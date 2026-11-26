import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { runHelper, helperLaunch, helperAccount, isLimitFailure } from '../src/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function config() {
  const c = loadConfig(path.join(here, 'fixtures', 'jarvis.config.json'));
  c.accounts.work.env.CODEX_HOME = path.join(os.tmpdir(), 'jarvis-test-work-login');
  c.accounts.mine.env.CODEX_HOME = path.join(os.tmpdir(), 'jarvis-test-personal-login');
  c.accounts.gemini.enabled = true;
  c.accounts.gemini.cli = 'agy';
  c.projects = [{ name: 'job', path: path.join(os.tmpdir(), 'WorkProj'), side: 'work' }];
  return c;
}

// A fake CLI: records how it was started, writes `answer` to the -o file (codex) or stdout (agy).
function fakeSpawn({ answer = 'done', stderr = '', code = 0, never = false } = {}) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = '';
    child.stdin = new Writable({ write(c, _e, cb) { stdin += c; cb(); }, final(cb) { cb(); } });
    child.kill = () => { child.killed = true; };
    const call = { file, args, opts, get stdin() { return stdin; } };
    calls.push(call);
    if (!never) {
      setTimeout(() => {
        const o = args.indexOf('-o');
        if (o >= 0) fs.writeFileSync(args[o + 1], answer);
        else child.stdout.write(answer);
        child.stderr.write(stderr);
        child.emit('close', code);
      }, 20);
    }
    return child;
  };
  return { spawn, calls };
}

test('usage limit detection follows the provider and ignores successful answers', async () => {
  for (const kind of ['codex', 'codex-work', 'gemini']) {
    assert.equal(isLimitFailure(kind, 'Rate limit exceeded'), true);
    assert.equal(isLimitFailure(kind, 'Quota exceeded'), true);
    assert.equal(isLimitFailure(kind, 'permission denied'), false);
    assert.equal(isLimitFailure(kind, 'HTTP 429'), kind === 'gemini');
  }
  const c = config();
  for (const [kind, answer, stderr] of [
    ['codex', 'partial answer', "ERROR: You've hit your usage limit."],
    ['gemini', '', 'RESOURCE_EXHAUSTED'],
  ]) {
    const { spawn, calls } = fakeSpawn({ code: 1, answer, stderr });
    await assert.rejects(runHelper({ config: c, kind, task: 'review', cwd: os.tmpdir(), spawn }), { message: stderr });
    assert.equal(calls.length, 1);
  }
  const { spawn } = fakeSpawn({ answer: 'fixed quota handling' });
  assert.equal((await runHelper({ config: c, kind: 'codex', task: 'review', cwd: os.tmpdir(), spawn })).answer, 'fixed quota handling');
});

