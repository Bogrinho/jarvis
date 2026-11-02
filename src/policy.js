import path from 'node:path';

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

// Flags verified against `--help` of codex-cli 0.166.0, claude 2.1.316, gemini 0.66.0.
// codex no longer accepts `--ask-for-approval untrusted` (only on-request|never),
// so "cautious" is expressed through the read-only sandbox.
const MODE_ARGS = {
  codex: {
    cautious: ['--ask-for-approval', 'on-request', '--sandbox', 'read-only'],
    'edit-in-project': ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'],
  },
  claude: {
    cautious: ['--permission-mode', 'default'],
    'edit-in-project': ['--permission-mode', 'acceptEdits'],
  },
  gemini: {
    cautious: ['--approval-mode', 'default'],
    'edit-in-project': ['--approval-mode', 'auto_edit'],
  },
};

const key = (p) => path.resolve(p).toLowerCase();

export function allowedAccounts(config, side) {
  return Object.values(config.accounts)
    .filter((a) => a.enabled && a.side === side)
    .map((a) => a.id);
}

export function resolveTarget(config, { accountId, projectPath, useHome } = {}) {
  const account = Object.hasOwn(config.accounts, accountId) ? config.accounts[accountId] : undefined;
  if (!account) throw new PolicyError('UNKNOWN_ACCOUNT', `unknown account: ${accountId}`);
  if (!account.enabled) throw new PolicyError('DISABLED', `account ${account.id} is disabled`);

  if (useHome || !projectPath) {
    if (!account.home) throw new PolicyError('NO_HOME', `account ${account.id} has no home directory`);
    return { cwd: account.home, side: account.side };
  }

  const wanted = key(projectPath);
  const project = config.projects.find((p) => key(p.path) === wanted);
  if (!project) throw new PolicyError('UNKNOWN_PROJECT', `project not in config: ${projectPath}`);
  if (project.side !== account.side) {
    throw new PolicyError(
      'SIDE_MISMATCH',
      `account ${account.id} (${account.side}) may not run in ${project.side} project ${project.name}`,
    );
  }
  return { cwd: project.path, side: project.side };
}

export function buildLaunch(account) {
  const modeArgs = MODE_ARGS[account.cli]?.[account.mode];
  if (!modeArgs) throw new PolicyError('UNKNOWN_ACCOUNT', `no launch mapping for ${account.cli}/${account.mode}`);
  const env = { ...process.env, ...account.env };
  if (process.platform === 'win32') {
    // npm installs .cmd shims on Windows, which must go through cmd.exe.
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', account.cli, ...modeArgs], env };
  }
  return { file: account.cli, args: [...modeArgs], env };
}
