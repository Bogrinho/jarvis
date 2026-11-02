import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatManager } from '../src/chat/manager.js';
import { ChatError } from '../src/chat/model.js';

class FakeAdapter extends EventEmitter {
  constructor() {
    super();
    this.sent = []; this.answers = []; this.started = null; this.closed = false; this.interrupted = 0;
    this.failStart = null;
  }
  async start(opts) {
    this.started = opts;
    if (this.failStart) throw new Error(this.failStart);
    return { externalId: 'ext-' + (opts.resumeId ?? 'new') };
  }
  send(t) { this.sent.push(t); }
  interrupt() { this.interrupted++; }
  answer(token, decision) { this.answers.push([token, decision]); }
  close() { this.closed = true; }
}

async function setup(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-chat-'));
  const indexFile = join(dir, 'data', 'chats.json');
  const adapters = [];
  const make = () => { const a = new FakeAdapter(); adapters.push(a); return a; };
  const mgr = new ChatManager({ adapters: { codex: make, claude: make }, indexFile, ...opts });
  const mk = (extra = {}) => mgr.create({
    accountId: 'a1', account: { cli: 'codex' }, cwd: 'C:\\x', side: 'left', title: 'T', ...extra,
  });
  return { mgr, adapters, indexFile, mk, dir };
}

test('create stores conversation and calls adapter.start', async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk({ resumeId: 'r1' });
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].started.resumeId, 'r1');
  assert.equal(adapters[0].started.conv.id, info.id);
  assert.equal(info.externalId, 'ext-r1');
  assert.equal(info.accountId, 'a1');
  assert.deepEqual(mgr.list().map(c => c.id), [info.id]);
  assert.deepEqual(mgr.get(info.id).items, []);
});

test('create rejects unsupported cli and wraps start failure', async () => {
  const { mgr, mk } = await setup();
  await assert.rejects(mk({ account: { cli: 'bash' } }), e => e instanceof ChatError && e.code === 'CHAT_UNSUPPORTED');
  const failing = new ChatManager({
    adapters: { codex: () => { const a = new FakeAdapter(); a.failStart = 'boom'; return a; } },
    indexFile: join((await setup()).dir, 'c.json'),
  });
  await assert.rejects(
    failing.create({ accountId: 'a', account: { cli: 'codex' }, cwd: '.', side: 'left', title: 't' }),
    e => e instanceof ChatError && e.code === 'START_FAILED' && /boom/.test(e.message));
  assert.deepEqual(failing.list(), []);
  assert.deepEqual(mgr.list(), []);
});

test('send appends a user item then forwards text', async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk();
  const seen = [];
  mgr.on('item', (id, item) => seen.push([id, item.kind]));
  mgr.send(info.id, 'hello');
  const { items } = mgr.get(info.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'user');
  assert.equal(items[0].text, 'hello');
  assert.deepEqual(adapters[0].sent, ['hello']);
  assert.deepEqual(seen, [[info.id, 'user']]);
  assert.throws(() => mgr.send('nope', 'x'), e => e.code === 'NO_SUCH_CHAT');
});

test('deltas build up the assistant item text', async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk();
  const a = adapters[0];
  const deltas = [];
  mgr.on('delta', (id, itemId, t) => deltas.push([id, itemId, t]));
  a.emit('item', { id: 'm1', kind: 'assistant', text: '', streaming: true });
  a.emit('delta', 'm1', 'Hel');
  a.emit('delta', 'm1', 'lo');
  a.emit('update', 'm1', { streaming: false });
  const it = mgr.get(info.id).items[0];
  assert.equal(it.text, 'Hello');
  assert.equal(it.streaming, false);
  assert.equal(deltas.length, 2);
});

