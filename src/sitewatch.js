// Reads the user's SiteWatch status (GET /api/status with a Bearer key) for the Jarvis
// dashboard. The key lives in a local file the user writes; it is sent only to the
// configured https SiteWatch address and never returned to the page.
import fs from 'node:fs/promises';

const FIELDS = ['name', 'host', 'status', 'response_time_ms', 'median_response_ms', 'p95_response_ms',
  'uptime_percentage', 'ssl_days_remaining', 'last_checked_at'];

export async function readSiteWatch({ url, tokenFile, fetch = globalThis.fetch, timeoutMs = 10000 }) {
  let token = '';
  try { token = (await fs.readFile(tokenFile, 'utf8')).trim(); } catch { token = ''; }
  if (!token) return { state: 'no-token' };
  let base;
  try { base = new URL(url); } catch { return { state: 'error', reason: 'bad url' }; }
  if (base.protocol !== 'https:') return { state: 'error', reason: 'bad url' };
  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(new URL('/api/status', base).href, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal,
    });
    if (res.status === 401) return { state: 'bad-token' };
    if (res.status === 404) return { state: 'disabled' };
    if (!res.ok) return { state: 'error', reason: `http ${res.status}` };
    const body = await res.json();
    if (!Array.isArray(body?.monitors)) return { state: 'error', reason: 'missing monitors' };
    const monitors = body.monitors.slice(0, 20).map((m) => Object.fromEntries(FIELDS.map((k) => [k, m?.[k] ?? null])));
    return { state: 'ok', generated_at: typeof body.generated_at === 'string' ? body.generated_at : null, monitors };
  } catch (err) {
    if (signal?.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { state: 'error', reason: 'timeout' };
    }
    return { state: 'error', reason: err instanceof SyntaxError ? 'bad json' : 'network' };
  }
}
