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

async function readRateFile(rateFile, now, fsp) {
  if (!rateFile) return null;
  try {
    const j = JSON.parse(await fsp.readFile(rateFile, 'utf8'));
    const fiveHour = validWindow(j.fiveHour);
    const weekly = validWindow(j.weekly);
    const updatedAt = new Date(j.updatedAt);
    if (!fiveHour || !weekly || Number.isNaN(updatedAt.getTime())) return null;
    const age = now.getTime() - updatedAt.getTime();
    if (age > RATE_MAX_AGE) return null;
    const stale = (w) => (w.resetsAt.getTime() < now.getTime() ? { pct: 0, resetsAt: w.resetsAt, reset: true } : w);
    return { kind: 'percent', fiveHour: stale(fiveHour), weekly: stale(weekly), plan: null, updatedAt };
  } catch {
    return null;
  }
}

async function listJsonl(fsp, dir, cutoffMs, out, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(fsp, full, cutoffMs, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.jsonl')) {
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs >= cutoffMs) out.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
  }
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Parsed entries per file, keyed by path; reused while (mtimeMs, size) are unchanged.
const fileCache = new Map();

async function scanFile(fsx, file) {
  const entries = [];
  const rl = readline.createInterface({ input: fsx.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
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
      entries.push({ ts, id: o.message.id ?? null, tokens });
    }
  } catch {
    /* unreadable file: keep what was parsed */
  }
  return entries;
}

async function sumTokens(fsx, claudeHome, now) {
  const projects = path.join(claudeHome, 'projects');
  try {
    if (!(await fsx.stat(projects)).isDirectory()) return null;
  } catch {
    return null;
  }
  const t = now.getTime();
  const files = [];
  await listJsonl(fsx, projects, t - SEVEN_D, files);
  const seen = new Set(files.map((f) => f.file));
  for (const key of fileCache.keys()) {
    if (key.startsWith(projects) && !seen.has(key)) fileCache.delete(key);
  }
  const byId = new Map(); // streamed duplicates count once (last record wins)
  const anon = [];
  for (const f of files) {
    let c = fileCache.get(f.file);
    if (!c || c.mtimeMs !== f.mtimeMs || c.size !== f.size) {
      c = { mtimeMs: f.mtimeMs, size: f.size, entries: await scanFile(fsx, f.file) };
      fileCache.set(f.file, c);
    }
    for (const e of c.entries) (e.id ? byId.set(e.id, e) : anon.push(e));
  }
  let five = 0;
  let week = 0;
  for (const { ts, tokens } of [...byId.values(), ...anon]) {
    const age = t - ts;
    if (age < 0 || age > SEVEN_D) continue;
    week += tokens;
    if (age <= FIVE_H) five += tokens;
  }
  return { kind: 'tokens', fiveHour: { tokens: five }, weekly: { tokens: week }, updatedAt: now };
}

const defaultFs = { ...fs.promises, createReadStream: fs.createReadStream };

export async function readClaudeUsage({ claudeHome, rateFile, now = new Date(), fs: fsx = defaultFs } = {}) {
  try {
    const pct = await readRateFile(rateFile, now, fsx);
    if (pct) return pct;
    if (!claudeHome) return null;
    return await sumTokens(fsx, claudeHome, now);
  } catch {
    return null;
  }
}
