// Jarvis HUD: wires the mockup layout to /api/state and the /ws socket.
// Everything from the server is data: it only ever reaches the DOM via textContent.
import { createOrb } from './orb.js';
import { createDictation, appendSpeech } from './voice.js';
import { h as el, createChatPane, fmtAgo } from './chat.js';

const TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content ?? '';
const $ = (id) => document.getElementById(id);

// Display copy per account (from the mockup).
const LOOK = {
  work: { name: 'Codex', display: 'Codex Δουλειά', mode: 'Codex mode · λογαριασμός δουλειάς', card: 'Codex δουλειά · weekly usage' },
  mine: { name: 'Codex', display: 'Codex Δικό μου', mode: 'Codex mode · προσωπικός λογαριασμός', card: 'Codex δικό μου · weekly usage' },
  claude: { name: 'Claude', display: 'Claude Code', mode: 'Original Jarvis core · Claude Code mode', card: 'Claude · weekly usage' },
  gemini: { name: 'Gemini', display: 'Gemini', mode: 'Gemini mode · Antigravity CLI', card: 'Gemini · weekly usage' },
};
const look = (acc) => LOOK[acc.id] ?? {
  name: acc.label.toUpperCase(), display: acc.label, mode: `${acc.label} mode`, card: `${acc.label} · weekly usage`,
};

const ERRORS = {
  NO_HOME: 'Ορίσε φάκελο για αυτόν τον λογαριασμό στο jarvis.config.json',
  SIDE_MISMATCH: 'Αυτό το project δεν επιτρέπεται με αυτόν τον λογαριασμό',
  UNKNOWN_PROJECT: 'Αυτό το project δεν υπάρχει πια στο jarvis.config.json',
  DISABLED: 'Ο λογαριασμός δεν έχει ρυθμιστεί ακόμα',
  NO_SUCH_HISTORY: 'Αυτή η συζήτηση δεν βρέθηκε σε αυτόν τον φάκελο',
  CHAT_UNSUPPORTED: 'Αυτός ο λογαριασμός δουλεύει μόνο σε terminal',
  START_FAILED: 'Η συζήτηση δεν ξεκίνησε· δες ότι το CLI είναι εγκατεστημένο και συνδεδεμένο',
  HISTORY_UNAVAILABLE: 'Το ιστορικό δεν είναι διαθέσιμο αυτή τη στιγμή',
};
const errorText = (code) => ERRORS[code] ?? `Κάτι πήγε στραβά (${code})`;
const STATE_LABEL = { idle: 'Idle', working: 'Working', waiting: 'Περιμένει εσένα', done: 'Done', error: 'Error' };
const DAYS = ['ΚΥΡ', 'ΔΕΥ', 'ΤΡΙ', 'ΤΕΤ', 'ΠΕΜ', 'ΠΑΡ', 'ΣΑΒ'];

// ---------- small helpers ----------
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
  return d.getTime() - Date.now() < 20 * 3600e3 ? hm : `${DAYS[d.getDay()]} ${hm}`;
}
const WEEKDAYS = ['Κυρ', 'Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ'];
// "updated 14:05" today, "updated Δευ 14:05" on another day; '' when unknown.
function fmtUpdated(iso, label) {
  const d = new Date(iso);
  if (iso == null || Number.isNaN(d.getTime())) return '';
  const hm = d.toTimeString().slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? `${label} ${hm}` : `${label} ${WEEKDAYS[d.getDay()]} ${hm}`;
}
const updatedText = (view, label = 'updated') => (view && view.kind !== 'none' ? fmtUpdated(view.updatedAt, label) : '');
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
  chats: [],
  usage: {},
  directives: [],
  selected: store.get('jarvis.account', 'claude'),
  lastProject: store.get('jarvis.lastProject', {}),
  focused: null,
};
const account = (id) => S.accounts.find((a) => a.id === id);
const selectedAccount = () => account(S.selected);
const canChat = (acc) => acc?.chat === true;

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
const orb = createOrb($('orb'), { shape: S.selected, pauseButton: $('pause') });

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
  svg.setAttribute('aria-hidden', 'true');
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

const usageStatus = { low: 'Άνετα', medium: 'Πρόσεχε', high: 'Σχεδόν τέλος' };
const usageLevel = (used) => used >= 85 ? 'high' : used >= 60 ? 'medium' : 'low';
const LEVEL_COLOR = { low: '#30d158', medium: '#ff9f0a', high: '#ff453a' };

