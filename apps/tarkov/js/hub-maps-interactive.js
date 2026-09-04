// Pilot Hub - the INTERACTIVE map view.
//
// This is the overlay's Leaflet map (src/renderer/app.js) ported to run inside
// the hub's Maps pane, over the plain hubAPI contract and NOTHING else.
//
// WHAT IS THE SAME as the overlay, deliberately, so it reads as the same map:
//   - the tarkov.dev projection (applyRotation / getCRS / the [z, x] latlng
//     convention), copied line for line from app.js
//   - the SVG basemap as an L.svgOverlay over the map's svgBounds
//   - the floor dropdown built off the SVG's own layer ids, and PilotFloors'
//     bounded-extent rule for dimming markers on another level
//   - drawStaticMarkers: the same layers, the same class names, the same
//     colours (the CSS is ported into tarkov-map.css from style.css)
//   - the filter panel: the same sections, the same toggles, the same per-
//     section "only" isolate button, the same loose-loot search
//
// WHAT IS DELIBERATELY GONE: everything that needs the desktop app. There is
// no trail, no squad, no hotkeys, no OCR. Those are the Electron product's edge
// and they are the one thing this view must never pretend to have. So there is
// not a single window.pilot reference in this file - it reads ctx.loadJson /
// ctx.loadText, which the host (Electron ipc or the web adapter's fetch)
// answers identically.
//
// WHAT THE LIVE LINK ADDS BACK, and only while it is up: the player dot, the
// nav arrow and the pings, all of them MIRRORS. This view never owns any of
// that state - it renders what PilotLive last heard and asks the app to change
// it, so the overlay and the browser can never disagree about what is pinned.
//
// HOST REQUIREMENTS, both feature-detected by the caller (hub-maps.js):
//   globalThis.L                  - Leaflet 1.9.x
//   globalThis.PilotFloors        - optional; without it nothing is dimmed
// The Electron hub window loads neither, so this whole view is web-only there
// and hub-maps.js simply never offers it.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubMapsInteractive = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==========================================================================
  // PURE: nothing below this line touches the DOM, Leaflet or storage.
  // ==========================================================================

  // Marker labels are synced strings from tarkov.dev / the game locale and go
  // into a divIcon's html, so they are escaped rather than trusted - the same
  // rule (and the same function) as app.js.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Copied from app.js's DEFAULT_FILTERS. Same keys, same defaults, so a player
  // who uses both sees the same map with the same things on it.
  const DEFAULT_FILTERS = {
    landmarks: true,
    extractsPmc: true,
    extractsScav: false,
    extractsShared: true,
    quests: true,
    questsMineOnly: true,
    bosses: false,
    spawnsPmc: false,
    spawnsScav: false,
    locks: false,
    hazards: false,
    transits: false,
    containers: {},
    lootItem: '',
  };

  // Every filter key that switches a whole marker CATEGORY on. questsMineOnly
  // is absent on purpose: it modifies the quest layer rather than being one.
  const MARKER_FILTER_KEYS = [
    'landmarks',
    'extractsPmc', 'extractsScav', 'extractsShared',
    'quests',
    'bosses', 'spawnsPmc', 'spawnsScav', 'locks', 'hazards', 'transits',
  ];

  // The overlay's appearance pack, minus everything that only means something
  // to a transparent click-through window (opacity, background mode).
  const DEFAULT_APPEARANCE = {
    markerScale: 1,
    labelScale: 1,
    alwaysShowExtracts: false,
    dimOffFloor: true,
  };
  const SCALE_STEPS = [['S', 0.8], ['M', 1], ['L', 1.3]];

  function normalizeFilters(saved) {
    const s = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
    const out = { ...DEFAULT_FILTERS, ...s };
    // containers is a map, not a boolean, and a junk value here would make
    // Object.entries throw inside drawStaticMarkers
    out.containers = (s.containers && typeof s.containers === 'object' && !Array.isArray(s.containers))
      ? { ...s.containers } : {};
    out.lootItem = typeof s.lootItem === 'string' ? s.lootItem : '';
    for (const k of MARKER_FILTER_KEYS) out[k] = !!out[k];
    out.questsMineOnly = !!out.questsMineOnly;
    return out;
  }

  function normalizeAppearance(saved) {
    const s = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
    const scale = (v, d) => {
      const n = Number(v);
      return (Number.isFinite(n) && n >= 0.5 && n <= 2) ? n : d;
    };
    return {
      markerScale: scale(s.markerScale, 1),
      labelScale: scale(s.labelScale, 1),
      alwaysShowExtracts: !!s.alwaysShowExtracts,
      dimOffFloor: s.dimOffFloor === undefined ? true : !!s.dimOffFloor,
    };
  }

  // maps.json is tarkov.dev's calibration index: groups keyed by normalizedName,
  // each holding several projections. Only an 'interactive' one with an svgPath
  // can be drawn - the tile projections need tarkov.dev's tile server, which is
  // exactly the off-origin fetch this build does not make.
  //
  // Byte-for-byte the same lookup app.js does, including the key fallback.
  function findMapEntry(index, normalizedName) {
    if (!Array.isArray(index)) return null;
    for (const group of index) {
      if (!group || group.normalizedName !== normalizedName) continue;
      const entry = (group.maps || []).find((m) => m && m.projection === 'interactive' && m.svgPath);
      if (entry) return entry;
    }
    for (const group of index) {
      if (!group) continue;
      const entry = (group.maps || []).find((m) => m && m.key === normalizedName && m.svgPath);
      if (entry) return entry;
    }
    return null;
  }

  // 'https://assets.tarkov.dev/maps/svg/Customs.svg' -> 'svg/Customs.svg', or
  // null when the tail is not a plain one-segment name the read-data allowlist
  // would accept anyway. Returning null here rather than letting a bad name
  // reach readData keeps the failure at the place that can explain it.
  function svgNameFor(entry) {
    const p = entry && entry.svgPath;
    if (!p || typeof p !== 'string') return null;
    const file = p.split('/').pop();
    if (!file || !/^[A-Za-z0-9_-]{1,64}\.svg$/.test(file)) return null;
    return 'svg/' + file;
  }

  // data/loot/<normalizedName>.json. Same shape rule.
  function lootNameFor(mapId) {
    const s = String(mapId == null ? '' : mapId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
    return 'loot/' + s + '.json';
  }

  function prettyName(n) {
    return String(n == null ? '' : n).replace(/-/g, ' ');
  }

  // ---- tarkov.dev projection (ported from app.js; MIT, tarkov-dev) ----
  // L is passed in rather than read off a global so these stay unit-testable.
  function applyRotation(L, latLng, rotation) {
    if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
    if (!rotation) return latLng;
    const r = (rotation * Math.PI) / 180;
    const x = latLng.lng;
    const y = latLng.lat;
    return L.latLng(x * Math.sin(r) + y * Math.cos(r), x * Math.cos(r) - y * Math.sin(r));
  }

  function getCRS(L, md) {
    let scaleX = 1;
    let scaleY = 1;
    let marginX = 0;
    let marginY = 0;
    if (md && md.transform) {
      scaleX = md.transform[0];
      scaleY = md.transform[2] * -1;
      marginX = md.transform[1];
      marginY = md.transform[3];
    }
    const rot = (md && md.coordinateRotation) || 0;
    return L.extend({}, L.CRS.Simple, {
      transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
      projection: L.extend({}, L.Projection.LonLat, {
        project: (latLng) => L.Projection.LonLat.project(applyRotation(L, latLng, rot)),
        unproject: (point) => applyRotation(L, L.Projection.LonLat.unproject(point), rot * -1),
      }),
    });
  }

  // game {x, z} -> leaflet [lat, lng]. The whole file depends on this one
  // inversion being in exactly one place.
  const gameLatLng = (p) => [p.z, p.x];

  function boundsOf(L, b) {
    if (!b || !b[0] || !b[1]) return undefined;
    return L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]);
  }

  // Faction bucketing, matching app.js's wantExtract: anything that is not
  // explicitly scav or shared counts as PMC.
  function extractBucket(faction) {
    const f = String(faction == null ? '' : faction).toLowerCase();
    if (f === 'scav') return 'scav';
    if (f === 'shared') return 'shared';
    return 'pmc';
  }

  // ==========================================================================
  // Storage. Per-map filters + a global appearance pack, the same split the
  // desktop app makes (mapFilters is per map, appearance is not). Best-effort
  // in both directions: a browser with site data blocked throws on read AND on
  // write, and a map that will not remember its filters is far better than a
  // map that refuses to open.
  // ==========================================================================
  const FILTERS_KEY = 'island.tarkov.mapfilters.v1';
  const APPEARANCE_KEY = 'island.tarkov.mapappearance.v1';

  function readStore(key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeStore(key, value) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* private mode / quota / blocked: forget instead of failing */ }
  }

  // ==========================================================================
  // Host. Everything below touches Leaflet and the DOM.
  // ==========================================================================

  // The two globals this view cannot be built without. hub-maps.js asks BEFORE
  // it offers the affordance, so a host without Leaflet (the Electron hub
  // window) never grows a button that would not work.
  function available() {
    return typeof globalThis !== 'undefined' && !!globalThis.L;
  }

  // maps.json, parsed once and cached by the hub's own loadJson.
  function loadIndex(ctx) {
    return ctx.loadJson('maps.json').then((doc) => (Array.isArray(doc) ? doc : []));
  }

  // "Does this map have an interactive projection at all?" - answered before
  // the button is drawn so a map with no calibration (the Lab, Labyrinth,
  // Icebreaker) shows nothing rather than a button that opens an error.
  function supports(ctx, normalizedName) {
    if (!available()) return Promise.resolve(false);
    return loadIndex(ctx)
      .then((index) => !!(findMapEntry(index, normalizedName) && svgNameFor(findMapEntry(index, normalizedName))))
      .catch(() => false);
  }

  /**
   * Mount the interactive map into `mount`.
   *
   * @param {object} opts
   *   ctx           the hub view context (loadJson / loadText / el / clear / questState)
   *   mount         the element to fill; it is emptied first
   *   mapId         normalizedName, e.g. 'customs'
   *   mapName       display name for the header
   *   onClose       called when the back control is used
   * @returns {{ destroy: function }} - ALWAYS returns, even on a data failure,
   *   so the caller has exactly one teardown path.
   */
  function open(opts) {
    const o = opts || {};
    const ctx = o.ctx;
    const mount = o.mount;
    const mapId = String(o.mapId == null ? '' : o.mapId);
    const L = globalThis.L;
    const Floors = globalThis.PilotFloors || null;

    const el = ctx.el;
    const clear = ctx.clear;

    // ---- state ----
    let map = null;
    let mapData = null;
    let markers = null;      // markers.json[mapId]
    let svgLayerEl = null;
    let svgRootEl = null;
    let floorList = [];      // [{ name, svgLayer }] that actually exist in the SVG
    let currentFloor = null;
    let staticLayers = [];
    let lootItems = null;
    let lootData = null;
    let destroyed = false;
    let resizeObs = null;

    // ---- Pilot live link (WEB ONLY, feature-detected exactly like Leaflet) --
    // globalThis.PilotLive is installed by hub-pilot-connect.js, which only the
    // island page loads. In Electron - and on the web with nothing connected -
    // every line guarded by Live() is a no-op and this view is byte-for-byte
    // the map it has always been.
    let liveUnsub = null;
    let playerMarker = null;   // the triangle dot, same divIcon as the overlay's
    let navMarker = null;      // where the overlay's arrow is currently pointed
    let navPopup = null;       // the map-click bubble ("ping here" / "navigate here")
    // id -> { marker, sig, ping }. Keyed, not a layer group, so a `pings` frame
    // that changes one ping does not rebuild the other five and shut the popup
    // the user is reading. Purely a CACHE of the last frame: never written to
    // by a click, only by drawPings().
    const pingMarkers = new Map();
    let followPlayer = false;
    let companion = false;
    let escHandler = null;
    let toastEl = null;
    let toastTimer = null;
    let refreshLiveChrome = null;  // set by buildLiveChrome once the head exists
    let refreshLivePanel = null;   // set by buildPanel when the pilot section is up

    function Live() {
      const lv = (typeof globalThis !== 'undefined') ? globalThis.PilotLive : null;
      return (lv && typeof lv.subscribe === 'function') ? lv : null;
    }
    function liveOn() {
      const lv = Live();
      return !!(lv && lv.connected());
    }

    let filters = normalizeFilters((readStore(FILTERS_KEY) || {})[mapId]);
    let appearance = normalizeAppearance(readStore(APPEARANCE_KEY));

    function persistFilters() {
      const all = readStore(FILTERS_KEY) || {};
      all[mapId] = filters;
      writeStore(FILTERS_KEY, all);
    }

    function persistAppearance() {
      writeStore(APPEARANCE_KEY, appearance);
    }

    // ---- chrome ----
    clear(mount);
    const view = el('div', 'imap-view');
    const head = el('div', 'imap-head');
    const back = el('button', 'imap-back', 'Back to map');
    back.type = 'button';
    back.title = 'Close the interactive map';
    back.addEventListener('click', () => { if (typeof o.onClose === 'function') o.onClose(); });
    head.appendChild(back);
    head.appendChild(el('div', 'imap-title', o.mapName || prettyName(mapId)));

    const floorSel = document.createElement('select');
    floorSel.className = 'imap-floor hidden';
    floorSel.title = 'Which floor of the map to show';
    head.appendChild(floorSel);

    // Live-link chip: the one place in the map chrome that says whether the
    // desktop app is driving this view, and the resume affordance for a
    // map-follow the user paused by browsing. Empty and hidden without a link.
    const liveChip = el('div', 'imap-live hidden');
    const liveDot = el('span', 'imap-live-dot');
    const liveText = el('span', 'imap-live-text', '');
    const liveResume = el('button', 'imap-live-resume hidden', 'resume follow');
    liveResume.type = 'button';
    liveResume.title = 'Follow the map the Pilot says you are on again';
    liveChip.appendChild(liveDot);
    liveChip.appendChild(liveText);
    liveChip.appendChild(liveResume);
    head.appendChild(liveChip);

    // Companion mode: the map fills the screen for a second monitor. Works with
    // or without the link - unlinked it is simply a big map.
    const companionBtn = el('button', 'imap-companion', 'Companion mode');
    companionBtn.type = 'button';
    companionBtn.title = 'Fill the screen with the map (Esc to exit)';
    head.appendChild(companionBtn);

    const status = el('div', 'imap-status', 'Loading map data...');
    head.appendChild(status);
    view.appendChild(head);

    const body = el('div', 'imap-body');
    const canvas = el('div', 'imap-canvas');
    const panel = el('aside', 'imap-panel');
    body.appendChild(canvas);
    body.appendChild(panel);
    view.appendChild(body);

    // Transient one-line messages (a nav target accepted, a 409 map mismatch, a
    // follow paused). A toast rather than the status line because the status
    // line is the map's own load state and must not be overwritten by a click.
    toastEl = el('div', 'imap-toast hidden');
    view.appendChild(toastEl);
    mount.appendChild(view);

    function toast(msg, bad) {
      if (!toastEl) return;
      toastEl.textContent = String(msg == null ? '' : msg);
      toastEl.classList.toggle('bad', !!bad);
      toastEl.classList.remove('hidden');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = null;
        if (toastEl) toastEl.classList.add('hidden');
      }, bad ? 6000 : 3200);
    }

    // ---- companion mode ----
    // A body class, not a new page: the map is already a self-contained pane,
    // so filling the screen is a CSS state (see tarkov-map.css) and every
    // control keeps working. Deliberately independent of the live link - a
    // second monitor showing a big static map is useful on its own.
    function setCompanion(on) {
      companion = !!on;
      try { document.body.classList.toggle('tk-companion', companion); } catch (e) { /* no body yet */ }
      view.classList.toggle('companion', companion);
      companionBtn.textContent = companion ? 'Exit companion' : 'Companion mode';
      companionBtn.classList.toggle('on', companion);
      if (companion && !escHandler) {
        escHandler = (e) => { if (e && e.key === 'Escape') setCompanion(false); };
        document.addEventListener('keydown', escHandler);
      } else if (!companion && escHandler) {
        document.removeEventListener('keydown', escHandler);
        escHandler = null;
      }
      // On a second monitor the point IS the player dot, so a user who has
      // never expressed a preference gets follow ON here and OFF in the pane.
      const lv = Live();
      if (companion && lv && lv.pref('followPlayer') === null) setFollowPlayer(true, false);
      // leaflet cached the container size before the class changed
      setTimeout(() => {
        if (destroyed || !map) return;
        map.invalidateSize();
        if (followPlayer) snapToPlayer();
      }, 60);
      if (refreshLivePanel) refreshLivePanel();
    }
    companionBtn.addEventListener('click', () => setCompanion(!companion));

    function applyAppearance() {
      view.style.setProperty('--marker-scale', String(appearance.markerScale));
      view.style.setProperty('--label-scale', String(appearance.labelScale));
    }
    applyAppearance();

    // Marker geometry is computed in JS from the scale, NOT in CSS: scaling an
    // anchored divIcon in CSS leaves leaflet's iconAnchor at the unscaled value
    // and slides every dot off the point it marks. Same rule, same comment, as
    // app.js's markerPx.
    const markerPx = (base) => Math.round(base * (Number(appearance.markerScale) || 1));

    function setStatus(text, cls) {
      status.textContent = text || '';
      status.className = 'imap-status' + (cls ? ' ' + cls : '');
    }

    // ---- floors ----
    // '' when the marker is on this floor, ' off-floor' when a BOUNDED layer
    // extent proves it is on another one. Without PilotFloors nothing is ever
    // dimmed, which is the safe direction (see floors.js).
    function offFloorClass(position) {
      if (!appearance.dimOffFloor || !Floors) return '';
      return Floors.isOffFloor(mapData, currentFloor, position) ? ' off-floor' : '';
    }

    function buildFloorSelect() {
      floorSel.innerHTML = '';
      currentFloor = (mapData && mapData.svgLayer) || null;
      const layers = [{ name: 'Base', svgLayer: mapData && mapData.svgLayer }]
        .concat((mapData && mapData.layers) || []);
      floorList = layers.filter((l) => l && l.svgLayer && svgRootEl && svgRootEl.getElementById(l.svgLayer));
      if (floorList.length <= 1) { floorSel.classList.add('hidden'); return; }
      floorSel.classList.remove('hidden');
      floorList.forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l.svgLayer;
        opt.textContent = l.name || l.svgLayer;
        floorSel.appendChild(opt);
      });
      floorSel.value = mapData.svgLayer;
      applyFloor(mapData.svgLayer, false);
      floorSel.onchange = () => applyFloor(floorSel.value, true);
    }

    function applyFloor(layerId, redraw) {
      currentFloor = layerId;
      // markers carry the off-floor class, so a floor change has to redraw them
      if (redraw && map) drawStaticMarkers();
      if (!svgRootEl) return;
      floorList.forEach((l) => {
        const node = svgRootEl.getElementById(l.svgLayer);
        if (!node) return;
        const on = l.svgLayer === layerId || l.svgLayer === mapData.svgLayer;
        node.style.display = on ? '' : 'none';
      });
    }

    // ---- markers ----
    // A click opens a leaflet popup built from DOM nodes, never an HTML string:
    // the same "one of these names will eventually contain a '<'" rule the rest
    // of the hub follows. In the overlay a click retargets the nav HUD, which
    // needs a live player position and therefore cannot exist here.
    // The popup content is built by a FUNCTION rather than up front, because
    // the "Navigate here" action only exists while the Pilot link is up and the
    // link can come and go long after the markers were drawn. Leaflet calls it
    // at open time, so the bubble is always right without redrawing the map.
    function popContent(title, detail, position) {
      const box = el('div', 'imap-pop');
      box.appendChild(el('div', 'imap-pop-title', title || ''));
      if (detail && detail !== title) box.appendChild(el('div', 'imap-pop-body', detail));
      if (position && liveOn()) {
        // Ping first: it is the cheap, additive, many-at-once action, and a
        // marker's own name is the best label a ping will ever get.
        const p = el('button', 'imap-ping-btn', 'Drop a ping here');
        p.type = 'button';
        p.title = 'Pin this spot on the Pilot overlay and every view of this map';
        p.addEventListener('click', () => sendPing(position, title || ''));
        box.appendChild(p);
        const b = el('button', 'imap-nav-btn', 'Navigate here');
        b.type = 'button';
        b.title = 'Point the Pilot overlay\'s nav arrow at this spot';
        b.addEventListener('click', () => sendNav(position, title || 'map pin'));
        box.appendChild(b);
      }
      return box;
    }

    function bindLabel(marker, title, detail, position) {
      marker.bindPopup(() => popContent(title, detail, position), { closeButton: true, autoPan: true });
    }

    function labelMarker(layer, position, cls, text, detail, dimmable) {
      const icon = L.divIcon({
        className: 'lbl-marker' + (dimmable === false ? '' : offFloorClass(position)),
        html: '<div class="' + cls + '">' + escapeHtml(text) + '</div>',
        iconAnchor: [0, 8],
      });
      const m = L.marker(gameLatLng(position), { icon }).addTo(layer);
      bindLabel(m, text, detail, position);
      return m;
    }

    function dotMarker(layer, position, cls, title, baseSize) {
      const s = markerPx(baseSize || 8);
      const icon = L.divIcon({
        className: 'dot-marker' + offFloorClass(position),
        html: '<div class="' + cls + '" title="' + escapeHtml(title || '') + '"></div>',
        iconSize: [s, s],
        iconAnchor: [s / 2, s / 2],
      });
      const m = L.marker(gameLatLng(position), { icon }).addTo(layer);
      if (title) bindLabel(m, title, null, position);
      return m;
    }

    // A quest marker is "mine" when the task is currently accepted. A marker
    // whose task id is unknown is KEPT, not hidden - better a marker you might
    // not need than a missing objective. (app.js's isMyQuest, over ctx's quest
    // state instead of the log watcher's.)
    function isMyQuest(q) {
      if (!q || !q.taskId) return true;
      const st = (ctx.questState || {})[q.taskId];
      return !!(st && st.status === 'started');
    }

    function questsForMap() {
      if (!markers) return [];
      const list = filters.questsMineOnly
        ? (markers.quests || []).filter(isMyQuest)
        : (markers.quests || []);
      return list;
    }

    function drawStaticMarkers() {
      if (!map) return;
      staticLayers.forEach((l) => l.remove());
      staticLayers = [];
      const layer = () => { const g = L.layerGroup().addTo(map); staticLayers.push(g); return g; };

      // Landmarks come from the calibration entry itself, not markers.json, so
      // they render even on a map with no marker data at all.
      if (filters.landmarks && mapData && mapData.labels && mapData.labels.length) {
        const lm = layer();
        (mapData.labels || []).forEach((lb) => {
          if (!lb || !Array.isArray(lb.position) || lb.position.length < 2 || !lb.text) return;
          const icon = L.divIcon({
            className: 'lbl-marker',
            html: '<div class="landmark">' + escapeHtml(lb.text) + '</div>',
            iconAnchor: [0, 6],
          });
          L.marker([lb.position[1], lb.position[0]], { icon, interactive: false }).addTo(lm);
        });
      }

      if (!markers) return;

      // extracts, split by faction so each is its own toggle. "always show
      // extracts" overrides all three, so isolating another category with an
      // "only" button never loses your way out of the map.
      const wantExtract = (ex) => {
        if (appearance.alwaysShowExtracts) return true;
        const b = extractBucket(ex.faction);
        if (b === 'scav') return filters.extractsScav;
        if (b === 'shared') return filters.extractsShared;
        return filters.extractsPmc;
      };
      const exLayer = layer();
      (markers.extracts || []).forEach((ex) => {
        if (!ex || !ex.position || !wantExtract(ex)) return;
        // a pinned extract is exempt from the off-floor fade too: the point of
        // the pin is that your way out stays legible no matter what
        labelMarker(exLayer, ex.position,
          'ex ' + (extractBucket(ex.faction) === 'scav' ? 'scav' : ''),
          ex.name, 'EXTRACT: ' + (ex.name || ''), !appearance.alwaysShowExtracts);
      });

      if (filters.quests) {
        const qLayer = layer();
        questsForMap().forEach((q) => {
          if (!q || !q.position) return;
          labelMarker(qLayer, q.position, 'qm' + (isMyQuest(q) ? ' mine' : ''),
            q.taskName || q.task, q.description || q.taskName || q.task);
        });
      }

      if (filters.bosses) {
        const bLayer = layer();
        (markers.bosses || []).forEach((b) => {
          (b.spawnLocations || []).forEach((loc) => {
            (loc.positions || []).forEach((p) => {
              dotMarker(bLayer, p, 'boss-dot',
                b.name + ' ' + Math.round((b.spawnChance == null ? 0 : b.spawnChance) * 100) + '%');
            });
          });
        });
      }

      if (filters.spawnsPmc || filters.spawnsScav) {
        const sLayer = layer();
        (markers.spawns || []).forEach((s) => {
          if (!s || !s.position) return;
          const sides = s.sides || [];
          const isPmc = sides.indexOf('pmc') >= 0 || sides.indexOf('all') >= 0;
          const isScav = sides.indexOf('scav') >= 0 || sides.indexOf('all') >= 0;
          if ((isPmc && filters.spawnsPmc) || (isScav && filters.spawnsScav)) {
            dotMarker(sLayer, s.position, isPmc ? 'spawn-pmc' : 'spawn-scav',
              (s.categories || sides).join(' '));
          }
        });
      }

      if (filters.locks) {
        const lLayer = layer();
        (markers.locks || []).forEach((l) => {
          if (!l || !l.position) return;
          dotMarker(lLayer, l.position, 'lock-dot',
            String(l.lockType || 'lock') + (l.needsPower ? ' (needs power)' : ''));
        });
      }

      if (filters.hazards) {
        const hLayer = layer();
        (markers.hazards || []).forEach((h) => {
          if (h && h.position) labelMarker(hLayer, h.position, 'hazard', h.name || 'hazard');
        });
      }

      if (filters.transits) {
        const tLayer = layer();
        (markers.transits || []).forEach((t) => {
          if (t && t.position) labelMarker(tLayer, t.position, 'transit', t.description || 'transit');
        });
      }

      const wantedTypes = Object.keys(filters.containers).filter((k) => filters.containers[k]);
      if (wantedTypes.length) {
        const cLayer = layer();
        (markers.containers || []).forEach((c) => {
          if (c && c.position && wantedTypes.indexOf(c.type) >= 0) {
            dotMarker(cLayer, c.position, 'container-dot', c.name);
          }
        });
      }

      if (filters.lootItem && lootData && Array.isArray(lootData.points)) {
        const name = (lootItems && lootItems[filters.lootItem]) || 'item';
        const iLayer = layer();
        lootData.points.forEach((pt) => {
          // loot dots are the one deliberately larger dot (10px base, not 8)
          if (pt && pt.i && pt.i.indexOf(filters.lootItem) >= 0) {
            dotMarker(iLayer, pt.p, 'loot-dot', name, 10);
          }
        });
      }
    }

    // ==========================================================================
    // THE LIVE LAYER. Everything from here to the filter panel exists only when
    // globalThis.PilotLive is present AND connected; without it every function
    // below returns immediately and the map is unchanged.
    // ==========================================================================

    // Same correction app.js applies: the tarkov.dev basemaps are pre-rotated,
    // and the two quarter-turn maps are additionally flipped, so a raw compass
    // heading points the dot the wrong way on exactly those two.
    function markerRotation(headingDeg) {
      let add = (mapData && mapData.coordinateRotation) || 0;
      if (add === 90 || add === 270) add += 180;
      return (Number(headingDeg) || 0) + add;
    }

    function removePlayer() {
      if (playerMarker) {
        try { playerMarker.remove(); } catch (e) { /* gone already */ }
        playerMarker = null;
      }
    }

    function removeNav() {
      if (navMarker) {
        try { navMarker.remove(); } catch (e) { /* gone already */ }
        navMarker = null;
      }
    }

    function removePings() {
      pingMarkers.forEach((rec) => {
        try { rec.marker.remove(); } catch (e) { /* gone already */ }
      });
      pingMarkers.clear();
    }

    // Pan only when the dot has left the middle 60% of the pane. Recentring on
    // every frame would make the map twitch under the cursor while you are
    // trying to read it; letting the dot walk off the edge defeats the point.
    function keepInView(ll) {
      if (!map) return;
      const p = map.latLngToContainerPoint(ll);
      const size = map.getSize();
      const mx = size.x * 0.2;
      const my = size.y * 0.2;
      if (p.x < mx || p.y < my || p.x > size.x - mx || p.y > size.y - my) {
        map.panTo(ll, { animate: true });
      }
    }

    function snapToPlayer() {
      const lv = Live();
      const p = lv ? lv.state().position : null;
      if (!map || !p || typeof p.x !== 'number' || typeof p.z !== 'number') return;
      map.setView(gameLatLng(p), map.getZoom(), { animate: false });
    }

    // The overlay's own player marker, class for class: a rotating triangle in
    // the same blue, so the two views read as one product.
    function drawPlayer() {
      const lv = Live();
      const p = lv ? lv.state().position : null;
      if (!map) return;
      if (!liveOn() || !p || typeof p.x !== 'number' || typeof p.z !== 'number') {
        removePlayer();
        return;
      }
      const ll = gameLatLng(p);
      if (!playerMarker) {
        const icon = L.divIcon({
          className: 'player-marker',
          html: '<div class="dot">&#9650;</div>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        playerMarker = L.marker(ll, { icon, interactive: false }).addTo(map);
      } else {
        playerMarker.setLatLng(ll);
      }
      const node = playerMarker.getElement();
      if (node) {
        const d = node.querySelector('.dot');
        if (d) d.style.transform = 'rotate(' + markerRotation(p.heading) + 'deg)';
      }
      if (followPlayer) keepInView(ll);
    }

    // Where the overlay's arrow currently points, echoed back so the two views
    // agree about the target the user just set from here.
    function drawNav() {
      const lv = Live();
      const t = lv ? lv.state().navTarget : null;
      if (!map) return;
      const gp = t && t.gamePos;
      if (!liveOn() || !gp || (t.map && t.map !== mapId)) { removeNav(); return; }
      const ll = gameLatLng({ x: gp.x, z: gp.z });
      if (!navMarker) {
        const icon = L.divIcon({
          className: 'nav-marker',
          html: '<div class="pin"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        navMarker = L.marker(ll, { icon, interactive: false }).addTo(map);
      } else {
        navMarker.setLatLng(ll);
      }
    }

    // ---- pings ----
    // The overlay's own pin, shape for shape: a rounded teardrop whose POINT is
    // the marked spot, with the ping's number in it. Deliberately unlike the
    // nav pin (one hollow amber ring, no tail) and unlike the quest and extract
    // labels, so a glance says "someone put this here" rather than "the game
    // put this here".
    //
    // The id can be anything the Pilot chose, so only a couple of characters of
    // it go in the pin - the full label is the chip beside it and the popup.
    function pingGlyph(id) {
      const s = String(id == null ? '' : id);
      const digits = s.replace(/[^0-9]/g, '');
      if (digits) return digits.slice(-2);
      return s.slice(-2).toUpperCase();
    }

    function pingIcon(ping) {
      const s = markerPx(22);
      // The pin's point is its bottom-left corner (border-radius + the -45deg
      // rotation), so the anchor is [half, full] of whatever the current marker
      // scale makes it - the same rule as app.js's pingIcon. Computed here in
      // JS, not CSS, for the reason markerPx exists at all.
      // The Pilot auto-names unlabelled pings 'ping <n>'; the glyph already
      // shows the number, so a matching chip is redundant noise (verifier
      // finding 1, 2026-08-31). Only a human-authored label earns a chip.
      let label = String(ping.label == null ? '' : ping.label);
      if (/^ping \d+$/i.test(label)) label = '';
      return L.divIcon({
        className: 'ping-marker',
        html: '<div class="pin"><span>' + escapeHtml(pingGlyph(ping.id)) + '</span></div>'
          + (label ? '<div class="ping-label">' + escapeHtml(label) + '</div>' : ''),
        iconSize: [s, s],
        iconAnchor: [s / 2, s],
      });
    }

    // Built at open time like popContent, so a bubble opened while the link was
    // up cannot offer a remove after it dropped.
    function pingPopup(ping) {
      const box = el('div', 'imap-pop');
      box.appendChild(el('div', 'imap-pop-title', ping.label || ('Ping ' + pingGlyph(ping.id))));
      box.appendChild(el('div', 'imap-pop-body',
        'x ' + Math.round(ping.gamePos.x) + ', z ' + Math.round(ping.gamePos.z)));
      if (liveOn()) {
        const b = el('button', 'imap-ping-remove', 'Remove this ping');
        b.type = 'button';
        b.title = 'Right-clicking the pin does the same thing';
        b.addEventListener('click', () => sendRemovePing(ping.id));
        box.appendChild(b);
      }
      return box;
    }

    // THE ONLY thing that puts a ping on this map. It reads PilotLive's last
    // `pings` frame and nothing else: a ping this page just asked for appears
    // when the app echoes it back, which is why a failed add cannot leave a
    // phantom pin behind and a ping dropped from the overlay shows up here for
    // free.
    function drawPings() {
      if (!map) return;
      const lv = Live();
      const payload = lv ? lv.state().pings : null;
      const list = (payload && Array.isArray(payload.pings)) ? payload.pings : [];
      // A frame for another map is not ours to draw - same rule drawNav applies
      // to a stale nav target. A payload with no map at all is trusted.
      const onThisMap = !payload || !payload.map || payload.map === mapId;
      if (!liveOn() || !onThisMap || !list.length) { removePings(); return; }

      const seen = Object.create(null);
      const px = markerPx(22);
      list.forEach((p) => {
        if (!p || p.id == null) return;
        const gp = p.gamePos;
        if (!gp || typeof gp.x !== 'number' || typeof gp.z !== 'number') return;
        const key = String(p.id);
        seen[key] = true;
        const ping = {
          id: p.id,
          label: String(p.label == null ? '' : p.label),
          gamePos: { x: gp.x, z: gp.z },
        };
        // The scale is in the signature because the icon geometry is baked into
        // it, so a marker-size change rebuilds the pins instead of sliding them
        // off the spot they mark.
        const sig = key + '|' + ping.label + '|' + gp.x + '|' + gp.z + '|' + px;
        const rec = pingMarkers.get(key);
        if (rec && rec.sig === sig) { rec.ping = ping; return; }
        if (rec) {
          try { rec.marker.remove(); } catch (e) { /* gone already */ }
          pingMarkers.delete(key);
        }
        const next = { marker: null, sig: sig, ping: ping };
        next.marker = L.marker(gameLatLng(ping.gamePos), { icon: pingIcon(ping) }).addTo(map);
        next.marker.bindPopup(() => pingPopup(next.ping), { closeButton: true, autoPan: true });
        // Right-click removes, exactly as it does in the overlay. A touch screen
        // has no right-click, which is what the popup's button is for; leaflet
        // already suppresses the browser menu for this event.
        next.marker.on('contextmenu', () => sendRemovePing(next.ping.id));
        pingMarkers.set(key, next);
      });

      pingMarkers.forEach((rec, key) => {
        if (seen[key]) return;
        try { rec.marker.remove(); } catch (e) { /* gone already */ }
        pingMarkers.delete(key);
      });
    }

    // The one write a map click can make. A 409 is REPORTED, never retried: the
    // server refuses a target for a map the player is not on precisely so a
    // stale arrow cannot appear three raids later, and quietly queueing it here
    // would put that behaviour back.
    function sendNav(position, label) {
      const lv = Live();
      if (!lv || !lv.connected()) { toast('The Pilot app is not connected.', true); return; }
      if (map) { try { map.closePopup(); } catch (e) { /* nothing open */ } }
      navPopup = null;
      const gp = { x: Number(position.x), z: Number(position.z) };
      if (!Number.isFinite(gp.x) || !Number.isFinite(gp.z)) { toast('That spot has no position.', true); return; }
      lv.navTarget({ map: mapId, label: String(label == null ? '' : label).slice(0, 120), gamePos: gp })
        .then((res) => {
          if (destroyed) return;
          if (res.ok) { toast('Nav arrow set: ' + (label || 'map pin')); return; }
          if (res.status === 409) {
            const on = (res.body && res.body.map) ? prettyName(res.body.map) : 'another map';
            toast('The Pilot is on ' + on + ' right now, so this pin was not sent - a nav target is never queued for later.', true);
            return;
          }
          toast('The Pilot refused that: ' + (res.error || ('HTTP ' + res.status)), true);
        });
    }

    // Ask the Pilot to drop a ping. Nothing is drawn here - see drawPings. The
    // 409 wording differs from nav's on purpose: a nav target is refused because
    // an arrow must never be queued, a ping because a pin belongs to the map it
    // was dropped on.
    function sendPing(position, label) {
      const lv = Live();
      if (!lv || !lv.connected()) { toast('The Pilot app is not connected.', true); return; }
      if (map) { try { map.closePopup(); } catch (e) { /* nothing open */ } }
      navPopup = null;
      const gp = { x: Number(position.x), z: Number(position.z) };
      if (!Number.isFinite(gp.x) || !Number.isFinite(gp.z)) { toast('That spot has no position.', true); return; }
      const body = { map: mapId, gamePos: gp };
      // 40 = the Pilot's cleanPingLabel cap - send what will actually be kept.
      const text = String(label == null ? '' : label).slice(0, 40);
      // No label rather than an invented one: the Pilot numbers an unlabelled
      // ping itself, and both views should show the same number.
      if (text) body.label = text;
      lv.addPing(body).then((res) => {
        if (destroyed) return;
        if (res.ok) { toast(text ? ('Ping dropped: ' + text) : 'Ping dropped.'); return; }
        if (res.status === 409) {
          const on = (res.body && res.body.map) ? prettyName(res.body.map) : 'another map';
          toast('The Pilot is on ' + on + ' right now, so this ping was not dropped - a ping belongs to the map you are actually in.', true);
          return;
        }
        toast('The Pilot refused that: ' + (res.error || ('HTTP ' + res.status)), true);
      });
    }

    function sendRemovePing(id) {
      const lv = Live();
      if (!lv || !lv.connected()) { toast('The Pilot app is not connected.', true); return; }
      if (map) { try { map.closePopup(); } catch (e) { /* nothing open */ } }
      lv.removePing(id).then((res) => {
        if (destroyed) return;
        toast(res.ok ? 'Ping removed.'
          : ('The Pilot refused that: ' + (res.error || ('HTTP ' + res.status))), !res.ok);
      });
    }

    function sendClearPings() {
      const lv = Live();
      if (!lv || !lv.connected()) { toast('The Pilot app is not connected.', true); return; }
      if (map) { try { map.closePopup(); } catch (e) { /* nothing open */ } }
      lv.clearPings().then((res) => {
        if (destroyed) return;
        toast(res.ok ? 'Pings cleared.'
          : ('The Pilot refused that: ' + (res.error || ('HTTP ' + res.status))), !res.ok);
      });
    }

    // A bare-map click offers the two writes rather than firing either: a stray
    // click while panning must not yank the overlay's arrow across the map, and
    // it must not litter the raid with pins either.
    function onMapClick(e) {
      if (!liveOn() || !map) return;
      const target = e && e.originalEvent && e.originalEvent.target;
      // marker clicks own their own popup (which already carries the actions)
      if (target && target.closest && target.closest('.leaflet-marker-icon')) return;
      const ll = e.latlng;
      const gp = { x: ll.lng, z: ll.lat };
      const box = el('div', 'imap-pop');
      box.appendChild(el('div', 'imap-pop-title', 'Mark this spot'));
      box.appendChild(el('div', 'imap-pop-body',
        'x ' + Math.round(gp.x) + ', z ' + Math.round(gp.z)));
      // Ping above nav: you can have as many pings as you like and undo one with
      // a right-click, but there is only ever one arrow and sending it moves it.
      const p = el('button', 'imap-ping-btn', 'Drop a ping here');
      p.type = 'button';
      p.title = 'Pin this spot on the Pilot overlay and every view of this map';
      p.addEventListener('click', () => sendPing(gp, ''));
      box.appendChild(p);
      const b = el('button', 'imap-nav-btn', 'Navigate here');
      b.type = 'button';
      b.title = 'Point the Pilot overlay\'s nav arrow at this spot';
      b.addEventListener('click', () => sendNav(gp, 'map pin'));
      box.appendChild(b);
      navPopup = L.popup({ closeButton: true }).setLatLng(ll).setContent(box).openOn(map);
    }

    function wireMapInteractions() {
      if (!map) return;
      map.on('click', onMapClick);
      // Dragging is a deliberate "let me look over there", so it pauses the
      // follow instead of fighting the user for the viewport.
      map.on('dragstart', () => {
        if (!followPlayer) return;
        setFollowPlayer(false, true);
        toast('Follow paused - tick "follow my position" to resume.');
      });
    }

    function setFollowPlayer(on, persist) {
      followPlayer = !!on;
      const lv = Live();
      if (persist !== false && lv) lv.setPref('followPlayer', followPlayer);
      if (followPlayer) snapToPlayer();
      if (refreshLivePanel) refreshLivePanel();
    }

    function liveLine() {
      const lv = Live();
      if (!lv) return '';
      const st = lv.status();
      if (st.state === 'connected') {
        let t = 'Live - Pilot v' + (st.appVersion || '?');
        if (st.map) t += ', on ' + prettyName(st.map);
        return t;
      }
      return lv.statusText(st);
    }

    function updateLiveChrome() {
      const lv = Live();
      if (!lv || !lv.linked()) { liveChip.classList.add('hidden'); return; }
      const st = lv.status();
      liveChip.classList.remove('hidden');
      liveChip.classList.toggle('live', st.state === 'connected');
      liveText.textContent = st.state === 'connected' ? 'Pilot live' : lv.statusText(st);
      const paused = st.state === 'connected' && lv.pref('followMap') === false;
      liveResume.classList.toggle('hidden', !paused);
    }
    refreshLiveChrome = updateLiveChrome;
    liveResume.addEventListener('click', () => {
      const lv = Live();
      if (!lv) return;
      lv.setPref('followMap', true);
      updateLiveChrome();
      toast('Following the Pilot\'s map again.');
    });

    // A filter set pushed by the Pilot. It is merged, persisted and redrawn
    // through the same path a click takes; the echo guard lives in PilotLive,
    // which records the signature BEFORE this runs, so nothing bounces back.
    function applyRemoteFilters(payload, quiet) {
      if (!payload || payload.map !== mapId) return;
      const merged = { ...filters, ...(payload.filters || {}) };
      filters = normalizeFilters(merged);
      persistFilters();
      drawStaticMarkers();
      buildPanel();
      if (!quiet) toast('Map filters synced from the Pilot.');
    }

    function startLive() {
      const lv = Live();
      updateLiveChrome();
      if (!lv) return;
      // The undecided default resolves by MODE, not by guessing: a full-screen
      // companion window wants to follow, a pane you are reading does not.
      const saved = lv.pref('followPlayer');
      followPlayer = (saved === null || saved === undefined) ? companion : !!saved;
      applyRemoteFilters(lv.state().mapFilters, true);
      drawPlayer();
      drawNav();
      // The server replays the last `pings` frame on connect, so a page opened
      // mid-raid comes up with the pins already on it.
      drawPings();
      if (followPlayer) snapToPlayer();
      liveUnsub = lv.subscribe((ev) => {
        if (destroyed || !ev) return;
        switch (ev.type) {
          case 'position': drawPlayer(); break;
          case 'navTarget': drawNav(); break;
          case 'pings': drawPings(); break;
          case 'mapFilters': applyRemoteFilters(ev.payload, false); break;
          case 'displayMode': if (refreshLivePanel) refreshLivePanel(); break;
          case 'pref':
            updateLiveChrome();
            if (refreshLivePanel) refreshLivePanel();
            break;
          case 'hello':
          case 'status':
            updateLiveChrome();
            if (refreshLivePanel) refreshLivePanel();
            if (liveOn()) { drawPlayer(); drawNav(); drawPings(); }
            else { removePlayer(); removeNav(); removePings(); }
            break;
          default: break;
        }
      });
    }

    // ---- filter panel ----
    function onChange() {
      persistFilters();
      drawStaticMarkers();
      pushFilters();
    }

    // Local change -> the Pilot. Debounced and echo-guarded inside PilotLive, so
    // a burst of checkbox clicks is one write and a set that came FROM the app
    // is never sent back to it.
    function pushFilters() {
      const lv = Live();
      if (lv && lv.connected()) lv.postFilters(mapId, filters);
    }

    // "only": turn this section's categories on and every other category off.
    // 'containers' and 'lootItem' are pseudo-keys for the two sections whose
    // state is not a plain boolean. Straight from app.js's applyOnly.
    function applyOnly(keys) {
      const want = keys || [];
      MARKER_FILTER_KEYS.forEach((k) => { filters[k] = want.indexOf(k) >= 0; });
      Object.keys(filters.containers).forEach((k) => { filters.containers[k] = false; });
      if (want.indexOf('containers') >= 0) {
        ((markers && markers.containers) || []).forEach((c) => { filters.containers[c.type] = true; });
      }
      if (want.indexOf('lootItem') < 0) filters.lootItem = '';
      persistFilters();
      drawStaticMarkers();
      buildPanel();
      pushFilters();
    }

    function ensureLootLoaded() {
      const jobs = [];
      if (!lootItems) {
        jobs.push(ctx.loadJson('loot-items.json').then((d) => {
          lootItems = (d && typeof d === 'object') ? d : {};
        }));
      }
      if (!lootData) {
        const name = lootNameFor(mapId);
        jobs.push(name
          ? ctx.loadJson(name).then((d) => { lootData = (d && typeof d === 'object') ? d : null; })
          : Promise.resolve());
      }
      return Promise.all(jobs);
    }

    function buildPanel() {
      clear(panel);

      const section = (title, onlyKeys) => {
        const s = el('div', 'fp-section');
        const h = el('div', 'fp-head');
        h.appendChild(el('span', null, title));
        if (onlyKeys && onlyKeys.length) {
          const b = el('button', 'fp-only', 'only');
          b.type = 'button';
          b.title = 'show only ' + title + ' - every other marker category off';
          b.addEventListener('click', () => applyOnly(onlyKeys));
          h.appendChild(b);
        }
        s.appendChild(h);
        panel.appendChild(s);
        return s;
      };

      const check = (parent, label, get, set, count, changed) => {
        const l = document.createElement('label');
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = !!get();
        c.addEventListener('change', () => { set(c.checked); (changed || onChange)(); });
        l.appendChild(c);
        l.appendChild(document.createTextNode(' ' + label + (count != null ? ' (' + count + ')' : '')));
        parent.appendChild(l);
        return l;
      };

      // ---- Pilot live link ----
      // Drawn only once the user has asked for the link at all (linked()), so a
      // visitor who never heard of the desktop app never sees a dead section.
      refreshLivePanel = null;
      const lv = Live();
      if (lv && lv.linked()) {
        const sp = section('pilot link');
        const line = el('div', 'fp-note pilot-line', liveLine());
        sp.appendChild(line);

        // These set() bodies do their own work, so the shared `changed` hook
        // (which persists + posts FILTERS) must not run for them.
        const noop = () => {};
        const fmLabel = check(sp, 'follow the Pilot map', () => lv.pref('followMap') !== false,
          (v) => { lv.setPref('followMap', v); }, null, noop);
        const fpLabel = check(sp, 'follow my position', () => followPlayer,
          (v) => { setFollowPlayer(v, true); }, null, noop);

        sp.appendChild(el('div', 'ap-cap', 'overlay shows'));
        // The overlay's two halves are INDEPENDENT booleans on the wire, so
        // they are two checkboxes here, not a mode picker. Every command sends
        // both keys; the checkbox reflects what the app echoes back, not what
        // was clicked, so a refusal cannot leave the UI lying.
        const sendDisplay = (patch) => {
          lv.setDisplay(patch).then((res) => {
            if (destroyed) return;
            if (!res.ok) toast('The Pilot refused that: ' + (res.error || ('HTTP ' + res.status)), true);
            if (refreshLivePanel) refreshLivePanel();
          });
        };
        const dmLabel = check(sp, 'map panel', () => !!(lv.state().display || {}).map,
          (v) => sendDisplay({ map: v }), null, noop);
        const daLabel = check(sp, 'nav arrow', () => !!(lv.state().display || {}).arrow,
          (v) => sendDisplay({ arrow: v }), null, noop);

        const navClear = el('button', 'imap-clear', 'clear the nav arrow');
        navClear.type = 'button';
        navClear.addEventListener('click', () => {
          lv.clearNav().then((res) => {
            if (destroyed) return;
            toast(res.ok ? 'Nav arrow cleared.'
              : ('The Pilot refused that: ' + (res.error || ('HTTP ' + res.status))), !res.ok);
          });
        });
        sp.appendChild(navClear);

        // The bulk undo for a map you have pinned to death. One button, no
        // confirm: every ping is one click to put back, and the Pilot echoes
        // the empty list so both views clear together.
        const pingClear = el('button', 'imap-clear', 'clear the pings');
        pingClear.type = 'button';
        pingClear.title = 'Take every ping off this map, here and on the overlay';
        pingClear.addEventListener('click', () => sendClearPings());
        sp.appendChild(pingClear);

        const inputOf = (node) => (node ? node.querySelector('input') : null);
        const fmIn = inputOf(fmLabel);
        const fpIn = inputOf(fpLabel);
        const dmIn = inputOf(dmLabel);
        const daIn = inputOf(daLabel);
        refreshLivePanel = function () {
          line.textContent = liveLine();
          const connected = lv.connected();
          const d = lv.state().display || {};
          if (fmIn) fmIn.checked = lv.pref('followMap') !== false;
          if (fpIn) { fpIn.checked = followPlayer; fpIn.disabled = !connected; }
          if (dmIn) { dmIn.checked = !!d.map; dmIn.disabled = !connected; }
          if (daIn) { daIn.checked = !!d.arrow; daIn.disabled = !connected; }
          navClear.disabled = !connected;
          pingClear.disabled = !connected;
        };
        refreshLivePanel();
      }

      // ---- appearance (global, and works even with no marker data) ----
      const sa = section('appearance');
      const cap = (text) => el('span', 'ap-cap', text);
      const btnGroup = (caption, options, get, set) => {
        const r = el('div', 'ap-row');
        r.appendChild(cap(caption));
        const box = el('div', 'ap-btns');
        options.forEach((pair) => {
          const b = el('button', null, pair[0]);
          b.type = 'button';
          if (get() === pair[1]) b.classList.add('on');
          b.addEventListener('click', () => {
            set(pair[1]);
            for (let i = 0; i < box.children.length; i++) box.children[i].classList.remove('on');
            b.classList.add('on');
          });
          box.appendChild(b);
        });
        r.appendChild(box);
        sa.appendChild(r);
      };
      const setScale = (key, v) => {
        appearance[key] = v;
        applyAppearance();
        persistAppearance();
        // marker geometry is computed in JS, not CSS, so a scale change only
        // takes effect once the icons are rebuilt - the pins included, or their
        // anchors would stay at the old size and slide off the marked spot
        if (key === 'markerScale') { drawStaticMarkers(); drawPings(); }
      };
      btnGroup('markers', SCALE_STEPS, () => appearance.markerScale, (v) => setScale('markerScale', v));
      btnGroup('labels', SCALE_STEPS, () => appearance.labelScale, (v) => setScale('labelScale', v));
      const apChange = () => { persistAppearance(); drawStaticMarkers(); };
      check(sa, 'always show extracts', () => appearance.alwaysShowExtracts,
        (v) => { appearance.alwaysShowExtracts = v; }, null, apChange);
      check(sa, 'dim off-floor markers', () => appearance.dimOffFloor,
        (v) => { appearance.dimOffFloor = v; }, null, apChange);

      if (!markers) {
        panel.appendChild(el('div', 'fp-note', 'no marker data for this map'));
        return;
      }

      const sm = section('map', ['landmarks']);
      check(sm, 'landmark names', () => filters.landmarks, (v) => { filters.landmarks = v; },
        ((mapData && mapData.labels) || []).length);

      const nExtract = (f) => (markers.extracts || []).filter((e) => extractBucket(e.faction) === f).length;
      const sx = section('extracts', ['extractsPmc', 'extractsScav', 'extractsShared']);
      check(sx, 'PMC', () => filters.extractsPmc, (v) => { filters.extractsPmc = v; }, nExtract('pmc'));
      check(sx, 'Scav', () => filters.extractsScav, (v) => { filters.extractsScav = v; }, nExtract('scav'));
      check(sx, 'Shared', () => filters.extractsShared, (v) => { filters.extractsShared = v; }, nExtract('shared'));

      const sq = section('quests', ['quests']);
      check(sq, 'show quests', () => filters.quests, (v) => { filters.quests = v; }, (markers.quests || []).length);
      check(sq, 'mine only', () => filters.questsMineOnly, (v) => { filters.questsMineOnly = v; });
      if (filters.questsMineOnly && !Object.keys(ctx.questState || {}).length) {
        sq.appendChild(el('div', 'fp-note',
          'no quest progress loaded - connect TarkovTracker above, or untick "mine only"'));
      }

      const sw = section('world', ['bosses', 'spawnsPmc', 'spawnsScav', 'locks', 'hazards', 'transits']);
      check(sw, 'bosses', () => filters.bosses, (v) => { filters.bosses = v; }, (markers.bosses || []).length);
      check(sw, 'PMC spawns', () => filters.spawnsPmc, (v) => { filters.spawnsPmc = v; });
      check(sw, 'Scav spawns', () => filters.spawnsScav, (v) => { filters.spawnsScav = v; });
      check(sw, 'locked doors', () => filters.locks, (v) => { filters.locks = v; }, (markers.locks || []).length);
      check(sw, 'hazards', () => filters.hazards, (v) => { filters.hazards = v; }, (markers.hazards || []).length);
      check(sw, 'transits', () => filters.transits, (v) => { filters.transits = v; }, (markers.transits || []).length);

      const types = {};
      (markers.containers || []).forEach((c) => {
        if (!c || !c.type) return;
        const t = types[c.type] || { name: c.name || c.type, count: 0 };
        t.count += 1;
        types[c.type] = t;
      });
      const typeKeys = Object.keys(types).sort((a, b) => String(types[a].name).localeCompare(String(types[b].name)));
      if (typeKeys.length) {
        const sc = section('containers', ['containers']);
        typeKeys.forEach((key) => {
          check(sc, types[key].name, () => !!filters.containers[key],
            (v) => { filters.containers[key] = v; }, types[key].count);
        });
      }

      // Loose-loot search. No "only" button: this is a search box, not a set of
      // toggles, and "only loose loot" with nothing searched isolates an empty
      // map.
      const sl = section('find loose loot');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'imap-search';
      input.placeholder = 'type an item... (e.g. GPU)';
      const list = el('div', 'imap-results');
      const current = el('div', 'imap-current');
      sl.appendChild(input);
      sl.appendChild(list);
      sl.appendChild(current);

      const showCurrent = () => {
        current.textContent = filters.lootItem
          ? 'showing: ' + ((lootItems && lootItems[filters.lootItem]) || filters.lootItem) : '';
        current.classList.toggle('hidden', !filters.lootItem);
      };
      showCurrent();

      input.addEventListener('input', () => {
        ensureLootLoaded().then(() => {
          if (destroyed) return;
          clear(list);
          const q = input.value.trim().toLowerCase();
          if (q.length < 2 || !lootItems || !lootData) return;
          // only items that actually spawn on THIS map
          const here = {};
          (lootData.points || []).forEach((pt) => { (pt.i || []).forEach((id) => { here[id] = true; }); });
          const hits = Object.keys(lootItems)
            .filter((id) => here[id] && String(lootItems[id]).toLowerCase().indexOf(q) >= 0)
            .slice(0, 12);
          hits.forEach((id) => {
            const b = el('button', null, lootItems[id]);
            b.type = 'button';
            b.addEventListener('click', () => {
              filters.lootItem = id;
              input.value = '';
              clear(list);
              showCurrent();
              onChange();
            });
            list.appendChild(b);
          });
        });
      });

      const clearBtn = el('button', 'imap-clear', 'clear loot filter');
      clearBtn.type = 'button';
      clearBtn.addEventListener('click', () => { filters.lootItem = ''; showCurrent(); onChange(); });
      sl.appendChild(clearBtn);
    }

    // ---- boot ----
    // Sanitising the basemap is NOT optional even though app.js does not do it:
    // this SVG goes into a page that also holds the rest of the site, and
    // PilotHubMaps.sanitizeSvg is the tested function that already guards the
    // flat basemap two panes over. Same text, same treatment.
    function parseBasemap(text) {
      const Maps = globalThis.PilotHubMaps;
      const clean = (Maps && typeof Maps.sanitizeSvg === 'function') ? Maps.sanitizeSvg(text) : null;
      if (clean == null) {
        console.error('hub-maps-interactive: PilotHubMaps.sanitizeSvg is missing - refusing to render the basemap');
        return null;
      }
      let doc;
      try {
        doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
      } catch (e) {
        console.error('hub-maps-interactive: basemap parse failed: ' + e.message);
        return null;
      }
      if (!doc || !doc.documentElement) return null;
      if (doc.getElementsByTagName('parsererror').length) return null;
      if (String(doc.documentElement.nodeName).toLowerCase() !== 'svg') return null;
      return document.importNode(doc.documentElement, true);
    }

    Promise.all([loadIndex(ctx), ctx.loadJson('markers.json')])
      .then((res) => {
        if (destroyed) return null;
        const index = res[0];
        const allMarkers = res[1];
        mapData = findMapEntry(index, mapId);
        markers = (allMarkers && typeof allMarkers === 'object') ? (allMarkers[mapId] || null) : null;
        if (!mapData) {
          setStatus('No interactive map data for this location yet.', 'bad');
          buildPanel();
          return null;
        }
        const svgName = svgNameFor(mapData);
        if (!svgName) {
          setStatus('This map has no basemap file.', 'bad');
          buildPanel();
          return null;
        }
        return ctx.loadText(svgName);
      })
      .then((svgText) => {
        if (destroyed || !mapData) return;
        if (svgText == null) {
          setStatus('The basemap file is missing from this build.', 'bad');
          buildPanel();
          return;
        }
        svgRootEl = parseBasemap(svgText);
        if (!svgRootEl) {
          setStatus('The basemap could not be parsed.', 'bad');
          buildPanel();
          return;
        }

        // tarkov.dev's minZoom is tuned for the overlay's use: a small panel
        // that follows the player, where never being able to zoom out past
        // "useful detail" is the right call. A full-width pane has the opposite
        // job - the WHOLE location has to fit on screen - and on the wider maps
        // that fit sits BELOW the configured floor. So the map is created with
        // room underneath, fitBounds picks the zoom it actually needs, and the
        // floor is then set to whichever is lower. Math.min, not the fit zoom
        // outright: on a pane bigger than the map, raising the floor to the fit
        // zoom would take away zoom-out range tarkov.dev meant you to have.
        const cfgMinZoom = mapData.minZoom == null ? 1 : mapData.minZoom;
        map = L.map(canvas, {
          crs: getCRS(L, mapData),
          // In-page this is a normal map the user drives with the mouse, so
          // unlike the click-through overlay it keeps leaflet's own zoom
          // control and scroll-wheel zoom.
          zoomControl: true,
          attributionControl: false,
          minZoom: cfgMinZoom - 3,
          maxZoom: mapData.maxZoom == null ? 5 : mapData.maxZoom,
          zoomSnap: 0.25,
        });

        const bounds = boundsOf(L, mapData.bounds);
        const svgBounds = mapData.svgBounds ? boundsOf(L, mapData.svgBounds) : bounds;
        svgLayerEl = L.svgOverlay(svgRootEl, svgBounds, { interactive: false });
        svgLayerEl.addTo(map);
        buildFloorSelect();
        if (bounds) {
          // leaflet cached the container size at init; the panel next to it was
          // laid out in the same frame, so measure again before fitting or the
          // fit is computed against a box that is about to change.
          map.invalidateSize();
          map.fitBounds(bounds);
          map.setMinZoom(Math.min(cfgMinZoom, map.getZoom()));
        } else {
          map.setMinZoom(cfgMinZoom);
        }

        buildPanel();
        drawStaticMarkers();
        setStatus(markers ? '' : 'no marker data for this map', markers ? '' : 'warn');

        // ?companion=1 opens straight into the second-monitor view. Read here
        // rather than at module load so a deep link works on every open, and
        // wrapped because a sandboxed iframe can throw on location access.
        try {
          const q = (typeof location !== 'undefined') ? String(location.search || '') : '';
          if (/[?&]companion=1(?:&|$)/.test(q)) setCompanion(true);
        } catch (e) { /* no location to read */ }

        wireMapInteractions();
        startLive();

        // The pane is a flex child of a resizable window; leaflet caches the
        // container size at init and would otherwise render into a stale box
        // after the shell reflows (phone rotate, sidebar collapse).
        if (typeof ResizeObserver !== 'undefined') {
          resizeObs = new ResizeObserver(() => { if (map) map.invalidateSize(); });
          resizeObs.observe(canvas);
        }
        setTimeout(() => { if (map) map.invalidateSize(); }, 60);

        // a saved loot filter needs its per-map data before it can draw
        if (filters.lootItem) ensureLootLoaded().then(() => { if (!destroyed) drawStaticMarkers(); });
      })
      .catch((e) => {
        if (destroyed) return;
        console.error('hub-maps-interactive: could not open the map: ' + (e && e.message ? e.message : e));
        setStatus('The interactive map could not be loaded.', 'bad');
      });

    return {
      destroy() {
        destroyed = true;
        // The live link outlives this view, so its subscription, its full-screen
        // body class and its Esc handler are all released here - a leaked one
        // would keep drawing into a map that no longer exists.
        if (liveUnsub) { try { liveUnsub(); } catch (e) { /* already gone */ } liveUnsub = null; }
        if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        if (companion) {
          companion = false;
          try { document.body.classList.remove('tk-companion'); } catch (e) { /* no body */ }
        }
        removePlayer();
        removeNav();
        removePings();
        refreshLivePanel = null;
        refreshLiveChrome = null;
        if (resizeObs) { try { resizeObs.disconnect(); } catch (e) { /* gone already */ } resizeObs = null; }
        staticLayers.forEach((l) => { try { l.remove(); } catch (e) { /* gone already */ } });
        staticLayers = [];
        if (map) { try { map.remove(); } catch (e) { /* gone already */ } map = null; }
        svgLayerEl = null;
        svgRootEl = null;
        clear(mount);
      },
    };
  }

  return {
    DEFAULT_FILTERS,
    DEFAULT_APPEARANCE,
    MARKER_FILTER_KEYS,
    SCALE_STEPS,
    escapeHtml,
    normalizeFilters,
    normalizeAppearance,
    findMapEntry,
    svgNameFor,
    lootNameFor,
    prettyName,
    extractBucket,
    gameLatLng,
    applyRotation,
    getCRS,
    boundsOf,
    available,
    loadIndex,
    supports,
    open,
  };
}));
