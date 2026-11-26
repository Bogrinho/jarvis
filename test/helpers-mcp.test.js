import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '../src/helpers-mcp.js';

const accounts = Object.fromEntries(['codex', 'agy', 'claude'].map(cli => [cli, { cli, enabled: true, side: 'personal' }]));
const workCodex = { label: 'Codex Work', cli: 'codex', enabled: true, side: 'work', mode: 'auto' };

const here = path.dirname(fileURLToPath(import.meta.url));

test('fallback follows each tool order, labels the answer and only changes the Gemini fallback prompt', async () => {
  for (const [name, order] of [
    ['ask_codex', ['codex', 'codex-work', 'gemini']],
    ['ask_codex_work', ['codex-work', 'gemini']],
    ['ask_gemini', ['gemini', 'codex', 'codex-work']],
  ]) {
    const calls = [];
    const handle = createMcpHandler({
      config: { accounts: { ...accounts, work: workCodex }, projects: [] }, cwd: process.cwd(), notify() {},
      run: async ({ kind, task }) => {
        calls.push(kind);
        if (kind === 'gemini' && name !== 'ask_gemini') assert.match(task, /cannot run shell commands.*checks the leader must run\.\n\nreview$/);
        else assert.equal(task, 'review');
        if (calls.length === order.length) return { account: kind, answer: 'ok' };
        if (kind === 'gemini') throw new Error('RESOURCE_EXHAUSTED');
        return { exitCode: 1, answer: 'You’ve hit your usage limit.' };
      },
    });
    const { result } = await handle({ id: 1, method: 'tools/call', params: { name, arguments: { task: 'review' } } });
    assert.deepEqual(calls, order);
    assert.ok(result.content[0].text.startsWith('[' + order.at(-1) + ' — fallback: '));
    assert.ok(result.content[0].text.endsWith(' hit its usage limit]\nok'));
  }
});

test('limited accounts are skipped across tools until their individual retry times', async () => {
  let clock = new Date(2026, 10, 26, 0, 0).valueOf();
  const calls = [];
  const handle = createMcpHandler({
    config: { accounts: { ...accounts, work: workCodex }, projects: [] }, cwd: process.cwd(), now: () => clock, notify() {},
    run: async ({ kind }) => {
      calls.push(kind);
      if (calls.length > 3) return { account: kind, answer: 'ok' };
      throw new Error(kind === 'codex' ? "You've hit your usage limit. try again at Nov 26th, 2026 2:03 AM." : 'quota');
    },
  });
  const call = async name => (await handle({ id: 1, method: 'tools/call', params: { name, arguments: { task: 'x' } } })).result;
  const all = await call('ask_codex');
  assert.equal(all.isError, true);
  for (const name of ['Όλοι', 'All eligible', 'Codex Personal', 'Codex Work', 'Gemini', new Date(2026, 10, 26, 2, 3).toISOString(), new Date(clock + 3600000).toISOString()]) {
    assert.ok(all.content[0].text.includes(name), name);
  }
  await call('ask_gemini');
  assert.equal(calls.length, 3);
  clock += 3600000;
  assert.equal((await call('ask_codex')).content[0].text, '[codex-work — fallback: Codex Personal hit its usage limit]\nok');
  clock = new Date(2026, 10, 26, 2, 3).valueOf();
  assert.equal((await call('ask_codex')).content[0].text, '[codex]\nok');
  assert.deepEqual(calls, ['codex', 'codex-work', 'gemini', 'codex-work', 'codex']);
});

test('mcp: initialize, list tools, call a tool, report errors', async () => {
  const runs = [];
  const notices = [];
  const handle = createMcpHandler({
    config: { accounts, projects: [] },
    cwd: 'C:/proj',
    notify: (notice) => notices.push(notice),
    run: async (o) => { runs.push(o); if (o.task === 'boom') throw new Error('kaput'); return { account: 'Codex Personal', answer: 'ok!' }; },
  });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['ask_codex', 'ask_gemini']);
  const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_gemini', arguments: { task: 'hi' } } });
  assert.deepEqual(call.result.content, [{ type: 'text', text: '[Codex Personal]\nok!' }]);
  assert.equal(runs[0].kind, 'gemini');
  assert.equal(runs[0].cwd, 'C:/proj');
  const bad = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_codex', arguments: { task: 'boom' } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /kaput/);
  assert.equal(runs.length, 2);
  assert.deepEqual(notices, [
    { title: 'Jarvis: Ο Gemini τελείωσε', body: 'hi' },
    { title: 'Jarvis: Ο Codex σταμάτησε με σφάλμα', body: 'boom' },
  ]);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } })).error.code, -32602);
  assert.equal((await handle({ jsonrpc: '2.0', id: 6, method: 'nope' })).error.code, -32601);
});

