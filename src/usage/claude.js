import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HOUR = 3600 * 1000;
const RATE_MAX_AGE = 6 * HOUR;
const FIVE_H = 5 * HOUR;
const SEVEN_D = 7 * 24 * HOUR;

function validWindow(w) {
  if (!w || typeof w.pct !== 'number' || !Number.isFinite(w.pct)) return null;
  const resetsAt = new Date(w.resetsAt);
  if (Number.isNaN(resetsAt.getTime())) return null;
  return { pct: w.pct, resetsAt };
}

async function readRateFile(rateFile, now) {
  if (!rateFile) return null;
  try {
    const j = JSON.parse(await fs.promises.readFile(rateFile, 'utf8'));
    const fiveHour = validWindow(j.fiveHour);
    const weekly = validWindow(j.weekly);
    const updatedAt = new Date(j.updatedAt);
    if (!fiveHour || !weekly || Number.isNaN(updatedAt.getTime())) return null;
    const age = now.getTime() - updatedAt.getTime();
    if (age > RATE_MAX_AGE) return null;
    return { kind: 'percent', fiveHour, weekly, plan: null, updatedAt };
  } catch {
    return null;
  }
}

async function listJsonl(dir, cutoffMs, out, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(full, cutoffMs, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.jsonl')) {
      try {
        if ((await fs.promises.stat(full)).mtimeMs >= cutoffMs) out.push(full);
      } catch {
        /* vanished */
      }
    }
  }
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function scanFile(file, entries) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const text of rl) {
      if (!text.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(text);
      } catch {
        continue;
      }
      const u = o?.message?.usage;
      const ts = Date.parse(o?.timestamp);
      if (!u || Number.isNaN(ts)) continue;
      // cache_read tokens are deliberately excluded.
      const tokens = n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens);
      const id = o.message.id;
      entries.set(id ? `id:${id}` : `anon:${entries.size}:${file}`, { ts, tokens });
    }
  } catch {
    /* unreadable file: skip */
  }
}

async function sumTokens(claudeHome, now) {
  const projects = path.join(claudeHome, 'projects');
  try {
    if (!(await fs.promises.stat(projects)).isDirectory()) return null;
  } catch {
    return null;
  }
  const t = now.getTime();
  const files = [];
  await listJsonl(projects, t - SEVEN_D, files);
  const entries = new Map(); // keyed by message id so streamed duplicates count once
  for (const f of files) await scanFile(f, entries);
  let five = 0;
  let week = 0;
  for (const { ts, tokens } of entries.values()) {
    const age = t - ts;
    if (age < 0 || age > SEVEN_D) continue;
    week += tokens;
    if (age <= FIVE_H) five += tokens;
  }
  return { kind: 'tokens', fiveHour: { tokens: five }, weekly: { tokens: week }, updatedAt: now };
}

export async function readClaudeUsage({ claudeHome, rateFile, now = new Date() } = {}) {
  try {
    const pct = await readRateFile(rateFile, now);
    if (pct) return pct;
    if (!claudeHome) return null;
    return await sumTokens(claudeHome, now);
  } catch {
    return null;
  }
}
