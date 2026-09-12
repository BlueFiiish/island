/* map.js - the Map tab (Lane P3 L9).
 *
 * Owns: the Leaflet CRS.Simple tile map for the three worlds, the pin layers,
 * the filter rail, the tracker-aware pin state, the numbered guide-route
 * overlay, and the two deep links (#map/<world>/pin/<id>, #map/<world>/guide/
 * <slug>). It talks to the rest of the app ONLY through window.ER.
 *
 * ---------------------------------------------------------------------------
 * THE TILE CONVENTION (read this before generating tiles)
 * ---------------------------------------------------------------------------
 * tools/build_tiles.mjs does not exist on disk yet, so this file DEFINES the
 * layout it expects and the tile lane must match it (or change this constant
 * and say so):
 *
 *   <tileBase><z>/<x>/<y>.webp
 *
 *   - z runs 0 .. world.maxZoom. At z == world.maxZoom the world image is at
 *     its native <width> x <height> pixels; each step down halves it.
 *   - tiles are 256 px, cut from the TOP-LEFT corner, x increasing to the
 *     right and y increasing DOWNWARDS (the XYZ convention, NOT TMS). The
 *     Leaflet `tms` option is therefore false, and is not used at all here
 *     because getTileUrl is written by hand.
 *   - the count at level z is ceil(width * 2^(z-maxZoom) / 256) across by
 *     ceil(height * 2^(z-maxZoom) / 256) down. Ragged right/bottom edges are
 *     fine: a missing edge tile resolves to the transparent errorTileUrl.
 *
 * The map coordinate space is the world's own pixel space at native zoom with
 * y pointing DOWN, which is exactly what map-pins.json stores. That is why the
 * CRS below overrides L.CRS.Simple's transformation from (1,0,-1,0) to
 * (1,0,1,0) and its scale to 2^(z - maxZoom): a pin at {x, y} is then simply
 * L.latLng(y, x), with no per-world magic numbers anywhere.
 *
 * ---------------------------------------------------------------------------
 * PATH RULE
 * ---------------------------------------------------------------------------
 * There is exactly ONE tile base per world and it comes from
 * ER.asset(world.tileBase). A bare '/island/apps/elden/map/' is never concatenated at runtime, no
 * deploy URL is hardcoded, and the only image bytes this file names directly
 * are inline SVG data URIs (in map.css) - Leaflet's default icon path is never
 * constructed, because every marker is a divIcon.
 *
 * ---------------------------------------------------------------------------
 * WHY LEAFLET IS LOADED HERE AND NOT BY index.html
 * ---------------------------------------------------------------------------
 * js/leaflet.js is 144 KB of library that only ONE of the five tabs needs, and
 * it is deliberately absent from index.html and from the registry `scripts`
 * list (PLAN section 8: "leaflet.js and saveparse*.js ship via copy"). So this
 * file fetches it the first time the Map tab is actually opened, through
 * ER.asset('js/leaflet.js') - which resolves against the shell's ONE rewritten
 * base, so it is correct standalone and mounted without a '/island/apps/elden/' literal of its
 * own. Four tabs therefore never pay for it, and a failure to load is a named
 * message rather than a blank pane.
 */
