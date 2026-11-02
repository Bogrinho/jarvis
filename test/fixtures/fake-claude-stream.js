// Fake `claude -p --input-format stream-json --output-format stream-json ...` for adapter
// tests. Speaks the shapes observed from Claude Code 2.1.316 (see task-3 report).
// Reads one JSON object per stdin line; the text of each user message picks a scenario:
//   "hello"        -> partial text deltas + final assistant text, result success
//   "silent-text"  -> assistant text without partial stream events
//   "bash"         -> Bash tool_use ok (npm test) and failing (npm run lint)
//   "tools"        -> Read, Glob, Grep, Edit (old/new), Write (content only) tool_uses + results
//   "perm <cmd>"   -> can_use_tool Bash <cmd>; replies with the received response as text
//   "perm-cancel"  -> can_use_tool, then control_cancel_request for it, then result
//   "unknown-ctl"  -> an unsupported control_request; echoes the response
//   "wait-int"     -> waits for an interrupt control_request, answers it, result error
//   "fail"         -> result with is_error
//   "crash"        -> a delta, then exit code 3 mid-turn
// Session id: --session-id / --resume value, or FAKE_FORK_SID when set (a resumed copy).
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const argAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const SID = process.env.FAKE_FORK_SID || argAfter('--session-id') || argAfter('--resume') || randomUUID();
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const waiting = new Map(); // control request id -> resolve(response envelope)
let interruptWaiter = null;
let queue = Promise.resolve();

const ev = (event) => send({ type: 'stream_event', event, parent_tool_use_id: null, uuid: randomUUID(), session_id: SID });
const assistant = (content) => send({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, session_id: SID, uuid: randomUUID() });
const toolResult = (id, content, isError) => send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content, is_error: isError, tool_use_id: id }] }, parent_tool_use_id: null, session_id: SID, uuid: randomUUID() });
const result = (extra = {}) => send({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: SID, uuid: randomUUID(), ...extra });
const text = (t) => assistant([{ type: 'text', text: t }]);
const ask = (request) => new Promise((resolve) => {
  const request_id = randomUUID();
  waiting.set(request_id, resolve);
  send({ type: 'control_request', request_id, request });
  return request_id;
});

async function run(userText) {
  send({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: SID, tools: [], permissionMode: argAfter('--permission-mode'), uuid: randomUUID() });
  if (userText === 'hello') {
    ev({ type: 'message_start', message: {} });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo there' } });
    text('Hello there');
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_stop' });
    return result({ result: 'Hello there' });
  }
  if (userText === 'silent-text') { text('no stream'); return result(); }
  if (userText === 'bash') {
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }]);
    toolResult('t1', 'ok', false);
    assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run lint' } }]);
    toolResult('t2', 'Exit code 1', true);
    return result();
  }
  if (userText === 'tools') {
    assistant([
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'C:\\proj\\a.js' } },
      { type: 'tool_use', id: 'g1', name: 'Glob', input: { pattern: '**/*.js' } },
      { type: 'tool_use', id: 'g2', name: 'Grep', input: { pattern: 'TODO' } },
    ]);
    toolResult('r1', 'x', false); toolResult('g1', 'x', false); toolResult('g2', 'x', false);
    assistant([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'C:\\proj\\a.js', old_string: 'a\nb', new_string: 'a\nc\nd' } }]);
    toolResult('e1', 'ok', false);
    assistant([{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'C:\\proj\\new.js', content: 'x' } }]);
    toolResult('w1', 'ok', false);
    return result();
  }
  if (userText.startsWith('perm ')) {
    const command = userText.slice(5);
    const resp = await ask({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command, description: 'Clean build' }, description: 'Clean build', tool_use_id: 'tp' });
    text('response=' + JSON.stringify(resp));
    return result();
  }
  if (userText === 'perm-cancel') {
    const request_id = randomUUID();
    send({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'x', content: 'y' }, tool_use_id: 'tc' } });
    await new Promise(r => setTimeout(r, 50));
    send({ type: 'control_cancel_request', request_id });
    await new Promise(r => setTimeout(r, 50));
    return result();
  }
  if (userText === 'unknown-ctl') {
    const resp = await ask({ subtype: 'hook_callback', callback_id: 'x', input: {} });
    text('response=' + JSON.stringify(resp));
    return result();
  }
  if (userText === 'wait-int') {
    const got = new Promise(r => { interruptWaiter = r; });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'waiting' } });
    const req = await got;
    send({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: {} } });
    return result({ subtype: 'error_during_execution', is_error: true, result: undefined });
  }
  if (userText === 'fail') return result({ subtype: 'error_during_execution', is_error: true, result: 'boom' });
  if (userText === 'crash') {
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } });
    setTimeout(() => process.exit(3), 20);
    return new Promise(() => {});
  }
  text('echo:' + userText);
  return result();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_response') {
    const r = waiting.get(m.response?.request_id);
    if (r) { waiting.delete(m.response.request_id); r(m.response); }
    return;
  }
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    if (interruptWaiter) { const w = interruptWaiter; interruptWaiter = null; w(m); }
    else send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type === 'user') {
    const c = m.message?.content;
    const t = typeof c === 'string' ? c : (c ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    queue = queue.then(() => run(t));
  }
});
rl.on('close', () => process.exit(0));
