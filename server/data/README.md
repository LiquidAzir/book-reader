# Gutenberg offline metadata

`gutenberg-catalog.json.gz` is a server-only compact index generated from Project Gutenberg's published CSV catalog. It contains metadata, not the books themselves. The frontend receives at most32 entries per list response and never downloads this asset.

Official source: https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz
Publisher's documentation: https://www.gutenberg.org/ebooks/offline_catalogs.html

The adjacent metadata manifest records the input SHA-256, source gzip timestamp, retrieval timestamp, exact record counts, generated asset hash, and featured ordering. Source snapshot2026-09-13 contains79,381 records, of which78,130 are Text editions;1,251 non-text entries are intentionally omitted.

Refresh deliberately, then review/tests/deploy:

```
node scripts/refresh-catalog.cjs
node --test tests/catalog.test.cjs
```

An already downloaded official feed can be used with `--input path/to/pg_catalog.csv.gz`. Downloads and decompression are bounded, schema/count validation runs before output replacement, and the running process retains its loaded snapshot until restart. No request-time scraping or attempts to evade upstream restrictions occur.

List search matches title/agent words with Unicode normalization. Language lists match any supplied code; topics match subjects/bookshelves; ascending/descending sort by Gutenberg ID. `popular` uses the application's existing featured classics followed by ascending IDs, explicitly marked as such. The CSV has no download statistics or copyright status, so those fields remain `null`. Author-year filtering and claims of known copyright are rejected with status400. Generated plain-text URLs use Gutenberg's official per-book endpoint; individual text editions can still be unavailable.
