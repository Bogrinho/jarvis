import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY_MS = 86_400_000;
const KEEP_MS = 14 * DAY_MS;
const MIN_GAP_MS = 15 * 60_000;
const MIN_SPAN_MS = 6 * 3_600_000;

async function load(file, io = fsp) {
  try {
    const data = JSON.parse(await io.readFile(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function save(file, data, io) {
  await io.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await io.writeFile(tmp, JSON.stringify(data), 'utf8');
    await io.rename(tmp, file);
  } catch (e) {
    try { await io.unlink(tmp); } catch { /* best effort */ }
    throw e;
  }
}

// `io` (fs/promises-like) is injectable for tests.
export async function appendSnapshot(file, accountId, pct, at, io = fsp) {
  const t = at.getTime();
  const data = await load(file, io);
  const stored = Array.isArray(data[accountId]) ? data[accountId] : null;
  const list = (stored ?? []).filter(p => p && Number.isFinite(p.at) && t - p.at <= KEEP_MS);
  let changed = stored === null || list.length !== stored.length;
  const last = list[list.length - 1];
  if (!last || t - last.at >= MIN_GAP_MS) {
    list.push({ at: t, pct });
    changed = true;
  }
  if (!changed) return;
  data[accountId] = list;
  await save(file, data, io);
}

export async function getSeries(file, accountId, days = 7, now = new Date()) {
  const from = now.getTime() - days * DAY_MS;
  const list = (await load(file))[accountId];
  if (!Array.isArray(list)) return [];
  return list
    .filter(p => p && Number.isFinite(p.at) && p.at >= from)
    .map(p => ({ at: new Date(p.at), pct: p.pct }));
}

export function perDayRate(series) {
  let start = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].pct < series[i - 1].pct) start = i;
  }
  const seg = series.slice(start);
  if (seg.length < 2) return null;
  const first = seg[0];
  const last = seg[seg.length - 1];
  const span = last.at.getTime() - first.at.getTime();
  if (span < MIN_SPAN_MS) return null;
  const rate = (last.pct - first.pct) / (span / DAY_MS);
  return Math.round(rate * 10) / 10;
}
