// Codex chat adapter: drives `codex app-server` (JSON-RPC over stdio, one JSON object
// per line — the protocol the Codex desktop app uses) and translates it into the
// normalized chat events consumed by ChatManager (see ./model.js).
// Shapes follow `codex app-server generate-ts` for codex-cli 0.166.0 (v2 API).
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as cp from 'node:child_process';

const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
})();

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

class ServerExitError extends Error {
  constructor(code) {
    super(`codex app-server stopped (exit code ${code ?? 'unknown'})`);
    this.code = 'SERVER_EXIT';
    this.exitCode = code;
  }
}

// One `codex app-server` per Codex account, shared by that account's conversations.
// Started lazily by the first request and restarted lazily after it dies.
export class CodexAppServer {
  #opts; #child = null; #starting = null; #pending = new Map(); #nextId = 1;
  #notif = new Set(); #reqHandlers = new Set(); #exitHandlers = new Set();

  constructor({ codexCmd = 'codex', env = process.env, spawn = cp.spawn, file, args, log = console.warn } = {}) {
    this.#opts = { codexCmd, env, spawn, file, args, log };
  }

  get child() { return this.#child; }

  start() {
    if (this.#starting) return this.#starting;
    const p = (async () => {
      this.#spawn();
      await this.#rawRequest('initialize', { clientInfo: { name: 'jarvis', title: 'Jarvis', version: VERSION }, capabilities: null });
      this.#write({ method: 'initialized' });
    })();
    this.#starting = p;
    p.catch(() => { if (this.#starting === p) this.#starting = null; });
    return p;
  }

  async request(method, params) {
    await this.start();
    return this.#rawRequest(method, params);
  }

  onNotification(fn) { this.#notif.add(fn); return () => this.#notif.delete(fn); }
  // fn(method, params, requestId) -> result | Promise<result> | undefined (= not mine)
  onRequest(fn) { this.#reqHandlers.add(fn); return () => this.#reqHandlers.delete(fn); }
  onExit(fn) { this.#exitHandlers.add(fn); return () => this.#exitHandlers.delete(fn); }

  close() {
    const child = this.#child;
    if (!child) return;
    this.#detach(child, null, false);
    try { child.stdin.end(); } catch { /* already gone */ }
    if (process.platform === 'win32' && child.pid) {
      // cmd.exe wrapper: kill the whole tree, not just the shell.
      try {
        cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .on('error', () => { try { child.kill(); } catch { /* ignore */ } });
      } catch { try { child.kill(); } catch { /* ignore */ } }
    } else {
      try { child.kill(); } catch { /* ignore */ }
    }
  }

  #spawn() {
    const { codexCmd, env, spawn, file, args } = this.#opts;
    let f, a;
    if (file) { f = file; a = args ?? []; }
    else if (process.platform === 'win32') { f = process.env.ComSpec || 'cmd.exe'; a = ['/d', '/s', '/c', codexCmd, 'app-server']; }
    else { f = codexCmd; a = ['app-server']; }
    const child = spawn(f, a, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) this.#onLine(child, line);
      }
    });
    child.stderr.on('data', () => { /* drained; app-server logs go to stderr */ });
    child.stdin.on('error', () => { /* EPIPE after exit is reported via 'exit' */ });
    child.on('error', (e) => {
      this.#opts.log(`codex app-server: ${e.message}`);
      this.#detach(child, null, true);
    });
    child.on('exit', (code) => this.#detach(child, code, true));
  }

  #detach(child, code, notify) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#starting = null;
    const err = new ServerExitError(code);
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
    if (notify) for (const fn of [...this.#exitHandlers]) { try { fn(code); } catch (e) { this.#opts.log(e); } }
  }

  #write(msg) {
    const child = this.#child;
    if (!child) throw new ServerExitError(null);
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  #rawRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject, method });
      try { this.#write({ id, method, params }); }
      catch (e) { this.#pending.delete(id); reject(e); }
    });
  }

  #onLine(child, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { msg = null; }
    if (!msg || typeof msg !== 'object') {
      this.#opts.log(`codex app-server: ignoring malformed JSON line (${line.length} chars)`);
      return;
    }
    if (msg.method && msg.id !== undefined) return this.#onServerRequest(child, msg);
    if (msg.method) {
      for (const fn of [...this.#notif]) { try { fn(msg.method, msg.params ?? {}); } catch (e) { this.#opts.log(e); } }
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) {
      const e = new Error(msg.error.message ?? `${p.method} failed`);
      e.rpcCode = msg.error.code;
      p.reject(e);
    } else {
      p.resolve(msg.result);
    }
  }

  #onServerRequest(child, msg) {
    const reply = (body) => {
      if (this.#child !== child) return; // that server is gone; nothing to answer
      try { this.#write({ id: msg.id, ...body }); } catch { /* exited meanwhile */ }
    };
    for (const fn of [...this.#reqHandlers]) {
      let r;
      try { r = fn(msg.method, msg.params ?? {}, msg.id); }
      catch (e) { reply({ error: { code: INTERNAL_ERROR, message: e.message } }); return; }
      if (r === undefined) continue;
      Promise.resolve(r).then(
        (result) => reply({ result }),
        (e) => reply({ error: { code: INTERNAL_ERROR, message: e?.message ?? String(e) } }));
      return;
    }
    reply({ error: { code: METHOD_NOT_FOUND, message: `Jarvis does not support ${msg.method}` } });
  }
}

// ---- item mapping -----------------------------------------------------------

function countDiff(diff, kind) {
  let added = 0, removed = 0;
  const lines = String(diff ?? '').split('\n');
  for (const l of lines) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  if (!added && !removed && (kind === 'add' || kind === 'delete')) {
    const n = lines.filter((l, i) => l !== '' || i < lines.length - 1).length;
    if (kind === 'add') added = n; else removed = n;
  }
  return { added, removed };
}

function commandActivity(item) {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  let icon = 'run', text = item.command ?? '';
  if (actions.length && actions.every(a => a.type === 'read')) {
    icon = 'read';
    text = actions.map(a => a.name || a.path).join(', ');
  } else if (actions.length && actions.every(a => ['read', 'search', 'listFiles'].includes(a.type))) {
    icon = 'search';
    text = actions.map(a => a.query || a.path || a.command).filter(Boolean).join(', ') || text;
  }
  return { kind: 'activity', icon, text, ...commandStatus(item) };
}

function commandStatus(item) {
  const out = {};
  if (item.status === 'inProgress') out.status = 'running';
  else if (item.status === 'completed' && (item.exitCode == null || item.exitCode === 0)) out.status = 'ok';
  else out.status = 'fail';
  if (item.exitCode != null) out.detail = `exit ${item.exitCode}`;
  else if (item.status === 'declined') out.detail = 'declined';
  return out;
}

function toolActivity(item) {
  const status = item.status === 'inProgress' ? 'running'
    : (item.status === 'completed' && !item.error && item.success !== false) ? 'ok' : 'fail';
  const name = [item.server ?? item.namespace, item.tool].filter(Boolean).join('.');
  return { kind: 'activity', icon: 'tool', text: name, status };
}

function diffItems(item) {
  if (item.status !== 'completed') {
    return [{ kind: 'activity', icon: 'edit', text: (item.changes ?? []).map(c => c.path).join(', '),
      status: item.status === 'inProgress' ? 'running' : 'fail', detail: item.status }];
  }
  return (item.changes ?? []).map(c => ({
    kind: 'diff', path: c.path, ...countDiff(c.diff, c.kind?.type), patch: c.diff ?? '',
  }));
}

// A finished Codex ThreadItem -> zero or more normalized items (without ids).
function mapThreadItem(item) {
  switch (item?.type) {
    case 'userMessage': {
      const text = (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      return text ? [{ kind: 'user', text }] : [];
    }
    case 'agentMessage': return [{ kind: 'assistant', text: item.text ?? '', streaming: false }];
    case 'commandExecution': return [commandActivity(item)];
    case 'fileChange': return diffItems(item);
    case 'mcpToolCall':
    case 'dynamicToolCall': return [toolActivity(item)];
    case 'webSearch': return [{ kind: 'activity', icon: 'search', text: item.query ?? 'web', status: 'ok' }];
    case 'imageView': return [{ kind: 'activity', icon: 'read', text: item.path ?? '', status: 'ok' }];
    default: return [];
  }
}

const withIds = list => list.map(i => ({ id: randomUUID(), ...i }));
const mapTurns = turns => withIds((turns ?? []).flatMap(t => (t.items ?? []).flatMap(mapThreadItem)));

// ---- approvals ----------------------------------------------------------------

const V2_DECISION = { approve: 'accept', deny: 'decline', always: 'acceptForSession' };
const LEGACY_DECISION = { approve: 'approved', always: 'approved_for_session', deny: { denied: { rejection: 'Declined in Jarvis' } } };

function grantedPermissions(requested) {
  const out = {};
  if (requested?.network) out.network = requested.network;
  if (requested?.fileSystem) out.fileSystem = requested.fileSystem;
  return out;
}

const APPROVALS = {
  'item/commandExecution/requestApproval': {
    describe: p => ({ title: 'Εκτέλεση εντολής', command: p.command ?? undefined, detail: joinDetail(p.reason, p.cwd) }),
    result: d => ({ decision: V2_DECISION[d] }),
    cancel: () => ({ decision: 'cancel' }),
  },
  'item/fileChange/requestApproval': {
    describe: (p, files) => ({ title: 'Αλλαγή αρχείων', detail: joinDetail(p.reason, files?.join(', ') || p.grantRoot) }),
    result: d => ({ decision: V2_DECISION[d] }),
    cancel: () => ({ decision: 'cancel' }),
  },
  'item/permissions/requestApproval': {
    describe: p => ({ title: 'Επιπλέον δικαιώματα', detail: joinDetail(p.reason, describePermissions(p.permissions)) }),
    result: (d, p) => d === 'deny'
      ? { permissions: {}, scope: 'turn' }
      : { permissions: grantedPermissions(p.permissions), scope: d === 'always' ? 'session' : 'turn' },
    cancel: () => ({ permissions: {}, scope: 'turn' }),
  },
  execCommandApproval: {
    describe: p => ({ title: 'Εκτέλεση εντολής', command: (p.command ?? []).join(' '), detail: joinDetail(p.reason, p.cwd) }),
    result: d => ({ decision: LEGACY_DECISION[d] }),
    cancel: () => ({ decision: 'abort' }),
  },
  applyPatchApproval: {
    describe: p => ({ title: 'Αλλαγή αρχείων', detail: joinDetail(p.reason, Object.keys(p.fileChanges ?? {}).join(', ')) }),
    result: d => ({ decision: LEGACY_DECISION[d] }),
    cancel: () => ({ decision: 'abort' }),
  },
};

function joinDetail(...parts) {
  return parts.filter(x => typeof x === 'string' && x).join(' — ');
}

function describePermissions(perm) {
  const out = [];
  if (perm?.network?.enabled) out.push('δίκτυο');
  const fs = perm?.fileSystem;
  if (fs?.read?.length) out.push('ανάγνωση: ' + fs.read.join(', '));
  if (fs?.write?.length) out.push('εγγραφή: ' + fs.write.join(', '));
  return out.join('; ');
}

// ---- adapter ------------------------------------------------------------------

class CodexAdapter extends EventEmitter {
  #server; #account; #cwd;
  #threadId = null; #needsResume = false;
  #activeTurn = null; #seenTurns = new Set();
  #state = 'idle';
  #live = new Map();       // codex item id -> { id, kind, text }
  #files = new Map();      // fileChange item id -> paths (for approval detail)
  #approvals = new Map();  // token -> { method, params, requestId, resolve }
  #queue = Promise.resolve();
  #unsub = [];
  #closed = false;

  constructor({ server, account, cwd }) {
    super();
    this.#server = server;
    this.#account = account ?? {};
    this.#cwd = cwd;
    this.#unsub.push(
      server.onNotification((m, p) => this.#onNotification(m, p)),
      server.onRequest((m, p, id) => this.#onRequest(m, p, id)),
      server.onExit(code => this.#onExit(code)),
    );
  }

  #policy() {
    return { approvalPolicy: 'on-request', sandbox: this.#account.mode === 'cautious' ? 'read-only' : 'workspace-write' };
  }

  async start({ resumeId } = {}) {
    if (resumeId) {
      const r = await this.#server.request('thread/resume', { threadId: resumeId, ...this.#policy() });
      this.#threadId = r.thread.id;
      let items = mapTurns(r.thread.turns);
      if (!items.length) items = await readCodexHistory({ server: this.#server, threadId: this.#threadId }).catch(() => []);
      for (const it of items) this.emit('item', it);
    } else {
      const r = await this.#server.request('thread/start', { cwd: this.#cwd, ...this.#policy() });
      this.#threadId = r.thread.id;
    }
    return { externalId: this.#threadId };
  }

  send(text) {
    this.#queue = this.#queue.then(() => this.#send(text)).catch(e => this.#fail(e));
  }

  async #send(text) {
    const input = [{ type: 'text', text, text_elements: [] }];
    this.#setState('working');
    if (this.#needsResume) {
      await this.#server.request('thread/resume', { threadId: this.#threadId, ...this.#policy(), excludeTurns: true });
      this.#needsResume = false;
    }
    if (this.#activeTurn) {
      await this.#server.request('turn/steer', { threadId: this.#threadId, input, expectedTurnId: this.#activeTurn });
      return;
    }
    const r = await this.#server.request('turn/start', { threadId: this.#threadId, input });
    const id = r?.turn?.id;
    if (id && !this.#seenTurns.has(id)) { this.#seenTurns.add(id); this.#activeTurn = id; }
  }

  #fail(e) {
    if (e?.code === 'SERVER_EXIT' || this.#closed) return; // reported through onExit
    this.emit('item', { id: randomUUID(), kind: 'error', text: `Codex: ${e?.message ?? e}` });
    this.#activeTurn = null;
    this.#setState('error');
  }

  interrupt() {
    this.#cancelApprovals();
    const turnId = this.#activeTurn;
    if (!turnId || !this.#threadId) return;
    this.#server.request('turn/interrupt', { threadId: this.#threadId, turnId }).catch(() => { /* turn already over */ });
  }

  answer(token, decision) {
    const rec = this.#approvals.get(token);
    if (!rec) throw new Error('No pending Codex approval for that token');
    const spec = APPROVALS[rec.method];
    if (!(decision in V2_DECISION)) throw new Error(`Unknown decision "${decision}"`);
    this.#approvals.delete(token);
    rec.resolve(spec.result(decision, rec.params));
    if (!this.#approvals.size) this.#setState('working');
  }

  close() {
    if (this.#closed) return;
    const turnId = this.#activeTurn;
    this.#cancelApprovals();
    this.#closed = true;
    for (const u of this.#unsub) u();
    if (turnId && this.#threadId) {
      this.#server.request('turn/interrupt', { threadId: this.#threadId, turnId }).catch(() => {});
    }
  }

  #setState(s) {
    if (this.#state === s) return;
    this.#state = s;
    this.emit('state', s);
  }

  #cancelApprovals() {
    for (const rec of this.#approvals.values()) rec.resolve(APPROVALS[rec.method].cancel());
    this.#approvals.clear();
  }

  #onExit(code) {
    if (this.#closed) return;
    this.#approvals.clear(); // the requests died with the server
    this.#live.clear();
    const busy = this.#state === 'working' || this.#state === 'waiting' || this.#activeTurn;
    this.#activeTurn = null;
    if (this.#threadId) this.#needsResume = true;
    this.#state = 'idle';
    if (busy) this.emit('exit', code);
  }

  #onRequest(method, params, requestId) {
    if (this.#closed || !this.#threadId) return undefined;
    if ((params.threadId ?? params.conversationId) !== this.#threadId) return undefined;
    const spec = APPROVALS[method];
    if (!spec) return undefined; // not ours to answer: the server replies "unsupported"
    return new Promise((resolve) => {
      const token = randomUUID();
      this.#approvals.set(token, { method, params, requestId, resolve });
      const d = spec.describe(params, this.#files.get(params.itemId));
      const ev = { token, title: d.title, detail: d.detail };
      if (d.command) ev.command = d.command;
      this.emit('approval', ev);
      this.#setState('waiting');
    });
  }

  #onNotification(method, p) {
    if (this.#closed || !this.#threadId || p.threadId !== this.#threadId) return;
    switch (method) {
      case 'turn/started':
        this.#seenTurns.add(p.turn?.id);
        this.#activeTurn = p.turn?.id ?? this.#activeTurn;
        this.#setState(this.#approvals.size ? 'waiting' : 'working');
        break;
      case 'turn/completed': {
        this.#seenTurns.add(p.turn?.id);
        for (const [cid, rec] of this.#live) {
          if (rec.kind === 'assistant') this.emit('update', rec.id, { streaming: false });
          else this.emit('update', rec.id, { status: p.turn?.status === 'completed' ? 'ok' : 'fail' });
          this.#live.delete(cid);
        }
        if (p.turn?.status === 'failed' && p.turn.error?.message) {
          this.emit('item', { id: randomUUID(), kind: 'error', text: p.turn.error.message });
        }
        this.#approvals.clear();
        if (!p.turn?.id || p.turn.id === this.#activeTurn) this.#activeTurn = null;
        this.#files.clear();
        this.#setState('idle');
        break;
      }
      case 'item/started': this.#itemStarted(p.item); break;
      case 'item/completed': this.#itemCompleted(p.item); break;
      case 'item/agentMessage/delta': {
        const rec = this.#assistant(p.itemId);
        rec.text += p.delta ?? '';
        this.emit('delta', rec.id, p.delta ?? '');
        break;
      }
      case 'serverRequest/resolved':
        for (const [token, rec] of this.#approvals) if (rec.requestId === p.requestId) this.#approvals.delete(token);
        break;
      case 'error':
        if (p.error?.message) {
          this.emit('item', { id: randomUUID(), kind: p.willRetry ? 'notice' : 'error', text: p.error.message });
        }
        break;
      default: break;
    }
  }

  #assistant(codexId) {
    let rec = this.#live.get(codexId);
    if (!rec) {
      rec = { id: randomUUID(), kind: 'assistant', text: '' };
      this.#live.set(codexId, rec);
      this.emit('item', { id: rec.id, kind: 'assistant', text: '', streaming: true });
    }
    return rec;
  }

  #itemStarted(item) {
    if (!item?.id || this.#live.has(item.id)) return;
    if (item.type === 'agentMessage') { this.#assistant(item.id); return; }
    if (item.type === 'fileChange') { this.#files.set(item.id, (item.changes ?? []).map(c => c.path)); return; }
    if (['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
      const [norm] = mapThreadItem(item);
      const rec = { id: randomUUID(), kind: 'activity' };
      this.#live.set(item.id, rec);
      this.emit('item', { id: rec.id, ...norm, status: 'running' });
    }
  }

  #itemCompleted(item) {
    // The user's own message is echoed back; ChatManager already added it on send.
    if (!item?.id || item.type === 'userMessage') return;
    const rec = this.#live.get(item.id);
    this.#live.delete(item.id);
    if (item.type === 'fileChange') this.#files.delete(item.id);
    if (!rec) { for (const it of withIds(mapThreadItem(item))) this.emit('item', it); return; }
    if (rec.kind === 'assistant') {
      const patch = { streaming: false };
      if (typeof item.text === 'string' && item.text !== rec.text) patch.text = item.text;
      this.emit('update', rec.id, patch);
      return;
    }
    const [norm] = mapThreadItem(item);
    if (norm) {
      const { kind, ...patch } = norm;
      this.emit('update', rec.id, patch);
    }
  }
}

export function createCodexAdapter({ server, account, cwd }) {
  return new CodexAdapter({ server, account, cwd });
}

// ---- past threads -------------------------------------------------------------

export function normalizeCwd(p) {
  return String(p ?? '').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

const toIso = t => (typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : t ?? null);

export async function listCodexThreads({ server, cwd, limit = 30 }) {
  const want = normalizeCwd(cwd);
  const out = [];
  let cursor = null;
  for (let page = 0; page < 5 && out.length < limit; page++) {
    const r = await server.request('thread/list', { limit, cwd, ...(cursor ? { cursor } : {}) });
    for (const t of r?.data ?? []) {
      if (normalizeCwd(t.cwd) !== want) continue;
      const title = t.name || (t.preview ? t.preview.slice(0, 80) : '') || 'Χωρίς τίτλο';
      out.push({ externalId: t.id, title, updatedAt: toIso(t.updatedAt), cwd: t.cwd });
      if (out.length >= limit) break;
    }
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export async function readCodexHistory({ server, threadId }) {
  const r = await server.request('thread/read', { threadId, includeTurns: true });
  return mapTurns(r?.thread?.turns);
}
