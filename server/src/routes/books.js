const express = require('express');

const router = express.Router();

const GUTENDEX = 'https://gutendex.com';
const MAX_ENTRIES = Number(process.env.BOOK_CACHE_MAX_ENTRIES || 50);
// Gutendex list queries can take 15-20s under load. Allow up to 20s before
// we give up; the frontend uses a bundled fallback when Browse times out.
const FETCH_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 20000);
const METADATA_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour
const LIST_CACHE_TTL_MS = 1000 * 60 * 10;     // 10 minutes

// Aborts the upstream fetch after FETCH_TIMEOUT_MS so a slow/down Gutendex
// can't pin a request handler indefinitely.
async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// LRU cache for full book text (large). Keyed by bookId.
const textCache = new Map();
function lruGet(map, key) {
  if (!map.has(key)) return null;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}
function lruSet(map, key, value, cap) {
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value);
}

// In-memory cache for Gutendex JSON responses (list + detail). When Gutendex
// is down, we can serve stale entries so Browse still shows something.
const jsonCache = new Map(); // key -> { data, fetchedAt }
async function cachedJson(key, url, ttl) {
  const hit = lruGet(jsonCache, key);
  if (hit && Date.now() - hit.fetchedAt < ttl) {
    return { data: hit.data, fresh: true };
  }
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) throw new Error('upstream ' + r.status);
    const data = await r.json();
    lruSet(jsonCache, key, { data, fetchedAt: Date.now() }, 200);
    return { data, fresh: true };
  } catch (err) {
    if (hit) return { data: hit.data, fresh: false, error: err.message };
    throw err;
  }
}

// Proxy Gutendex search/browse with server-side caching + timeout so a slow
// upstream doesn't translate to slow Browse.
router.get('/books', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const key = 'list:' + qs;
  try {
    const { data, fresh } = await cachedJson(key, GUTENDEX + '/books?' + qs, LIST_CACHE_TTL_MS);
    res.set('Cache-Control', fresh ? 'public, max-age=300' : 'public, max-age=60');
    if (!fresh) res.set('X-Cache-Status', 'stale');
    res.json(data);
  } catch (err) {
    console.error('[books] list failed:', err.message);
    res.status(503).json({ error: 'Catalog temporarily unavailable. Try again in a moment.' });
  }
});

router.get('/books/:id', async (req, res) => {
  const id = String(req.params.id);
  try {
    const { data, fresh } = await cachedJson(
      'detail:' + id,
      GUTENDEX + '/books/' + encodeURIComponent(id),
      METADATA_CACHE_TTL_MS
    );
    res.set('Cache-Control', fresh ? 'public, max-age=3600' : 'public, max-age=300');
    if (!fresh) res.set('X-Cache-Status', 'stale');
    res.json(data);
  } catch (err) {
    console.error('[books] detail failed:', err.message);
    res.status(503).json({ error: 'Book metadata temporarily unavailable.' });
  }
});

// Allow-listed proxy for direct Gutenberg .txt URLs. Used by the frontend's
// fallback path when the catalog API is unreachable but we know the canonical
// URL ahead of time (from the bundled fallback catalog).
const ALLOWED_PROXY_HOSTS = new Set([
  'www.gutenberg.org',
  'gutenberg.org',
  'www.gutenberg.net',
]);
router.get('/proxy', async (req, res) => {
  const raw = String(req.query.url || '');
  let url;
  try { url = new URL(raw); }
  catch { return res.status(400).json({ error: 'bad url' }); }
  if (url.protocol !== 'https:' || !ALLOWED_PROXY_HOSTS.has(url.hostname)) {
    return res.status(403).json({ error: 'host not allowed' });
  }
  try {
    const r = await fetchWithTimeout(url.toString(), { timeoutMs: 20_000 });
    if (!r.ok) return res.status(r.status).json({ error: 'upstream ' + r.status });
    const text = await r.text();
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    console.error('[proxy] failed:', err.message);
    res.status(503).json({ error: 'Upstream fetch failed' });
  }
});

router.get('/books/:id/content', async (req, res) => {
  const id = String(req.params.id);
  const cached = lruGet(textCache, id);
  if (cached) {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain; charset=utf-8').send(cached.text);
    return;
  }
  try {
    // Need metadata to find the plain-text format URL. Use cached metadata if available.
    const { data: meta } = await cachedJson(
      'detail:' + id,
      GUTENDEX + '/books/' + encodeURIComponent(id),
      METADATA_CACHE_TTL_MS
    );
    const fmts = (meta && meta.formats) || {};
    const finalUrl =
      fmts['text/plain; charset=utf-8'] ||
      fmts['text/plain'] ||
      fmts['text/plain; charset=us-ascii'] ||
      Object.entries(fmts).find(([k, v]) => k.startsWith('text/plain') && v)?.[1];
    if (!finalUrl) {
      return res.status(404).json({ error: 'No plain-text edition available for this book' });
    }
    // Book text downloads can be 500KB+, give them a longer timeout.
    const r = await fetchWithTimeout(finalUrl, { timeoutMs: 20_000 });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch book content' });
    const text = await r.text();
    lruSet(textCache, id, { text, fetchedAt: Date.now() }, MAX_ENTRIES);
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    console.error('[books] content failed:', err.message);
    res.status(503).json({ error: 'Book content temporarily unavailable. Try again in a moment.' });
  }
});

module.exports = router;
