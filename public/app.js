// Jarvis HUD: wires the mockup layout to /api/state and the /ws socket.
// Everything from the server is data: it only ever reaches the DOM via textContent.
import { createOrb } from './orb.js';

const TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content ?? '';
const $ = (id) => document.getElementById(id);

// Display copy per account (from the mockup).
const LOOK = {
  work: { name: 'CODEX', display: 'Codex Δουλειά', mode: 'Codex mode · λογαριασμός δουλειάς', card: 'Codex δουλειά · weekly usage' },
  mine: { name: 'CODEX', display: 'Codex Δικό μου', mode: 'Codex mode · προσωπικός λογαριασμός', card: 'Codex δικό μου · weekly usage' },
  claude: { name: 'CLAUDE', display: 'Claude Code', mode: 'Original Jarvis core · Claude Code mode', card: 'Claude · weekly usage' },
  gemini: { name: 'GEMINI', display: 'Gemini', mode: 'Gemini mode · σύντομα', card: 'Gemini · weekly usage' },
};
const look = (acc) => LOOK[acc.id] ?? {
  name: acc.label.toUpperCase(), display: acc.label, mode: `${acc.label} mode`, card: `${acc.label} · weekly usage`,
};

const ERRORS = {
  NO_HOME: 'Ορίσε φάκελο για αυτόν τον λογαριασμό στο jarvis.config.json',
  SIDE_MISMATCH: 'Αυτό το project δεν επιτρέπεται με αυτόν τον λογαριασμό',
  UNKNOWN_PROJECT: 'Αυτό το project δεν υπάρχει πια στο jarvis.config.json',
  DISABLED: 'Ο λογαριασμός δεν έχει ρυθμιστεί ακόμα',
};
const errorText = (code) => ERRORS[code] ?? `Κάτι πήγε στραβά (${code})`;
const STATE_LABEL = { idle: 'Idle', working: 'Working', done: 'Done', error: 'Error' };
const DAYS = ['ΚΥΡ', 'ΔΕΥ', 'ΤΡΙ', 'ΤΕΤ', 'ΠΕΜ', 'ΠΑΡ', 'ΣΑΒ'];

// ---------- small helpers ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked */ }
  },
};
const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return [140, 133, 146];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const safeColor = (hex) => (/^#[0-9a-f]{3,8}$/i.test(String(hex ?? '')) ? hex : '#8c8592');
const fmtTokens = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
};
const fmtPct = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');
function fmtReset(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toTimeString().slice(0, 5);
  return d.getTime() - Date.now() < 20 * 3600e3 ? `reset ${hm}` : `reset ${DAYS[d.getDay()]} ${hm}`;
}
const WEEKDAYS = ['Κυρ', 'Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ'];
// "updated 14:05" today, "updated Δευ 14:05" on another day; '' when unknown.
function fmtUpdated(iso) {
  const d = new Date(iso);
  if (iso == null || Number.isNaN(d.getTime())) return '';
  const hm = d.toTimeString().slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? `updated ${hm}` : `updated ${WEEKDAYS[d.getDay()]} ${hm}`;
}
const updatedText = (view) => (view && view.kind !== 'none' ? fmtUpdated(view.updatedAt) : '');
function showMsg(node, text, ok = false) {
  node.textContent = text;
  node.classList.toggle('ok', ok);
  node.hidden = !text;
}

// ---------- state ----------
const S = {
  accounts: [],
  projects: [],
  quickCommands: [],
  jobs: [],
  usage: {},
  directives: [],
  selected: store.get('jarvis.account', 'claude'),
  lastProject: store.get('jarvis.lastProject', {}),
  focused: null,
};
const account = (id) => S.accounts.find((a) => a.id === id);
const selectedAccount = () => account(S.selected);

// ---------- API ----------
class ApiError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'x-jarvis-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('OFFLINE', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP_${res.status}`, res.status);
  return data;
}

// ---------- orb + switcher ----------
const orb = createOrb($('orb'), { shape: S.selected, rgb: [224, 96, 154], pauseButton: $('pause') });

function renderSwitcher() {
  const nav = $('switch');
  nav.replaceChildren();
  for (const acc of S.accounts) {
    const b = el('button', {
      type: 'button',
      'data-a': acc.id,
      'aria-pressed': String(acc.id === S.selected),
      class: acc.enabled ? '' : 'off',
      style: { '--c': safeColor(acc.color) },
      title: acc.enabled ? acc.label : `${acc.label} · not set up`,
      onclick: () => select(acc.id),
    }, el('i'), look(acc).display);
    if (!acc.enabled) b.append(el('small', { text: 'not set up' }));
    nav.append(b);
  }
}

