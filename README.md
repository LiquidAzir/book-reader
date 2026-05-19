# Book Reader

A book-reading web app for **Meta Ray-Ban Display** smart glasses. Read
70,000+ free classics from Project Gutenberg, browse, search, favorite, and
resume where you left off across sessions.

This is a v1 intended for public release. Anonymous-device identity (a UUID
in the browser's localStorage) — no login required, can upgrade to email-based
accounts later without a data migration.

## Architecture

```
book-reader/
  glasses-app/      Static frontend served at the public glasses URL
    index.html      All screens (home, browse, search, detail, reader, library, settings)
    app.js          State, navigation, pagination engine, API client
    config.js       Hostname-auto-detected API base URL
    styles.css      Dark theme tuned for the additive display
    favicon.png     128x128 themed icon

  server/           Node + Express backend
    src/
      index.js      App entry — CORS, JSON, routes
      routes/
        books.js    /api/books — Gutendex proxy + in-memory text cache (LRU)
        me.js       /api/me/* — favorites, progress, recents (requires X-Device-Id)
      middleware/
        device.js   Upserts users by X-Device-Id header
      db.js         pg pool
      schema.sql    users, favorites, reading_history
      migrate.js    Applies schema.sql

  render.yaml       Render Blueprint — provisions static site + API + Postgres
```

### Why a backend?

- **CORS** — gutenberg.org doesn't enable CORS on `.txt` downloads, so the
  glasses can't fetch book content directly. The server proxies and caches.
- **Public release** — favorites, reading progress, and recents need to survive
  localStorage clears. Stored server-side, keyed to the anonymous device ID.
- **Rate limiting** — a single cached fetch per book serves all readers.

### Identity model

Each first visit generates a UUID stored at `mdg_book_reader_v1:device`. Every
API call sends it as `X-Device-Id`. The server upserts a `users` row on first
sight. To attach an email account later, you can extend the `users` table and
keep the same row.

## Local dev

```bash
# 1. Postgres (any local instance) — optional; the books proxy works without it
createdb book_reader
cd server
cp .env.example .env
# Edit DATABASE_URL in .env if you want favorites/progress server-side
npm install
node src/migrate.js   # if you set DATABASE_URL
npm run dev           # http://localhost:3000

# 2. Frontend (any static server)
cd ../glasses-app
python -m http.server 5180
# Open http://localhost:5180/ — config.js auto-points to localhost:3000
```

Arrow keys = D-pad. Enter = tap. Escape = back. In the reader, ←/→ turn pages
and ↑/↓ open the size menu.

## Deploying to Render

The included [`render.yaml`](./render.yaml) provisions everything in one click.

1. Push this repo to GitHub.
2. In Render: **Blueprints → New Blueprint Instance**, select the repo.
3. Render creates: a Postgres DB, the API service, and the static site.
   `node src/migrate.js` runs as part of the API build, so the schema is
   applied automatically on first deploy.
4. After the static site deploys, copy its URL and:
   - Edit [`glasses-app/config.js`](./glasses-app/config.js) — replace
     `PROD_API_URL` with your actual API URL (e.g.
     `https://book-reader-api.onrender.com`) and re-deploy the static site.
   - In the API service settings, set `CORS_ORIGINS` to the static site URL
     (instead of `*`) for production.

The free tier puts the API to sleep after 15 minutes of inactivity. First
request after sleep takes ~30s to wake. Upgrade the API service plan to
prevent sleep if needed.

## Adding to your glasses

Once the static site is live at HTTPS:

1. Open the Meta AI app on your phone.
2. **Devices → Display Glasses → App connections → Web apps → Add**.
3. Enter "Book Reader" and the static site URL.

Or generate a QR code that deep-links into the Meta AI app — use the
`/qr-code` skill in Claude Code to produce one.

## Roadmap (v2)

- **Personal EPUB uploads** via a companion web page (the glasses lack a file
  picker). Server parses EPUB → plain text + chapter markers, stores in object
  storage (R2) keyed to the user.
- **Email account upgrade** — magic-link auth that attaches an email to an
  existing anonymous device ID so library follows the user across devices.
- **Chapter jump** — table of contents extracted from book metadata.
- **Bookmarks** within a book.
- **Custom themes** — sepia, high-contrast, etc.
