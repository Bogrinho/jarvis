import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeClaudeJarvisSettings } from '../src/claude-settings.js';

test('writes a status-line settings file pointing at the Jarvis helper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Έγγραφα-jv-'));
  const file = writeClaudeJarvisSettings(root);
  assert.equal(file, path.join(root, 'data', 'claude-jarvis-settings.json'));
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.statusLine.type, 'command');
  assert.ok(j.statusLine.command.startsWith('node "'));
  assert.ok(j.statusLine.command.includes('/scripts/statusline.js"'));
  assert.ok(!j.statusLine.command.includes(String.fromCharCode(92)), 'forward slashes work in every shell');
  assert.deepEqual(Object.keys(j), ['statusLine']);
});
