// Pilot Hub - shell, router and the shared formatting helpers.
//
// Loaded two ways on purpose, exactly like floors.js and squad.js: as a plain
// <script> in the hub window (no bundler, CSP script-src 'self') and via
// require() from test/hub.test.mjs. Hence the factory + globalThis/
// module.exports tail rather than ESM, and hence the rule that EVERY DOM touch
// lives behind start() - requiring this file in node must not need a document.
//
// This file owns: the hash router, the nav rail, the footer sync line, the
// first-run blocking screen, the in-memory json cache, and the number/date
// formatting every view shares. The item browser itself lives in hub-items.js.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHub = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==========================================================================
  // PURE: routing
  // ==========================================================================
  // `ready:false` renders the placeholder stub. Kept as data rather than as an
  // if-ladder in the router so shipping a view is a one-word change here.
  const ROUTES = [
    { id: 'items', label: 'Items', ready: true, view: 'PilotHubItems' },
    { id: 'quests', label: 'Quests', ready: true, view: 'PilotHubQuests' },
    { id: 'traders', label: 'Traders', ready: true, view: 'PilotHubTraders' },
    { id: 'maps', label: 'Maps', ready: true, view: 'PilotHubMaps' },
    { id: 'kit', label: 'Kit', ready: true, view: 'PilotHubKit' },
  ];
  const DEFAULT_ROUTE = 'items';

  // '#/items', '#items', '#/items/5447a9...', '', '#/nonsense' -> a known route
  // or the default. Never throws, never returns something the shell cannot
  // render: a bad hash must land on Items, not on a blank pane.
  function routeFromHash(hash) {
    return parseHash(hash).route;
  }

  // The deep-link form. '#/quests/<taskId>' is how the quest list hands a task
  // to the detail pane, and how the trader view sends you to an item - so the
  // second segment has to survive parsing, decoding and a hostile hash.
  //
  // Returns { route, param }. param is '' when there is no second segment, and
  // is NEVER trusted beyond being a string: every consumer looks it up in the
  // data it already holds, so an unknown id renders "not found", not a fetch.
  function parseHash(hash) {
    const raw = String(hash == null ? '' : hash).replace(/^#/, '').replace(/^\//, '');
    // a query or a second '#' ends the path; '/' separates route from param
    const path = raw.split(/[?#]/)[0];
    const parts = path.split('/');
    const head = String(parts[0] || '').toLowerCase();
    let route = DEFAULT_ROUTE;
    for (let i = 0; i < ROUTES.length; i++) if (ROUTES[i].id === head) route = head;
    let param = parts.length > 1 ? parts.slice(1).join('/') : '';
    try { param = decodeURIComponent(param); } catch (e) { /* keep the raw text */ }
    return { route, param };
  }

  // The inverse. Kept next to parseHash so the two cannot drift: every
  // cross-route link in the hub is built here.
  function hashFor(route, param) {
    const r = String(route || DEFAULT_ROUTE);
    return '#/' + r + (param ? '/' + encodeURIComponent(String(param)) : '');
  }

  // ==========================================================================
  // PURE: pilot-img:// URLs
  // ==========================================================================
  // These two must stay in step with HUB_IMG_ID_RE / HUB_IMG_SLUG_RE in
  // main.js. The renderer copy is not a security boundary - main validates
  // every request again - it exists so a bad id becomes an empty <img> here
  // instead of a 404 round trip.
  //
  // 24 lowercase alphanumerics: that is every tarkov.dev item and trader id in
  // the synced data. Not [0-9a-f], because 'customdogtags12345678910' is real.
  const ID_RE = /^[0-9a-z]{24}$/;
  // Boss slugs carry dots and brackets ('black-div.', 'the-wedge-(labs)'), so
  // they get their own rule; '..' is refused separately since a dot is legal.
  const SLUG_RE = /^[0-9a-z][0-9a-z().-]{0,63}$/;
  const IMG_KINDS = ['item', 'item512', 'trader', 'boss'];

  function imgUrl(kind, id) {
    if (IMG_KINDS.indexOf(kind) < 0) return '';
    const s = String(id == null ? '' : id);
    if (kind === 'boss') {
      if (!SLUG_RE.test(s) || s.indexOf('..') >= 0) return '';
    } else if (!ID_RE.test(s)) {
      return '';
    }
    // Escape hatch for a host that is not Electron (the web port serves the
    // same icons over plain https). Deliberately AFTER the validation above, so
    // a hook can only ever be handed a kind/id pair main.js would also have
    // accepted - the rules stay in one place and a host cannot widen them.
    // Nothing sets this in the desktop app, so the pilot-img: URL below is what
    // Electron keeps getting.
    const hook = (typeof globalThis !== 'undefined') ? globalThis.PILOT_IMG_URL : null;
    if (typeof hook === 'function') return hook(kind, s);
    return 'pilot-img://' + kind + '/' + s;
  }

  // ==========================================================================
  // PURE: the first-run screen's state machine
  // ==========================================================================
  // What the blocking boot card should show for a given wiki-sync-status
  // payload, or null when the status says nothing about booting.
  //
  // 'idle' is the one that matters and the one that was missing. main answers a
  // FORCED sync with { state: 'idle' } in two cases - the 60s debounce swallowed
  // it, or it decided nothing needed syncing - and in neither case will a
  // 'running' or 'done' ever follow. Handling only error/done/running meant the
  // very first "Try again" after an offline first run hid the retry button,
  // asked for a sync that was debounced away, and left the window reading
  // "Downloading..." forever with no way back short of a restart.
  //
  // Pure so exactly that path can be tested without a window.
  function bootPlanFor(s) {
    const state = s && s.state;
    if (state === 'error') {
      return {
        msg: 'The item database could not be downloaded.',
        progress: (s && s.error) ? String(s.error) : 'the sync failed',
        retry: true,
        load: false,
      };
    }
    if (state === 'done') {
      return { msg: 'Loading the item database...', progress: '', retry: false, load: true };
    }
    if (state === 'running') {
      return {
        msg: 'Downloading the item database...',
        progress: (s && s.progress) ? String(s.progress) : 'starting',
        retry: false,
        load: false,
      };
    }
    if (state === 'idle') {
      return {
        msg: 'The item database has not downloaded yet.',
        // The debounce is a 60s window, so "try again shortly" is literally
        // true - and far better than a dead button with no explanation.
        progress: (s && s.debounced)
          ? 'a sync just ran - try again in a minute'
          : 'nothing was downloaded',
        retry: true,
        load: false,
      };
    }
    return null;
  }

  // The packaged build deliberately excludes data/wiki/img (it would add
  // hundreds of MB to the installer), so a first run has the database but no
  // icons until a sync mirrors them. iconsMirrored + iconsSkipped === 0 is
  // exactly that state: a sync HAS run (there is an images block) and it put no
  // icon on disk. Anything older than the images block, or any real mirror,
  // returns false - a notice that cries wolf is worse than no notice.
  function iconsLookMissing(meta) {
    const img = meta && meta.images;
    if (!img || typeof img !== 'object') return false;
    const mirrored = Number(img.iconsMirrored);
    const skipped = Number(img.iconsSkipped);
    if (!Number.isFinite(mirrored) || !Number.isFinite(skipped)) return false;
    return (mirrored + skipped) === 0;
  }

  // ==========================================================================
  // PURE: formatting
  // ==========================================================================
  // Written as an escape so this file stays plain ASCII on disk (a rouble sign
  // pasted into a source file is exactly the sort of thing that survives here
  // and breaks somewhere else).
  const RUB = '\u20bd';

  function groupDigits(n) {
    const neg = n < 0;
    const s = String(Math.abs(n));
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ',';
      out += s[i];
    }
    return (neg ? '-' : '') + out;
  }

  // null/undefined/'' return EMPTY, not '0': Number(null) is 0, and a missing
  // price rendering as "0 roubles" is a lie the UI has no way to walk back.
  function blank(v) {
    return v == null || v === '';
  }

  function formatRub(v) {
    if (blank(v)) return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return groupDigits(Math.round(n)) + RUB;
  }

  // Trader prices are quoted in their own currency; the rouble equivalent is
  // always shown alongside, so this never has to guess an exchange rate.
  function formatCurrency(v, cur) {
    if (blank(v)) return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    const c = String(cur || 'RUB').toUpperCase();
    if (c === 'RUB') return formatRub(n);
    if (c === 'USD') return '$' + groupDigits(Math.round(n));
    if (c === 'EUR') return '\u20ac' + groupDigits(Math.round(n));
    return groupDigits(Math.round(n)) + ' ' + c;
  }

  function formatWeight(v) {
    if (blank(v)) return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return (Math.round(n * 100) / 100) + ' kg';
  }

  // 48h flea change. Signed on purpose - "-7.7%" and "7.7%" are different facts.
  function formatPct(v) {
    if (blank(v)) return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    const r = Math.round(n * 10) / 10;
    return (r > 0 ? '+' : '') + r + '%';
  }

  // Short, human, and never a lie: an unscanned or missing timestamp says so
  // rather than rendering as 1970.
  function ago(then, now) {
    const t = Number(then);
    if (!Number.isFinite(t) || t <= 0) return 'never';
    const n = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(n)) return 'never';
    const secs = Math.floor(Math.max(0, n - t) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 48) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  // ==========================================================================
  // Everything below touches the DOM and only ever runs inside start().
  // ==========================================================================

  // One parse per file per session. The promise is what is cached, not the
  // result, so two views asking for items-desc.json at once share one read
  // instead of parsing 800 KB twice.
  const jsonCache = new Map();

  function makeLoader(api) {
    return function loadJson(name) {
      if (jsonCache.has(name)) return jsonCache.get(name);
      const p = Promise.resolve()
        .then(() => api.readData(name))
        .then((text) => {
          if (text == null) return null;
          try {
            return JSON.parse(text);
          } catch (e) {
            console.error('hub: ' + name + ' is not valid JSON: ' + e.message);
            return null;
          }
        })
        .catch((e) => {
          // a read that REJECTED may succeed later (a sync landing the file),
          // so this one is not cached
          jsonCache.delete(name);
          console.error('hub: could not read ' + name + ': ' + e.message);
          return null;
        });
      jsonCache.set(name, p);
      return p;
    };
  }

  // The map basemaps under data/svg/ are TEXT, not JSON, so they need their own
  // cache: handing one to loadJson would fail to parse and then cache a null
  // for the rest of the session. read-data already returns raw text and already
  // refuses anything that escapes a data dir, so nothing new is needed in main.
  const textCache = new Map();

  function makeTextLoader(api) {
    return function loadTextFile(name) {
      if (textCache.has(name)) return textCache.get(name);
      const p = Promise.resolve()
        .then(() => api.readData(name))
        .then((text) => (typeof text === 'string' ? text : null))
        .catch((e) => {
          textCache.delete(name); // a rejected read may succeed later
          console.error('hub: could not read ' + name + ': ' + e.message);
          return null;
        });
      textCache.set(name, p);
      return p;
    };
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  // The two builders every view repeats. textContent only, never innerHTML:
  // item names, quest names and map descriptions are all synced strings, and
  // one of them WILL eventually contain a '<'.
  function section(title) {
    const s = el('section', 'detail-section');
    if (title != null) s.appendChild(el('h3', null, title));
    return s;
  }

  function table(rows) {
    const t = el('table', 'stat-table');
    const body = document.createElement('tbody');
    (rows || []).forEach((r) => {
      if (!r) return;
      const tr = document.createElement('tr');
      tr.appendChild(el('th', null, r.k));
      tr.appendChild(el('td', null, r.v));
      body.appendChild(tr);
    });
    t.appendChild(body);
    return t;
  }

  function start() {
    const api = (typeof globalThis !== 'undefined' && globalThis.hubAPI) || null;
    const loadJson = api ? makeLoader(api) : function () { return Promise.resolve(null); };
    const loadText = api ? makeTextLoader(api) : function () { return Promise.resolve(null); };

    const navEl = document.getElementById('hub-nav-items');
    const mainEl = document.getElementById('hub-main');
    const bootEl = document.getElementById('hub-boot');
    const bootMsgEl = document.getElementById('hub-boot-msg');
    const bootProgEl = document.getElementById('hub-boot-progress');
    const bootBtn = document.getElementById('hub-boot-retry');
    const syncStateEl = document.getElementById('sync-state');
    const syncAgeEl = document.getElementById('sync-age');
    const syncBtn = document.getElementById('sync-now');
    const updateLineEl = document.getElementById('update-line');
    const noticeEl = document.getElementById('hub-notice');
    const noticeTextEl = document.getElementById('hub-notice-text');
    const noticeBtn = document.getElementById('hub-notice-dismiss');

    let init = null;
    let meta = null;
    let booted = false;      // the data is in and the router is live
    let mountedRoute = null; // so re-entering the same route does not rebuild it
    let mountedView = null;  // whatever the view's render() handed back
    const ctx = {
      api,
      loadJson,
      loadText,
      imgUrl,
      formatRub,
      formatCurrency,
      formatWeight,
      formatPct,
      ago,
      el,
      clear,
      section,
      table,
      hashFor,
      // Cross-route navigation. The ONE way a view is allowed to send the user
      // somewhere else, so the "same hash, different intent" case (clicking the
      // same item twice from two different quests) is handled in one place
      // instead of silently doing nothing.
      go: (route, param) => {
        const next = hashFor(route, param);
        if (window.location.hash === next) applyRoute(next);
        else window.location.hash = next;
      },
      // Told to the views so they can gate on it; kept here so the quest badges
      // and the trader inventory can never disagree about what the profile says.
      profile: { playerLevel: null, faction: null, traderLevels: {} },
      questState: {},
      // A view calls this to persist a profile patch. The echo comes back on
      // the 'profile' push, which is what actually updates ctx.profile - so the
      // UI can never show a value main refused.
      saveProfile: (patch) => { if (api && api.saveProfile) api.saveProfile(patch); },
      // Feature-detected, and null in Electron ON PURPOSE. Here the quest state
      // is a READ of the game's own push-notification log - the app knows what
      // the player has done because the game said so, and letting the UI write
      // over that would mean the badges could disagree with the game itself.
      // A host with no log to read (the web port) provides this hook instead,
      // and hub-quests.js grows its done-marking controls only when it is here.
      setQuestStatus: (typeof globalThis !== 'undefined'
        && typeof globalThis.PILOT_SET_QUEST_STATUS === 'function')
        ? globalThis.PILOT_SET_QUEST_STATUS
        : null,
      // Drop a cached parse. loadJson caches the PROMISE, so a file that read
      // as null once (missing, mid-sync, bad JSON) would keep answering null for
      // the rest of the session; a view that can recover from that says so here.
      forgetJson: (name) => { jsonCache.delete(name); },
    };

    // Lazily-loaded, cached-forever slices of the wiki. Deliberately NOT part
    // of loadCore: quests.json is 3 MB and mapsinfo.json is only wanted by one
    // route, so paying for them at boot would slow the window down for someone
    // who only ever opens Items.
    function ensureQuests() {
      if (ctx.quests) return Promise.resolve(ctx.quests);
      return loadJson('wiki/quests.json').then((doc) => {
        ctx.quests = (doc && Array.isArray(doc.tasks)) ? doc.tasks : [];
        ctx.questById = {};
        ctx.quests.forEach((t) => { if (t && t.id) ctx.questById[t.id] = t; });
        return ctx.quests;
      });
    }

    function ensureMaps() {
      if (ctx.mapsinfo) return Promise.resolve(ctx.mapsinfo);
      return loadJson('wiki/mapsinfo.json').then((doc) => {
        ctx.mapsinfo = Array.isArray(doc) ? doc : [];
        return ctx.mapsinfo;
      });
    }

    // 3.4 MB, and only two views want it - the item detail pane and the kit
    // optimizer. loadJson caches the PROMISE by filename, so whichever asks
    // first pays for the parse and the other gets it free.
    function ensureProps() {
      if (ctx.itemProps) return Promise.resolve(ctx.itemProps);
      return loadJson('wiki/item-props.json').then((doc) => {
        ctx.itemProps = (doc && typeof doc === 'object') ? doc : {};
        return ctx.itemProps;
      });
    }

    ctx.ensureQuests = ensureQuests;
    ctx.ensureMaps = ensureMaps;
    ctx.ensureProps = ensureProps;

    // ---- nav rail ----
    function renderNav(active) {
      clear(navEl);
      ROUTES.forEach((r) => {
        const a = el('a', 'nav-item' + (r.id === active ? ' active' : ''), r.label);
        a.href = '#/' + r.id;
        if (!r.ready) a.appendChild(el('span', 'nav-soon', 'soon'));
        navEl.appendChild(a);
      });
    }

    // ---- footer ----
    function renderFooter(state) {
      const syncing = !!(state && state.syncing);
      const err = state && state.error;
      if (syncing) {
        syncStateEl.textContent = 'syncing' + (state.progress ? ' - ' + state.progress : '');
        syncStateEl.className = 'sync-state busy';
      } else if (err) {
        syncStateEl.textContent = String(err);
        syncStateEl.className = 'sync-state bad';
      } else {
        syncStateEl.textContent = meta ? 'wiki data ready' : 'no wiki data yet';
        syncStateEl.className = 'sync-state' + (meta ? '' : ' bad');
      }
      const counts = meta && meta.counts;
      syncAgeEl.textContent = meta
        ? (counts && counts.items ? counts.items + ' items - ' : '') + 'synced ' + ago(meta.syncedAt)
        : '';
      syncBtn.disabled = syncing;
      syncBtn.textContent = syncing ? 'syncing...' : 'Sync now';
    }

    // ---- update line ----
    // Sits next to the sync status and is a pure readout of main's
    // 'updater-status' push: every word, and the decision about whether it can
    // be clicked at all, is computed in src/updater.js. This function must NOT
    // develop opinions of its own - if it ever decides for itself that a
    // restart is offerable, the "never mid-raid" rule stops being testable in
    // one place.
    //
    // 'Up to date' is deliberately NOT shown: a permanently-green line in the
    // footer is noise. Nothing to say means nothing rendered.
    let updateStatus = null;
    function renderUpdateLine() {
      if (!updateLineEl) return;
      const s = updateStatus;
      const show = !!(s && s.text && s.state && s.state !== 'idle' && s.state !== 'checking');
      if (show) updateLineEl.textContent = s.text;
      const clickable = !!(show && s.actionable && s.action);
      updateLineEl.disabled = !clickable;
      // One authoritative className assignment rather than a toggle plus an
      // overwrite - the overwrite always won anyway, and two of them reading
      // differently is how a hidden element ends up visible.
      updateLineEl.className = 'update-line' + (show ? '' : ' hidden')
        + (clickable ? ' ready' : '');
      updateLineEl.title = clickable
        ? ''
        : (s && s.gameRunning ? 'Held back until Tarkov closes' : '');
    }
    if (updateLineEl) {
      updateLineEl.addEventListener('click', () => {
        const s = updateStatus;
        if (!s || !s.actionable || !s.action) return;
        if (api && api.updaterAction) api.updaterAction(s.action);
      });
    }

    // ---- notice line ----
    // One dismissable line, session-only. Today it has exactly one job: on a
    // packaged first run the installer ships no data/wiki/img, so every icon in
    // the browser is blank until a sync mirrors them - which looks like a broken
    // app rather than a pending download.
    let noticeDismissed = false;
    function renderNotice() {
      if (!noticeEl) return;
      const show = !noticeDismissed && !!meta && iconsLookMissing(meta);
      if (show && noticeTextEl) {
        noticeTextEl.textContent = 'Item icons finish downloading on the next data sync.';
      }
      noticeEl.classList.toggle('hidden', !show);
    }

    // ---- asking for a sync ----
    // Every path that asks main for a sync goes through here. main answers a
    // real sync with a 'running' status within a tick, so if NOTHING has come
    // back by the time this fires the request was swallowed - TEST_MODE returns
    // from autoSyncWiki before sending any status at all - and the controls have
    // to come back rather than sit disabled for the rest of the session.
    const SYNC_ANSWER_MS = 1500;
    let syncAnswerTimer = null;
    function clearSyncWatchdog() {
      if (syncAnswerTimer) { clearTimeout(syncAnswerTimer); syncAnswerTimer = null; }
    }
    function requestSync() {
      if (!api) return;
      syncBtn.disabled = true;
      clearSyncWatchdog();
      syncAnswerTimer = setTimeout(() => {
        syncAnswerTimer = null;
        renderFooter({ syncing: false });
        if (!booted) {
          showBoot('The item database has not downloaded yet.',
            'the sync did not start - try again', true);
        }
      }, SYNC_ANSWER_MS);
      api.syncWikiNow();
    }

    // ---- routing ----
    // Views are looked up by the global their UMD tail sets, so a file that
    // failed to load says so in the pane instead of leaving it blank.
    function viewFor(def) {
      if (!def || !def.view) return null;
      return (typeof globalThis !== 'undefined' && globalThis[def.view]) || null;
    }

    // Some routes need a slice of the wiki that boot deliberately skipped.
    // Resolved BEFORE the view is built, so no view has to render an empty
    // shell and then re-render itself.
    function prefetchFor(route) {
      if (route === 'quests') return ensureQuests();
      if (route === 'traders') return ensureQuests(); // task names on locked offers
      if (route === 'maps') return ensureMaps();
      // the kit view needs the properties (every stat it scores) AND the quest
      // names, since a task-locked offer is only actionable if you know which
      // task it is
      if (route === 'kit') return Promise.all([ensureProps(), ensureQuests()]);
      return Promise.resolve(null);
    }

    function mount(route, param) {
      // Re-entering the SAME route with a different deep link is a focus, not
      // a rebuild: rebuilding the quest tree every time a task is clicked would
      // throw away the scroll position and the open accordion.
      if (mountedRoute === route) {
        if (mountedView && typeof mountedView.focus === 'function') mountedView.focus(param);
        return;
      }
      mountedRoute = route;
      // A view that took anything OUTSIDE mainEl - the items browser holds the
      // window's single resize listener - gets told before its DOM is thrown
      // away. Optional: a view with nothing to release simply has no destroy.
      if (mountedView && typeof mountedView.destroy === 'function') {
        try { mountedView.destroy(); } catch (e) { console.error('hub: view destroy failed: ' + e.message); }
      }
      mountedView = null;
      renderNav(route);
      clear(mainEl);
      // Leaving a route drops the phone detail overlay so the next view opens on
      // its list, not on a stale detail pane. No-op on desktop (CSS ignores it).
      mainEl.classList.remove('mobile-detail');
      const def = ROUTES.filter((r) => r.id === route)[0];
      if (def && def.ready) {
        const view = viewFor(def);
        if (!view) {
          mainEl.appendChild(el('div', 'stub', 'hub-' + route + '.js did not load'));
          return;
        }
        const pending = el('div', 'stub', 'Loading...');
        mainEl.appendChild(pending);
        const wanted = route;
        prefetchFor(route).then(() => {
          if (mountedRoute !== wanted) return; // the user moved on while it loaded
          clear(mainEl);
          mountedView = view.render(mainEl, ctx, param) || null;
        }).catch((e) => {
          if (mountedRoute !== wanted) return;
          clear(mainEl);
          mainEl.appendChild(el('div', 'stub', 'This view could not load: '
            + String(e && e.message ? e.message : e)));
        });
        return;
      }
      const stub = el('div', 'stub');
      stub.appendChild(el('h2', null, def ? def.label : 'Unknown'));
      stub.appendChild(el('p', null, 'Coming in the next update.'));
      mainEl.appendChild(stub);
    }

    function applyRoute(hash) {
      if (!booted) return;
      const r = parseHash(hash);
      mount(r.route, r.param);
    }

    function route() {
      applyRoute(window.location.hash);
    }

    // A quest event or a profile save changes what EVERY badge in the mounted
    // view should say, so the shell tells the view rather than each view
    // subscribing to ipc for itself.
    function notifyView() {
      if (mountedView && typeof mountedView.refresh === 'function') {
        try { mountedView.refresh(); } catch (e) { console.error('hub: view refresh failed: ' + e.message); }
      }
    }

    // ---- boot ----
    function showBoot(msg, progress, retryable) {
      bootEl.classList.remove('hidden');
      bootMsgEl.textContent = msg;
      bootProgEl.textContent = progress || '';
      bootBtn.classList.toggle('hidden', !retryable);
    }

    function hideBoot() {
      bootEl.classList.add('hidden');
    }

    async function loadCore() {
      const [items, cats] = await Promise.all([
        loadJson('wiki/items.json'),
        loadJson('wiki/categories.json'),
      ]);
      if (!items || !items.items) return false;
      ctx.items = items.items;
      ctx.gameMode = items.gameMode || (init && init.gameMode) || 'regular';
      ctx.categories = cats || { itemCategories: {}, handbookCategories: {} };
      const traders = await loadJson('wiki/traders.json');
      ctx.traders = Array.isArray(traders) ? traders : [];
      ctx.traderById = {};
      ctx.traders.forEach((t) => { if (t && t.id) ctx.traderById[t.id] = t; });
      const barters = await loadJson('wiki/barters.json');
      ctx.barters = Array.isArray(barters) ? barters : [];
      return true;
    }

    async function finishBoot() {
      const ok = await loadCore();
      if (!ok) {
        showBoot('The item database could not be read.',
          'data/wiki/items.json is missing or unreadable.', true);
        return;
      }
      booted = true;
      hideBoot();
      mountPalette();
      mountedRoute = null;
      route();
    }

    // ---- Ctrl+K palette ----
    // Mounted once, AFTER the data is in: it searches ctx.items/quests/traders/
    // mapsinfo, so there is nothing for it to do while the boot screen is up.
    // Looked up off the global its UMD tail sets, exactly like the route views,
    // so a build without hub-search.js loses the palette and nothing else.
    let paletteMounted = false;
    function mountPalette() {
      if (paletteMounted) return;
      const mod = (typeof globalThis !== 'undefined' && globalThis.PilotHubSearch) || null;
      if (!mod || typeof mod.mount !== 'function') return;
      try {
        mod.mount(ctx);
        paletteMounted = true;
      } catch (e) {
        console.error('hub: the search palette could not mount: '
          + (e && e.message ? e.message : e));
      }
    }

    // ---- wiring ----
    window.addEventListener('hashchange', route);

    // ---- mobile master-detail (web island only) ----
    // On a phone the two-pane views collapse to one column: tapping a list row
    // reveals the detail as a full-pane overlay, and the Back button returns to
    // the list. This is pure DOM class toggling delegated at the shell - it
    // does NOT reach into any view's own select() logic, so desktop, tests and
    // the Electron build (which never has #hub-back) are all unaffected. The
    // accordion trader headers in Quests are deliberately NOT in the selector,
    // so expanding a trader group does not slam the detail overlay open.
    const backBtn = document.getElementById('hub-back');
    function showMobileDetail(on) { mainEl.classList.toggle('mobile-detail', !!on); }
    mainEl.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.item-row, .quest-row, .trader-card, .map-card')) {
        showMobileDetail(true);
      }
    });
    if (backBtn) backBtn.addEventListener('click', () => showMobileDetail(false));

    // Quest state arrives from the game's own log watcher; the profile arrives
    // back from main after a save. Either one changes every badge on screen.
    if (api && api.onQuests) {
      api.onQuests((p) => {
        if (!p) return;
        ctx.questState = p.state || {};
        notifyView();
      });
    }
    if (api && api.onProfile) {
      api.onProfile((p) => {
        if (!p) return;
        ctx.profile = {
          playerLevel: p.playerLevel == null ? null : p.playerLevel,
          faction: p.faction || null,
          traderLevels: p.traderLevels || {},
        };
        notifyView();
      });
    }
    syncBtn.addEventListener('click', requestSync);
    bootBtn.addEventListener('click', () => {
      if (!api) return;
      showBoot('Downloading the item database...', 'starting', false);
      requestSync();
    });
    if (noticeBtn) {
      noticeBtn.addEventListener('click', () => { noticeDismissed = true; renderNotice(); });
    }

    if (api && api.onWikiSyncStatus) {
      api.onWikiSyncStatus((s) => {
        if (!s) return;
        clearSyncWatchdog(); // main answered, so the "nothing came back" path is off
        if (s.meta) meta = s.meta;
        renderFooter(s);
        renderNotice();
        if (booted) return;
        const plan = bootPlanFor(s);
        if (!plan) return;
        showBoot(plan.msg, plan.progress, plan.retry);
        if (plan.load) {
          // the files have just been rewritten, so nothing parsed before the
          // sync may be reused
          jsonCache.clear();
          finishBoot();
        }
      });
    }

    if (api && api.onUpdaterStatus) {
      api.onUpdaterStatus((s) => {
        if (!s) return;
        updateStatus = s;
        renderUpdateLine();
      });
    }

    if (!api) {
      showBoot('This window was opened without its preload bridge.', '', false);
      return;
    }

    api.getInit().then((got) => {
      init = got || {};
      meta = init.wikiMeta || null;
      // Both of these have to be in place BEFORE the first view is built - a
      // quest tree that renders every badge as 'locked' and then corrects
      // itself a tick later reads as a bug.
      ctx.questState = init.questState || {};
      const prof = init.profile || {};
      ctx.profile = {
        playerLevel: prof.playerLevel == null ? null : prof.playerLevel,
        faction: prof.faction || null,
        traderLevels: prof.traderLevels || {},
      };
      renderFooter({ syncing: init.syncing });
      // Seeded from getInit so the footer is correct on first paint - the next
      // 'updater-status' push may be hours away (the check itself is 30s after
      // launch and then every 4 hours).
      updateStatus = init.updater || null;
      renderUpdateLine();
      renderNotice();
      if (!init.hasWiki) {
        // NOTHING to show: block. Merely-stale data does not block - main has
        // already kicked off a background sync (openHub calls autoSyncWiki) and
        // an aging copy is far more useful than an empty window.
        showBoot('Downloading the item database...',
          init.syncing ? 'starting' : 'this is a one-off, and takes a minute', !init.syncing);
        if (!init.syncing) requestSync();
        return;
      }
      showBoot('Loading the item database...', '', false);
      finishBoot();
    }).catch((e) => {
      showBoot('The hub could not start.', String(e && e.message ? e.message : e), false);
    });
  }

  // Renderer only. In node (the tests) there is no document and nothing here
  // runs - which is the whole point of keeping the helpers above pure.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }

  return {
    ROUTES,
    DEFAULT_ROUTE,
    ID_RE,
    SLUG_RE,
    routeFromHash,
    parseHash,
    hashFor,
    bootPlanFor,
    iconsLookMissing,
    imgUrl,
    groupDigits,
    formatRub,
    formatCurrency,
    formatWeight,
    formatPct,
    ago,
    start,
  };
}));
