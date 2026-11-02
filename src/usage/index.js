import path from 'node:path';
import { readCodexUsage as defaultCodex } from './codex.js';
import { readClaudeUsage as defaultClaude } from './claude.js';

const CLAUDE_HOME = 'C:\Users\stath\.claude';

const none = (reason) => ({ kind: 'none', reason });

async function forAccount(account, config, deps) {
  if (account.cli === 'gemini') return none(account.enabled ? 'no local usage data' : 'not set up');
  if (!account.enabled) return none('not set up');
  if (account.cli === 'codex') {
    const home = account.env?.CODEX_HOME;
    if (!home) return none('no CODEX_HOME configured');
    return (await deps.readCodexUsage(home)) ?? none('no usage data yet');
  }
  if (account.cli === 'claude') {
    const u = await deps.readClaudeUsage({
      claudeHome: CLAUDE_HOME,
      rateFile: path.join(config.rootDir, 'data', 'claude-rate.json'),
    });
    return u ?? none('no usage data yet');
  }
  return none('no local usage data');
}

export async function collectUsage(config, deps = {}) {
  const d = { readCodexUsage: deps.readCodexUsage ?? defaultCodex, readClaudeUsage: deps.readClaudeUsage ?? defaultClaude };
  const result = {};
  await Promise.all(
    Object.values(config.accounts).map(async (account) => {
      try {
        result[account.id] = await forAccount(account, config, d);
      } catch {
        result[account.id] = none('usage unavailable');
      }
    }),
  );
  return result;
}
