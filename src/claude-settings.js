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
