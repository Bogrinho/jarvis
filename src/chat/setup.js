import os from 'node:os';
import path from 'node:path';
import { buildEnv } from '../policy.js';
import { ChatManager } from './manager.js';
import { CodexAppServer, createCodexAdapter, listCodexThreads } from './codex.js';
import { createClaudeAdapter as realClaudeAdapter, listClaudeSessions } from './claude.js';

// Real chat wiring: one codex app-server per Codex account (lazy, own CODEX_HOME env),
// one claude process per conversation, history listers for both.
export function createChat({ config, indexFile, log = () => {}, deps = {} }) {
  const makeServer = deps.CodexAppServer ?? ((o) => new CodexAppServer(o));
  const makeClaude = deps.createClaudeAdapter ?? realClaudeAdapter;
  const servers = new Map(); // accountId -> CodexAppServer
  const codexServer = (account) => {
    let s = servers.get(account.id);
    if (!s) {
      s = makeServer({ env: buildEnv(account.env ?? {}), log });
      servers.set(account.id, s);
    }
    return s;
  };
  const claudeHome = (account) => buildEnv(account.env ?? {}).CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

  const manager = new ChatManager({
    indexFile,
    adapters: {
      codex: (account, cwd) => createCodexAdapter({ server: codexServer(account), account, cwd }),
      claude: (account, cwd) => makeClaude({ account, cwd, env: buildEnv(account.env ?? {}), claudeHome: claudeHome(account) }),
    },
  });

  async function history({ account, cwd }) {
    if (account.cli === 'codex') return listCodexThreads({ server: codexServer(account), cwd });
    if (account.cli === 'claude') return listClaudeSessions({ claudeHome: claudeHome(account), cwd });
    return [];
  }

  async function closeAll() {
    try { await manager.closeAll(); } catch (e) { log(`chat closeAll: ${e.message}`); }
    for (const s of servers.values()) { try { s.close(); } catch { /* best effort */ } }
    servers.clear();
  }

  return { manager, history, closeAll };
}