test('approval from adapter becomes a pending approval item with a new approvalId', async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk();
  adapters[0].emit('approval', { token: 'tok1', title: 'Run?', detail: 'd', command: 'ls' });
  const it = mgr.get(info.id).items[0];
  assert.equal(it.kind, 'approval');
  assert.equal(it.state, 'pending');
  assert.notEqual(it.approvalId, 'tok1');
  assert.match(it.approvalId, /^[0-9a-f-]{36}$/);
  assert.equal(it.command, 'ls');
  assert.equal(JSON.stringify(it).includes('tok1'), false);
});

test('answer with a known approvalId forwards decision once and marks item', async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk();
  adapters[0].emit('approval', { token: 'tok1', title: 'Run?', detail: 'd' });
  const it = mgr.get(info.id).items[0];
  mgr.answer(info.id, it.approvalId, 'approve');
  assert.deepEqual(adapters[0].answers, [['tok1', 'approve']]);
  assert.equal(mgr.get(info.id).items[0].state, 'approved');
  assert.throws(() => mgr.answer(info.id, it.approvalId, 'deny'), e => e.code === 'NO_SUCH_APPROVAL');
  assert.equal(adapters[0].answers.length, 1);
});

test('answer for unknown or already-answered approvalId throws NO_SUCH_APPROVAL and forwards nothing', async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk();
  assert.throws(() => mgr.answer(info.id, 'bogus', 'approve'),
    e => e instanceof ChatError && e.code === 'NO_SUCH_APPROVAL');
  adapters[0].emit('approval', { token: 't', title: 'x', detail: '' });
  const it = mgr.get(info.id).items[0];
  assert.throws(() => mgr.answer(info.id, it.approvalId, 'maybe'), e => e.code === 'BAD_DECISION');
  assert.equal(mgr.get(info.id).items[0].state, 'pending');
  assert.equal(adapters[0].answers.length, 0);
});

test('two conversations approvals never cross', async () => {
  const { mgr, adapters, mk } = await setup();
  const c1 = await mk();
  const c2 = await mk();
  adapters[0].emit('approval', { token: 'same', title: 'a', detail: '' });
  adapters[1].emit('approval', { token: 'same', title: 'b', detail: '' });
  const ap1 = mgr.get(c1.id).items[0].approvalId;
  const ap2 = mgr.get(c2.id).items[0].approvalId;
  assert.throws(() => mgr.answer(c1.id, ap2, 'approve'), e => e.code === 'NO_SUCH_APPROVAL');
  assert.throws(() => mgr.answer(c2.id, ap1, 'approve'), e => e.code === 'NO_SUCH_APPROVAL');
  assert.equal(adapters[0].answers.length + adapters[1].answers.length, 0);
  mgr.answer(c2.id, ap2, 'always');
  assert.equal(adapters[0].answers.length, 0);
  assert.equal(adapters[1].answers.length, 1);
  assert.equal(mgr.get(c2.id).items[0].state, 'always');
  assert.equal(mgr.get(c1.id).items[0].state, 'pending');
});

test('transcript capped at transcriptCap keeping newest', async () => {
  const { mgr, adapters, mk } = await setup({ transcriptCap: 3 });
  const info = await mk();
  for (let i = 0; i < 5; i++) adapters[0].emit('item', { id: 'n' + i, kind: 'notice', text: String(i) });
  assert.deepEqual(mgr.get(info.id).items.map(i => i.text), ['2', '3', '4']);
});

test("adapter exit while working adds an error item and state 'error'", async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk();
  adapters[0].emit('state', 'working');
  assert.equal(mgr.get(info.id).info.state, 'working');
  adapters[0].emit('approval', { token: 't', title: 'x', detail: '' });
  adapters[0].emit('exit', 1);
  const { info: i, items } = mgr.get(info.id);
  assert.equal(i.state, 'error');
  assert.equal(items.at(-1).kind, 'error');
  const ap = items.find(x => x.kind === 'approval');
  assert.equal(ap.state, 'expired');
  assert.throws(() => mgr.answer(info.id, ap.approvalId, 'approve'), e => e.code === 'NO_SUCH_APPROVAL');
});

