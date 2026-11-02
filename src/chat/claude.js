// Claude Code chat adapter: drives `claude -p` in stream-json mode (one process per
// conversation, one JSON object per line on stdin/stdout) and translates it into the
// normalized chat events consumed by ChatManager (see ./model.js).
// Shapes confirmed against Claude Code 2.1.316 (schemas in the binary + real runs):
//   in : {type:'user', message:{role:'user', content}, parent_tool_use_id:null, session_id:''}
//        {type:'control_response', response:{subtype:'success'|'error', request_id, response|error}}
//        {type:'control_request', request_id, request:{subtype:'interrupt'}}
//   out: {type:'system', subtype:'init', session_id, ...}   (once per turn)
//        {type:'stream_event', event:<Anthropic stream event>, parent_tool_use_id}
//        {type:'assistant'|'user', message:{content:[text|tool_use|tool_result...]}, parent_tool_use_id}
//        {type:'control_request', request_id, request:{subtype:'can_use_tool', tool_name, input, ...}}
//        {type:'control_cancel_request', request_id}
//        {type:'result', subtype, is_error, result, session_id}
// Permission prompts reach the host only with `--permission-prompt-tool stdio` (what the
// Agent SDK passes); with `--permission-prompts host` alone every ask is denied locally.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import * as cp from 'node:child_process';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = s => typeof s === 'string' && UUID_RE.test(s);

// Account permission mode -> Claude Code --permission-mode. Anything else is refused.
const PERMISSION_MODE = Object.freeze({ 'edit-in-project': 'acceptEdits', cautious: 'default' });

const DENY_MESSAGE = 'The user denied this in Jarvis.';
const DECISIONS = Object.freeze({ approve: 'allow', deny: 'deny', always: 'allow' });
const isDecision = d => typeof d === 'string' && Object.hasOwn(DECISIONS, d);

// ---- item mapping -------------------------------------------------------------

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const RUN_TOOLS = new Set(['Bash', 'PowerShell']);

function toolActivity(name, input) {
  const i = input ?? {};
  if (name === 'Read') return { icon: 'read', text: String(i.file_path ?? '') };
  if (name === 'Glob' || name === 'Grep') return { icon: 'search', text: String(i.pattern ?? '') };
  if (RUN_TOOLS.has(name)) return { icon: 'run', text: String(i.command ?? '') };
  if (EDIT_TOOLS.has(name)) return { icon: 'edit', text: String(i.file_path ?? i.notebook_path ?? '') };
  if (name === 'WebSearch') return { icon: 'search', text: String(i.query ?? 'web') };
  if (name === 'WebFetch') return { icon: 'read', text: String(i.url ?? '') };
  return { icon: 'tool', text: String(name ?? 'tool') };
}

function hunk(oldStr, newStr) {
  const a = String(oldStr).split('\n');
  const b = String(newStr).split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  const lines = [
    ...a.slice(0, pre).map(l => ' ' + l),
    ...removed.map(l => '-' + l),
    ...added.map(l => '+' + l),
    ...a.slice(a.length - suf).map(l => ' ' + l),
  ];
  return { lines, added: added.length, removed: removed.length };
}

// Edit/MultiEdit with old/new strings -> diff item (without id); otherwise null.
function diffFor(name, input) {
  let pairs = null;
  if (name === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    pairs = [[input.old_string, input.new_string]];
  } else if (name === 'MultiEdit' && Array.isArray(input?.edits)
    && input.edits.every(e => typeof e?.old_string === 'string' && typeof e?.new_string === 'string')) {
    pairs = input.edits.map(e => [e.old_string, e.new_string]);
  }
  if (!pairs || typeof input.file_path !== 'string') return null;
  const path = input.file_path;
  let added = 0, removed = 0;
  const body = [];
  for (const [o, n] of pairs) {
    const h = hunk(o, n);
    added += h.added; removed += h.removed;
    body.push('@@', ...h.lines);
  }
  return { kind: 'diff', path, added, removed, patch: [`--- ${path}`, `+++ ${path}`, ...body].join('\n') };
}

const blocks = content => (Array.isArray(content) ? content : []);

const NOISE_RE = /^\s*<(command-name|command-message|command-args|local-command-[a-z]+|system-reminder)>/;

