// Run a helper once in the task folder using its configured Jarvis account.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildEnv } from './policy.js';

export const HELPER_TIMEOUT_MS = 15 * 60 * 1000;

export function isLimitFailure(kind, message) {
  if (kind === 'gemini') return /quota|resource.?exhausted|rate[ -]limit|\b429\b/i.test(message);
  return ['codex', 'codex-work'].includes(kind) && /usage limit|rate[ -]limit|quota/i.test(message);
}

// Headless agy auto-denies shell commands and then stops with no answer, so steer it to
// its own file tools up front.
const CODEX_PREAMBLE =
  'You are a helper: the task below comes from the team leader. Do exactly the task, stay inside this ' +
  'folder, run the relevant tests when you change code and report the results honestly. Do not commit or push. ' +
  'End with a short report: what you did, files changed, test results, anything left open.\n\n';

const GEMINI_PREAMBLE =
  'You are running headless: shell commands (run_command) are not allowed and will be denied. ' +
  'Use your file tools instead: list_dir, find_by_name, grep_search, view_file (and edit tools only if the task asks for changes). ' +
  'Always finish with a written answer.\n\n';
const MAX_OUTPUT = 200 * 1024;

const norm = (p) => path.resolve(p).toLowerCase();
const within = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function helperAccount(config, kind) {
  const cli = ({ gemini: 'agy', 'codex-work': 'codex' })[kind] ?? kind;
  if (!['codex', 'agy', 'claude'].includes(cli)) throw new Error(`unsupported helper kind ${kind}`);
  const side = kind === 'codex-work' ? 'work' : 'personal';
  const acc = Object.values(config.accounts).find((a) => a.enabled && a.side === side && a.cli === cli);
  if (acc) return acc;
  if (kind === 'codex-work') throw new Error('Δεν υπάρχει ενεργός εταιρικός λογαριασμός Codex στο Jarvis');
  if (cli === 'codex') throw new Error('Δεν υπάρχει ενεργός προσωπικός λογαριασμός Codex στο Jarvis');
  if (cli === 'claude') throw new Error('No enabled personal Claude account in Jarvis');
  throw new Error('Δεν υπάρχει ενεργός λογαριασμός Gemini (Antigravity) στο Jarvis');
}

// Never run a personal helper inside a work folder.
export function checkFolder(config, cwd, kind) {
  if (kind === 'codex-work') return;
  for (const p of config.projects) {
    if (p.side === 'work' && within(cwd, p.path)) throw new Error(`Ο φάκελος ${cwd} είναι φάκελος δουλειάς`);
  }
  for (const a of Object.values(config.accounts)) {
    if (a.side === 'work' && a.home && within(cwd, a.home)) throw new Error(`Ο φάκελος ${cwd} είναι φάκελος δουλειάς`);
  }
}

// Exact command lines (verified against codex-cli 0.166.0 and agy 1.4.12 --help).
// A node_modules that is a link to a folder outside the project (e.g. a Windows junction):
// builds write there (Vite's temp config), so the Codex sandbox must be allowed to.
// Skips paths with characters cmd.exe would treat specially.
function linkedNodeModules(cwd) {
  try {
    const p = path.join(cwd, 'node_modules');
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    const real = fs.realpathSync(p);
    if (within(real, cwd) || /["&|<>^%]/.test(real)) return null;
    return real;
  } catch {
    return null;
  }
}

export function helperLaunch(account, cwd, outFile) {
  const env = buildEnv(account.env ?? {});
  if (account.cli === 'codex') {
    const sandbox = account.mode !== 'cautious' ? 'workspace-write' : 'read-only';
    // The task goes in on stdin ("-"), so no user text ever passes through cmd.exe.
    const extra = sandbox === 'workspace-write' ? linkedNodeModules(cwd) : null;
    const args = ['exec', '-s', sandbox, '-C', cwd, ...(extra ? ['--add-dir', extra] : []), '--skip-git-repo-check', '--color', 'never', '-o', outFile, '-'];
    if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'codex', ...args], env, stdin: true };
    return { file: 'codex', args, env, stdin: true };
  }
  if (account.cli === 'claude') {
    const args = ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text'];
    if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'claude', ...args], env, stdin: true };
    return { file: 'claude', args, env, stdin: true };
  }
  if (account.cli === 'agy') {
    const mode = account.mode !== 'cautious' ? ['--mode', 'accept-edits'] : [];
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

// Headless Gemini sometimes ends with no answer at all; one retry usually works.
export async function runHelper(opts) {
  try {
    return await runOnce(opts);
  } catch (e) {
    if (opts.kind !== 'gemini' || isLimitFailure(opts.kind, e.message) || !/δεν έδωσε απάντηση/.test(e.message)) throw e;
    return runOnce(opts);
  }
}

function runOnce({ config, kind, task, cwd, spawn = cp.spawn, timeoutMs = HELPER_TIMEOUT_MS, tmpDir = os.tmpdir() }) {
  return new Promise((resolve, reject) => {
    if (typeof task !== 'string' || !task.trim()) return reject(new Error('Λείπει η εργασία (task)'));
    let account;
    try {
      account = helperAccount(config, kind);
      checkFolder(config, cwd, kind);
    } catch (e) { return reject(e); }
    const outFile = path.join(tmpDir, `jarvis-helper-${crypto.randomBytes(6).toString('hex')}.txt`);
    const l = helperLaunch(account, cwd, outFile);
    const args = l.promptArg ? [...l.args, (kind === 'gemini' ? GEMINI_PREAMBLE : '') + task] : l.args;
    let child;
    try {
      child = spawn(l.file, args, { cwd, env: l.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return reject(e); }
    let out = '';
    let err = '';
    const add = (s, d) => (s.length < MAX_OUTPUT ? s + d : s);
    child.stdout?.on('data', (d) => { out = add(out, String(d)); });
    child.stderr?.on('data', (d) => { err = (err + String(d)).slice(-MAX_OUTPUT); });
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
      if (code !== 0 || !answer) {
        // Codex can echo the prompt on stderr before its diagnostic.
        if (l.stdin) err = err.split(CODEX_PREAMBLE + task).at(-1);
        const failure = [err, out, answer].find(text => isLimitFailure(kind, text));
        if (failure) return reject(new Error(failure.trim()));
      }
      if (!answer) return reject(new Error(`Ο βοηθός δεν έδωσε απάντηση (κωδικός ${code}): ${err.trim().slice(-800) || 'χωρίς μήνυμα'}`));
      resolve({ account: account.label, answer, exitCode: code });
    });
    if (l.stdin) child.stdin?.end(CODEX_PREAMBLE + task); else child.stdin?.end();
  });
}
