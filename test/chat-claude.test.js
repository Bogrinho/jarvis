import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as cp from 'node:child_process';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter, listClaudeSessions, readClaudeHistory, claudeProjectSlug } from '../src/chat/claude.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-stream.js', import.meta.url));
const SID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT = { id: 'cl', cli: 'claude', mode: 'cautious' };

function mk(extra = {}) {
  const calls = [];
  const spawn = (f, a, o) => { calls.push({ f, a, o }); return cp.spawn(f, a, o); };
  const a = createClaudeAdapter({
    account: ACCOUNT, cwd: process.cwd(), env: { ...process.env },
    file: process.execPath, fileArgs: [FAKE], spawn, claudeHome: join(tmpdir(), 'no-such-claude-home'),
    ...extra,
  });
  return { a, calls };
}

function record(adapter) {
  const events = [];
  for (const ev of ['item', 'delta', 'update', 'state', 'approval', 'approval-expired', 'exit']) {
    adapter.on(ev, (...args) => events.push([ev, ...args]));
  }
  return events;
}

async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for condition');
}

const states = ev => ev.filter(e => e[0] === 'state').map(e => e[1]);
const items = ev => ev.filter(e => e[0] === 'item').map(e => e[1]);
const idleCount = ev => states(ev).filter(s => s === 'idle').length;
const lastText = ev => items(ev).filter(i => i.kind === 'assistant').at(-1)?.text;

test('init yields externalId; spawn flags, cwd and env are exact', async (t) => {
  const { a, calls } = mk();
  t.after(() => a.close());
  const ev = record(a);
  const { externalId } = await a.start({ conv: { id: 'c' } });
  assert.match(externalId, /^[0-9a-f-]{36}$/);
  a.send('hi');
  await waitFor(() => idleCount(ev) === 1);
  assert.equal(calls.length, 1);
  const { f, a: args, o } = calls[0];
  assert.equal(f, process.execPath);
  assert.deepEqual(args, [FAKE, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', 'default', '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio', '--session-id', externalId]);
  assert.equal(o.cwd, process.cwd());
  assert.ok(o.env);
  assert.equal(lastText(ev), 'echo:hi'); // assistant text without partial events
  assert.deepEqual(states(ev), ['working', 'idle']);
});

test('windows default command goes through cmd.exe /d /s /c claude; user text never on the command line', async (t) => {
  const calls = [];
  const spawn = (f, a, o) => { calls.push({ f, a, o }); return cp.spawn(process.execPath, [FAKE, ...a.slice(a.indexOf('-p'))], o); };
  const a = createClaudeAdapter({ account: { mode: 'edit-in-project' }, cwd: process.cwd(), env: { ...process.env }, spawn });
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('secret & text');
  await waitFor(() => idleCount(ev) === 1);
  if (process.platform === 'win32') {
    assert.equal(calls[0].f, process.env.ComSpec || 'cmd.exe');
    assert.deepEqual(calls[0].a.slice(0, 5), ['/d', '/s', '/c', 'claude', '-p']);
  }
  assert.ok(calls[0].a.includes('acceptEdits'));
  assert.ok(!calls[0].a.some(x => x.includes('secret')));
  assert.equal(lastText(ev), 'echo:secret & text');
});

test('env is required; modes map explicitly', () => {
  assert.throws(() => createClaudeAdapter({ account: ACCOUNT, cwd: '.' }), /env/);
  assert.throws(() => createClaudeAdapter({ account: { mode: 'yolo' }, cwd: '.', env: {} }), /mode/);
  assert.throws(() => createClaudeAdapter({ account: { mode: 'constructor' }, cwd: '.', env: {} }), /mode/);
});

test('partial deltas stream into one assistant item', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('hello');
  await waitFor(() => idleCount(ev) === 1);
  const its = items(ev);
  assert.equal(its.length, 1);
  assert.equal(its[0].kind, 'assistant');
  assert.equal(its[0].streaming, true);
  const deltas = ev.filter(e => e[0] === 'delta');
  assert.ok(deltas.every(d => d[1] === its[0].id));
  assert.equal(deltas.map(d => d[2]).join(''), 'Hello there');
  const upd = ev.filter(e => e[0] === 'update' && e[1] === its[0].id);
  assert.equal(upd.at(-1)[2].streaming, false);
  assert.deepEqual(states(ev), ['working', 'idle']);
});

test('Bash tool_use becomes run activity and result marks ok/fail', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('bash');
  await waitFor(() => idleCount(ev) === 1);
  const acts = items(ev).filter(i => i.kind === 'activity');
  assert.deepEqual(acts.map(x => [x.icon, x.text, x.status]), [['run', 'npm test', 'running'], ['run', 'npm run lint', 'running']]);
  const st = id => ev.filter(e => e[0] === 'update' && e[1] === id).at(-1)[2].status;
  assert.equal(st(acts[0].id), 'ok');
  assert.equal(st(acts[1].id), 'fail');
});

