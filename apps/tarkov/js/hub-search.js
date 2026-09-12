// Pilot Hub - the Ctrl+K command palette.
//
// Loaded two ways on purpose, exactly like hub.js and the view files: as a
// plain <script> in the hub window (no bundler, CSP script-src 'self') and via
// require() from test/hub.test.mjs. Hence the factory + globalThis/
// module.exports tail rather than ESM, and hence the rule that EVERY DOM touch
// lives behind mount() - requiring this file in node must not need a document.
//
// WHY THIS EXISTS: the hub has five routes and four of them have their own
// search box, each searching one namespace. Knowing WHICH box to open before
// you can look something up is the wrong way round - you know the NAME
// ("Gunsmith Part 5", "Salewa", "Skier", "Interchange") long before you know
// whether it is a quest, an item, a trader or a map. Ctrl+K searches all four
// at once and routes you to whichever it turns out to be.
//
// THE RANKING IS NOT A COPY. matchRank/compareSearch are hub-items' own
// functions, reached through the global its UMD tail sets, because "exact >
// prefix > substring, with the short name checked alongside the full name" is
// ONE rule and two implementations of it would drift the first time either is
// tuned. See itemsModule() for why the lookup is lazy.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubSearch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==========================================================================
  // PURE: the namespaces
  // ==========================================================================
  // `route` is the hub route a hit of that type navigates to, so the palette
  // never hardcodes a hash: '#/items/<id>' is built by ctx.hashFor/ctx.go from
  // this route id and the entry's own id.
  const TYPES = [
    { id: 'item', label: 'Items', route: 'items' },
    { id: 'quest', label: 'Quests', route: 'quests' },
    { id: 'trader', label: 'Traders', route: 'traders' },
    { id: 'map', label: 'Maps', route: 'maps' },
  ];

  // Tie-break order for hits that scored the SAME rank, and only for those.
  //
  // Items last, deliberately. There are 5,312 of them against 517 quests, 16
  // traders and 17 maps, so an item is overwhelmingly the most likely thing to
  // match a string by accident - while a trader/map/quest name that matched at
  // the same rank almost always IS what was typed. "prapor" must not put four
  // items called "...Prapor..." above the trader.
  const TYPE_ORDER = ['trader', 'map', 'quest', 'item'];

  // Anything past this is noise: a query loose enough to return 30 hits is a
  // query that wants another character typed, not a longer list scrolled.
  const MAX_RESULTS = 30;

  function typeDef(type) {
    const t = String(type == null ? '' : type);
    for (let i = 0; i < TYPES.length; i++) if (TYPES[i].id === t) return TYPES[i];
    return null;
  }

  function routeForType(type) {
    const d = typeDef(type);
    return d ? d.route : '';
  }

  function labelForType(type) {
    const d = typeDef(type);
    return d ? d.label : String(type == null ? '' : type);
  }

  // ==========================================================================
  // PURE: ranking, borrowed from the items browser
  // ==========================================================================
  // Resolved at CALL time, not at load time. In the window hub.html loads
  // hub-items.js before this file; in node the tests require them in whatever
  // order they like. A lazy lookup is correct under both, and costs one
  // property read per keystroke.
  function itemsModule() {
    const m = (typeof globalThis !== 'undefined' && globalThis.PilotHubItems) || null;
    return (m && typeof m.matchRank === 'function') ? m : null;
  }

  // -1 (no hit) when the items module is missing, rather than a throw on every
  // keystroke: a palette that finds nothing is a bad afternoon, a palette that
  // throws inside a keydown handler takes the input with it.
  function matchRank(name, alt, query) {
    const m = itemsModule();
    if (!m) return -1;
    return m.matchRank(name, alt, query);
  }

  // rank, then namespace, then hub-items' own tie-break (base price desc, then
  // the shorter name, then alphabetical - see compareSearch over there for why
  // price is in there at all).
  function compareHits(a, b) {
    if (a._rank !== b._rank) return a._rank - b._rank;
    const at = TYPE_ORDER.indexOf(a.type);
    const bt = TYPE_ORDER.indexOf(b.type);
    if (at !== bt) return at - bt;
    const m = itemsModule();
    if (m && typeof m.compareSearch === 'function') return m.compareSearch(a, b);
    const an = String(a.n || '');
    const bn = String(b.n || '');
    if (an.length !== bn.length) return an.length - bn.length;
    return an < bn ? -1 : (an > bn ? 1 : 0);
  }

  // ==========================================================================
  // PURE: the index
  // ==========================================================================
  // One flat array over all four namespaces. Field names are hub-items'
  // (`n` = name, `s` = the alternate name matched at the same rank, `base` =
  // the price tie-break) precisely so its comparator can be handed these
  // entries unchanged.
  //
  // The entries are FRESH objects, never the ctx.items records themselves:
  // searchAll stamps `_rank` on what it matches, and stamping it on the shared
  // item records would fight the items browser doing the same thing.
  function buildIndex(data) {
    const d = data || {};
    const out = [];

    const items = (d.items && typeof d.items === 'object') ? d.items : {};
    const ids = Object.keys(items);
    for (let i = 0; i < ids.length; i++) {
      const it = items[ids[i]];
      if (!it) continue;
      const n = String(it.n == null ? '' : it.n);
      if (!n) continue;
      const s = String(it.s == null ? '' : it.s);
      out.push({ type: 'item', id: ids[i], n, s, base: Number(it.base) || 0, sub: s });
    }

    const quests = Array.isArray(d.quests) ? d.quests : [];
    for (let i = 0; i < quests.length; i++) {
      const t = quests[i];
      if (!t || !t.id) continue;
      const n = String(t.name == null ? '' : t.name);
      if (!n) continue;
      out.push({
        type: 'quest',
        id: String(t.id),
        n,
        s: String(t.normalizedName == null ? '' : t.normalizedName),
        base: 0,
        sub: String(t.trader == null ? '' : t.trader),
      });
    }

    const traders = Array.isArray(d.traders) ? d.traders : [];
    for (let i = 0; i < traders.length; i++) {
      const t = traders[i];
      if (!t || !t.id) continue;
      const n = String(t.name == null ? '' : t.name);
      if (!n) continue;
      out.push({
        type: 'trader',
        id: String(t.id),
        n,
        s: String(t.normalizedName == null ? '' : t.normalizedName),
        base: 0,
        sub: '',
      });
    }

    const maps = Array.isArray(d.mapsinfo) ? d.mapsinfo : [];
    for (let i = 0; i < maps.length; i++) {
      const m = maps[i];
      if (!m || !m.id) continue;
      const n = String(m.name == null ? '' : m.name);
      if (!n) continue;
      out.push({
        type: 'map',
        id: String(m.id),
        n,
        s: String(m.normalizedName == null ? '' : m.normalizedName),
        base: 0,
        sub: '',
      });
    }

    return out;
  }

  // ==========================================================================
  // PURE: the type chips
  // ==========================================================================
  // An EMPTY list means "every type", not "no types" - the chips start off and
  // the palette searches everything, which is the whole point of it.
  function normalizeTypes(types) {
    const list = Array.isArray(types) ? types : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const t = String(list[i] == null ? '' : list[i]);
      if (!typeDef(t)) continue;
      if (out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  // Returns a NEW list; never mutates the caller's. An unknown id is ignored
  // rather than added, so a stale chip can never filter every hit away.
  function toggleType(types, id) {
    const cur = normalizeTypes(types);
    const t = String(id == null ? '' : id);
    if (!typeDef(t)) return cur;
    const i = cur.indexOf(t);
    if (i === -1) return cur.concat([t]);
    return cur.slice(0, i).concat(cur.slice(i + 1));
  }

  function typeAllowed(type, types) {
    const want = normalizeTypes(types);
    if (!want.length) return true;
    return want.indexOf(String(type == null ? '' : type)) !== -1;
  }

  // ==========================================================================
  // PURE: the search itself
  // ==========================================================================
  // An empty query returns NOTHING, unlike hub-items' searchItems which
  // returns the whole list. A browser with no query showing everything is a
  // browser; a palette with no query showing 5,312 rows is a mistake.
  function searchAll(index, query, opts) {
    const o = opts || {};
    const q = String(query == null ? '' : query).trim();
    if (!q) return [];
    const list = Array.isArray(index) ? index : [];
    const want = normalizeTypes(o.types);
    const limit = (Number.isFinite(o.limit) && o.limit > 0) ? Math.floor(o.limit) : MAX_RESULTS;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e) continue;
      if (want.length && want.indexOf(e.type) === -1) continue;
      const rank = matchRank(e.n, e.s, q);
      if (rank < 0) continue;
      e._rank = rank;
      out.push(e);
    }
    out.sort(compareHits);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  // ==========================================================================
  // PURE: keyboard
  // ==========================================================================
  // Wraps at both ends, and treats "nothing selected" as "before the first
  // row" so the very first Down lands on 0 and the very first Up lands on the
  // last row. Returns -1 for an empty list, which is the only value that ever
  // means "no selection".
  function moveSelection(current, delta, count) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return -1;
    const d = Number(delta) || 0;
    let c = Number(current);
    if (!Number.isFinite(c) || c < 0) c = (d >= 0) ? -1 : 0;
    let next = (c + d) % n;
    if (next < 0) next += n;
    return next;
  }

  // Ctrl+K (Cmd+K too - it costs one clause and this file has no business
  // caring which OS it is on). Alt disqualifies: Ctrl+Alt+K is AltGr+K on a
  // European layout and types a real character.
  function isOpenCombo(evt) {
    if (!evt) return false;
    if (evt.altKey) return false;
    if (!(evt.ctrlKey || evt.metaKey)) return false;
    return String(evt.key == null ? '' : evt.key).toLowerCase() === 'k';
  }

  // What the hint line under the results should say. Pure because it is the
  // one piece of the palette that can quietly lie (claiming "3 matches" while
  // showing a capped 30 is worse than saying nothing).
  function hintFor(state) {
    const s = state || {};
    if (!s.ready) return 'Loading the index...';
    if (!String(s.query == null ? '' : s.query).trim()) {
      return 'Type to search items, quests, traders and maps.';
    }
    const n = Number(s.count) || 0;
    if (!n) return 'No match.';
    const limit = (Number.isFinite(s.limit) && s.limit > 0) ? Math.floor(s.limit) : MAX_RESULTS;
    if (n >= limit) return 'first ' + limit + ' matches - keep typing to narrow it';
    return n + (n === 1 ? ' match' : ' matches');
  }

  // ==========================================================================
  // Everything below touches the DOM and only ever runs inside mount().
  // ==========================================================================
  // Called by hub.js once the wiki data is in. Returns null when the markup is
  // not there (or there is no document at all), so a hub.html that predates
  // this file degrades to "no palette" rather than to a broken window.
  function mount(ctx) {
    if (typeof document === 'undefined' || !ctx) return null;
    const overlay = document.getElementById('hub-palette');
    const input = document.getElementById('palette-input');
    const chipBox = document.getElementById('palette-chips');
    const listEl = document.getElementById('palette-results');
    const hintEl = document.getElementById('palette-hint');
    const openBtn = document.getElementById('palette-open');
    if (!overlay || !input || !listEl || !chipBox || !hintEl) return null;

    const el = ctx.el;
    const clear = ctx.clear;

    let index = null;     // the flat array, built once per session
    let building = null;  // the in-flight build, so two opens share one
    let isOpen = false;
    let types = [];
    let hits = [];
    let sel = -1;
    let lastFocus = null;

    // quests.json and mapsinfo.json are the two slices boot deliberately skips
    // (3 MB and one-route-only respectively). The palette needs both, so the
    // FIRST open pays for them - which is also why the hint line has a
    // "Loading the index..." state at all.
    function ensureIndex() {
      if (index) return Promise.resolve(index);
      if (building) return building;
      building = Promise.all([
        ctx.ensureQuests ? ctx.ensureQuests() : Promise.resolve(null),
        ctx.ensureMaps ? ctx.ensureMaps() : Promise.resolve(null),
      ]).then(() => {
        index = buildIndex({
          items: ctx.items,
          quests: ctx.quests,
          traders: ctx.traders,
          mapsinfo: ctx.mapsinfo,
        });
        building = null;
        return index;
      }).catch((e) => {
        // A slice that would not load must not cost the user the namespaces
        // that ARE in memory: index what we have and say nothing, rather than
        // leaving the palette dead for the rest of the session.
        console.error('hub: search index build failed: ' + (e && e.message ? e.message : e));
        index = buildIndex({ items: ctx.items, traders: ctx.traders });
        building = null;
        return index;
      });
      return building;
    }

    function renderChips() {
      clear(chipBox);
      TYPES.forEach((t) => {
        const on = types.indexOf(t.id) !== -1;
        const b = el('button', 'chip' + (on ? ' on' : ''), t.label);
        b.type = 'button';
        b.addEventListener('click', () => {
          types = toggleType(types, t.id);
          renderChips();
          renderResults();
          input.focus();
        });
        chipBox.appendChild(b);
      });
    }

    function paintSelection() {
      const rows = listEl.children;
      for (let i = 0; i < rows.length; i++) {
        const on = (i === sel);
        rows[i].className = 'palette-row' + (on ? ' on' : '');
        if (on && typeof rows[i].scrollIntoView === 'function') {
          rows[i].scrollIntoView({ block: 'nearest' });
        }
      }
    }

    function renderResults() {
      clear(listEl);
      const q = input.value;
      hits = index ? searchAll(index, q, { types, limit: MAX_RESULTS }) : [];
      sel = hits.length ? 0 : -1;
      hits.forEach((h, i) => {
        // textContent only, everywhere: every one of these strings is synced
        // data and one of them WILL eventually contain a '<'.
        const row = el('div', 'palette-row' + (i === sel ? ' on' : ''));
        row.appendChild(el('span', 'palette-type', labelForType(h.type)));
        row.appendChild(el('span', 'palette-name', h.n));
        if (h.sub) row.appendChild(el('span', 'palette-sub', h.sub));
        row.addEventListener('mouseenter', () => { sel = i; paintSelection(); });
        // mousedown, not click: the input is focused, and letting the browser
        // blur it first has already closed the palette out from under the row.
        row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
        listEl.appendChild(row);
      });
      hintEl.textContent = hintFor({
        ready: !!index, query: q, count: hits.length, limit: MAX_RESULTS,
      });
    }

    function choose(i) {
      const h = hits[i];
      if (!h) return;
      const route = routeForType(h.type);
      if (!route) return;
      close();
      ctx.go(route, h.id);
    }

    function open() {
      // Nothing is loaded before the boot screen clears, so there is nothing
      // to search and no window to put a palette over.
      if (isOpen || !ctx.items) return;
      isOpen = true;
      lastFocus = document.activeElement;
      overlay.classList.remove('hidden');
      renderChips();
      renderResults();
      input.focus();
      input.select();
      ensureIndex().then(() => {
        if (!isOpen) return;
        renderResults();
      });
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      overlay.classList.add('hidden');
      clear(listEl);
      hits = [];
      sel = -1;
      // Put the caret back where it was. Guarded on isConnected because the
      // element that had focus may have been a row in a view the navigation
      // just tore down.
      if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (e) { /* a detached node; nothing to do */ }
      }
      lastFocus = null;
    }

    function toggle() {
      if (isOpen) close();
      else open();
    }

    input.addEventListener('input', renderResults);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        sel = moveSelection(sel, 1, hits.length);
        paintSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        sel = moveSelection(sel, -1, hits.length);
        paintSelection();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        choose(sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    // Clicking the dimmed area closes; clicking the card does not.
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    if (openBtn) openBtn.addEventListener('click', () => { open(); });

    // Capture, on the window: the focus is usually inside SOME input (the
    // items search, a kit number box), and a bubbling listener would only see
    // Ctrl+K after that input had its chance to do something with it.
    window.addEventListener('keydown', (e) => {
      if (isOpenCombo(e)) {
        e.preventDefault();
        toggle();
        return;
      }
      // Escape from anywhere, not just the input - the palette can hold focus
      // on a row after a mouseenter.
      if (isOpen && e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }, true);

    return { open, close, toggle, isOpen: () => isOpen };
  }

  return {
    TYPES,
    TYPE_ORDER,
    MAX_RESULTS,
    typeDef,
    routeForType,
    labelForType,
    matchRank,
    compareHits,
    buildIndex,
    normalizeTypes,
    toggleType,
    typeAllowed,
    searchAll,
    moveSelection,
    isOpenCombo,
    hintFor,
    mount,
  };
}));
