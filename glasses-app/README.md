# Reader interface

This frontend stays dependency-free and works at the Meta Display's 600×600 viewport and in native phone layouts. Covers use static CSS, and the reader keeps only one displayed page in the DOM.

## Controls

- Library: arrows move between books, tabs and actions. Enter or a click on the focused element activates it. Touch also works.
- Reading: left/right turn pages; up focuses the toolbar; down or a pinch/Enter on the text opens the reading menu. Previous/Next buttons support touch and repeated focused activation.
- Menu: text size and line spacing reflow around the same source passage. Back to reading restores focus to the text. Escape closes the menu first, then leaves the book.
- Search: type with a normal keyboard or use **Spell with D-pad**. The letter grid includes space and delete. Up/down can leave the input field, while left/right preserve normal text editing.

## Saved data and compatibility

The existing `mdg_book_reader_v1` and `mdg_book_reader_v1:device` keys and personal API routes are preserved. Device identity is never shown in ordinary settings.

Backup belongs to this browser's anonymous identity; there is no account or recovery login. Clearing browser storage also clears that identity and local reading data. The server backup cannot restore the previous library without the original identity, so it does not provide recovery after browser storage is cleared.

New progress records retain `fraction` and add a local `offset`, normalized `textLength`, and `anchorVersion`. Legacy records still resume using their previous page fraction; newly saved local records return to the exact source anchor across text-size and viewport changes. The server receives only the existing fraction payload. Normalization removes Gutenberg envelope text, folds source line wrapping, and removes balanced literary underscore emphasis markers.

Progress is committed only for successfully loaded, active reading sessions. Leaving a pending or failed load never replaces an existing position. Book/detail/search generations and abort signals prevent stale responses from changing another book or screen.

Personal mutations are saved locally before sending, with one in-flight request per key and a durable latest-value retry queue. Favorite removal timestamps prevent stale server responses from restoring deleted entries. Hydration merges timestamps without discarding newer local data. Outgoing writes use keepalive. If a page closes while an older write is still in flight, its newer pending value stays local for the next visit rather than being sent concurrently out of order.

## Verification

From the repository root, with the frontend served at `http://127.0.0.1:5213/`:

```
node tests/frontend.browser.cjs
node tests/frontend.sync.cjs
node tests/frontend.pagination.cjs
```

Set `PLAYWRIGHT_MODULE` to your installed Playwright module path if needed. Tests use disposable browser contexts, fixture APIs and isolated identities. They cover 36 UI/input/race scenarios, 10 hydration/retry scenarios and 48 font/spacing/viewport combinations, including complete page reconstruction and exact-anchor retention. The real Gutenberg Pride and Prejudice edition is separately checked through the local backend.
