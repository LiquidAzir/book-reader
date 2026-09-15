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
    syncAvailable: false,
    data: {
      // Persisted user data
      favorites: {},        // bookId -> { id, title, author, addedAt }
      recents: [],          // [{ id, title, author, lastReadAt }] most-recent first, capped
      progress: {},         // bookId -> { fraction: 0..1, updatedAt }
      syncQueue: {},
      favoriteRemoved: {},
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
  var readGeneration = 0, readController = null, searchGeneration = 0, detailGeneration = 0;
  var syncing = {}, retryTimer = null;

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
        if (parsed.favorites && typeof parsed.favorites === 'object' && !Array.isArray(parsed.favorites)) state.data.favorites = parsed.favorites;
        if (Array.isArray(parsed.recents)) state.data.recents = parsed.recents.filter(function(b) { return b && Number.isInteger(b.id) && b.id > 0 && typeof b.title === 'string'; }).slice(0,20);
        if (parsed.progress && typeof parsed.progress === 'object' && !Array.isArray(parsed.progress)) state.data.progress = parsed.progress;
        if (parsed.settings)  Object.assign(state.data.settings, parsed.settings);
        state.data.syncQueue = parsed.syncQueue || {};
        state.data.favoriteRemoved = parsed.favoriteRemoved || {};
      }
    } catch (e) { /* Keep usable defaults when browser data is malformed. */ }
    ['textSizeIdx','lineSpacingIdx'].forEach(function(k) {
      var max = k === 'textSizeIdx' ? CONFIG.textSizes.length : CONFIG.lineSpacings.length;
      if (!Number.isInteger(state.data.settings[k]) || state.data.settings[k] < 0 || state.data.settings[k] >= max) state.data.settings[k] = k === 'textSizeIdx' ? 2 : 1;
    });
    state.data.syncQueue = state.data.syncQueue && typeof state.data.syncQueue === 'object' ? state.data.syncQueue : {};
    state.data.favoriteRemoved = state.data.favoriteRemoved && typeof state.data.favoriteRemoved === 'object' ? state.data.favoriteRemoved : {};
    Object.keys(state.data.favorites).forEach(function(key){var b=state.data.favorites[key];if(!b||!Number.isInteger(b.id)||b.id<=0||typeof b.title!=='string')delete state.data.favorites[key];});
    Object.keys(state.data.progress).forEach(function(key){var p=state.data.progress[key];if(!p||!Number.isFinite(Number(p.fraction))||Number(p.fraction)<0||Number(p.fraction)>1)delete state.data.progress[key];});
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
      var outer = init.signal;
      if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener('abort', function() { ctrl.abort(); }, {once:true}); }
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      init.signal = ctrl.signal;
      return fetch(url, init).then(function (res) {
        clearTimeout(timer);
        return res;
      }, function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError' && !(outer && outer.aborted)) throw new Error('Request timed out');
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

  function fetchBookText(bookId, signal) {
    if (!CONFIG.apiBaseUrl) {
      // No backend: try direct (will usually CORS-fail). Kept for local-only dev.
      return fetchWithTimeout(CONFIG.gutendexBaseUrl + '/books/' + bookId, {signal:signal}).then(function (r) { return r.json(); })
        .then(function (meta) {
          var fmts = (meta && meta.formats) || {};
          var url = fmts['text/plain; charset=utf-8'] || fmts['text/plain'];
          if (!url) throw new Error('No plain-text edition available');
          return fetchWithTimeout(url, {signal:signal}).then(function (r) { if (!r.ok) throw new Error('Book unavailable'); return r.text(); });
        });
    }
    // Race two retrieval paths in parallel:
    //   primary: /api/books/:id/content — uses backend cache, requires Gutendex up
    //   proxy:   /api/proxy?url=...     — direct gutenberg.org via our backend
    // Hand-rolled "first-success" race instead of Promise.any so we don't
    // depend on Chrome 85+ — the embedded Display glasses browser may be older.
    var primaryPromise = fetchWithTimeout(apiUrl('/api/books/' + bookId + '/content'), {signal:signal}).then(function (res) {
      if (!res.ok) throw new Error('primary ' + res.status);
      return res.text();
    });
    var fb = window.__BOOK_READER_FALLBACK_CATALOG__;
    var entry = fb && fb.byId[bookId];
    if (!(entry && entry.gutenbergTextUrl)) return primaryPromise;
    var proxyPromise = fetchWithTimeout(apiUrl('/api/proxy?url=' + encodeURIComponent(entry.gutenbergTextUrl)), {signal:signal})
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
  // Local changes are durable first. Each key has at most one request in flight,
  // so a slow response cannot overwrite a newer page or favorite choice.
  function queueSync(kind, id, payload) {
    if (!CONFIG.apiBaseUrl) return;
    if(kind!=='progress' && payload)payload={title:String(payload.title||'Untitled').slice(0,2000),author:String(payload.author||'').slice(0,1000)};
    var key = kind + ':' + id;
    state.data.syncQueue[key] = {kind:kind, id:id, payload:payload, stamp:Date.now()};
    saveData(); drainSync(key);
  }
  function drainSync(key) {
    if (syncing[key] || !CONFIG.apiBaseUrl) return;
    var item = state.data.syncQueue[key];
    if (!item || !Number.isInteger(item.id) || item.id <= 0 || !['favorite','progress','recent'].includes(item.kind)) return;
    var url, method, body;
    if (item.kind === 'progress') { url='/api/me/progress/'+item.id; method='PUT'; body={fraction:item.payload.fraction}; }
    if (item.kind === 'recent') { url='/api/me/recents'; method='POST'; body={bookId:item.id,title:item.payload.title,author:item.payload.author}; }
    if (item.kind === 'favorite') { url='/api/me/favorites'+(item.payload ? '' : '/'+item.id); method=item.payload?'POST':'DELETE'; body=item.payload&&{bookId:item.id,title:item.payload.title,author:item.payload.author}; }
    syncing[key] = true;
    fetchWithTimeout(apiUrl(url), withDeviceHeader({method:method,keepalive:true,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),15000)
      .then(function(res) { if (!res.ok) throw new Error('Sync unavailable'); state.syncAvailable=true; if (state.data.syncQueue[key] === item) delete state.data.syncQueue[key]; saveData(); })
      .catch(function() { state.syncAvailable=false; clearTimeout(retryTimer); retryTimer=setTimeout(retrySync,15000); })
      .then(function() { delete syncing[key]; if (state.data.syncQueue[key] && state.data.syncQueue[key] !== item) drainSync(key); if(state.currentScreen==='settings')renderSettings(); });
  }
  function retrySync() { Object.keys(state.data.syncQueue).forEach(drainSync); }
  function hydrateLibrary() {
    if (!CONFIG.apiBaseUrl) return Promise.resolve();
    return Promise.all([
      apiFetchJson(apiUrl('/api/me/favorites'),withDeviceHeader()).then(function(data) {
        var remoteIds={};
        (Array.isArray(data.favorites)?data.favorites:[]).forEach(function(b) {
          remoteIds[b.id]=true;
          if (!Number.isInteger(b.id) || b.id <= 0 || !b.title || state.data.syncQueue['favorite:'+b.id]) return;
          if (Number(b.addedAt) <= (state.data.favoriteRemoved[b.id] || 0)) return;
          var local=state.data.favorites[b.id];
          if (!local || Number(b.addedAt)>Number(local.addedAt)) state.data.favorites[b.id]=b;
        });
        Object.keys(state.data.favorites).forEach(function(id){if(!remoteIds[id]&&!state.data.syncQueue['favorite:'+id])serverSyncFavoriteAdd(state.data.favorites[id]);});
      }),
      apiFetchJson(apiUrl('/api/me/recents'),withDeviceHeader()).then(function(data) {
        var combined={}; state.data.recents.forEach(function(b) { combined[b.id]=b; });
        (Array.isArray(data.recents)?data.recents:[]).forEach(function(b) {
          if (!Number.isInteger(b.id) || b.id <= 0 || !b.title || b.title==='(unknown)') return;
          if (!combined[b.id] || Number(b.lastReadAt)>Number(combined[b.id].lastReadAt)) combined[b.id]=b;
          var p=state.data.progress[b.id];
          if (!state.data.syncQueue['progress:'+b.id] && Number.isFinite(Number(b.fraction)) && (!p || Number(b.lastReadAt)>Number(p.updatedAt)) && !(p && Math.abs(p.fraction-Number(b.fraction))<.000001)) {
            state.data.progress[b.id]={fraction:Number(b.fraction),updatedAt:Number(b.lastReadAt),anchorVersion:1};
          }
        });
        state.data.recents=Object.values(combined).sort(function(a,b){return Number(b.lastReadAt)-Number(a.lastReadAt);}).slice(0,20);
      })
    ]).then(function(){state.syncAvailable=true;saveData();if(state.currentScreen==='home')renderHome();if(state.currentScreen==='library')renderLibrary();}).catch(function(){state.syncAvailable=false;saveData(); /* Offline library stays intact. */ });
  }
  function serverSyncFavoriteAdd(book) {
    queueSync('favorite',book.id,book);
  }
  function serverSyncFavoriteRemove(bookId) {
    queueSync('favorite',bookId,null);
  }
  function serverSyncProgress(bookId, fraction) {
    queueSync('progress',bookId,{fraction:fraction});
  }
  function serverSyncRecent(book) {
    queueSync('recent',book.id,book);
  }
  function pingServer() {
    if (!CONFIG.apiBaseUrl) {
      state.serverAvailable = false;
      return Promise.resolve(false);
    }
    return fetchWithTimeout(apiUrl('/api/health')).then(function (res) {
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
    document.querySelectorAll('[data-action="back"]').forEach(function(b){b.setAttribute('aria-label',b.closest('#reader')?'Leave book':'Back');});
  }

  function navigateTo(screenId, options) {
    options = options || {};
    if (state.currentScreen === 'reader' && screenId !== 'reader') {
      flushProgress(); state.reader.ready=false; readGeneration++; if(readController)readController.abort(); closeReaderMenu();
    }
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
        document.getElementById('reader-page').focus();
      } else {
        focusFirst(screens[screenId]);
      }
    }
  }

  function navigateBack() {
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
    if(container===screens['book-detail']){document.querySelector('[data-action="open-book"]').focus();return;}
    if(container===screens.browse || container===screens.library){var book=container.querySelector('.book-item');if(book){book.focus();return;}}
    if(container===screens.search){document.getElementById('search-input').focus();return;}
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
        if (direction === 'down') { document.getElementById('reader-page').focus(); return; }
        if (direction === 'up')   { return; }
        var btns = visibleFocusables(toolbar);
        var ti = btns.indexOf(rActive);
        if (direction === 'left')  { if (ti > 0) btns[ti - 1].focus(); return; }
        if (direction === 'right') { if (ti < btns.length - 1) btns[ti + 1].focus(); return; }
      }
      if (rActive && rActive.closest && rActive.closest('.reader-footer')) {
        if (direction === 'up') { document.getElementById('reader-page').focus(); return; }
        var footerButtons=visibleFocusables(document.getElementById('reader-footer'));
        var target=moveFocusSpatial(footerButtons,rActive,direction); if(target)target.focus(); return;
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
      next.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  // ==================== UI HELPERS ====================
  function showToast(message, type) {
    var toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.getElementById('app').appendChild(toast);
      toast.setAttribute('role','status');
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
    btn.setAttribute('aria-label',(b.title||'Untitled')+', by '+(b.author||'Unknown'));
    btn.innerHTML = coverHTML(b) + '<span class="book-copy">' +
      '<span class="book-item-title">' + escapeHtml(b.title || 'Untitled') + '</span>' +
      '<div class="book-item-author">' + escapeHtml(b.author || 'Unknown') + '</div>' +
      (b.metaLine
        ? '<div class="book-item-meta">' + escapeHtml(b.metaLine) + '</div>'
        : '') + '</span>';
    return btn;
  }
  function coverHTML(b) {
    var letter=(b.title||'Book').replace(/^(the|a|an)\s+/i,'').trim().charAt(0).toUpperCase();
    return '<span class="book-cover cover-'+(Number(b.id)%6)+'" aria-hidden="true"><span class="cover-monogram">'+escapeHtml(letter)+'</span></span>';
  }
  function renderFeatured() {
    var holder=document.getElementById('home-featured'),fb=window.__BOOK_READER_FALLBACK_CATALOG__;
    if(!holder || !fb)return;
    if(holder.children.length)return;
    holder.innerHTML='';
    [1342,11,84].forEach(function(id){var b=fb.byId[id];if(!b)return;var item=bookListItem(b);item.className='featured-book focusable';item.innerHTML=coverHTML(b)+'<span class="book-caption">'+escapeHtml(b.title)+'</span>';holder.appendChild(item);});
  }

  function renderBookList(containerId, books, opts) {
    opts = opts || {};
    var container = document.getElementById(containerId);
    if (!container) return;
    var focused=container.contains(document.activeElement)?document.activeElement.dataset.bookId:null;
    container.innerHTML = '';
    if (!books || books.length === 0) {
      var msg = opts.emptyMessage || 'No books found';
      container.innerHTML = '<div class="empty-row">' + escapeHtml(msg) + '</div>';
      return;
    }
    books.forEach(function (b) { container.appendChild(bookListItem(b)); });
    if(focused){var replacement=Array.from(container.children).find(function(b){return b.dataset.bookId===focused;})||container.querySelector('.book-item');if(replacement)replacement.focus({preventScroll:true});}
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
      document.getElementById('continue-percent').textContent=pct+'% of your journey';
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
    document.getElementById('library-welcome').classList.toggle('hidden',!!recent);
    renderFeatured();
    var status = state.serverAvailable ? 'Classics, connected' : 'Your personal shelf';
    document.getElementById('home-status').textContent = status;
  }

  // ---- Browse ----
  // Tabs split into two strategies:
  //   - "popular" uses the server catalog. It may return a dated Gutenberg
  //     backup, which is labeled as Catalog rather than live popularity.
  //   - Topic tabs (fiction / adventure / mystery) render from the bundled
  //     catalog directly. Gutendex topic-filtered queries take 15-22s which is
  //     unusable on glasses; the curated bundled list is instant and reliable.
  function loadBrowse(tab) {
    state.browseTab = tab;
    document.querySelectorAll('#browse-tabs .tab-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tab === tab);
      el.setAttribute('aria-pressed',el.dataset.tab===tab);
    });
    var list = document.getElementById('browse-list');
    document.getElementById('browse-load-more').innerHTML='';
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

    // Default catalog page; the response identifies any saved catalog source.
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
      if (state.browseTab !== tab || state.browseExtras[tab].generation !== gen || state.currentScreen !== 'browse') return;
      renderPopularInitial(data);
    }).catch(function (err) {
      clearTimeout(slowMsgTimer);
      if (state.browseTab !== tab || state.browseExtras[tab].generation !== gen || state.currentScreen !== 'browse') return;
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
    var restore = state.currentScreen==='browse' && (!document.activeElement || document.activeElement.classList.contains('back-btn') || !screens.browse.contains(document.activeElement));
    var books = (data.results || []).map(normalizeGutendexBook).map(function (b) {
      b.metaLine = b.downloadCount ? (b.downloadCount.toLocaleString() + ' downloads') : '';
      return b;
    });
    var ex = state.browseExtras.popular;
    books.forEach(function (b) { ex.loadedIds[b.id] = true; });
    ex.gutendexPage = 1;
    ex.hasMore = !!data.next;
    renderBookList('browse-list', books, { emptyMessage: 'No books in this category' });
    showCatalogSource('browse-list', data);
    document.querySelector('#browse-tabs [data-tab="popular"]').textContent = data.catalog_source === 'gutenberg-offline' ? 'Catalog' : 'Popular';
    updateLoadMoreButton();
    if(restore)focusFirst(screens.browse);
  }

  function showCatalogSource(listId, data) {
    if (data.catalog_source !== 'gutenberg-offline') return;
    var list = document.getElementById(listId);
    var note = list.querySelector('.catalog-source-note');
    if (!note) {
      note = document.createElement('p');
      note.className = 'book-item-meta catalog-source-note';
      note.style.gridColumn = '1 / -1';
      note.style.margin = '0 0 4px';
      note.style.fontSize = '14px';
      note.style.lineHeight = '1.4';
      note.setAttribute('role', 'status');
      list.insertBefore(note, list.firstChild);
    }
    var date = typeof data.catalog_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.catalog_date) ? data.catalog_date : '';
    note.textContent = 'Gutenberg catalog · ' + (date ? 'saved ' + date : 'saved edition');
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
    var restoreFocus=!!(document.activeElement && document.activeElement.closest('#browse-load-more'));
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
      showCatalogSource('browse-list', data);
      if (tab === 'popular' && data.catalog_source === 'gutenberg-offline') document.querySelector('#browse-tabs [data-tab="popular"]').textContent = 'Catalog';
      ex.gutendexPage += 1;
      ex.hasMore = !!data.next;
      ex.loadingMore = false;
      updateLoadMoreButton();
      if(restoreFocus && state.currentScreen==='browse'){
        var next=fresh.length?document.querySelector('#browse-list [data-book-id="'+fresh[0].id+'"]'):document.querySelector('#browse-load-more .focusable');
        if(!next)next=document.querySelector('#browse-list .book-item:last-child');
        if(next){next.focus();next.scrollIntoView({block:'nearest'});}
      }
    }).catch(function (err) {
      if (gen !== state.browseExtras[tab].generation || state.browseTab !== tab) return;
      ex.loadingMore = false;
      updateLoadMoreButton(err.message || 'Network error');
      if(restoreFocus && state.currentScreen==='browse')focusFirst(document.getElementById('browse-load-more'));
    });
  }

  // ---- Search ----
  function renderSearchScreen() {
    // No-op; results render after submit
  }
  function runSearch() {
    var generation=++searchGeneration;
    var input = document.getElementById('search-input');
    var q = (input.value || '').trim();
    var results = document.getElementById('search-results');
    if (!q) {
      results.innerHTML = '<div class="empty-row">Enter a title or author</div>';
      return;
    }
    document.getElementById('search-keyboard').classList.add('hidden');
    document.getElementById('keyboard-toggle').setAttribute('aria-expanded','false');
    document.getElementById('search-results').classList.remove('hidden');
    results.innerHTML = '<div class="loading-row">Searching…</div>';
    fetchBookList({ search: q }).then(function (data) {
      if(generation!==searchGeneration)return;
      var books = (data.results || []).map(normalizeGutendexBook);
      renderBookList('search-results', books, { emptyMessage: 'No results' });
      showCatalogSource('search-results', data);
    }).catch(function (err) {
      if(generation!==searchGeneration)return;
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
    document.getElementById('detail-name').textContent = b.title || 'Book';
    document.getElementById('detail-cover').innerHTML=coverHTML(b);
    document.getElementById('detail-author').textContent = b.author || '';
    document.getElementById('detail-subjects').textContent =
      (b.subjects || []).slice(0, 3).join(' • ');
    document.getElementById('detail-description').textContent = b.description || 'A classic from the Project Gutenberg collection. Open the book to begin, or save it to your shelf for another day.';
    var btn = document.getElementById('detail-favorite-btn');
    btn.textContent = state.data.favorites[b.id] ? '★ Favorited' : '☆ Favorite';
    btn.setAttribute('aria-pressed',!!state.data.favorites[b.id]);
    document.querySelector('[data-action="open-book"]').textContent = (state.data.progress[b.id]||{}).fraction > 0 ? 'Resume reading' : 'Start reading';
  }

  function openBookDetailFromElement(el) {
    var generation=++detailGeneration;
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
      if(generation!==detailGeneration || !state.detailBook || state.detailBook.id!==book.id)return;
      var full = normalizeGutendexBook(raw);
      state.detailBook = full;
      if (state.currentScreen === 'book-detail') renderBookDetail();
    }).catch(function () {
      if(generation!==detailGeneration || !state.detailBook || state.detailBook.id!==book.id)return;
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
      state.data.favoriteRemoved[b.id]=Date.now();
      serverSyncFavoriteRemove(b.id);
      showToast('Removed from favorites');
    } else {
      state.data.favorites[b.id] = {
        id: b.id, title: b.title, author: b.author, addedAt: Date.now(),
      };
      delete state.data.favoriteRemoved[b.id];
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
      el.setAttribute('aria-pressed',el.dataset.tab===state.libraryTab);
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
    flushProgress();
    if (readController) readController.abort();
    var generation = ++readGeneration;
    var controller = readController = new AbortController();
    var r = state.reader;
    r.ready = false; r.bookId = b.id; r.title = b.title; r.author = b.author;
    r.text = ''; r.pages = []; r.offsets = []; r.currentPage = 0; r.anchorOffset=0;
    closeReaderMenu();
    document.getElementById('reader-toolbar-title').textContent = b.title;
    document.getElementById('reader-page-inner').innerHTML = '<div class="loading-row" id="reader-load-status">Opening your book…</div>';
    document.getElementById('reader-page-num').textContent = 'Finding your place';
    navigateTo('reader'); applyTextSize(); updatePageDisplay();
    var active = function() { return generation === readGeneration && state.currentScreen === 'reader' && state.reader.bookId === b.id; };
    var deadline = setTimeout(function() { controller.abort(); }, 45000);
    var slow = setTimeout(function() { if(active()) { var el=document.getElementById('reader-load-status'); if(el)el.textContent='Still opening… you can go back at any time.'; } },4000);
    function retrieve(attempt) {
      return fetchBookText(b.id, controller.signal).catch(function(err) {
        if(controller.signal.aborted || !active() || attempt>=1)throw err;
        return new Promise(function(resolve){setTimeout(resolve,600);}).then(function(){ if(controller.signal.aborted)throw new Error('Cancelled'); return retrieve(attempt+1); });
      });
    }
    var remote = CONFIG.apiBaseUrl ? fetchWithTimeout(apiUrl('/api/me/progress/'+b.id),withDeviceHeader({signal:controller.signal}),4000)
      .then(function(res){if(!res.ok)throw new Error('Local progress');return res.json();}).catch(function(){return null;}) : Promise.resolve(null);
    Promise.all([retrieve(0),remote]).then(function(values) {
      if(!active())return;
      var cleaned=stripGutenbergBoilerplate(values[0]);
      if(!cleaned || /^\s*<(?:!doctype|html)/i.test(cleaned))throw new Error('No readable text in this edition');
      r.text=cleaned.split(/\n{2,}/).map(function(p){return p.replace(/\s+/g,' ').trim();}).filter(Boolean).join('\n\n');
      var saved=state.data.progress[b.id] || {fraction:0}, remoteProgress=values[1];
      if(remoteProgress && !state.data.syncQueue['progress:'+b.id] && Number.isFinite(Number(remoteProgress.fraction)) && Number(remoteProgress.updatedAt)>Number(saved.updatedAt||0) && Math.abs(Number(remoteProgress.fraction)-Number(saved.fraction))>.000001) {
        saved={fraction:Number(remoteProgress.fraction),updatedAt:Number(remoteProgress.updatedAt),anchorVersion:1};state.data.progress[b.id]=saved;
      }
      rebuildPages();
      if(Number.isInteger(saved.offset) && saved.textLength===r.text.length) seekToOffset(saved.offset);
      else if(saved.anchorVersion===1) seekToOffset(Math.floor(Math.max(0,Math.min(1,Number(saved.fraction)||0))*r.text.length));
      else seekToFraction(Number(saved.fraction)||0);
      r.ready=true;updatePageDisplay();addToRecents();
      if(readController===controller)readController=null;
      controller.abort(); // Cancel any slower duplicate content retrieval.
    }).catch(function(err) {
      if(!active())return;
      r.ready=false;
      document.getElementById('reader-page-inner').innerHTML='<div class="error-row">This edition could not be opened.<br>Your saved place is safe. Try again, or choose another book.</div><button class="nav-item primary focusable" data-action="retry-open-book">Try again</button>';
      document.getElementById('reader-page-num').textContent='Your place is saved';
      document.querySelector('[data-action="retry-open-book"]').focus();
    }).then(function(){clearTimeout(deadline);clearTimeout(slow);});
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
    return body.replace(/\r\n/g, '\n').replace(/(^|[\s(])_([^_\n]{1,240})_(?=$|[\s.,;:!?)])/g,'$1$2').replace(/^\s+/, '').replace(/\s+$/, '');
  }

  // ---- Pagination engine ----
  // Pre-computes page boundaries by measuring paragraph heights in a hidden
  // sibling that matches the reader's font & width. Rendering only the current
  // page keeps the DOM tiny and scrolling smooth on the glasses.
  function rebuildPages() {
    var text=state.reader.text;
    if(!text)return;
    var inner=document.getElementById('reader-page-inner'),page=document.getElementById('reader-page');
    var cs=getComputedStyle(inner),lineHeight=parseFloat(cs.lineHeight)||parseFloat(cs.fontSize)*1.5;
    var capacity=Math.max(lineHeight,Math.floor(page.clientHeight/lineHeight)*lineHeight);
    var gap=parseFloat(cs.fontSize);
    var measure=document.createElement('div');
    measure.style.cssText='position:absolute;top:-99999px;left:0;visibility:hidden;margin:0;padding:0;border:0;';
    measure.style.fontFamily=cs.fontFamily;measure.style.fontSize=cs.fontSize;measure.style.lineHeight=cs.lineHeight;
    measure.style.width=inner.clientWidth+'px';measure.style.overflowWrap='anywhere';measure.style.whiteSpace='normal';
    document.body.appendChild(measure);
    function height(value){measure.textContent=value;return measure.getBoundingClientRect().height;}
    function prefix(value,available){
      var low=1,high=value.length,best=1;
      while(low<=high){var mid=(low+high)>>1;if(height(value.slice(0,mid))<=available){best=mid;low=mid+1;}else high=mid-1;}
      if(best<value.length){var space=value.lastIndexOf(' ',best);if(space>0)best=space;}
      if(best<value.length && /[\uD800-\uDBFF]/.test(value[best-1]))best--;
      if(best<1)best=Math.min(2,value.length);
      return value.slice(0,best).trimEnd();
    }
    var pages=[],offsets=[],parts=[],used=0,pageOffset=0,sourceOffset=0;
    function flush(){if(parts.length){pages.push(parts.map(function(p){return '<p>'+escapeHtml(p)+'</p>';}).join(''));offsets.push(pageOffset);}parts=[];used=0;}
    text.split('\n\n').forEach(function(paragraph){
      var remaining=paragraph,position=sourceOffset;sourceOffset+=paragraph.length+2;
      while(remaining.length){
        var margin=parts.length?gap:0,room=capacity-used-margin;
        if(room<lineHeight){flush();continue;}
        var fullHeight=height(remaining);
        if(fullHeight<=room){if(!parts.length)pageOffset=position;parts.push(remaining);used+=margin+fullHeight;break;}
        var chunk=prefix(remaining,room);
        if(!parts.length)pageOffset=position;
        parts.push(chunk);flush();position+=chunk.length;remaining=remaining.slice(chunk.length);
        while(remaining[0]===' '){position++;remaining=remaining.slice(1);}
      }
    });
    flush();measure.remove();
    state.reader.pages=pages.length?pages:[''];state.reader.offsets=offsets.length?offsets:[0];
    state.reader.currentPage=Math.min(state.reader.currentPage,state.reader.pages.length-1);
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
    document.getElementById('reader-spacing-display').textContent=String(spacing);
    document.querySelectorAll('[data-action="text-size-down"]').forEach(function(b){b.disabled=state.data.settings.textSizeIdx===0;b.setAttribute('aria-label','Smaller text');});
    document.querySelectorAll('[data-action="text-size-up"]').forEach(function(b){b.disabled=state.data.settings.textSizeIdx===CONFIG.textSizes.length-1;b.setAttribute('aria-label','Larger text');});
    document.querySelectorAll('[data-action="line-spacing-down"]').forEach(function(b){b.disabled=state.data.settings.lineSpacingIdx===0;});
    document.querySelectorAll('[data-action="line-spacing-up"]').forEach(function(b){b.disabled=state.data.settings.lineSpacingIdx===CONFIG.lineSpacings.length-1;});
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
    screens.reader.classList.add('reader-menu-open');
    var first = menu.querySelector('.focusable');
    if (first) first.focus();
  }
  function closeReaderMenu() {
    var menu = document.getElementById('reader-menu');
    menu.classList.add('hidden');
    screens.reader.classList.remove('reader-menu-open');
    if(state.currentScreen==='reader')document.getElementById('reader-page').focus();
  }

  function pageForward() {
    if(!state.reader.ready)return;
    if (state.reader.currentPage < totalPages() - 1) {
      state.reader.currentPage++;
      state.reader.anchorOffset=state.reader.offsets[state.reader.currentPage];
      renderCurrentPage();
      scheduleProgressSave();
    }
  }
  function pageBack() {
    if(!state.reader.ready)return;
    if (state.reader.currentPage > 0) {
      state.reader.currentPage--;
      state.reader.anchorOffset=state.reader.offsets[state.reader.currentPage];
      renderCurrentPage();
      scheduleProgressSave();
    }
  }
  function updatePageDisplay() {
    document.getElementById('reader-page-num').textContent =
      state.reader.pages.length ? (state.reader.currentPage + 1) + ' / ' + totalPages() + ' · '+Math.round(currentFraction()*100)+'%' : 'Opening…';
    document.getElementById('page-back').disabled=!state.reader.ready||state.reader.currentPage===0;
    document.getElementById('page-forward').disabled=!state.reader.ready||state.reader.currentPage>=totalPages()-1;
    document.getElementById('reading-track-fill').style.width=(currentFraction()*100)+'%';
  }
  function currentFraction() {
    var n = totalPages();
    if (n <= 1) return state.reader.ready ? 1 : 0;
    if(state.reader.currentPage===n-1)return 1;
    return currentOffset()/Math.max(1,state.reader.text.length);
  }
  function currentOffset() { return Number.isInteger(state.reader.anchorOffset)?state.reader.anchorOffset:((state.reader.offsets||[])[state.reader.currentPage]||0); }
  function seekToOffset(offset) {
    var points=state.reader.offsets||[0], page=0;
    for(var i=1;i<points.length;i++){if(points[i]>offset)break;page=i;}
    state.reader.currentPage=page; state.reader.anchorOffset=Math.max(0,Math.min(offset,state.reader.text.length)); renderCurrentPage();
  }
  function seekToFraction(f) {
    var n = totalPages();
    var p = Math.round(f * (n - 1));
    state.reader.currentPage = Math.max(0, Math.min(n - 1, p));
    state.reader.anchorOffset=(state.reader.offsets||[])[state.reader.currentPage]||0;
    renderCurrentPage();
  }
  function scheduleProgressSave() {
    clearTimeout(state.reader.saveTimer);
    state.reader.saveTimer = setTimeout(flushProgress, CONFIG.progressSaveDebounce);
  }
  function flushProgress() {
    clearTimeout(state.reader.saveTimer);
    if (!state.reader.bookId || !state.reader.ready || !state.reader.text) return;
    var f = currentFraction();
    state.data.progress[state.reader.bookId] = { fraction: f, offset:currentOffset(),textLength:state.reader.text.length,anchorVersion:1,updatedAt: Date.now() };
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
    var anchor = currentOffset();
    var n = CONFIG.textSizes.length;
    var i = state.data.settings.textSizeIdx + delta;
    if (i < 0 || i >= n) return;
    state.data.settings.textSizeIdx = i;
    saveData();
    applyTextSize();
    if (state.currentScreen === 'reader' && state.reader.text) {
      rebuildPages();
      seekToOffset(anchor); scheduleProgressSave();
    }
  }
  function bumpLineSpacing(delta) {
    var anchor = currentOffset();
    var n = CONFIG.lineSpacings.length;
    var i = state.data.settings.lineSpacingIdx + delta;
    if (i < 0 || i >= n) return;
    state.data.settings.lineSpacingIdx = i;
    saveData();
    applyTextSize();
    if (state.currentScreen === 'reader' && state.reader.text) {
      rebuildPages();
      seekToOffset(anchor); scheduleProgressSave();
    }
  }

  // ---- Settings screen ----
  function renderSettings() {
    applyTextSize();
    document.getElementById('settings-device-id').textContent = 'Reading positions and favorites are saved automatically in this browser. Keep its browsing data to keep access to your shelf.';
    document.getElementById('settings-server-status').textContent =
      Object.keys(state.data.syncQueue).length ? 'Saved on this device · Waiting to sync.' :
      state.syncAvailable ? 'Your shelf is also backed up for this browser.' : 'Saved on this device. Online backup is currently unavailable.';
  }

  // ==================== ACTIONS ====================
  function toggleKeyboard() {
    var keyboard=document.getElementById('search-keyboard'),opening=keyboard.classList.contains('hidden');
    keyboard.classList.toggle('hidden',!opening);document.getElementById('keyboard-toggle').setAttribute('aria-expanded',opening);
    document.getElementById('search-results').classList.toggle('hidden',opening);
    if(opening)focusFirst(keyboard);
  }
  function keyboardLetter(key) {
    var input=document.getElementById('search-input');
    if(key==='delete')input.value=Array.from(input.value).slice(0,-1).join('');
    else if(input.value.length<160)input.value+=key==='space'?' ':key.toLowerCase();
  }
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
      case 'toggle-keyboard':   toggleKeyboard(); break;
      case 'type-letter':       keyboardLetter(el.dataset.letter); break;
      case 'page-back':         pageBack(); break;
      case 'page-forward':      pageForward(); break;
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
      if(!actionEl || !screens[state.currentScreen].contains(actionEl) || actionEl.disabled)return;
      if(state.currentScreen==='reader' && !isReaderMenuClosed() && !document.getElementById('reader-menu').contains(actionEl))return;
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function (e) {
      var active = document.activeElement;
      var isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (isInput && !['Escape', 'Enter','ArrowUp','ArrowDown'].includes(e.key)) return;
      if(e.key==='Tab' && state.currentScreen==='reader' && !isReaderMenuClosed()) {
        var choices=visibleFocusables(document.getElementById('reader-menu')),ix=choices.indexOf(active);
        choices[(ix+(e.shiftKey?-1:1)+choices.length)%choices.length].focus();e.preventDefault();return;
      }

      switch (e.key) {
        case 'ArrowUp':    moveFocus('up');    e.preventDefault(); break;
        case 'ArrowDown':  moveFocus('down');  e.preventDefault(); break;
        case 'ArrowLeft':  moveFocus('left');  e.preventDefault(); break;
        case 'ArrowRight': moveFocus('right'); e.preventDefault(); break;
        case 'Enter':
          if(e.repeat){e.preventDefault();break;}
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
        var anchor = currentOffset();
        rebuildPages();
        seekToOffset(anchor);
      }
    });
    window.addEventListener('pagehide',function(){flushProgress();saveData();retrySync();});
    window.addEventListener('online',function(){pingServer();retrySync();hydrateLibrary();});
    document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flushProgress();});
  }

  // ==================== INIT ====================
  function init() {
    ensureDeviceId();
    collectScreens();
    setupEvents();
    loadData();
    applyTextSize();
    var keyboard=document.getElementById('search-keyboard');
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['space','delete']).forEach(function(letter){var b=document.createElement('button');b.className='letter-key focusable';b.dataset.action='type-letter';b.dataset.letter=letter;b.textContent=letter==='space'?'␣':letter==='delete'?'⌫':letter;b.setAttribute('aria-label',letter);keyboard.appendChild(b);});
    hydrateLibrary().then(retrySync);
    pingServer().then(function () {
      if (state.currentScreen === 'home') renderHome();
      if (state.currentScreen === 'settings') renderSettings();
      // Warm up: prefetch popular books so Browse is instant when the user opens it.
      // Errors are silent — Browse will retry on demand.
      fetchBookList({ sort: 'popular', page: 1 }).then(function (data) {
        state.cache['browse:popular'] = { data: data, timestamp: Date.now() };
      }).catch(function () {});
    });
    navigateTo('home', { addToHistory: false });
  }

  window.render_reader_to_text=function(){return JSON.stringify({screen:state.currentScreen,bookId:state.reader.bookId,ready:!!state.reader.ready,page:state.reader.currentPage+1,pages:state.reader.pages.length,offset:currentOffset(),fraction:currentFraction(),focus:document.activeElement&&document.activeElement.getAttribute('data-action')});};
  if(location.hostname==='127.0.0.1' && new URLSearchParams(location.search).has('test'))window.__readerTest={state:state,open:openBook,action:handleAction,flush:flushProgress,rebuild:rebuildPages,seek:seekToOffset,hydrate:hydrateLibrary,retrySync:retrySync};

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
