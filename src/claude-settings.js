// Per-launch Claude settings for usage reporting and terminal state changes.
import fs from 'node:fs';
import path from 'node:path';

export function writeClaudeJarvisSettings(rootDir) {
  const script = path.join(rootDir, 'scripts', 'statusline.js').split(path.sep).join('/');
  const hookScript = path.join(rootDir, 'scripts', 'jarvis-hook.js').split(path.sep).join('/');
  const command = (state) => [{ type: 'command', command: `node "${hookScript}" ${state}`, timeout: 3 }];
  const file = path.join(rootDir, 'data', 'claude-jarvis-settings.json');
  const settings = {
    statusLine: { type: 'command', command: `node "${script}"`, padding: 0 },
    hooks: {
      UserPromptSubmit: [{ hooks: command('working') }],
      Stop: [{ hooks: command('done') }],
      // An idle reminder also fires after a completed answer. Only actual requests need attention.
      Notification: [{ matcher: '^(permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input)$', hooks: command('waiting') }],
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

// MCP config Jarvis gives the Claude Code it starts (via --mcp-config): the jarvis-helpers
// server (ask_codex / ask_gemini), so the team works in every folder, not only in Jarvis.
export function writeClaudeJarvisMcp(rootDir) {
  const file = path.join(rootDir, 'data', 'claude-jarvis-mcp.json');
  const config = { mcpServers: { 'jarvis-helpers': { command: 'node', args: [path.join(rootDir, 'scripts', 'helpers-mcp.js'), '--leader', 'claude'] } } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}