test('Read/Glob/Grep map to read/search; Edit yields a diff, Write an edit activity', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('tools');
  await waitFor(() => idleCount(ev) === 1);
  const its = items(ev);
  const acts = its.filter(i => i.kind === 'activity').map(x => [x.icon, x.text]);
  assert.deepEqual(acts, [['read', 'C:\\proj\\a.js'], ['search', '**/*.js'], ['search', 'TODO'],
    ['edit', 'C:\\proj\\a.js'], ['edit', 'C:\\proj\\new.js']]);
  const diff = its.find(i => i.kind === 'diff');
  assert.equal(diff.path, 'C:\\proj\\a.js');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.match(diff.patch, /^ a$/m);
  assert.match(diff.patch, /^-b$/m);
  assert.match(diff.patch, /^\+d$/m);
  assert.equal(its.filter(i => i.kind === 'diff').length, 1);
});

test('permission request → approval; approve/deny written back with the request id', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  for (const [decision, expected] of [
    ['approve', { behavior: 'allow', updatedInput: { command: 'rm -rf build', description: 'Clean build' } }],
    ['deny', { behavior: 'deny', message: 'The user denied this in Jarvis.' }],
  ]) {
    ev.length = 0;
    a.send('perm rm -rf build');
    const ap = await waitFor(() => ev.find(e => e[0] === 'approval'));
    assert.equal(ap[1].command, 'rm -rf build');
    assert.ok(ap[1].title);
    assert.match(ap[1].detail, /Clean build/);
    assert.deepEqual(ev[ev.indexOf(ap) + 1], ['state', 'waiting']);
    a.answer(ap[1].token, decision);
    await waitFor(() => idleCount(ev) === 1);
    assert.deepEqual(states(ev), ['working', 'waiting', 'working', 'idle']);
    const resp = JSON.parse(lastText(ev).slice('response='.length));
    assert.equal(resp.subtype, 'success');
    assert.equal(typeof resp.request_id, 'string'); // matched by the fake against its own request id
    assert.deepEqual(resp.response, expected);
    assert.throws(() => a.answer(ap[1].token, decision)); // single use
  }
});

test('always auto-allows an identical later request only in this conversation', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('perm rm -rf build');
  const ap = await waitFor(() => ev.find(e => e[0] === 'approval'));
  a.answer(ap[1].token, 'always');
  await waitFor(() => idleCount(ev) === 1);
  assert.equal(JSON.parse(lastText(ev).slice(9)).response.behavior, 'allow');

  ev.length = 0;
  a.send('perm rm -rf build');
  await waitFor(() => idleCount(ev) === 1);
  assert.equal(ev.filter(e => e[0] === 'approval').length, 0);
  assert.ok(!states(ev).includes('waiting'));
  assert.equal(JSON.parse(lastText(ev).slice(9)).response.behavior, 'allow');
  const note = items(ev).find(i => i.kind === 'activity' && /αυτόματα/i.test(i.text));
  assert.ok(note, 'auto-allow is shown as an activity');

  ev.length = 0;
  a.send('perm rm -rf dist'); // different input asks again
  assert.ok(await waitFor(() => ev.find(e => e[0] === 'approval')));

  // a different conversation does not inherit it
  const { a: b } = mk();
  t.after(() => b.close());
  const ev2 = record(b);
  await b.start({});
  b.send('perm rm -rf build');
  assert.ok(await waitFor(() => ev2.find(e => e[0] === 'approval')));
});

