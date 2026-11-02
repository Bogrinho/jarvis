import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/chat/setup.js';

const KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'];

function withEnv(t) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) process.env[k] = 'secret-' + k;
  t.after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

const config = {
  accounts: {
    work: { id: 'work', cli: 'codex', side: 'work', env: { CODEX_HOME: 'C:\\w' } },
    mine: { id: 'mine', cli: 'codex', side: 'personal', env: { CODEX_HOME: 'C:\\p' } },
    cl: { id: 'cl', cli: 'claude', side: 'personal', env: {} },
    gem: { id: 'gem', cli: 'gemini', side: 'personal', env: {} },
  },
};

function build(t) {
  withEnv(t);
  const servers = [];
  const claudeCalls = [];
  class FakeServer {
    constructor(o) { this.o = o; this.closed = 0; this.requests = []; servers.push(this); }
    close() { this.closed++; }
    async request(method) { this.requests.push(method); return { data: [] }; }
  }
  const fakeAdapter = { on() {}, removeAllListeners() {}, close() {}, async start() { return { externalId: 'x' }; } };
  const chat = createChat({
    config, indexFile: path.join(os.tmpdir(), `jarvis-setup-${process.pid}-${Date.now()}.json`),
    deps: {
      CodexAppServer: (o) => new FakeServer(o),
      createClaudeAdapter: (o) => { claudeCalls.push(o); return fakeAdapter; },
    },
  });
  return { chat, servers, claudeCalls };
}

test('one codex server per account, each with its own CODEX_HOME and no API keys', async (t) => {
  const { chat, servers } = build(t);
  await chat.history({ account: config.accounts.work, cwd: 'C:\\x' });
  await chat.history({ account: config.accounts.mine, cwd: 'C:\\x' });
  await chat.history({ account: config.accounts.work, cwd: 'C:\\y' });
  assert.equal(servers.length, 2);
  assert.equal(servers[0].o.env.CODEX_HOME, 'C:\\w');
  assert.equal(servers[1].o.env.CODEX_HOME, 'C:\\p');
  for (const s of servers) {
    assert.equal(s.o.env.OPENAI_API_KEY, undefined);
    assert.equal(s.o.env.CODEX_API_KEY, undefined);
  }
  assert.equal(servers[0].requests.length, 2); // second work call reused the server
});

test('claude adapter gets a sanitized env and ~/.claude', async (t) => {
  const { chat, claudeCalls } = build(t);
  await chat.manager.create({ accountId: 'cl', account: config.accounts.cl, cwd: 'C:\\x', side: 'personal', title: 't' });
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(claudeCalls[0].claudeHome, path.join(os.homedir(), '.claude'));
  assert.equal(claudeCalls[0].cwd, 'C:\\x');
  await chat.closeAll();
});

test('gemini history is empty and closeAll closes every codex server', async (t) => {
  const { chat, servers } = build(t);
  assert.deepEqual(await chat.history({ account: config.accounts.gem, cwd: 'C:\\x' }), []);
  await chat.history({ account: config.accounts.work, cwd: 'C:\\x' });
  await chat.history({ account: config.accounts.mine, cwd: 'C:\\x' });
  await chat.closeAll();
  assert.deepEqual(servers.map((s) => s.closed), [1, 1]);
});

test('claude rate limits are saved to the rate file', async (t) => {
  withEnv(t);
  const { EventEmitter } = await import('node:events');
  const { readFile, mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-rate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rateFile = path.join(dir, 'data', 'claude-rate.json');
  const adapter = Object.assign(new EventEmitter(), { close() {}, async start() { return { externalId: 'x' }; } });
  const chat = createChat({
    config, rateFile, indexFile: path.join(dir, 'chats.json'),
    deps: { CodexAppServer: () => ({ close() {} }), createClaudeAdapter: () => adapter },
  });
  await chat.manager.create({ accountId: 'cl', account: config.accounts.cl, cwd: 'C:\\x', side: 'personal', title: 't' });
  const v = { fiveHour: { pct: 70, resetsAt: '2026-11-02T20:00:00.000Z' }, weekly: { pct: 33, resetsAt: '2026-11-07T00:00:00.000Z' } };
  adapter.emit('rate-limits', v);
  let saved;
  for (let i = 0; i < 100 && !saved; i++) {
    try { saved = JSON.parse(await readFile(rateFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.deepEqual(saved.fiveHour, v.fiveHour);
  assert.deepEqual(saved.weekly, v.weekly);
  assert.ok(!Number.isNaN(new Date(saved.updatedAt).getTime()));
  await chat.closeAll();
});
