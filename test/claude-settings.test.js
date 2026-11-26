import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeClaudeJarvisSettings } from '../src/claude-settings.js';

test('writes the status line and Claude hooks for turns and input requests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Έγγραφα jv-'));
  const file = writeClaudeJarvisSettings(root);
  assert.equal(file, path.join(root, 'data', 'claude-jarvis-settings.json'));
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.statusLine.type, 'command');
  assert.ok(j.statusLine.command.startsWith('node "'));
  assert.ok(j.statusLine.command.includes('/scripts/statusline.js"'));
  assert.ok(!j.statusLine.command.includes(String.fromCharCode(92)), 'forward slashes work in every shell');
  const hookScript = path.join(root, 'scripts', 'jarvis-hook.js').split(path.sep).join('/');
  for (const [event, state] of Object.entries({ UserPromptSubmit: 'working', Stop: 'done', Notification: 'waiting' })) {
    const [group] = j.hooks[event];
    assert.deepEqual(group.hooks, [{ type: 'command', command: `node "${hookScript}" ${state}`, timeout: 3 }]);
  }
  const matcher = new RegExp(j.hooks.Notification[0].matcher);
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) assert.ok(matcher.test(type));
  for (const type of ['idle_prompt', 'auth_success', 'agent_completed']) assert.ok(!matcher.test(type));
});

test('writes the helpers MCP config with the absolute script path', async () => {
  const { writeClaudeJarvisMcp } = await import('../src/claude-settings.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Έγγραφα-jv-'));
  const file = writeClaudeJarvisMcp(root);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(j.mcpServers), ['jarvis-helpers']);
  assert.equal(j.mcpServers['jarvis-helpers'].command, 'node');
  assert.deepEqual(j.mcpServers['jarvis-helpers'].args, [path.join(root, 'scripts', 'helpers-mcp.js'), '--leader', 'claude']);
});
