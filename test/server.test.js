import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { createServer } from '../src/server.js';

const repoConfig = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jarvis.config.json');
const TOKEN = 'a'.repeat(64);
const run = promisify(execFile);
const hookScript = fileURLToPath(new URL('../scripts/jarvis-hook.js', import.meta.url));

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

async function setup({ deps = {}, onShutdown = () => {}, edit = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-server-'));
  const raw = JSON.parse(fs.readFileSync(repoConfig, 'utf8'));
  // Fixed homes so the tests don't depend on the user's own folders.
  raw.accounts.work.home = null;
  for (const id of ['mine', 'claude', 'gemini']) raw.accounts[id].home = 'vault';
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
  edit(raw);
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

test('remote HTTP and WebSocket share the identity and origin checks', async () => {
  const host = 'pc.tail.ts.net';
  const ctx = await setup({ edit(raw) { raw.remote = { enabled: true, host, allowedUsers: ['Owner@example.com'] }; } });
  const remote = { host, origin: `https://${host}`, 'tailscale-user-login': 'OWNER@example.com' };
  for (const [headers, status] of [
    [{ host }, 403], [{ ...remote, 'tailscale-user-login': 'other@example.com' }, 403],
    [{ ...remote, host: 'other.ts.net' }, 403], [{ ...remote, origin: 'http://' + host }, 403],
    [{ host: `localhost:${ctx.port}`, 'x-forwarded-host': host }, 403],
    [remote, 200], [{ ...remote, host: host + ':443' }, 200], [{}, 200],
  ]) {
    const page = await request(ctx, { headers });
    assert.equal(page.status, status);
    if (status === 200) assert.ok(page.text.includes(TOKEN));
    const socket = await wsOutcome(openWs(ctx, { headers }));
    assert.deepEqual(socket, status === 200 ? { open: true } : { open: false, status });
  }
});

test('remote detection reads the status DNS name and permits identified users', async () => {
  const logs = [];
  const ctx = await setup({
    edit(raw) { raw.remote = { enabled: true }; },
    deps: {
      async execFile(file, args, options) {
        assert.equal(file, 'tailscale');
        assert.deepEqual(args, ['status', '--json']);
        assert.equal(options.timeout, 5000);
        return { stdout: '{"Self":{"DNSName":"PC.tail.ts.net."}}' };
      },
      log: msg => logs.push(msg),
    },
  });
  const headers = { host: 'pc.tail.ts.net' };
  assert.ok(logs.includes('Remote (Tailscale): https://pc.tail.ts.net/'));
  assert.equal((await request(ctx, { headers })).status, 403);
  headers['tailscale-user-login'] = 'user@example.com';
  const manifest = await request(ctx, { headers, path: '/manifest.webmanifest' });
  assert.equal(manifest.headers['content-type'], 'application/manifest+json');
  assert.equal(manifest.json.name, 'Jarvis');
  for (const icon of manifest.json.icons) assert.equal((await request(ctx, { headers, path: icon.src })).status, 200);
});

test('invalid Tailscale status leaves local access working and remote disabled', async () => {
  const logs = [];
  const ctx = await setup({
    edit(raw) { raw.remote = { enabled: true }; },
    deps: { execFile: async () => ({ stdout: 'invalid' }), log: msg => logs.push(msg) },
  });
  assert.ok(logs.some(line => line.includes('Remote (Tailscale) disabled')));
  assert.equal((await request(ctx)).status, 200);
  assert.equal((await request(ctx, { headers: { host: 'pc.tail.ts.net', 'tailscale-user-login': 'owner' } })).status, 403);
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

test('serves the Jarvis icon', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/jarvis.ico' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/x-icon');
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
  assert.deepEqual(claude, { id: 'claude', label: 'Claude', side: 'personal', color: claude.color, enabled: true, chat: false, cli: claude.cli, mode: claude.mode });
  assert.ok(['codex', 'claude', 'gemini'].includes(claude.cli) && ['cautious', 'edit-in-project'].includes(claude.mode));
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

test('only the active terminal viewer controls size, including after disconnect', async () => {
  const ctx = await setup();
  const job = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'mine', projectPath: ctx.personalPath } });
  assert.equal(job.status, 201);
  const id = job.json.id;
  const proc = ctx.calls[0];
  const send = (ws, type, fields = {}) => ws.send(JSON.stringify({ type, id, ...fields }));
  async function attach(ws) {
    const count = () => ws.received.filter(m => m.type === 'scrollback' && m.id === id).length;
    const previous = count();
    send(ws, 'attach');
    await until(() => count() > previous);
  }
  async function viewer(cols) {
    const ws = openWs(ctx);
    assert.equal((await wsOutcome(ws)).open, true);
    await attach(ws);
    send(ws, 'resize', { cols, rows: 30 });
    await attach(ws); // Wait for the preceding resize to be processed on this socket.
    return ws;
  }
  const pc = await viewer(120);
  const phone = await viewer(40);
  const tablet = await viewer(80);
  send(phone, 'active', { cols: -1, rows: 30 });
  await attach(phone);
  assert.deepEqual(proc.resizes, [[120, 30]]);
  send(phone, 'active');
  await until(() => proc.resizes.length === 2);
  send(pc, 'resize', { cols: 140, rows: 35 });
  await attach(pc);
  assert.deepEqual(proc.resizes.at(-1), [40, 30]);
  send(tablet, 'input', { data: 'typed' });
  await until(() => proc.writes.includes('typed'));
  assert.deepEqual(proc.resizes.at(-1), [80, 30]);
  send(tablet, 'active', { cols: 85, rows: 32 });
  await attach(tablet);
  tablet.close();
  await until(() => proc.resizes.at(-1)[0] === 40);
  phone.close();
  await until(() => proc.resizes.at(-1)[0] === 140);
  assert.deepEqual(proc.resizes, [[120, 30], [40, 30], [80, 30], [85, 32], [40, 30], [140, 35]]);
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

test('job state hooks require authentication, a valid state and a matching live job id', async () => {
  const ctx = await setup();
  const { json: { id } } = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'mine' } });
  const post = (body, headers) => request(ctx, { method: 'POST', path: `/api/jobs/${id}/state`, body, headers });
  for (const token of [undefined, 'incorrect']) {
    assert.equal((await post({ id, state: 'done' }, { 'x-jarvis-token': token })).status, 403);
  }
  for (const body of [{}, { state: 'idle' }, { state: 'error' }, { state: 1 }, { id: 'other', state: 'done' }, null]) {
    assert.equal((await post(body)).status, 400);
  }
  const unknown = await request(ctx, { method: 'POST', path: '/api/jobs/unknown/state', body: { state: 'done' } });
  assert.equal(unknown.status, 404);
  assert.equal(ctx.jobs.attach(id).info.state, 'working');
});