test('prototype-key and unknown decisions are rejected and answer nothing', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('perm ls');
  const ap = await waitFor(() => ev.find(e => e[0] === 'approval'));
  for (const d of ['constructor', 'toString', '__proto__', 'yes', undefined]) {
    assert.throws(() => a.answer(ap[1].token, d), /decision/i);
  }
  a.answer(ap[1].token, 'deny');
  await waitFor(() => idleCount(ev) === 1);
  assert.equal(JSON.parse(lastText(ev).slice(9)).response.behavior, 'deny');
});

test('control_cancel_request expires the approval and resumes working', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('perm-cancel');
  const ap = await waitFor(() => ev.find(e => e[0] === 'approval'));
  const ex = await waitFor(() => ev.find(e => e[0] === 'approval-expired'));
  assert.equal(ex[1], ap[1].token);
  await waitFor(() => idleCount(ev) === 1);
  assert.deepEqual(states(ev), ['working', 'waiting', 'working', 'idle']);
  assert.throws(() => a.answer(ap[1].token, 'approve'));
});

test('unsupported control requests get an error response', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('unknown-ctl');
  await waitFor(() => idleCount(ev) === 1);
  const resp = JSON.parse(lastText(ev).slice(9));
  assert.equal(resp.subtype, 'error');
  assert.match(resp.error, /hook_callback/);
});

test('interrupt sends an interrupt control request', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('wait-int');
  await waitFor(() => ev.some(e => e[0] === 'delta' && e[2] === 'waiting'));
  a.interrupt(); // the fake only finishes the turn once it receives the interrupt request
  await waitFor(() => idleCount(ev) === 1);
  assert.equal(items(ev).filter(i => i.kind === 'error').length, 0);
});

test('error result emits an error item then idle', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ev = record(a);
  await a.start({});
  a.send('fail');
  await waitFor(() => idleCount(ev) === 1);
  const err = items(ev).find(i => i.kind === 'error');
  assert.match(err.text, /boom/);
});

test('resume passes --resume and adopts a forked session id for the next respawn', async (t) => {
  const FORK = '99999999-2222-4333-8444-555555555555';
  const { a, calls } = mk({ env: { ...process.env, FAKE_FORK_SID: FORK } });
  t.after(() => a.close());
  const ev = record(a);
  const res = await a.start({ resumeId: SID });
  assert.equal(res.externalId, SID);
  a.send('hi');
  await waitFor(() => idleCount(ev) === 1);
  const args = calls[0].a;
  assert.equal(args[args.indexOf('--resume') + 1], SID);
  assert.ok(!args.includes('--session-id'));
  a.send('crash');
  await waitFor(() => states(ev).includes('error'));
  a.send('hi');
  await waitFor(() => idleCount(ev) === 2);
  const args2 = calls[1].a;
  assert.equal(args2[args2.indexOf('--resume') + 1], FORK);
});

test('resume id must be a UUID', async () => {
  const { a } = mk();
  await assert.rejects(a.start({ resumeId: 'x & calc' }), /session id/i);
});

