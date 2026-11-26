import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function isTailnetHost(host) {
  return typeof host === 'string' && host.length <= 253 && host.endsWith('.ts.net') &&
    host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export async function detectTailnetHost(run = promisify(execFile)) {
  const args = ['status', '--json'];
  const options = { timeout: 5000, windowsHide: true };
  let result;
  try {
    result = await run('tailscale', args, options);
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'ENOENT') throw error;
    result = await run('C:\\Program Files\\Tailscale\\tailscale.exe', args, options);
  }
  const host = JSON.parse(result.stdout)?.Self?.DNSName?.replace(/\.$/, '').toLowerCase();
  if (!isTailnetHost(host)) throw new Error('missing or invalid Self.DNSName');
  return host;
}