test('index file lists conversations without message text', async () => {
  const { mgr, adapters, mk, indexFile } = await setup();
  const info = await mk();
  mgr.send(info.id, 'secret words');
  adapters[0].emit('item', { id: 'm', kind: 'assistant', text: 'more secret', streaming: false });
  await mgr.flush();
  const raw = await readFile(indexFile, 'utf8');
  assert.equal(raw.includes('secret'), false);
  const idx = JSON.parse(raw);
  assert.equal(idx.length, 1);
  assert.deepEqual(Object.keys(idx[0]).sort(),
    ['accountId', 'cwd', 'externalId', 'id', 'side', 'title', 'updatedAt']);
});

test('index survives corrupt file and close removes entry', async () => {
  const { mgr, mk, indexFile, dir } = await setup();
  await mkdir(join(dir, 'data'), { recursive: true });
  await writeFile(indexFile, '{not json');
  const a = await mk();
  const b = await mk();
  await mgr.flush();
  assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).length, 2);
  mgr.close(a.id);
  await mgr.flush();
  assert.deepEqual(JSON.parse(await readFile(indexFile, 'utf8')).map(e => e.id), [b.id]);
  assert.throws(() => mgr.get(a.id), e => e.code === 'NO_SUCH_CHAT');
});

test('concurrent creates serialize index writes', async () => {
  const { mgr, mk, indexFile } = await setup();
  await Promise.all(Array.from({ length: 10 }, () => mk()));
  await mgr.flush();
  assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).length, 10);
});

test('transcript cap never drops a pending approval', async () => {
  const { mgr, adapters, mk } = await setup({ transcriptCap: 5 });
  const info = await mk();
  adapters[0].emit('approval', { token: 'tk', title: 'x', detail: '' });
  for (let i = 0; i < 20; i++) adapters[0].emit('item', { id: 'n' + i, kind: 'notice', text: String(i) });
  const items = mgr.get(info.id).items;
  const ap = items.find(x => x.kind === 'approval');
  assert.ok(ap, 'approval kept');
  assert.equal(items.filter(x => x.kind === 'notice').length, 4);
  mgr.answer(info.id, ap.approvalId, 'approve');
  assert.deepEqual(adapters[0].answers, [['tk', 'approve']]);
});

for (const st of ['idle', 'error']) {
  test(`pending approval expires when adapter state becomes ${st}`, async () => {
    const { mgr, adapters, mk } = await setup();
    const info = await mk();
    adapters[0].emit('approval', { token: 't', title: 'x', detail: '' });
    const ap = mgr.get(info.id).items[0];
    const updates = [];
    mgr.on('update', (...a) => updates.push(a));
    adapters[0].emit('state', st);
    assert.equal(mgr.get(info.id).items[0].state, 'expired');
    assert.deepEqual(updates, [[info.id, ap.id, { state: 'expired' }]]);
    assert.throws(() => mgr.answer(info.id, ap.approvalId, 'approve'), e => e.code === 'NO_SUCH_APPROVAL');
    assert.equal(adapters[0].answers.length, 0);
  });
}

test('pending approval expires on interrupt', async () => {
  const { mgr, adapters, mk } = await setup();
  const info = await mk();
  adapters[0].emit('approval', { token: 't', title: 'x', detail: '' });
  const ap = mgr.get(info.id).items[0];
  mgr.interrupt(info.id);
  assert.equal(adapters[0].interrupted, 1);
  assert.equal(mgr.get(info.id).items[0].state, 'expired');
  assert.throws(() => mgr.answer(info.id, ap.approvalId, 'approve'), e => e.code === 'NO_SUCH_APPROVAL');
});

test('conversation ids are full UUIDs', async () => {
  const { mk } = await setup();
  assert.match((await mk()).id, /^[0-9a-f-]{36}$/);
});