test('codex helper: personal login, workspace sandbox, task on stdin, final answer returned', async () => {
  const c = config();
  const { spawn, calls } = fakeSpawn({ answer: 'Έλεγξα τον κώδικα: όλα καλά.' });
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-leak';
  let r;
  try {
    r = await runHelper({ config: c, kind: 'codex', task: 'Έλεγξε το app.js & πες μου "τι" βλέπεις', cwd: os.tmpdir(), spawn });
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
  assert.equal(r.answer, 'Έλεγξα τον κώδικα: όλα καλά.');
  assert.equal(r.account, 'Codex Personal');
  const call = calls[0];
  assert.equal(call.opts.env.CODEX_HOME, c.accounts.mine.env.CODEX_HOME);
  assert.equal(call.opts.env.OPENAI_API_KEY, undefined);
  assert.ok(call.args.includes('workspace-write'));
  assert.ok(!call.args.some((a) => /dangerously/.test(a)));
  assert.equal(call.args.at(-1), '-');
  assert.ok(!call.args.some((a) => a.includes('Έλεγξε')), 'task text never on the command line');
  assert.ok(call.stdin.endsWith('Έλεγξε το app.js & πες μου "τι" βλέπεις'));
  assert.equal(call.opts.cwd, os.tmpdir());
});

test('gemini helper runs agy -p with accept-edits in the folder', async () => {
  const c = config();
  const { spawn, calls } = fakeSpawn({ answer: 'hello from gemini\n' });
  const r = await runHelper({ config: c, kind: 'gemini', task: 'γράψε ένα README', cwd: os.tmpdir(), spawn });
  assert.equal(r.answer, 'hello from gemini');
  assert.equal(calls[0].file, 'agy');
  assert.deepEqual(calls[0].args.slice(0, -1), ['--mode', 'accept-edits', '--output-format', 'text', '-p']);
  assert.ok(calls[0].args.at(-1).endsWith('γράψε ένα README'));
  assert.ok(!calls[0].args.includes('--dangerously-skip-permissions'));
});

test('personal helpers refuse work folders, empty tasks and missing accounts', async () => {
  const c = config();
  const { spawn, calls } = fakeSpawn();
  await assert.rejects(runHelper({ config: c, kind: 'codex', task: 'x', cwd: path.join(os.tmpdir(), 'WorkProj', 'src'), spawn }), /δουλειάς/);
  await assert.rejects(runHelper({ config: c, kind: 'codex', task: '  ', cwd: os.tmpdir(), spawn }), /εργασία/);
  c.accounts.gemini.enabled = false;
  await assert.rejects(runHelper({ config: c, kind: 'gemini', task: 'x', cwd: os.tmpdir(), spawn }), /Gemini/);
  assert.equal(calls.length, 0);
  assert.equal(helperAccount(config(), 'codex').id, 'mine');
});

test('codex-work selects the first enabled work Codex account and reports when none exists', () => {
  const c = config();
  c.accounts.secondWork = { ...c.accounts.work, id: 'secondWork' };
  assert.equal(helperAccount(c, 'codex-work'), c.accounts.work);
  c.accounts.work.enabled = false;
  assert.equal(helperAccount(c, 'codex-work'), c.accounts.secondWork);
  c.accounts.secondWork.enabled = false;
  assert.throws(() => helperAccount(c, 'codex-work'), {
    message: 'Δεν υπάρχει ενεργός εταιρικός λογαριασμός Codex στο Jarvis',
  });
});

test('codex-work runs with its work login in a work project and outside it', async () => {
  const c = config();
  const { spawn, calls } = fakeSpawn();
  for (const cwd of [c.projects[0].path, os.tmpdir()]) {
    const result = await runHelper({ config: c, kind: 'codex-work', task: 'review', cwd, spawn });
    assert.equal(result.account, c.accounts.work.label);
    assert.equal(calls.at(-1).opts.env.CODEX_HOME, c.accounts.work.env.CODEX_HOME);
    assert.equal(calls.at(-1).opts.cwd, cwd);
  }
});

test('a helper that hangs is stopped after the timeout; a failing one reports its error', async () => {
  const c = config();
  const hang = fakeSpawn({ never: true });
  await assert.rejects(runHelper({ config: c, kind: 'codex', task: 'x', cwd: os.tmpdir(), spawn: hang.spawn, timeoutMs: 50 }), /σταμάτησε/);
  const fail = fakeSpawn({ answer: '', code: 1 });
  await assert.rejects(runHelper({ config: c, kind: 'gemini', task: 'x', cwd: os.tmpdir(), spawn: fail.spawn }), /δεν έδωσε απάντηση/);
});

test('cautious accounts run read-only / ask-everything', () => {
  const c = config();
  const l = helperLaunch({ ...c.accounts.mine, mode: 'cautious' }, os.tmpdir(), 'o.txt');
  assert.ok(l.args.includes('read-only'));
  const g = helperLaunch({ ...c.accounts.gemini, mode: 'cautious' }, os.tmpdir(), 'o.txt');
  assert.ok(!g.args.includes('--mode'));
});

test('gemini is told to use file tools, not shell commands', async () => {
  const c = config();
  const { spawn, calls } = fakeSpawn({ answer: 'ok' });
  await runHelper({ config: c, kind: 'gemini', task: 'review x', cwd: os.tmpdir(), spawn });
  const prompt = calls[0].args.at(-1);
  assert.match(prompt, /list_dir/);
  assert.match(prompt, /review x$/);
});

test('an empty answer reports what the helper said on stderr', async () => {
  const c = config();
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.kill = () => {};
    setTimeout(() => { child.stderr.write('no output produced — a tool required the "command" permission'); child.emit('close', 0); }, 20);
    return child;
  };
  await assert.rejects(runHelper({ config: c, kind: 'gemini', task: 'x', cwd: os.tmpdir(), spawn }), /command" permission/);
});

test('codex gets the helper rules before the task', async () => {
  const c = config();
  const { spawn, calls } = fakeSpawn({ answer: 'ok' });
  await runHelper({ config: c, kind: 'codex', task: 'do x', cwd: os.tmpdir(), spawn });
  assert.match(calls[0].stdin, /Do not commit/);
  assert.ok(calls[0].stdin.endsWith('do x'));
});

test('codex may write to a node_modules that links outside the folder', () => {
  const c = config();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-proj-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-mods-'));
  fs.symlinkSync(target, path.join(dir, 'node_modules'), 'junction');
  const l = helperLaunch(c.accounts.mine, dir, 'o.txt');
  const i = l.args.indexOf('--add-dir');
  assert.ok(i > 0, 'has --add-dir');
  assert.equal(fs.realpathSync(l.args[i + 1]), fs.realpathSync(target));
  // a normal node_modules folder, or a read-only account, adds nothing
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-plain-'));
  fs.mkdirSync(path.join(plain, 'node_modules'));
  assert.ok(!helperLaunch(c.accounts.mine, plain, 'o.txt').args.includes('--add-dir'));
  assert.ok(!helperLaunch({ ...c.accounts.mine, mode: 'cautious' }, dir, 'o.txt').args.includes('--add-dir'));
});

test('an empty gemini answer is retried once', async () => {
  const c = config();
  let n = 0;
  const spawn = () => {
    n++;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.kill = () => {};
    setTimeout(() => { if (n === 2) child.stdout.write('second time works'); child.emit('close', 0); }, 10);
    return child;
  };
  const r = await runHelper({ config: c, kind: 'gemini', task: 'x', cwd: os.tmpdir(), spawn });
  assert.equal(r.answer, 'second time works');
  assert.equal(n, 2);
});

test('Claude helper uses stdin and headless text mode', async () => {
  const c = config();
  c.accounts.claude = { enabled: true, side: 'personal', cli: 'claude', label: 'Claude', env: {} };
  const { spawn, calls } = fakeSpawn();
  await runHelper({ config: c, kind: 'claude', task: 'review this', cwd: os.tmpdir(), spawn });
  assert.deepEqual(calls[0].args.slice(-5), ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text']);
  assert.match(calls[0].stdin, /team leader/);
  assert.ok(calls[0].stdin.endsWith('review this'));
});
