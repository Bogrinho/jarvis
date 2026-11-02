#!/usr/bin/env node
// MCP server "jarvis-helpers": lets Claude hand tasks to Codex and Gemini (see src/helpers-mcp.js).
// Claude Code starts it with the project folder as the working directory.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { runHelper } from '../src/helpers.js';
import { createMcpHandler } from '../src/helpers-mcp.js';
import { refreshWindowsPath } from '../src/winpath.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
refreshWindowsPath();
const config = loadConfig(path.join(ROOT, 'jarvis.config.json'));
const handle = createMcpHandler({ config, cwd: process.cwd(), run: runHelper });

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const out = await handle(msg);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
});
rl.on('close', () => process.exit(0));