// Text the user actually typed, or '' for tool results, meta lines and slash-command noise.
function userText(msg) {
  if (!msg || msg.type !== 'user' || msg.isMeta || msg.isSidechain) return '';
  const c = msg.message?.content;
  const parts = typeof c === 'string' ? [c] : blocks(c).filter(b => b?.type === 'text').map(b => String(b.text ?? ''));
  return parts.filter(p => p.trim() && !NOISE_RE.test(p)).join('\n');
}

function joinDetail(...parts) {
  return parts.filter(x => typeof x === 'string' && x).join(' — ');
}

function describeApproval(req) {
  const name = req.tool_name;
  const input = req.input ?? {};
  const reason = typeof req.decision_reason === 'string' ? req.decision_reason : undefined;
  if (RUN_TOOLS.has(name)) {
    return { title: 'Εκτέλεση εντολής', command: String(input.command ?? ''),
      detail: joinDetail(input.description ?? req.description, reason) };
  }
  if (EDIT_TOOLS.has(name)) {
    return { title: 'Αλλαγή αρχείου', detail: joinDetail(input.file_path ?? input.notebook_path ?? req.description, reason) };
  }
  let json = '';
  try { json = JSON.stringify(input); } catch { /* unserializable */ }
  if (json.length > 300) json = json.slice(0, 300) + '…';
  return { title: `Χρήση εργαλείου: ${req.display_name || name}`,
    detail: joinDetail(req.description, req.blocked_path, reason, json) };
}

// ---- adapter --------------------------------------------------------------------

class ClaudeAdapter extends EventEmitter {
  #opts; #mode; #child = null; #buf = '';
  #sessionId = null; #sessionStarted = false;
  #state = 'idle'; #closed = false; #interrupted = false;
  #liveText = null;            // { id, text } of the streaming assistant item
  #tools = new Map();          // tool_use id -> { id, name, input }
  #approvals = new Map();      // token -> { requestId, sig, input }
  #always = new Set();         // tool name + exact input JSON granted "always" in this conversation

  constructor(opts) {
    super();
    const mode = opts.account?.mode;
    if (typeof mode !== 'string' || !Object.hasOwn(PERMISSION_MODE, mode)) {
      throw new Error(`Unknown Claude account mode "${mode}"`);
    }
    // Never inherit process.env by accident: it must be the account env from policy.buildEnv.
    if (!opts.env || typeof opts.env !== 'object') throw new TypeError('Claude adapter needs an explicit env (policy.buildEnv)');
    if (typeof opts.claudeCmd !== 'string' || !/^[\w.:\\/ -]+$/.test(opts.claudeCmd)) {
      throw new Error('Invalid claude command');
    }
    this.#mode = PERMISSION_MODE[mode];
    this.#opts = opts;
  }

