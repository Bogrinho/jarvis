// Helpers for a leader AI: run Codex or Gemini (Antigravity) once, non-interactively, on a
// task in a folder, and return their final answer. Uses the Jarvis account settings:
// the personal Codex login (its own CODEX_HOME), no API keys, edits only inside the folder.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildEnv } from './policy.js';

export const HELPER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT = 200 * 1024;

const norm = (p) => path.resolve(p).toLowerCase();
const within = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The account a helper runs as: personal side only, enabled, the right CLI.
export function helperAccount(config, kind) {
  const want = kind === 'codex' ? ['codex'] : ['agy'];
  const acc = Object.values(config.accounts).find((a) => a.enabled && a.side === 'personal' && want.includes(a.cli));
  if (!acc) throw new Error(kind === 'codex' ? 'Δεν υπάρχει ενεργός προσωπικός λογαριασμός Codex στο Jarvis' : 'Δεν υπάρχει ενεργός λογαριασμός Gemini (Antigravity) στο Jarvis');
  return acc;
}

// Never run a personal helper inside a work folder.
export function checkFolder(config, cwd) {
  for (const p of config.projects) {
    if (p.side === 'work' && within(cwd, p.path)) throw new Error(`Ο φάκελος ${cwd} είναι φάκελος δουλειάς`);
  }
  for (const a of Object.values(config.accounts)) {
    if (a.side === 'work' && a.home && within(cwd, a.home)) throw new Error(`Ο φάκελος ${cwd} είναι φάκελος δουλειάς`);
  }
}

// Exact command lines (verified against codex-cli 0.166.0 and agy 1.4.12 --help).
export function helperLaunch(account, cwd, outFile) {
  const env = buildEnv(account.env ?? {});
  if (account.cli === 'codex') {
    const sandbox = account.mode === 'edit-in-project' ? 'workspace-write' : 'read-only';
    // The task goes in on stdin ("-"), so no user text ever passes through cmd.exe.
    const args = ['exec', '-s', sandbox, '-C', cwd, '--skip-git-repo-check', '--color', 'never', '-o', outFile, '-'];
    if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'codex', ...args], env, stdin: true };
    return { file: 'codex', args, env, stdin: true };
  }
  if (account.cli === 'agy') {
    const mode = account.mode === 'edit-in-project' ? ['--mode', 'accept-edits'] : [];
    // agy is a real .exe: Node passes the task as one argument, no shell involved.
    return { file: 'agy', args: [...mode, '--output-format', 'text', '-p'], env, stdin: false, promptArg: true };
  }
  throw new Error(`unsupported helper cli ${account.cli}`);
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try { cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch { /* ignore */ }
  }
  try { child.kill(); } catch { /* ignore */ }
}

export function runHelper({ config, kind, task, cwd, spawn = cp.spawn, timeoutMs = HELPER_TIMEOUT_MS, tmpDir = os.tmpdir() }) {
  return new Promise((resolve, reject) => {
    if (typeof task !== 'string' || !task.trim()) return reject(new Error('Λείπει η εργασία (task)'));
    let account;
    try {
      account = helperAccount(config, kind);
      checkFolder(config, cwd);
    } catch (e) { return reject(e); }
    const outFile = path.join(tmpDir, `jarvis-helper-${crypto.randomBytes(6).toString('hex')}.txt`);
    const l = helperLaunch(account, cwd, outFile);
    const args = l.promptArg ? [...l.args, task] : l.args;
    let child;
    try {
      child = spawn(l.file, args, { cwd, env: l.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return reject(e); }
    let out = '';
    let err = '';
    const add = (s, d) => (s.length < MAX_OUTPUT ? s + d : s);
    child.stdout?.on('data', (d) => { out = add(out, String(d)); });
    child.stderr?.on('data', (d) => { err = add(err, String(d)); });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child);
      reject(new Error(`Ο βοηθός δεν τελείωσε σε ${Math.round(timeoutMs / 60000)} λεπτά και σταμάτησε`));
    }, timeoutMs);
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let answer = '';
      try { answer = fs.readFileSync(outFile, 'utf8'); } catch { answer = ''; }
      try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
      if (!answer.trim()) answer = out;
      answer = answer.trim();
      if (code !== 0 && !answer) return reject(new Error(`Ο βοηθός σταμάτησε με σφάλμα (κωδικός ${code}): ${err.trim().slice(-800)}`));
      resolve({ account: account.label, answer: answer || '(καμία απάντηση)', exitCode: code });
    });
    if (l.stdin) child.stdin?.end(task); else child.stdin?.end();
  });
}
