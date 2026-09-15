require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { attachUser } = require('./middleware/device');
const booksRoutes = require('./routes/books');
const meRoutes = require('./routes/me');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const origins = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: origins.includes('*') ? true : origins,
  credentials: false,
}));

app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, time: Date.now(), build: process.env.RENDER_GIT_COMMIT || 'local' });
});

app.use('/api', booksRoutes);
app.use('/api/me', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store'); res.vary('X-Device-Id'); next();
}, attachUser, meRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  console.error('[unhandled]', err.code || err.name || 'Error');
  const personal = req.originalUrl.startsWith('/api/me/');
  if (personal) res.set('Cache-Control', 'private, no-store').set('Retry-After', '10');
  res.status(personal ? 503 : 500).json({ error: personal ? 'Library temporarily unavailable. Please try again.' : 'Internal error' });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`[server] Listening on ${port}`));
}
module.exports = app;
