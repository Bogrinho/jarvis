import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSiteWatch } from '../src/sitewatch.js';

const URL_ = 'https://sitewatch.example.workers.dev';
function tokenFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sw-'));
  const f = path.join(dir, 'sitewatch-token.txt');
  if (content !== undefined) fs.writeFileSync(f, content);
  return f;
}
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('no token file: asks for the key and never calls the network', async () => {
  let called = false;
  const r = await readSiteWatch({ url: URL_, tokenFile: tokenFile(), fetch: async () => { called = true; } });
  assert.deepEqual(r, { state: 'no-token' });
  assert.equal(called, false);
});

test('sends the key as a Bearer token to /api/status and keeps only the known fields', async () => {
  let seen;
  const body = {
    generated_at: '2026-11-03T00:00:00Z',
    monitors: [
      { name: 'TestraTech', host: 'testratech.gr', status: 'up', response_time_ms: 211, median_response_ms: 230, p95_response_ms: 400,
        uptime_percentage: 99.8, ssl_days_remaining: 40, last_checked_at: '2026-11-03T00:00:00Z', secret: 'drop me' },
    ],
  };
  const r = await readSiteWatch({
    url: URL_ + '/', tokenFile: tokenFile('  abc123xyz-token-0123456789abcdef \n'),
    fetch: async (u, opts) => { seen = { u, opts }; return reply(200, body)(); },
  });
  assert.equal(seen.u, URL_ + '/api/status');
  assert.equal(seen.opts.headers.Authorization, 'Bearer abc123xyz-token-0123456789abcdef');
  assert.equal(r.state, 'ok');
  assert.equal(r.monitors[0].secret, undefined);
  assert.equal(r.monitors[0].host, 'testratech.gr');
  assert.equal(r.monitors[0].median_response_ms, 230);
  assert.equal(JSON.stringify(r).includes('abc123'), false, 'the key is never in the result');
});

test('wrong key, endpoint off, server error and network failure are reported plainly', async () => {
  const f = tokenFile('k'.repeat(40));
  assert.equal((await readSiteWatch({ url: URL_, tokenFile: f, fetch: reply(401, {}) })).state, 'bad-token');
  assert.equal((await readSiteWatch({ url: URL_, tokenFile: f, fetch: reply(404, {}) })).state, 'disabled');
  assert.equal((await readSiteWatch({ url: URL_, tokenFile: f, fetch: reply(503, {}) })).state, 'error');
  assert.equal((await readSiteWatch({ url: URL_, tokenFile: f, fetch: async () => { throw new Error('offline'); } })).state, 'error');
  assert.equal((await readSiteWatch({ url: URL_, tokenFile: f, fetch: reply(200, { monitors: 'nope' }) })).state, 'error');
});

test('only https addresses are used', async () => {
  const r = await readSiteWatch({ url: 'http://insecure.example', tokenFile: tokenFile('k'.repeat(40)), fetch: reply(200, { monitors: [] }) });
  assert.equal(r.state, 'error');
});
