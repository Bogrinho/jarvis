// Dev only: boots the real Jarvis server with FAKE chat adapters so the chat view can be tried
// without starting codex/claude. Every message gets a scripted reply: streamed Greek markdown with a
// code block, a read and a run activity, a diff and an approval that resolves when you click it.
// No terminals are spawned (the job manager refuses), usage is empty, everything lives in a temp folder.
//
//   node scripts/dev-fake-chat.js            -> prints the URL; Ctrl+C to stop
//   node scripts/dev-fake-chat.js --port 4799
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { createServer } from '../src/server.js';
import { ChatManager } from '../src/chat/manager.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argPort = Number(process.argv[process.argv.indexOf('--port') + 1]) || 0;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(argPort, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const REPLY = [
  'Το **SiteWatch** είναι σχεδόν έτοιμο για το portfolio σου. Το demo δουλεύει και τα τεστ περνάνε.',
  '',
  'Μένουν τρία πράγματα:',
  '- το README στο GitHub χρειάζεται *screenshots*',
  '- λείπει σελίδα «About»',
  '- το Cloudflare deploy δεν έχει custom domain',
  '',
  'Για το deploy αρκεί αυτό στο `wrangler.toml`:',
  '```toml',
  'name = "sitewatch"',
  'routes = [{ pattern = "sitewatch.example.com", custom_domain = true }]',
  '```',
  'Τεκμηρίωση: [Cloudflare routes](https://developers.cloudflare.com/workers/configuration/routing/) · <script>alert(1)</script> μένει κείμενο.',
  '',
  'Θες να ξεκινήσω από τα screenshots;',
].join('\n');

const PATCH = [
  '--- README.md', '+++ README.md', '@@ -12,3 +12,4 @@', '  ## Demo',
  '- (screenshots coming soon)', '+ ![Dashboard](sitewatch-public-demo.png)', '+ ![GitHub](sitewatch-github.png)', '  ',
].join('\n');

class FakeAdapter extends EventEmitter {
  constructor(account, cwd) {
    super();
    this.account = account;
    this.cwd = cwd;
    this.pending = new Map(); // token -> resolve
    this.stopped = false;
  }

  async start({ resumeId }) {
    if (resumeId) {
      setTimeout(() => {
        this.emit('item', { id: randomUUID(), kind: 'notice', text: 'Συνέχεια προηγούμενης συζήτησης' });
        this.emit('item', { id: randomUUID(), kind: 'user', text: 'Τι έμεινε από χθες;' });
        this.emit('item', { id: randomUUID(), kind: 'assistant', text: 'Χθες τελειώσαμε το **login**. Μένει το `logout`.', streaming: false });
      }, 50);
    }
    return { externalId: resumeId ?? `fake-${randomUUID()}` };
  }

  item(item) { const id = randomUUID(); this.emit('item', { id, ...item }); return id; }

  async send(text) {
    this.stopped = false;
    this.emit('state', 'working');
    await sleep(900);
    const read = this.item({ kind: 'activity', icon: 'read', text: 'START_HERE.md, README.md, Reliability_Check.md', status: 'running' });
    await sleep(700);
    this.emit('update', read, { status: 'ok' });
    const run = this.item({ kind: 'activity', icon: 'run', text: 'npm test', status: 'running' });
    await sleep(1200);
    this.emit('update', run, { status: 'ok', detail: '24 πέρασαν' });
    if (this.stopped) return;

    const msg = this.item({ kind: 'assistant', text: '', streaming: true });
    const words = (/\bfail\b/i.test(text) ? 'Κάτι πήγε στραβά.' : REPLY).match(/\S+|\s+/g) ?? [];
    for (let i = 0; i < words.length; i += 3) {
      if (this.stopped) break;
      this.emit('delta', msg, words.slice(i, i + 3).join(''));
      await sleep(45);
    }
    this.emit('update', msg, { streaming: false });
    if (this.stopped) return;

    await sleep(500);
    this.item({ kind: 'diff', path: 'README.md', added: 2, removed: 1, patch: PATCH });
    await sleep(400);
    const token = randomUUID();
    this.emit('state', 'waiting');
    this.emit('approval', { token, title: 'Θέλει να ανεβάσει την αλλαγή στο GitHub:', detail: 'στο ' + this.cwd, command: 'git push origin main' });
    const decision = await new Promise((resolve) => this.pending.set(token, resolve));
    if (decision === null) return;
    this.emit('state', 'working');
    await sleep(900);
    if (decision === 'deny') {
      this.item({ kind: 'assistant', text: 'Εντάξει, **δεν** το ανέβασα. Η αλλαγή μένει τοπικά.', streaming: false });
    } else {
      const push = this.item({ kind: 'activity', icon: 'run', text: 'git push origin main', status: 'running' });
      await sleep(900);
      this.emit('update', push, { status: 'ok', detail: 'exit 0' });
      this.item({ kind: 'assistant', text: 'Έγινε. Τα screenshots είναι πλέον στο README στο GitHub.', streaming: false });
    }
    this.emit('state', 'idle');
  }

