(function () {
  'use strict';

  // ==================== CONFIG ====================
  var RUNTIME = window.__BOOK_READER_CONFIG__ || {};
  var CONFIG = {
    appName: 'Book Reader',
    storageKey: 'mdg_book_reader_v1',
    apiBaseUrl: (RUNTIME.apiBaseUrl || '').replace(/\/$/, ''),
    gutendexBaseUrl: (RUNTIME.gutendexBaseUrl || 'https://gutendex.com').replace(/\/$/, ''),
    textSizes: [
      { key: 'S',  px: 18, label: 'S'  },
      { key: 'M',  px: 22, label: 'M'  },
      { key: 'L',  px: 28, label: 'L'  },
      { key: 'XL', px: 34, label: 'XL' },
    ],
    lineSpacings: [1.3, 1.5, 1.7, 1.9],
    cacheDuration: 5 * 60 * 1000,
    progressSaveDebounce: 600,
  };

  // ==================== STATE ====================
  var state = {
    currentScreen: 'home',
    screenHistory: [],
    cache: {},
    deviceId: null,
    serverAvailable: false,
    data: {
      // Persisted user data
      favorites: {},        // bookId -> { id, title, author, addedAt }
      recents: [],          // [{ id, title, author, lastReadAt }] most-recent first, capped
      progress: {},         // bookId -> { fraction: 0..1, updatedAt }
      settings: {
        textSizeIdx: 2,       // index into CONFIG.textSizes (L) — readable default on additive display
        lineSpacingIdx: 1,    // index into CONFIG.lineSpacings (1.5)
      },
    },
    // Ephemeral reader state
    reader: {
      bookId: null,
      title: '',
      author: '',
      text: '',
      pages: [],            // pre-built array of HTML strings, one per page
      currentPage: 0,
      pendingResumeFraction: null,
      saveTimer: null,
    },
    // Ephemeral screen-specific state
    browseTab: 'popular',
    libraryTab: 'favorites',
    detailBook: null,
    browseExtras: {},      // per-tab pagination: { tab: { gutendexPage, hasMore, loadingMore, loadedIds: Set, generation } }
  };

  var screens = {};

  // ==================== DEVICE ID ====================
  function ensureDeviceId() {
    var key = CONFIG.storageKey + ':device';
    var id = null;
    try { id = localStorage.getItem(key); } catch (e) {}
    if (!id) {
      id = 'dev_' + (crypto.randomUUID
        ? crypto.randomUUID()
        : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          })));
      try { localStorage.setItem(key, id); } catch (e) {}
    }
    state.deviceId = id;
  }

  // ==================== STORAGE ====================
  function loadData() {
    try {
      var raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.favorites) state.data.favorites = parsed.favorites;
        if (parsed.recents)   state.data.recents = parsed.recents;
        if (parsed.progress)  state.data.progress = parsed.progress;
        if (parsed.settings)  Object.assign(state.data.settings, parsed.settings);
      }
    } catch (e) {
      console.error('[Storage] Load error:', e);
    }
  }

  function saveData() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.data));
    } catch (e) {
      console.error('[Storage] Save error:', e);
    }
  }

  // ==================== API ====================
  function apiUrl(path) {
    return CONFIG.apiBaseUrl + path;
  }
  function withDeviceHeader(init) {
    init = init || {};
    init.headers = Object.assign({}, init.headers, { 'X-Device-Id': state.deviceId });
    return init;
  }

  // Hard client-side timeout via AbortController. fetch() with no signal can
  // hang indefinitely if the connection stalls (Render dyno cold start, flaky
  // network) — bound it so the user always gets either a response or an error.
  function fetchWithTimeout(url, init, timeoutMs) {
    init = init || {};
    timeoutMs = timeoutMs || 25000;
    if (typeof AbortController === 'function') {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      init.signal = ctrl.signal;
      return fetch(url, init).then(function (res) {
        clearTimeout(timer);
        return res;
      }, function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') throw new Error('Request timed out');
        throw err;
      });
    }
    return fetch(url, init);
  }

  function apiFetchJson(url, init) {
    return fetchWithTimeout(url, init).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // ---- Gutendex (server-proxied if backend exists, else direct) ----
  function fetchBookList(params) {
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    if (CONFIG.apiBaseUrl) {
      return apiFetchJson(apiUrl('/api/books?' + qs));
    }
    return apiFetchJson(CONFIG.gutendexBaseUrl + '/books?' + qs);
  }

  function fetchBookText(bookId) {
    if (!CONFIG.apiBaseUrl) {
      // No backend: try direct (will usually CORS-fail). Kept for local-only dev.
      return fetch(CONFIG.gutendexBaseUrl + '/books/' + bookId).then(function (r) { return r.json(); })
        .then(function (meta) {
          var fmts = (meta && meta.formats) || {};
          var url = fmts['text/plain; charset=utf-8'] || fmts['text/plain'];
          if (!url) throw new Error('No plain-text edition available');
          return fetch(url).then(function (r) { return r.text(); });
        });
    }
    // Race two retrieval paths in parallel:
    //   primary: /api/books/:id/content — uses backend cache, requires Gutendex up
    //   proxy:   /api/proxy?url=...     — direct gutenberg.org via our backend
    // Hand-rolled "first-success" race instead of Promise.any so we don't
    // depend on Chrome 85+ — the embedded Display glasses browser may be older.
    var primaryPromise = fetch(apiUrl('/api/books/' + bookId + '/content')).then(function (res) {
      if (!res.ok) throw new Error('primary ' + res.status);
      return res.text();
    });
    var fb = window.__BOOK_READER_FALLBACK_CATALOG__;
    var entry = fb && fb.byId[bookId];
    if (!(entry && entry.gutenbergTextUrl)) return primaryPromise;
    var proxyPromise = fetch(apiUrl('/api/proxy?url=' + encodeURIComponent(entry.gutenbergTextUrl)))
      .then(function (res) {
        if (!res.ok) throw new Error('proxy ' + res.status);
        return res.text();
      });
    return firstSuccess([primaryPromise, proxyPromise]);
  }

  // Retry a promise-returning function up to maxAttempts times with linear
  // backoff (0s, 1s, 2s, ...). Surfaces only the final error.
  function retryWithBackoff(fn, maxAttempts) {
    function tryAttempt(n) {
      return fn().catch(function (err) {
        if (n + 1 >= maxAttempts) throw err;
        var statusEl = document.getElementById('reader-load-status');
        if (statusEl) statusEl.textContent = 'Retrying… (attempt ' + (n + 2) + ' of ' + maxAttempts + ')';
        return new Promise(function (r) { setTimeout(r, (n + 1) * 1000); })
          .then(function () { return tryAttempt(n + 1); });
      });
    }
    return tryAttempt(0);
  }

  // Resolves with the first promise that fulfills. Rejects only when all reject.
  function firstSuccess(promises) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var rejected = 0;
      var errors = [];
      promises.forEach(function (p, i) {
        p.then(function (v) {
          if (settled) return;
          settled = true;
          resolve(v);
        }, function (err) {
          errors[i] = err;
          rejected++;
          if (rejected === promises.length && !settled) {
            settled = true;
            reject(new Error(errors.map(function (e) { return e && e.message || String(e); }).join(' / ')));
          }
        });
      });
    });
  }

  // ---- User data (server is source-of-truth when present) ----
  function serverSyncFavoriteAdd(book) {
    if (!CONFIG.apiBaseUrl) return Promise.resolve();
    return fetch(apiUrl('/api/me/favorites'), withDeviceHeader({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, title: book.title, author: book.author }),
    })).catch(function () { /* offline-tolerant */ });
  }
  function serverSyncFavoriteRemove(bookId) {
    if (!CONFIG.apiBaseUrl) return Promise.resolve();
    return fetch(apiUrl('/api/me/favorites/' + bookId), withDeviceHeader({
      method: 'DELETE',
    })).catch(function () {});
  }
  function serverSyncProgress(bookId, fraction) {
    if (!CONFIG.apiBaseUrl) return Promise.resolve();
    return fetch(apiUrl('/api/me/progress/' + bookId), withDeviceHeader({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fraction: fraction }),
    })).catch(function () {});
  }
  function serverSyncRecent(book) {
    if (!CONFIG.apiBaseUrl) return Promise.resolve();
    return fetch(apiUrl('/api/me/recents'), withDeviceHeader({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, title: book.title, author: book.author }),
    })).catch(function () {});
  }
  function pingServer() {
    if (!CONFIG.apiBaseUrl) {
      state.serverAvailable = false;
      return Promise.resolve(false);
    }
    return fetch(apiUrl('/api/health')).then(function (res) {
      state.serverAvailable = res.ok;
      return res.ok;
    }).catch(function () {
      state.serverAvailable = false;
      return false;
    });
  }

  // ==================== NAVIGATION ====================
  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function (s) {
      if (s.id) screens[s.id] = s;
    });
  }

  function navigateTo(screenId, options) {
    options = options || {};
    var addToHistory = options.addToHistory !== false;
    if (addToHistory && state.currentScreen && state.currentScreen !== screenId) {
      state.screenHistory.push(state.currentScreen);
    }
    Object.keys(screens).forEach(function (k) { screens[k].classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      onScreenEnter(screenId);
      // Reader starts in "reading mode" with no toolbar focus so ←/→ go
      // straight to page-turning. User presses ↑ to reveal the back button.
      if (screenId === 'reader') {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      } else {
        focusFirst(screens[screenId]);
      }
    }
  }

  function navigateBack() {
    if (state.currentScreen === 'reader') {
      flushProgress();
    }
    if (state.screenHistory.length > 0) {
      navigateTo(state.screenHistory.pop(), { addToHistory: false });
      return;
    }
    // No history: if we're already on home, re-focus its first element so the
    // user is never stranded with no working buttons. Otherwise return home.
    if (state.currentScreen !== 'home') {
      navigateTo('home', { addToHistory: false });
    } else {
      focusFirst(screens.home);
    }
  }

  // ==================== FOCUS ====================
  // Visible-and-enabled focusables. Filters out elements with hidden ancestors
  // (e.g. Resume button inside a hidden Continue Reading card) since
  // .focusable:not(.hidden) only checks the element itself.
  function visibleFocusables(container) {
    return Array.from(container.querySelectorAll('.focusable:not([disabled])'))
      .filter(function (el) {
        if (el.offsetParent === null) return false;  // hidden ancestor
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
  }

  function focusFirst(container) {
    var els = visibleFocusables(container);
    if (els.length) els[0].focus();
  }

  // Spatial (2D) focus: picks the visible focusable closest to the current one
  // in the requested direction, with a perpendicular-drift penalty so e.g.
  // pressing Down from a tab lands on the list below rather than the next tab.
  function moveFocusSpatial(focusables, current, direction) {
    var cr = current.getBoundingClientRect();
    var cx = (cr.left + cr.right) / 2;
    var cy = (cr.top + cr.bottom) / 2;
    var EPSILON = 4; // px hysteresis so micro-misalignments don't wrong-direct

    var best = null, bestScore = Infinity;
    for (var i = 0; i < focusables.length; i++) {
      var el = focusables[i];
      if (el === current) continue;
      var r = el.getBoundingClientRect();
      var ex = (r.left + r.right) / 2;
      var ey = (r.top + r.bottom) / 2;
      var dx = ex - cx, dy = ey - cy;

      // Must be on the correct side of `current` for this direction.
      if (direction === 'up'    && dy >= -EPSILON) continue;
      if (direction === 'down'  && dy <=  EPSILON) continue;
      if (direction === 'left'  && dx >= -EPSILON) continue;
      if (direction === 'right' && dx <=  EPSILON) continue;

      // Score: primary-axis distance + heavy perpendicular penalty.
      var primary, perp;
      if (direction === 'up' || direction === 'down') {
        primary = Math.abs(dy);  perp = Math.abs(dx);
      } else {
        primary = Math.abs(dx);  perp = Math.abs(dy);
      }
      var score = primary + perp * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;

    // ----- Reader navigation -----
    // Reading mode (no toolbar focus): ←/→ turn pages, ↑ enters toolbar, ↓ opens menu.
    // Toolbar mode (back or menu button focused): ←/→ moves between toolbar
    //   buttons, ↓ exits back to reading mode, ↑ stays put.
    if (state.currentScreen === 'reader' && isReaderMenuClosed()) {
      var rActive = document.activeElement;
      var toolbar = document.querySelector('#reader .reader-toolbar');
      var inToolbar = rActive && rActive.closest && rActive.closest('.reader-toolbar');
      if (inToolbar) {
        if (direction === 'down') { rActive.blur(); return; }
        if (direction === 'up')   { return; }
        var btns = visibleFocusables(toolbar);
        var ti = btns.indexOf(rActive);
        if (direction === 'left')  { if (ti > 0) btns[ti - 1].focus(); return; }
        if (direction === 'right') { if (ti < btns.length - 1) btns[ti + 1].focus(); return; }
      }
      // Reading mode
      if (direction === 'left')  { pageBack();    return; }
      if (direction === 'right') { pageForward(); return; }
      if (direction === 'up') {
        var first = toolbar && toolbar.querySelector('.focusable');
        if (first) first.focus();
        return;
      }
      if (direction === 'down') { openReaderMenu(); return; }
    }

    // When reader menu is open, scope focus to inside the menu.
    if (state.currentScreen === 'reader' && !isReaderMenuClosed()) {
      var menu = document.getElementById('reader-menu');
      var menuFocusables = visibleFocusables(menu);
      if (!menuFocusables.length) return;
      var menuCurrent = document.activeElement;
      if (!menuFocusables.includes(menuCurrent)) { menuFocusables[0].focus(); return; }
      var menuNext = moveFocusSpatial(menuFocusables, menuCurrent, direction);
      if (menuNext) menuNext.focus();
      return;
    }

    var focusables = visibleFocusables(container);
    if (focusables.length === 0) return;

    var current = document.activeElement;
    if (!focusables.includes(current)) {
      focusables[0].focus();
      return;
    }

    var next = moveFocusSpatial(focusables, current, direction);
    if (!next) {
      // No element in that direction. For up/down, wrap to first/last in primary axis.
      // For left/right, just stay put (no surprising wrap mid-row).
      if (direction === 'down') next = focusables[0];
      else if (direction === 'up') next = focusables[focusables.length - 1];
    }
    // When *entering* a tab row from outside (up from list, down from header),
    // snap to the active tab so the user lands on "the tab they're on". But
    // not when moving sideways within the tab row — there they need free
    // movement between tabs.
    if (next && next.classList.contains('tab-item') && !next.classList.contains('active')) {
      var tabBar = next.closest('.tab-bar');
      var currentInSameTabBar =
        current && current.classList && current.classList.contains('tab-item') &&
        current.closest('.tab-bar') === tabBar;
      if (!currentInSameTabBar) {
        var active = tabBar && tabBar.querySelector('.tab-item.active');
        if (active && focusables.includes(active)) next = active;
      }
    }
    if (next) {
      next.focus();
      next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ==================== UI HELPERS ====================
  function showToast(message, type) {
    var toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast' + (type ? ' ' + type : '');
    void toast.offsetHeight;
    toast.classList.add('visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toast.classList.remove('visible'); }, 2200);
  }

  function bookListItem(b) {
    var btn = document.createElement('button');
    btn.className = 'book-item focusable';
    btn.dataset.action = 'open-detail';
    btn.dataset.bookId = String(b.id);
    btn.dataset.bookTitle = b.title || '';
    btn.dataset.bookAuthor = b.author || '';
    btn.innerHTML =
      '<div class="book-item-title">' + escapeHtml(b.title || 'Untitled') + '</div>' +
      '<div class="book-item-author">' + escapeHtml(b.author || 'Unknown') + '</div>' +
      (b.metaLine
        ? '<div class="book-item-meta">' + escapeHtml(b.metaLine) + '</div>'
        : '');
    return btn;
  }

  function renderBookList(containerId, books, opts) {
    opts = opts || {};
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!books || books.length === 0) {
      var msg = opts.emptyMessage || 'No books found';
      container.innerHTML = '<div class="empty-row">' + escapeHtml(msg) + '</div>';
      return;
    }
    books.forEach(function (b) { container.appendChild(bookListItem(b)); });
  }

  function appendBooksToList(containerId, books) {
    var container = document.getElementById(containerId);
    if (!container || !books || !books.length) return;
    // Strip empty-state row if present
    var empty = container.querySelector('.empty-row');
    if (empty) empty.remove();
    books.forEach(function (b) { container.appendChild(bookListItem(b)); });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normalizeGutendexBook(raw) {
    var author = (raw.authors && raw.authors[0] && raw.authors[0].name) || 'Unknown';
    return {
      id: raw.id,
      title: raw.title || 'Untitled',
      author: author,
      subjects: raw.subjects || [],
      description: raw.summaries && raw.summaries[0] || '',
      downloadCount: raw.download_count,
    };
  }

  // ==================== SCREEN ENTRY ====================
  function onScreenEnter(screenId) {
    switch (screenId) {
      case 'home':       renderHome(); break;
      case 'browse':     loadBrowse(state.browseTab); break;
      case 'search':     renderSearchScreen(); break;
      case 'book-detail':renderBookDetail(); break;
      case 'library':    renderLibrary(); break;
      case 'settings':   renderSettings(); break;
      case 'reader':     /* handled when book opens */ break;
    }
  }

  // ---- Home ----
  function renderHome() {
    var card = document.getElementById('continue-reading-card');
    var recent = state.data.recents[0];
    if (recent) {
      document.getElementById('continue-title').textContent = recent.title;
      document.getElementById('continue-author').textContent = recent.author || '';
      var pct = Math.round(((state.data.progress[recent.id] || {}).fraction || 0) * 100);
      document.getElementById('continue-progress').style.width = pct + '%';
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
    var status = state.serverAvailable ? 'Online' : 'Offline';
    document.getElementById('home-status').textContent = status;
  }

  // ---- Browse ----
  // Tabs split into two strategies:
  //   - "popular" hits the live Gutendex catalog (fast, ~1s) so users see the
  //     freshest most-downloaded books from the full 78K set.
  //   - Topic tabs (fiction / adventure / mystery) render from the bundled
  //     catalog directly. Gutendex topic-filtered queries take 15-22s which is
  //     unusable on glasses; the curated bundled list is instant and reliable.
  function loadBrowse(tab) {
    state.browseTab = tab;
    document.querySelectorAll('#browse-tabs .tab-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    var list = document.getElementById('browse-list');
    var fallback = window.__BOOK_READER_FALLBACK_CATALOG__;

    // Reset pagination state for this tab. generation lets us ignore stale
    // Load-More responses if the user switches tabs mid-fetch.
    var gen = ((state.browseExtras[tab] && state.browseExtras[tab].generation) || 0) + 1;
    state.browseExtras[tab] = {
      gutendexPage: 0, hasMore: true, loadingMore: false,
      loadedIds: Object.create(null), generation: gen,
    };

    if (tab !== 'popular') {
      // Topic tabs render bundled list instantly. Load More augments with Gutendex.
      var entries = fallback ? fallback.forTab(tab) : [];
      var bundledBooks = entries.map(function (b) {
        return {
          id: b.id, title: b.title, author: b.author, subjects: b.subjects,
          metaLine: b.subjects.slice(0, 2).join(' • '),
        };
      });
      bundledBooks.forEach(function (b) { state.browseExtras[tab].loadedIds[b.id] = true; });
      renderBookList('browse-list', bundledBooks, { emptyMessage: 'No books in this category yet' });
      updateLoadMoreButton();
      return;
    }

    // Popular tab → live Gutendex page 1.
    list.innerHTML = '<div class="loading-row">Loading…</div>';
    var cacheKey = 'browse:popular';
    var cached = state.cache[cacheKey];
    if (cached && Date.now() - cached.timestamp < CONFIG.cacheDuration) {
      renderPopularInitial(cached.data);
      return;
    }
    // Update loading text if it takes more than a couple seconds — server may
    // be cold-starting (Render free tier sleeps after 15 min idle).
    var slowMsgTimer = setTimeout(function () {
      var lr = list.querySelector('.loading-row');
      if (lr) lr.textContent = 'Loading… (server may be waking up)';
    }, 4000);

    // Fetch once, retry once silently on failure — covers the dyno cold-start
    // case where the first request times out but the second hits a warm server.
    function fetchOnce() { return fetchBookList({ sort: 'popular', page: 1 }); }
    fetchOnce().catch(function (err) {
      console.warn('[browse] popular first attempt failed, retrying:', err.message);
      var lr = list.querySelector('.loading-row');
      if (lr) lr.textContent = 'Retrying…';
      return fetchOnce();
    }).then(function (data) {
      clearTimeout(slowMsgTimer);
      state.cache[cacheKey] = { data: data, timestamp: Date.now() };
      renderPopularInitial(data);
    }).catch(function (err) {
      clearTimeout(slowMsgTimer);
      console.warn('[browse] catalog API failed after retry, using fallback catalog:', err.message);
      if (fallback) {
        var fb = fallback.forTab('popular').map(function (b) {
          return { id: b.id, title: b.title, author: b.author, metaLine: 'Offline catalog' };
        });
        fb.forEach(function (b) { state.browseExtras.popular.loadedIds[b.id] = true; });
        state.browseExtras.popular.hasMore = false;
        renderBookList('browse-list', fb, { emptyMessage: 'No books found' });
        updateLoadMoreButton();
      } else {
        list.innerHTML =
          '<div class="error-row">Couldn’t load: ' + escapeHtml(err.message || 'network error') + '</div>' +
          '<button class="nav-item primary focusable" data-action="browse-tab" data-tab="popular">Retry</button>';
      }
    });
  }
  function renderPopularInitial(data) {
    var books = (data.results || []).map(normalizeGutendexBook).map(function (b) {
      b.metaLine = b.downloadCount ? (b.downloadCount.toLocaleString() + ' downloads') : '';
      return b;
    });
    var ex = state.browseExtras.popular;
    books.forEach(function (b) { ex.loadedIds[b.id] = true; });
    ex.gutendexPage = 1;
    ex.hasMore = !!data.next;
    renderBookList('browse-list', books, { emptyMessage: 'No books in this category' });
    updateLoadMoreButton();
  }

  function updateLoadMoreButton(errorMsg) {
    var el = document.getElementById('browse-load-more');
    if (!el) return;
    var tab = state.browseTab;
    var ex = state.browseExtras[tab];
    if (!ex) { el.innerHTML = ''; return; }
    if (ex.loadingMore) {
      el.innerHTML = '<div class="loading-row">Loading more…</div>';
      return;
    }
    if (errorMsg) {
      el.innerHTML =
        '<div class="error-row">' + escapeHtml(errorMsg) + '</div>' +
        '<button class="nav-item focusable" data-action="load-more-books">Try again</button>';
      return;
    }
    if (!ex.hasMore) { el.innerHTML = ''; return; }
    var label = tab === 'popular' ? 'Load more' : 'Load more from Gutenberg';
    el.innerHTML = '<button class="nav-item focusable" data-action="load-more-books">' + label + '</button>';
  }

  function loadMoreBooks() {
    var tab = state.browseTab;
    var ex = state.browseExtras[tab];
    if (!ex || ex.loadingMore || !ex.hasMore) return;
    ex.loadingMore = true;
    var gen = ex.generation;
    updateLoadMoreButton();

    var query;
    if (tab === 'popular') {
      query = { sort: 'popular', page: ex.gutendexPage + 1 };
    } else {
      // For topic tabs, use search= since Gutendex topic= is even slower.
      query = { search: tab, sort: 'popular', page: ex.gutendexPage + 1 };
    }

    fetchBookList(query).then(function (data) {
      // Drop if user has changed tabs in the meantime.
      if (gen !== state.browseExtras[tab].generation || state.browseTab !== tab) return;
      var fresh = (data.results || [])
        .map(normalizeGutendexBook)
        .filter(function (b) { return !ex.loadedIds[b.id]; })
        .map(function (b) {
          b.metaLine = b.downloadCount ? (b.downloadCount.toLocaleString() + ' downloads') : '';
          return b;
        });
      fresh.forEach(function (b) { ex.loadedIds[b.id] = true; });
      appendBooksToList('browse-list', fresh);
      ex.gutendexPage += 1;
      ex.hasMore = !!data.next;
      ex.loadingMore = false;
      updateLoadMoreButton();
    }).catch(function (err) {
      if (gen !== state.browseExtras[tab].generation || state.browseTab !== tab) return;
      ex.loadingMore = false;
      updateLoadMoreButton(err.message || 'Network error');
    });
  }

  // ---- Search ----
  function renderSearchScreen() {
    // No-op; results render after submit
  }
  function runSearch() {
    var input = document.getElementById('search-input');
    var q = (input.value || '').trim();
    var results = document.getElementById('search-results');
    if (!q) {
      results.innerHTML = '<div class="empty-row">Enter a title or author</div>';
      return;
    }
    results.innerHTML = '<div class="loading-row">Searching…</div>';
    fetchBookList({ search: q }).then(function (data) {
      var books = (data.results || []).map(normalizeGutendexBook);
      renderBookList('search-results', books, { emptyMessage: 'No results' });
    }).catch(function (err) {
      var fallback = window.__BOOK_READER_FALLBACK_CATALOG__;
      if (fallback) {
        var hits = fallback.search(q).map(function (b) {
          return { id: b.id, title: b.title, author: b.author, metaLine: 'Offline catalog', _fromFallback: true };
        });
        renderBookList('search-results', hits, { emptyMessage: 'No matches in offline catalog' });
      } else {
        results.innerHTML = '<div class="error-row">Search failed. ' + escapeHtml(err.message || '') + '</div>';
      }
    });
  }

  // ---- Book Detail ----
  function renderBookDetail() {
    var b = state.detailBook;
    if (!b) return;
    document.getElementById('detail-title').textContent = b.title || 'Book';
    document.getElementById('detail-author').textContent = b.author || '';
    document.getElementById('detail-subjects').textContent =
      (b.subjects || []).slice(0, 3).join(' • ');
    document.getElementById('detail-description').textContent = b.description || '';
    var btn = document.getElementById('detail-favorite-btn');
    btn.textContent = state.data.favorites[b.id] ? '★ Favorited' : '☆ Favorite';
  }

  function openBookDetailFromElement(el) {
    var book = {
      id: Number(el.dataset.bookId),
      title: el.dataset.bookTitle,
      author: el.dataset.bookAuthor,
      subjects: [],
      description: '',
    };
    state.detailBook = book;
    // Fetch full metadata for description/subjects
    var url = CONFIG.apiBaseUrl
      ? apiUrl('/api/books/' + book.id)
      : CONFIG.gutendexBaseUrl + '/books/' + book.id;
    apiFetchJson(url).then(function (raw) {
      var full = normalizeGutendexBook(raw);
      state.detailBook = full;
      if (state.currentScreen === 'book-detail') renderBookDetail();
    }).catch(function () {
      // Catalog metadata unavailable — enrich from the fallback catalog if we know this book.
      var fb = window.__BOOK_READER_FALLBACK_CATALOG__;
      var entry = fb && fb.byId[book.id];
      if (entry) {
        state.detailBook = {
          id: book.id, title: entry.title, author: entry.author,
          subjects: entry.subjects, description: '',
          gutenbergTextUrl: entry.gutenbergTextUrl,
        };
        if (state.currentScreen === 'book-detail') renderBookDetail();
      }
    });
    navigateTo('book-detail');
  }

  function toggleFavorite() {
    var b = state.detailBook;
    if (!b) return;
    if (state.data.favorites[b.id]) {
      delete state.data.favorites[b.id];
      serverSyncFavoriteRemove(b.id);
      showToast('Removed from favorites');
    } else {
      state.data.favorites[b.id] = {
        id: b.id, title: b.title, author: b.author, addedAt: Date.now(),
      };
      serverSyncFavoriteAdd(b);
      showToast('Added to favorites', 'success');
    }
    saveData();
    renderBookDetail();
  }

  // ---- Library ----
  function renderLibrary() {
    document.querySelectorAll('#library .tab-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tab === state.libraryTab);
    });
    var list = document.getElementById('library-list');
    if (state.libraryTab === 'favorites') {
      var favs = Object.values(state.data.favorites).sort(function (a, b) {
        return b.addedAt - a.addedAt;
      });
      renderBookList('library-list', favs, { emptyMessage: 'No favorites yet' });
    } else {
      renderBookList('library-list', state.data.recents, { emptyMessage: 'No recent books' });
    }
  }

  // ==================== READER ====================
  function openBook() {
    var b = state.detailBook;
    if (!b) return;

    state.reader.bookId = b.id;
    state.reader.title = b.title;
    state.reader.author = b.author;
    state.reader.text = '';
    state.reader.pages = [];
    state.reader.currentPage = 0;
    state.reader.pendingResumeFraction =
      (state.data.progress[b.id] && state.data.progress[b.id].fraction) || 0;

    document.getElementById('reader-toolbar-title').textContent = b.title;
    var inner = document.getElementById('reader-page-inner');
    inner.innerHTML = '<div class="loading-row" id="reader-load-status">Loading book…</div>';
    document.getElementById('reader-page-num').textContent = '—';

    navigateTo('reader');
    applyTextSize();

    // Surface elapsed time during long loads so the user isn't staring at a
    // dead-looking "Loading…" string while we fight Gutendex.
    var loadStart = Date.now();
    var loadTimer = setInterval(function () {
      var statusEl = document.getElementById('reader-load-status');
      if (!statusEl) return clearInterval(loadTimer);
      var secs = Math.floor((Date.now() - loadStart) / 1000);
      if (secs >= 3) statusEl.textContent = 'Loading book… ' + secs + 's';
    }, 1000);

    // Gutenberg downloads can flake intermittently (Render IPs sometimes hit
    // gutenberg.org throttling). Retry up to 3 times with backoff before
    // surfacing an error — totally invisible to the user when transient.
    Promise.resolve().then(function () {
      return retryWithBackoff(function () { return fetchBookText(b.id); }, 3);
    }).then(function (text) {
      clearInterval(loadTimer);
      var cleaned = stripGutenbergBoilerplate(text);
      state.reader.text = cleaned;
      rebuildPages();
      var resume = state.reader.pendingResumeFraction || 0;
      seekToFraction(resume);
      addToRecents();
    }).catch(function (err) {
      clearInterval(loadTimer);
      // Log technical detail to console but show a friendly message in the UI.
      console.warn('[openBook] failed after retries:', err && err.message);
      document.getElementById('reader-page-inner').innerHTML =
        '<div class="error-row">Couldn’t load this book.<br>' +
        'Gutenberg.org may be temporarily unavailable. Try again in a minute.' +
        '</div>' +
        '<button class="nav-item primary focusable" data-action="retry-open-book" style="margin-top:16px">Try again</button>';
      focusFirst(screens.reader);
    });
  }

  function stripGutenbergBoilerplate(text) {
    // Gutenberg files have START/END markers — keep only the body in between.
    var startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^*]*\*\*\*/i;
    var endRe   = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[^*]*\*\*\*/i;
    var startM = text.match(startRe);
    var endM = text.match(endRe);
    var body = text;
    if (startM) body = body.slice(startM.index + startM[0].length);
    if (endM)   body = body.slice(0, body.indexOf(endM[0]));
    return body.replace(/\r\n/g, '\n').replace(/^\s+/, '').replace(/\s+$/, '');
  }

  // ---- Pagination engine ----
  // Pre-computes page boundaries by measuring paragraph heights in a hidden
  // sibling that matches the reader's font & width. Rendering only the current
  // page keeps the DOM tiny and scrolling smooth on the glasses.
  function rebuildPages() {
    var text = state.reader.text;
    if (!text) return;
    var inner = document.getElementById('reader-page-inner');
    var page = document.getElementById('reader-page');
    var cs = window.getComputedStyle(inner);
    var lineHeight = parseFloat(cs.lineHeight);
    if (!lineHeight || isNaN(lineHeight)) lineHeight = parseFloat(cs.fontSize) * 1.5;
    var linesPerPage = Math.max(1, Math.floor(page.clientHeight / lineHeight));
    var pageHeightPx = linesPerPage * lineHeight;

    // Measurer matches the inner's width and typography exactly
    var meas = document.createElement('div');
    meas.style.cssText = 'position:absolute;top:-99999px;left:0;visibility:hidden;';
    meas.style.fontFamily = cs.fontFamily;
    meas.style.fontSize = cs.fontSize;
    meas.style.lineHeight = cs.lineHeight;
    meas.style.width = inner.clientWidth + 'px';
    meas.style.whiteSpace = 'normal';
    meas.style.wordWrap = 'break-word';
    document.body.appendChild(meas);

    var paragraphs = text.split(/\n{2,}/)
      .map(function (p) { return p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);

    function paragraphHeightPx(s) {
      meas.textContent = s;
      return meas.scrollHeight;
    }

    function splitLongParagraph(s, maxHeightPx) {
      // Splits a paragraph that's taller than a page into smaller chunks at
      // word boundaries, each one fitting on its own page.
      var words = s.split(/\s+/);
      var chunks = [];
      var lo = 0;
      while (lo < words.length) {
        var hi = words.length;
        // Binary search for the largest prefix that fits
        var best = lo + 1;
        var l = lo + 1, r = words.length;
        while (l <= r) {
          var m = (l + r) >> 1;
          meas.textContent = words.slice(lo, m).join(' ');
          if (meas.scrollHeight <= maxHeightPx) { best = m; l = m + 1; }
          else { r = m - 1; }
        }
        chunks.push(words.slice(lo, best).join(' '));
        lo = best;
      }
      return chunks;
    }

    var pages = [];
    var current = [];          // array of paragraph strings on current page
    var heightUsed = 0;
    var marginPx = lineHeight; // p { margin-bottom: 1lh }

    function flush() {
      if (current.length) {
        var html = current.map(function (p) {
          return '<p>' + escapeHtml(p) + '</p>';
        }).join('');
        pages.push(html);
      }
      current = [];
      heightUsed = 0;
    }

    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i];
      var ph = paragraphHeightPx(p);
      if (ph > pageHeightPx) {
        flush();
        var chunks = splitLongParagraph(p, pageHeightPx);
        for (var j = 0; j < chunks.length; j++) {
          pages.push('<p>' + escapeHtml(chunks[j]) + '</p>');
        }
        continue;
      }
      var cost = (current.length === 0 ? 0 : marginPx) + ph;
      if (heightUsed + cost <= pageHeightPx) {
        current.push(p);
        heightUsed += cost;
      } else {
        flush();
        current.push(p);
        heightUsed = ph;
      }
    }
    flush();

    document.body.removeChild(meas);
    state.reader.pages = pages.length ? pages : [''];
    renderCurrentPage();
  }

  function renderCurrentPage() {
    var inner = document.getElementById('reader-page-inner');
    var html = state.reader.pages[state.reader.currentPage] || '';
    inner.innerHTML = html;
    updatePageDisplay();
  }

  function applyTextSize() {
    var size = CONFIG.textSizes[state.data.settings.textSizeIdx] || CONFIG.textSizes[1];
    var spacing = CONFIG.lineSpacings[state.data.settings.lineSpacingIdx] || 1.5;
    document.documentElement.style.setProperty('--reader-font-size', size.px + 'px');
    document.documentElement.style.setProperty('--reader-line-height', String(spacing));
    document.getElementById('text-size-display').textContent = size.label;
    var settingsDisplay = document.getElementById('settings-size-display');
    if (settingsDisplay) settingsDisplay.textContent = size.label;
    var spacingDisplay = document.getElementById('settings-spacing-display');
    if (spacingDisplay) spacingDisplay.textContent = String(spacing);
  }

  function totalPages() {
    return Math.max(1, state.reader.pages.length);
  }

  function isReaderMenuClosed() {
    var menu = document.getElementById('reader-menu');
    return !menu || menu.classList.contains('hidden');
  }
  function openReaderMenu() {
    var menu = document.getElementById('reader-menu');
    menu.classList.remove('hidden');
    var first = menu.querySelector('.focusable');
    if (first) first.focus();
  }
  function closeReaderMenu() {
    var menu = document.getElementById('reader-menu');
    menu.classList.add('hidden');
  }

  function pageForward() {
    if (state.reader.currentPage < totalPages() - 1) {
      state.reader.currentPage++;
      renderCurrentPage();
      scheduleProgressSave();
    }
  }
  function pageBack() {
    if (state.reader.currentPage > 0) {
      state.reader.currentPage--;
      renderCurrentPage();
      scheduleProgressSave();
    }
  }
  function updatePageDisplay() {
    document.getElementById('reader-page-num').textContent =
      (state.reader.currentPage + 1) + ' / ' + totalPages();
  }
  function currentFraction() {
    var n = totalPages();
    if (n <= 1) return 0;
    return state.reader.currentPage / (n - 1);
  }
  function seekToFraction(f) {
    var n = totalPages();
    var p = Math.round(f * (n - 1));
    state.reader.currentPage = Math.max(0, Math.min(n - 1, p));
    renderCurrentPage();
  }
  function scheduleProgressSave() {
    clearTimeout(state.reader.saveTimer);
    state.reader.saveTimer = setTimeout(flushProgress, CONFIG.progressSaveDebounce);
  }
  function flushProgress() {
    clearTimeout(state.reader.saveTimer);
    if (!state.reader.bookId) return;
    var f = currentFraction();
    state.data.progress[state.reader.bookId] = { fraction: f, updatedAt: Date.now() };
    saveData();
    serverSyncProgress(state.reader.bookId, f);
  }

  function addToRecents() {
    var b = {
      id: state.reader.bookId,
      title: state.reader.title,
      author: state.reader.author,
      lastReadAt: Date.now(),
    };
    state.data.recents = [b].concat(
      state.data.recents.filter(function (x) { return x.id !== b.id; })
    ).slice(0, 20);
    saveData();
    serverSyncRecent(b);
  }

  function resumeReading() {
    var recent = state.data.recents[0];
    if (!recent) { showToast('Nothing to resume'); return; }
    state.detailBook = {
      id: recent.id, title: recent.title, author: recent.author,
      subjects: [], description: '',
    };
    openBook();
  }

  function bumpTextSize(delta) {
    var n = CONFIG.textSizes.length;
    var i = state.data.settings.textSizeIdx + delta;
    if (i < 0 || i >= n) return;
    state.data.settings.textSizeIdx = i;
    saveData();
    applyTextSize();
    if (state.currentScreen === 'reader' && state.reader.text) {
      var f = currentFraction();
      rebuildPages();
      seekToFraction(f);
    }
  }
  function bumpLineSpacing(delta) {
    var n = CONFIG.lineSpacings.length;
    var i = state.data.settings.lineSpacingIdx + delta;
    if (i < 0 || i >= n) return;
    state.data.settings.lineSpacingIdx = i;
    saveData();
    applyTextSize();
    if (state.currentScreen === 'reader' && state.reader.text) {
      var f = currentFraction();
      rebuildPages();
      seekToFraction(f);
    }
  }

  // ---- Settings screen ----
  function renderSettings() {
    applyTextSize();
    document.getElementById('settings-device-id').textContent = state.deviceId || '—';
    document.getElementById('settings-server-status').textContent =
      CONFIG.apiBaseUrl
        ? (state.serverAvailable ? 'Connected (' + CONFIG.apiBaseUrl + ')' : 'Unreachable')
        : 'Local-only mode';
  }

  // ==================== ACTIONS ====================
  function handleAction(action, el) {
    switch (action) {
      case 'back':              navigateBack(); break;
      case 'go-browse':         navigateTo('browse'); break;
      case 'go-search':         navigateTo('search'); break;
      case 'go-library':        navigateTo('library'); break;
      case 'go-settings':       navigateTo('settings'); break;
      case 'resume-reading':    resumeReading(); break;
      case 'browse-tab':        loadBrowse(el.dataset.tab); break;
      case 'load-more-books':   loadMoreBooks(); break;
      case 'library-tab':       state.libraryTab = el.dataset.tab; renderLibrary(); break;
      case 'open-detail':       openBookDetailFromElement(el); break;
      case 'run-search':        runSearch(); break;
      case 'open-book':         openBook(); break;
      case 'retry-open-book':   openBook(); break;
      case 'toggle-favorite':   toggleFavorite(); break;
      case 'open-reader-menu':  openReaderMenu(); break;
      case 'close-reader-menu': closeReaderMenu(); break;
      case 'text-size-up':      bumpTextSize(+1); break;
      case 'text-size-down':    bumpTextSize(-1); break;
      case 'line-spacing-up':   bumpLineSpacing(+1); break;
      case 'line-spacing-down': bumpLineSpacing(-1); break;
      default: console.log('[Action] unhandled:', action);
    }
  }

  // ==================== KEYBOARD ====================
  function setupEvents() {
    document.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function (e) {
      var active = document.activeElement;
      var isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (isInput && !['Escape', 'Enter'].includes(e.key)) return;

      switch (e.key) {
        case 'ArrowUp':    moveFocus('up');    e.preventDefault(); break;
        case 'ArrowDown':  moveFocus('down');  e.preventDefault(); break;
        case 'ArrowLeft':  moveFocus('left');  e.preventDefault(); break;
        case 'ArrowRight': moveFocus('right'); e.preventDefault(); break;
        case 'Enter':
          if (isInput) {
            var submit = active.dataset.submitAction;
            if (submit) handleAction(submit, active);
          } else if (active && active.classList.contains('focusable')) {
            active.click();
          }
          e.preventDefault();
          break;
        case 'Escape':
          if (state.currentScreen === 'reader' && !isReaderMenuClosed()) {
            closeReaderMenu();
          } else {
            navigateBack();
          }
          e.preventDefault();
          break;
      }
    });

    // Re-paginate on resize (desktop testing)
    window.addEventListener('resize', function () {
      if (state.currentScreen === 'reader' && state.reader.text) {
        var f = currentFraction();
        rebuildPages();
        seekToFraction(f);
      }
    });
  }

  // ==================== INIT ====================
  function init() {
    ensureDeviceId();
    collectScreens();
    setupEvents();
    loadData();
    applyTextSize();
    pingServer().then(function () {
      if (state.currentScreen === 'home') renderHome();
      if (state.currentScreen === 'settings') renderSettings();
      // Warm up: prefetch popular books so Browse is instant when the user opens it.
      // Errors are silent — Browse will retry on demand.
      fetchBookList({ sort: 'popular', page: 1 }).then(function (data) {
        state.cache['browse:popular'] = { data: data, timestamp: Date.now() };
      }).catch(function () {});
    });
    setTimeout(function () {
      navigateTo('home', { addToHistory: false });
    }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