function select(id) {
  const acc = account(id);
  if (!acc) return;
  S.selected = id;
  store.set('jarvis.account', id);
  for (const b of $('switch').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.a === id));
  const rgb = hexRgb(acc.color);
  document.documentElement.style.setProperty('--acc-rgb', rgb.join(','));
  orb.setColor(rgb);
  orb.setShape(id);
  const l = look(acc);
  $('coreName').textContent = l.name;
  $('mode').textContent = l.mode;
  renderCard();
  closePicker();
  showMsg($('skillsMsg'), '');
  showMsg($('askMsg'), '');
}

// ---------- usage ----------
function sparkline(series, color) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 22');
  svg.setAttribute('preserveAspectRatio', 'none');
  const pts = (Array.isArray(series) ? series : []).filter(Number.isFinite);
  if (pts.length) {
    const line = document.createElementNS(NS, 'polyline');
    const y = (p) => (21 - (Math.max(0, Math.min(100, p)) / 100) * 19).toFixed(1);
    const coords = pts.length === 1
      ? [`0,${y(pts[0])}`, `100,${y(pts[0])}`]
      : pts.map((p, i) => `${((i / (pts.length - 1)) * 100).toFixed(1)},${y(p)}`);
    line.setAttribute('points', coords.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1');
    svg.append(line);
  }
  return svg;
}

function perDayText(perDay) {
  if (perDay == null || !Number.isFinite(perDay)) return '';
  const abs = Math.abs(perDay);
  const n = abs >= 10 ? Math.round(abs) : Math.round(abs * 10) / 10;
  return `${perDay < 0 ? '▼' : '▲'} ${n}% /μέρα`;
}

function renderVitals() {
  const box = $('vitals');
  box.replaceChildren();
  for (const acc of S.accounts) {
    const color = safeColor(acc.color);
    const view = S.usage[acc.id];
    const big = el('div', { class: 'big' });
    if (view?.kind === 'percent') {
      const w = view.weekly;
      big.append(w?.reset ? '0%' : `${fmtPct(w?.pct)}%`);
      if (w?.reset) big.append(el('small', { text: '(reset)' }));
      const f = view.fiveHour;
      if (f) {
        const five = f.reset ? '5h 0% (reset)' : `5h ${fmtPct(f.pct)}%`;
        const reset = !f.reset && f.resetsAt ? ` · ${fmtReset(f.resetsAt)}` : '';
        big.append(el('small', { text: five + reset }));
      }
    } else if (view?.kind === 'tokens') {
      big.append(fmtTokens(view.weekly?.tokens));
      big.append(el('small', { text: 'tokens / 7d' }));
    } else {
      big.classList.add('dim');
      big.textContent = !acc.enabled || view?.reason === 'not set up' ? 'not set up' : 'no data';
      if (view?.reason) big.title = view.reason;
    }
    const upd = updatedText(view);
    box.append(el('div', { class: 'vital', style: { '--c': color } },
      el('div', { class: 'lbl' }, look(acc).display, el('em', { text: perDayText(view?.perDay) })),
      big,
      sparkline(view?.kind === 'percent' ? view.series : [], color),
      upd ? el('div', { class: 'upd', text: upd }) : null));
  }
  renderCard();
}

function renderCard() {
  const acc = selectedAccount();
  if (!acc) return;
  const view = S.usage[acc.id];
  $('cardT').textContent = look(acc).card;
  let n = '—';
  let unit = '';
  let p = 0;
  if (view?.kind === 'percent') {
    const w = view.weekly;
    if (w?.reset) { n = '0'; unit = '% (reset)'; } else if (Number.isFinite(w?.pct)) { n = fmtPct(w.pct); unit = '% used'; p = w.pct; }
  } else if (view?.kind === 'tokens') {
    n = fmtTokens(view.weekly?.tokens);
    unit = 'tokens / 7d';
  } else {
    unit = !acc.enabled ? 'not set up' : (view?.reason ?? 'no data');
  }
  $('cardN').textContent = n;
  $('cardU').textContent = unit;
  $('scale').style.setProperty('--p', `${Math.max(0, Math.min(100, p))}%`);
  const upd = updatedText(view);
  $('cardUpd').textContent = upd;
  $('cardUpd').hidden = !upd;
}

