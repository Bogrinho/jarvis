import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { resolveTarget, buildLaunch, PolicyError } from './policy.js';
import { collectUsage as defaultCollectUsage } from './usage/index.js';
import {
  appendSnapshot as defaultAppendSnapshot,
  getSeries as defaultGetSeries,
  perDayRate as defaultPerDayRate,
} from './usage/history.js';
import { readDirectives as defaultReadDirectives } from './directives.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR = {
  xterm: path.join(ROOT, 'node_modules', '@xterm', 'xterm'),
  'addon-fit': path.join(ROOT, 'node_modules', '@xterm', 'addon-fit'),
};
const MAX_BODY = 64 * 1024;
const MAX_WS_PAYLOAD = 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      return reject(new HttpError(400, 'BAD_CONTENT_TYPE'));
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      req.resume();
      return reject(new HttpError(400, 'BODY_TOO_LARGE'));
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HttpError(400, 'BODY_TOO_LARGE'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'BAD_JSON'));
      }
    });
    req.on('error', () => { if (!failed) { failed = true; reject(new HttpError(400, 'BAD_REQUEST')); } });
  });
}

// Maps a URL pathname to a file inside the allowed roots, or null. Rejects anything traversal-shaped.
function staticFile(rawPath) {
  if (/[\\]|%5c|%00|%2f/i.test(rawPath)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\0:]/.test(decoded)) return null;
  if (decoded === '/') return path.join(PUBLIC_DIR, 'index.html');
  const segments = decoded.split('/').slice(1);
  if (segments.some((s) => s === '..' || s === '.')) return null;

  let base;
  let rest;
  if (segments[0] === 'vendor' && segments[1] === 'xterm') {
    base = Object.hasOwn(VENDOR, segments[2]) ? VENDOR[segments[2]] : null;
    rest = segments.slice(3);
  } else {
    base = PUBLIC_DIR;
    rest = segments;
  }
  if (!base || rest.length === 0 || rest.some((s) => s === '')) return null;
  const file = path.resolve(base, ...rest);
  if (!file.startsWith(base + path.sep)) return null;
  return file;
}

