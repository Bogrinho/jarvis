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

test('reports safe reasons for HTTP, network, timeout and invalid response errors', async () => {
  const key = 'k'.repeat(40);
  const f = tokenFile(key);
  assert.equal((await readSiteWatch({ url: URL_, tokenFile: f, fetch: reply(401, {}) })).state, 'bad-token');
  assert.equal((await readSiteWatch({ url: URL_, tokenFile: f, fetch: reply(404, {}) })).state, 'disabled');
  const failures = [
    [reply(503, {}), 'http 503'],
    [async () => { throw new Error(key); }, 'network'],
    [async () => { throw new DOMException(key, 'TimeoutError'); }, 'timeout'],
    [async () => new Response(key), 'bad json'],
    [reply(200, { monitors: 'nope' }), 'missing monitors'],
  ];
  for (const [fetch, reason] of failures) {
    assert.deepEqual(await readSiteWatch({ url: URL_, tokenFile: f, fetch }), { state: 'error', reason });
  }
});

test('only https addresses are used', async () => {
  const f = tokenFile('k'.repeat(40));
  for (const url of ['http://insecure.example', 'invalid address']) {
    const r = await readSiteWatch({ url, tokenFile: f, fetch: reply(200, { monitors: [] }) });
    assert.deepEqual(r, { state: 'error', reason: 'bad url' });
  }
});