// ---------- directives + quick commands ----------
function renderDirectives() {
  const ul = $('dir');
  ul.replaceChildren();
  const list = S.directives.slice(0, 3);
  if (!list.length) ul.append(el('li', { class: 'empty', text: 'Κανένα directive στο today.md' }));
  for (const d of list) ul.append(el('li', { class: d.done ? 'done' : '', text: d.text }));
}

function renderSkills() {
  const box = $('skills');
  box.replaceChildren();
  for (const q of S.quickCommands) {
    box.append(el('button', { type: 'button', onclick: (e) => runQuick(q, e.currentTarget) }, q.label, el('span', { text: '→' })));
  }
}

// A remembered project that the server no longer accepts for this account: fall back to the home folder next time.
function forgetProject(accountId, code) {
  if (code !== 'UNKNOWN_PROJECT' && code !== 'SIDE_MISMATCH') return;
  delete S.lastProject[accountId];
  store.set('jarvis.lastProject', S.lastProject);
}

async function startJob(body, msgNode, button, onError) {
  showMsg(msgNode, '');
  if (button) button.disabled = true;
  try {
    const info = await api('POST', '/api/jobs', body);
    upsertJob(info);
    focusJob(info.id, true);
    return info;
  } catch (e) {
    showMsg(msgNode, e.code === 'OFFLINE' ? 'Jarvis is not running' : errorText(e.code));
    onError?.(e.code);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function runQuick(q, button) {
  startJob({ accountId: S.selected, quickCommandId: q.id }, $('skillsMsg'), button);
}

$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('askInput');
  const prompt = input.value.trim();
  if (!prompt) return;
  const accountId = S.selected;
  const last = S.lastProject[accountId];
  const info = await startJob(
    { accountId, projectPath: last ?? undefined, useHome: !last, prompt },
    $('askMsg'),
    null,
    (code) => { if (last) forgetProject(accountId, code); },
  );
  if (info) input.value = '';
});

// ---------- new-terminal picker ----------
function closePicker() {
  $('picker').hidden = true;
  $('newTerm').setAttribute('aria-expanded', 'false');
}
function openPicker() {
  const acc = selectedAccount();
  if (!acc) return;
  const list = $('pickerList');
  list.replaceChildren();
  showMsg($('pickerMsg'), '');
  $('pickerH').textContent = `${look(acc).display} · φάκελος`;
  const pick = async (projectPath) => {
    const info = await startJob(
      projectPath ? { accountId: acc.id, projectPath } : { accountId: acc.id, useHome: true },
      $('pickerMsg'),
      null,
      (code) => { if (projectPath && S.lastProject[acc.id] === projectPath) forgetProject(acc.id, code); },
    );
    if (!info) return;
    if (projectPath) S.lastProject[acc.id] = projectPath;
    else delete S.lastProject[acc.id];
    store.set('jarvis.lastProject', S.lastProject);
    closePicker();
  };
  // Mirrors the server's side rule: an account may only open projects of its own side.
  for (const p of S.projects.filter((pr) => pr.side === acc.side)) {
    list.append(el('button', { type: 'button', onclick: () => pick(p.path) }, p.name, el('small', { text: p.path })));
  }
  list.append(el('button', { type: 'button', onclick: () => pick(null) }, 'Home folder', el('small', { text: 'φάκελος του λογαριασμού' })));
  $('picker').hidden = false;
  $('newTerm').setAttribute('aria-expanded', 'true');
  list.querySelector('button')?.focus();
}
$('newTerm').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('picker').hidden) openPicker(); else closePicker();
});
$('picker').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closePicker);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

// ---------- jobs: dock, drawer, terminals ----------
const panes = new Map(); // jobId -> { node, term, fit, header refs }
const visibleJobs = () => S.jobs;
const dockOpen = () => $('dock').classList.contains('open');

function upsertJob(info) {
  const i = S.jobs.findIndex((j) => j.id === info.id);
  if (i === -1) S.jobs.push(info); else S.jobs[i] = { ...S.jobs[i], ...info };
  renderJobs();
}

