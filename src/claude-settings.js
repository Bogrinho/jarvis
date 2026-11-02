// Settings Jarvis gives the Claude Code it starts (via --settings): a status line that saves
// the account's 5h / weekly limits for the usage panel. The user's own settings stay untouched.
import fs from 'node:fs';
import path from 'node:path';

export function writeClaudeJarvisSettings(rootDir) {
  const script = path.join(rootDir, 'scripts', 'statusline.js').split(path.sep).join('/');
  const file = path.join(rootDir, 'data', 'claude-jarvis-settings.json');
  const settings = { statusLine: { type: 'command', command: `node "${script}"`, padding: 0 } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

// MCP config Jarvis gives the Claude Code it starts (via --mcp-config): the jarvis-helpers
// server (ask_codex / ask_gemini), so the team works in every folder, not only in Jarvis.
export function writeClaudeJarvisMcp(rootDir) {
  const file = path.join(rootDir, 'data', 'claude-jarvis-mcp.json');
  const config = { mcpServers: { 'jarvis-helpers': { command: 'node', args: [path.join(rootDir, 'scripts', 'helpers-mcp.js')] } } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}
