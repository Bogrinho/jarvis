import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CLIS = ['codex', 'claude', 'gemini', 'agy'];
const SIDES = ['work', 'personal'];
const MODES = ['cautious', 'edit-in-project', 'auto'];
const COLORS = { work: '#5b8cff', mine: '#5fd39a', claude: '#e0609a', gemini: '#a98bff' };
const FALLBACK_COLOR = '#8a93a6';

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ConfigError(`${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function str(value, field) {
  if (typeof value !== 'string' || value === '') throw new ConfigError(`${field} must be a non-empty string`);
  return value;
}

// Case-insensitive, normalized comparison key for Windows paths (resolve drops trailing separators).
const norm = (p) => path.resolve(p).toLowerCase();

// True when `child` equals `parent` or lies inside it (separator-aware: C:\x\Proj2 is not inside C:\x\Proj).
function isWithin(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function loadConfig(filePath) {
  let abs = path.resolve(filePath);
  // Expand Windows short names (e.g. 53DB~1 -> Έγγραφα) so "." homes match the
  // folder Claude Code uses for its saved conversations.
  try { abs = fs.realpathSync.native(abs); } catch {}
  const rootDir = path.dirname(abs);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new ConfigError(`cannot read config ${abs}: ${e.message}`);
  }
  const resolve = (p) => path.resolve(rootDir, p);

  const port = raw.port ?? 4777;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('port must be an integer 1-65535');

  const accounts = {};
  for (const [id, a] of Object.entries(raw.accounts ?? {})) {
    const f = `accounts.${id}`;
    if (!a || typeof a !== 'object') throw new ConfigError(`${f} must be an object`);
    if (a.env != null && (typeof a.env !== 'object' || Array.isArray(a.env))) throw new ConfigError(`${f}.env must be an object`);
    const account = {
      id,
      label: str(a.label, `${f}.label`),
      cli: oneOf(a.cli, CLIS, `${f}.cli`),
      side: oneOf(a.side, SIDES, `${f}.side`),
      mode: oneOf(a.mode, MODES, `${f}.mode`),
      home: a.home == null ? null : resolve(str(a.home, `${f}.home`)),
      env: { ...(a.env ?? {}) },
      enabled: a.enabled !== false,
      color: a.color ?? COLORS[id] ?? FALLBACK_COLOR,
    };
    for (const [k, v] of Object.entries(account.env)) {
      if (typeof v !== 'string') throw new ConfigError(`${f}.env.${k} must be a string`);
    }
    // Every Codex account must name its own login folder; never fall back to the default ~/.codex.
    if (account.cli === 'codex') str(account.env.CODEX_HOME, `${f}.env.CODEX_HOME`);
    accounts[id] = account;
  }

  const list = Object.values(accounts);
  const workCodexHomes = list.filter((a) => a.cli === 'codex' && a.side === 'work').map((a) => norm(a.env.CODEX_HOME));
  const defaultCodexHome = norm(path.join(os.homedir(), '.codex'));
  for (const a of list) {
    if (a.cli !== 'codex' || a.side !== 'personal') continue;
    const h = norm(a.env.CODEX_HOME);
    if (h === defaultCodexHome || workCodexHomes.includes(h)) {
      throw new ConfigError(
        `accounts.${a.id}.env.CODEX_HOME: personal Codex must not use the work/default Codex home (${a.env.CODEX_HOME})`,
      );
    }
  }

  const projects = (raw.projects ?? []).map((p, i) => ({
    name: str(p?.name, `projects[${i}].name`),
    path: resolve(str(p?.path, `projects[${i}].path`)),
    side: oneOf(p?.side, SIDES, `projects[${i}].side`),
  }));

  // A folder may never be reachable from both sides.
  const seen = new Map();
  projects.forEach((p, i) => {
    const k = norm(p.path);
    if (seen.has(k)) throw new ConfigError(`projects[${i}].path duplicates projects[${seen.get(k)}].path (${p.path})`);
    seen.set(k, i);
  });
  for (const a of list) {
    if (!a.home) continue;
    for (const p of projects) {
      if (p.side !== a.side && isWithin(a.home, p.path)) {
        throw new ConfigError(`accounts.${a.id}.home (${a.home}) is inside ${p.side} project ${p.name}`);
      }
    }
    if (a.side !== 'personal') continue;
    for (const w of list) {
      if (w.side === 'work' && w.home && (isWithin(a.home, w.home) || isWithin(w.home, a.home))) {
        throw new ConfigError(`accounts.${a.id}.home: personal home must not be the same as or nested with work home of ${w.id}`);
      }
    }
  }

  const quickCommands = (raw.quickCommands ?? []).map((q, i) => ({
    id: str(q?.id, `quickCommands[${i}].id`),
    label: str(q?.label, `quickCommands[${i}].label`),
    prompt: str(q?.prompt, `quickCommands[${i}].prompt`),
  }));

  // Optional: the user's SiteWatch status page (read with a key kept in a local file).
  let sitewatch = null;
  if (raw.sitewatch != null) {
    const u = str(raw.sitewatch.url, 'sitewatch.url');
    let parsed;
    try { parsed = new URL(u); } catch { throw new ConfigError('sitewatch.url must be a valid address'); }
    if (parsed.protocol !== 'https:') throw new ConfigError('sitewatch.url must use https');
    sitewatch = { url: parsed.origin, tokenFile: resolve(str(raw.sitewatch.tokenFile, 'sitewatch.tokenFile')) };
  }

  return {
    rootDir,
    port,
    sitewatch,
    accounts,
    projects,
    quickCommands,
    directivesFile: resolve(str(raw.directivesFile, 'directivesFile')),
  };
}
