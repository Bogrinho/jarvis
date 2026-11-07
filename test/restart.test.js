import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreJobs, saveRestart } from '../src/restart.js';

test('restore deletes the snapshot and continues after a terminal fails', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-restart-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const entries = [
    { accountId: 'claude', cwd: 'one', title: 'First' },
    { accountId: 'mine', cwd: 'two', title: 'Second' },
  ];
  await saveRestart(rootDir, entries);
  const started = [];
  const errors = [];
  await restoreJobs({ rootDir, start: (entry) => {
    started.push(entry);
    if (entry.accountId === 'claude') throw new Error('failed');
  }, log: (message) => errors.push(message) });
  assert.deepEqual(started, entries);
  assert.equal(fs.existsSync(path.join(rootDir, 'data', 'restart.json')), false);
  assert.match(errors[0], /failed/);
});
