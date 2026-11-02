import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { createServer } from '../src/server.js';
import { ChatManager } from '../src/chat/manager.js';

const repoConfig = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jarvis.config.json');
const TOKEN = 'a'.repeat(64);
const UUID = '11111111-2222-4333-8444-555555555555';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout waiting for condition');
};

class FakeAdapter extends EventEmitter {
  constructor(account, cwd) { super(); this.account = account; this.cwd = cwd; this.sent = []; this.answers = []; this.closed = false; }
  async start({ resumeId }) { this.resumeId = resumeId; return { externalId: resumeId ?? 'ext-new' }; }
  send(t) { this.sent.push(t); }
  interrupt() { this.interrupted = true; }
  answer(token, decision) { this.answers.push([token, decision]); }
  close() { this.closed = true; }
}

let current = [];
afterEach(async () => {
  for (const c of current) {
    for (const ws of c.sockets) ws.terminate();
    await c.server.close();
    await c.jobs.killAll();
  }
  current = [];
});

const norm = (p) => path.resolve(p).toLowerCase();

// `history` is filled by the test after setup: { 'accountId|normalizedCwd': [{externalId,title,updatedAt}] }
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-srvchat-'));
  const raw = JSON.parse(fs.readFileSync(repoConfig, 'utf8'));
  raw.accounts.work.home = null;
  for (const id of ['mine', 'claude', 'gemini']) raw.accounts[id].home = 'vault';
  raw.accounts.gemini.enabled = true;
  const workPath = path.join(dir, 'WorkProj');
  const personalPath = path.join(dir, 'PersonalProj');
  fs.mkdirSync(workPath); fs.mkdirSync(personalPath); fs.mkdirSync(path.join(dir, 'vault'));
  raw.projects = [
    { name: 'work-proj', path: workPath, side: 'work' },
    { name: 'personal-proj', path: personalPath, side: 'personal' },
  ];
  raw.port = await freePort();
  const file = path.join(dir, 'jarvis.config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  const config = loadConfig(file);
  const jobs = new JobManager({ spawn: () => { throw new Error('no terminals in chat tests'); }, idleMs: 100000 });
  const adapters = [];
  const make = (account, cwd) => { const a = new FakeAdapter(account, cwd); adapters.push(a); return a; };
  const chats = new ChatManager({ adapters: { codex: make, claude: make }, indexFile: path.join(dir, 'data', 'chats.json') });
  const history = {};
  // The real lister returns extra fields (cwd ...); the server must strip them.
  const chatHistory = async ({ account, cwd }) => (history[`${account.id}|${norm(cwd)}`] ?? [])
    .map((h) => ({ ...h, cwd: 'LEAK', secret: 'LEAK' }));
  const server = createServer({
    config, jobs, token: TOKEN, usageIntervalMs: 3600000, onShutdown: () => {},
    chats, chatHistory, deps: { collectUsage: async () => ({}) },
  });
  await server.listen();
  const ctx = { dir, config, jobs, server, chats, adapters, history, port: config.port, workPath, personalPath, sockets: [] };
  current.push(ctx);
  return ctx;
}