  async start({ resumeId } = {}) {
    if (resumeId != null) {
      if (!isUuid(resumeId)) throw new Error('Invalid Claude session id');
      this.#sessionId = resumeId;
      this.#sessionStarted = true;
      const items = await readClaudeHistory({ claudeHome: this.#opts.claudeHome, cwd: this.#opts.cwd, sessionId: resumeId })
        .catch(() => []);
      for (const it of items) this.emit('item', it);
    } else {
      this.#sessionId = randomUUID();
    }
    return { externalId: this.#sessionId };
  }

  send(text) {
    if (this.#closed) return;
    if (!this.#child) this.#spawn();
    this.#interrupted = false;
    this.#setState(this.#approvals.size ? 'waiting' : 'working');
    this.#write({ type: 'user', message: { role: 'user', content: String(text) }, parent_tool_use_id: null, session_id: '' });
  }

  interrupt() {
    if (!this.#child) return;
    this.#interrupted = true;
    for (const rec of this.#approvals.values()) this.#respond(rec.requestId, { behavior: 'deny', message: 'Interrupted in Jarvis.', interrupt: true });
    this.#approvals.clear();
    this.#write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  answer(token, decision) {
    const rec = this.#approvals.get(token);
    if (!rec) throw new Error('No pending Claude approval for that token');
    if (!isDecision(decision)) throw new Error(`Unknown decision "${decision}"`);
    this.#approvals.delete(token);
    if (decision === 'always') this.#always.add(rec.sig);
    this.#respond(rec.requestId, DECISIONS[decision] === 'allow'
      ? { behavior: 'allow', updatedInput: rec.input }
      : { behavior: 'deny', message: DENY_MESSAGE });
    if (!this.#approvals.size) this.#setState('working');
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#approvals.clear();
    const child = this.#child;
    this.#child = null;
    if (child) killTree(child);
    this.emit('exit', 0); // the only place 'exit' is emitted
  }

  // -- process ---------------------------------------------------------------------

  #args() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-mode', this.#mode, '--permission-prompts', 'host',
      '--permission-prompt-tool', 'stdio'];
    if (!isUuid(this.#sessionId)) throw new Error('Invalid Claude session id');
    if (this.#sessionStarted) args.push('--resume', this.#sessionId);
    else args.push('--session-id', this.#sessionId);
    return args;
  }

  #spawn() {
    const { file, fileArgs, claudeCmd, env, cwd, spawn } = this.#opts;
    const args = this.#args();
    let f, a;
    if (file) { f = file; a = [...(fileArgs ?? []), ...args]; }
    else if (process.platform === 'win32') { f = process.env.ComSpec || 'cmd.exe'; a = ['/d', '/s', '/c', claudeCmd, ...args]; }
    else { f = claudeCmd; a = args; }
    const child = spawn(f, a, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    this.#buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.#child !== child) return;
      this.#buf += chunk;
      let nl;
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl).replace(/\r$/, '');
        this.#buf = this.#buf.slice(nl + 1);
        if (line.trim()) this.#onLine(line);
        if (this.#child !== child) return;
      }
    });
    child.stderr.on('data', () => { /* drained */ });
    child.stdin.on('error', () => { /* EPIPE after exit is reported via 'exit' */ });
    child.on('error', e => this.#onExit(child, e?.message));
    child.on('exit', code => this.#onExit(child, code));
  }

  #onExit(child, code) {
    if (this.#child !== child || this.#closed) return;
    this.#child = null;
    this.#approvals.clear(); // the requests died with the process
    const busy = this.#state === 'working' || this.#state === 'waiting';
    this.#finishTurn('fail');
    // The conversation survives: the next send respawns with --resume <session id>.
    if (busy) {
      this.emit('item', { id: randomUUID(), kind: 'error',
        text: `Το Claude Code σταμάτησε απρόσμενα (κωδικός ${code ?? 'άγνωστος'}) — ξαναπροσπάθησε.` });
      this.#setState('error');
    }
  }

  #write(msg) {
    const child = this.#child;
    if (!child) return;
    try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* exited meanwhile */ }
  }

  #respond(requestId, response) {
    this.#write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  #setState(s) {
    if (this.#state === s) return;
    this.#state = s;
    this.emit('state', s);
  }

  // -- stdout ----------------------------------------------------------------------

  #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          // A resume can continue under a new id (e.g. a copy of a running session).
          if (isUuid(msg.session_id) && msg.session_id !== this.#sessionId) {
            this.#sessionId = msg.session_id;
            this.emit('external-id', msg.session_id);
          }
          this.#sessionStarted = true;
          if (this.#state === 'idle') this.#setState(this.#approvals.size ? 'waiting' : 'working');
        }
        break;
      case 'stream_event': if (msg.parent_tool_use_id == null) this.#onStreamEvent(msg.event); break;
      case 'assistant': if (msg.parent_tool_use_id == null) this.#onAssistant(msg.message); break;
      case 'user': if (msg.parent_tool_use_id == null) this.#onToolResults(msg.message); break;
      case 'control_request': this.#onControlRequest(msg); break;
      case 'control_cancel_request': this.#onCancel(msg.request_id); break;
      case 'result': this.#onResult(msg); break;
      default: break; // control_response to our interrupt, rate_limit_event, ...
    }
  }

  #onStreamEvent(ev) {
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
      this.#closeText();
      this.#textItem();
    } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      const rec = this.#textItem();
      rec.text += ev.delta.text;
      this.emit('delta', rec.id, ev.delta.text);
    }
  }

  #textItem() {
    if (!this.#liveText) {
      this.#liveText = { id: randomUUID(), text: '' };
      this.emit('item', { id: this.#liveText.id, kind: 'assistant', text: '', streaming: true });
    }
    return this.#liveText;
  }

  #closeText(finalText) {
    const rec = this.#liveText;
    if (!rec) return;
    this.#liveText = null;
    const patch = { streaming: false };
    if (typeof finalText === 'string' && finalText !== rec.text) patch.text = finalText;
    this.emit('update', rec.id, patch);
  }

  #onAssistant(message) {
    for (const b of blocks(message?.content)) {
      if (b?.type === 'text') {
        const text = String(b.text ?? '');
        if (this.#liveText) this.#closeText(text);
        else if (text) this.emit('item', { id: randomUUID(), kind: 'assistant', text, streaming: false });
      } else if (b?.type === 'tool_use' && typeof b.id === 'string' && !this.#tools.has(b.id)) {
        this.#closeText();
        const rec = { id: randomUUID(), name: b.name, input: b.input ?? {} };
        this.#tools.set(b.id, rec);
        this.emit('item', { id: rec.id, kind: 'activity', ...toolActivity(b.name, b.input), status: 'running' });
      }
    }
  }

  #onToolResults(message) {
    for (const b of blocks(message?.content)) {
      if (b?.type !== 'tool_result') continue;
      const rec = this.#tools.get(b.tool_use_id);
      if (!rec) continue;
      this.#tools.delete(b.tool_use_id);
      const ok = b.is_error !== true;
      this.emit('update', rec.id, { status: ok ? 'ok' : 'fail' });
      const diff = ok && diffFor(rec.name, rec.input);
      if (diff) this.emit('item', { id: randomUUID(), ...diff });
    }
  }