function activityRings({ name, wUsed, fUsed, wColor, fColor, wRemaining, fRemaining }) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.setAttribute('width', '48');
  svg.setAttribute('height', '48');
  svg.setAttribute('class', 'vital-rings');
  svg.setAttribute('aria-hidden', 'false');

  const g = document.createElementNS(NS, 'g');
  g.setAttribute('transform', 'rotate(-90 26 26)');

  const c1 = 2 * Math.PI * 21; // ~131.95
  const c2 = 2 * Math.PI * 14; // ~87.96

  // Outer track (Εβδομάδα)
  const t1 = document.createElementNS(NS, 'circle');
  t1.setAttribute('cx', '26');
  t1.setAttribute('cy', '26');
  t1.setAttribute('r', '21');
  t1.setAttribute('fill', 'none');
  t1.setAttribute('stroke', 'rgba(255, 255, 255, 0.08)');
  t1.setAttribute('stroke-width', '4.5');

  // Inner track (5 ώρες)
  const t2 = document.createElementNS(NS, 'circle');
  t2.setAttribute('cx', '26');
  t2.setAttribute('cy', '26');
  t2.setAttribute('r', '14');
  t2.setAttribute('fill', 'none');
  t2.setAttribute('stroke', 'rgba(255, 255, 255, 0.08)');
  t2.setAttribute('stroke-width', '4.5');

  g.append(t1, t2);

  // Outer progress
  const p1 = document.createElementNS(NS, 'circle');
  p1.setAttribute('cx', '26');
  p1.setAttribute('cy', '26');
  p1.setAttribute('r', '21');
  p1.setAttribute('fill', 'none');
  p1.setAttribute('stroke', wUsed > 0 ? wColor : 'transparent');
  p1.setAttribute('stroke-width', '4.5');
  p1.setAttribute('stroke-linecap', 'round');
  p1.setAttribute('stroke-dasharray', `${c1.toFixed(2)} ${c1.toFixed(2)}`);
  const off1 = Math.max(0, c1 * (1 - Math.min(100, Math.max(0, wUsed)) / 100));
  p1.setAttribute('stroke-dashoffset', off1.toFixed(2));
  p1.setAttribute('role', 'progressbar');
  p1.setAttribute('aria-label', `${name} · Εβδομάδα · ποσοστό χρήσης`);
  p1.setAttribute('aria-valuemin', '0');
  p1.setAttribute('aria-valuemax', '100');
  p1.setAttribute('aria-valuenow', String(Math.round(wUsed)));
  p1.setAttribute('aria-valuetext', wRemaining);

  // Inner progress
  const p2 = document.createElementNS(NS, 'circle');
  p2.setAttribute('cx', '26');
  p2.setAttribute('cy', '26');
  p2.setAttribute('r', '14');
  p2.setAttribute('fill', 'none');
  p2.setAttribute('stroke', fUsed > 0 ? fColor : 'transparent');
  p2.setAttribute('stroke-width', '4.5');
  p2.setAttribute('stroke-linecap', 'round');
  p2.setAttribute('stroke-dasharray', `${c2.toFixed(2)} ${c2.toFixed(2)}`);
  const off2 = Math.max(0, c2 * (1 - Math.min(100, Math.max(0, fUsed)) / 100));
  p2.setAttribute('stroke-dashoffset', off2.toFixed(2));
  p2.setAttribute('role', 'progressbar');
  p2.setAttribute('aria-label', `${name} · 5 ώρες · ποσοστό χρήσης`);
  p2.setAttribute('aria-valuemin', '0');
  p2.setAttribute('aria-valuemax', '100');
  p2.setAttribute('aria-valuenow', String(Math.round(fUsed)));
  p2.setAttribute('aria-valuetext', fRemaining);

  g.append(p1, p2);
  svg.append(g);
  return svg;
}

function usageBar(name, label, used, resetsAt) {
  const remaining = `Μένει ${fmtPct(100 - used)}%`;
  const resetTime = resetsAt && fmtReset(resetsAt);
  return el('div', { class: 'vital-period' },
    el('div', { class: 'vital-row' }, el('span', { text: label }), el('strong', { text: remaining })),
    el('div', {
      class: 'vital-track', 'data-level': usageLevel(used), style: { '--used': `${used}%` },
      role: 'progressbar', 'aria-label': `${name} · ${label} · ποσοστό χρήσης`,
      'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': used, 'aria-valuetext': remaining,
    }),
    resetTime ? el('small', { text: `μηδενίζεται ${resetTime}` }) : null);
}

