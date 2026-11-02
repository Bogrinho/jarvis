import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { createServer } from '../src/server.js';

const repoConfig = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jarvis.config.json');
const TOKEN = 'a'.repeat(64);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for condition');
};

function fakeSpawn() {
  const calls = [];
  const spawn = (file, args, opts) => {
    const proc = {
      file, args, opts, writes: [], resizes: [], killed: false,
      onData(cb) { this.dataCb = cb; },
      onExit(cb) { this.exitCb = cb; },
      write(d) { this.writes.push(d); },
      resize(c, r) { this.resizes.push([c, r]); },
      kill() { this.killed = true; this.exitCb?.({ exitCode: 0 }); },
      emit(d) { this.dataCb(d); },
    };
    calls.push(proc);
    return proc;
  };
  return { spawn, calls };
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

async function setup({ deps = {}, onShutdown = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-server-'));
  const raw = JSON.parse(fs.readFileSync(repoConfig, 'utf8'));
  const workPath = path.join(dir, 'WorkProj');
  const personalPath = path.join(dir, 'PersonalProj');
  fs.mkdirSync(workPath);
  fs.mkdirSync(personalPath);
  fs.mkdirSync(path.join(dir, 'vault'));
  fs.writeFileSync(path.join(dir, 'vault', 'today.md'), '- [ ] first\n- [x] second\n');
  raw.projects = [
    { name: 'work-proj', path: workPath, side: 'work' },
    { name: 'personal-proj', path: personalPath, side: 'personal' },
  ];
  raw.port = await freePort();
  const file = path.join(dir, 'jarvis.config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  const config = loadConfig(file);
  const { spawn, calls } = fakeSpawn();
  const jobs = new JobManager({ spawn, idleMs: 100000, promptDelayMs: 10 });
  const server = createServer({
    config, jobs, token: TOKEN, usageIntervalMs: 3600000, onShutdown,
    deps: { collectUsage: async () => ({}), ...deps },
  });
  await server.listen();
  const ctx = { dir, config, jobs, server, calls, port: config.port, workPath, personalPath, sockets: [] };
  current.push(ctx);
  return ctx;
}

function request(ctx, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  const h = { host: `127.0.0.1:${ctx.port}`, 'x-jarvis-token': TOKEN, ...headers };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
    h['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.port, method, path: p, headers: h, setHost: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function openWs(ctx, { query = `?token=${TOKEN}`, headers = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws${query}`, { headers });
  ctx.sockets.push(ws);
  ws.received = [];
  ws.on('message', (m) => ws.received.push(JSON.parse(m.toString())));
  return ws;
}

const wsOutcome = (ws) => new Promise((resolve) => {
  ws.once('open', () => resolve({ open: true }));
  ws.once('unexpected-response', (req, res) => { resolve({ open: false, status: res.statusCode }); });
  ws.once('error', () => resolve({ open: false }));
});

test('binds to 127.0.0.1 only', async () => {
  const ctx = await setup();
  assert.equal(ctx.server.address().address, '127.0.0.1');
});

test('ping answers jarvis without a token', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/api/ping', headers: { 'x-jarvis-token': undefined } });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'jarvis');
});

test('ping still requires a local Host', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/api/ping', headers: { host: `evil.example:${ctx.port}` } });
  assert.equal(r.status, 403);
});

test('rejects foreign Origin', async () => {
  const ctx = await setup();
  const r = await request(ctx, {
    method: 'POST', path: '/api/jobs', headers: { origin: 'https://evil.example' },
    body: { accountId: 'claude', useHome: true },
  });
  assert.equal(r.status, 403);
  assert.equal(ctx.calls.length, 0);
});

test('rejects Origin with the right host but wrong port or scheme', async () => {
  const ctx = await setup();
  for (const origin of [`http://127.0.0.1:${ctx.port + 1}`, `https://127.0.0.1:${ctx.port}`, 'null']) {
    const r = await request(ctx, { method: 'POST', path: '/api/jobs', headers: { origin }, body: { accountId: 'claude' } });
    assert.equal(r.status, 403, origin);
  }
  assert.equal(ctx.calls.length, 0);
});

test('accepts a local Origin', async () => {
  const ctx = await setup();
  const r = await request(ctx, {
    method: 'POST', path: '/api/jobs', headers: { origin: `http://localhost:${ctx.port}`, host: `localhost:${ctx.port}` },
    body: { accountId: 'claude' },
  });
  assert.equal(r.status, 201);
});

test('rejects rebinding Host', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/api/state', headers: { host: `evil.example:${ctx.port}` } });
  assert.equal(r.status, 403);
  const page = await request(ctx, { path: '/', headers: { host: `evil.example:${ctx.port}` } });
  assert.equal(page.status, 403);
  assert.ok(!page.text.includes(TOKEN));
});

test('rejects missing or wrong token', async () => {
  const ctx = await setup();
  const none = await request(ctx, { path: '/api/state', headers: { 'x-jarvis-token': undefined } });
  assert.equal(none.status, 403);
  const wrong = await request(ctx, { path: '/api/state', headers: { 'x-jarvis-token': 'b'.repeat(64) } });
  assert.equal(wrong.status, 403);
  const short = await request(ctx, {
    method: 'POST', path: '/api/jobs', headers: { 'x-jarvis-token': 'a' }, body: { accountId: 'claude' },
  });
  assert.equal(short.status, 403);
  assert.equal(ctx.calls.length, 0);
});

test('WS upgrade without token, with wrong token, or foreign Origin is refused', async () => {
  const ctx = await setup();
  const a = await wsOutcome(openWs(ctx, { query: '' }));
  assert.equal(a.open, false);
  const b = await wsOutcome(openWs(ctx, { query: `?token=${'b'.repeat(64)}` }));
  assert.equal(b.open, false);
  const c = await wsOutcome(openWs(ctx, { headers: { origin: 'https://evil.example' } }));
  assert.equal(c.open, false);
  const d = await wsOutcome(openWs(ctx, { headers: { host: `evil.example:${ctx.port}` } }));
  assert.equal(d.open, false);
});

test('serves index.html with the token injected', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/', headers: { 'x-jarvis-token': undefined } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.ok(r.text.includes(`<meta name="jarvis-token" content="${TOKEN}">`));
});

