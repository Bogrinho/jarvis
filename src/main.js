import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { JobManager } from './jobs.js';
import { createServer } from './server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noOpen = process.argv.includes('--no-open');

const config = loadConfig(path.join(ROOT, 'jarvis.config.json'));
const dataDir = path.join(config.rootDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'server.log');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(logFile, line, 'utf8'); } catch { /* logging must never crash */ }
}

const url = `http://127.0.0.1:${config.port}/`;

function openBrowser() {
  if (noOpen) return;
  try {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
      detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true,
    });
    child.on('error', (e) => log(`open browser failed: ${e.message}`));
    child.unref();
  } catch (e) {
    log(`open browser failed: ${e.message}`);
  }
}

async function pingExisting() {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.text()) === 'jarvis';
  } catch {
    return false;
  }
}

// Token lives only in memory; the served index.html carries it to the HUD.
const token = crypto.randomBytes(32).toString('hex');
const jobs = new JobManager();
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  try { await jobs.killAll(); } catch { /* best effort */ }
  // node-pty tears ConPTY down via short-lived helper processes; calling process.exit while one
  // is still running hangs node on Windows (port stays bound). Wait for them, but not forever.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && process.getActiveResourcesInfo().includes('ProcessWrap')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  process.exit(code);
}

const server = createServer({ config, jobs, token, onShutdown: () => shutdown(0), deps: { log } });

process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack ?? e}`));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  await server.listen();
  log(`listening on ${url}`);
  console.log(`Jarvis listening on ${url}`);
  openBrowser();
} catch (e) {
  if (e?.code === 'EADDRINUSE' && (await pingExisting())) {
    openBrowser();
    console.log('Jarvis already running');
    process.exit(0);
  }
  log(`listen failed: ${e?.stack ?? e}`);
  console.error(`Jarvis could not start: ${e?.code ?? e?.message ?? e} (see ${logFile})`);
  process.exit(1);
}
