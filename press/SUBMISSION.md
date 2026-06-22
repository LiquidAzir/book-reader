# Book Reader — App Submission Packet

All assets and copy needed for the "Add an app" form. Files live in
`book-reader/press/`.

## Form fields

| Field | Value |
|-------|-------|
| **App name** | `Book Reader` |
| **Tagline** (40 char max) | `78,000+ free books on your glasses` (34 chars) |
| **Category** | Try `Reading`, `Books`, or `Education` first in the dropdown — fall back to `other` if none of those exist |
| **Visibility** | `Public — listed in the catalog` |
| **Developer / studio name** | `LiquidAzir` (your GitHub handle; change if you'd rather use a real name or a brand) |
| **App link** | `https://book-reader-glasses.onrender.com` |
| **App icon** | [`press/icon-512.png`](icon-512.png) — 512×512 PNG |

## Tagline alternatives

If the recommendation doesn't fit, here are a few backups (all ≤40 chars):

- `Read the classics on your glasses` (33)
- `Project Gutenberg, on your glasses` (34)
- `Free public-domain books for glasses` (36)
- `A clean reader for free classics` (32)

## Description

Pick whichever length the form accepts; the longer version is the better
pitch if there's room.

### Short (one paragraph)

> Read 78,000+ free public-domain classics from Project Gutenberg on your Meta
> Ray-Ban Display glasses. Browse popular titles, search by author, and open
> books directly from a curated list of famous works. Adjustable text size,
> paragraph-aware pagination, and resume-where-you-left-off across sessions —
> all driven by D-pad navigation.

### Longer

> Book Reader brings the entire Project Gutenberg library — 78,000+ free
> public-domain books — to your Meta Ray-Ban Display glasses, with a UI
> designed for the additive display: pure black background, high-contrast
> text, and adjustable sizes from Small to Extra Large.
>
> Browse the most-downloaded classics, search by title or author, or pick
> from curated Fiction / Adventure / Mystery lists that include the entire
> Sherlock Holmes canon, Dracula, Frankenstein, Pride and Prejudice, Moby
> Dick, Treasure Island, and more. Every title opens in seconds with
> paragraph-aware pagination that fits cleanly on the 600×600 display.
>
> Your reading position is saved per book and synced across sessions via an
> anonymous device ID — no account required. Favorites and recently-read
> titles appear on the home screen for one-tap resume.
>
> D-pad navigation: swipe ←/→ to turn pages, ↑ to reach the back/menu
> toolbar, ↓ to open the text-size menu, tap to select. Built in vanilla
> HTML/JS — no plugin install needed.

## Screenshots (in order, up to 8)

All exported at exactly 600×600 PNG. The 7 captured cover every key surface
of the app; pick whichever subset matches the form's upload limit.

| # | File | Caption suggestion |
|---|------|--------------------|
| 1 | [`01-home-first-launch.png`](01-home-first-launch.png) | Home screen with on-board controls hint |
| 2 | [`02-browse-popular.png`](02-browse-popular.png) | Browse — top books in the full Gutenberg catalog |
| 3 | [`03-browse-mystery.png`](03-browse-mystery.png) | Curated tabs — Mystery showing the Sherlock canon |
| 4 | [`04-book-detail.png`](04-book-detail.png) | Book detail with full description and Read/Favorite actions |
| 5 | [`05-reader.png`](05-reader.png) | The reader — Dracula at the default Large text size |
| 6 | [`06-reader-menu.png`](06-reader-menu.png) | Text-size menu pulled from the bottom of the reader |
| 7 | [`07-home-with-recent.png`](07-home-with-recent.png) | Home with Continue Reading card after first session |

**Recommended subset if the catalog limits you to 4–5:**
`02-browse-popular`, `05-reader`, `06-reader-menu`, `07-home-with-recent`,
plus `03-browse-mystery` if there's room.

## Icon — 512×512

The icon at [`icon-512.png`](icon-512.png) is a higher-resolution version of
the in-app favicon. Same theme (cyan plate over dark grad, book lines), just
sized for catalog tiles. The 128×128 favicon shipped on the live site is at
`book-reader/glasses-app/favicon.png` if you need the smaller version too.