function request(ctx, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  const h = { host: `127.0.0.1:${ctx.port}`, 'x-jarvis-token': TOKEN, ...headers };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
    h['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.port, method, path: p, headers: h, setHost: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function openWs(ctx) {
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${TOKEN}`);
  ctx.sockets.push(ws);
  ws.received = [];
  ws.on('message', (m) => ws.received.push(JSON.parse(m.toString())));
  return new Promise((resolve) => ws.once('open', () => resolve(ws)));
}

const post = (ctx, body) => request(ctx, { method: 'POST', path: '/api/chats', body });

test('chat routes reject foreign Origin and missing token', async () => {
  const ctx = await setup();
  const routes = [
    ['GET', '/api/chats'], ['POST', '/api/chats'], ['GET', `/api/chats/${UUID}`],
    ['POST', `/api/chats/${UUID}/messages`], ['POST', `/api/chats/${UUID}/approvals/${UUID}`],
    ['POST', `/api/chats/${UUID}/interrupt`], ['DELETE', `/api/chats/${UUID}`],
    ['GET', '/api/chat-history?accountId=claude&useHome=1'],
  ];
  for (const [method, p] of routes) {
    const body = method === 'POST' ? { accountId: 'claude', useHome: true, text: 'x', decision: 'approve' } : undefined;
    const noTok = await request(ctx, { method, path: p, body, headers: { 'x-jarvis-token': undefined } });
    assert.equal(noTok.status, 403, `${method} ${p} without token`);
    const evil = await request(ctx, { method, path: p, body, headers: { origin: 'http://evil.example' } });
    assert.equal(evil.status, 403, `${method} ${p} foreign origin`);
    const badHost = await request(ctx, { method, path: p, body, headers: { host: 'evil.example' } });
    assert.equal(badHost.status, 403, `${method} ${p} foreign host`);
  }
  assert.equal(ctx.adapters.length, 0);
});

test('chat WS refuses a foreign origin', async () => {
  const ctx = await setup();
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${TOKEN}`, { headers: { origin: 'http://evil.example' } });
  ctx.sockets.push(ws);
  const outcome = await new Promise((r) => {
    ws.once('open', () => r('open'));
    ws.once('unexpected-response', (q, s) => r(s.statusCode));
    ws.once('error', () => r('error'));
  });
  assert.notEqual(outcome, 'open');
});

test('personal account cannot open work folder chat (SIDE_MISMATCH)', async () => {
  const ctx = await setup();
  const r = await post(ctx, { accountId: 'mine', projectPath: ctx.workPath });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'SIDE_MISMATCH');
  const h = await request(ctx, { path: `/api/chat-history?accountId=mine&projectPath=${encodeURIComponent(ctx.workPath)}` });
  assert.equal(h.status, 403);
  assert.equal(ctx.adapters.length, 0);
});

test('message flows to adapter and items reach attached ws', async () => {
  const ctx = await setup();
  const c = await post(ctx, { accountId: 'mine', projectPath: ctx.personalPath, prompt: 'hello' });
  assert.equal(c.status, 201);
  const id = c.json.id;
  assert.equal(ctx.adapters[0].cwd, ctx.personalPath);
  assert.deepEqual(ctx.adapters[0].sent, ['hello']);
  const ws = await openWs(ctx);
  await until(() => ws.received.some((m) => m.type === 'chats' && m.list.some((x) => x.id === id)));
  ws.send(JSON.stringify({ type: 'chat-attach', id }));
  await until(() => ws.received.some((m) => m.type === 'chat-snapshot'));
  const m = await request(ctx, { method: 'POST', path: `/api/chats/${id}/messages`, body: { text: 'more' } });
  assert.equal(m.status, 200);
  assert.deepEqual(ctx.adapters[0].sent, ['hello', 'more']);
  const a = ctx.adapters[0];
  a.emit('item', { id: 'i1', kind: 'assistant', text: 'Hi', streaming: true });
  a.emit('delta', 'i1', ' there');
  a.emit('update', 'i1', { streaming: false });
  await until(() => ws.received.some((x) => x.type === 'chat-update'));
  assert.ok(ws.received.some((x) => x.type === 'chat-item' && x.id === id && x.item.kind === 'assistant'));
  assert.ok(ws.received.some((x) => x.type === 'chat-delta' && x.id === id && x.itemId === 'i1' && x.text === ' there'));
  assert.ok(ws.received.some((x) => x.type === 'chat-update' && x.id === id && x.itemId === 'i1' && x.patch.streaming === false));
  // an unattached socket gets no per-chat traffic
  const other = await openWs(ctx);
  a.emit('item', { id: 'i2', kind: 'notice', text: 'x' });
  await until(() => ws.received.some((x) => x.type === 'chat-item' && x.item.id === 'i2'));
  assert.ok(!other.received.some((x) => x.type === 'chat-item'));
});

