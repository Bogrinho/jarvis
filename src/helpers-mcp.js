import path from 'node:path';
import { checkFolder, helperAccount, isLimitFailure } from './helpers.js';
import { notify as defaultNotify } from './notify.js';

// A tiny MCP server (JSON-RPC over stdio, one message per line) that gives a leader AI
// the available helpers. Each runs once in the leader's
// folder and returns its final answer.
const TOOLS = [
  {
    name: 'ask_codex',
    description:
      'Give a task to Codex (the user\'s personal OpenAI Codex account) and get its final answer. ' +
      'Codex works in the same folder as you and can read and edit files there. Use it for a second ' +
      'opinion, a code review, or to hand off a well-defined part of the work. Write the task so it ' +
      'stands alone: Codex does not see this conversation. On usage limits it tries Codex Work, then Gemini.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The full task for Codex, self-contained.' } },
      required: ['task'],
    },
  },
  {
    name: 'ask_codex_work',
    description: 'Give a self-contained coding task to Codex Work. Its primary use is TestreaTech work. It is also used automatically as a fallback when personal Codex reaches its usage limit. On its own limit it tries Gemini.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The full task for Codex Work, self-contained.' } },
      required: ['task'],
    },
  },
  {
    name: 'ask_gemini',
    description:
      'Give a task to Gemini (the user\'s Google AI Pro account, via the Antigravity CLI) and get its final ' +
      'answer. Gemini works in the same folder as you and can read and edit files there (it cannot run ' +
      'shell commands here). Use it for a second opinion, research-style questions, or a separate part of ' +
      'the work. Write the task so it stands alone: Gemini does not see this conversation. On usage limits it tries personal Codex, then Codex Work.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The full task for Gemini, self-contained.' } },
      required: ['task'],
    },
  },
];

const HELPERS = [
  { name: 'Codex', tool: 'ask_codex', kind: 'codex', cli: 'codex', side: 'personal', skills: 'code, tests, bugs and review' },
  { name: 'Codex Work', tool: 'ask_codex_work', kind: 'codex-work', cli: 'codex', side: 'work', skills: 'TestreaTech company work: code, tests, bugs and review' },
  { name: 'Gemini', tool: 'ask_gemini', kind: 'gemini', cli: 'agy', side: 'personal', skills: 'research, second opinions, long reading and writing; cannot run commands' },
  { name: 'Claude', tool: 'ask_claude', kind: 'claude', cli: 'claude', side: 'personal', skills: 'careful reasoning, planning, review and writing' },
];
TOOLS.push({ name: 'ask_claude', description: 'Give a self-contained task to Claude for careful reasoning, planning, review or writing.', inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'The full task for Claude.' } }, required: ['task'] } });
for (const tool of TOOLS) {
  tool.description += ' Pass your current folder as the absolute cwd argument.';
  tool.inputSchema.properties.cwd = { type: 'string', description: 'Your current folder, as an absolute path.' };
}

const fallbackOrder = {
  codex: ['codex', 'codex-work', 'gemini'],
  'codex-work': ['codex-work', 'gemini'],
  gemini: ['gemini', 'codex', 'codex-work'],
};

function retryTime(message, now) {
  const date = /try again at\s+([^\n.!?]+)/i.exec(message)?.[1];
  const parsed = date && Date.parse(date.replace(/(\d)(st|nd|rd|th)\b/gi, '$1').trim());
  return parsed > now ? parsed : now + 3600000;
}

export function createMcpHandler({ config, cwd, run, leader = 'claude', notify = defaultNotify, now = Date.now }) {
  const teamLeader = HELPERS.find(h => h.cli === leader && h.side === 'personal');
  if (!teamLeader) throw new Error(`Invalid leader ${leader}`);
  const accounts = Object.values(config.accounts ?? {});
  const available = HELPERS.filter(h => h !== teamLeader &&
    accounts.some(a => a.enabled && a.cli === h.cli && a.side === h.side));
  const tools = TOOLS.filter(t => available.some(h => h.tool === t.name));
  const instructions = `You are the team leader (${teamLeader.name}). Available helpers: ${available.map(h => `${h.tool} (${h.name}): ${h.skills}`).join('; ') || 'none'}. On usage limits, Codex and Gemini automatically fall back to available helpers allowed in the folder. The answer header identifies who answered. Give each a self-contained task and your current folder. Verify their work and tests. Helpers never commit; commit only when the user asks.`;
  const limitedUntil = new Map();

  async function runWithFallback(helper, task, folder) {
    checkFolder(config, folder, helper.kind);
    if (typeof task !== 'string' || !task.trim()) throw new Error('Λείπει η εργασία (task)');
    const limited = [];
    for (const kind of fallbackOrder[helper.kind] ?? [helper.kind]) {
      const candidate = available.find(h => h.kind === kind);
      if (!candidate) continue;
      if (kind !== helper.kind) {
        try { checkFolder(config, folder, kind); } catch { continue; }
      }
      const label = helperAccount(config, kind).label ?? (kind === 'codex' ? 'Codex Personal' : candidate.name);
      let until = limitedUntil.get(kind);
      if (!(until > now())) {
        const prompt = kind === 'gemini' && kind !== helper.kind
          ? 'You cannot run shell commands. List the checks the leader must run.\n\n' + task : task;
        try {
          const r = await run({ config, kind, task: prompt, cwd: folder });
          if (r.exitCode && isLimitFailure(kind, r.answer)) throw new Error(r.answer);
          const reasons = limited.map(l => l.label + ' hit its usage limit').join(', ');
          return { ...r, header: `[${r.account ?? label}${reasons ? ' — fallback: ' + reasons : ''}]`, helperName: candidate.name };
        } catch (e) {
          if (!isLimitFailure(kind, e.message)) throw e;
          until = retryTime(e.message, now());
          limitedUntil.set(kind, until);
        }
      }
      limited.push({ label, until });
    }
    throw new Error('Όλοι οι διαθέσιμοι βοηθοί έφτασαν το όριο χρήσης / All eligible helpers reached their usage limit. Retry at ' +
      limited.map(l => l.label + ': ' + new Date(l.until).toISOString()).join(', '));
  }
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
          instructions,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools });
      case 'tools/call': {
        const name = params?.name;
        const helper = available.find(h => h.tool === name);
        const kind = helper?.kind;
        if (!kind) return fail(-32602, `unknown tool ${name}`);
        const task = params?.arguments?.task;
        const finished = (failed, helperName = helper.name) => {
          try { notify({ title: `Jarvis: Ο ${helperName} ${failed ? 'σταμάτησε με σφάλμα' : 'τελείωσε'}`, body: typeof task === 'string' ? Array.from(task).slice(0, 150).join('') : '' }); } catch { /* ignore notification failures */ }
        };
        try {
          const folder = params?.arguments?.cwd === undefined ? cwd : params.arguments.cwd;
          if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('cwd must be an absolute folder path');
          const r = await runWithFallback(helper, task, folder);
          finished(r.exitCode != null && r.exitCode !== 0, r.helperName);
          return reply({ content: [{ type: 'text', text: `${r.header}\n${r.answer}` }] });
        } catch (e) {
          finished(true);
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