function setDock(open) {
  $('dock').classList.toggle('open', open);
  $('ttCount').textContent = `${visibleJobs().length} open ${open ? 'v' : '^'}`;
  if (open) requestAnimationFrame(fitAll);
}
$('tt').addEventListener('click', () => setDock(!dockOpen()));
$('openTerms').addEventListener('click', () => setDock(true));

function focusJob(id, open = false) {
  S.focused = id;
  if (open) setDock(true);
  renderJobs();
  const pane = panes.get(id);
  if (pane && dockOpen()) {
    pane.node.scrollIntoView({ block: 'nearest' });
    pane.term?.focus();
  }
}

function sendWs(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function createPane(job) {
  const acc = account(job.accountId);
  const color = safeColor(acc?.color);
  const title = el('b');
  const stateEl = el('em');
  const close = el('button', { type: 'button', 'aria-label': 'Κλείσιμο', text: '✕' });
  const host = el('div', { class: 'xt' });
  const node = el('div', { class: 'term', style: { '--c': color } },
    el('header', {}, title, el('span', { class: 'r' }, el('span', { text: acc ? look(acc).display : job.accountId }), stateEl, close)),
    host);
  node.addEventListener('mousedown', () => { if (S.focused !== job.id) focusJob(job.id); });
  close.addEventListener('click', () => closeJob(job.id));

  let term = null;
  let fit = null;
  if (typeof window.Terminal === 'function') {
    term = new window.Terminal({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0b0a0c', foreground: '#d6d0d9', cursor: color, selectionBackground: '#3a3440' },
    });
    if (window.FitAddon?.FitAddon) {
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open(host);
    term.onData((data) => sendWs({ type: 'input', id: job.id, data }));
    term.onResize(({ cols, rows }) => sendWs({ type: 'resize', id: job.id, cols, rows }));
  } else {
    host.textContent = 'xterm.js failed to load';
  }
  const pane = { node, term, fit, title, stateEl, attached: false };
  panes.set(job.id, pane);
  return pane;
}

function attachPane(id) {
  const pane = panes.get(id);
  if (!pane || ws?.readyState !== WebSocket.OPEN) return;
  pane.attached = true;
  sendWs({ type: 'attach', id });
}

function fitAll() {
  if (!dockOpen()) return;
  for (const [id, pane] of panes) {
    if (!pane.fit || !pane.node.isConnected) continue;
    try { pane.fit.fit(); } catch { /* not laid out yet */ }
    if (pane.term) sendWs({ type: 'resize', id, cols: pane.term.cols, rows: pane.term.rows });
  }
}
let fitTimer = 0;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitAll, 120); });

function closeJob(id) {
  const job = S.jobs.find((j) => j.id === id);
  if (!job) return;
  const live = job.state === 'working' || job.state === 'idle';
  if (live && !confirm(`Τερματισμός του "${job.title}";`)) return;
  // The server drops the job (and frees its console) on kill, finished or not; the next jobs list removes the pane.
  sendWs({ type: 'kill', id });
}

function renderJobs() {
  const jobs = visibleJobs();
  if (S.focused && !jobs.some((j) => j.id === S.focused)) S.focused = null;
  if (!S.focused && jobs.length) S.focused = jobs[jobs.length - 1].id;

  // tabs
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const job of jobs) {
    const acc = account(job.accountId);
    tabs.append(el('button', {
      type: 'button',
      class: `tab${job.id === S.focused ? ' focus' : ''}`,
      style: { '--c': safeColor(acc?.color) },
      title: job.cwd,
      onclick: () => focusJob(job.id, true),
    }, el('i'), el('b', { text: job.title }), el('small', { text: STATE_LABEL[job.state] ?? job.state })));
  }
  $('ttCount').textContent = `${jobs.length} open ${dockOpen() ? 'v' : '^'}`;

  // panes (kept alive across renders so xterm keeps its buffer)
  const drawer = $('drawer');
  let added = false;
  for (const job of jobs) {
    let pane = panes.get(job.id);
    if (!pane) {
      pane = createPane(job);
      drawer.append(pane.node);
      attachPane(job.id);
      added = true;
    }
    pane.title.textContent = job.title;
    pane.stateEl.textContent = STATE_LABEL[job.state] ?? job.state;
    pane.node.classList.toggle('focus', job.id === S.focused);
  }
  for (const [id, pane] of panes) {
    if (!jobs.some((j) => j.id === id)) {
      pane.term?.dispose();
      pane.node.remove();
      panes.delete(id);
    }
  }
  drawer.style.setProperty('--cols', String(Math.max(1, Math.min(3, jobs.length))));
  if (added) requestAnimationFrame(fitAll);
  renderStates();
}

