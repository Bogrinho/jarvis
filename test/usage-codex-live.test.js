import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readCodexLive } from '../src/usage/codex-live.js';

const NOW = new Date('2026-11-02T16:00:00Z');

// A fake `codex app-server`: answers initialize, then account/rateLimits/read with `reply`.
function fakeSpawn(reply, calls = []) {
  return (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const m = JSON.parse(line);
          calls.push(m.method);
          if (m.method === 'initialize') child.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
          if (m.method === 'account/rateLimits/read' && reply) child.stdout.write(JSON.stringify({ id: m.id, ...reply }) + '\n');
        }
        cb();
      },
    });
    calls.opts = opts;
    calls.child = child;
    return child;
  };
}

const limits = {
  result: {
    rateLimits: {
      primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1793651044 },
      secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1793802277 },
      planType: 'plus',
    },
  },
};

test('reads live 5h and weekly percentages with the account CODEX_HOME', async () => {
  const calls = [];
  const u = await readCodexLive('C:\\Users\\x\\.codex-personal', { spawn: fakeSpawn(limits, calls), now: NOW });
  assert.deepEqual(u, {
    kind: 'percent',
    fiveHour: { pct: 13, resetsAt: new Date(1793651044 * 1000) },
    weekly: { pct: 48, resetsAt: new Date(1793802277 * 1000) },
    plan: 'plus',
    updatedAt: NOW,
  });
  assert.deepEqual(calls.slice(0, 3), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(calls.opts.env.CODEX_HOME, 'C:\\Users\\x\\.codex-personal');
  assert.equal(calls.child.killed, true);
});

test('API keys never reach the usage process', async () => {
  const calls = [];
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  try {
    await readCodexLive('C:\\h', { spawn: fakeSpawn(limits, calls), now: NOW });
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
  assert.equal(calls.opts.env.OPENAI_API_KEY, undefined);
});

test('an error reply, missing windows or a silent server give null', async () => {
  assert.equal(await readCodexLive('C:\\h', { spawn: fakeSpawn({ error: { message: 'not logged in' } }), now: NOW }), null);
  assert.equal(await readCodexLive('C:\\h', { spawn: fakeSpawn({ result: { rateLimits: { primary: null } } }), now: NOW }), null);
  const calls = [];
  assert.equal(await readCodexLive('C:\\h', { spawn: fakeSpawn(null, calls), now: NOW, timeoutMs: 100 }), null);
  assert.equal(calls.child.killed, true);
});

test('a spawn failure gives null', async () => {
  assert.equal(await readCodexLive('C:\\h', { spawn: () => { throw new Error('ENOENT'); }, now: NOW }), null);
  assert.equal(await readCodexLive(null, { spawn: fakeSpawn(limits), now: NOW }), null);
});

test('windows already past their reset show 0%', async () => {
  const later = new Date(1793651044 * 1000 + 1000);
  const u = await readCodexLive('C:\\h', { spawn: fakeSpawn(limits), now: later });
  assert.deepEqual(u.fiveHour, { pct: 0, resetsAt: new Date(1793651044 * 1000), reset: true });
  assert.equal(u.weekly.pct, 48);
});
