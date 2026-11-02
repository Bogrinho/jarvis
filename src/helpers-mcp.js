// A tiny MCP server (JSON-RPC over stdio, one message per line) that gives a leader AI
// (Claude) two tools: ask_codex and ask_gemini. Each runs the helper once in the leader's
// folder and returns its final answer.
const TOOLS = [
  {
    name: 'ask_codex',
    description:
      'Give a task to Codex (the user\'s personal OpenAI Codex account) and get its final answer. ' +
      'Codex works in the same folder as you and can read and edit files there. Use it for a second ' +
      'opinion, a code review, or to hand off a well-defined part of the work. Write the task so it ' +
      'stands alone: Codex does not see this conversation. It can take several minutes.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The full task for Codex, self-contained.' } },
      required: ['task'],
    },
  },
  {
    name: 'ask_gemini',
    description:
      'Give a task to Gemini (the user\'s Google AI Pro account, via the Antigravity CLI) and get its final ' +
      'answer. Gemini works in the same folder as you and can read and edit files there (it cannot run ' +
      'shell commands here). Use it for a second opinion, research-style questions, or a separate part of ' +
      'the work. Write the task so it stands alone: Gemini does not see this conversation.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The full task for Gemini, self-contained.' } },
      required: ['task'],
    },
  },
];

export function createMcpHandler({ config, cwd, run }) {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const { id, method, params } = msg;
    const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'jarvis-helpers', version: '1.0.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        const kind = name === 'ask_codex' ? 'codex' : name === 'ask_gemini' ? 'gemini' : null;
        if (!kind) return fail(-32602, `unknown tool ${name}`);
        try {
          const r = await run({ config, kind, task: params?.arguments?.task, cwd });
          return reply({ content: [{ type: 'text', text: `[${r.account}]\n${r.answer}` }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `Σφάλμα: ${e.message}` }], isError: true });
        }
      }
      default:
        if (typeof method === 'string' && method.startsWith('notifications/')) return null;
        return fail(-32601, `method not found: ${method}`);
    }
  };
}

export { TOOLS };