  #onControlRequest(msg) {
    const req = msg.request ?? {};
    const requestId = msg.request_id;
    if (typeof requestId !== 'string') return;
    if (req.subtype !== 'can_use_tool' || this.#closed) {
      this.#write({ type: 'control_response', response: { subtype: 'error', request_id: requestId,
        error: `Jarvis does not support control request "${String(req.subtype)}"` } });
      return;
    }
    const input = req.input && typeof req.input === 'object' ? req.input : {};
    let sig;
    try { sig = `${req.tool_name}\u0000${JSON.stringify(input)}`; } catch { sig = null; }
    if (sig && this.#always.has(sig)) {
      const act = toolActivity(req.tool_name, input);
      this.emit('item', { id: randomUUID(), kind: 'activity', icon: act.icon, status: 'ok',
        text: `Εγκρίθηκε αυτόματα (Πάντα για αυτό): ${req.tool_name}${act.text && act.text !== req.tool_name ? ' ' + act.text : ''}` });
      this.#respond(requestId, { behavior: 'allow', updatedInput: input });
      return;
    }
    const token = randomUUID();
    this.#approvals.set(token, { requestId, sig, input });
    const d = describeApproval({ ...req, input });
    const ev = { token, title: d.title, detail: d.detail };
    if (d.command !== undefined) ev.command = d.command;
    this.emit('approval', ev);
    this.#setState('waiting');
  }

  #onCancel(requestId) {
    let hit = false;
    for (const [token, rec] of this.#approvals) {
      if (rec.requestId !== requestId) continue;
      this.#approvals.delete(token);
      hit = true;
      this.emit('approval-expired', token);
    }
    if (hit && !this.#approvals.size && this.#state === 'waiting') this.#setState('working');
  }

  #onResult(msg) {
    this.#finishTurn('fail');
    if (msg.is_error && !this.#interrupted) {
      const why = typeof msg.result === 'string' && msg.result ? msg.result
        : Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join('; ') : String(msg.subtype ?? 'error');
      this.emit('item', { id: randomUUID(), kind: 'error', text: `Claude Code: ${why}` });
    }
    this.#interrupted = false;
    this.#approvals.clear(); // the turn is over; ChatManager expires their cards on idle
    this.#setState('idle');
  }

  // Close the streaming text and any tool call that never got a result.
  #finishTurn(status) {
    this.#closeText();
    for (const rec of this.#tools.values()) this.emit('update', rec.id, { status });
    this.#tools.clear();
  }
}

