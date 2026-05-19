const { pool } = require('../db');

const DEVICE_ID_RE = /^dev_[A-Za-z0-9-]{8,128}$/;

// Identifies the caller by X-Device-Id header. Lazy-creates a users row on first sight.
// Routes that need an identified caller use `requireUser`; routes that are open
// (e.g. browse) use the lighter `attachUser` which doesn't 401.
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
    console.error('[device] upsert failed:', err.message);
    req.user = null;
    next();
  }
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Missing or invalid X-Device-Id' });
  }
  next();
}

module.exports = { attachUser, requireUser };
