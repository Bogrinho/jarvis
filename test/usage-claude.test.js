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

test('ignores a rate file older than 6 hours and falls back to tokens', async () => {
  const later = new Date(NOW.getTime() + 7 * 3600 * 1000 - 11 * 60 * 1000); // file is ~6h49m old
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
  const r = await collectUsage(config, { readCodexUsage: async () => null, readClaudeUsage: async () => null });
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
