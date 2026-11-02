import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '../src/helpers-mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('mcp: initialize, list tools, call a tool, report errors', async () => {
  const runs = [];
  const handle = createMcpHandler({
    config: { accounts: {}, projects: [] },
    cwd: 'C:/proj',
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
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } })).error.code, -32602);
  assert.equal((await handle({ jsonrpc: '2.0', id: 6, method: 'nope' })).error.code, -32601);
});

test('mcp script starts and answers over stdio', async () => {
  const child = spawn(process.execPath, [path.join(here, '..', 'scripts', 'helpers-mcp.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const t0 = Date.now();
  while (lines.length < 2 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, 'jarvis-helpers');
  assert.equal(lines[1].result.tools.length, 2);
});
