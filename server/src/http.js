// Express 4 does not forward rejected async handlers to its error middleware.
const asyncRoute = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
const validBookId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function bookIdParam(value) {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && validBookId(Number(value)) ? Number(value) : null;
}
function metadataBody(body) {
  const { bookId, title, author } = body || {};
  if (!validBookId(bookId) || typeof title !== 'string' || !title.trim() || title.length > 2000 || (author != null && (typeof author !== 'string' || author.length > 1000))) return null;
  return { bookId, title: title.trim(), author: author ? author.trim() : null };
}
module.exports = { asyncRoute, bookIdParam, metadataBody };
