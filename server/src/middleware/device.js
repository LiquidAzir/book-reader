const { pool } = require('../db');

const DEVICE_ID_RE = /^dev_[A-Za-z0-9-]{8,128}$/;

// Identifies the caller by X-Device-Id header. Lazy-creates a users row on first sight.
// Only personal-library routes need this database lookup. Browsing stays public.
async function attachUser(req, res, next) {
  const id = req.header('X-Device-Id');
  if (!id || !DEVICE_ID_RE.test(id)) {
    req.user = null;
    return next();
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (device_id)
         VALUES ($1)
         ON CONFLICT (device_id) DO UPDATE SET last_seen_at = NOW()
         RETURNING id, device_id, email`,
      [id]
    );
    req.user = rows[0];
    next();
  } catch (err) {
    console.error('[device] library unavailable:', err.code || err.name);
    req.user = null;
    res.set('Retry-After', '10').status(503).json({ error: 'Library temporarily unavailable. Your device identity is unchanged.' });
  }
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Missing or invalid X-Device-Id' });
  }
  next();
}

module.exports = { attachUser, requireUser };