test('serves xterm vendor files', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/vendor/xterm/xterm/lib/xterm.js' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
  const fit = await request(ctx, { path: '/vendor/xterm/addon-fit/lib/addon-fit.js' });
  assert.equal(fit.status, 200);
});

test('blocks path traversal in static serving', async () => {
  const ctx = await setup();
  const pkg = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8');
  const attempts = [
    '/../package.json',
    '/%2e%2e/package.json',
    '/%2E%2E/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/..%5cpackage.json',
    '/..\\package.json',
    '/vendor/xterm/xterm/../../../package.json',
    '/vendor/xterm/%2e%2e/%2e%2e/%2e%2e/package.json',
    '/vendor/xterm/ws/package.json',
    '/C:/Windows/win.ini',
    '/C%3A%5CWindows%5Cwin.ini',
    '//etc/passwd',
    '/%00index.html',
  ];
  for (const p of attempts) {
    const r = await request(ctx, { path: p });
    assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('"dependencies"'), p);
    assert.notEqual(r.text, pkg, p);
  }
});

test('state lists accounts with side, projects, quick commands and directives', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/api/state' });
  assert.equal(r.status, 200);
  const claude = r.json.accounts.find((a) => a.id === 'claude');
  assert.deepEqual(claude, { id: 'claude', label: 'Claude', side: 'personal', color: claude.color, enabled: true });
  assert.ok(r.json.accounts.every((a) => !('env' in a) && !('home' in a)));
  assert.ok(r.json.projects.some((p) => p.side === 'work'));
  assert.deepEqual(r.json.quickCommands[0], { id: 'plan-today', label: 'Plan Today' });
  assert.deepEqual(r.json.jobs, []);
  assert.deepEqual(r.json.directives, [{ text: 'first', done: false }, { text: 'second', done: true }]);
});

