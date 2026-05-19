// Runtime config. The dev/prod split is auto-detected from the hostname so
// the same bundle works locally and on Render with no build step.
//
// To use a custom backend URL in production, edit PROD_API_URL below to match
// whatever Render assigns to your web service (e.g. https://book-reader-api.onrender.com).
window.__BOOK_READER_CONFIG__ = (function () {
  var PROD_API_URL = 'https://book-reader-api.onrender.com';
  var host = window.location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  return {
    apiBaseUrl: isLocal ? 'http://localhost:3000' : PROD_API_URL,
    gutendexBaseUrl: 'https://gutendex.com',
  };
})();
