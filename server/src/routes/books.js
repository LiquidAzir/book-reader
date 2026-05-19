const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const router = express.Router();

const GUTENDEX = 'https://gutendex.com';
const MAX_ENTRIES = Number(process.env.BOOK_CACHE_MAX_ENTRIES || 50);

// Simple LRU for fetched book text. Render free tier has limited memory, so we
// cap entries and evict oldest. Each entry is the cleaned plain-text body.
const textCache = new Map(); // bookId -> { text, fetchedAt }
function cacheGet(id) {
  if (!textCache.has(id)) return null;
  const v = textCache.get(id);
  textCache.delete(id);
  textCache.set(id, v); // bump to most-recent
  return v.text;
}
function cacheSet(id, text) {
  textCache.set(id, { text, fetchedAt: Date.now() });
  while (textCache.size > MAX_ENTRIES) {
    const oldest = textCache.keys().next().value;
    textCache.delete(oldest);
  }
}

// Proxy Gutendex search/browse to keep the frontend free of CORS and to let us
// add caching/rate-limiting later without a redeploy.
router.get('/books', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await fetch(GUTENDEX + '/books?' + qs);
    if (!r.ok) return res.status(r.status).json({ error: 'Gutendex error' });
    const data = await r.json();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    console.error('[books] list failed:', err.message);
    res.status(502).json({ error: 'Upstream fetch failed' });
  }
});

router.get('/books/:id', async (req, res) => {
  const id = String(req.params.id);
  try {
    const r = await fetch(GUTENDEX + '/books/' + encodeURIComponent(id));
    if (!r.ok) return res.status(r.status).json({ error: 'Gutendex error' });
    const data = await r.json();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    console.error('[books] detail failed:', err.message);
    res.status(502).json({ error: 'Upstream fetch failed' });
  }
});

router.get('/books/:id/content', async (req, res) => {
  const id = String(req.params.id);
  const cached = cacheGet(id);
  if (cached != null) {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain; charset=utf-8').send(cached);
    return;
  }
  try {
    // Fetch metadata to find a plain-text format URL.
    const metaRes = await fetch(GUTENDEX + '/books/' + encodeURIComponent(id));
    if (!metaRes.ok) return res.status(metaRes.status).json({ error: 'Gutendex error' });
    const meta = await metaRes.json();
    const fmts = meta.formats || {};
    const url =
      fmts['text/plain; charset=utf-8'] ||
      fmts['text/plain'] ||
      fmts['text/plain; charset=us-ascii'] ||
      // Some books only have .txt.utf-8 with a different key form
      Object.keys(fmts).find((k) => k.startsWith('text/plain') && fmts[k]);
    const finalUrl = typeof url === 'string' ? url : (url ? fmts[url] : null);
    if (!finalUrl) {
      return res.status(404).json({ error: 'No plain-text edition available for this book' });
    }
    const r = await fetch(finalUrl);
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch book content' });
    const text = await r.text();
    cacheSet(id, text);
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    console.error('[books] content failed:', err.message);
    res.status(502).json({ error: 'Upstream fetch failed' });
  }
});

module.exports = router;