test('mcp script starts and answers over stdio', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'helpers-mcp.js');
  fs.copyFileSync(path.join(here, '..', 'scripts', 'helpers-mcp.js'), script);
  fs.symlinkSync(path.join(here, '..', 'src'), path.join(root, 'src'), 'junction');
  fs.writeFileSync(path.join(root, 'jarvis.config.json'), JSON.stringify({
    accounts: { work: { ...workCodex, env: { CODEX_HOME: path.join(root, 'work-login') } } },
    directivesFile: 'today.md',
  }));
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const t0 = Date.now();
  while (lines.length < 2 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, 'jarvis-helpers');
  assert.deepEqual(lines[1].result.tools.map(t => t.name), ['ask_codex_work']);
});

test('mcp initialize tells the leader how the team works', async () => {
  const handle = createMcpHandler({ config: { accounts, projects: [] }, cwd: 'C:/p', run: async () => ({}) });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.match(init.result.instructions, /leader/i);
  assert.match(init.result.instructions, /ask_codex/);
  assert.match(init.result.instructions, /ask_gemini/);
});


test('mcp reports nonzero helper exit as a notification failure', async () => {
  const notices = [];
  const handle = createMcpHandler({ config: { accounts, projects: [] }, cwd: process.cwd(), notify: (n) => notices.push(n), run: async () => ({ account: 'Codex', answer: 'failed', exitCode: 1 }) });
  await handle({ id: 1, method: 'tools/call', params: { name: 'ask_codex', arguments: { task: 'x'.repeat(170) } } });
  assert.deepEqual(notices, [{ title: 'Jarvis: Ο Codex σταμάτησε με σφάλμα', body: 'x'.repeat(150) }]);
});

test('with personal accounts the leader sees the other enabled helpers', async () => {
  for (const [leader, names, title] of [['claude', ['ask_codex', 'ask_gemini'], 'Claude'], ['codex', ['ask_gemini', 'ask_claude'], 'Codex'], ['agy', ['ask_codex', 'ask_claude'], 'Gemini']]) {
    const handle = createMcpHandler({ config: { accounts, projects: [] }, leader, cwd: process.cwd(), run: async () => ({}) });
    assert.deepEqual((await handle({ id: 1, method: 'tools/list' })).result.tools.map(t => t.name), names);
    assert.match((await handle({ id: 2, method: 'initialize' })).result.instructions, new RegExp(title));
    assert.equal((await handle({ id: 3, method: 'tools/call', params: { name: `ask_${leader === 'agy' ? 'gemini' : leader}` } })).error.code, -32602);
  }
  const handle = createMcpHandler({ config: { accounts: { x: { cli: 'codex', enabled: false, side: 'personal' }, y: { cli: 'agy', enabled: true, side: 'work' } }, projects: [] }, cwd: process.cwd(), run: async () => ({}) });
  assert.deepEqual((await handle({ id: 1, method: 'tools/list' })).result.tools, []);
});

test('a personal Codex leader sees ask_codex_work only with an enabled work Codex account', async () => {
  for (const enabled of [true, false]) {
    const handle = createMcpHandler({
      config: { accounts: { ...accounts, work: { ...workCodex, enabled } }, projects: [] },
      leader: 'codex', cwd: process.cwd(), run: async () => ({}),
    });
    const { result } = await handle({ id: 1, method: 'tools/list' });
    const tool = result.tools.find(t => t.name === 'ask_codex_work');
    assert.equal(Boolean(tool), enabled);
    assert.ok(!result.tools.some(t => t.name === 'ask_codex'));
    if (enabled) {
      assert.match(tool.description, /primary use is TestreaTech work/i);
      assert.match(tool.description, /fallback/);
      assert.deepEqual(tool.inputSchema.required, ['task']);
      assert.equal(tool.inputSchema.properties.task.type, 'string');
      assert.equal(tool.inputSchema.properties.cwd.type, 'string');
    } else {
      const response = await handle({ id: 2, method: 'tools/call', params: { name: 'ask_codex_work', arguments: { task: 'review' } } });
      assert.equal(response.error.code, -32602);
    }
  }
});

test('cwd is passed through and checked against work folders', async () => {
  const work = path.join(process.cwd(), 'work-test');
  const runs = [];
  const notices = [];
  const handle = createMcpHandler({
    config: { accounts: { ...accounts, work: workCodex }, projects: [{ side: 'work', path: work }] },
    cwd: process.cwd(),
    run: async ({ kind, cwd }) => { runs.push({ kind, cwd }); return { answer: 'ok' }; },
    notify: notice => notices.push(notice),
  });
  const call = (name, cwd) => handle({ id: 1, method: 'tools/call', params: { name, arguments: { task: 'x', cwd } } });
  assert.equal((await call('ask_codex', process.cwd())).result.isError, undefined);
  const blocked = await call('ask_codex', work);
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /φάκελος δουλειάς/);
  assert.equal((await call('ask_codex', 'relative')).result.isError, true);
  assert.equal((await call('ask_codex_work', work)).result.isError, undefined);
  assert.deepEqual(runs, [{ kind: 'codex', cwd: process.cwd() }, { kind: 'codex-work', cwd: work }]);
  assert.deepEqual(notices.at(-1), { title: 'Jarvis: Ο Codex Work τελείωσε', body: 'x' });
});
