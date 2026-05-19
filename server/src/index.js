require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { attachUser } = require('./middleware/device');
const booksRoutes = require('./routes/books');
const meRoutes = require('./routes/me');

const app = express();
app.set('trust proxy', 1);

const origins = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: origins.includes('*') ? true : origins,
  credentials: false,
}));

app.use(express.json({ limit: '64kb' }));
app.use(attachUser);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

app.use('/api', booksRoutes);
app.use('/api/me', meRoutes);

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal error' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[server] Listening on ${port}`);
});