(function () {
  'use strict';

  var ER = window.ER;
  if (!ER || typeof ER.registerTab !== 'function') {
    if (window.console && console.error) {
      console.error('map.js: window.ER is not ready; the Map tab was not registered.');
    }
    return;
  }

  // --------------------------------------------------------------------------
  // small helpers (each one degrades safely if the shell has not shipped that
  // part of the API yet, so a half-built app still renders a usable map)
  // --------------------------------------------------------------------------

  function esc(s) {
    if (ER && typeof ER.esc === 'function') return ER.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  function byId(id) {
    if (!id || !ER || typeof ER.byId !== 'function') return null;
    try { return ER.byId(id) || null; } catch (e) { return null; }
  }

  function srcOn(src) {
    if (!ER || typeof ER.srcOn !== 'function') return true;
    try { return !!ER.srcOn(src); } catch (e) { return true; }
  }

  function dlcOn() {
    try { return !!(ER.modes && ER.modes.sote); } catch (e) { return false; }
  }

  function toast(msg) {
    try { if (typeof ER.toast === 'function') ER.toast(msg); } catch (e) { /* no toast host */ }
  }

  function trackerDone(ref) {
    if (!ref) return false;
    try {
      return !!(ER.tracker && typeof ER.tracker.isDone === 'function' && ER.tracker.isDone(ref));
    } catch (e) { return false; }
  }

  // --------------------------------------------------------------------------
  // constants
  // --------------------------------------------------------------------------

  var TAB_ID = 'map';
  var TILE_SIZE = 256;
  var TILE_EXT = '.webp';
  // A 1x1 fully transparent GIF. Ragged pyramid edges and not-yet-generated
  // levels then read as empty ground instead of a broken-image glyph.
  var BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // The filter rail, in display order. `id` is the map-pins `kind`; anything
  // arriving with an unknown kind is bucketed into 'other' so a data surprise
  // shows up on the map rather than vanishing from it.
  var KINDS = [
    { id: 'grace', label: 'Graces' },
    { id: 'boss', label: 'Bosses' },
    { id: 'dungeon', label: 'Dungeons' },
    { id: 'evergaol', label: 'Evergaols' },
    { id: 'quest', label: 'Quest steps' },
    { id: 'guide', label: 'Guide route' },
    { id: 'other', label: 'Other' }
  ];
  var KIND_IDS = KINDS.map(function (k) { return k.id; });

  function kindOf(pin) {
    var k = pin && pin.kind ? String(pin.kind) : '';
    return KIND_IDS.indexOf(k) >= 0 ? k : 'other';
  }

  function kindLabel(id) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].id === id) return KINDS[i].label;
    return 'Other';
  }

  // --------------------------------------------------------------------------
  // module state
  // --------------------------------------------------------------------------

  var root = null;          // the tab's mount element
  var elWorlds = null;      // world chip rail
  var elFilters = null;     // kind chip rail
  var elBanner = null;      // route banner slot
  var elFrame = null;       // bordered frame around the canvas
  var elCanvas = null;      // the Leaflet container
  var elStatus = null;      // the small overlay status line
  var elEmpty = null;       // the "no map data" panel

  var map = null;           // L.Map, recreated on every world switch (the CRS
                            // is per-world and is fixed at construction)
  var tiles = null;
  var layers = {};          // kind -> L.LayerGroup
  var routeLayer = null;
  var markersByPin = {};    // pin id -> L.Marker (current world only)

  var worldId = null;       // the world currently drawn
  var worldBounds = null;   // L.LatLngBounds of the world currently drawn
  var filters = {};         // kind -> bool
  var routeSlug = null;     // active guide route, or null
  var focusId = null;       // pin id to highlight, or null
  var visible = false;
  var mounted = false;
  var trackerBound = false;
  var resizeObs = null;
  var tileLoads = 0;
  var tileErrors = 0;
  var prefsTimer = null;

  // --------------------------------------------------------------------------
  // preferences (nested inside elden_prefs_v1 via ER.prefs - this lane never
  // touches localStorage itself)
  // --------------------------------------------------------------------------

  function readPrefs() {
    var saved = null;
    try {
      if (ER.prefs && typeof ER.prefs.get === 'function') saved = ER.prefs.get('map', null);
    } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};

    var f = (saved.filters && typeof saved.filters === 'object' && !Array.isArray(saved.filters))
      ? saved.filters : {};
    filters = {};
    for (var i = 0; i < KIND_IDS.length; i++) {
      var k = KIND_IDS[i];
      filters[k] = f[k] === undefined ? true : !!f[k];
    }
    return typeof saved.world === 'string' ? saved.world : null;
  }

  function savePrefs() {
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(function () {
      prefsTimer = null;
      try {
        if (ER.prefs && typeof ER.prefs.set === 'function') {
          ER.prefs.set('map', { world: worldId, filters: filters });
        }
      } catch (e) { /* a full or blocked store must never break the map */ }
    }, 300);
  }

  // --------------------------------------------------------------------------
  // data access
  // --------------------------------------------------------------------------

  function manifestWorlds() {
    var m = (ER.data && ER.data.mapManifest) || null;
    return arr(m && m.worlds);
  }

  // A world is hidden when it belongs to the DLC and the DLC toggle is off.
  // The manifest may or may not carry `src`, so the Land of Shadow is also
  // recognised by id - the toggle has to work either way.
  function worldIsSote(w) {
    if (!w) return false;
    if (w.src) return String(w.src) === 'sote';
    return String(w.id) === 'shadow';
  }

  function visibleWorlds() {
    var on = dlcOn();
    return manifestWorlds().filter(function (w) {
      return w && w.id && (on || !worldIsSote(w));
    });
  }

  function worldById(id) {
    var ws = manifestWorlds();
    for (var i = 0; i < ws.length; i++) if (ws[i] && ws[i].id === id) return ws[i];
    return null;
  }

  function allPins() { return arr(ER.data && ER.data.mapPins); }

  function pinById(id) {
    var p = allPins();
    for (var i = 0; i < p.length; i++) if (p[i] && p[i].id === id) return p[i];
    return null;
  }

  // A pin follows the DLC toggle through whichever of the two carries `src`:
  // its own field first, then the record it points at.
  function pinAllowedBySrc(pin) {
    if (pin && pin.src) return srcOn(pin.src);
    var rec = byId(pin && pin.ref);
    if (rec && rec.src) return srcOn(rec.src);
    return true;
  }

  function pinTitle(pin) {
    var rec = byId(pin && pin.ref);
    if (rec && rec.name) return rec.name;
    if (pin && pin.name) return pin.name;
    return (pin && (pin.ref || pin.id)) || 'Marker';
  }

  function guideBySlug(slug) {
    var gs = arr(ER.data && ER.data.guides);
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      if (g && (g.slug === slug || g.id === slug)) return g;
    }
    return null;
  }

  // Route steps, in step order, that actually have a resolvable pin.
  function routeStops(guide) {
    if (!guide) return [];
    var steps = arr(guide.route).slice().sort(function (a, b) {
      return num(a && a.step, 0) - num(b && b.step, 0);
    });
    var out = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var pin = s && s.pin ? pinById(s.pin) : null;
      if (pin) out.push({ step: s, pin: pin, n: out.length + 1 });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // the per-world CRS and tile layer
  // --------------------------------------------------------------------------

  function nativeZoom(world) { return Math.max(0, Math.round(num(world && world.maxZoom, 4))); }

  function crsFor(world) {
    var nz = nativeZoom(world);
    return L.extend({}, L.CRS.Simple, {
      // y-down image space (see the header). L.CRS.Simple ships (1,0,-1,0).
      transformation: new L.Transformation(1, 0, 1, 0),
      // one map unit == one source pixel at z == maxZoom
      scale: function (zoom) { return Math.pow(2, zoom - nz); },
      zoom: function (scale) { return Math.log(scale) / Math.LN2 + nz; },
      infinite: true
    });
  }

  function boundsFor(world) {
    var w = num(world && world.width, 0);
    var h = num(world && world.height, 0);
    return L.latLngBounds(L.latLng(0, 0), L.latLng(h, w));
  }

  // Built the first time it is needed, NOT at script load: this file is
  // parsed before Leaflet is fetched (see the header), so touching L at the
  // top level would throw "L is not defined" and take the whole tab with it.
  var ErTileLayer = null;
  function tileLayerClass() {
    if (ErTileLayer) return ErTileLayer;
    ErTileLayer = L.TileLayer.extend({
      // The ONE place a tile URL is built. options.erBase is already the
      // ER.asset()-resolved, '/island/apps/elden/'-prefixed base for this world.
      getTileUrl: function (coords) {
        return this.options.erBase + coords.z + '/' + coords.x + '/' + coords.y + TILE_EXT;
      },
      // VERIFY-2026-09-04 B3: at the initial (often sub-zero, whole-world)
      // view, GridLayer's own keepBuffer ring computed a full 3x3 tile
      // neighbourhood at z0 - 8 guaranteed 404s on the Map tab's first paint,
      // because the pyramid holds exactly ONE tile there. Leaflet's built-in
      // options.bounds check (still run first, above) is supposed to catch
      // this and evidently does not reliably - rather than chase why, this
      // reads the EXACT per-zoom tile count map-manifest.json's world.grid
      // carries (written by the tile-cutting stage from the real files on
      // disk) and refuses any coordinate outside it. No tile URL for a
      // (z, x, y) missing from the grid is ever requested.
      _isValidTile: function (coords) {
        if (!L.TileLayer.prototype._isValidTile.call(this, coords)) return false;
        var grid = this.options.erGrid;
        if (!grid || !grid.length) return true; // no grid data - fall back to the bounds check above
        var row = null;
        for (var i = 0; i < grid.length; i++) {
          if (grid[i] && grid[i].z === coords.z) { row = grid[i]; break; }
        }
        if (!row) return false; // a zoom level the pyramid never cut is never valid
        return coords.x >= 0 && coords.y >= 0 && coords.x < num(row.nx, 0) && coords.y < num(row.ny, 0);
      }
    });
    return ErTileLayer;
  }

  function assetBase(world) {
    var base = String((world && world.tileBase) || '');
    if (base && base.charAt(base.length - 1) !== '/') base += '/';
    if (ER && typeof ER.asset === 'function') {
      try { return ER.asset(base); } catch (e) { /* fall through */ }
    }
    return base;
  }

  // --------------------------------------------------------------------------
  // markers
  // --------------------------------------------------------------------------

  function pinIconHtml(pin, kind, done, focus) {
    var cls = 'er-pin-wrap' + (done ? ' is-done' : '') + (focus ? ' is-focus' : '');
    /* data-pin makes every marker addressable - by the verifier, and by
       anything that later wants to touch one icon instead of re-rendering. */
    return '<span class="' + cls + '" data-pin="' + esc(pin.id) + '" title="' + esc(pinTitle(pin)) + '">'
      + '<span class="er-pin" data-kind="' + esc(kind) + '"></span>'
      + '<span class="er-pin-check" aria-hidden="true"></span>'
      + '</span>';
  }

  function makeMarker(pin) {
    var kind = kindOf(pin);
    var done = trackerDone(pin.ref);
    var focus = focusId === pin.id;
    var icon = L.divIcon({
      className: 'er-pin-icon',
      html: pinIconHtml(pin, kind, done, focus),
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    var m = L.marker(L.latLng(num(pin.y, 0), num(pin.x, 0)), {
      icon: icon,
      keyboard: true,
      riseOnHover: true,
      alt: pinTitle(pin) + ' - ' + kindLabel(kind)
    });
    m.on('click', function () { openPin(pin); });
    return m;
  }

  // ER.sheet injects opts.icon as RAW HTML (app.js paintSheet), so this must
  // hand back markup - never a bare URL, which would print as text.
  function sheetIconHtml(rec, kind) {
    if (rec && rec.icon && typeof ER.asset === 'function') {
      return '<img class="er-map-sheet-ic" src="' + esc(ER.asset(rec.icon)) + '" alt="" loading="lazy">';
    }
    return '<span class="er-pin er-map-sheet-pin" data-kind="' + esc(kind || 'other') + '"></span>';
  }

  function openPin(pin) {
    var rec = byId(pin && pin.ref);
    if (rec && typeof ER.openEntity === 'function') {
      try { ER.openEntity(pin.ref); return; } catch (e) { /* fall through to the sheet */ }
    }
    openPinSheet(pin);
  }

  // The fallback sheet, for a pin whose ref has no entity page (a quest step
  // is the common case). Deliberately small: what it is, where it is, and the
  // one action the tracker can offer.
  function openPinSheet(pin) {
    if (!ER.sheet || typeof ER.sheet.open !== 'function') {
      toast(pinTitle(pin));
      return;
    }
    var kind = kindOf(pin);
    var w = worldById(pin.world) || {};
    var rec = byId(pin.ref);
    var html = '<div class="er-map-sheet">';
    if (rec && rec.location) html += '<p class="er-map-sheet-loc">' + esc(rec.location) + '</p>';
    html += '<dl>'
      + '<dt>Kind</dt><dd>' + esc(kindLabel(kind)) + '</dd>'
      + '<dt>World</dt><dd>' + esc(w.name || pin.world || 'Unknown') + '</dd>';
    var region = rec && rec.region ? byId(rec.region) : null;
    if (region && region.name) html += '<dt>Region</dt><dd>' + esc(region.name) + '</dd>';
    /* A raw id is a developer's answer, not a reader's - it is only worth
       showing when nothing in the app resolved the marker to a real entry. */
    if (!rec && pin.ref) html += '<dt>Marks</dt><dd>' + esc(pin.ref) + '</dd>';
    html += '</dl></div>';

    var actions = [];
    if (ER.tracker && typeof ER.tracker.toggle === 'function' && pin.ref) {
      actions.push({
        label: trackerDone(pin.ref) ? 'Mark not done' : 'Mark done',
        onClick: function () {
          try { ER.tracker.toggle(pin.ref); } catch (e) { /* tracker refused */ }
          if (ER.sheet && typeof ER.sheet.close === 'function') ER.sheet.close();
          renderPins();
        }
      });
    }
    ER.sheet.open({
      title: pinTitle(pin),
      sub: kindLabel(kind),
      icon: sheetIconHtml(rec, kind),
      html: html,
      actions: actions
    });
  }

  // --------------------------------------------------------------------------
  // rendering
  // --------------------------------------------------------------------------

  function pinsForWorld(id) {
    return allPins().filter(function (p) {
      return p && p.id && p.world === id && pinAllowedBySrc(p);
    });
  }

  function renderPins() {
    if (!map) return;
    markersByPin = {};
    for (var i = 0; i < KIND_IDS.length; i++) {
      var k = KIND_IDS[i];
      var lg = layers[k];
      if (!lg) continue;
      lg.clearLayers();
      if (filters[k]) { if (!map.hasLayer(lg)) lg.addTo(map); }
      else if (map.hasLayer(lg)) map.removeLayer(lg);
    }

    var pins = pinsForWorld(worldId);
    for (var j = 0; j < pins.length; j++) {
      var pin = pins[j];
      var kind = kindOf(pin);
      if (!filters[kind]) continue;
      var m = makeMarker(pin);
      m.addTo(layers[kind]);
      markersByPin[pin.id] = m;
    }
    renderFilterCounts(pins);
  }

  function renderFilterCounts(pins) {
    if (!elFilters) return;
    var counts = {};
    for (var i = 0; i < pins.length; i++) {
      var k = kindOf(pins[i]);
      counts[k] = (counts[k] || 0) + 1;
    }
    var chips = elFilters.querySelectorAll('.er-map-chip');
    for (var c = 0; c < chips.length; c++) {
      var chip = chips[c];
      var id = chip.getAttribute('data-kind');
      var n = counts[id] || 0;
      var slot = chip.querySelector('.er-map-chip-n');
      if (slot) slot.textContent = String(n);
      chip.setAttribute('aria-pressed', filters[id] ? 'true' : 'false');
      chip.style.display = n ? '' : 'none';
    }
  }

  function renderWorldChips() {
    if (!elWorlds) return;
    var ws = visibleWorlds();
    var html = '';
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      var on = w.id === worldId;
      html += '<button type="button" class="er-map-chip" role="tab"'
        + ' data-world="' + esc(w.id) + '"'
        + ' aria-selected="' + (on ? 'true' : 'false') + '">'
        + esc(w.name || w.id) + '</button>';
    }
    elWorlds.innerHTML = html;
    elWorlds.className = 'er-map-rail er-map-rail-worlds' + (dlcOn() ? ' er-map-rail-sote' : '');
  }

  function renderFilterChips() {
    if (!elFilters) return;
    var html = '';
    for (var i = 0; i < KINDS.length; i++) {
      var k = KINDS[i];
      html += '<button type="button" class="er-map-chip" data-kind="' + esc(k.id) + '"'
        + ' aria-pressed="' + (filters[k.id] ? 'true' : 'false') + '">'
        + '<span class="er-map-chip-dot"></span>' + esc(k.label)
        + ' <span class="er-map-chip-n">0</span></button>';
    }
    elFilters.innerHTML = html;
  }

  function setStatus(msg) {
    if (!elStatus) return;
    if (msg) {
      elStatus.textContent = msg;
      elStatus.hidden = false;
    } else {
      elStatus.textContent = '';
      elStatus.hidden = true;
    }
  }

  // --------------------------------------------------------------------------
  // the guide route overlay
  // --------------------------------------------------------------------------

  function clearRoute() {
    routeSlug = null;
    if (routeLayer) routeLayer.clearLayers();
    if (elBanner) elBanner.innerHTML = '';
  }

  function drawRoute(slug) {
    clearRoute();
    var guide = guideBySlug(slug);
    if (!guide) { toast('That build guide has no route yet.'); return; }
    routeSlug = slug;

    var stops = routeStops(guide).filter(function (s) { return s.pin.world === worldId; });
    if (elBanner) {
      elBanner.innerHTML = '<div class="er-route-banner">'
        + '<b>' + esc(guide.name || slug) + '</b>'
        + '<span>' + stops.length + ' mapped ' + (stops.length === 1 ? 'stop' : 'stops') + '</span>'
        + '<button type="button" data-act="clear-route">Clear</button>'
        + '</div>';
    }
    if (!stops.length) {
      setStatus('This route has no stops in ' + ((worldById(worldId) || {}).name || 'this world') + '.');
      return;
    }

    var latlngs = stops.map(function (s) { return L.latLng(num(s.pin.y, 0), num(s.pin.x, 0)); });
    L.polyline(latlngs, {
      className: 'er-route-line',
      color: '#d6a84c',
      weight: 2.5,
      opacity: 0.9,
      dashArray: '7 8',
      interactive: false
    }).addTo(routeLayer);

    for (var i = 0; i < stops.length; i++) {
      (function (stop) {
        var icon = L.divIcon({
          className: 'er-route-icon',
          html: '<span class="er-route-num">' + esc(String(stop.n)) + '</span>',
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });
        var m = L.marker(L.latLng(num(stop.pin.y, 0), num(stop.pin.x, 0)), {
          icon: icon,
          keyboard: true,
          zIndexOffset: 800,
          alt: 'Route step ' + stop.n
        });
        m.on('click', function () { openRouteStep(guide, stop); });
        m.addTo(routeLayer);
      }(stops[i]));
    }

    if (!routeLayer.getLayers().length) return;
    try {
      map.fitBounds(L.latLngBounds(latlngs).pad(0.25), { maxZoom: nativeZoom(worldById(worldId)) });
    } catch (e) { /* a single-stop route can produce a degenerate bounds */ }
    setStatus('');
  }

  function openRouteStep(guide, stop) {
    if (!ER.sheet || typeof ER.sheet.open !== 'function') { openPin(stop.pin); return; }
    var s = stop.step || {};
    var html = '<div class="er-map-sheet">';
    if (s.text) html += '<p class="er-map-sheet-loc">' + esc(s.text) + '</p>';
    html += '<dl>';
    if (s.location) html += '<dt>Where</dt><dd>' + esc(s.location) + '</dd>';
    html += '<dt>Marks</dt><dd>' + esc(pinTitle(stop.pin)) + '</dd>';

    /* Cross-links: everything this step tells you to pick up or kill. Rendered
       as data-entity buttons, which the shell already delegates to
       ER.openEntity - no inline handler, no innerHTML with unescaped data. */
    var picks = arr(s.items).map(byId).filter(Boolean);
    if (picks.length) {
      html += '<dt>Pick up</dt><dd>' + picks.map(function (r) {
        return '<button type="button" class="er-map-link" data-entity="' + esc(r.id) + '">' + esc(r.name) + '</button>';
      }).join(' ') + '</dd>';
    }
    var bossRec = s.boss ? byId(s.boss) : null;
    if (bossRec) {
      html += '<dt>Boss</dt><dd><button type="button" class="er-map-link" data-entity="'
        + esc(bossRec.id) + '">' + esc(bossRec.name) + '</button></dd>';
    }
    html += '</dl></div>';

    var actions = [{
      label: 'Open marker',
      onClick: function () {
        if (ER.sheet && typeof ER.sheet.close === 'function') ER.sheet.close();
        openPin(stop.pin);
      }
    }];
    if (typeof ER.navigate === 'function' && guide && guide.slug) {
      actions.push({
        label: 'Read the guide',
        onClick: function () {
          if (ER.sheet && typeof ER.sheet.close === 'function') ER.sheet.close();
          ER.navigate('builds', [guide.slug]);
        }
      });
    }
    ER.sheet.open({
      title: 'Step ' + stop.n + ' - ' + (guide && guide.name ? guide.name : 'Route'),
      sub: 'Guide route',
      icon: '<span class="er-step-badge">' + esc(String(stop.n)) + '</span>',
      html: html,
      actions: actions
    });
  }

  // --------------------------------------------------------------------------
  // focus
  // --------------------------------------------------------------------------

  function applyFocus(pinId) {
    focusId = pinId || null;
    // repaint the icons so the old highlight is dropped and the new one is on
    renderPins();
    if (!focusId) return;
    var pin = pinById(focusId);
    if (!pin || pin.world !== worldId) return;
    var m = markersByPin[focusId];
    var ll = L.latLng(num(pin.y, 0), num(pin.x, 0));
    var z = Math.max(map.getZoom(), Math.max(0, nativeZoom(worldById(worldId)) - 1));
    try { map.flyTo(ll, z, { duration: 0.6 }); } catch (e) { map.setView(ll, z); }
    if (!m) {
      // its layer is filtered off - say so rather than flying to nothing
      setStatus('That marker is hidden by the ' + kindLabel(kindOf(pin)) + ' filter.');
    }
  }

  // --------------------------------------------------------------------------
  // the Leaflet loader (see the header)
  // --------------------------------------------------------------------------

  var LIB_IDLE = 0, LIB_LOADING = 1, LIB_READY = 2, LIB_FAILED = 3;
  var libState = LIB_IDLE;
  var libWaiters = [];

  function libPresent() {
    return typeof L !== 'undefined' && !!L && typeof L.map === 'function';
  }

  function libSettle(ok) {
    libState = ok ? LIB_READY : LIB_FAILED;
    var waiting = libWaiters;
    libWaiters = [];
    for (var i = 0; i < waiting.length; i++) {
      try { waiting[i](ok); } catch (e) { /* one waiter must not sink the rest */ }
    }
  }

  // cb(ok) - called synchronously when the library is already on the page.
  function ensureLeaflet(cb) {
    if (libPresent()) { libState = LIB_READY; cb(true); return; }
    if (libState === LIB_FAILED) { cb(false); return; }
    libWaiters.push(cb);
    if (libState === LIB_LOADING) return;
    libState = LIB_LOADING;

    var src = (ER && typeof ER.asset === 'function') ? ER.asset('js/leaflet.js') : 'js/leaflet.js';
    // If some later build DOES put the tag in index.html, reuse it rather than
    // evaluating the library twice.
    var existing = null;
    var tags = document.getElementsByTagName('script');
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].src && tags[i].src.indexOf('leaflet.js') >= 0) { existing = tags[i]; break; }
    }
    var s = existing || document.createElement('script');
    function done() { libSettle(libPresent()); }
    function failed() { libSettle(false); }
    s.addEventListener('load', done);
    s.addEventListener('error', failed);
    if (!existing) {
      s.src = src;
      s.async = true;
      s.defer = false;
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function showLibError() {
    destroyMap();
    if (elFrame) elFrame.hidden = true;
    if (elEmpty) {
      elEmpty.hidden = false;
      elEmpty.innerHTML = '<h3>The map could not start</h3>'
        + '<p>The map library did not load, so this tab cannot draw anything. Every other tab is'
        + ' unaffected - reload the app and try again.</p>';
    }
  }

  // --------------------------------------------------------------------------
  // map lifecycle
  // --------------------------------------------------------------------------

  function destroyMap() {
    if (resizeObs) { try { resizeObs.disconnect(); } catch (e) { /* gone */ } resizeObs = null; }
    if (map) { try { map.remove(); } catch (e) { /* already removed */ } }
    map = null;
    tiles = null;
    layers = {};
    routeLayer = null;
    markersByPin = {};
  }

  // How far out the user may zoom. Locking this to the fitBounds result is
  // wrong: the fit is computed against whatever the container measured at
  // build time, and under the shell that can still be mid-reflow. So the floor
  // is derived from the world's own size instead - the point at which the
  // whole world is roughly a thumbnail - and is stable whatever the container
  // is doing.
  function minZoomFloor(world) {
    var nz = nativeZoom(world);
    var span = Math.max(num(world && world.width, TILE_SIZE), num(world && world.height, TILE_SIZE), TILE_SIZE);
    var steps = Math.ceil(Math.log(span / TILE_SIZE) / Math.LN2);
    return nz - steps - 1;
  }

  function buildMap(id) {
    destroyMap();
    var world = worldById(id);
    if (!world) return false;
    /* ensureLeaflet() gates every caller; this is the belt-and-braces check so
       a future direct call can never throw a bare ReferenceError. */
    if (!libPresent()) { showLibError(); return false; }
    worldId = id;

    var nz = nativeZoom(world);
    var floorZ = minZoomFloor(world);
    var bounds = boundsFor(world);
    worldBounds = bounds;

    map = L.map(elCanvas, {
      crs: crsFor(world),
      zoomControl: false,
      attributionControl: false,
      minZoom: floorZ,
      // two levels of over-zoom past the pyramid: Leaflet upscales the native
      // tiles, which is what makes pin-picking on a phone bearable
      maxZoom: nz + 2,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 120,
      maxBounds: bounds.pad(0.2),
      maxBoundsViscosity: 0.8,
      bounceAtZoomLimits: false
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    addResetControl(bounds);

    tileLoads = 0;
    tileErrors = 0;
    tiles = new (tileLayerClass())('', {
      erBase: assetBase(world),
      erGrid: arr(world && world.grid),
      tileSize: TILE_SIZE,
      // one step below the map's own floor: GridLayer drops the whole layer
      // when the (rounded) map zoom falls outside the LAYER's min/max, and it
      // does that check BEFORE clamping to minNativeZoom.
      minZoom: floorZ - 1,
      maxZoom: nz + 2,
      maxNativeZoom: nz,
      minNativeZoom: 0,
      noWrap: true,
      bounds: bounds,
      errorTileUrl: BLANK_TILE,
      keepBuffer: 2,
      updateWhenZooming: false,
      className: 'er-map-tile'
    });
    tiles.on('tileload', function () {
      tileLoads++;
      if (tileLoads === 1) setStatus('');
    });
    tiles.on('tileerror', function () {
      tileErrors++;
      if (tileLoads === 0 && tileErrors >= 3) {
        setStatus('Map imagery for this world has not been generated yet. Pins are still live.');
      }
    });
    tiles.addTo(map);

    for (var i = 0; i < KIND_IDS.length; i++) layers[KIND_IDS[i]] = L.layerGroup();
    routeLayer = L.layerGroup().addTo(map);

    map.fitBounds(bounds);

    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(function () { if (map) map.invalidateSize(); });
      try { resizeObs.observe(elCanvas); } catch (e) { resizeObs = null; }
    }
    return true;
  }

  function addResetControl(bounds) {
    var Reset = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var b = L.DomUtil.create('button', 'er-map-reset');
        b.type = 'button';
        b.textContent = 'Fit';
        b.title = 'Fit the whole world on screen';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', function () {
          if (map) map.fitBounds(bounds);
        });
        return b;
      }
    });
    new Reset().addTo(map);
  }

  // The canvas height is measured, not guessed: --erm-top is the frame's
  // distance from the top of the DOCUMENT, so the CSS can subtract it (plus
  // the tab bar and the safe area) from 100dvh. This is the one number that
  // differs between standalone and the island shell, whose own chrome sits
  // above the app.
  // The scroll offset that has to be added back to a viewport-relative top to
  // get a scroll-INVARIANT one. Standalone that is the window; under the
  // island shell the app can sit inside its own scrolling element, and using
  // pageYOffset there would shrink --erm-top by however far the user had
  // scrolled and stretch the canvas past the bottom of the screen.
  function scrollerOffset(el) {
    var n = el && el.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      var ov;
      try { ov = getComputedStyle(n).overflowY; } catch (e) { ov = ''; }
      if ((ov === 'auto' || ov === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n.scrollTop || 0;
      n = n.parentElement;
    }
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }

  function measureTop() {
    if (!root || !elFrame) return;
    var top = 0;
    try {
      top = elFrame.getBoundingClientRect().top + scrollerOffset(elFrame);
    } catch (e) { top = 0; }
    if (!isFinite(top) || top < 0) top = 0;
    root.style.setProperty('--erm-top', Math.round(top) + 'px');
  }

  function refreshSize() {
    measureTop();
    if (map) {
      map.invalidateSize();
      // the container height just changed under leaflet; a second pass on the
      // next frame catches the reflow the first one measured mid-flight
      window.requestAnimationFrame(function () { if (map) map.invalidateSize(); });
    }
  }

  // --------------------------------------------------------------------------
  // wiring
  // --------------------------------------------------------------------------

  function onRailClick(e) {
    var chip = e.target && e.target.closest ? e.target.closest('.er-map-chip') : null;
    if (!chip || !root.contains(chip)) return;

    var w = chip.getAttribute('data-world');
    if (w) {
      if (w === worldId) return;
      if (typeof ER.navigate === 'function') ER.navigate(TAB_ID, [w]);
      else show([w]);
      return;
    }
    var k = chip.getAttribute('data-kind');
    if (k && filters.hasOwnProperty(k)) {
      filters[k] = !filters[k];
      savePrefs();
      renderPins();
      if (focusId) applyFocus(focusId);
    }
  }

  function onBannerClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-act="clear-route"]') : null;
    if (!b) return;
    if (typeof ER.navigate === 'function') ER.navigate(TAB_ID, [worldId]);
    else { clearRoute(); }
  }

  function bindTracker() {
    if (trackerBound) return;
    if (!ER.tracker || typeof ER.tracker.onChange !== 'function') return;
    try {
      ER.tracker.onChange(function () { if (map) renderPins(); });
      trackerBound = true;
    } catch (e) { /* tracker lane not ready */ }
  }

  // --------------------------------------------------------------------------
  // tab API
  // --------------------------------------------------------------------------

  function mount(el) {
    root = el;
    root.className = (root.className ? root.className + ' ' : '') + 'er-map';
    root.innerHTML =
      '<div class="er-map-railhead">World</div>'
      + '<div class="er-map-rail er-map-rail-worlds" role="tablist"></div>'
      + '<div class="er-map-railhead">Show on the map</div>'
      + '<div class="er-map-rail er-map-rail-filters"></div>'
      + '<hr class="er-map-rule">'
      + '<div class="er-map-banner"></div>'
      + '<div class="er-map-frame">'
      + '<div class="er-map-canvas"></div>'
      + '<div class="er-map-status" hidden></div>'
      + '</div>'
      + '<div class="er-map-empty" hidden>'
      + '<h3>The map is not here yet</h3>'
      + '<p>No world has been published to this build. Everything else in the'
      + ' app works; come back when the map data lands.</p>'
      + '</div>';

    elWorlds = root.querySelector('.er-map-rail-worlds');
    elFilters = root.querySelector('.er-map-rail-filters');
    elBanner = root.querySelector('.er-map-banner');
    elFrame = root.querySelector('.er-map-frame');
    elCanvas = root.querySelector('.er-map-canvas');
    elStatus = root.querySelector('.er-map-status');
    elEmpty = root.querySelector('.er-map-empty');

    readPrefs();
    renderFilterChips();

    root.addEventListener('click', onRailClick);
    root.addEventListener('click', onBannerClick);
    window.addEventListener('resize', refreshSize);
    window.addEventListener('orientationchange', refreshSize);

    if (typeof ER.onModeChange === 'function') {
      try {
        ER.onModeChange(function () {
          renderWorldChips();
          /* worldId is null until the library has loaded and showNow() has
             drawn something. The shell fires every mode callback immediately
             AFTER route(), so without this guard a cold
             #map/<world>/pin/<id> deep link is navigated away to #map/<world>
             before it is ever honoured - the params are simply lost. */
          if (!visible || !worldId) return;
          var ws = visibleWorlds();
          var stillThere = ws.some(function (w) { return w.id === worldId; });
          if (!stillThere && ws.length) {
            /* the world the user was on just went away with the DLC; any pin
               or route params belonged to it, so they go too */
            if (typeof ER.navigate === 'function') ER.navigate(TAB_ID, [ws[0].id]);
            else show([ws[0].id]);
          } else {
            renderPins();
          }
        });
      } catch (e) { /* no mode host */ }
    }
    bindTracker();
    mounted = true;
  }

  var pendingParams = [];

  function show(params) {
    visible = true;
    bindTracker();
    pendingParams = arr(params);
    if (!libPresent()) setStatus('Loading the map...');
    ensureLeaflet(function (ok) {
      if (!visible) return; /* the user moved on while the library loaded */
      if (!ok) { showLibError(); return; }
      setStatus('');
      showNow(pendingParams);
    });
  }

  function showNow(params) {
    params = arr(params);

    var ws = visibleWorlds();
    if (!ws.length) {
      destroyMap();
      if (elFrame) elFrame.hidden = true;
      if (elEmpty) elEmpty.hidden = false;
      if (elWorlds) elWorlds.innerHTML = '';
      renderFilterCounts([]);
      return;
    }
    if (elFrame) elFrame.hidden = false;
    if (elEmpty) elEmpty.hidden = true;

    var wanted = params[0] || null;
    var savedWorld = null;
    try {
      var sp = (ER.prefs && typeof ER.prefs.get === 'function') ? ER.prefs.get('map', null) : null;
      savedWorld = sp && typeof sp.world === 'string' ? sp.world : null;
    } catch (e) { savedWorld = null; }

    var target = null;
    var asked = false;
    if (wanted) {
      asked = true;
      for (var i = 0; i < ws.length; i++) if (ws[i].id === wanted) target = ws[i].id;
    }
    if (!target && savedWorld) {
      for (var j = 0; j < ws.length; j++) if (ws[j].id === savedWorld) target = ws[j].id;
    }
    if (!target) target = ws[0].id;
    if (asked && wanted !== target) {
      toast(worldById(wanted) ? 'The Land of Shadow is hidden while the DLC toggle is off.'
        : 'That world is not in this build.');
    }

    var rebuilt = false;
    if (!map || worldId !== target) {
      rebuilt = buildMap(target);
      if (!rebuilt) { setStatus('This world could not be opened.'); return; }
      savePrefs();
    }
    renderWorldChips();
    refreshSize();
    if (rebuilt && worldBounds) {
      // refreshSize just gave the canvas its measured height; the fit computed
      // against the pre-measure box would leave the world cropped.
      try { map.fitBounds(worldBounds); } catch (e) { /* degenerate bounds */ }
    }

    var mode = params[1] ? String(params[1]) : '';
    var argRaw = params[2] ? String(params[2]) : '';
    var arg = '';
    try { arg = decodeURIComponent(argRaw); } catch (e) { arg = argRaw; }

    if (mode === 'guide' && arg) {
      focusId = null;
      renderPins();
      drawRoute(arg);
    } else if (mode === 'pin' && arg) {
      clearRoute();
      applyFocus(arg);
      if (!pinById(arg)) setStatus('No marker with that id is in this build.');
    } else {
      clearRoute();
      applyFocus(null);
    }
  }

  function hide() {
    visible = false;
  }

  // The shell aggregates this into the header search on every tab. Pins first
  // (they are what the Map tab can actually do something with), then the build
  // guides that have a mapped route.
  function search(q) {
    var needle = String(q == null ? '' : q).trim().toLowerCase();
    if (needle.length < 2) return [];
    var out = [];
    var ws = visibleWorlds();
    var wname = {};
    for (var i = 0; i < ws.length; i++) wname[ws[i].id] = ws[i].name || ws[i].id;

    var pins = allPins();
    for (var p = 0; p < pins.length && out.length < 8; p++) {
      var pin = pins[p];
      if (!pin || !pin.id || !wname[pin.world] || !pinAllowedBySrc(pin)) continue;
      var kind = kindOf(pin);
      var title = pinTitle(pin);
      var hay = (title + ' ' + kindLabel(kind) + ' ' + wname[pin.world]).toLowerCase();
      if (hay.indexOf(needle) < 0) continue;
      out.push({
        title: title,
        sub: 'Map - ' + kindLabel(kind) + ', ' + wname[pin.world],
        icon: '\u{1F5FA}',
        go: (function (pp) {
          return function () {
            if (typeof ER.navigate === 'function') ER.navigate(TAB_ID, [pp.world, 'pin', pp.id]);
          };
        }(pin))
      });
    }

    var guides = arr(ER.data && ER.data.guides);
    for (var g = 0; g < guides.length && out.length < 12; g++) {
      var guide = guides[g];
      if (!guide || !guide.slug || !srcOn(guide.src)) continue;
      if (String(guide.name || '').toLowerCase().indexOf(needle) < 0) continue;
      var stops = routeStops(guide);
      if (!stops.length) continue;
      out.push({
        title: guide.name + ' - route',
        sub: 'Map - ' + stops.length + ' mapped stops',
        icon: '\u{1F5FA}',
        go: (function (gg, first) {
          return function () {
            if (typeof ER.navigate === 'function') ER.navigate(TAB_ID, [first.pin.world, 'guide', gg.slug]);
          };
        }(guide, stops[0]))
      });
    }
    return out;
  }

  ER.registerTab(TAB_ID, {
    label: 'Map',
    icon: '\u{1F5FA}',
    order: 50,
    mount: mount,
    show: show,
    hide: hide,
    search: search
  });

  // --------------------------------------------------------------------------
  // the cross-lane API (Builds "Show route on Map", Wiki "Show on the map")
  // --------------------------------------------------------------------------

  ER.mapApi = {
    showRoute: function (guideSlug) {
      var guide = guideBySlug(guideSlug);
      var stops = routeStops(guide);
      if (!guide) { toast('That guide is not in this build.'); return false; }
      if (!stops.length) { toast('That guide has no mapped route yet.'); return false; }
      var w = stops[0].pin.world;
      if (typeof ER.navigate === 'function') ER.navigate(TAB_ID, [w, 'guide', guide.slug]);
      return true;
    },
    focusPin: function (pinId) {
      var pin = pinById(pinId);
      if (!pin) { toast('That marker is not on the map.'); return false; }
      if (typeof ER.navigate === 'function') ER.navigate(TAB_ID, [pin.world, 'pin', pin.id]);
      return true;
    }
  };

  // Not part of the public API - the browser-driving verifier reads this to
  // assert the tile URL math without screen-scraping leaflet's internals.
  ER.mapApi._debug = function () {
    return {
      world: worldId,
      params: pendingParams,
      guides: arr(ER.data && ER.data.guides).length,
      zoom: map ? map.getZoom() : null,
      tileBase: tiles ? tiles.options.erBase : null,
      sampleTileUrl: (tiles && map)
        ? tiles.getTileUrl({ z: nativeZoom(worldById(worldId)), x: 0, y: 0 })
        : null,
      pins: Object.keys(markersByPin).length,
      route: routeSlug,
      focus: focusId,
      filters: filters,
      tileLoads: tileLoads,
      tileErrors: tileErrors,
      mounted: mounted
    };
  };
}());