test('a spawned notify command broadcasts completion, and Enter starts the next turn', async () => {
  const notices = [];
  const ctx = await setup({ deps: { notify: n => notices.push(n) } });
  const ws = openWs(ctx);
  assert.equal((await wsOutcome(ws)).open, true);
  const { json: job } = await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'mine' } });
  const proc = ctx.calls[0];
  const config = proc.args[proc.args.indexOf('-c') + 1];
  const [node, ...args] = JSON.parse(config.slice('notify='.length));
  assert.equal(proc.opts.env.JARVIS_JOB_ID, job.id);
  assert.equal(proc.opts.env.JARVIS_URL, `http://127.0.0.1:${ctx.port}`);
  const result = await run(node, [...args, '{"type":"agent-turn-complete"}'], { env: proc.opts.env, timeout: 5000 });
  assert.deepEqual(result, { stdout: '', stderr: '' });
  await until(() => ws.received.some(m => m.type === 'jobs' && m.list.some(j => j.id === job.id && j.state === 'done')));
  assert.deepEqual(notices, [{ title: 'Jarvis: Έτοιμη απάντηση', body: job.title }]);
  ws.send(JSON.stringify({ type: 'input', id: job.id, data: 'next\r' }));
  await until(() => ctx.jobs.attach(job.id).info.state === 'working');
  assert.equal(proc.writes.at(-1), 'next\r');
});