export function createServer({
  config, jobs, token, usageIntervalMs = 60000, onShutdown = () => process.exit(0), deps = {},
}) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('createServer: token required');
  const d = {
    collectUsage: deps.collectUsage ?? defaultCollectUsage,
    appendSnapshot: deps.appendSnapshot ?? defaultAppendSnapshot,
    getSeries: deps.getSeries ?? defaultGetSeries,
    perDayRate: deps.perDayRate ?? defaultPerDayRate,
    readDirectives: deps.readDirectives ?? defaultReadDirectives,
    historyFile: deps.historyFile ?? path.join(config.rootDir, 'data', 'usage-history.json'),
    log: deps.log ?? (() => {}),
  };
  const port = config.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  let usage = {};
  let usageTimer = null;
  let refreshing = false;

  const hostOk = (req) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return false;
    const origin = req.headers.origin;
    return origin === undefined || allowedOrigins.has(String(origin).toLowerCase());
  };

  // ---------- usage ----------
  async function refreshUsage() {
    if (refreshing) return;
    refreshing = true;
    try {
      const raw = await d.collectUsage(config);
      const now = new Date();
      for (const [id, view] of Object.entries(raw ?? {})) {
        const pct = view?.kind === 'percent' ? view.weekly?.pct : undefined;
        if (!Number.isFinite(pct)) continue;
        try { await d.appendSnapshot(d.historyFile, id, pct, now); } catch (e) { d.log(`usage history: ${e.message}`); }
      }
      const merged = {};
      for (const [id, view] of Object.entries(raw ?? {})) {
        let series = [];
        try { series = await d.getSeries(d.historyFile, id); } catch { series = []; }
        let perDay = null;
        try { perDay = d.perDayRate(series); } catch { perDay = null; }
        merged[id] = { ...view, series: series.map((p) => p.pct), perDay: perDay ?? null };
      }
      usage = merged;
      broadcast({ type: 'usage', usage });
    } catch (e) {
      d.log(`usage refresh failed: ${e.message}`);
    } finally {
      refreshing = false;
    }
  }

  // ---------- REST ----------
  async function state() {
    let directives = [];
    try { directives = await d.readDirectives(config.directivesFile); } catch { directives = []; }
    return {
      accounts: Object.values(config.accounts).map(({ id, label, side, color, enabled }) => ({ id, label, side, color, enabled })),
      projects: config.projects.map(({ name, path: p, side }) => ({ name, path: p, side })),
      quickCommands: config.quickCommands.map(({ id, label }) => ({ id, label })),
      jobs: jobs.list(),
      usage,
      directives,
    };
  }

  function startJob(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'BAD_REQUEST');
    const { accountId, projectPath, useHome, prompt, quickCommandId } = body;
    if (typeof accountId !== 'string') throw new HttpError(400, 'BAD_REQUEST');
    if (projectPath !== undefined && projectPath !== null && typeof projectPath !== 'string') throw new HttpError(400, 'BAD_REQUEST');
    if (useHome !== undefined && typeof useHome !== 'boolean') throw new HttpError(400, 'BAD_REQUEST');
    if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') throw new HttpError(400, 'BAD_REQUEST');
    if (quickCommandId !== undefined && quickCommandId !== null && typeof quickCommandId !== 'string') throw new HttpError(400, 'BAD_REQUEST');

    let target;
    let jobPrompt = prompt || undefined;
    let title;
    if (quickCommandId) {
      const cmd = config.quickCommands.find((q) => q.id === quickCommandId);
      if (!cmd) throw new HttpError(400, 'UNKNOWN_COMMAND');
      target = resolveTarget(config, { accountId, useHome: true });
      jobPrompt = cmd.prompt;
      title = cmd.label;
    } else {
      target = resolveTarget(config, { accountId, projectPath: projectPath || undefined, useHome: useHome === true });
    }
    const account = config.accounts[accountId];
    const launch = buildLaunch(account);
    if (!title) {
      const project = config.projects.find((p) => path.resolve(p.path).toLowerCase() === path.resolve(target.cwd).toLowerCase());
      title = jobPrompt ? jobPrompt.slice(0, 60) : `${account.label} · ${project ? project.name : 'home'}`;
    }
    let info;
    try {
      info = jobs.start({ accountId, cwd: target.cwd, launch, title, prompt: jobPrompt });
    } catch (e) {
      d.log(`spawn failed: ${e.message}`);
      throw new HttpError(500, 'SPAWN_FAILED');
    }
    broadcastJobs();
    return info;
  }

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/ping' && req.method === 'GET') return send(res, 200, 'jarvis');
    if (!tokenMatches(token, req.headers['x-jarvis-token'])) return send(res, 403, { error: 'FORBIDDEN' });

    if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, await state());
    if (pathname === '/api/jobs' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 201, startJob(body));
    }
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      await jobs.killAll();
      res.once('finish', () => setImmediate(() => onShutdown()));
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  }

  async function handleStatic(req, res, rawPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const file = staticFile(rawPath);
    if (!file) return send(res, 404, { error: 'NOT_FOUND' });
    let info;
    try { info = await stat(file); } catch { info = null; }
    if (!info || !info.isFile()) return send(res, 404, { error: 'NOT_FOUND' });
    let data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    if (file === path.join(PUBLIC_DIR, 'index.html')) {
      data = Buffer.from(
        data.toString('utf8').replace(/(<meta\s+name="jarvis-token"\s+content=")[^"]*(")/, `$1${token}$2`),
        'utf8',
      );
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[ext] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return send(res, 403, { error: 'FORBIDDEN' });
      const rawPath = String(req.url ?? '/').split('?')[0];
      if (rawPath === '/api' || rawPath.startsWith('/api/')) return await handleApi(req, res, rawPath);
      return await handleStatic(req, res, rawPath);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof PolicyError) return send(res, 403, { error: e.code });
      if (e instanceof HttpError) {
        if (e.code === 'BODY_TOO_LARGE') res.setHeader('connection', 'close');
        return send(res, e.status, { error: e.code });
      }
      d.log(`request failed: ${e?.stack ?? e}`);
      return send(res, 500, { error: 'INTERNAL' });
    }
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  const attached = new Map(); // ws -> Set<jobId>

  server.on('upgrade', (req, socket, head) => {
    const reject = (status) => {
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let url;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return reject(400); }
    if (!hostOk(req)) return reject(403);
    if (url.pathname !== '/ws') return reject(404);
    if (!tokenMatches(token, url.searchParams.get('token'))) return reject(401);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const sendWs = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  function broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(text);
  }
  function broadcastJobs() {
    broadcast({ type: 'jobs', list: jobs.list() });
  }

  const known = (id) => typeof id === 'string' && jobs.list().some((j) => j.id === id);
  const dim = (n) => Number.isInteger(n) && n > 0 && n <= 1000;

  wss.on('connection', (ws) => {
    attached.set(ws, new Set());
    ws.on('close', () => attached.delete(ws));
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object' || !known(msg.id)) return;
      try {
        switch (msg.type) {
          case 'attach': {
            const { scrollback } = jobs.attach(msg.id);
            attached.get(ws)?.add(msg.id);
            sendWs(ws, { type: 'scrollback', id: msg.id, data: scrollback });
            break;
          }
          case 'input':
            if (typeof msg.data === 'string') jobs.write(msg.id, msg.data);
            break;
          case 'resize':
            if (dim(msg.cols) && dim(msg.rows)) jobs.resize(msg.id, msg.cols, msg.rows);
            break;
          case 'kill':
            jobs.kill(msg.id);
            break;
          default:
            break;
        }
      } catch (e) {
        d.log(`ws message failed: ${e.message}`);
      }
    });
    sendWs(ws, { type: 'jobs', list: jobs.list() });
    sendWs(ws, { type: 'usage', usage });
  });

  const onData = (id, data) => {
    for (const [ws, ids] of attached) if (ids.has(id)) sendWs(ws, { type: 'data', id, data });
  };
  const onJobChange = () => broadcastJobs();
  jobs.on('data', onData);
  jobs.on('state', onJobChange);
  jobs.on('exit', onJobChange);

  return {
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (e) => reject(e);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          server.on('error', (e) => d.log(`server error: ${e.message}`));
          refreshUsage();
          usageTimer = setInterval(refreshUsage, usageIntervalMs);
          usageTimer.unref?.();
          resolve();
        });
      });
    },
    address() {
      return server.address();
    },
    refreshUsage,
    close() {
      clearInterval(usageTimer);
      jobs.off('data', onData);
      jobs.off('state', onJobChange);
      jobs.off('exit', onJobChange);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