test('usage is collected, recorded and merged with series and perDay', async () => {
  const appended = [];
  const ctx = await setup({
    deps: {
      collectUsage: async () => ({
        mine: { kind: 'percent', weekly: { pct: 42 }, fiveHour: { pct: 3 } },
        gemini: { kind: 'none', reason: 'not set up' },
      }),
      appendSnapshot: async (file, id, pct) => { appended.push([file, id, pct]); },
      getSeries: async (file, id) => (id === 'mine' ? [{ at: new Date(0), pct: 10 }, { at: new Date(1), pct: 42 }] : []),
      perDayRate: (s) => (s.length ? 5.5 : null),
    },
  });
  let state;
  await until(async () => {
    state = (await request(ctx, { path: '/api/state' })).json;
    return state.usage?.mine;
  });
  assert.deepEqual(state.usage.mine.series, [10, 42]);
  assert.equal(state.usage.mine.perDay, 5.5);
  assert.equal(state.usage.mine.weekly.pct, 42);
  assert.deepEqual(state.usage.gemini.series, []);
  assert.equal(state.usage.gemini.perDay, null);
  assert.deepEqual(appended, [[path.join(ctx.config.rootDir, 'data', 'usage-history.json'), 'mine', 42]]);
});

test('a failing usage refresh does not crash the server', async () => {
  const ctx = await setup({ deps: { collectUsage: async () => { throw new Error('boom'); } } });
  await new Promise((r) => setTimeout(r, 50));
  const r = await request(ctx, { path: '/api/state' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.usage, {});
});

test('refuses work project with claude', async () => {
  const ctx = await setup();
  const r = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', projectPath: ctx.workPath } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: 'SIDE_MISMATCH' });
  assert.equal(ctx.calls.length, 0);
});

test('rejects unknown account, bad input, oversized and non-JSON bodies', async () => {
  const ctx = await setup();
  const unknown = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'nope' } });
  assert.ok([400, 403].includes(unknown.status));
  assert.equal(typeof unknown.json.error, 'string');
  const proto = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: '__proto__' } });
  assert.ok([400, 403].includes(proto.status));
  const badType = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', prompt: 5 } });
  assert.equal(badType.status, 400);
  const arr = await request(ctx, { method: 'POST', path: '/api/jobs', body: [] });
  assert.equal(arr.status, 400);
  const notJson = await request(ctx, { method: 'POST', path: '/api/jobs', body: 'accountId=claude' });
  assert.equal(notJson.status, 400);
  assert.ok(!notJson.text.includes('at '), 'no stack trace');
  const big = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', prompt: 'x'.repeat(70 * 1024) } });
  assert.equal(big.status, 400);
  const badCmd = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', quickCommandId: 'nope' } });
  assert.equal(badCmd.status, 400);
  assert.equal(ctx.calls.length, 0);
});

