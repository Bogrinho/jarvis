import test from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../src/notify.js';

test('notification passes encoded Unicode text safely to hidden PowerShell', () => {
  const calls = [];
  let unref = false;
  const spawn = (...args) => { calls.push(args); return { on() {}, unref() { unref = true; } }; };
  const title = "Jarvis δοκιμή ' ; evil";
  const body = 'Οι ειδοποιήσεις δουλεύουν';
  notify({ title, body }, { spawn });
  assert.equal(calls.length, 1);
  const [file, args, options] = calls[0];
  assert.equal(file, 'powershell.exe');
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command']);
  assert.ok(args[5].includes(Buffer.from(title).toString('base64')));
  assert.ok(args[5].includes(Buffer.from(body).toString('base64')));
  assert.ok(!args[5].includes(title));
  assert.ok(args[5].includes("AppUserModelId\\Jarvis"));
  assert.ok(args[5].includes("CreateToastNotifier('Jarvis')"));
  assert.deepEqual(options, { windowsHide: true, detached: true, stdio: 'ignore' });
  assert.ok(unref);
  assert.doesNotThrow(() => notify({ title, body }, { spawn: () => { throw new Error('no'); } }));
});

test('notifications can be disabled', () => {
  const previous = process.env.JARVIS_NO_NOTIFY;
  process.env.JARVIS_NO_NOTIFY = '1';
  try { notify({ title: 'test' }, { spawn: () => assert.fail('spawned') }); }
  finally { if (previous === undefined) delete process.env.JARVIS_NO_NOTIFY; else process.env.JARVIS_NO_NOTIFY = previous; }
});
