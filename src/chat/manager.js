import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { ChatError, DECISIONS } from './model.js';

const INDEX_MAX = 200;
const now = () => new Date().toISOString();

async function loadIndex(file, io) {
  try {
    const data = JSON.parse(await io.readFile(file, 'utf8'));
    return Array.isArray(data) ? data.filter(e => e && typeof e.id === 'string') : [];
  } catch {
    return [];
  }
}

async function saveIndex(file, data, io) {
  await io.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await io.writeFile(tmp, JSON.stringify(data), 'utf8');
    await io.rename(tmp, file);
  } catch (e) {
    try { await io.unlink(tmp); } catch { /* best effort */ }
    throw e;
  }
}

const indexEntry = i => ({
  id: i.id, accountId: i.accountId, cwd: i.cwd, side: i.side,
  title: i.title, externalId: i.externalId, updatedAt: i.updatedAt,
});

export class ChatManager extends EventEmitter {
  #adapters; #indexFile; #cap; #io;
  #convs = new Map();      // id -> { info, items, adapter, approvals: Map<approvalId,{token,itemId}>, exited }
  #removed = new Set();    // ids that must be dropped from the persisted index
  #persisted = null;       // entries already on disk, loaded lazily on first write
  #writing = null;         // in-flight write chain
  #dirty = false;

  constructor({ adapters, indexFile, transcriptCap = 2000, io = fsp }) {
    super();
    this.#adapters = adapters ?? {};
    this.#indexFile = indexFile;
    this.#cap = transcriptCap;
    this.#io = io;
  }

  async create({ accountId, account, cwd, side, title, resumeId }) {
    const factory = this.#adapters[account?.cli];
    if (typeof factory !== 'function') {
      throw new ChatError('CHAT_UNSUPPORTED', `Chat is not supported for CLI "${account?.cli}"`);
    }
    const adapter = factory(account, cwd);
    const t = now();
    const info = {
      id: randomUUID(), accountId, cwd, side, title,
      state: 'idle', externalId: null, createdAt: t, updatedAt: t,
    };
    const conv = { info, items: [], adapter, approvals: new Map(), exited: false };
    this.#wire(conv);
    this.#convs.set(info.id, conv);
    try {
      const res = await adapter.start({ conv: { ...info }, resumeId });
      info.externalId = res?.externalId ?? null;
    } catch (e) {
      this.#convs.delete(info.id);
      adapter.removeAllListeners();
      try { adapter.close(); } catch { /* best effort */ }
      throw new ChatError('START_FAILED', e?.message ?? String(e));
    }
    this.#touch(conv);
    this.#scheduleWrite();
    this.emit('conv', { ...info });
    return { ...info };
  }

  list() {
    return [...this.#convs.values()].map(c => ({ ...c.info }));
  }

  get(id) {
    const c = this.#need(id);
    return { info: { ...c.info }, items: c.items.map(i => ({ ...i })) };
  }

  send(id, text) {
    const c = this.#need(id);
    if (c.exited) throw new ChatError('CHAT_EXITED', 'Conversation has ended');
    this.#addItem(c, { id: randomUUID(), kind: 'user', text });
    c.adapter.send(text);
  }

  interrupt(id) {
    const c = this.#need(id);
    this.#expireApprovals(c);
    c.adapter.interrupt();
  }

  answer(id, approvalId, decision) {
    const c = this.#need(id);
    const rec = c.approvals.get(approvalId);
    const item = rec && c.items.find(i => i.id === rec.itemId);
    if (!rec || !item || item.state !== 'pending') {
      throw new ChatError('NO_SUCH_APPROVAL', 'No pending approval with that id in this conversation');
    }
    const next = typeof decision === 'string' && Object.hasOwn(DECISIONS, decision) ? DECISIONS[decision] : undefined;
    if (!next) throw new ChatError('BAD_DECISION', `Unknown decision "${decision}"`);
    // Mark first so a re-entrant or repeated answer can never forward twice.
    item.state = next;
    c.approvals.delete(approvalId);
    try {
      c.adapter.answer(rec.token, decision);
    } catch (e) {
      item.state = 'pending';
      c.approvals.set(approvalId, rec);
      throw e;
    }
    this.#touch(c);
    this.emit('update', id, item.id, { state: next });
  }

  close(id) {
    const c = this.#need(id);
    this.#convs.delete(id);
    this.#removed.add(id);
    this.#expireApprovals(c);
    c.adapter.removeAllListeners();
    try { c.adapter.close(); } catch { /* best effort */ }
    this.#scheduleWrite();
    this.emit('removed', id);
  }

  // Shutdown: stop every adapter but keep the index so conversations can be resumed.
  closeAll() {
    for (const c of this.#convs.values()) {
      c.adapter.removeAllListeners();
      try { c.adapter.close(); } catch { /* best effort */ }
    }
    this.#convs.clear();
    return this.flush();
  }

  // Resolves once all pending index changes are on disk.
  async flush() {
    while (this.#writing || this.#dirty) {
      if (this.#writing) await this.#writing;
      else this.#startWrite();
    }
  }

  #need(id) {
    const c = this.#convs.get(id);
    if (!c) throw new ChatError('NO_SUCH_CHAT', 'No such conversation');
    return c;
  }

  #touch(c) {
    c.info.updatedAt = now();
  }