function renderVitals() {
  const box = $('vitals');
  box.replaceChildren();
  let latestUpdated = null;

  for (const acc of S.accounts) {
    const color = safeColor(acc.color);
    const view = S.usage[acc.id];
    const name = look(acc).display;

    if (view && view.kind !== 'none' && view.updatedAt) {
      const t = new Date(view.updatedAt).getTime();
      if (Number.isFinite(t) && (!latestUpdated || t > new Date(latestUpdated).getTime())) {
        latestUpdated = view.updatedAt;
      }
    }

    const vital = el('div', { class: 'vital', style: { '--c': color } });
    if (view?.kind === 'percent') {
      const wPeriod = view.weekly;
      const fPeriod = view.fiveHour;
      const wUsed = wPeriod?.reset ? 0 : Math.max(0, Math.min(100, Number.isFinite(wPeriod?.pct) ? wPeriod.pct : 0));
      const fUsed = fPeriod?.reset ? 0 : Math.max(0, Math.min(100, Number.isFinite(fPeriod?.pct) ? fPeriod.pct : 0));
      const wLevel = usageLevel(wUsed);
      const fLevel = usageLevel(fUsed);
      const peak = Math.max(Number.isFinite(wPeriod?.pct) ? wUsed : 0, Number.isFinite(fPeriod?.pct) ? fUsed : 0);
      const peakLevel = usageLevel(peak);
      const statusWord = usageStatus[peakLevel];

      const wReset = wPeriod?.resetsAt ? fmtReset(wPeriod.resetsAt) : '';
      const fReset = fPeriod?.resetsAt ? fmtReset(fPeriod.resetsAt) : '';
      const wRemaining = Number.isFinite(wPeriod?.pct) || wPeriod?.reset ? `Μένει ${fmtPct(100 - wUsed)}%` : '—';
      const fRemaining = Number.isFinite(fPeriod?.pct) || fPeriod?.reset ? `Μένει ${fmtPct(100 - fUsed)}%` : '—';
      const wLine = `Εβδομάδα · ${wRemaining}${wReset ? ` · ${wReset}` : ''}`;
      const fLine = `5 ώρες · ${fRemaining}${fReset ? ` · ${fReset}` : ''}`;

      const rings = activityRings({
        name,
        wUsed,
        fUsed,
        wColor: LEVEL_COLOR[wLevel],
        fColor: LEVEL_COLOR[fLevel],
        wRemaining,
        fRemaining,
      });

      const header = el('div', { class: 'vital-ring-header' },
        el('strong', { text: name }),
        statusWord ? el('span', { class: 'vital-status', 'data-level': peakLevel, text: statusWord }) : null
      );
      const lines = el('div', { class: 'vital-ring-lines' },
        el('div', { class: 'vital-ring-sub' }, wLine),
        el('div', { class: 'vital-ring-sub' }, fLine)
      );
      const body = el('div', { class: 'vital-ring-body' }, header, lines);
      const row = el('div', { class: 'vital-ring-row' }, rings, body);
      vital.append(row);
    } else if (view?.kind === 'tokens') {
      const header = el('div', { class: 'vital-row vital-header' }, el('strong', { text: name }));
      vital.append(header, el('div', { class: 'big' }, fmtTokens(view.weekly?.tokens), el('small', { text: 'tokens / 7 μέρες' })));
    } else {
      continue; // no usage data for this account: leave it out
    }
    box.append(vital);
  }

  if (latestUpdated) {
    const upd = fmtUpdated(latestUpdated, 'Ενημέρωση');
    if (upd) box.append(el('div', { class: 'vitals-foot', text: upd }));
  }

  renderCard();
}

function renderCard() {
  const acc = selectedAccount();
  if (!acc || !$('cardT')) return; // the usage card was removed from the page
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
  if (!ul) return; // the Directives card was removed from the page
  ul.replaceChildren();
  const list = S.directives.slice(0, 3);
  if (!list.length) ul.append(el('li', { class: 'empty', text: 'Κανένα directive στο today.md' }));
  for (const d of list) ul.append(el('li', { class: d.done ? 'done' : '', text: d.text }));
}

// ---------- SiteWatch (the user's monitored websites) ----------
const SW_NOTE = {
  loading: 'Φόρτωση…',
  'no-token': 'Λείπει το κλειδί του SiteWatch.',
  'bad-token': 'Το κλειδί δεν ταιριάζει με το SiteWatch.',
  disabled: 'Το SiteWatch δεν έχει ακόμα ενεργό κλειδί.',
  error: 'Το SiteWatch δεν απαντάει τώρα.',
};
const swMs = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '—');
const swPct = (v) => (Number.isFinite(v) ? `${v.toFixed(v >= 99.95 ? 0 : 1)}%` : '—');
let refreshingSites = false;
async function retrySites() {
  if (refreshingSites || !S.sitewatch || ['off', 'ok'].includes(S.sitewatch.state)) return;
  refreshingSites = true;
  renderSites();
  try {
    S.sitewatch = await api('POST', '/api/sitewatch/refresh');
  } catch { /* Keep the current status so the user can retry. */ }
  finally {
    refreshingSites = false;
    renderSites();
  }
}
window.addEventListener('focus', retrySites);
document.addEventListener('visibilitychange', () => { if (!document.hidden) retrySites(); });

function renderSites() {
  const sw = S.sitewatch ?? { state: 'off' };
  $('sw').hidden = sw.state === 'off';
  const box = $('sites');
  box.replaceChildren();
  if (sw.state === 'off') return;
  if (sw.state !== 'ok') {
    const note = refreshingSites ? SW_NOTE.loading : (SW_NOTE[sw.state] ?? SW_NOTE.error);
    box.append(el('p', { class: 'sw-note' }, note, ' ',
      el('button', { class: 'pill', type: 'button', disabled: refreshingSites, onclick: retrySites, text: 'Δοκίμασε ξανά' })));
    return;
  }
  if (!sw.monitors.length) { box.append(el('p', { class: 'sw-note', text: 'Δεν υπάρχουν sites στο SiteWatch.' })); return; }
  for (const m of sw.monitors) {
    const status = ['up', 'degraded', 'down'].includes(m.status) ? m.status : 'unknown';
    const ssl = Number.isFinite(m.ssl_days_remaining) ? `SSL ${m.ssl_days_remaining} ημ.` : 'SSL —';
    const ms = m.response_time_ms;
    const speed = !Number.isFinite(ms) ? '' : ms < 800 ? 'speed-fast' : ms < 1500 ? 'speed-med' : 'speed-slow';
    box.append(el('div', { class: `site s-${status}`, title: `${m.host ?? ''} · ${status}` },
      el('div', { class: 'site-top' },
        el('i', { class: 'site-dot', 'aria-hidden': 'true' }),
        el('b', { text: m.name ?? m.host ?? '—' }),
        el('span', { class: `site-ms ${speed}`.trim(), text: swMs(ms) })),
      el('div', { class: 'site-sub', text: `διάμεσος ${swMs(m.median_response_ms)} · διαθ. ${swPct(m.uptime_percentage)} · ${ssl}` })));
  }
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

// kind 'chat' -> a conversation (POST /api/chats); 'terminal' -> a terminal job (POST /api/jobs).
// The user chose terminals only, so Skills and Ask always open a terminal.
const kindFor = () => 'terminal';

async function startSession(kind, body, msgNode, button, onError) {
  showMsg(msgNode, '');
  if (button) button.disabled = true;
  try {
    const info = await api('POST', kind === 'chat' ? '/api/chats' : '/api/jobs', body);
    if (kind === 'chat') upsertChat(info); else upsertJob(info);
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
  startSession(kindFor(selectedAccount()), { accountId: S.selected, quickCommandId: q.id }, $('skillsMsg'), button);
}

$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('askInput');
  const prompt = input.value.trim();
  if (!prompt) return;
  const accountId = S.selected;
  const last = S.lastProject[accountId];
  const info = await startSession(
    kindFor(account(accountId)),
    { accountId, projectPath: last ?? undefined, useHome: !last, prompt },
    $('askMsg'),
    null,
    (code) => { if (last) forgetProject(accountId, code); },
  );
  if (info) input.value = '';
});

