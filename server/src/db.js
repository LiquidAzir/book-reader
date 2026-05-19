const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db] DATABASE_URL is not set — DB calls will fail.');
}

const pool = new Pool({
  connectionString,
  // Render-managed Postgres requires TLS; allow self-signed cert on the internal hostname.
  ssl: connectionString && connectionString.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error', err);
});

module.exports = { pool };