test('process exit mid-turn → error item + state error (no exit); next send respawns with --resume', async (t) => {
  const { a, calls } = mk();
  t.after(() => a.close());
  const ev = record(a);
  const { externalId } = await a.start({});
  a.send('crash');
  await waitFor(() => states(ev).includes('error'));
  assert.ok(items(ev).some(i => i.kind === 'error'));
  assert.equal(ev.filter(e => e[0] === 'exit').length, 0);
  // the streaming item is closed
  const asst = items(ev).find(i => i.kind === 'assistant');
  assert.ok(ev.some(e => e[0] === 'update' && e[1] === asst.id && e[2].streaming === false));

  ev.length = 0;
  a.send('hi');
  await waitFor(() => idleCount(ev) === 1);
  assert.equal(calls.length, 2);
  const args = calls[1].a;
  assert.equal(args[args.indexOf('--resume') + 1], externalId);
  assert.equal(lastText(ev), 'echo:hi');
});

test('close emits exit once and kills the process', async () => {
  const { a } = mk();
  const ev = record(a);
  await a.start({});
  a.send('hi');
  await waitFor(() => idleCount(ev) === 1);
  a.close();
  a.close();
  assert.deepEqual(ev.filter(e => e[0] === 'exit'), [['exit', 0]]);
});

// ---- history -----------------------------------------------------------------

test('project slug matches Claude Code naming (non-alphanumerics → "-", long paths hashed)', () => {
  assert.equal(claudeProjectSlug('C:\\Users\\stath\\OneDrive\\Έγγραφα\\Jarvis'), 'C--Users-stath-OneDrive---------Jarvis');
  const long = 'C:\\' + 'a'.repeat(250);
  const s = claudeProjectSlug(long);
  assert.equal(s.slice(0, 201), ('C--' + 'a'.repeat(250)).slice(0, 200) + '-');
  assert.match(s.slice(201), /^[0-9a-z]+$/);
});

const line = o => JSON.stringify(o) + '\n';
const userLine = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, uuid: 'u', ...extra });
const asstLine = content => line({ type: 'assistant', message: { role: 'assistant', content }, uuid: 'a' });

async function mkHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jarvis-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('listClaudeSessions reads only the cwd\'s project folder', async (t) => {
  const home = await mkHome(t);
  const cwd = 'C:\\Proj\\Ένα';
  const dir = join(home, 'projects', claudeProjectSlug(cwd));
  const other = join(home, 'projects', claudeProjectSlug('C:\\Proj\\Other'));
  await mkdir(dir, { recursive: true });
  await mkdir(other, { recursive: true });
  const s1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const s2 = 'aaaaaaaa-0000-4000-8000-000000000002';
  const s3 = 'aaaaaaaa-0000-4000-8000-000000000003';
  await writeFile(join(dir, `${s1}.jsonl`),
    line({ type: 'queue-operation' }) +
    userLine('<command-name>/clear</command-name>') +
    userLine('caveat', { isMeta: true }) +
    userLine([{ type: 'text', text: 'Φτιάξε μου ένα πολύ μεγάλο τίτλο που ξεπερνά σίγουρα τους εξήντα χαρακτήρες εδώ' }]) +
    asstLine([{ type: 'text', text: 'SECRET ANSWER' }]));
  await writeFile(join(dir, `${s2}.jsonl`), userLine('short one') + asstLine([{ type: 'text', text: 'ok' }]));
  await writeFile(join(dir, 'not-a-session.jsonl'), userLine('nope'));
  await mkdir(join(dir, s3)); // per-session folder (subagents, tool results)
  await writeFile(join(other, `${s3}.jsonl`), userLine('other project'));
  const old = new Date('2026-01-01T00:00:00Z');
  await utimes(join(dir, `${s1}.jsonl`), old, old);

  const list = await listClaudeSessions({ claudeHome: home, cwd });
  assert.deepEqual(list.map(s => s.externalId), [s2, s1]);
  assert.equal(list[0].title, 'short one');
  assert.equal(list[1].title.length, 60);
  assert.ok(list[1].title.startsWith('Φτιάξε μου'));
  assert.equal(list[1].updatedAt, old.toISOString());
  for (const s of list) assert.deepEqual(Object.keys(s).sort(), ['externalId', 'title', 'updatedAt']);
  assert.ok(!JSON.stringify(list).includes('SECRET'));

  assert.deepEqual(await listClaudeSessions({ claudeHome: home, cwd: 'C:\\Nowhere' }), []);
  assert.equal((await listClaudeSessions({ claudeHome: home, cwd, limit: 1 })).length, 1);
});

