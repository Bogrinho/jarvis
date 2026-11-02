import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeUsage } from '../src/usage/claude.js';
import { collectUsage } from '../src/usage/index.js';
import { loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (...p) => path.join(here, 'fixtures', ...p);
const NOW = new Date('2026-11-01T12:00:00.000Z');

test('prefers percent from a fresh rate file', async () => {
  const u = await readClaudeUsage({ claudeHome: fx('claude-home'), rateFile: fx('claude-rate.json'), now: NOW });
  assert.equal(u.kind, 'percent');
  assert.equal(u.weekly.pct, 39);
  assert.equal(u.fiveHour.pct, 12);
  assert.ok(u.weekly.resetsAt instanceof Date);
  assert.equal(u.plan, null);
});

test('keeps a day-old rate file (windows past reset show 0%) but ignores one older than 7 days', async () => {
  const dayOld = await readClaudeUsage({ claudeHome: fx('claude-home'), rateFile: fx('claude-rate.json'), now: new Date(NOW.getTime() + 24 * 3600 * 1000) });
  assert.equal(dayOld.kind, 'percent');
  assert.equal(dayOld.fiveHour.reset, true);
  const later = new Date(NOW.getTime() + 8 * 24 * 3600 * 1000);
  const u = await readClaudeUsage({ claudeHome: fx('claude-home'), rateFile: fx('claude-rate.json'), now: later });
  assert.equal(u.kind, 'tokens');
});

test('sums tokens in last 5h and 7 days', async () => {
  const u = await readClaudeUsage({ claudeHome: fx('claude-home'), rateFile: fx('missing.json'), now: NOW });
  assert.equal(u.kind, 'tokens');
  assert.equal(u.fiveHour.tokens, 350);
  assert.equal(u.weekly.tokens, 1350);
});

test('corrupt rate file falls back to tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-'));
  const rf = path.join(dir, 'rate.json');
  fs.writeFileSync(rf, '{not json');
  const u = await readClaudeUsage({ claudeHome: fx('claude-home'), rateFile: rf, now: NOW });
  assert.equal(u.kind, 'tokens');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no projects folder returns null', async () => {
  assert.equal(await readClaudeUsage({ claudeHome: fx('nope'), rateFile: fx('missing.json'), now: NOW }), null);
});

test('collectUsage keeps going when one account throws', async () => {
  const config = loadConfig(path.join(here, 'fixtures', 'jarvis.config.json'));
  const pct = { kind: 'percent', fiveHour: { pct: 1, resetsAt: NOW }, weekly: { pct: 2, resetsAt: NOW }, plan: null, updatedAt: NOW };
  const r = await collectUsage(config, {
    readCodexUsage: async (home) => {
      if (home.includes('personal')) throw new Error('boom');
      return pct;
    },
    readCodexLive: async () => null,
    readClaudeUsage: async () => null,
  });
  assert.equal(r.mine.kind, 'none');
  assert.equal(r.work.kind, 'percent');
  assert.equal(r.claude.kind, 'none');
  assert.equal(r.gemini.kind, 'none');
  assert.equal(r.gemini.reason, 'not set up');
});

test('gemini enabled reports no local usage data', async () => {
  const config = loadConfig(path.join(here, 'fixtures', 'jarvis.config.json'));
  config.accounts.gemini.enabled = true;
  const r = await collectUsage(config, { readCodexUsage: async () => null, readCodexLive: async () => null, readClaudeUsage: async () => null });
  assert.equal(r.gemini.reason, 'no local usage data');
});