test('get one chat, interrupt, close, and bad ids', async () => {
  const ctx = await setup();
  const id = (await post(ctx, { accountId: 'claude', useHome: true })).json.id;
  assert.equal((await request(ctx, { path: '/api/chats' })).json.length, 1);
  const one = await request(ctx, { path: `/api/chats/${id}` });
  assert.equal(one.json.info.id, id);
  assert.deepEqual(one.json.items, []);
  assert.equal((await request(ctx, { method: 'POST', path: `/api/chats/${id}/interrupt`, body: {} })).status, 200);
  assert.equal(ctx.adapters[0].interrupted, true);
  assert.equal((await request(ctx, { path: '/api/chats/not-a-uuid' })).status, 404);
  assert.equal((await request(ctx, { path: `/api/chats/${UUID}` })).status, 404);
  assert.equal((await request(ctx, { method: 'POST', path: `/api/chats/${id}/messages`, body: { text: '' } })).status, 400);
  assert.equal((await request(ctx, { method: 'POST', path: `/api/chats/${id}/messages`, body: { text: 5 } })).status, 400);
  assert.equal((await request(ctx, { method: 'DELETE', path: `/api/chats/${id}` })).status, 200);
  assert.equal(ctx.adapters[0].closed, true);
  assert.equal((await request(ctx, { path: `/api/chats/${id}` })).status, 404);
});

test('quick command creates a chat in the account home with the command prompt', async () => {
  const ctx = await setup();
  const r = await post(ctx, { accountId: 'claude', quickCommandId: 'plan-today' });
  assert.equal(r.status, 201);
  assert.equal(r.json.title, 'Plan Today');
  assert.match(ctx.adapters[0].sent[0], /plan my day/);
  assert.equal((await post(ctx, { accountId: 'claude', quickCommandId: 'nope' })).status, 400);
});

test('gemini chat -> 400 CHAT_UNSUPPORTED', async () => {
  const ctx = await setup();
  const r = await post(ctx, { accountId: 'gemini', useHome: true });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'CHAT_UNSUPPORTED');
  const h = await request(ctx, { path: '/api/chat-history?accountId=gemini&useHome=1' });
  assert.equal(h.status, 400);
});

test('history lists only externalId/title/updatedAt; resume must come from that list', async () => {
  const ctx = await setup();
  const entry = { externalId: 'thread-p', title: 'Mine', updatedAt: '2026-01-01T00:00:00Z' };
  ctx.history[`mine|${norm(ctx.personalPath)}`] = [entry];
  const list = await request(ctx, { path: `/api/chat-history?accountId=mine&projectPath=${encodeURIComponent(ctx.personalPath)}` });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, [entry]);

  const ok = await post(ctx, { accountId: 'mine', projectPath: ctx.personalPath, resumeId: 'thread-p' });
  assert.equal(ok.status, 201);
  assert.equal(ctx.adapters.at(-1).resumeId, 'thread-p');
  assert.equal(ok.json.externalId, 'thread-p');

  const typed = await post(ctx, { accountId: 'mine', projectPath: ctx.personalPath, resumeId: 'made-up' });
  assert.equal(typed.status, 404);
  assert.equal(typed.json.error, 'NO_SUCH_HISTORY');
  assert.equal((await post(ctx, { accountId: 'mine', projectPath: ctx.personalPath, resumeId: 7 })).status, 400);
  assert.equal(ctx.adapters.length, 1);

  // the same thread is already open: return the live chat, no second adapter
  const again = await post(ctx, { accountId: 'mine', projectPath: ctx.personalPath, resumeId: 'thread-p' });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, ok.json.id);
  assert.equal(ctx.adapters.length, 1);
});

test('first prompt failure is visible in the transcript', async () => {
  const ctx = await setup();
  const orig = ctx.chats.send.bind(ctx.chats);
  ctx.chats.send = () => { throw new Error('boom'); };
  const r = await post(ctx, { accountId: 'mine', useHome: true, prompt: 'hi' });
  ctx.chats.send = orig;
  assert.equal(r.status, 201);
  const { items } = ctx.chats.get(r.json.id);
  assert.ok(items.some((i) => i.kind === 'error' && /first message/i.test(i.text)));
});

