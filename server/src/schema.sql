-- Book Reader schema.
-- Identity model: anonymous device IDs. Email is nullable so we can attach an
-- account later without a migration.

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT UNIQUE NOT NULL,
  email       TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id   INTEGER NOT NULL,
  title     TEXT NOT NULL,
  author    TEXT,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS favorites_user_added_idx
  ON favorites (user_id, added_at DESC);

CREATE TABLE IF NOT EXISTS reading_history (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  author        TEXT,
  fraction      REAL NOT NULL DEFAULT 0,
  last_read_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS reading_history_user_recent_idx
  ON reading_history (user_id, last_read_at DESC);
