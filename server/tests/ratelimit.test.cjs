const { test } = require('node:test');
const assert = require('node:assert/strict');
// Tight limits for this process only; node --test runs each file in its own process.
process.env.RATE_LIMIT_READS = '10';
process.env.RATE_LIMIT_WRITES = '2';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
const originalFetch = global.fetch;
const app = require('../src/index');
const { pool } = require('../src/db');
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const device = 'dev_ratelimit-device-1234';

test('per-IP rate limits protect the proxy and the personal library', async t => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (route, options = {}) => originalFetch(base + route, options);
  const originalQuery = pool.query;
  try {
    global.fetch = async () => json({ count: 0, results: [] });
    pool.query = async sql => (/INSERT INTO users/.test(sql) ? { rows: [{ id: 1, device_id: device, email: null }] } : { rows: [] });
    // Every /api request counts toward the general limit (10 here); library writes have a tighter one (2).
    await t.test('writes: personal-library updates have their own tighter limit', async () => {
      const put = fraction => request('/api/me/progress/1342', { method: 'PUT', headers: { 'X-Device-Id': device, 'Content-Type': 'application/json' }, body: JSON.stringify({ fraction }) });
      assert.equal((await put(0.1)).status, 200);
      assert.equal((await put(0.2)).status, 200);
      const blocked = await put(0.3);
      assert.equal(blocked.status, 429);
      assert.deepEqual(await blocked.json(), { error: 'Too many library updates. Please slow down.' });
    });
    await t.test('reads: the general limit applies per window and returns a retryable 429', async () => {
      for (let i = 0; i < 7; i++) assert.equal((await request('/api/books?search=limit' + i)).status, 200); // requests 4..10
      const blocked = await request('/api/books?search=limit7'); // request 11
      assert.equal(blocked.status, 429);
      assert.match(blocked.headers.get('retry-after'), /^\d+$/);
      assert.match(blocked.headers.get('cache-control'), /no-store/);
      assert.deepEqual(await blocked.json(), { error: 'Too many requests. Please slow down.' });
    });
    await t.test('health checks are never limited', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await request('/api/health')).status, 200);
    });
  } finally {
    global.fetch = originalFetch; pool.query = originalQuery;
    await new Promise(resolve => server.close(resolve));
  }
});
