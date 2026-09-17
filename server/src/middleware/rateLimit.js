// Per-client request limiter, in memory (the API runs as one instance).
// Keeps a public deployment from being used as a bulk Gutenberg proxy or from
// filling the free Postgres with junk rows, while staying far above what a real
// reader generates. Limits are per client IP (trust proxy is enabled for Render).
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function createRateLimiter({ limit, windowMs = DEFAULT_WINDOW_MS, message = 'Too many requests. Please slow down.' }) {
  const buckets = new Map();
  let nextSweep = Date.now() + windowMs;
  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      nextSweep = now + windowMs;
    }
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) { bucket = { count: 0, resetAt: now + windowMs }; buckets.set(key, bucket); }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const windowMs = boundedInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, 1000, 60 * 60 * 1000);
// Reads: catalog, search, book text, library reads. ~1 request per screen; 600 per 10 min is generous.
const readLimiter = createRateLimiter({ limit: boundedInt(process.env.RATE_LIMIT_READS, 600, 1, 100000), windowMs });
// Writes: favorites/progress/recents. Progress saves are debounced client-side; 240 per 10 min is generous.
const writeLimiter = createRateLimiter({ limit: boundedInt(process.env.RATE_LIMIT_WRITES, 240, 1, 100000), windowMs, message: 'Too many library updates. Please slow down.' });

module.exports = { createRateLimiter, readLimiter, writeLimiter };
