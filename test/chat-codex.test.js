import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { CodexAppServer, createCodexAdapter, listCodexThreads, readCodexHistory } from '../src/chat/codex.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.js', import.meta.url));

function mkServer(extra = {}) {
  const logs = [];
  const server = new CodexAppServer({
    file: process.execPath, args: [FAKE],
    env: { ...process.env, CODEX_HOME: 'C:\\fake-home', OPENAI_API_KEY: 'should-not-pass' },
    log: (...a) => logs.push(a.join(' ')),
    ...extra,
  });
  return { server, logs };
}

// Records every adapter event in order.
function record(adapter) {
  const events = [];
  for (const ev of ['item', 'delta', 'update', 'state', 'approval', 'exit']) {
    adapter.on(ev, (...args) => events.push([ev, ...args]));
  }
  return events;
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for condition');
}

const states = events => events.filter(e => e[0] === 'state').map(e => e[1]);
const sentRequests = async (server, method) =>
  (await server.request('fake/log', {})).received.filter(m => m.method === method);

test('initialize then thread/start with cwd and sandbox per mode', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { id: 'w', cli: 'codex', mode: 'cautious' }, cwd: 'C:\\proj' });
  const res = await a.start({ conv: { id: 'c1' } });
  assert.equal(res.externalId, 'thread-1');
  const b = createCodexAdapter({ server, account: { id: 'p', cli: 'codex', mode: 'edit-in-project' }, cwd: 'C:\\proj2' });
  assert.equal((await b.start({ conv: { id: 'c2' } })).externalId, 'thread-2');

  const log = (await server.request('fake/log', {})).received;
  assert.equal(log[0].method, 'initialize');
  assert.equal(log[0].params.clientInfo.name, 'jarvis');
  assert.equal(typeof log[0].params.clientInfo.version, 'string');
  assert.equal(log[1].method, 'initialized');
  assert.equal(log[1].id, undefined);
  const starts = log.filter(m => m.method === 'thread/start');
  assert.deepEqual(starts.map(s => s.params), [
    { cwd: 'C:\\proj', approvalPolicy: 'on-request', sandbox: 'read-only' },
    { cwd: 'C:\\proj2', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  ]);
  // one initialize for the shared server
  assert.equal(log.filter(m => m.method === 'initialize').length, 1);
});

test('server env comes from the caller (account home, no inherited keys via buildEnv)', async (t) => {
  const { buildEnv } = await import('../src/policy.js');
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'leak';
  t.after(() => { if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev; });
  const env = buildEnv({ CODEX_HOME: 'C:\\acct-home' });
  const server = new CodexAppServer({ file: process.execPath, args: [FAKE], env, log: () => {} });
  t.after(() => server.close());
  const r = await server.request('fake/log', {});
  assert.deepEqual(r.env, { CODEX_HOME: 'C:\\acct-home', OPENAI_API_KEY: null });
});

test('turn streams deltas into one assistant item', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  a.send('hello codex');
  await waitFor(() => states(ev).includes('idle'));

  const items = ev.filter(e => e[0] === 'item').map(e => e[1]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'assistant');
  assert.equal(items[0].streaming, true);
  const deltas = ev.filter(e => e[0] === 'delta');
  assert.ok(deltas.every(d => d[1] === items[0].id));
  assert.equal(deltas.map(d => d[2]).join(''), 'Hello there');
  const upd = ev.find(e => e[0] === 'update' && e[1] === items[0].id);
  assert.equal(upd[2].streaming, false);
  assert.deepEqual(states(ev), ['working', 'idle']);

  const [ts] = await sentRequests(server, 'turn/start');
  assert.equal(ts.params.threadId, 'thread-1');
  assert.deepEqual(ts.params.input, [{ type: 'text', text: 'hello codex', text_elements: [] }]);
});

