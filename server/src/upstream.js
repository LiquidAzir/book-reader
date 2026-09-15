const GUTENBERG_HOSTS = new Set(['www.gutenberg.org', 'gutenberg.org', 'www.gutenberg.net']);
class UpstreamError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
function bookUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new UpstreamError('Invalid book URL', 403); }
  if (url.protocol !== 'https:' || !GUTENBERG_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new UpstreamError('Book host not allowed', 403);
  return url;
}
function catalogUrl(raw) {
  const url = new URL(raw);
  if (url.origin !== 'https://gutendex.com' || url.username || url.password) throw new UpstreamError('Invalid catalog redirect', 502);
  return url;
}
function bookRedirectUrl(raw) {
  const url = new URL(raw);
  // Gutenberg's /ebooks/*.txt.utf-8 redirects to an HTTP canonical URL,
  // which itself redirects back to HTTPS. Upgrade it without making that hop.
  if (url.protocol === 'http:' && GUTENBERG_HOSTS.has(url.hostname) && !url.port) url.protocol = 'https:';
  return bookUrl(url.toString());
}
function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}
// One deadline covers redirects AND streaming the body, not just response headers.
async function readUpstream(raw, { validate = bookUrl, validateRedirect, timeoutMs = 20000, maxBytes = 12 * 1024 * 1024, fetchImpl = fetch } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = validate(raw), response;
    for (let hops = 0; hops < 5; hops++) {
      response = await fetchImpl(url.toString(), { signal: controller.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hops === 4) throw new UpstreamError('Too many upstream redirects', 502);
      url = (validateRedirect || validate)(new URL(location, url).toString());
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new UpstreamError(response.status === 404 ? 'Book not found' : 'Book service temporarily unavailable', response.status === 404 ? 404 : 503);
      error.code = 'UPSTREAM_HTTP_' + response.status;
      throw error;
    }
    const length = Number(response.headers.get('content-length'));
    if (length > maxBytes) { await response.body?.cancel(); throw new UpstreamError('Book response is too large', 413); }
    const chunks = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { await reader.cancel(); throw new UpstreamError('Book response is too large', 413); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return { text: Buffer.concat(chunks, size).toString('utf8'), contentType: response.headers.get('content-type') || '' };
  } catch (err) {
    if (controller.signal.aborted) throw new UpstreamError('Book service timed out');
    throw err;
  } finally { clearTimeout(timer); }
}
module.exports = { bookUrl, bookRedirectUrl, catalogUrl, boundedInt, readUpstream, UpstreamError };