test('interrupt ignores the request body entirely', async () => {
  const ctx = await setup();
  const id = (await post(ctx, { accountId: 'claude', useHome: true })).json.id;
  const r = await request(ctx, { method: 'POST', path: `/api/chats/${id}/interrupt` });
  assert.equal(r.status, 200);
});

test('resume of a thread whose cwd is on the other side is refused', async () => {
  const ctx = await setup();
  // a thread recorded under the work folder is not resumable from a personal folder
  ctx.history[`mine|${norm(ctx.workPath)}`] = [{ externalId: 'thread-w', title: 'W', updatedAt: null }];
  const r = await post(ctx, { accountId: 'mine', projectPath: ctx.personalPath, resumeId: 'thread-w' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'SIDE_MISMATCH');
  assert.equal(ctx.adapters.length, 0);
});

test("approval answer for another conversation's approvalId is 404", async () => {
  const ctx = await setup();
  const a = (await post(ctx, { accountId: 'mine', useHome: true })).json.id;
  const b = (await post(ctx, { accountId: 'claude', useHome: true })).json.id;
  ctx.adapters[0].emit('approval', { token: 't1', title: 'Run?', detail: 'x', command: 'ls' });
  const item = ctx.chats.get(a).items.find((i) => i.kind === 'approval');
  const ans = (cid, aid, decision) => request(ctx, { method: 'POST', path: `/api/chats/${cid}/approvals/${aid}`, body: { decision } });
  assert.equal((await ans(b, item.approvalId, 'approve')).status, 404);
  assert.equal(ctx.adapters[0].answers.length, 0);
  assert.equal((await ans(a, 'not-uuid', 'approve')).status, 404);
  assert.equal((await ans(a, item.approvalId, 'sure')).status, 400);
  assert.equal((await ans(a, item.approvalId, 'approve')).status, 200);
  assert.deepEqual(ctx.adapters[0].answers, [['t1', 'approve']]);
  assert.equal((await ans(a, item.approvalId, 'approve')).status, 404);
});

test('attach after reconnect replays transcript and pending approval', async () => {
  const ctx = await setup();
  const id = (await post(ctx, { accountId: 'mine', useHome: true, prompt: 'go' })).json.id;
  ctx.adapters[0].emit('item', { id: 'i1', kind: 'assistant', text: 'ok', streaming: false });
  ctx.adapters[0].emit('approval', { token: 't1', title: 'Run?', detail: 'd' });
  const ws = await openWs(ctx);
  ws.send(JSON.stringify({ type: 'chat-attach', id }));
  await until(() => ws.received.some((m) => m.type === 'chat-snapshot'));
  const snap = ws.received.find((m) => m.type === 'chat-snapshot');
  assert.equal(snap.id, id);
  assert.equal(snap.info.id, id);
  assert.deepEqual(snap.items.map((i) => i.kind), ['user', 'assistant', 'approval']);
  assert.equal(snap.items[2].state, 'pending');
  assert.match(snap.items[2].approvalId, /^[0-9a-f-]{36}$/);
  ws.terminate();
  const ws2 = await openWs(ctx);
  ws2.send(JSON.stringify({ type: 'chat-attach', id }));
  await until(() => ws2.received.some((m) => m.type === 'chat-snapshot'));
  assert.equal(ws2.received.find((m) => m.type === 'chat-snapshot').items.length, 3);
  // unknown ids get no reply and do not break the socket
  ws2.send(JSON.stringify({ type: 'chat-attach', id: 'nope' }));
  ws2.send(JSON.stringify({ type: 'chat-attach', id: UUID }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ws2.received.filter((m) => m.type === 'chat-snapshot').length, 1);
});

test('shutdown route also closes chats', async () => {
  const ctx = await setup();
  await post(ctx, { accountId: 'mine', useHome: true });
  const r = await request(ctx, { method: 'POST', path: '/api/shutdown', body: {} });
  assert.equal(r.status, 200);
  assert.equal(ctx.adapters[0].closed, true);
});