test('commandExecution approval request becomes approval and decision maps to accept/decline/acceptForSession', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });

  for (const [decision, expected] of [['approve', 'accept'], ['deny', 'decline'], ['always', 'acceptForSession']]) {
    ev.length = 0;
    a.send('approve-cmd');
    const ap = await waitFor(() => ev.find(e => e[0] === 'approval'));
    assert.equal(ap[1].command, 'npm install');
    assert.ok(ap[1].title);
    assert.match(ap[1].detail, /needs network/);
    // waiting right after the approval, before any answer
    const idx = ev.indexOf(ap);
    assert.deepEqual(ev[idx + 1], ['state', 'waiting']);
    a.answer(ap[1].token, decision);
    await waitFor(() => states(ev).includes('idle'));
    assert.deepEqual(states(ev), ['working', 'waiting', 'working', 'idle']);
    const msg = ev.filter(e => e[0] === 'delta').map(e => e[2]).join('');
    assert.equal(msg, 'decision=' + JSON.stringify({ decision: expected }));
    assert.throws(() => a.answer(ap[1].token, decision)); // token is single-use
  }
});

test('fileChange, permissions and legacy approvals answer with their own result shapes', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'edit-in-project' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  const run = async (text, decision) => {
    ev.length = 0;
    a.send(text);
    const ap = await waitFor(() => ev.find(e => e[0] === 'approval'));
    a.answer(ap[1].token, decision);
    await waitFor(() => states(ev).includes('idle'));
    return ev.filter(e => e[0] === 'delta').map(e => e[2]).join('');
  };
  assert.equal(await run('approve-file', 'always'), 'decision=' + JSON.stringify({ decision: 'acceptForSession' }));
  const diffs = ev.filter(e => e[0] === 'item' && e[1].kind === 'diff').map(e => e[1]);
  assert.deepEqual(diffs.map(d => [d.path, d.added, d.removed]), [['C:\\proj\\a.txt', 2, 1], ['C:\\proj\\new.txt', 2, 0]]);
  assert.match(diffs[0].patch, /\+y/);

  assert.equal(await run('approve-perm', 'approve'),
    'decision=' + JSON.stringify({ permissions: { network: { enabled: true } }, scope: 'turn' }));
  assert.equal(await run('approve-perm', 'always'),
    'decision=' + JSON.stringify({ permissions: { network: { enabled: true } }, scope: 'session' }));
  assert.equal(await run('approve-perm', 'deny'), 'decision=' + JSON.stringify({ permissions: {}, scope: 'turn' }));
  assert.equal(await run('approve-legacy', 'approve'), 'decision=' + JSON.stringify({ decision: 'approved' }));
  assert.equal(await run('approve-legacy', 'always'), 'decision=' + JSON.stringify({ decision: 'approved_for_session' }));
  assert.equal(await run('approve-legacy', 'deny'), 'decision=' + JSON.stringify({ decision: { denied: { rejection: 'Declined in Jarvis' } } }));
});

test('unsupported server request gets a JSON-RPC error, never hangs', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  a.send('unknown-req');
  await waitFor(() => states(ev).includes('idle'));
  assert.equal(ev.filter(e => e[0] === 'delta').map(e => e[2]).join(''), 'unknown=' + JSON.stringify({ error: -32601 }));
  assert.equal(ev.filter(e => e[0] === 'approval').length, 0);
});

test('command items map to read/search/run activities with exit status', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  a.send('run');
  await waitFor(() => states(ev).includes('idle'));
  const acts = ev.filter(e => e[0] === 'item').map(e => e[1]);
  assert.deepEqual(acts.map(x => [x.kind, x.icon, x.status]),
    [['activity', 'read', 'running'], ['activity', 'search', 'running'], ['activity', 'run', 'running']]);
  const final = acts.map(x => ev.filter(e => e[0] === 'update' && e[1] === x.id).at(-1)[2].status);
  assert.deepEqual(final, ['ok', 'ok', 'fail']);
  assert.match(acts[2].text, /npm test/);
  assert.match(ev.filter(e => e[0] === 'update' && e[1] === acts[2].id).at(-1)[2].detail, /1/);
});