// ---------- "+ Νέα συζήτηση" picker: mode, folder, past conversations ----------
const P = { mode: 'terminal', folder: null, seq: 0 }; // Terminal is the default every time the picker opens

function closePicker() {
  $('picker').hidden = true;
  $('newTerm').setAttribute('aria-expanded', 'false');
}

async function pick(kind, projectPath, resumeId, button) {
  const acc = selectedAccount();
  if (!acc) return;
  const body = projectPath ? { accountId: acc.id, projectPath } : { accountId: acc.id, useHome: true };
  if (resumeId) body.resumeId = resumeId;
  const info = await startSession(kind, body, $('pickerMsg'), button,
    (code) => { if (projectPath && S.lastProject[acc.id] === projectPath) forgetProject(acc.id, code); });
  if (!info) return;
  if (projectPath) S.lastProject[acc.id] = projectPath;
  else delete S.lastProject[acc.id];
  store.set('jarvis.lastProject', S.lastProject);
  closePicker();
}

async function loadHistory(acc, folder, box) {
  const seq = ++P.seq;
  const q = new URLSearchParams({ accountId: acc.id });
  if (folder) q.set('projectPath', folder); else q.set('useHome', '1');
  let list;
  try {
    list = await api('GET', `/api/chat-history?${q}`);
  } catch (e) {
    if (seq === P.seq) box.replaceChildren(el('p', { class: 'pk-empty', text: errorText(e.code) }));
    return;
  }
  if (seq !== P.seq) return; // the user picked another folder meanwhile
  box.replaceChildren();
  const items = (Array.isArray(list) ? list : [])
    .filter((it) => it && typeof it.externalId === 'string')
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, 30);
  if (!items.length) box.append(el('p', { class: 'pk-empty', text: 'Καμία προηγούμενη συζήτηση εδώ' }));
  for (const it of items) {
    const title = String(it.title || '(χωρίς τίτλο)');
    box.append(el('button', { type: 'button', title, onclick: (e) => pick('chat', folder, it.externalId, e.currentTarget) },
      title, el('small', { text: fmtAgo(it.updatedAt) })));
  }
}

function renderPicker() {
  const acc = selectedAccount();
  if (!acc) return;
  // The user chose terminals only: the Chat/Terminal switch is hidden and Chat is never picked.
  P.mode = 'terminal';
  const chat = false;
  $('pickerMode').hidden = true;
  for (const b of $('pickerMode').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === (chat ? 'chat' : 'terminal')));
  }
  $('pickerH').textContent = `${look(acc).display} · ${chat ? 'νέα συζήτηση' : 'νέο terminal'}`;
  const list = $('pickerList');
  list.replaceChildren();
  // Mirrors the server's side rule: an account may only open projects of its own side.
  const folders = [
    ...S.projects.filter((pr) => pr.side === acc.side).map((p) => ({ path: p.path, name: p.name, sub: p.path })),
    { path: null, name: 'Home folder', sub: 'φάκελος του λογαριασμού' },
  ];
  for (const f of folders) {
    const sel = chat && f.path === P.folder;
    list.append(el('button', {
      type: 'button',
      class: sel ? 'sel' : '',
      'aria-pressed': chat ? String(sel) : null,
      onclick: (e) => {
        if (!chat) { pick('terminal', f.path, undefined, e.currentTarget); return; }
        P.folder = f.path;
        renderPicker();
      },
    }, f.name, el('small', { text: f.sub })));
  }
  const hist = $('pickerHistory');
  hist.replaceChildren();
  if (chat) {
    const box = el('div', {}, el('p', { class: 'pk-empty', text: 'φόρτωση…' }));
    hist.append(
      el('button', { type: 'button', class: 'pk-go', onclick: (e) => pick('chat', P.folder, undefined, e.currentTarget) }, 'Ξεκίνα συζήτηση →'),
      el('p', { class: 'pk-sub', text: 'Συνέχεια συζήτησης' }),
      box,
    );
    loadHistory(acc, P.folder, box);
  } else {
    P.seq++;
  }
}

