import fsDefault from 'node:fs';
import path from 'node:path';

const MAX_FILES = 20;
const TAIL_BYTES = 2 * 1024 * 1024;

// Only files under <codexHome>/sessions ending in .jsonl are ever opened.
async function listJsonl(fs, dir, out, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(fs, full, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.jsonl')) {
      try {
        out.push({ file: full, mtime: (await fs.stat(full)).mtimeMs });
      } catch {
        /* vanished; skip */
      }
    }
  }
}

async function readTail(fs, file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally {
    await fh.close();
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toWindow(w) {
  if (!w) return null;
  const pct = num(w.used_percent);
  const reset = num(w.resets_at);
  if (pct === null || reset === null) return null;
  return { pct, resetsAt: new Date(reset * 1000) };
}

function parseLine(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  const rl = obj?.payload?.rate_limits ?? obj?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const fiveHour = toWindow(rl.primary);
  const weekly = toWindow(rl.secondary);
  const updatedAt = new Date(obj.timestamp);
  if (!fiveHour || !weekly || Number.isNaN(updatedAt.getTime())) return null;
  return {
    kind: 'percent',
    fiveHour,
    weekly,
    plan: typeof rl.plan_type === 'string' ? rl.plan_type : null,
    updatedAt,
  };
}

export async function readCodexUsage(codexHome, { fs = fsDefault.promises } = {}) {
  if (!codexHome) return null;
  try {
    const files = [];
    await listJsonl(fs, path.join(codexHome, 'sessions'), files);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { file } of files.slice(0, MAX_FILES)) {
      let text;
      try {
        text = await readTail(fs, file);
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        const r = parseLine(lines[i]);
        if (r) return r;
      }
    }
    return null;
  } catch {
    return null;
  }
}
