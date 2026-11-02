import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexUsage } from '../src/usage/codex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(here, 'fixtures', name);
const BEFORE = new Date((1793343758 - 3600) * 1000); // before the fixture reset times

const line = (ts, p, w) =>
  JSON.stringify({
    timestamp: ts,
    payload: {
      rate_limits: {
        primary: { used_percent: p, window_minutes: 300, resets_at: 1793343758 },
        secondary: { used_percent: w, window_minutes: 10080, resets_at: 1793802196 },
        plan_type: 'team',
      },
    },
  });

test('reads 5h and weekly percent', async () => {
  const u = await readCodexUsage(fx('codex-home'), { now: BEFORE });
  assert.equal(u.kind, 'percent');
  assert.equal(u.fiveHour.pct, 40);
  assert.equal(u.weekly.pct, 13);
  assert.equal(u.plan, 'team');
  assert.equal(u.fiveHour.resetsAt.getTime(), 1793343758000);
  assert.equal(u.weekly.resetsAt.getTime(), 1793802196000);
  assert.equal(u.updatedAt.toISOString(), '2026-11-01T18:24:55.773Z');
});

test('uses the newest rate_limits line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(
    path.join(dir, 'sessions', 'r.jsonl'),
    [line('2026-11-01T10:00:00.000Z', 10, 5), '{"other":1}', line('2026-11-01T11:00:00.000Z', 55, 21)].join('\n') + '\n',
  );
  const u = await readCodexUsage(dir, { now: BEFORE });
  assert.equal(u.fiveHour.pct, 55);
  assert.equal(u.weekly.pct, 21);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing sessions folder returns null', async () => {
  assert.equal(await readCodexUsage(fx('nope-does-not-exist')), null);
  assert.equal(await readCodexUsage(here), null);
});

test('ignores a half-written last line', async () => {
  const u = await readCodexUsage(fx('codex-home-broken'), { now: BEFORE });
  assert.equal(u.fiveHour.pct, 40);
});

test('never opens auth.json', async () => {
  const opened = [];
  const real = fs.promises;
  const spy = {
    readdir: (...a) => real.readdir(...a),
    stat: (...a) => real.stat(...a),
    open: (p, ...a) => (opened.push(String(p)), real.open(p, ...a)),
    readFile: (p, ...a) => (opened.push(String(p)), real.readFile(p, ...a)),
  };
  const u = await readCodexUsage(fx('codex-home'), { fs: spy });
  assert.ok(u);
  assert.ok(opened.length > 0);
  assert.ok(opened.every((p) => !p.toLowerCase().endsWith('auth.json')));
});

test('a window whose resetsAt is before now reports pct 0 with reset true', async () => {
  // fixture: 5h resets 1793343758 (s), weekly resets 1793802196 (s)
  const between = new Date((1793343758 + 60) * 1000);
  const u = await readCodexUsage(fx('codex-home'), { now: between });
  assert.equal(u.fiveHour.pct, 0);
  assert.equal(u.fiveHour.reset, true);
  assert.equal(u.fiveHour.resetsAt.getTime(), 1793343758000);
  assert.equal(u.weekly.pct, 13);
  assert.equal(u.weekly.reset, undefined);
});