  answer(token, decision) {
    const resolve = this.pending.get(token);
    if (!resolve) throw new Error('unknown token');
    this.pending.delete(token);
    resolve(decision);
  }

  interrupt() {
    this.stopped = true;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.item({ kind: 'notice', text: 'Σταμάτησε από εσένα' });
    this.emit('state', 'idle');
  }

  close() { this.interrupt(); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-devchat-'));
for (const d of ['work-home', 'mine-home', 'claude-home', 'vault', 'SiteWatch', 'Atlas']) fs.mkdirSync(path.join(dir, d));
fs.writeFileSync(path.join(dir, 'vault', 'today.md'), '- [ ] Δοκιμή chat\n- [x] Mockup\n');
const port = await freePort();
const raw = {
  port,
  accounts: {
    work: { label: 'Codex Work', cli: 'codex', side: 'work', mode: 'cautious', home: 'work-home', env: { CODEX_HOME: path.join(dir, 'cx-work') }, enabled: true },
    mine: { label: 'Codex Personal', cli: 'codex', side: 'personal', mode: 'edit-in-project', home: 'mine-home', env: { CODEX_HOME: path.join(dir, 'cx-mine') }, enabled: true },
    claude: { label: 'Claude', cli: 'claude', side: 'personal', mode: 'edit-in-project', home: 'claude-home', env: {}, enabled: true },
    gemini: { label: 'Gemini', cli: 'gemini', side: 'personal', mode: 'edit-in-project', home: 'vault', env: {}, enabled: true },
  },
  projects: [
    { name: 'SiteWatch', path: path.join(dir, 'SiteWatch'), side: 'personal' },
    { name: 'Atlas', path: path.join(dir, 'Atlas'), side: 'work' },
  ],
  quickCommands: [{ id: 'daily-brief', label: 'Daily Brief', prompt: 'Δώσε μου ένα σύντομο daily brief.' }],
  directivesFile: 'vault/today.md',
};
fs.writeFileSync(path.join(dir, 'jarvis.config.json'), JSON.stringify(raw, null, 2));
const config = loadConfig(path.join(dir, 'jarvis.config.json'));

const jobs = new JobManager({ spawn: () => { throw new Error('dev-fake-chat: no terminals'); } });
const make = (account, cwd) => new FakeAdapter(account, cwd);
const chats = new ChatManager({ adapters: { codex: make, claude: make }, indexFile: path.join(dir, 'data', 'chats.json') });
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const chatHistory = async ({ account }) => [
  { externalId: `${account.id}-h1`, title: 'Login σελίδα για το SiteWatch', updatedAt: ago(42) },
  { externalId: `${account.id}-h2`, title: 'Διόρθωσε τα failing tests', updatedAt: ago(60 * 26) },
];

const server = createServer({
  config, jobs, token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
  usageIntervalMs: 3600000, onShutdown: () => stop(), chats, chatHistory,
  deps: { collectUsage: async () => ({}), historyFile: path.join(dir, 'data', 'usage-history.json') },
});
await server.listen();

// One conversation already running so the page has something to show.
if (!process.argv.includes('--empty')) {
  const info = await chats.create({
    accountId: 'mine', account: config.accounts.mine, cwd: raw.projects[0].path, side: 'personal', title: 'SiteWatch',
  });
  chats.send(info.id, 'Διάβασε το START_HERE.md και πες μου πού βρίσκεται το project SiteWatch και τι μένει να γίνει.');
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await chats.closeAll().catch(() => {});
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`dev-fake-chat listening on http://127.0.0.1:${port}/`);
