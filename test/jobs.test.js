import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager } from '../src/jobs.js';

const fakeCli = fileURLToPath(new URL('./fixtures/fake-cli.js', import.meta.url));
const launch = (...extra) => ({ file: process.execPath, args: [fakeCli, ...extra], env: process.env });
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for condition');
};

let jm;
afterEach(async () => { if (jm) await jm.killAll(); jm = null; });

test('runs in a cwd with Greek characters and spaces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-'));
  const cwd = path.join(dir, 'Έγγραφα test');
  fs.mkdirSync(cwd);
  jm = new JobManager({ idleMs: 200 });
  const info = jm.start({ accountId: 'a', cwd, launch: launch(), title: 't' });
  await until(() => jm.attach(info.id).scrollback.includes('Έγγραφα test'));
  await jm.killAll();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* conpty may briefly hold the cwd */ }
});

test('types the initial prompt after the CLI is ready', async () => {
  jm = new JobManager({ idleMs: 200, promptDelayMs: 200 });
  const info = jm.start({ accountId: 'a', cwd: process.cwd(), launch: launch(), title: 't', prompt: 'Γεια "σου"' });
  await until(() => jm.attach(info.id).scrollback.includes('ECHO:Γεια "σου"'));
});

test('state goes working -> idle -> error on exit 3', async () => {
  jm = new JobManager({ idleMs: 200, promptDelayMs: 100 });
  const states = [];
  jm.on('state', (id, s) => states.push(s));
  const info = jm.start({ accountId: 'a', cwd: process.cwd(), launch: launch(), title: 't' });
  assert.equal(info.state, 'working');
  await until(() => states.includes('idle'));
  jm.write(info.id, 'quit\r');
  await until(() => states.includes('error'));
  assert.deepEqual(states.filter((s, i) => s !== states[i - 1]).slice(0, 2), ['idle', 'working']);
  assert.equal(states.at(-1), 'error');
  const j = jm.list().find((x) => x.id === info.id);
  assert.equal(j.state, 'error');
  assert.equal(j.exitCode, 3);
});

test('scrollback is capped', async () => {
  jm = new JobManager({ idleMs: 200 });
  const info = jm.start({ accountId: 'a', cwd: process.cwd(), launch: launch('flood'), title: 't' });
  await until(() => jm.list()[0].state === 'done');
  const { scrollback } = jm.attach(info.id);
  assert.ok(scrollback.length <= 512 * 1024, String(scrollback.length));
  assert.ok(scrollback.length > 100 * 1024);
  assert.ok(scrollback.includes('LAST-MARKER'));
});

test('trimming never splits a surrogate pair', async () => {
  const fake = () => {
    const h = {};
    return { onData: (f) => { h.d = f; }, onExit: (f) => { h.e = f; }, write() {}, resize() {}, kill() { h.e({ exitCode: 0 }); }, _h: h };
  };
  let p;
  jm = new JobManager({ scrollbackBytes: 11, spawn: () => (p = fake()) });
  const info = jm.start({ accountId: 'a', cwd: '.', launch: launch(), title: 't' });
  p._h.d('abcd' + '😀😀😀'); // 4 + 6 = 10, then add more
  p._h.d('ef');
  const sb = jm.attach(info.id).scrollback;
  assert.ok(sb.length <= 11);
  assert.ok(!/^[\uDC00-\uDFFF]/.test(sb));
  assert.ok(sb.endsWith('ef'));
});

test('killAll ends every job', async () => {
  jm = new JobManager({ idleMs: 200 });
  jm.start({ accountId: 'a', cwd: process.cwd(), launch: launch(), title: '1' });
  jm.start({ accountId: 'b', cwd: process.cwd(), launch: launch(), title: '2' });
  assert.equal(jm.list().length, 2);
  await jm.killAll();
  assert.equal(jm.list().length, 0);
});