  #addItem(c, item) {
    c.items.push(item);
    // Trim oldest first, but never a pending approval: its record is the only
    // way to answer the adapter's outstanding request.
    for (let i = 0; c.items.length > this.#cap && i < c.items.length;) {
      const it = c.items[i];
      if (it.kind === 'approval' && it.state === 'pending') { i++; continue; }
      c.items.splice(i, 1);
      if (it.approvalId) c.approvals.delete(it.approvalId);
    }
    this.#touch(c);
    this.#scheduleWrite();
    this.emit('item', c.info.id, { ...item });
  }

  #setState(c, state) {
    if (state === 'idle' || state === 'error') this.#expireApprovals(c);
    if (c.info.state === state) return;
    c.info.state = state;
    this.#touch(c);
    this.emit('conv', { ...c.info });
  }

  #expireApprovals(c) {
    for (const rec of c.approvals.values()) {
      const item = c.items.find(i => i.id === rec.itemId);
      if (item && item.state === 'pending') {
        item.state = 'expired';
        this.emit('update', c.info.id, item.id, { state: 'expired' });
      }
    }
    c.approvals.clear();
  }

  #wire(c) {
    const { adapter } = c;
    const id = c.info.id;
    adapter.on('item', item => this.#addItem(c, { ...item }));
    adapter.on('delta', (itemId, chunk) => {
      const item = c.items.find(i => i.id === itemId);
      if (!item) return;
      item.text = (item.text ?? '') + chunk;
      this.emit('delta', id, itemId, chunk);
    });
    adapter.on('update', (itemId, patch) => {
      const item = c.items.find(i => i.id === itemId);
      if (!item) return;
      // approval identity and state are owned by the manager, never by the adapter
      const { approvalId, kind, id: _id, ...safe } = patch ?? {};
      if (item.kind === 'approval') delete safe.state;
      Object.assign(item, safe);
      this.emit('update', id, itemId, safe);
    });
    adapter.on('state', state => this.#setState(c, state));
    adapter.on('approval', ({ token, title, detail, command }) => {
      const approvalId = randomUUID();
      const item = { id: randomUUID(), kind: 'approval', approvalId, title, detail, state: 'pending' };
      if (command !== undefined) item.command = command;
      c.approvals.set(approvalId, { token, itemId: item.id });
      this.#addItem(c, item);
    });
    // The CLI stopped waiting for one approval (e.g. it was resolved elsewhere):
    // expire just that card so it can no longer be answered.
    adapter.on('approval-expired', token => {
      for (const [approvalId, rec] of c.approvals) {
        if (rec.token !== token) continue;
        c.approvals.delete(approvalId);
        const item = c.items.find(i => i.id === rec.itemId);
        if (item && item.state === 'pending') {
          item.state = 'expired';
          this.#touch(c);
          this.emit('update', id, item.id, { state: 'expired' });
        }
      }
    });
    adapter.on('exit', code => {
      const wasWorking = c.info.state === 'working' || c.info.state === 'waiting';
      c.exited = true;
      this.#expireApprovals(c);
      if (wasWorking) {
        this.#addItem(c, {
          id: randomUUID(), kind: 'error',
          text: `The session ended unexpectedly (exit code ${code ?? 'unknown'}).`,
        });
        this.#setState(c, 'error');
      } else {
        this.#setState(c, 'idle');
      }
    });
  }

  // Index writes are coalesced and strictly serialized: one write in flight,
  // at most one queued, each snapshotting the state when it actually runs.
  #scheduleWrite() {
    this.#dirty = true;
    if (!this.#writing) this.#startWrite();
  }

  #startWrite() {
    this.#dirty = false;
    this.#writing = (async () => {
      try {
        if (!this.#persisted) this.#persisted = await loadIndex(this.#indexFile, this.#io);
        const live = new Map([...this.#convs.values()].map(c => [c.info.id, indexEntry(c.info)]));
        const kept = this.#persisted.filter(e => !live.has(e.id) && !this.#removed.has(e.id));
        const all = [...live.values(), ...kept]
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, INDEX_MAX);
        this.#persisted = all;
        await saveIndex(this.#indexFile, all, this.#io);
      } catch (e) {
        this.emit('index-error', e);
      } finally {
        this.#writing = null;
        if (this.#dirty) this.#startWrite();
      }
    })();
  }
}
