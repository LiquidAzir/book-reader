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

  render.yaml       Render Blueprint — static site + API using an existing Postgres database
```

### Why a backend?

- **CORS** — gutenberg.org doesn't enable CORS on `.txt` downloads, so the
  glasses can't fetch book content directly. The server proxies and caches.
- **Library backup** — favorites, reading progress, and recents are stored
  server-side under the browser's anonymous identity. Clearing browser storage
  also clears that identity, so the old library cannot be recovered without it.
- **Shared content cache** — concurrent readers share a bounded Gutenberg fetch
  and text cache, reducing repeated upstream requests.
- **Catalog resilience** — if Gutendex is unavailable, the API searches the
  official Gutenberg offline snapshot bundled on the server. The app shows its
  saved date. This index includes 78,130 text editions; it does not add a large
  download to the glasses. It records unknown copyright/download counts as
  unknown and labels its curated ordering instead of claiming live popularity.

### Identity model

Each first visit generates a UUID stored at `mdg_book_reader_v1:device`. Every
personal API call sends it as `X-Device-Id`. Public book browsing does not create
users or require the database. The server upserts a `users` row for personal
library requests. To attach an email account later, you can extend the `users` table and
keep the same row.

## Local dev

```bash
# Use Node 22. Postgres is optional; the books proxy works without it.
createdb book_reader
cd server
cp .env.example .env
# Edit DATABASE_URL in .env if you want favorites/progress server-side
npm ci
node src/migrate.js   # if you set DATABASE_URL
npm run dev           # http://localhost:3000

# 2. Frontend (any static server)
cd ../glasses-app
python -m http.server 5180
# Open http://localhost:5180/ — config.js auto-points to localhost:3000
```

Arrow keys = D-pad. Enter or focused click = pinch. Escape = back. In the reader,
←/→ turn pages, ↑ focuses the toolbar, and ↓ opens the reading menu. Touch
Previous/Next buttons also turn pages. See [reader controls and save behavior](glasses-app/README.md).

## Deploying to Render

The included [`render.yaml`](./render.yaml) defines the static site and API.
It uses a separately configured Postgres connection, such as the existing Neon database.

1. Push this repo to GitHub.
2. In Render: **Blueprints → New Blueprint Instance**, select the repo.
3. Supply the existing database connection as `DATABASE_URL`. Render creates the
   API service and static site. `npm ci && node src/migrate.js` installs the
   committed dependencies and applies the idempotent schema during the API build.
4. After the static site deploys, copy its URL and:
   - Edit [`glasses-app/config.js`](./glasses-app/config.js) — replace
     `PROD_API_URL` with your actual API URL (e.g.
     `https://book-reader-api.onrender.com`) and re-deploy the static site.
   - In the API service settings, set `CORS_ORIGINS` to the static site URL
     (instead of `*`) for production.

If the hosting plan puts an idle API to sleep, its first request can take longer
to complete. The reader keeps its local library and saved place during temporary
service failures and retries pending personal saves on later visits.

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
