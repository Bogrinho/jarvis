import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(here, 'fixtures', 'config', name);

test('loads default config with separate work and personal Codex accounts', () => {
  const c = loadConfig('jarvis.config.json');
  assert.deepEqual(Object.keys(c.accounts), ['work', 'mine', 'claude', 'gemini']);
  assert.equal(c.accounts.work.enabled, true);
  assert.equal(c.accounts.work.cli, 'codex');
  assert.equal(c.accounts.work.side, 'work');
  assert.equal(c.accounts.mine.env.CODEX_HOME, 'C:\\Users\\stath\\.codex-personal');
  assert.equal(c.accounts.claude.mode, 'auto');
  assert.equal(c.accounts.gemini.enabled, true);
  assert.equal(c.port, 4777);
});

test('fixture config keeps the work account for side-rule tests', () => {
  const c = loadConfig(path.join(here, 'fixtures', 'jarvis.config.json'));
  assert.equal(c.accounts.work.env.CODEX_HOME, 'C:\\Users\\stath\\.codex');
  assert.equal(c.accounts.work.mode, 'cautious');
  assert.equal(c.accounts.work.color, '#ffb547');
});

test('resolves relative paths against rootDir, keeping Greek characters', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'Έγγραφα test '));
  try {
    const cfgPath = path.join(tmp, 'jarvis.config.json');
    fs.copyFileSync(fx('relative-home.json'), cfgPath);
    const c = loadConfig(cfgPath);
    assert.equal(c.rootDir, tmp);
    assert.equal(c.accounts.work.home, path.join(tmp, 'vault'));
    assert.equal(c.directivesFile, path.join(tmp, 'vault', 'today.md'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rejects project with unknown side', () => {
  assert.throws(() => loadConfig(fx('bad-side.json')), (e) => e instanceof ConfigError && /projects\[0\]\.side/.test(e.message));
});

test('rejects account with unknown mode', () => {
  assert.throws(() => loadConfig(fx('bad-mode.json')), (e) => e instanceof ConfigError && /accounts\.work\.mode/.test(e.message));
});

test('rejects personal-side account sharing a home with a work-side account', () => {
  assert.throws(() => loadConfig(fx('shared-home.json')), (e) => e instanceof ConfigError && /accounts.mine.home/.test(e.message));
});

// ---------- account / folder separation ----------

function baseRaw() {
  return {
    port: 4777,
    accounts: {
      work: { label: 'Work', cli: 'codex', side: 'work', mode: 'cautious', home: null, env: { CODEX_HOME: 'C:\\x\\codex-work' } },
      mine: { label: 'Mine', cli: 'codex', side: 'personal', mode: 'edit-in-project', home: 'C:\\x\\vault', env: { CODEX_HOME: 'C:\\x\\codex-personal' } },
      claude: { label: 'Claude', cli: 'claude', side: 'personal', mode: 'edit-in-project', home: 'C:\\x\\vault', env: {} },
    },
    projects: [],
    quickCommands: [],
    directivesFile: 'vault/today.md',
  };
}

function loadRaw(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cfg-'));
  const file = path.join(dir, 'jarvis.config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  try {
    return loadConfig(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rejects = (raw, re) => assert.throws(() => loadRaw(raw), (e) => e instanceof ConfigError && re.test(e.message));

test('remote access defaults off and validates optional settings', () => {
  const raw = baseRaw();
  assert.equal(loadRaw(raw).remote.enabled, false);
  for (const remote of [{ enabled: true }, { enabled: true, host: 'pc.tail-net.ts.net', allowedUsers: [] }]) {
    assert.deepEqual(loadRaw({ ...raw, remote }).remote, remote);
  }
  for (const remote of [null, {}, { enabled: 1 }, { enabled: true, allowedUsers: 'owner' },
    { enabled: true, allowedUsers: [123] }]) rejects({ ...raw, remote }, /remote/);
  for (const host of ['pc.example', 'PC.ts.net', '-pc.ts.net', 'pc..ts.net', 'pc.ts.net:443', 'https://pc.ts.net']) {
    rejects({ ...raw, remote: { enabled: true, host } }, /remote.host/);
  }
});

test('base separation config loads', () => {
  const c = loadRaw(baseRaw());
  assert.equal(c.accounts.mine.env.CODEX_HOME, 'C:\\x\\codex-personal');
});

test('codex account without CODEX_HOME is rejected', () => {
  const raw = baseRaw();
  delete raw.accounts.mine.env.CODEX_HOME;
  rejects(raw, /accounts\.mine\.env\.CODEX_HOME/);
  const raw2 = baseRaw();
  raw2.accounts.work.env = {};
  rejects(raw2, /accounts\.work\.env\.CODEX_HOME/);
  const raw3 = baseRaw();
  raw3.accounts.mine.env.CODEX_HOME = '';
  rejects(raw3, /accounts\.mine\.env\.CODEX_HOME/);
  const raw4 = baseRaw();
  delete raw4.accounts.mine.env;
  rejects(raw4, /accounts\.mine\.env\.CODEX_HOME/);
});

test('personal codex sharing the work CODEX_HOME is rejected (case/slash-insensitive)', () => {
  const raw = baseRaw();
  raw.accounts.mine.env.CODEX_HOME = 'c:/X/Codex-Work/';
  rejects(raw, /accounts\.mine\.env\.CODEX_HOME/);
});

test('personal codex using the default ~/.codex is rejected', () => {
  const raw = baseRaw();
  raw.accounts.mine.env.CODEX_HOME = path.join(os.homedir(), '.codex').toUpperCase();
  rejects(raw, /accounts\.mine\.env\.CODEX_HOME/);
});

test('non-string env values are rejected', () => {
  const raw = baseRaw();
  raw.accounts.claude.env = { FOO: 1 };
  rejects(raw, /accounts\.claude\.env\.FOO/);
  const raw2 = baseRaw();
  raw2.accounts.mine.env.CODEX_HOME = ['C:\\x\\a'];
  rejects(raw2, /accounts\.mine\.env\.CODEX_HOME/);
});

test('account home inside a project of the other side is rejected', () => {
  const raw = baseRaw();
  raw.projects = [{ name: 'w', path: 'C:\\x', side: 'work' }];
  rejects(raw, /accounts\.mine\.home/);
  const raw2 = baseRaw();
  raw2.projects = [{ name: 'w', path: 'c:/X/VAULT/', side: 'work' }];
  rejects(raw2, /accounts\.mine\.home/);
  const raw3 = baseRaw();
  raw3.accounts.work.home = 'C:\\x\\workhome\\sub';
  raw3.projects = [{ name: 'p', path: 'C:\\x\\workhome', side: 'personal' }];
  rejects(raw3, /accounts\.work\.home/);
});

test('account home inside a project of its own side is fine', () => {
  const raw = baseRaw();
  raw.projects = [{ name: 'p', path: 'C:\\x', side: 'personal' }];
  assert.equal(loadRaw(raw).projects.length, 1);
});

test('personal and work homes nested inside each other are rejected', () => {
  const raw = baseRaw();
  raw.accounts.work.home = 'C:\\x\\vault\\work';
  rejects(raw, /home/);
  const raw2 = baseRaw();
  raw2.accounts.work.home = 'C:\\x';
  rejects(raw2, /home/);
});

test('sibling paths sharing a name prefix are not treated as nested', () => {
  const raw = baseRaw();
  raw.accounts.mine.home = 'C:\\x\\Proj2';
  raw.accounts.claude.home = 'C:\\x\\Proj2';
  raw.accounts.work.home = 'C:\\x\\Proj';
  raw.projects = [
    { name: 'w', path: 'C:\\x\\Proj', side: 'work' },
    { name: 'p', path: 'C:\\x\\Proj2', side: 'personal' },
  ];
  const c = loadRaw(raw);
  assert.equal(c.projects.length, 2);
});

test('duplicate project paths are rejected regardless of side', () => {
  const raw = baseRaw();
  raw.projects = [
    { name: 'a', path: 'C:\\y\\Proj', side: 'personal' },
    { name: 'b', path: 'c:/y/proj/', side: 'personal' },
  ];
  rejects(raw, /projects\[1\]\.path/);
  const raw2 = baseRaw();
  raw2.projects = [
    { name: 'a', path: 'C:\\y\\Proj', side: 'work' },
    { name: 'b', path: 'C:\\Y\\PROJ', side: 'personal' },
  ];
  rejects(raw2, /projects\[1\]\.path/);
});

test('the Gemini account runs the Antigravity CLI (agy)', () => {
  const c = loadConfig('jarvis.config.json');
  assert.equal(c.accounts.gemini.cli, 'agy');
  assert.equal(c.accounts.gemini.label, 'Gemini');
});

test('the old work folder stays marked as work so personal helpers never run there', () => {
  const c = loadConfig('jarvis.config.json');
  const w = c.projects.find((p) => p.side === 'work');
  assert.ok(w && /act-as-my-coding-agent-we$/.test(w.path));
});

test('sitewatch settings: https address and a token file inside data/', () => {
  const c = loadConfig('jarvis.config.json');
  assert.equal(new URL(c.sitewatch.url).protocol, 'https:');
  assert.equal(c.sitewatch.tokenFile, path.join(c.rootDir, 'data', 'sitewatch-token.txt'));
});

test('a non-https sitewatch address is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-cfg-'));
  const raw = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'jarvis.config.json'), 'utf8'));
  raw.sitewatch = { url: 'http://x.example', tokenFile: 'data/t.txt' };
  const f = path.join(dir, 'jarvis.config.json');
  fs.writeFileSync(f, JSON.stringify(raw));
  assert.throws(() => loadConfig(f), /sitewatch/);
});
