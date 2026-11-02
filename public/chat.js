// Chat pane: the HUD conversation view (design/chat-mockup.html) for one Codex/Claude conversation.
// All server/AI text reaches the DOM as text nodes (via h / renderMarkdown); never as HTML.
import { renderMarkdown } from './markdown.js';

// Tiny DOM builder shared with app.js. Strings become text nodes.
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

const PILL = { idle: 'ΕΤΟΙΜΟ', working: 'ΔΟΥΛΕΥΕΙ', waiting: 'ΠΕΡΙΜΕΝΕΙ ΕΣΕΝΑ', error: 'ΣΦΑΛΜΑ' };
const ICON = { read: '◎', run: '›_', search: '⌕', edit: '✎', tool: '⚙' };
const VERB = { read: 'Διάβασε', run: 'Έτρεξε', search: 'Έψαξε', edit: 'Άλλαξε', tool: 'Εργαλείο' };
const RESULT = {
  approved: '✓ Επιτράπηκε', denied: '✕ Δεν επιτράπηκε', always: '✓ Πάντα για αυτό', expired: 'Έληξε — δεν χρειάζεται πια',
};
const ERRORS = {
  NO_SUCH_APPROVAL: 'Αυτό το αίτημα έληξε', CHAT_EXITED: 'Η συζήτηση έχει τελειώσει', NO_SUCH_CHAT: 'Η συζήτηση δεν υπάρχει πια',
  OFFLINE: 'Το Jarvis δεν τρέχει',
};
const errText = (code) => ERRORS[code] ?? `Κάτι πήγε στραβά (${code})`;
const DIFF_MAX_LINES = 400;
const WEEKDAYS = ['ΚΥΡ', 'ΔΕΥ', 'ΤΡΙ', 'ΤΕΤ', 'ΠΕΜ', 'ΠΑΡ', 'ΣΑΒ'];

// "~\Documents\Codex\…\project" style short path; full path stays in the title attribute.
export function shortPath(p) {
  let s = String(p ?? '').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
  const parts = s.split(/[\\/]/);
  if (parts.length > 5) s = [...parts.slice(0, 3), '…', parts[parts.length - 1]].join('\\');
  return s;
}

// "πριν 5 λεπ." etc. for history lists.
export function fmtAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'μόλις τώρα';
  if (m < 60) return `πριν ${m} λεπ.`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `πριν ${hrs} ώρ.`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `πριν ${days} ${days === 1 ? 'μέρα' : 'μέρες'}`;
  return new Date(t).toLocaleDateString('el-GR');
}

function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === new Date().toDateString()) return `ΣΗΜΕΡΑ · ${hm}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} · ${hm}`;
}

/**
 * createChatPane({ info, who, color, rgb, placeholder, api, onFocus, onClose })
 * -> { node, focus(), setInfo(info), snapshot(info, items), addItem(item), delta(itemId, text), patch(itemId, patch), dispose() }
 */