test('resume uses thread/resume and history maps to items', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  const res = await a.start({ conv: { id: 'c' }, resumeId: 'thread-old' });
  assert.equal(res.externalId, 'thread-old');
  const [r] = await sentRequests(server, 'thread/resume');
  assert.equal(r.params.threadId, 'thread-old');
  assert.equal(r.params.approvalPolicy, 'on-request');
  assert.equal(r.params.sandbox, 'read-only');
  assert.equal((await sentRequests(server, 'thread/start')).length, 0);
  const items = ev.filter(e => e[0] === 'item').map(e => e[1]);
  assert.deepEqual(items.map(i => [i.kind, i.text]), [
    ['user', 'old question'], ['activity', 'npm test'], ['assistant', 'old answer'],
  ]);
  assert.equal(items[1].status, 'ok');
  assert.equal(items[2].streaming, false);

  const hist = await readCodexHistory({ server, threadId: 'thread-old' });
  assert.deepEqual(hist.map(i => i.kind), ['user', 'activity', 'assistant']);
  const [rd] = await sentRequests(server, 'thread/read');
  assert.deepEqual(rd.params, { threadId: 'thread-old', includeTurns: true });
});

test('listCodexThreads filters by cwd', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const list = await listCodexThreads({ server, cwd: 'c:/PROJ/a/', limit: 10 });
  assert.deepEqual(list.map(x => [x.externalId, x.title]), [['t-a', 'TestraTech'], ['t-b', 'preview title']]);
  assert.equal(list[0].updatedAt, new Date(1761000300 * 1000).toISOString());
  assert.equal(list[0].cwd, 'C:\\Proj\\A');
  const [req] = await sentRequests(server, 'thread/list');
  assert.equal(req.params.limit, 10);
});

test('server crash mid-turn emits error and exit, next send restarts server', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  const pid1 = (await server.request('fake/log', {})).pid;
  a.send('crash');
  const ex = await waitFor(() => ev.find(e => e[0] === 'exit'));
  assert.equal(ex[1], 3);
  assert.ok(!states(ev).includes('idle'), 'no idle on crash; manager turns exit into error');

  ev.length = 0;
  a.send('hello again');
  await waitFor(() => states(ev).includes('idle'));
  const log = await server.request('fake/log', {});
  assert.notEqual(log.pid, pid1);
  assert.deepEqual(log.received.map(m => m.method).filter(m => m !== 'fake/log'),
    ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  assert.equal(log.received.find(m => m.method === 'thread/resume').params.threadId, 'thread-1');
});

test('unknown method rejects; server death rejects pending requests', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  await assert.rejects(server.request('no/such', {}), /unknown method/);
  const pending = server.request('fake/hang', {});
  await new Promise(r => setTimeout(r, 50));
  server.child.kill();
  await assert.rejects(pending, /exit|stopped/i);
});

test('malformed JSON line is ignored and logged', async (t) => {
  const { server, logs } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  a.send('malformed');
  await waitFor(() => states(ev).includes('idle'));
  assert.equal(ev.filter(e => e[0] === 'delta').map(e => e[2]).join(''), 'Hello there');
  assert.ok(logs.some(l => /malformed|not json|parse/i.test(l)), logs.join('\n'));
});

test('interrupt cancels pending approvals and sends turn/interrupt with the turn id', async (t) => {
  const { server } = mkServer();
  t.after(() => server.close());
  const a = createCodexAdapter({ server, account: { mode: 'cautious' }, cwd: 'C:\\proj' });
  const ev = record(a);
  await a.start({ conv: { id: 'c' } });
  a.send('approve-cmd');
  const ap = await waitFor(() => ev.find(e => e[0] === 'approval'));
  a.interrupt();
  await waitFor(() => states(ev).includes('idle'));
  const [ir] = await sentRequests(server, 'turn/interrupt');
  assert.deepEqual(ir.params, { threadId: 'thread-1', turnId: 'turn-1' });
  const log = (await server.request('fake/log', {})).received;
  const resp = log.find(m => m.id === 1000 && !m.method);
  assert.deepEqual(resp.result, { decision: 'cancel' });
  assert.throws(() => a.answer(ap[1].token, 'approve'));
});

test('close kills the server process', async () => {
  const { server } = mkServer();
  await server.start();
  const child = server.child;
  const exited = once(child, 'exit');
  server.close();
  await exited;
});
