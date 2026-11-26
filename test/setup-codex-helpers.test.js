import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupCodexHelpers } from '../scripts/setup-codex-helpers.js';

test('personal Codex setup preserves other tables, backs up and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-'));
  const file = path.join(dir, 'config.toml');
  const original = 'model = "example"\r\n\r\n[mcp_servers.jarvis-helpers]\r\ncommand = "old"\r\n[other]\r\nvalue = 42\r\n';
  fs.writeFileSync(file, original);
  const options = { shortPath: 'C:\\SHORT~1\\helpers-mcp.js' };
  assert.equal(setupCodexHelpers(dir, 'unused', options), true);
  const result = fs.readFileSync(file, 'utf8');
  assert.equal(fs.readFileSync(file + '.bak-jarvis', 'utf8'), original);
  assert.ok(result.startsWith('model = "example"\r\n\r\n'));
  assert.ok(result.endsWith('[other]\r\nvalue = 42\r\n'));
  assert.match(result, /--leader", "codex/);
  assert.equal(setupCodexHelpers(dir, 'unused', options), false);
  assert.equal(fs.readFileSync(file, 'utf8'), result);
});