export function createChatPane({ info: initial, who, color, rgb, placeholder, api, onFocus, onClose }) {
  let info = { ...initial };
  const recs = new Map(); // itemId -> { item, node, answering }
  let tail = null; // { type:'me'|'ai'|'sys', body }
  let stick = true;
  let sending = false;
  const dirty = new Set();
  let frame = 0;

  // ---------- skeleton ----------
  const title = h('h2');
  const sub = h('small');
  const pill = h('span', { class: 'pill' });
  const close = h('button', { type: 'button', class: 'x', 'aria-label': 'Κλείσιμο συζήτησης', text: '✕' });
  const log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
  const newer = h('button', { type: 'button', class: 'newer', hidden: true, text: '↓ νέα μηνύματα' });
  const typing = h('div', { class: 'ai typing-row' }, h('div', { class: 'av', 'aria-hidden': 'true' }),
    h('div', { class: 'typing' }, 'σκέφτεται ', h('span', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))));
  const input = h('textarea', { rows: 1, placeholder: placeholder ?? 'Γράψε…', 'aria-label': 'Μήνυμα' });
  const send = h('button', { type: 'button', class: 'send', 'aria-label': 'Αποστολή', title: 'Αποστολή', text: '➤' });
  const stop = h('button', { type: 'button', class: 'stop', 'aria-label': 'Σταμάτα', title: 'Σταμάτα', hidden: true },
    h('span', { 'aria-hidden': 'true' }));
  const err = h('span', { class: 'err', role: 'status' });
  const node = h('section', { class: 'chat', style: { '--c': color, '--c-rgb': rgb } },
    h('div', { class: 'hd' },
      h('div', { class: 'orb', 'aria-hidden': 'true' }),
      h('div', { class: 'ttl' }, title, sub),
      h('div', { class: 'sp' }),
      h('span', { class: 'seg', title: 'Λειτουργία' }, h('span', { class: 'on', text: 'Chat' })),
      pill,
      close),
    h('div', { class: 'beam', 'aria-hidden': 'true' }),
    h('div', { class: 'logwrap' }, log, newer),
    h('div', { class: 'comp' },
      h('div', { class: 'box' }, input, stop, send),
      h('div', { class: 'meta' },
        h('span', { class: 'chip', text: who }),
        h('span', { class: 'chip', text: 'ρωτάει πριν τις εντολές' }),
        err,
        h('span', { class: 'sp' }),
        h('span', { class: 'hint', text: 'Enter αποστολή · Shift+Enter νέα γραμμή' }))));

  node.addEventListener('mousedown', () => onFocus?.());
  close.addEventListener('click', () => onClose?.());

  // ---------- scrolling ----------
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.addEventListener('scroll', () => {
    stick = atBottom();
    if (stick) newer.hidden = true;
  });
  const toBottom = () => { log.scrollTop = log.scrollHeight; newer.hidden = true; stick = true; };
  newer.addEventListener('click', toBottom);
  // The pane may be laid out later (dock closed) or resized: keep following the newest message.
  const resizeWatch = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (stick) log.scrollTop = log.scrollHeight; }) : null;
  resizeWatch?.observe(log);
  function afterChange(fresh) {
    if (stick) requestAnimationFrame(() => { if (stick) log.scrollTop = log.scrollHeight; });
    else if (fresh) newer.hidden = false;
  }

  // ---------- item views ----------
  function viewAssistant(item) {
    const box = h('div', { class: `md${item.streaming ? ' streaming' : ''}` }, ...renderMarkdown(item.text ?? '', h));
    if (!item.text) box.hidden = true; // nothing yet: the typing indicator speaks for it
    return box;
  }

  function viewActivity(item) {
    const icon = ICON[item.icon] ?? ICON.tool;
    const text = String(item.text ?? '');
    const verb = VERB[item.icon] ?? VERB.tool;
    const what = item.icon === 'run' ? h('code', { text }) : h('span', { class: 'what', text });
    let status;
    if (item.status === 'running') status = h('span', { class: 'run', 'aria-label': 'τρέχει' }, h('i'), h('i'), h('i'));
    else if (item.status === 'fail') status = h('span', { class: 'bad', text: `✕ ${item.detail ?? 'απέτυχε'}` });
    else status = h('span', { class: 'ok', text: item.detail ? `✓ ${item.detail}` : '✓' });
    return h('div', { class: `act ${item.status ?? ''}`, title: item.detail ? `${text}\n${item.detail}` : text },
      h('i', { 'aria-hidden': 'true', text: icon }), h('span', { class: 'tx' }, `${verb} `, what), status);
  }

  function viewDiff(item, prev) {
    const lines = String(item.patch ?? '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const pre = h('pre');
    lines.slice(0, DIFF_MAX_LINES).forEach((l, i) => {
      if (i) pre.append('\n');
      const cls = /^(\+\+\+|---)/.test(l) || l.startsWith('@@') ? 'd' : l.startsWith('+') ? 'p' : l.startsWith('-') ? 'm' : 'd';
      pre.append(h('span', { class: cls, text: l }));
    });
    if (lines.length > DIFF_MAX_LINES) pre.append('\n', h('span', { class: 'd', text: `… ${lines.length - DIFF_MAX_LINES} ακόμα γραμμές` }));
    const open = prev ? prev.open : lines.length <= 40;
    return h('details', { class: 'diff', open },
      h('summary', {}, h('span', { class: 'car', 'aria-hidden': 'true', text: '▸' }), h('b', { text: String(item.path ?? '') }),
        h('span', { class: 'add', text: `+${Number(item.added) || 0}` }), h('span', { class: 'rem', text: `−${Number(item.removed) || 0}` })),
      pre);
  }

  function viewApproval(rec) {
    const { item } = rec;
    const card = h('div', { class: 'ask', 'data-state': item.state });
    card.append(h('div', { class: 't', text: item.state === 'pending' ? 'ΖΗΤΑΕΙ ΑΔΕΙΑ' : 'ΑΔΕΙΑ' }));
    if (item.title) card.append(h('div', { class: 'what', text: item.title }));
    if (item.detail) card.append(h('div', { class: 'det', text: item.detail }));
    if (item.command) card.append(h('code', { text: item.command }));
    if (item.state !== 'pending') {
      card.append(h('div', { class: 'res', text: RESULT[item.state] ?? item.state }));
      return card;
    }
    const msg = h('div', { class: 'amsg', role: 'status', hidden: !rec.error, text: rec.error ?? '' });
    const btns = [
      ['approve', 'Επιτρέπεται', 'btn go'],
      ['deny', 'Όχι', 'btn'],
      ['always', 'Πάντα για αυτό', 'btn'],
    ].map(([decision, label, cls]) => h('button', {
      type: 'button', class: `${cls}${rec.answering === decision ? ' chosen' : ''}`, disabled: Boolean(rec.answering), text: label,
      onclick: () => answer(rec, decision),
    }));
    card.append(h('div', { class: 'btns' }, ...btns), msg);
    return card;
  }

  async function answer(rec, decision) {
    if (rec.answering) return;
    rec.answering = decision;
    rec.error = null;
    rerender(rec);
    try {
      await api('POST', `/api/chats/${info.id}/approvals/${rec.item.approvalId}`, { decision });
      // the resulting state arrives as a chat-update; keep the buttons locked until then
    } catch (e) {
      if (e.code === 'NO_SUCH_APPROVAL') {
        rec.item.state = rec.item.state === 'pending' ? 'expired' : rec.item.state;
      } else {
        rec.answering = null;
        rec.error = errText(e.code);
      }
      rerender(rec);
    }
  }

  function view(rec, prev) {
    const { item } = rec;
    switch (item.kind) {
      case 'user': return h('div', { class: 'me', text: item.text ?? '' });
      case 'assistant': return viewAssistant(item);
      case 'activity': return viewActivity(item);
      case 'diff': return viewDiff(item, prev);
      case 'approval': return viewApproval(rec);
      case 'error': return h('div', { class: 'err-card', role: 'alert', text: item.text ?? '' });
      case 'notice': return h('div', { class: 'sys', text: item.text ?? '' });
      default: return h('div', { class: 'sys', text: item.text ?? '' });
    }
  }

  function rerender(rec) {
    const fresh = view(rec, rec.node);
    rec.node.replaceWith(fresh);
    rec.node = fresh;
  }

  function place(rec) {
    const { kind } = rec.item;
    if (kind === 'user') {
      log.append(rec.node);
      tail = { type: 'me' };
    } else if (kind === 'notice') {
      log.append(rec.node);
      tail = { type: 'sys' };
    } else {
      if (tail?.type !== 'ai') {
        const body = h('div', { class: 'body' });
        log.append(h('div', { class: 'ai' }, h('div', { class: 'av', 'aria-hidden': 'true' }), body));
        tail = { type: 'ai', body };
      }
      if (kind === 'activity') {
        let acts = tail.body.lastElementChild;
        if (!acts?.classList.contains('acts')) { acts = h('div', { class: 'acts' }); tail.body.append(acts); }
        acts.append(rec.node);
      } else {
        tail.body.append(rec.node);
      }
    }
  }

  function add(item) {
    if (!item || typeof item.id !== 'string') return;
    const old = recs.get(item.id);
    if (old) { old.item = { ...item }; rerender(old); return; }
    const rec = { item: { ...item }, node: null, answering: null, error: null };
    rec.node = view(rec);
    recs.set(item.id, rec);
    place(rec);
  }

  // ---------- typing + composer state ----------
  function syncTyping() {
    const streamingText = [...recs.values()].some((r) => r.item.kind === 'assistant' && r.item.streaming && r.item.text);
    const show = info.state === 'working' && !streamingText;
    if (show) log.append(typing); // always last
    else typing.remove();
  }
  function syncComposer() {
    const busy = info.state === 'working' || info.state === 'waiting';
    stop.hidden = !busy;
    send.hidden = busy;
    send.disabled = sending;
    input.disabled = sending;
  }
  function setInfo(next) {
    info = { ...info, ...next };
    title.textContent = info.title ?? '';
    sub.textContent = `${who} · ${shortPath(info.cwd)}`;
    sub.title = info.cwd ?? '';
    pill.textContent = PILL[info.state] ?? String(info.state ?? '');
    node.dataset.state = info.state ?? 'idle';
    syncComposer();
    syncTyping();
    afterChange(false);
  }

  function flushDirty() {
    frame = 0;
    for (const rec of dirty) if (recs.has(rec.item.id)) rerender(rec);
    dirty.clear();
    syncTyping();
    afterChange(true);
  }

  // ---------- composer ----------
  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  async function submit() {
    const text = input.value.trim();
    if (!text || sending || info.state === 'working' || info.state === 'waiting') return;
    sending = true;
    err.textContent = '';
    syncComposer();
    try {
      await api('POST', `/api/chats/${info.id}/messages`, { text });
      input.value = '';
      grow();
      toBottom();
    } catch (e) {
      err.textContent = errText(e.code);
    } finally {
      sending = false;
      syncComposer();
      input.focus();
    }
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  send.addEventListener('click', submit);
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try { await api('POST', `/api/chats/${info.id}/interrupt`); } catch (e) { err.textContent = errText(e.code); }
    finally { stop.disabled = false; }
  });

  setInfo(info);

  return {
    node,
    focus() { if (!input.disabled) input.focus({ preventScroll: true }); },
    setInfo,
    snapshot(nextInfo, items) {
      recs.clear();
      dirty.clear();
      tail = null;
      log.replaceChildren();
      const day = dayLabel(nextInfo?.createdAt ?? info.createdAt);
      if (day) log.append(h('div', { class: 'day', text: day }));
      for (const it of Array.isArray(items) ? items : []) add(it);
      setInfo(nextInfo ?? {});
      toBottom();
      requestAnimationFrame(toBottom);
    },
    addItem(item) {
      add(item);
      syncTyping();
      afterChange(true);
    },
    delta(itemId, text) {
      const rec = recs.get(itemId);
      if (!rec || typeof text !== 'string') return;
      rec.item.text = (rec.item.text ?? '') + text;
      dirty.add(rec);
      if (!frame) frame = requestAnimationFrame(flushDirty);
    },
    patch(itemId, patch) {
      const rec = recs.get(itemId);
      if (!rec || !patch || typeof patch !== 'object') return;
      const { id: _id, kind: _kind, ...safe } = patch;
      Object.assign(rec.item, safe);
      if (rec.item.kind === 'approval' && rec.item.state !== 'pending') rec.answering = null;
      dirty.add(rec);
      if (!frame) frame = requestAnimationFrame(flushDirty);
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      resizeWatch?.disconnect();
      node.remove();
    },
  };
}
