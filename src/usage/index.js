import os from 'node:os';
import path from 'node:path';
import { readCodexUsage as defaultCodex } from './codex.js';
import { readCodexLive as defaultCodexLive } from './codex-live.js';
import { readClaudeUsage as defaultClaude } from './claude.js';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

const none = (reason) => ({ kind: 'none', reason });

// Live Codex limits cost a short app-server run, so ask at most every 5 minutes per account.
const LIVE_EVERY = 5 * 60 * 1000;
const defaultLiveCache = new Map(); // CODEX_HOME -> { at, value }

const markReset = (w, now) => (w && !w.reset && w.resetsAt.getTime() < now.getTime() ? { pct: 0, resetsAt: w.resetsAt, reset: true } : w);

async function codexLive(home, deps) {
  const hit = deps.liveCache.get(home);
  if (!hit || deps.now.getTime() - hit.at >= LIVE_EVERY) {
    let value = null;
    try { value = await deps.readCodexLive(home, { now: deps.now }); } catch { value = null; }
    deps.liveCache.set(home, { at: deps.now.getTime(), value });
    return value;
  }
  const v = hit.value;
  return v && { ...v, fiveHour: markReset(v.fiveHour, deps.now), weekly: markReset(v.weekly, deps.now) };
}

// The newer of two readings wins: live limits, or session files if Codex just ran here.
function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(b.updatedAt).getTime() > new Date(a.updatedAt).getTime() ? b : a;
}

async function forAccount(account, config, deps) {
  if (account.cli === 'gemini') return none(account.enabled ? 'no local usage data' : 'not set up');
  if (!account.enabled) return none('not set up');
  if (account.cli === 'codex') {
    const home = account.env?.CODEX_HOME;
    if (!home) return none('no CODEX_HOME configured');
    const [file, live] = await Promise.all([
      deps.readCodexUsage(home).catch(() => null),
      codexLive(home, deps),
    ]);
    return newer(file, live) ?? none('no usage data yet');
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
  const d = {
    readCodexUsage: deps.readCodexUsage ?? defaultCodex,
    readCodexLive: deps.readCodexLive ?? defaultCodexLive,
    readClaudeUsage: deps.readClaudeUsage ?? defaultClaude,
    liveCache: deps.liveCache ?? defaultLiveCache,
    now: deps.now ?? new Date(),
  };
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
