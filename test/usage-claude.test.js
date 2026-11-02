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
  const config = loadConfig(path.join(here, '..', 'jarvis.config.json'));
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
  const config = loadConfig(path.join(here, '..', 'jarvis.config.json'));
  config.accounts.gemini.enabled = true;
  const r = await collectUsage(config, { readCodexUsage: async () => null, readClaudeUsage: async () => null });
  assert.equal(r.gemini.reason, 'no local usage data');
});
