import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep every other TOML table byte-for-byte; never replace an existing backup.
export function setupCodexHelpers(codexHome, scriptPath, { shortPath } = {}) {
  if (!codexHome || !path.isAbsolute(codexHome)) throw new Error('Personal CODEX_HOME must be an absolute path');
  const file = path.join(codexHome, 'config.toml');
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let script = shortPath;
  if (!script && process.platform === 'win32') {
    // Shorten only the folder: a short FILE name (HELPER~1.JS) has an upper-case extension
    // that Node's ES module loader rejects.
    const folder = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:JARVIS_HELPERS_DIR).ShortPath'],
    { env: { ...process.env, JARVIS_HELPERS_DIR: path.dirname(scriptPath) }, encoding: 'utf8', windowsHide: true }).trim();
    script = folder ? path.join(folder, path.basename(scriptPath)) : '';
    if (!script || /[^\x00-\x7f]/.test(script)) throw new Error('Could not obtain an ASCII short path');
  }
  script ||= scriptPath;
  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const table = `[mcp_servers.jarvis-helpers]${nl}command = "node"${nl}args = [${JSON.stringify(script)}, "--leader", "codex"]${nl}`;
  const header = /^[ \t]*\[mcp_servers\.jarvis-helpers\][ \t]*(?:#.*)?\r?\n/gm;
  const matches = [...original.matchAll(header)];
  if (matches.length > 1) throw new Error('Duplicate jarvis-helpers tables');
  let updated;
  if (matches.length) {
    const start = matches[0].index;
    const bodyStart = start + matches[0][0].length;
    const next = /^(?=[ \t]*\[)/m.exec(original.slice(bodyStart));
    const end = next ? bodyStart + next.index : original.length;
    updated = original.slice(0, start) + table + original.slice(end);
  } else {
    updated = original + (original && !original.endsWith('\n') ? nl : '') + table;
  }
  if (updated === original) return false;
  fs.mkdirSync(codexHome, { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(`${file}.bak-jarvis`)) fs.copyFileSync(file, `${file}.bak-jarvis`, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(file, updated, 'utf8');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupCodexHelpers(process.env.CODEX_HOME, path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers-mcp.js'));
}