function killTree(child) {
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

const defaultClaudeHome = env => env?.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// `file`/`fileArgs` override the command (tests run a fake script via process.execPath).
export function createClaudeAdapter({ account, cwd, env, claudeCmd = 'claude', spawn = cp.spawn, claudeHome, file, fileArgs } = {}) {
  return new ClaudeAdapter({ account, cwd, env, claudeCmd, spawn, file, fileArgs,
    claudeHome: claudeHome ?? defaultClaudeHome(env) });
}

// ---- past sessions ------------------------------------------------------------------

// Claude Code's project folder name for a cwd: every non-alphanumeric UTF-16 unit
// becomes "-"; names over 200 chars are cut and suffixed with a 32-bit string hash.
export function claudeProjectSlug(cwd) {
  const s = String(cwd);
  const slug = s.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

function cleanCwd(cwd) {
  const s = String(cwd ?? '').normalize('NFC').replace(/^\\\\\?\\/, '');
  return /^[a-zA-Z]:[\\/]?$/.test(s) ? s : s.replace(/[\\/]+$/, '');
}

async function projectDir(claudeHome, cwd) {
  const root = join(claudeHome, 'projects');
  const slug = claudeProjectSlug(cleanCwd(cwd));
  try {
    if ((await fsp.stat(join(root, slug))).isDirectory()) return join(root, slug);
  } catch { /* fall through: drive letter or case may differ */ }
  try {
    const want = slug.toLowerCase();
    const hit = (await fsp.readdir(root, { withFileTypes: true }))
      .find(d => d.isDirectory() && d.name.toLowerCase() === want);
    return hit ? join(root, hit.name) : null;
  } catch {
    return null;
  }
}

const normCwd = (p) => String(p ?? '').normalize('NFC').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// Whether Claude recorded this folder as the cwd anywhere in a session file. The project
// folder name is a lossy slug (non-ASCII folders collide), so this proves a session belongs
// to a folder. A session can start in another folder and move here later, so every line counts.
async function workedIn(file, want) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg?.cwd === 'string' && normCwd(msg.cwd) === want) return true;
    }
  } catch { /* unreadable */ } finally {
    rl.close();
    stream.destroy();
  }
  return false;
}

async function firstUserText(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 2000) break;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const t = userText(msg);
      if (t) return t;
    }
  } catch { /* unreadable */ } finally {
    rl.close();
    stream.destroy();
  }
  return '';
}

export async function listClaudeSessions({ claudeHome, cwd, limit = 30 }) {
  const dir = await projectDir(claudeHome, cwd);
  if (!dir) return [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const d of entries) {
    if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
    const id = d.name.slice(0, -'.jsonl'.length);
    if (!isUuid(id)) continue;
    try { files.push({ id, file: join(dir, d.name), mtime: (await fsp.stat(join(dir, d.name))).mtime }); } catch { /* gone */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    if (!(await workedIn(f.file, normCwd(cleanCwd(cwd))))) continue;
    const text = (await firstUserText(f.file)).replace(/\s+/g, ' ').trim();
    if (!text) continue; // nothing the user said: not a conversation worth continuing
    out.push({ externalId: f.id, title: [...text].slice(0, 60).join(''), updatedAt: f.mtime.toISOString() });
  }
  return out;
}

const HISTORY_CAP = 500;

export async function readClaudeHistory({ claudeHome, cwd, sessionId }) {
  if (!isUuid(sessionId)) throw new Error('Invalid Claude session id');
  const dir = await projectDir(claudeHome, cwd);
  if (!dir) return [];
  const raw = await fsp.readFile(join(dir, `${sessionId}.jsonl`), 'utf8');
  const entries = [];              // items, or tool records resolved below
  const tools = new Map();         // tool_use id -> record
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg?.isSidechain || msg?.isMeta) continue;
    if (msg?.type === 'user') {
      for (const b of blocks(msg.message?.content)) {
        if (b?.type === 'tool_result' && tools.has(b.tool_use_id)) tools.get(b.tool_use_id).ok = b.is_error !== true;
      }
      const t = userText(msg);
      if (t) entries.push({ kind: 'user', text: t });
    } else if (msg?.type === 'assistant') {
      for (const b of blocks(msg.message?.content)) {
        if (b?.type === 'text' && b.text) entries.push({ kind: 'assistant', text: String(b.text), streaming: false });
        else if (b?.type === 'tool_use' && typeof b.id === 'string' && !tools.has(b.id)) {
          const rec = { tool: true, name: b.name, input: b.input ?? {}, ok: null };
          tools.set(b.id, rec);
          entries.push(rec);
        }
      }
    }
  }
  const items = entries.map((e) => {
    if (!e.tool) return e;
    const diff = e.ok && diffFor(e.name, e.input);
    if (diff) return diff;
    return { kind: 'activity', ...toolActivity(e.name, e.input), status: e.ok ? 'ok' : 'fail' };
  });
  return items.slice(-HISTORY_CAP).map(i => ({ id: randomUUID(), ...i }));
}
