import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { allowedAccounts, resolveTarget, buildLaunch, PolicyError } from '../src/policy.js';

const repoConfig = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jarvis.config.json');

function makeConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-policy-'));
  const raw = JSON.parse(fs.readFileSync(repoConfig, 'utf8'));
  const workPath = path.join(dir, 'WorkProj');
  const personalPath = path.join(dir, 'PersonalProj');
  fs.mkdirSync(workPath);
  fs.mkdirSync(personalPath);
  fs.mkdirSync(path.join(dir, 'unlisted'));
  raw.projects = [
    { name: 'work-proj', path: workPath, side: 'work' },
    { name: 'personal-proj', path: personalPath, side: 'personal' },
  ];
  const file = path.join(dir, 'jarvis.config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return { cfg: loadConfig(file), dir, workPath, personalPath };
}

const code = (c) => (e) => e instanceof PolicyError && e.code === c;

test('work project allows only codex work', () => {
  const { cfg } = makeConfig();
  assert.deepEqual(allowedAccounts(cfg, 'work'), ['work']);
  assert.deepEqual(allowedAccounts(cfg, 'personal'), ['mine', 'claude']);
});

test('rejects personal account on work project', () => {
  const { cfg, workPath } = makeConfig();
  assert.throws(() => resolveTarget(cfg, { accountId: 'claude', projectPath: workPath }), code('SIDE_MISMATCH'));
});

test('rejects work account on personal project', () => {
  const { cfg, personalPath } = makeConfig();
  assert.throws(() => resolveTarget(cfg, { accountId: 'work', projectPath: personalPath }), code('SIDE_MISMATCH'));
});

test('rejects unknown project path', () => {
  const { cfg, dir } = makeConfig();
  assert.throws(
    () => resolveTarget(cfg, { accountId: 'mine', projectPath: path.join(dir, 'unlisted') }),
    code('UNKNOWN_PROJECT'),
  );
});

test('rejects unknown and disabled accounts', () => {
  const { cfg, personalPath } = makeConfig();
  assert.throws(() => resolveTarget(cfg, { accountId: 'nope', useHome: true }), code('UNKNOWN_ACCOUNT'));
  assert.throws(() => resolveTarget(cfg, { accountId: 'gemini', projectPath: personalPath }), code('DISABLED'));
});

test('useHome without a home', () => {
  const { cfg } = makeConfig();
  assert.throws(() => resolveTarget(cfg, { accountId: 'work', useHome: true }), code('NO_HOME'));
});

test('useHome resolves to the account home', () => {
  const { cfg } = makeConfig();
  assert.deepEqual(resolveTarget(cfg, { accountId: 'mine', useHome: true }), {
    cwd: cfg.accounts.mine.home,
    side: 'personal',
  });
});

test('matching project resolves to its configured path and side', () => {
  const { cfg, workPath } = makeConfig();
  assert.deepEqual(resolveTarget(cfg, { accountId: 'work', projectPath: workPath }), { cwd: workPath, side: 'work' });
});

test('project path comparison ignores case, slash style and trailing slash', () => {
  const { cfg, workPath } = makeConfig();
  const variant = workPath.split(path.sep).join('/').toLowerCase() + '/';
  const r = resolveTarget(cfg, { accountId: 'work', projectPath: variant });
  assert.equal(r.cwd, workPath);
  assert.throws(() => resolveTarget(cfg, { accountId: 'claude', projectPath: variant }), code('SIDE_MISMATCH'));
});

test('codex work launch is cautious with its own CODEX_HOME', () => {
  const { cfg } = makeConfig();
  const l = buildLaunch(cfg.accounts.work);
  assert.ok(l.args.includes('on-request'));
  assert.ok(l.args.includes('read-only'));
  assert.equal(l.env.CODEX_HOME, 'C:\\Users\\stath\\.codex');
});

test('codex personal launch uses personal home', () => {
  const { cfg } = makeConfig();
  const l = buildLaunch(cfg.accounts.mine);
  assert.ok(l.env.CODEX_HOME.endsWith('.codex-personal'));
  assert.ok(l.args.includes('workspace-write'));
});

test('claude launch accepts edits', () => {
  const { cfg } = makeConfig();
  assert.ok(buildLaunch(cfg.accounts.claude).args.includes('acceptEdits'));
});

test('gemini launch uses auto_edit; env is merged over process.env', () => {
  const { cfg } = makeConfig();
  const l = buildLaunch(cfg.accounts.gemini);
  assert.ok(l.args.includes('auto_edit'));
  assert.equal(l.env.PATH ?? l.env.Path, process.env.PATH ?? process.env.Path);
});

const STRIPPED = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
];

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('inherited CODEX_HOME in another case is replaced, not duplicated', () => {
  const { cfg } = makeConfig();
  const l = withEnv({ Codex_Home: 'C:/leaked/work' }, () => buildLaunch(cfg.accounts.mine));
  const keys = Object.keys(l.env).filter((k) => k.toLowerCase() === 'codex_home');
  assert.deepEqual(keys, ['CODEX_HOME']);
  assert.equal(l.env.CODEX_HOME, cfg.accounts.mine.env.CODEX_HOME);
});

test('API keys from the parent environment are not inherited', () => {
  const { cfg } = makeConfig();
  const vars = Object.fromEntries(STRIPPED.map((k, i) => [i % 2 ? k.toLowerCase() : k, 'secret']));
  for (const id of ['work', 'mine', 'claude', 'gemini']) {
    const l = withEnv(vars, () => buildLaunch(cfg.accounts[id]));
    for (const k of STRIPPED) {
      assert.ok(!Object.keys(l.env).some((e) => e.toLowerCase() === k.toLowerCase()), `${id}: ${k} leaked`);
    }
  }
});

test('codex launch without CODEX_HOME is refused', () => {
  const { cfg } = makeConfig();
  const acct = { ...cfg.accounts.mine, env: {} };
  assert.throws(() => buildLaunch(acct), (e) => e instanceof PolicyError);
});
