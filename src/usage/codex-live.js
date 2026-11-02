// Live Codex limits: asks `codex app-server` (account/rateLimits/read) for the account's
// current 5h and weekly usage. Session files only update when Codex runs on this PC;
// this works even when the account is used elsewhere (e.g. the ChatGPT app).
// It only reads usage; it never starts a conversation.
import cp from 'node:child_process';
import { buildEnv } from '../policy.js';

function toWindow(w, now) {
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  if (typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt)) return null;
  const resetsAt = new Date(w.resetsAt * 1000);
  return resetsAt.getTime() < now.getTime() ? { pct: 0, resetsAt, reset: true } : { pct: w.usedPercent, resetsAt };
}

function kill(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    // cmd.exe wrapper: kill the whole tree, not just the shell.
    try {
      cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { try { child.kill(); } catch { /* ignore */ } });
    } catch { /* ignore */ }
  }
  try { child.kill(); } catch { /* ignore */ }
}

export function readCodexLive(codexHome, { spawn = cp.spawn, now = new Date(), timeoutMs = 20000, codexCmd = 'codex' } = {}) {
  if (!codexHome) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill(child);
      resolve(value);
    };
    try {
      const env = buildEnv({ CODEX_HOME: codexHome });
      const [f, a] = process.platform === 'win32'
        ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', codexCmd, 'app-server']]
        : [codexCmd, ['app-server']];
      child = spawn(f, a, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { finish(null); } };
    child.on?.('error', () => finish(null));
    child.on?.('exit', () => finish(null));
    child.stdin.on?.('error', () => finish(null));
    child.stderr?.on?.('data', () => { /* drained */ });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(null);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2) {
          const rl = m.result?.rateLimits;
          const fiveHour = toWindow(rl?.primary, now);
          const weekly = toWindow(rl?.secondary, now);
          if (m.error || !fiveHour || !weekly) return finish(null);
          return finish({ kind: 'percent', fiveHour, weekly, plan: typeof rl.planType === 'string' ? rl.planType : null, updatedAt: now });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'jarvis', title: 'Jarvis', version: '1' }, capabilities: null } });
  });
}