test('rate-file window with resetsAt before now reports pct 0 with reset true', async () => {
  const now = new Date('2026-11-01T15:30:00.000Z'); // after fiveHour reset (15:00), file still fresh
  const f = path.join(fx(), 'claude-rate-tmp.json');
  fs.writeFileSync(f, JSON.stringify({
    fiveHour: { pct: 12, resetsAt: '2026-11-01T15:00:00.000Z' },
    weekly: { pct: 39, resetsAt: '2026-11-06T09:00:00.000Z' },
    updatedAt: '2026-11-01T14:00:00.000Z',
  }));
  try {
    const u = await readClaudeUsage({ claudeHome: fx('nope'), rateFile: f, now });
    assert.equal(u.kind, 'percent');
    assert.equal(u.fiveHour.pct, 0);
    assert.equal(u.fiveHour.reset, true);
    assert.equal(u.weekly.pct, 39);
    assert.equal(u.weekly.reset, undefined);
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test('token scan caches per file: unchanged files are not re-read, changed ones are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-cache-'));
  const proj = path.join(dir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const a = path.join(proj, 'a.jsonl');
  const b = path.join(proj, 'b.jsonl');
  const row = (ts, out) => JSON.stringify({ timestamp: ts, message: { usage: { output_tokens: out } } }) + '\n';
  fs.writeFileSync(a, row('2026-11-01T11:00:00.000Z', 10));
  fs.writeFileSync(b, row('2026-11-01T11:30:00.000Z', 20));
  const reads = [];
  const spy = { ...fs.promises, createReadStream: (p, ...r) => (reads.push(p), fs.createReadStream(p, ...r)) };
  const args = { claudeHome: dir, rateFile: fx('missing.json'), now: NOW, fs: spy };
  try {
    assert.equal((await readClaudeUsage(args)).fiveHour.tokens, 30);
    assert.equal(reads.length, 2);
    assert.equal((await readClaudeUsage(args)).fiveHour.tokens, 30);
    assert.equal(reads.length, 2, 'unchanged files must not be re-read');
    fs.appendFileSync(b, row('2026-11-01T11:40:00.000Z', 5));
    assert.equal((await readClaudeUsage(args)).fiveHour.tokens, 35);
    assert.deepEqual(reads.slice(2), [b], 'only the changed file is re-read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex usage uses the newer of live limits and session files; live is asked at most every 5 minutes', async () => {
  const config = loadConfig(path.join(here, 'fixtures', 'jarvis.config.json'));
  config.accounts = { mine: config.accounts.mine };
  const at = (iso, pct) => ({ kind: 'percent', fiveHour: { pct, resetsAt: new Date('2099-01-01') }, weekly: { pct, resetsAt: new Date('2099-01-01') }, plan: 'plus', updatedAt: new Date(iso) });
  let liveCalls = 0;
  let live = at('2026-11-02T16:00:00Z', 13);
  const deps = {
    readCodexUsage: async () => at('2026-11-02T10:00:00Z', 46),
    readCodexLive: async (home) => { liveCalls++; assert.equal(home, config.accounts.mine.env.CODEX_HOME); return live; },
    readClaudeUsage: async () => null,
    liveCache: new Map(),
  };
  const t0 = new Date('2026-11-02T16:00:00Z');
  assert.equal((await collectUsage(config, { ...deps, now: t0 })).mine.weekly.pct, 13);
  live = at('2026-11-02T16:02:00Z', 99);
  assert.equal((await collectUsage(config, { ...deps, now: new Date(t0.getTime() + 2 * 60000) })).mine.weekly.pct, 13);
  assert.equal(liveCalls, 1);
  assert.equal((await collectUsage(config, { ...deps, now: new Date(t0.getTime() + 6 * 60000) })).mine.weekly.pct, 99);
  assert.equal(liveCalls, 2);
  // live failing: the session files still answer
  const r = await collectUsage(config, { ...deps, readCodexLive: async () => null, liveCache: new Map(), now: t0 });
  assert.equal(r.mine.weekly.pct, 46);
  // session files newer than live (Codex just ran here): files win
  const r2 = await collectUsage(config, { ...deps, readCodexUsage: async () => at('2026-11-02T17:00:00Z', 50), liveCache: new Map(), now: t0 });
  assert.equal(r2.mine.weekly.pct, 50);
});

test('antigravity accounts report no local usage data', async () => {
  const config = loadConfig(path.join(here, 'fixtures', 'jarvis.config.json'));
  config.accounts.gemini.enabled = true;
  config.accounts.gemini.cli = 'agy';
  const r = await collectUsage(config, { readCodexUsage: async () => null, readCodexLive: async () => null, readClaudeUsage: async () => null });
  assert.equal(r.gemini.reason, 'no local usage data');
});