test('readClaudeHistory maps text, tools and results; caps to 500 items', async (t) => {
  const home = await mkHome(t);
  const cwd = 'C:\\Proj\\A';
  const dir = join(home, 'projects', claudeProjectSlug(cwd));
  await mkdir(dir, { recursive: true });
  const sid = 'bbbbbbbb-0000-4000-8000-000000000001';
  await writeFile(join(dir, `${sid}.jsonl`),
    userLine('question') +
    userLine('meta', { isMeta: true }) +
    asstLine([{ type: 'thinking', thinking: 'hmm' }]) +
    asstLine([{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'npm test' } }]) +
    userLine([{ type: 'tool_result', tool_use_id: 'x1', content: 'fail', is_error: true }]) +
    asstLine([{ type: 'tool_use', id: 'x2', name: 'Edit', input: { file_path: 'f.js', old_string: 'a', new_string: 'b' } }]) +
    userLine([{ type: 'tool_result', tool_use_id: 'x2', content: 'ok' }]) +
    line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } }) +
    'garbage\n' +
    asstLine([{ type: 'text', text: 'answer' }]));
  const items = await readClaudeHistory({ claudeHome: home, cwd, sessionId: sid });
  assert.deepEqual(items.map(i => [i.kind, i.text ?? i.path, i.status]), [
    ['user', 'question', undefined],
    ['activity', 'npm test', 'fail'],
    ['diff', 'f.js', undefined],
    ['assistant', 'answer', undefined],
  ]);
  assert.ok(items.every(i => typeof i.id === 'string'));
  assert.equal(items[3].streaming, false);

  let big = '';
  for (let i = 0; i < 600; i++) big += userLine(`m${i}`);
  await writeFile(join(dir, `${sid}.jsonl`), big);
  const capped = await readClaudeHistory({ claudeHome: home, cwd, sessionId: sid });
  assert.equal(capped.length, 500);
  assert.equal(capped.at(-1).text, 'm599');

  await assert.rejects(readClaudeHistory({ claudeHome: home, cwd, sessionId: '..\\..\\x' }), /session id/i);
});

test('start with resumeId emits history items from the session file', async (t) => {
  const home = await mkHome(t);
  const cwd = process.cwd();
  const dir = join(home, 'projects', claudeProjectSlug(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SID}.jsonl`), userLine('old q') + asstLine([{ type: 'text', text: 'old a' }]));
  const { a } = mk({ claudeHome: home });
  t.after(() => a.close());
  const ev = record(a);
  await a.start({ resumeId: SID });
  assert.deepEqual(items(ev).map(i => i.text), ['old q', 'old a']);
});

test('a resume that forks to a new session id emits external-id', async (t) => {
  const FORK = '99999999-8888-4777-8666-555555555555';
  process.env.FAKE_FORK_SID = FORK;
  t.after(() => { delete process.env.FAKE_FORK_SID; });
  const { a } = mk({ env: { ...process.env, FAKE_FORK_SID: FORK } });
  t.after(() => a.close());
  const ids = [];
  a.on('external-id', (id) => ids.push(id));
  const ev = record(a);
  await a.start({ conv: { id: 'c' }, resumeId: SID });
  a.send('hello');
  await waitFor(() => idleCount(ev) === 1);
  assert.deepEqual(ids, [FORK]);
});

test('no external-id when the session id is unchanged', async (t) => {
  const { a } = mk();
  t.after(() => a.close());
  const ids = [];
  a.on('external-id', (id) => ids.push(id));
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  a.send('hello');
  await waitFor(() => idleCount(ev) === 1);
  assert.deepEqual(ids, []);
});