function openPicker() {
  const acc = selectedAccount();
  if (!acc) return;
  showMsg($('pickerMsg'), '');
  P.mode = 'terminal';
  const last = S.lastProject[acc.id];
  P.folder = last && S.projects.some((p) => p.path === last && p.side === acc.side) ? last : null;
  renderPicker();
  $('picker').hidden = false;
  $('newTerm').setAttribute('aria-expanded', 'true');
  $('picker').querySelector('#pickerList button')?.focus();
}
for (const b of $('pickerMode').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    P.mode = b.dataset.mode === 'terminal' ? 'terminal' : 'chat';
    showMsg($('pickerMsg'), '');
    renderPicker();
  });
}
$('newTerm').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('picker').hidden) openPicker(); else closePicker();
});
$('picker').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closePicker);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closePicker();
  if (maximizedId && !e.defaultPrevented && !e.target.closest?.('.xterm')) toggleMaximized(maximizedId);
});

// ---------- sessions (terminal jobs + chats): dock, drawer, panes ----------
const panes = new Map(); // id -> terminal pane { kind:'terminal', node, term, fit, ... } | chat pane { kind:'chat', view, node }
const voice = createDictation(() => panes.get(S.focused)?.mic ?? askMic);
const askMic = voice.button(text => {
  const input = $('askInput');
  input.value = appendSpeech(input.value, text);
});
if (askMic) $('askInput').after(askMic);
let maximizedId = null;
// Terminals and chats share one dock, oldest first.
const visibleJobs = () => [
  ...S.jobs.map((j) => ({ kind: 'terminal', id: j.id, accountId: j.accountId, title: j.title, state: j.state, cwd: j.cwd, t: Number(j.startedAt) || 0, info: j })),
  ...S.chats.map((c) => ({ kind: 'chat', id: c.id, accountId: c.accountId, title: c.title, state: c.state, cwd: c.cwd, t: Date.parse(c.createdAt) || 0, info: c })),
].sort((a, b) => a.t - b.t);
const dockOpen = () => $('dock').classList.contains('open');

function upsertJob(info) {
  const i = S.jobs.findIndex((j) => j.id === info.id);
  if (i === -1) S.jobs.push(info); else S.jobs[i] = { ...S.jobs[i], ...info };
  renderJobs();
}
function upsertChat(info) {
  const i = S.chats.findIndex((c) => c.id === info.id);
  if (i === -1) S.chats.push(info); else S.chats[i] = { ...S.chats[i], ...info };
  renderJobs();
}

function setDock(open) {
  $('dock').classList.toggle('open', open);
  $('ttCount').textContent = `${visibleJobs().length} open ${open ? 'v' : '^'}`;
  if (open) requestAnimationFrame(fitAll);
}
$('tt').addEventListener('click', () => setDock(!dockOpen()));
$('openTerms').addEventListener('click', () => setDock(true));

function selectJob(id) {
  S.focused = id;
  if (maximizedId) maximizedId = id;
  renderJobs();
}

function focusJob(id, open = false) {
  if (open) setDock(true);
  selectJob(id);
  const pane = panes.get(id);
  if (pane && dockOpen()) {
    pane.node.scrollIntoView({ block: 'nearest' });
    if (pane.kind === 'chat') pane.view.focus();
    else {
      pane.activate();
      pane.term?.focus();
    }
  }
}

function toggleMaximized(id) {
  maximizedId = maximizedId === id ? null : id;
  selectJob(id);
  const pane = panes.get(id);
  pane.maximize.focus({ preventScroll: true });
  if (!maximizedId) pane.node.scrollIntoView({ block: 'nearest' });
  requestAnimationFrame(fitAll);
}

function sendWs(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function terminalComposer(sendInput) {
  const input = el('textarea', { rows: 1, 'aria-label': 'Κείμενο για το τερματικό', placeholder: 'Γράψε εδώ…', enterkeyhint: 'send' });
  function grow() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 2 + 'px';
    requestAnimationFrame(fitAll);
  }
  const mic = voice.button(text => {
    input.value = appendSpeech(input.value, text);
    grow();
  });
  let submitting = false;
  function submit() {
    if (submitting || ws?.readyState !== WebSocket.OPEN) return;
    submitting = true;
    const socket = ws;
    if (input.value) sendInput(input.value);
    input.value = '';
    grow();
    setTimeout(() => {
      if (ws === socket && input.isConnected) sendInput('\r');
      submitting = false;
    }, 100);
  }
  input.addEventListener('input', grow);
  let shiftEnter = false;
  input.addEventListener('keydown', e => {
    shiftEnter = e.key === 'Enter' && e.shiftKey;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!e.repeat) submit();
    }
  });
  input.addEventListener('keyup', () => { shiftEnter = false; });
  input.addEventListener('blur', () => { shiftEnter = false; });
  // Some soft keyboards report only the text-editing event for Enter.
  input.addEventListener('beforeinput', e => {
    if (e.inputType === 'insertLineBreak' && e.cancelable && !e.isComposing && !shiftEnter) {
      e.preventDefault();
      submit();
    }
  });
  const send = el('button', { type: 'button', text: 'Αποστολή', 'aria-label': 'Αποστολή', onclick: submit });
  const keys = [['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Ctrl+C', '\x03']];
  const bar = el('div', { class: 'term-compose' }, el('div', {}, input, mic, send),
    el('div', {}, ...keys.map(([text, data]) => el('button', { type: 'button', text, onclick: () => sendInput(data) }))));
  return { bar, mic };
}

