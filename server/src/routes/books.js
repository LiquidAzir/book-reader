const express = require('express');
const { bookIdParam } = require('../http');
const { bookUrl, bookRedirectUrl, catalogUrl, boundedInt, readUpstream, UpstreamError } = require('../upstream');
const router = express.Router();
const TIMEOUT = boundedInt(process.env.UPSTREAM_TIMEOUT_MS, 20000, 100, 30000);
const MAX_ENTRIES = boundedInt(process.env.BOOK_CACHE_MAX_ENTRIES, 50, 1, 100);
const MAX_TEXT_BYTES = boundedInt(process.env.BOOK_CACHE_MAX_BYTES, 32 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
const jsonCache = new Map(), textCache = new Map(), inFlight = new Map();
function hit(map, key) {
  const value = map.get(key);
  if (value) { map.delete(key); map.set(key, value); }
  return value;
}
function put(map, key, data, cap, byteCap) {
  const bytes = Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data));
  map.delete(key);
  if (bytes > byteCap) return;
  map.set(key, { data, bytes, at: Date.now() });
  let total = [...map.values()].reduce((sum, item) => sum + item.bytes, 0);
  while (map.size > cap || total > byteCap) {
    const first = map.keys().next().value; total -= map.get(first).bytes; map.delete(first);
  }
}
function once(key, work) {
  if (inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= 12) return Promise.reject(new UpstreamError('Book service is busy. Please try again.'));
  const pending = Promise.resolve().then(work).finally(() => inFlight.delete(key));
  inFlight.set(key, pending); return pending;
}
async function catalog(key, url, ttl) {
  const cached = hit(jsonCache, key);
  if (cached && Date.now() - cached.at < ttl) return { data: cached.data, fresh: true };
  try {
    return await once(key, async () => {
      const response = await readUpstream(url, { validate: catalogUrl, timeoutMs: TIMEOUT, maxBytes: 2 * 1024 * 1024 });
      let data; try { data = JSON.parse(response.text); } catch { throw new UpstreamError('Invalid catalog response', 502); }
      if (!data || typeof data !== 'object' || (key.startsWith('list:') ? !Array.isArray(data.results) : typeof data.formats !== 'object' || !data.formats)) throw new UpstreamError('Invalid catalog response', 502);
      put(jsonCache, key, data, 200, 8 * 1024 * 1024);
      return { data, fresh: true };
    });
  } catch (err) {
    if (cached && err.status !== 404) return { data: cached.data, fresh: false };
    throw err;
  }
}
async function bookText(raw) {
  const url = bookRedirectUrl(raw).toString(), cached = hit(textCache, url);
  if (cached) return cached.data;
  return once('text:' + url, async () => {
    const response = await readUpstream(url, { timeoutMs: TIMEOUT, validateRedirect: bookRedirectUrl });
    if (!response.text.trim() || /(?:text\/html|application\/(?:json|xml))/i.test(response.contentType) || /^\s*(?:<!doctype html|<html)/i.test(response.text)) throw new UpstreamError('No readable text edition returned', 502);
    put(textCache, url, response.text, MAX_ENTRIES, MAX_TEXT_BYTES);
    return response.text;
  });
}
function failure(res, err, fallback) {
  const status = err instanceof UpstreamError ? err.status : 503;
  // Operational diagnostics contain only error codes, never URLs, book text or identity.
  console.warn('[book-upstream]', err.code || err.cause?.code || err.name || 'Error', status);
  if (status === 503) res.set('Retry-After', '10');
  res.set('Cache-Control', 'no-store').status(status).json({ error: status === 404 ? 'Book not found' : status === 413 ? 'This text edition is too large to load.' : fallback });
}
function sendText(res, text) { res.set('Cache-Control', 'public, max-age=86400').type('text/plain; charset=utf-8').send(text); }

router.get('/books', async (req, res) => {
  const allowed = new Set(['search', 'topic', 'page', 'languages', 'mime_type', 'sort', 'ids', 'copyright', 'author_year_start', 'author_year_end']);
  const query = new URLSearchParams();
  for (const key of Object.keys(req.query).sort()) {
    const value = req.query[key];
    if (!allowed.has(key) || typeof value !== 'string' || value.length > 1000 || (key === 'page' && !/^[1-9]\d{0,5}$/.test(value))) return res.status(400).json({ error: 'Invalid catalog query' });
    query.set(key, value);
  }
  try {
    const { data, fresh } = await catalog('list:' + query, 'https://gutendex.com/books?' + query, 600000);
    res.set('Cache-Control', fresh ? 'public, max-age=300' : 'public, max-age=60');
    if (!fresh) res.set('X-Cache-Status', 'stale');
    res.json(data);
  } catch (err) { failure(res, err, 'Catalog temporarily unavailable. Try again in a moment.'); }
});
router.get('/proxy', async (req, res) => {
  let url;
  try {
    if (typeof req.query.url !== 'string' || req.query.url.length > 2048) return res.status(400).json({ error: 'Invalid book URL' });
    url = bookUrl(req.query.url);
  } catch { return res.status(403).json({ error: 'Book host not allowed' }); }
  try { sendText(res, await bookText(url.toString())); }
  catch (err) { failure(res, err, 'Book content temporarily unavailable. Try again in a moment.'); }
});
router.get('/books/:id', async (req, res) => {
  const id = bookIdParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid book ID' });
  try {
    const { data, fresh } = await catalog('detail:' + id, 'https://gutendex.com/books/' + id, 3600000);
    res.set('Cache-Control', fresh ? 'public, max-age=3600' : 'public, max-age=300');
    if (!fresh) res.set('X-Cache-Status', 'stale');
    res.json(data);
  } catch (err) { failure(res, err, 'Book metadata temporarily unavailable.'); }
});
router.get('/books/:id/content', async (req, res) => {
  const id = bookIdParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid book ID' });
  try {
    const { data } = await catalog('detail:' + id, 'https://gutendex.com/books/' + id, 3600000);
    const formats = data.formats;
    const url = formats['text/plain; charset=utf-8'] || formats['text/plain'] || formats['text/plain; charset=us-ascii'] || Object.entries(formats).find(([type, value]) => type.startsWith('text/plain') && value)?.[1];
    if (!url) return res.status(404).json({ error: 'No plain-text edition available for this book' });
    sendText(res, await bookText(url));
  } catch (err) { failure(res, err, 'Book content temporarily unavailable. Try again in a moment.'); }
});
module.exports = router;