function renderStates() {
  const job = S.jobs.find((j) => j.id === S.focused);
  const state = job?.state ?? 'idle';
  for (const s of $('states').querySelectorAll('span')) s.classList.toggle('on', s.dataset.s === state);
  $('st').textContent = STATE_LABEL[state] ?? state;
  $('ready').textContent = job ? `${job.title} · ${STATE_LABEL[state] ?? state}` : 'Ready · idle';
}

// ---------- WebSocket with reconnect ----------
let ws = null;
let backoff = 500;
let reconnectTimer = 0;

function setDown(down) {
  $('down').hidden = !down;
  $('conn').textContent = down ? 'Offline' : (ws?.readyState === WebSocket.OPEN ? 'Connected' : 'Connecting…');
}

function onMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  switch (msg?.type) {
    case 'jobs':
      if (Array.isArray(msg.list)) { S.jobs = msg.list; renderJobs(); }
      break;
    case 'usage':
      if (msg.usage && typeof msg.usage === 'object') { S.usage = msg.usage; renderVitals(); }
      break;
    case 'directives':
      if (Array.isArray(msg.list)) { S.directives = msg.list; renderDirectives(); }
      break;
    case 'scrollback': {
      const pane = panes.get(msg.id);
      if (pane?.term && typeof msg.data === 'string') {
        pane.term.reset();
        pane.term.write(msg.data);
      }
      break;
    }
    case 'data': {
      const pane = panes.get(msg.id);
      if (pane?.term && typeof msg.data === 'string') pane.term.write(msg.data);
      break;
    }
    default:
      break;
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws = sock;
  sock.addEventListener('open', () => {
    backoff = 500;
    setDown(false);
    for (const id of panes.keys()) attachPane(id); // live data only flows to attached sockets
    fitAll();
  });
  sock.addEventListener('message', onMessage);
  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    $('conn').textContent = 'Reconnecting…';
    scheduleReconnect();
  });
}

async function scheduleReconnect() {
  // Is the server there at all, and is it still the one that issued our token?
  let alive = false;
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    alive = r.ok && (await r.text()) === 'jarvis';
  } catch { alive = false; }
  if (alive) {
    try {
      await api('GET', '/api/state');
    } catch (e) {
      if (e.status === 403) { location.reload(); return; } // restarted server: new token in a fresh page
    }
  }
  setDown(!alive);
  // Server is up: reconnect promptly. Server is gone: keep probing with growing gaps.
  reconnectTimer = setTimeout(alive ? connect : scheduleReconnect, alive ? Math.min(backoff, 1000) : backoff);
  backoff = Math.min(backoff * 2, 10000);
}

// ---------- header ----------
function tick() {
  const d = new Date();
  $('clk').textContent = d.toTimeString().slice(0, 5);
  $('day').textContent = DAYS[d.getDay()];
}
tick();
setInterval(tick, 10000);

$('shutdown').addEventListener('click', async () => {
  if (!confirm('Σταματάνε όλες οι δουλειές. Συνέχεια;')) return;
  try { await api('POST', '/api/shutdown'); } catch { /* already gone */ }
  setDown(true);
});

// ---------- boot ----------
async function boot() {
  let state;
  try {
    state = await api('GET', '/api/state');
  } catch {
    setDown(true);
    reconnectTimer = setTimeout(() => { boot(); }, backoff);
    backoff = Math.min(backoff * 2, 10000);
    return;
  }
  S.accounts = Array.isArray(state.accounts) ? state.accounts : [];
  S.projects = Array.isArray(state.projects) ? state.projects : [];
  S.quickCommands = Array.isArray(state.quickCommands) ? state.quickCommands : [];
  S.jobs = Array.isArray(state.jobs) ? state.jobs : [];
  S.usage = state.usage && typeof state.usage === 'object' ? state.usage : {};
  S.directives = Array.isArray(state.directives) ? state.directives : [];

  if (!account(S.selected)) S.selected = (S.accounts.find((a) => a.enabled) ?? S.accounts[0])?.id ?? 'claude';
  renderSwitcher();
  select(S.selected);
  renderVitals();
  renderDirectives();
  renderSkills();
  setDown(false);
  connect();
  renderJobs();
}
boot();