function createPane(job, maximize) {
  const acc = account(job.accountId);
  const color = safeColor(acc?.color);
  const rgb = hexRgb(color).join(',');
  const title = el('b');
  const stateEl = el('em', { class: 'chip' });
  const close = el('button', { type: 'button', class: 'x', 'aria-label': 'Κλείσιμο', text: '✕' });
  const attach = el('button', { type: 'button', class: 'x', 'aria-label': 'Επισύναψη αρχείου', title: 'Επισύναψη εικόνας ή αρχείου', text: '📎' });
  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  const host = el('div', { class: 'xt' });
  const sendInput = data => sendWs({ type: 'input', id: job.id, data });
  const composer = window.matchMedia('(pointer: coarse)').matches ? terminalComposer(sendInput) : null;
  const mic = composer ? composer.mic : voice.button((text, continued) => sendInput((continued ? ' ' : '') + text));
  const node = el('div', { class: 'term', style: { '--c': color, '--c-rgb': rgb } },
    el('header', {},
      el('span', { class: 'l' }, el('i', { class: 'dot', 'aria-hidden': 'true' }), title),
      el('span', { class: 'r' }, el('span', { class: 'who', text: acc ? look(acc).display : job.accountId }), stateEl, attach, !composer && mic, maximize, close, picker)),
    el('div', { class: 'beam', 'aria-hidden': 'true' }),
    host, composer?.bar);
  node.addEventListener('mousedown', () => { if (!composer && S.focused !== job.id) focusJob(job.id); });
  close.addEventListener('click', () => closeSession(job.id));

  let term = null;
  let fit = null;
  if (typeof window.Terminal === 'function') {
    term = new window.Terminal({
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: window.matchMedia('(max-width: 520px)').matches ? 12 : 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 5000,
      allowTransparency: true,
      theme: {
        // The host supplies the opaque terminal surface, including its padding.
        background: 'rgba(0,0,0,0)',
        foreground: '#eeeef4',
        cursor: color,
        cursorAccent: '#0f0d10',
        selectionBackground: `rgba(${rgb},0.30)`,
        black: '#1a1a22', brightBlack: '#9696a5',
        red: '#ff6b8a', brightRed: '#ff8fa6',
        green: '#62d49d', brightGreen: '#86e3b4',
        yellow: '#f2c66d', brightYellow: '#f7d78f',
        blue: '#6f9bff', brightBlue: '#93b4ff',
        magenta: '#e874bf', brightMagenta: '#ee8bb8',
        cyan: '#6fd6e8', brightCyan: '#9be5f0',
        white: '#d6d0d9', brightWhite: '#f4f0f5',
      },
    });
    if (window.FitAddon?.FitAddon) {
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open(host);
    if (composer && term.textarea) {
      term.textarea.readOnly = true;
      term.textarea.inputMode = 'none';
    }
    enableClipboard(term, host);
    enableFiles(term, node, host, attach, picker, job.id);
    term.onData(sendInput);
    term.onResize(({ cols, rows }) => sendWs({ type: 'resize', id: job.id, cols, rows }));
  } else {
    host.textContent = 'xterm.js failed to load';
  }
  function activate() {
    if (!term || !host.clientWidth || !host.clientHeight) return;
    fit?.fit();
    sendWs({ type: 'active', id: job.id, cols: term.cols, rows: term.rows });
  }
  for (const event of ['pointerdown', 'touchstart', 'keydown', 'focusin']) {
    node.addEventListener(event, () => {
      if ((composer || event === 'focusin' || event === 'keydown') && S.focused !== job.id) selectJob(job.id);
      activate();
    }, { capture: true, passive: true });
  }
  const pane = { kind: 'terminal', node, term, fit, activate, title, stateEl, mic, attached: false };
  panes.set(job.id, pane);
  return pane;
}

// Copy / paste like Windows Terminal:
// - Ctrl+C copies when text is selected (otherwise it still stops the running command)
// - Ctrl+V / Ctrl+Shift+V paste; Ctrl+Shift+C copies
// - right click copies the selection, or pastes when nothing is selected
async function copySelection(term) {
  const text = term.getSelection();
  if (!text) return false;
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
  term.clearSelection();
  return true;
}

async function pasteClipboard(term) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch {
    // The browser blocked reading the clipboard: Ctrl+V still works.
    term.focus();
  }
}

// Screenshots and files: Ctrl+V of an image, drag & drop, or the 📎 button. Each file is
// saved by Jarvis and its full path is typed into the terminal; Claude, Codex and
// Gemini read images and files from a path.
const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);

