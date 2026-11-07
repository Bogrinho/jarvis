import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const restartFile = (rootDir) => path.join(rootDir, 'data', 'restart.json');

export async function saveRestart(rootDir, jobs) {
  const file = restartFile(rootDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(jobs.map(({ accountId, cwd, title }) => ({ accountId, cwd, title }))), 'utf8');
}

export function relaunchJarvis() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js'), '--restored', '--no-open'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function restoreJobs({ rootDir, start, log = () => {} }) {
  const file = restartFile(rootDir);
  let saved;
  try { saved = await readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  await unlink(file);
  let entries;
  try {
    entries = JSON.parse(saved);
    if (!Array.isArray(entries)) throw new Error('expected an array');
  } catch (e) { log(`restart file: ${e.message}`); return; }
  for (const entry of entries) {
    try { await start(entry); }
    catch (e) { log(`restore terminal: ${e.message}`); }
  }
}
