import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { runHelper, helperLaunch, helperAccount } from '../src/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function config() {
  const c = loadConfig(path.join(here, 'fixtures', 'jarvis.config.json'));
  c.accounts.gemini.enabled = true;
  c.accounts.gemini.cli = 'agy';
  c.projects = [{ name: 'job', path: path.join(os.tmpdir(), 'WorkProj'), side: 'work' }];
  return c;
}

// A fake CLI: records how it was started, writes `answer` to the -o file (codex) or stdout (agy).
function fakeSpawn({ answer = 'done', code = 0, never = false } = {}) {
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
        child.emit('close', code);
      }, 20);
    }
    return child;
  };
  return { spawn, calls };
}

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

test('helpers refuse work folders, empty tasks and missing accounts', async () => {
  const c = config();
  const { spawn, calls } = fakeSpawn();
  await assert.rejects(runHelper({ config: c, kind: 'codex', task: 'x', cwd: path.join(os.tmpdir(), 'WorkProj', 'src'), spawn }), /δουλειάς/);
  await assert.rejects(runHelper({ config: c, kind: 'codex', task: '  ', cwd: os.tmpdir(), spawn }), /εργασία/);
  c.accounts.gemini.enabled = false;
  await assert.rejects(runHelper({ config: c, kind: 'gemini', task: 'x', cwd: os.tmpdir(), spawn }), /Gemini/);
  assert.equal(calls.length, 0);
  // the work Codex account is never used as a helper
  assert.equal(helperAccount(config(), 'codex').id, 'mine');
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