async function uploadFiles(term, jobId, files) {
  const paths = [];
  for (const file of files) {
    try {
      const name = file.name || `screenshot-${Date.now()}.png`;
      const res = await fetch(`/api/upload?job=${encodeURIComponent(jobId)}&name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'x-jarvis-token': TOKEN, 'content-type': 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new Error(String(res.status));
      paths.push(quotePath((await res.json()).path));
    } catch (e) {
      term.write(`\r\n\x1b[31m[Jarvis] Δεν ανέβηκε το αρχείο ${file.name || ''} (${e.message === '413' ? 'πάνω από 25 MB' : 'σφάλμα'})\x1b[0m\r\n`);
    }
  }
  if (paths.length) {
    term.paste(paths.join(' ') + ' ');
    term.focus();
  }
}

function enableFiles(term, node, host, attach, picker, jobId) {
  // capture phase: runs before xterm's own paste handler, so an image never arrives as text
  host.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    uploadFiles(term, jobId, files);
  }, true);
  node.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove('drop'); });
  node.addEventListener('drop', (e) => {
    node.classList.remove('drop');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    uploadFiles(term, jobId, files);
  });
  attach.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    picker.value = '';
    if (files.length) uploadFiles(term, jobId, files);
  });
}

function enableClipboard(term, host) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && (e.shiftKey || term.hasSelection())) {
      e.preventDefault();
      copySelection(term);
      return false;
    }
    // Ctrl+V: don't send ^V to the program; let the browser's own paste reach xterm
    // (needs no clipboard permission, unlike navigator.clipboard.readText).
    if (k === 'v') return false;
    return true;
  });
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) copySelection(term); else pasteClipboard(term);
  });
}

function createChat(chat, maximize) {
  const acc = account(chat.accountId);
  const color = safeColor(acc?.color);
  const l = acc ? look(acc) : null;
  const cli = l ? l.name.charAt(0) + l.name.slice(1).toLowerCase() : 'AI';
  const view = createChatPane({
    info: chat,
    who: l ? l.display : chat.accountId,
    cli: acc?.cli,
    mode: acc?.mode,
    color,
    rgb: hexRgb(color).join(','),
    placeholder: `Γράψε στο ${cli}…`,
    api,
    voice,
    maximize,
    onFocus: () => { if (S.focused !== chat.id) focusJob(chat.id); },
    onClose: () => closeSession(chat.id),
  });
  const pane = { kind: 'chat', view, node: view.node, mic: view.mic, attached: false };
  panes.set(chat.id, pane);
  return pane;
}

function attachPane(id) {
  const pane = panes.get(id);
  if (!pane || ws?.readyState !== WebSocket.OPEN) return;
  pane.attached = true;
  sendWs({ type: pane.kind === 'chat' ? 'chat-attach' : 'attach', id }); // chat-attach replies with a full snapshot
}

function fitAll() {
  if (!dockOpen()) return;
  for (const [id, pane] of panes) {
    if (!pane.fit || !pane.node.isConnected || (maximizedId && id !== maximizedId)) continue;
    try { pane.fit.fit(); } catch { /* not laid out yet */ }
    if (pane.term) sendWs({ type: 'resize', id, cols: pane.term.cols, rows: pane.term.rows });
  }
}
let fitTimer = 0;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitAll, 120); });

async function closeChat(id) {
  const chat = S.chats.find((c) => c.id === id);
  if (!chat) return;
  const busy = chat.state === 'working' || chat.state === 'waiting';
  if (busy && !confirm(`Η συζήτηση "${chat.title}" δουλεύει ακόμα. Κλείσιμο;`)) return;
  try {
    await api('DELETE', `/api/chats/${id}`);
  } catch (e) {
    if (e.code !== 'NO_SUCH_CHAT') { alert(errorText(e.code)); return; }
  }
  S.chats = S.chats.filter((c) => c.id !== id); // the server's chats broadcast says the same
  renderJobs();
}

function closeSession(id) {
  if (S.chats.some((c) => c.id === id)) { closeChat(id); return; }
  const job = S.jobs.find((j) => j.id === id);
  if (!job) return;
  const live = job.exitCode === null;
  if (live && !confirm(`Τερματισμός του "${job.title}";`)) return;
  // The server drops the job (and frees its console) on kill, finished or not; the next jobs list removes the pane.
  sendWs({ type: 'kill', id });
}

function renderJobs() {
  const jobs = visibleJobs();
  if (maximizedId && !jobs.some((j) => j.id === maximizedId)) maximizedId = null;
  $('dock').classList.toggle('has-maximized', maximizedId !== null);
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
  let layoutChanged = false;
  for (const job of jobs) {
    let pane = panes.get(job.id);
    if (!pane) {
      const maximize = el('button', { type: 'button', class: 'x', onclick: () => toggleMaximized(job.id) });
      pane = job.kind === 'chat' ? createChat(job.info, maximize) : createPane(job.info, maximize);
      pane.maximize = maximize;
      const header = pane.node.querySelector('header');
      header.addEventListener('mousedown', (e) => {
        // Keep the header under the pointer instead of scrolling to the terminal or composer.
        e.stopPropagation();
        if (S.focused !== job.id) selectJob(job.id);
      });
      header.addEventListener('dblclick', (e) => {
        if (!e.target.closest('button, input')) toggleMaximized(job.id);
      });
      drawer.append(pane.node);
      attachPane(job.id);
      layoutChanged = true;
    }
    if (pane.kind === 'chat') {
      pane.view.setInfo(job.info);
    } else {
      pane.title.textContent = job.title;
      pane.stateEl.textContent = STATE_LABEL[job.state] ?? job.state;
      pane.node.dataset.state = job.state;
    }
    pane.node.classList.toggle('focus', job.id === S.focused);
    const maximized = job.id === maximizedId;
    pane.node.classList.toggle('maximized', maximized);
    pane.maximize.textContent = maximized ? '⤡' : '⤢';
    pane.maximize.title = maximized ? 'Σμίκρυνση' : 'Μεγέθυνση';
    pane.maximize.setAttribute('aria-label', pane.maximize.title);
  }
  for (const [id, pane] of panes) {
    if (!jobs.some((j) => j.id === id)) {
      voice.detach(pane.mic);
      if (pane.kind === 'chat') pane.view.dispose(); else pane.term?.dispose();
      pane.node.remove();
      panes.delete(id);
      layoutChanged = true;
    }
  }
  // keep the drawer in session order; only move nodes when needed (moving resets scroll positions)
  const order = jobs.map((j) => panes.get(j.id).node);
  if (order.some((n, i) => drawer.children[i] !== n)) for (const n of order) drawer.append(n);
  drawer.style.setProperty('--cols', String(Math.max(1, Math.min(3, jobs.length))));
  if (layoutChanged) requestAnimationFrame(fitAll);
  renderStates();
}

function renderStates() {
  const job = visibleJobs().find((j) => j.id === S.focused);
  const state = job?.state ?? 'idle';
  for (const s of $('states').querySelectorAll('span')) s.classList.toggle('on', s.dataset.s === state);
  $('st').textContent = STATE_LABEL[state] ?? state;
  $('ready').textContent = job ? `${job.title} · ${STATE_LABEL[state] ?? state}` : 'Ready · idle';
}

// ---------- WebSocket with reconnect ----------
let ws = null;
let backoff = 500;
let reconnectTimer = 0;
let restarting = false;

function setDown(down) {
  $('down').hidden = !down;
  $('conn').textContent = down ? 'Offline' : (ws?.readyState === WebSocket.OPEN ? 'Connected' : 'Connecting…');
}

const chatPane = (id) => { const p = panes.get(id); return p?.kind === 'chat' ? p.view : null; };

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
    case 'sitewatch':
      if (msg.sitewatch && typeof msg.sitewatch === 'object') { S.sitewatch = msg.sitewatch; renderSites(); }
      break;
    case 'directives':
      if (Array.isArray(msg.list)) { S.directives = msg.list; renderDirectives(); }
      break;
    case 'chats':
      if (Array.isArray(msg.list)) { S.chats = msg.list; renderJobs(); }
      break;
    case 'chat-snapshot':
      if (msg.info && typeof msg.info === 'object') {
        const i = S.chats.findIndex((c) => c.id === msg.id);
        if (i !== -1) S.chats[i] = { ...S.chats[i], ...msg.info };
      }
      chatPane(msg.id)?.snapshot(msg.info, msg.items);
      break;
    case 'chat-item':
      chatPane(msg.id)?.addItem(msg.item);
      break;
    case 'chat-delta':
      chatPane(msg.id)?.delta(msg.itemId, msg.text);
      break;
    case 'chat-update':
      chatPane(msg.id)?.patch(msg.itemId, msg.patch);
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

function reportFocus(event) {
  const focused = !document.hidden && document.hasFocus();
  sendWs({ type: 'focus', focused });
  if (event && focused) panes.get(S.focused)?.activate?.();
}
window.addEventListener('focus', reportFocus);
window.addEventListener('blur', reportFocus);
document.addEventListener('visibilitychange', reportFocus);

function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws = sock;
  sock.addEventListener('open', () => {
    backoff = 500;
    setDown(false);
    reportFocus();
    for (const id of panes.keys()) attachPane(id); // live data only flows to attached sockets
    fitAll();
  });
  sock.addEventListener('message', onMessage);
  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    if (restarting) return;
    $('conn').textContent = 'Reconnecting…';
    scheduleReconnect();
  });
}

async function scheduleReconnect() {
  if (restarting) return;
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

$('restart').addEventListener('click', async () => {
  if (!confirm('Επανεκκίνηση του Jarvis; Τα terminals θα ξανανοίξουν και θα συνεχίσουν τις συζητήσεις τους.')) return;
  try { await api('POST', '/api/restart'); }
  catch { alert('Η επανεκκίνηση απέτυχε.'); return; }
  restarting = true;
  clearTimeout(reconnectTimer);
  setDown(true);
  $('conn').textContent = 'Restarting…';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const ping = await fetch('/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(1000) });
      if (!ping.ok || await ping.text() !== 'jarvis') continue;
      try { await api('GET', '/api/state'); }
      catch (e) { if (e.status === 403) { location.reload(); return; } }
    } catch { /* server is still restarting */ }
  }
  $('conn').textContent = 'Restart timed out';
  restarting = false;
  scheduleReconnect();
});

$('shutdown').addEventListener('click', async () => {
  if (!confirm('Σταματάνε όλες οι δουλειές. Συνέχεια;')) return;
  try { await api('POST', '/api/shutdown'); } catch { /* already gone */ }
  setDown(true);
  // Close the Jarvis app window too (works in the --app window; a normal tab may refuse).
  window.close();
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
  S.sitewatch = state.sitewatch && typeof state.sitewatch === 'object' ? state.sitewatch : { state: 'off' };
  renderSites();

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
