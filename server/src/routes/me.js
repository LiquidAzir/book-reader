const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../middleware/device');

const router = express.Router();

router.use(requireUser);

// ---- Favorites ----
router.get('/favorites', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT book_id AS id, title, author, EXTRACT(EPOCH FROM added_at)*1000 AS "addedAt"
       FROM favorites WHERE user_id = $1
       ORDER BY added_at DESC`,
    [req.user.id]
  );
  res.json({ favorites: rows });
});

router.post('/favorites', async (req, res) => {
  const { bookId, title, author } = req.body || {};
  if (!Number.isInteger(bookId) || !title) {
    return res.status(400).json({ error: 'bookId (int) and title required' });
  }
  await pool.query(
    `INSERT INTO favorites (user_id, book_id, title, author)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, book_id) DO NOTHING`,
    [req.user.id, bookId, title, author || null]
  );
  res.json({ ok: true });
});

router.delete('/favorites/:bookId', async (req, res) => {
  const bookId = Number(req.params.bookId);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: 'bad bookId' });
  await pool.query(
    `DELETE FROM favorites WHERE user_id = $1 AND book_id = $2`,
    [req.user.id, bookId]
  );
  res.json({ ok: true });
});

// ---- Progress ----
router.get('/progress/:bookId', async (req, res) => {
  const bookId = Number(req.params.bookId);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: 'bad bookId' });
  const { rows } = await pool.query(
    `SELECT fraction, EXTRACT(EPOCH FROM last_read_at)*1000 AS "updatedAt"
       FROM reading_history WHERE user_id = $1 AND book_id = $2`,
    [req.user.id, bookId]
  );
  res.json(rows[0] || { fraction: 0, updatedAt: 0 });
});

router.put('/progress/:bookId', async (req, res) => {
  const bookId = Number(req.params.bookId);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: 'bad bookId' });
  const f = Number((req.body || {}).fraction);
  if (!(f >= 0 && f <= 1)) return res.status(400).json({ error: 'fraction must be 0..1' });
  // Upsert — only update fraction/last_read_at; preserve title if already set.
  await pool.query(
    `INSERT INTO reading_history (user_id, book_id, title, author, fraction, last_read_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, book_id) DO UPDATE
         SET fraction = EXCLUDED.fraction,
             last_read_at = NOW()`,
    [req.user.id, bookId, '(unknown)', null, f]
  );
  res.json({ ok: true });
});

// ---- Recents ----
router.get('/recents', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT book_id AS id, title, author,
            fraction,
            EXTRACT(EPOCH FROM last_read_at)*1000 AS "lastReadAt"
       FROM reading_history
       WHERE user_id = $1
       ORDER BY last_read_at DESC
       LIMIT 20`,
    [req.user.id]
  );
  res.json({ recents: rows });
});

// Touched whenever a book is opened — records title/author so recents list
// has metadata even if progress is still 0.
router.post('/recents', async (req, res) => {
  const { bookId, title, author } = req.body || {};
  if (!Number.isInteger(bookId) || !title) {
    return res.status(400).json({ error: 'bookId (int) and title required' });
  }
  await pool.query(
    `INSERT INTO reading_history (user_id, book_id, title, author, fraction, last_read_at)
       VALUES ($1, $2, $3, $4, 0, NOW())
       ON CONFLICT (user_id, book_id) DO UPDATE
         SET title = EXCLUDED.title,
             author = EXCLUDED.author,
             last_read_at = NOW()`,
    [req.user.id, bookId, title, author || null]
  );
  res.json({ ok: true });
});

module.exports = router;
