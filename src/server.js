import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
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
import { readSiteWatch as defaultReadSiteWatch } from './sitewatch.js';
import { notify as defaultNotify } from './notify.js';
import { ChatError } from './chat/model.js';
import { relaunchJarvis, saveRestart } from './restart.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR = {
  xterm: path.join(ROOT, 'node_modules', '@xterm', 'xterm'),
  'addon-fit': path.join(ROOT, 'node_modules', '@xterm', 'addon-fit'),
};
const MAX_BODY = 64 * 1024;
const MAX_WS_PAYLOAD = 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024; // screenshots and files pasted / dropped into a terminal

// A safe file name: letters (any language), digits, dot, dash, underscore; no folders.
function safeName(name) {
  const base = String(name).split(/[\\/]/).pop().normalize('NFC');
  const clean = base.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '').slice(-100);
  return clean || 'file';
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      req.resume();
      return reject(new HttpError(413, 'FILE_TOO_LARGE'));
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; reject(new HttpError(413, 'FILE_TOO_LARGE')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_CLIS = new Set(['codex', 'claude']);
const CHAT_ERRORS = {
  NO_SUCH_CHAT: 404, NO_SUCH_APPROVAL: 404, BAD_DECISION: 400,
  CHAT_UNSUPPORTED: 400, START_FAILED: 502, CHAT_EXITED: 409,
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
  chats = null, chatHistory = null,
}) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('createServer: token required');
  const d = {
    collectUsage: deps.collectUsage ?? defaultCollectUsage,
    appendSnapshot: deps.appendSnapshot ?? defaultAppendSnapshot,
    getSeries: deps.getSeries ?? defaultGetSeries,
    perDayRate: deps.perDayRate ?? defaultPerDayRate,
    readDirectives: deps.readDirectives ?? defaultReadDirectives,
    readSiteWatch: deps.readSiteWatch ?? defaultReadSiteWatch,
    notify: deps.notify ?? defaultNotify,
    siteWatchIntervalMs: deps.siteWatchIntervalMs ?? 3600000, // once an hour
    historyFile: deps.historyFile ?? path.join(config.rootDir, 'data', 'usage-history.json'),
    watch: deps.watch ?? fs.watch,
    log: deps.log ?? (() => {}),
    claudeSettingsFile: deps.claudeSettingsFile ?? null,
    claudeMcpFile: deps.claudeMcpFile ?? null,
    relaunch: deps.relaunch ?? relaunchJarvis,
  };
  const port = config.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  let usage = {};
  let sitewatch = { state: config.sitewatch ? 'loading' : 'off' };
  let siteWatchTimer = null;
  const siteWatchStatuses = new Map();
  async function refreshSiteWatch() {
    if (!config.sitewatch) return;
    try { sitewatch = await d.readSiteWatch({ url: config.sitewatch.url, tokenFile: config.sitewatch.tokenFile }); }
    catch { sitewatch = { state: 'error' }; }
    if (sitewatch?.state === 'ok' && Array.isArray(sitewatch.monitors)) {
      for (const monitor of sitewatch.monitors) {
        const key = monitor.host || monitor.name;
        if (!key) continue;
        const up = monitor.status === 'up';
        if (siteWatchStatuses.has(key) && siteWatchStatuses.get(key) !== up) {
          try { d.notify({ title: up ? 'Jarvis: Το site ξαναλειτουργεί' : 'Jarvis: Το site έπεσε', body: `${monitor.name ?? ''} (${monitor.host ?? ''})` }); } catch { /* ignore notification failures */ }
        }
        siteWatchStatuses.set(key, up);
      }
    }
    broadcast({ type: 'sitewatch', sitewatch });
  }
  let usageTimer = null;
  let refreshing = false;
  let lastDirectives = null; // JSON of the last list sent/served
  let directivesWatcher = null;
  let closed = false;
  let directivesDebounce = null;

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
    await checkDirectives(); // fallback for missed fs.watch events
  }

  // ---------- directives (today.md) ----------
  async function readDirectivesSafe() {
    try { return await d.readDirectives(config.directivesFile); } catch { return []; }
  }

  async function checkDirectives() {
    const list = await readDirectivesSafe();
    const json = JSON.stringify(list);
    if (json === lastDirectives) return;
    lastDirectives = json;
    broadcast({ type: 'directives', list });
  }

  function watchDirectives() {
    if (closed || directivesWatcher) return;
    const dir = path.dirname(config.directivesFile);
    const name = path.basename(config.directivesFile).toLowerCase();
    try {
      directivesWatcher = d.watch(dir, (event, filename) => {
        if (filename && String(filename).toLowerCase() !== name) return;
        clearTimeout(directivesDebounce);
        directivesDebounce = setTimeout(() => { checkDirectives().catch(() => {}); }, 300);
      });
      directivesWatcher.on?.('error', (e) => d.log(`directives watch: ${e.message}`));
    } catch (e) {
      d.log(`directives watch unavailable: ${e.message}`);
    }
  }

  // ---------- REST ----------
  async function state() {
    const directives = await readDirectivesSafe();
    return {
      accounts: Object.values(config.accounts).map(({ id, label, side, color, enabled, cli, mode }) => ({
        id, label, side, color, enabled, cli, mode, chat: Boolean(chats) && CHAT_CLIS.has(cli),
      })),
      projects: config.projects.map(({ name, path: p, side }) => ({ name, path: p, side })),
      quickCommands: config.quickCommands.map(({ id, label }) => ({ id, label })),
      jobs: jobs.list(),
      usage,
      directives,
      sitewatch,
    };
  }

  function startJob(body, restored = null) {
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
    const launch = buildLaunch(account, { claudeSettingsFile: d.claudeSettingsFile, claudeMcpFile: d.claudeMcpFile, continueLast: !!restored });
    if (restored) title = restored.title;
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

  // ---------- chat ----------
  const optStr = (v) => v === undefined || v === null || typeof v === 'string';

  // Past conversations of `account` in `cwd`, reduced to what the client may see.
  async function historyFor(account, cwd) {
    if (typeof chatHistory !== 'function') return [];
    let list;
    try { list = await chatHistory({ account, cwd }); } catch (e) {
      d.log(`chat history failed: ${e.message}`);
      throw new HttpError(502, 'HISTORY_UNAVAILABLE');
    }
    return (Array.isArray(list) ? list : []).map((h) => ({
      externalId: h.externalId, title: h.title, updatedAt: h.updatedAt ?? null,
    }));
  }

  function chatAccount(accountId) {
    const account = config.accounts[accountId];
    if (!CHAT_CLIS.has(account.cli)) throw new ChatError('CHAT_UNSUPPORTED', `no chat for ${account.cli}`);
    return account;
  }

  async function startChat(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'BAD_REQUEST');
    const { accountId, projectPath, useHome, prompt, quickCommandId, resumeId } = body;
    if (typeof accountId !== 'string') throw new HttpError(400, 'BAD_REQUEST');
    if (!optStr(projectPath) || !optStr(prompt) || !optStr(quickCommandId)) throw new HttpError(400, 'BAD_REQUEST');
    if (useHome !== undefined && typeof useHome !== 'boolean') throw new HttpError(400, 'BAD_REQUEST');
    if (resumeId !== undefined && resumeId !== null && (typeof resumeId !== 'string' || !resumeId || resumeId.length > 200)) {
      throw new HttpError(400, 'BAD_REQUEST');
    }

    let target;
    let firstPrompt = prompt || undefined;
    let title;
    if (quickCommandId) {
      const cmd = config.quickCommands.find((q) => q.id === quickCommandId);
      if (!cmd) throw new HttpError(400, 'UNKNOWN_COMMAND');
      target = resolveTarget(config, { accountId, useHome: true });
      firstPrompt = cmd.prompt;
      title = cmd.label;
    } else {
      target = resolveTarget(config, { accountId, projectPath: projectPath || undefined, useHome: useHome === true });
    }
    const account = chatAccount(accountId);

    if (resumeId) {
      // Only ids the history list offers for this account + resolved folder may be resumed.
      const mine = (await historyFor(account, target.cwd)).find((h) => h.externalId === resumeId);
      if (!mine) {
        const otherSide = [
          ...config.projects.filter((p) => p.side !== target.side).map((p) => p.path),
          ...Object.values(config.accounts).filter((a) => a.side !== target.side && a.home).map((a) => a.home),
        ];
        for (const cwd of otherSide) {
          const found = (await historyFor(account, cwd).catch(() => [])).some((h) => h.externalId === resumeId);
          if (found) throw new HttpError(403, 'SIDE_MISMATCH');
        }
        throw new HttpError(404, 'NO_SUCH_HISTORY');
      }
      const live = chats.findByExternal(accountId, resumeId);
      if (live) return { existing: true, info: live };
      title ??= mine.title;
    }
    if (!title) {
      const project = config.projects.find((p) => path.resolve(p.path).toLowerCase() === path.resolve(target.cwd).toLowerCase());
      title = firstPrompt ? firstPrompt.slice(0, 60) : `${account.label} · ${project ? project.name : 'home'}`;
    }
    const info = await chats.create({
      accountId, account, cwd: target.cwd, side: target.side, title, resumeId: resumeId || undefined,
    });
    if (firstPrompt) {
      try { chats.send(info.id, firstPrompt); } catch (e) {
        d.log(`chat first message failed: ${e.message}`);
        try { chats.reportError(info.id, `The first message could not be sent: ${e.message}`); } catch { /* chat gone */ }
      }
    }
    return { existing: false, info: chats.get(info.id).info };
  }

  async function handleChatApi(req, res, pathname) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/api/chat-history' && req.method === 'GET') {
      const accountId = url.searchParams.get('accountId');
      if (!accountId) throw new HttpError(400, 'BAD_REQUEST');
      const target = resolveTarget(config, {
        accountId, projectPath: url.searchParams.get('projectPath') || undefined, useHome: url.searchParams.get('useHome') === '1',
      });
      const account = chatAccount(accountId);
      return send(res, 200, await historyFor(account, target.cwd));
    }
    if (pathname === '/api/chats' && req.method === 'GET') return send(res, 200, chats.list());
    if (pathname === '/api/chats' && req.method === 'POST') {
      const { existing, info } = await startChat(await readJson(req));
      return send(res, existing ? 200 : 201, info);
    }

    const m = /^\/api\/chats\/([^/]+)(?:\/(messages|interrupt|approvals\/([^/]+)))?$/.exec(pathname);
    if (!m || !UUID_RE.test(m[1])) return send(res, 404, { error: 'NOT_FOUND' });
    const [, id, action, approvalId] = m;
    if (!action && req.method === 'GET') return send(res, 200, chats.get(id));
    if (!action && req.method === 'DELETE') { chats.close(id); return send(res, 200, { ok: true }); }
    if (action === 'messages' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body.text !== 'string' || body.text.trim() === '') throw new HttpError(400, 'BAD_REQUEST');
      chats.send(id, body.text);
      return send(res, 200, { ok: true });
    }
    if (action === 'interrupt' && req.method === 'POST') {
      req.resume(); // interrupt needs no body
      chats.interrupt(id);
      return send(res, 200, { ok: true });
    }
    if (approvalId !== undefined && req.method === 'POST') {
      if (!UUID_RE.test(approvalId)) throw new ChatError('NO_SUCH_APPROVAL');
      const body = await readJson(req);
      chats.answer(id, approvalId, body?.decision);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  }

  // Saves a pasted / dropped file under data/uploads/<terminal id>/ and returns its full path,
  // which the page then types into that terminal for the CLI to read.
  async function handleUpload(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const id = q.get('job');
    const name = q.get('name');
    if (!jobs.list().some((j) => j.id === id)) { req.resume(); return send(res, 404, { error: 'NOT_FOUND' }); }
    if (!name) { req.resume(); return send(res, 400, { error: 'BAD_NAME' }); }
    const data = await readRaw(req, MAX_UPLOAD);
    const dir = path.join(config.rootDir, 'data', 'uploads', safeName(id));
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const file = path.join(dir, `${stamp}-${crypto.randomBytes(3).toString('hex')}-${safeName(name)}`);
    await writeFile(file, data, { flag: 'wx' });
    return send(res, 201, { path: file });
  }

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/ping' && req.method === 'GET') return send(res, 200, 'jarvis');
    if (!tokenMatches(token, req.headers['x-jarvis-token'])) return send(res, 403, { error: 'FORBIDDEN' });

    if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, await state());
    if (pathname === '/api/upload' && req.method === 'POST') return handleUpload(req, res);
    if (pathname === '/api/jobs' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 201, startJob(body));
    }
    if (chats && (pathname === '/api/chat-history' || pathname === '/api/chats' || pathname.startsWith('/api/chats/'))) {
      return handleChatApi(req, res, pathname);
    }
    if (pathname === '/api/restart' && req.method === 'POST') {
      await saveRestart(config.rootDir, jobs.list());
      await d.relaunch();
      await jobs.killAll();
      try { await chats?.closeAll(); } catch (e) { d.log(`chat shutdown: ${e.message}`); }
      res.once('finish', () => setImmediate(() => onShutdown()));
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      await jobs.killAll();
      try { await chats?.closeAll(); } catch (e) { d.log(`chat shutdown: ${e.message}`); }
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
      if (e instanceof ChatError) return send(res, CHAT_ERRORS[e.code] ?? 500, { error: e.code });
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
  const chatAttached = new Map(); // ws -> Set<chatId>

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
    chatAttached.set(ws, new Set());
    ws.on('close', () => { attached.delete(ws); chatAttached.delete(ws); });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'chat-attach') {
        if (!chats || typeof msg.id !== 'string' || !UUID_RE.test(msg.id)) return;
        try {
          const { info, items } = chats.get(msg.id);
          chatAttached.get(ws)?.add(msg.id);
          sendWs(ws, { type: 'chat-snapshot', id: msg.id, info, items });
        } catch { /* unknown conversation: no reply */ }
        return;
      }
      if (!known(msg.id)) return;
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
    if (chats) sendWs(ws, { type: 'chats', list: chats.list() });
  });

  const toChat = (id, msg) => {
    for (const [ws, ids] of chatAttached) if (ids.has(id)) sendWs(ws, msg);
  };
  const chatListeners = chats ? {
    conv: () => broadcast({ type: 'chats', list: chats.list() }),
    removed: (id) => {
      for (const ids of chatAttached.values()) ids.delete(id);
      broadcast({ type: 'chats', list: chats.list() });
    },
    item: (id, item) => toChat(id, { type: 'chat-item', id, item }),
    delta: (id, itemId, text) => toChat(id, { type: 'chat-delta', id, itemId, text }),
    update: (id, itemId, patch) => toChat(id, { type: 'chat-update', id, itemId, patch }),
  } : {};
  for (const [ev, fn] of Object.entries(chatListeners)) chats.on(ev, fn);

  const onData = (id, data) => {
    for (const [ws, ids] of attached) if (ids.has(id)) sendWs(ws, { type: 'data', id, data });
  };
  const onJobChange = () => broadcastJobs();
  jobs.on('data', onData);
  jobs.on('state', onJobChange);
  jobs.on('exit', onJobChange);

  return {
    restoreJob(saved) {
      const account = Object.hasOwn(config.accounts, saved.accountId) ? config.accounts[saved.accountId] : null;
      const useHome = !!account?.home && path.resolve(account.home).toLowerCase() === path.resolve(saved.cwd).toLowerCase();
      return startJob({ accountId: saved.accountId, projectPath: saved.cwd, useHome }, saved);
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (e) => reject(e);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          server.on('error', (e) => d.log(`server error: ${e.message}`));
          usageTimer = setInterval(refreshUsage, usageIntervalMs);
          usageTimer.unref?.();
          if (config.sitewatch) {
            siteWatchTimer = setInterval(refreshSiteWatch, d.siteWatchIntervalMs);
            siteWatchTimer.unref?.();
          }
          // Baseline the directives list first so only real edits are broadcast.
          readDirectivesSafe().then((list) => {
            lastDirectives ??= JSON.stringify(list);
            watchDirectives();
            refreshUsage();
            refreshSiteWatch().then(resolve, resolve);
          });
        });
      });
    },
    address() {
      return server.address();
    },
    refreshUsage,
    refreshSiteWatch,
    close() {
      closed = true;
      clearInterval(usageTimer);
      clearInterval(siteWatchTimer);
      clearTimeout(directivesDebounce);
      try { directivesWatcher?.close(); } catch { /* already closed */ }
      directivesWatcher = null;
      jobs.off('data', onData);
      jobs.off('state', onJobChange);
      jobs.off('exit', onJobChange);
      for (const [ev, fn] of Object.entries(chatListeners)) chats.off(ev, fn);
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