test('hook notifications respect window focus, debounce per job, and skip exits', async (t) => {
  const notices = [];
  const ctx = await setup({ deps: { notify: n => notices.push(n) } });
  const ws = openWs(ctx);
  assert.equal((await wsOutcome(ws)).open, true);
  const start = async (prompt) => (await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', prompt } })).json.id;
  const first = await start('First job');
  const second = await start('Second job');
  const post = async (id, state) => assert.equal((await request(ctx, { method: 'POST', path: `/api/jobs/${id}/state`, body: { id, state } })).status, 200);
  const focus = async (focused) => {
    ws.send(JSON.stringify({ type: 'focus', focused }));
    // Input on the same socket is processed after the focus message.
    ws.send(JSON.stringify({ type: 'input', id: first, data: String(focused) }));
    await until(() => ctx.calls[0].writes.includes(String(focused)));
  };
  await focus(true);
  await post(first, 'waiting');
  assert.deepEqual(notices, []);
  await focus(false);
  await post(first, 'waiting'); // duplicate
  assert.deepEqual(notices, []);
  await post(first, 'working');
  await post(first, 'waiting');
  await post(first, 'done'); // same job in the cooldown period
  ctx.calls[1].emit('redraw without hooks');
  await post(second, 'done');
  assert.deepEqual(notices, [
    { title: 'Jarvis: Σε περιμένει', body: 'First job' },
    { title: 'Jarvis: Έτοιμη απάντηση', body: 'Second job' },
  ]);
  const third = await start('Third job');
  await post(third, 'working');
  ctx.calls[2].exitCb({ exitCode: 0 });
  await post(third, 'waiting'); // a late hook cannot replace the exit state
  assert.equal(ctx.jobs.attach(third).info.state, 'done');
  assert.equal(notices.length, 2);
  const later = Date.now() + 20_000;
  t.mock.method(Date, 'now', () => later);
  await post(first, 'working');
  await post(first, 'done');
  assert.equal(notices.length, 3);
  assert.deepEqual(notices.at(-1), { title: 'Jarvis: Έτοιμη απάντηση', body: 'First job' });
});

test('the hook script quietly succeeds without job environment or with an unavailable server', async () => {
  for (const url of ['', `http://127.0.0.1:${await freePort()}`]) {
    const env = { ...process.env, JARVIS_URL: url, JARVIS_JOB_ID: url ? 'test' : '', JARVIS_TOKEN: url ? TOKEN : '' };
    const result = await run(process.execPath, [hookScript, 'done'], { env, timeout: 5000 });
    assert.deepEqual(result, { stdout: '', stderr: '' });
  }
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

function upload(ctx, query, buf, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: ctx.port, method: 'POST', path: `/api/upload?${query}`, setHost: false,
      headers: { host: `127.0.0.1:${ctx.port}`, 'x-jarvis-token': TOKEN, 'content-type': 'application/octet-stream', 'content-length': buf.length, ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json; try { json = JSON.parse(data); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(buf);
  });
}

test('upload saves a file for a running terminal and returns its full path', async () => {
  const ctx = await setup();
  const job = (await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', useHome: true } })).json;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const r = await upload(ctx, `job=${job.id}&name=${encodeURIComponent('Στιγμιότυπο οθόνης (1).png')}`, png);
  assert.equal(r.status, 201);
  assert.ok(path.isAbsolute(r.json.path));
  assert.ok(r.json.path.startsWith(path.join(ctx.dir, 'data', 'uploads')));
  assert.match(path.basename(r.json.path), /-Στιγμιότυπο_οθόνης__1_\.png$/u);
  assert.deepEqual(fs.readFileSync(r.json.path), png);
  // a second upload with the same name never overwrites the first
  const r2 = await upload(ctx, `job=${job.id}&name=${encodeURIComponent('Στιγμιότυπο οθόνης (1).png')}`, Buffer.from('x'));
  assert.notEqual(r2.json.path, r.json.path);
});

test('upload refuses unknown terminals, bad names, path tricks and big files', async () => {
  const ctx = await setup();
  const job = (await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude', useHome: true } })).json;
  assert.equal((await upload(ctx, 'job=nope&name=a.png', Buffer.from('x'))).status, 404);
  assert.equal((await upload(ctx, `job=${job.id}`, Buffer.from('x'))).status, 400);
  const sneaky = await upload(ctx, `job=${job.id}&name=${encodeURIComponent('..\..\evil.txt')}`, Buffer.from('x'));
  assert.equal(sneaky.status, 201);
  assert.equal(path.dirname(sneaky.json.path).startsWith(path.join(ctx.dir, 'data', 'uploads')), true);
  assert.ok(!sneaky.json.path.includes('..'));
  const big = await upload(ctx, `job=${job.id}&name=a.bin`, Buffer.alloc(26 * 1024 * 1024)).catch((e) => ({ status: e.code }));
  assert.ok([413, 'EPIPE', 'ECONNRESET'].includes(big.status), String(big.status));
  assert.equal((await upload(ctx, `job=${job.id}&name=a.png`, Buffer.from('x'), { 'x-jarvis-token': 'wrong' })).status, 403);
});

function configureSiteWatch(raw) {
  raw.sitewatch = { url: 'https://sw.example.workers.dev', tokenFile: 'data/sitewatch-token.txt' };
}

test('state includes SiteWatch status from the reader, without the key', async () => {
  const ctx = await setup({ edit: configureSiteWatch, deps: { readSiteWatch: async (o) => ({ state: 'ok', generated_at: 'g', monitors: [{ name: 'A', host: 'a.gr', status: 'up', response_time_ms: 120 }], _saw: o.tokenFile ? 'file' : 'none' }) } });
  const r = await request(ctx, { path: '/api/state' });
  assert.equal(r.json.sitewatch.state, 'ok');
  assert.equal(r.json.sitewatch.monitors[0].host, 'a.gr');
});

test('state reports SiteWatch as off when it is not configured', async () => {
  const ctx = await setup();
  const r = await request(ctx, { path: '/api/state' });
  assert.equal(r.json.sitewatch.state, 'off');
  const refresh = await request(ctx, { method: 'POST', path: '/api/sitewatch/refresh' });
  assert.deepEqual(refresh.json, { state: 'off' });
});


test('SiteWatch retries after failures, stops on recovery and logs only changed failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  let reads = 0;
  let result = { state: 'error', reason: 'network' };
  const ctx = await setup({
    edit: configureSiteWatch,
    deps: {
      siteWatchRetryMs: 200,
      log: (line) => logs.push(line),
      readSiteWatch: async () => { reads++; return result; },
    },
  });
  assert.equal(reads, 1);
  await ctx.server.refreshSiteWatch();
  t.mock.timers.tick(199);
  assert.equal(reads, 2);

  result = { state: 'error', reason: 'timeout' };
  t.mock.timers.tick(1);
  assert.deepEqual((await request(ctx, { path: '/api/state' })).json.sitewatch, result);
  assert.equal(reads, 3);

  result = { state: 'ok', monitors: [] };
  t.mock.timers.tick(200);
  assert.deepEqual((await request(ctx, { path: '/api/state' })).json.sitewatch, result);
  t.mock.timers.tick(400);
  assert.equal(reads, 4);

  result = { state: 'error', reason: 'timeout' };
  await ctx.server.refreshSiteWatch();
  assert.deepEqual(logs, ['SiteWatch error: network', 'SiteWatch error: timeout', 'SiteWatch error: timeout']);
  await ctx.server.close();
  t.mock.timers.tick(200);
  assert.equal(reads, 5);
});

test('POST SiteWatch refresh requires authentication and returns the fresh shared result', async () => {
  let reads = 0;
  const next = Promise.withResolvers();
  const ctx = await setup({
    edit: configureSiteWatch,
    deps: { readSiteWatch: async () => ++reads === 1 ? { state: 'error', reason: 'network' } : next.promise },
  });
  const post = { method: 'POST', path: '/api/sitewatch/refresh' };
  const denied = await request(ctx, { ...post, headers: { 'x-jarvis-token': undefined } });
  assert.equal(denied.status, 403);
  assert.equal(reads, 1);

  const response = request(ctx, post);
  await until(() => reads === 2);
  const overlappingRefresh = ctx.server.refreshSiteWatch();
  const recovered = { state: 'ok', monitors: [{ name: 'A', host: 'a.gr', status: 'up' }] };
  next.resolve(recovered);
  const r = await response;
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, recovered);
  assert.deepEqual(await overlappingRefresh, recovered);
  assert.deepEqual((await request(ctx, { path: '/api/state' })).json.sitewatch, recovered);
  assert.equal(reads, 2);
});

test('SiteWatch notifies only when a known monitor changes up state', async () => {
  let status = 'up';
  let state = 'ok';
  const notices = [];
  const ctx = await setup({
    edit: configureSiteWatch,
    deps: { notify: (n) => notices.push(n), readSiteWatch: async () => state === 'ok' ? { state, monitors: [{ name: 'Site', host: 'example.com', status }] } : { state } },
  });
  assert.deepEqual(notices, []);
  await ctx.server.refreshSiteWatch();
  status = 'degraded';
  await ctx.server.refreshSiteWatch();
  status = 'down';
  await ctx.server.refreshSiteWatch();
  state = 'error';
  await ctx.server.refreshSiteWatch();
  state = 'ok';
  status = 'up';
  await ctx.server.refreshSiteWatch();
  await ctx.server.refreshSiteWatch();
  assert.deepEqual(notices, [
    { title: 'Jarvis: Το site έπεσε', body: 'Site (example.com)' },
    { title: 'Jarvis: Το site ξαναλειτουργεί', body: 'Site (example.com)' },
  ]);
});

test('restart saves open jobs and invokes relaunch and shutdown', async () => {
  let relaunched = 0;
  let shutdown = 0;
  const ctx = await setup({ deps: { relaunch: async () => { relaunched++; } }, onShutdown: () => { shutdown++; } });
  const job = (await request(ctx, { method: 'POST', path: '/api/jobs', body: { accountId: 'claude' } })).json;
  const forbidden = await request(ctx, { method: 'POST', path: '/api/restart', headers: { 'x-jarvis-token': undefined } });
  assert.equal(forbidden.status, 403);
  const response = await request(ctx, { method: 'POST', path: '/api/restart' });
  assert.equal(response.status, 200);
  await until(() => shutdown === 1);
  assert.equal(relaunched, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'data', 'restart.json'), 'utf8')), [
    { accountId: job.accountId, cwd: job.cwd, title: job.title },
  ]);
  assert.equal(ctx.calls[0].killed, true);
});

test('restored jobs use the normal job path and resume the saved account and folder', async () => {
  const ctx = await setup();
  const saved = { accountId: 'claude', cwd: ctx.personalPath, title: 'Saved terminal' };
  ctx.server.restoreJob(saved);
  assert.equal(ctx.calls[0].opts.cwd, saved.cwd);
  assert.ok(ctx.calls[0].args.includes('--continue'));
  assert.equal(ctx.jobs.list()[0].title, saved.title);
  ctx.server.restoreJob({ accountId: 'mine', cwd: ctx.personalPath, title: 'Codex' });
  assert.deepEqual(ctx.calls[1].args.slice(-2), ['resume', '--last']);
});
