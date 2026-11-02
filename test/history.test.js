import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSnapshot, getSeries, perDayRate } from '../src/usage/history.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
async function tmpFile() {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-hist-'));
  return join(dir, 'sub', 'history.json');
}
const pt = (i, pct) => ({ at: new Date(T0 + i * DAY), pct });

test('throttles to one point per 15 minutes', async () => {
  const f = await tmpFile();
  await appendSnapshot(f, 'a', 10, new Date(T0));
  await appendSnapshot(f, 'a', 11, new Date(T0 + 5 * 60_000));
  await appendSnapshot(f, 'a', 12, new Date(T0 + 15 * 60_000));
  const s = await getSeries(f, 'a', 7, new Date(T0 + 20 * 60_000));
  assert.deepEqual(s.map(p => p.pct), [10, 12]);
  assert.ok(s[0].at instanceof Date);
});

test('drops points older than 14 days', async () => {
  const f = await tmpFile();
  await appendSnapshot(f, 'a', 1, new Date(T0));
  await appendSnapshot(f, 'a', 2, new Date(T0 + 15 * DAY));
  const raw = JSON.parse(await readFile(f, 'utf8'));
  assert.deepEqual(raw.a.map(p => p.pct), [2]);
});

test('corrupt file is treated as empty', async () => {
  const f = await tmpFile();
  await appendSnapshot(f, 'a', 1, new Date(T0));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(f, '{not json');
  assert.deepEqual(await getSeries(f, 'a', 7, new Date(T0)), []);
  await appendSnapshot(f, 'a', 3, new Date(T0));
  assert.equal((await getSeries(f, 'a', 7, new Date(T0))).length, 1);
});

test('getSeries limits to the requested days', async () => {
  const f = await tmpFile();
  await appendSnapshot(f, 'a', 1, new Date(T0));
  await appendSnapshot(f, 'a', 2, new Date(T0 + 6 * DAY));
  const s = await getSeries(f, 'a', 3, new Date(T0 + 7 * DAY));
  assert.deepEqual(s.map(p => p.pct), [2]);
});

test('perDayRate is null with one point', () => {
  assert.equal(perDayRate([pt(0, 10)]), null);
  assert.equal(perDayRate([]), null);
});

test('perDayRate is null when span under 6 h', () => {
  assert.equal(perDayRate([{ at: new Date(T0), pct: 1 }, { at: new Date(T0 + 3 * 3600_000), pct: 5 }]), null);
});

test('perDayRate 10→22 over 2 days is 6', () => {
  assert.equal(perDayRate([pt(0, 10), pt(2, 22)]), 6);
});

test('perDayRate restarts after a reset', () => {
  assert.equal(perDayRate([pt(0, 30), pt(1, 40), pt(2, 2), pt(3, 8)]), 6);
});
