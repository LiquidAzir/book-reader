const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const originalFetch = global.fetch;
const app = require('../src/index');
const { pool } = require('../src/db');
const { readUpstream, bookUrl, bookRedirectUrl } = require('../src/upstream');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const device = 'dev_test-device-12345678';

test('Book Reader API regressions (isolated database and upstream)', async t => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (route, options = {}) => originalFetch(base + route, options);
  const personal = (route, body, method = 'POST') => request('/api/me' + route, { method, headers: { 'X-Device-Id': device, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const originalQuery = pool.query;
  try {
    await t.test('catalog and health do not depend on the personal-library database', async () => {
      let queries = 0; pool.query = async () => { queries++; throw Error('DB offline'); };
      global.fetch = async () => json({ count: 0, results: [] });
      for (const path of ['/api/health', '/api/books?search=independent-catalog']) assert.equal((await request(path, { headers: { 'X-Device-Id': device } })).status, 200);
      assert.equal(queries, 0);
    });
    await t.test('missing identity is 401; database outage is retryable 503 without losing identity', async () => {
      assert.equal((await request('/api/me/favorites')).status, 401);
      pool.query = async () => { throw Object.assign(Error('private connection detail'), { code: 'ECONNREFUSED' }); };
      const r = await request('/api/me/favorites', { headers: { 'X-Device-Id': device } });
      assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '10'); assert.match(r.headers.get('cache-control'), /no-store/);
      assert.doesNotMatch(await r.text(), /private connection detail/);
    });
    await t.test('async library query failures reach JSON error handler; process serves next request', async () => {
      pool.query = async sql => { if (sql.includes('INSERT INTO users')) return { rows: [{ id: 7 }] }; throw Error('database query failure'); };
      const r = await request('/api/me/recents', { headers: { 'X-Device-Id': device } });
      assert.equal(r.status, 503); assert.match((await r.json()).error, /temporarily unavailable/);
      assert.equal((await request('/api/health')).status, 200);
    });
    await t.test('invalid progress never coerces null, booleans or strings into a zero reset', async () => {
      const queries = [];
      pool.query = async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id: 7 }] }; };
      for (const fraction of [null, false, '', '0.5', -0.1, 1.1, {}, []]) assert.equal((await personal('/progress/1342', { fraction }, 'PUT')).status, 400);
      assert.ok(queries.every(q => q.sql.includes('INSERT INTO users')));
      assert.equal((await personal('/progress/1342', { fraction: 0.375 }, 'PUT')).status, 200);
      assert.deepEqual(queries.at(-1).params, [7, 1342, '(unknown)', null, 0.375]);
    });
    await t.test('IDs and metadata are bounded, and parameterized writes retain original API shape', async () => {
      const writes = []; pool.query = async (sql, params) => { writes.push({ sql, params }); return { rows: [{ id: 7 }] }; };
      for (const id of ['-1', '0', '0x10', '1e3', '2147483648']) assert.equal((await personal('/progress/' + id, { fraction: 0.5 }, 'PUT')).status, 400);
      for (const body of [{ bookId: -1, title: 'a' }, { bookId: 1, title: {} }, { bookId: 1, title: ' ' }, { bookId: 1, title: 'a', author: [] }]) assert.equal((await personal('/favorites', body)).status, 400);
      assert.equal((await personal('/favorites', { bookId: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' })).status, 200);
      assert.deepEqual(writes.at(-1).params, [7, 1342, 'Pride and Prejudice', 'Jane Austen']);
      assert.match(writes.at(-1).sql, /\$1/);
    });
    await t.test('library responses are private and scoped to the identified user', async () => {
      const reads = [];
      pool.query = async (sql, params) => {
        if (sql.includes('INSERT INTO users')) return { rows: [{ id: params[0] === device ? 7 : 8 }] };
        reads.push(params); return { rows: [{ id: params[0] === 7 ? 1342 : 11, title: 'Fixture' }] };
      };
      for (const identity of [device, 'dev_second-device-87654321']) {
        const r = await request('/api/me/favorites', { headers: { 'X-Device-Id': identity } });
        assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /private, no-store/); assert.match(r.headers.get('vary'), /X-Device-Id/i);
        assert.equal((await r.json()).favorites[0].id, identity === device ? 1342 : 11);
      }
      assert.deepEqual(reads, [[7], [8]]);
    });
    await t.test('malformed JSON returns 400 and large payloads return 413', async () => {
      const headers = { 'Content-Type': 'application/json', 'X-Device-Id': device };
      assert.equal((await request('/api/me/favorites', { method: 'POST', headers, body: '{' })).status, 400);
      assert.equal((await personal('/favorites', { title: 'a'.repeat(70000), bookId: 1 })).status, 413);
    });
    await t.test('proxy rejects credentials, nonstandard ports and off-host URLs before fetch', async () => {
      let calls = 0; global.fetch = async () => { calls++; return new Response('bad'); };
      for (const url of ['https://127.0.0.1/a.txt', 'http://gutenberg.org/a.txt', 'https://name:secret@gutenberg.org/a.txt', 'https://www.gutenberg.org:444/a.txt']) {
        assert.equal((await request('/api/proxy?url=' + encodeURIComponent(url))).status, 403);
      }
      assert.equal(calls, 0);
      assert.equal((await request('/api/books/0')).status, 400);
      assert.equal((await request('/api/books?search[0]=x')).status, 400);
    });
    await t.test('every redirect and metadata-provided content URL is host-validated', async () => {
      const called = [];
      global.fetch = async url => { called.push(url); return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }); };
      assert.equal((await request('/api/proxy?url=' + encodeURIComponent('https://www.gutenberg.org/redirect-fixture.txt'))).status, 403);
      assert.equal(called.length, 1);
      global.fetch = async url => { called.push(url); return json({ id: 91001, formats: { 'text/plain': 'https://localhost/private' } }); };
      assert.equal((await request('/api/books/91001/content')).status, 403);
      assert.ok(called.every(url => !url.includes('localhost') && !url.includes('127.0.0.1')));
    });
    await t.test('canonical Gutenberg HTTP redirect is upgraded to HTTPS without an insecure request', async () => {
      const calls = [];
      const result = await readUpstream('https://www.gutenberg.org/ebooks/1342.txt.utf-8', { validateRedirect: bookRedirectUrl, fetchImpl: async url => {
        calls.push(url);
        return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: 'http://www.gutenberg.org/cache/epub/1342/pg1342.txt' } }) : new Response('The book text');
      } });
      assert.equal(result.text, 'The book text');
      assert.deepEqual(calls, ['https://www.gutenberg.org/ebooks/1342.txt.utf-8', 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt']);
      assert.throws(() => bookRedirectUrl('http://localhost/private'));
    });
    await t.test('concurrent readers share one catalog and one text download; proxy shares text cache', async () => {
      const called = [], textUrl = 'https://www.gutenberg.org/cache/epub/91002/pg91002.txt';
      global.fetch = async url => { called.push(url); await delay(10); return url.includes('gutendex') ? json({ id: 91002, formats: { 'text/plain; charset=utf-8': textUrl } }) : new Response('Original fixture book.\nChapter I', { headers: { 'Content-Type': 'text/plain' } }); };
      const responses = await Promise.all(Array.from({ length: 12 }, () => request('/api/books/91002/content')));
      for (const r of responses) { assert.equal(r.status, 200); assert.match(await r.text(), /Chapter I/); }
      assert.equal(called.length, 2);
      assert.equal((await request('/api/proxy?url=' + encodeURIComponent(textUrl))).status, 200);
      assert.equal(called.length, 2);
    });
    await t.test('missing books stay 404; HTML error pages cannot become cached book text', async () => {
      global.fetch = async () => new Response('missing', { status: 404 });
      assert.equal((await request('/api/books/91003')).status, 404);
      global.fetch = async () => new Response('<html>temporarily unavailable</html>', { headers: { 'Content-Type': 'text/html' } });
      const r = await request('/api/proxy?url=' + encodeURIComponent('https://www.gutenberg.org/error-fixture.txt'));
      assert.equal(r.status, 502); assert.match(r.headers.get('cache-control'), /no-store/);
    });
    await t.test('redirect loops and oversized streamed bodies stop within fixed bounds', async () => {
      let calls = 0;
      await assert.rejects(readUpstream('https://www.gutenberg.org/loop.txt', { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { Location: '/loop.txt' } }); } }), e => e.status === 502);
      assert.equal(calls, 5);
      await assert.rejects(readUpstream('https://www.gutenberg.org/large.txt', { maxBytes: 4, fetchImpl: async () => new Response('12345') }), e => e.status === 413);
      assert.throws(() => bookUrl('https://www.gutenberg.org.evil.example/a.txt'));
    });
    await t.test('upstream timeout covers the body after headers have already arrived', async () => {
      const slow = http.createServer((req, res) => { res.writeHead(200); res.write('start'); const timer = setTimeout(() => res.end('end'), 1000); res.on('close', () => clearTimeout(timer)); });
      slow.listen(0, '127.0.0.1'); await new Promise(resolve => slow.once('listening', resolve));
      const started = Date.now();
      try {
        await assert.rejects(readUpstream('https://www.gutenberg.org/slow.txt', { timeoutMs: 80, fetchImpl: (_, options) => originalFetch('http://127.0.0.1:' + slow.address().port, options) }), e => e.status === 503);
        assert.ok(Date.now() - started < 700);
      } finally { slow.closeAllConnections(); await new Promise(resolve => slow.close(resolve)); }
    });
    await t.test('datacenter refusal falls back to the official catalog with one bounded retry circuit', async () => {
      let catalogCalls = 0, textCalls = 0;
      global.fetch = async url => {
        if (new URL(url).hostname === 'gutendex.com') { catalogCalls++; return new Response('Denied', { status: 403 }); }
        textCalls++; return new Response('Official book text fixture', { headers: { 'Content-Type': 'text/plain' } });
      };
      const search = await request('/api/books?search=pride%20prejudice&languages=en');
      assert.equal(search.status, 200); assert.equal(search.headers.get('x-catalog-source'), 'gutenberg-offline');
      const data = await search.json(); assert.equal(data.catalog_source, 'gutenberg-offline'); assert.ok(data.results.some(book => book.id === 1342));
      const detail = await request('/api/books/1342'); assert.equal(detail.status, 200); assert.equal((await detail.json()).copyright, null);
      const content = await request('/api/books/1342/content'); assert.equal(content.status, 200); assert.equal(await content.text(), 'Official book text fixture');
      assert.equal((await request('/api/books?copyright=false')).status, 400);
      assert.equal((await request('/api/books/2147483647')).status, 404);
      assert.equal(catalogCalls, 1); assert.equal(textCalls, 1);
    });
  } finally {
    global.fetch = originalFetch; pool.query = originalQuery;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await pool.end();
  }
});