test('starts a job and streams data over ws', async () => {
  const ctx = await setup();
  const ws = openWs(ctx);
  assert.equal((await wsOutcome(ws)).open, true);
  const r = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'mine', projectPath: ctx.personalPath, prompt: 'hello' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.accountId, 'mine');
  assert.equal(r.json.state, 'working');
  const proc = ctx.calls[0];
  assert.equal(proc.opts.cwd, ctx.personalPath);
  await until(() => ws.received.some((m) => m.type === 'jobs' && m.list.some((j) => j.id === r.json.id)));
  proc.emit('early output');
  ws.send(JSON.stringify({ type: 'attach', id: r.json.id }));
  await until(() => ws.received.some((m) => m.type === 'scrollback' && m.id === r.json.id && m.data === 'early output'));
  proc.emit('more');
  await until(() => ws.received.some((m) => m.type === 'data' && m.id === r.json.id && m.data === 'more'));
  ws.send(JSON.stringify({ type: 'input', id: r.json.id, data: 'typed' }));
  ws.send(JSON.stringify({ type: 'resize', id: r.json.id, cols: 100, rows: 40 }));
  await until(() => proc.writes.includes('typed') && proc.resizes.length === 1);
  assert.deepEqual(proc.resizes[0], [100, 40]);
  // prompt text first, then Enter as its own write (user input may land in between)
  await until(() => proc.writes.includes('hello') && proc.writes.indexOf('\r', proc.writes.indexOf('hello')) > 0);
  // garbage and unknown ids are ignored
  ws.send('not json');
  ws.send(JSON.stringify({ type: 'input', id: 'nope', data: 'x' }));
  ws.send(JSON.stringify({ type: 'resize', id: r.json.id, cols: -1, rows: 'x' }));
  ws.send(JSON.stringify({ type: 'attach', id: 'nope' }));
  ws.send(JSON.stringify({ type: 'kill', id: r.json.id }));
  await until(() => proc.killed);
  await until(() => ws.received.some((m) => m.type === 'jobs' && !m.list.some((j) => j.id === r.json.id)));
  assert.equal(proc.resizes.length, 1);
  const ping = await request(ctx, { path: '/api/ping' });
  assert.equal(ping.text, 'jarvis');
});

test('quick command runs in account home', async () => {
  const ctx = await setup();
  const r = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', quickCommandId: 'plan-today', projectPath: ctx.personalPath } });
  assert.equal(r.status, 201);
  const proc = ctx.calls[0];
  assert.equal(proc.opts.cwd, ctx.config.accounts.claude.home);
  proc.emit('ready');
  const prompt = ctx.config.quickCommands.find((q) => q.id === 'plan-today').prompt;
  await until(() => proc.writes.join('|').includes(prompt + '|\r'));

  const work = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'work', quickCommandId: 'plan-today' } });
  assert.equal(work.status, 403);
  assert.deepEqual(work.json, { error: 'NO_HOME' });
  assert.equal(ctx.calls.length, 1);
});

test('shutdown kills jobs and calls onShutdown', async () => {
  let shut = 0;
  const ctx = await setup({ onShutdown: () => { shut++; } });
  await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude' } });
  const r = await request(ctx, { method: 'POST', path: '/api/shutdown' });
  assert.equal(r.status, 200);
  assert.equal(ctx.calls[0].killed, true);
  await until(() => shut === 1);
});

test('shutdown requires the token', async () => {
  let shut = 0;
  const ctx = await setup({ onShutdown: () => { shut++; } });
  const r = await request(ctx, { method: 'POST', path: '/api/shutdown', headers: { 'x-jarvis-token': undefined } });
  assert.equal(r.status, 403);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(shut, 0);
});

test('editing the directives file pushes the new list over ws', async () => {
  const ctx = await setup();
  const ws = openWs(ctx);
  assert.deepEqual(await wsOutcome(ws), { open: true });
  await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(path.join(ctx.dir, 'vault', 'today.md'), '- [ ] changed task\n- [ ] another\n');
  await until(() => ws.received.some((m) => m.type === 'directives'
    && m.list.length === 2 && m.list[0].text === 'changed task' && m.list[0].done === false));
});

test('usage refresh re-reads directives as a fallback and only broadcasts changes', async () => {
  const ctx = await setup({ deps: { watch: () => ({ close() {}, on() {} }) } });
  const ws = openWs(ctx);
  assert.deepEqual(await wsOutcome(ws), { open: true });
  await ctx.server.refreshUsage();
  assert.equal(ws.received.filter((m) => m.type === 'directives').length, 0);
  fs.writeFileSync(path.join(ctx.dir, 'vault', 'today.md'), '- [x] via refresh\n');
  await ctx.server.refreshUsage();
  await until(() => ws.received.some((m) => m.type === 'directives' && m.list[0]?.text === 'via refresh'));
  await ctx.server.refreshUsage();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ws.received.filter((m) => m.type === 'directives').length, 1);
});
