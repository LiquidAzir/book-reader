require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[migrate] Applying schema…');
  await pool.query(sql);
  console.log('[migrate] Done.');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
