import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CLIS = ['codex', 'claude', 'gemini'];
const SIDES = ['work', 'personal'];
const MODES = ['cautious', 'edit-in-project'];
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

export function loadConfig(filePath) {
  const abs = path.resolve(filePath);
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
    accounts[id] = {
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
  }

  const norm = (p) => path.normalize(p).toLowerCase();
  const workHomes = new Set(
    Object.values(accounts).filter((a) => a.side === 'work' && a.home).map((a) => norm(a.home)),
  );
  for (const a of Object.values(accounts)) {
    if (a.side === 'personal' && a.home && workHomes.has(norm(a.home))) {
      throw new ConfigError(`accounts.${a.id}.home: personal account must not share a home with a work account`);
    }
  }

  const projects = (raw.projects ?? []).map((p, i) => ({
    name: str(p?.name, `projects[${i}].name`),
    path: resolve(str(p?.path, `projects[${i}].path`)),
    side: oneOf(p?.side, SIDES, `projects[${i}].side`),
  }));

  const quickCommands = (raw.quickCommands ?? []).map((q, i) => ({
    id: str(q?.id, `quickCommands[${i}].id`),
    label: str(q?.label, `quickCommands[${i}].label`),
    prompt: str(q?.prompt, `quickCommands[${i}].prompt`),
  }));

  return {
    rootDir,
    port,
    accounts,
    projects,
    quickCommands,
    directivesFile: resolve(str(raw.directivesFile, 'directivesFile')),
  };
}
