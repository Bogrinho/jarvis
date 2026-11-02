// Windows: a program installed after login (e.g. via winget) is only on the PATH stored in
// the registry, not on the PATH Jarvis inherited. Merge the stored PATH in at startup.
import { execFileSync } from 'node:child_process';

export function mergePath(current, stored) {
  const seen = new Set();
  const out = [];
  for (const p of `${current ?? ''};${stored ?? ''}`.split(';')) {
    const t = p.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.join(';');
}

export function refreshWindowsPath({ env = process.env, exec = execFileSync } = {}) {
  if (process.platform !== 'win32') return false;
  try {
    const stored = String(exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
    { encoding: 'utf8', timeout: 10000, windowsHide: true })).trim();
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
    env[key] = mergePath(env[key], stored);
    return true;
  } catch {
    return false;
  }
}
