// Pilot Hub - the LIVE LINK to the Fiiish Pilot desktop app.
//
// WEB ONLY. Loaded by src/pages/tarkov.astro AFTER hub.js / hub-connect.js.
// Nothing in the Electron app loads it, and nothing in the hub route modules
// requires it: every consumer (hub-maps.js, hub-maps-interactive.js) feature-
// detects globalThis.PilotLive and stays exactly as it is today when it is
// absent. Not connected == the site behaves as it always has.
//
// WHAT IT TALKS TO
// The Pilot's live-link server (projects/tarkov/pilot/src/tarkov/{live-link,
// server}.js) on http://127.0.0.1:8852, which allowlists this origin. The wire:
//   GET  /healthz  -> "ok"
//   GET  /state    -> a flat snapshot
//   GET  /events   -> SSE; every frame { v, type, seq, at, payload }
//   POST /ping /set-map /map-filters /nav-target /clear-nav /display-mode
//        /add-ping /remove-ping /clear-pings
// On connect the server replays `hello` then ONE FRAME PER PIECE OF STATE IT
// HAS EVER SEEN. A piece that is absent means "never seen" - it must NOT be
// treated as null, or a browser that connects before the first screenshot would
// wipe the quest progress it already had.
//
// WHY A POST /ping BEFORE THE EventSource
// EventSource reports every failure as the same contentless `error` event, so
// an app that is not running, a wrong port and a refused origin are
// indistinguishable from it. One /ping first turns those into a sentence the
// status line can actually show, and its body carries the app version.
//
// MIXED CONTENT, the one real limitation: the public site is https and the
// Pilot is plain http. Chrome and Firefox exempt http://127.0.0.1 from mixed-
// content blocking (a loopback origin is "potentially trustworthy"); Safari
// does not, so the link is a Chrome/Firefox feature and says so when it fails.
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotLive = api;
  // Same guard hub.js and the web adapter use: in node (tests) there is no
  // document, so nothing self-installs and a test drives the pure half.
  if (typeof document !== 'undefined') api.install();
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ==========================================================================
  // PURE: nothing above the "Host" banner touches the DOM, the network or
  // storage, so all of it is unit-testable under node.
  // ==========================================================================

  const BASE = 'http://127.0.0.1:8852';
  const PROTOCOL = 1;

  // The "reconnect me automatically" preference. Persisting it is the whole
  // difference between a toy and a feature: the player opens the page mid-raid
  // and it is already live.
  const LINK_KEY = 'island.tarkov.pilot.link.v1';
  // Live-map preferences shared between the map view (which draws the toggles)
  // and hub-maps.js (which acts on the map-follow one).
  const MAP_PREF_KEY = 'island.tarkov.pilot.map.v1';

  const PREF_DEFAULTS = {
    // Follow the map the Pilot says the player is on. ON by default: a live
    // link that does not follow the raid is a link you have to babysit.
    followMap: true,
    // Pan to keep the player dot in view. `null` = "the user has not decided",
    // which the map view resolves to ON in companion mode and OFF in the pane -
    // a pane you are reading while alt-tabbed should not yank itself around.
    followPlayer: null,
  };

  // How the overlay is drawn. TWO INDEPENDENT BOOLEANS, not a three-value enum:
  // the minimap panel and the nav arrow are shown or hidden on their own, and
  // the wire carries both keys on every frame and every command.
  //   { map: true,  arrow: true  }  panel + arrow
  //   { map: true,  arrow: false }  panel only
  //   { map: false, arrow: true  }  arrow only
  //   { map: false, arrow: false }  neither (the overlay is effectively off)
  const DISPLAY_KEYS = ['map', 'arrow'];
  const DEFAULT_DISPLAY = { map: true, arrow: true };

  // Both keys must be real booleans or the frame is not trusted; a partial
  // payload would otherwise silently turn a toggle off in the UI.
  function normalizeDisplay(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof v.map !== 'boolean' || typeof v.arrow !== 'boolean') return null;
    return { map: v.map, arrow: v.arrow };
  }

  // Reconnect backoff. Capped low on purpose: the Pilot is a local app the user
  // is actively starting, so a 60s hole between retries reads as "broken".
  const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
  function backoffMs(attempt) {
    const i = Math.max(0, Math.min(BACKOFF_MS.length - 1, Number(attempt) || 0));
    return BACKOFF_MS[i];
  }

  // One SSE `data:` line -> a frame, or null. Every rejection is silent by
  // design: a stray heartbeat comment or a frame from a future protocol must
  // never throw inside an event handler and kill the stream.
  function parseFrame(text) {
    let doc;
    try { doc = JSON.parse(String(text)); } catch (e) { return null; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (typeof doc.type !== 'string' || !doc.type) return null;
    return {
      v: Number(doc.v) || 0,
      type: doc.type,
      seq: Number(doc.seq) || 0,
      at: Number(doc.at) || 0,
      payload: (doc.payload === undefined) ? null : doc.payload,
    };
  }

  // The empty live state. `undefined` is deliberate and load-bearing: it is how
  // "the Pilot has never told us" is told apart from "the Pilot told us null".
  function emptyState() {
    return {
      map: undefined,
      position: undefined,
      quests: undefined,
      profile: undefined,
      mapFilters: undefined,
      display: { map: DEFAULT_DISPLAY.map, arrow: DEFAULT_DISPLAY.arrow },
      navTarget: undefined,
      // { map, pings: [...] }. ALWAYS the whole list for that map, never a
      // delta - see the `pings` case in reduce().
      pings: undefined,
    };
  }

  // Fold a frame into the running state. Returns true when it changed anything
  // a consumer would want to redraw for.
  function reduce(state, frame) {
    if (!frame) return false;
    switch (frame.type) {
      case 'map': state.map = frame.payload && frame.payload.map; return true;
      case 'position': state.position = frame.payload; return true;
      case 'quests': state.quests = frame.payload && frame.payload.state; return true;
      case 'profile': state.profile = frame.payload; return true;
      case 'mapFilters': state.mapFilters = frame.payload; return true;
      case 'displayMode': {
        const d = normalizeDisplay(frame.payload);
        // An unreadable frame leaves the last known value alone rather than
        // snapping the checkboxes back to the default.
        if (!d) return false;
        state.display = d;
        return true;
      }
      case 'navTarget': state.navTarget = frame.payload; return true;
      // REPLACE THE WHOLE LIST, always. The Pilot sends the full set for the
      // current map on every change (and an empty array when the last one goes),
      // so a consumer only ever has to render what this frame says - there is no
      // local ping state anywhere on this side to drift out of sync. `undefined`
      // still means "never told us", which is why an absent key is not [].
      case 'pings': state.pings = frame.payload; return true;
      default: return false;
    }
  }

  // A stable signature for a filter set, used as the ECHO GUARD in both
  // directions: a filter set we just received is never posted back, and a
  // filter set we just posted is not re-applied when the Pilot echoes it. Keys
  // are sorted so two equal sets can never sign differently.
  function filterSig(mapId, filters) {
    const f = (filters && typeof filters === 'object' && !Array.isArray(filters)) ? filters : {};
    const keys = Object.keys(f).sort();
    const parts = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = f[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const ck = Object.keys(v).sort();
        const inner = [];
        for (let j = 0; j < ck.length; j++) inner.push(ck[j] + ':' + String(v[ck[j]]));
        parts.push(k + '={' + inner.join(',') + '}');
      } else {
        parts.push(k + '=' + String(v));
      }
    }
    return String(mapId == null ? '' : mapId) + '|' + parts.join(';');
  }

  // The live-link server refuses a filter set with an unknown key OUTRIGHT
  // (400, whole command), which is the right posture for it and the wrong thing
  // to hand it blind: the web map view owns two keys the desktop app also has,
  // but a key added on the web side first would break every push. So the
  // payload is built from the schema the wire documents, never from whatever
  // the local object happens to hold.
  const WIRE_FILTER_BOOLEANS = [
    'landmarks',
    'extractsPmc', 'extractsScav', 'extractsShared',
    'quests', 'questsMineOnly',
    'bosses', 'spawnsPmc', 'spawnsScav', 'locks', 'hazards', 'transits',
  ];
  const ITEM_ID_RE = /^[0-9a-f]{24}$/;
  const CONTAINER_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

  function wireFilters(filters) {
    const f = (filters && typeof filters === 'object' && !Array.isArray(filters)) ? filters : {};
    const out = {};
    for (let i = 0; i < WIRE_FILTER_BOOLEANS.length; i++) {
      const k = WIRE_FILTER_BOOLEANS[i];
      if (typeof f[k] === 'boolean') out[k] = f[k];
    }
    if (f.containers && typeof f.containers === 'object' && !Array.isArray(f.containers)) {
      const c = {};
      const keys = Object.keys(f.containers);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (CONTAINER_KEY_RE.test(k) && typeof f.containers[k] === 'boolean') c[k] = f.containers[k];
      }
      out.containers = c;
    }
    if (typeof f.lootItem === 'string' && (f.lootItem === '' || ITEM_ID_RE.test(f.lootItem))) {
      out.lootItem = f.lootItem;
    }
    return out;
  }

  // A `profile` frame -> the patch hubAPI.saveProfile will accept. The adapter
  // refuses the WHOLE save on one junk value, so anything unrecognised is left
  // out here rather than passed through and silently losing the good half.
  function profilePatch(payload) {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : null;
    if (!p) return null;
    const patch = {};
    const lvl = p.playerLevel;
    if (typeof lvl === 'number' && Number.isInteger(lvl) && lvl >= 1 && lvl <= 79) patch.playerLevel = lvl;
    const fac = (typeof p.faction === 'string') ? p.faction.trim().toLowerCase() : null;
    if (fac === 'bear' || fac === 'usec') patch.faction = fac;
    const tl = p.traderLevels;
    if (tl && typeof tl === 'object' && !Array.isArray(tl)) {
      const clean = {};
      const keys = Object.keys(tl);
      let bad = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const n = Number(tl[k]);
        if (/^[0-9a-z]{24}$/.test(k) && Number.isInteger(n) && n >= 1 && n <= 4) clean[k] = n;
        else bad++;
      }
      // One bad entry would make saveProfile refuse the whole map, so a partly
      // junk trader map is dropped instead of poisoning the level + faction.
      if (!bad && keys.length) patch.traderLevels = clean;
    }
    return Object.keys(patch).length ? patch : null;
  }

  // The status line's words live here so the button, the map chrome and any
  // future consumer cannot describe the same state three different ways.
  function statusText(st) {
    const s = st || {};
    switch (s.state) {
      case 'connected': {
        let t = 'Pilot linked';
        if (s.appVersion) t += ' - v' + s.appVersion;
        if (s.map) t += ' - on ' + String(s.map).replace(/-/g, ' ');
        return t;
      }
      case 'connecting': return 'Looking for the Pilot app...';
      case 'reconnecting': return 'Pilot link lost - reconnecting...';
      case 'error': return s.error || 'The Pilot app could not be reached.';
      default: return 'Pilot app not connected';
    }
  }

  // ==========================================================================
  // Host. Everything below touches fetch/EventSource/localStorage/the DOM.
  // ==========================================================================

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
    } catch (e) { /* private mode / blocked site data: forget instead of failing */ }
  }

  const status = { state: 'off', appVersion: null, caps: null, error: null, map: null, at: 0 };
  const live = emptyState();
  const subs = new Set();

  let es = null;
  let retryTimer = null;
  let attempt = 0;
  let wanted = false;          // the persisted "keep me connected" intent
  let applying = false;        // an inbound push is being written to the hub
  let lastFilterSig = null;    // the echo guard, set on receive AND on send
  let filterTimer = null;
  let pendingFilters = null;

  function emit(type, payload) {
    const ev = { type, payload, status: snapshotStatus(), state: live };
    subs.forEach((fn) => {
      try { fn(ev); } catch (e) {
        console.error('hub-pilot-connect: a subscriber threw: ' + (e && e.message ? e.message : e));
      }
    });
  }

  function snapshotStatus() {
    return {
      state: status.state,
      appVersion: status.appVersion,
      caps: status.caps,
      error: status.error,
      map: live.map === undefined ? null : live.map,
      at: status.at,
    };
  }

  function setState(next, error) {
    if (status.state === next && (error || null) === status.error) return;
    status.state = next;
    status.error = error || null;
    status.at = Date.now();
    emit('status', snapshotStatus());
  }

  // ---- preferences ----
  function pref(name) {
    const all = readStore(MAP_PREF_KEY) || {};
    if (!Object.prototype.hasOwnProperty.call(all, name)) {
      return Object.prototype.hasOwnProperty.call(PREF_DEFAULTS, name) ? PREF_DEFAULTS[name] : null;
    }
    return all[name];
  }
  function setPref(name, value) {
    const all = readStore(MAP_PREF_KEY) || {};
    all[name] = value;
    writeStore(MAP_PREF_KEY, all);
    emit('pref', { name: name, value: value });
  }

  // ---- commands ----
  // Never throws. A refusal and a dead socket both come back as an object the
  // caller can show, because every call site is a click that has to say
  // something. { ok, status, body, error }
  function command(name, body) {
    return fetch(BASE + '/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'omit',
    }).then((res) => res.json().catch(() => null).then((doc) => ({
      ok: res.ok,
      status: res.status,
      body: doc,
      error: (!res.ok && doc && doc.error) ? doc.error : null,
    }))).catch((e) => ({
      ok: false,
      status: 0,
      body: null,
      error: (e && e.message) ? e.message : 'the Pilot app is not reachable',
    }));
  }

  function ping() { return command('ping', {}); }
  function setMap(mapId) { return command('set-map', { map: mapId }); }
  function navTarget(t) { return command('nav-target', t || {}); }
  function clearNav() { return command('clear-nav', {}); }
  // Pings. Fire-and-forget on purpose: NOTHING here writes to live.pings, so a
  // caller cannot draw a ping the Pilot has not accepted. The command's whole
  // visible effect is the `pings` frame it causes (loopback, so <100ms), and a
  // refusal - a 409 for the wrong map above all - is returned for the click to
  // show, exactly the way navTarget's is.
  function addPing(t) { return command('add-ping', t || {}); }
  function removePing(id) { return command('remove-ping', { id: id }); }
  function clearPings() { return command('clear-pings', {}); }
  // Both keys always, both strict booleans - the server refuses anything else,
  // and a command that silently dropped a key would flip a toggle the user did
  // not touch.
  function setDisplay(next) {
    const cur = live.display || DEFAULT_DISPLAY;
    const n = (next && typeof next === 'object') ? next : {};
    const body = {
      map: typeof n.map === 'boolean' ? n.map : !!cur.map,
      arrow: typeof n.arrow === 'boolean' ? n.arrow : !!cur.arrow,
    };
    return command('display-mode', body);
  }

  // Debounced, echo-guarded filter push. The map view calls this on every
  // checkbox; the Pilot gets at most one write per burst, and never one that
  // just came FROM it.
  function postFilters(mapId, filters) {
    if (status.state !== 'connected') return;
    if (!mapAllowed(mapId)) return;
    const wire = wireFilters(filters);
    const sig = filterSig(mapId, wire);
    if (sig === lastFilterSig) return;
    pendingFilters = { map: mapId, filters: wire, sig: sig };
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterTimer = null;
      const job = pendingFilters;
      pendingFilters = null;
      if (!job || status.state !== 'connected') return;
      lastFilterSig = job.sig;
      command('map-filters', { map: job.map, filters: job.filters }).then((res) => {
        if (!res.ok) {
          // A refused push must not poison the guard, or the next legitimate
          // change with the same shape would be swallowed too.
          lastFilterSig = null;
          console.error('hub-pilot-connect: map-filters refused: ' + (res.error || res.status));
        }
      });
    }, 400);
  }

  // True when the Pilot's `hello` said it knows this map id. Without caps (not
  // connected yet) nothing is claimed - the command itself will 400 if wrong.
  function mapAllowed(mapId) {
    const maps = status.caps && status.caps.maps;
    if (!Array.isArray(maps)) return true;
    return maps.indexOf(String(mapId)) >= 0;
  }

  // ---- inbound application ----
  // Quests and profile go through the EXACT paths a hand edit and the
  // TarkovTracker connect use, so a live push can never put the hub in a state
  // the UI cannot produce. `applying` is set across the write so a consumer
  // listening to the hub's own echo can tell our push apart from a user edit.
  function applyQuests(payload) {
    const host = root.PilotHubWebHost;
    const state = payload && payload.state;
    if (!host || typeof host.importQuestState !== 'function') return;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    applying = true;
    try { host.importQuestState(state); } catch (e) {
      console.error('hub-pilot-connect: quest push failed: ' + (e && e.message ? e.message : e));
    } finally { applying = false; }
  }

  function applyProfile(payload) {
    const api = root.hubAPI;
    if (!api || typeof api.saveProfile !== 'function') return;
    const patch = profilePatch(payload);
    if (!patch) return;
    applying = true;
    try { api.saveProfile(patch); } catch (e) {
      console.error('hub-pilot-connect: profile push failed: ' + (e && e.message ? e.message : e));
    } finally { applying = false; }
  }

  function onFrame(frame) {
    if (!frame) return;
    if (frame.type === 'hello') {
      const p = frame.payload || {};
      status.appVersion = p.appVersion || null;
      status.caps = p.caps || null;
      if (Number(p.protocol) !== PROTOCOL) {
        console.error('hub-pilot-connect: the Pilot speaks protocol '
          + p.protocol + ', this page speaks ' + PROTOCOL);
      }
      attempt = 0;
      setState('connected', null);
      emit('hello', p);
      return;
    }
    if (!reduce(live, frame)) return;
    if (frame.type === 'quests') applyQuests(frame.payload);
    if (frame.type === 'profile') applyProfile(frame.payload);
    if (frame.type === 'mapFilters' && frame.payload) {
      // Remember it BEFORE the map view redraws off it, so the redraw's own
      // change handler sees a matching signature and does not push it back.
      lastFilterSig = filterSig(frame.payload.map, wireFilters(frame.payload.filters));
    }
    emit(frame.type, frame.payload);
  }

  // ---- the stream ----
  function closeStream() {
    if (es) {
      try { es.close(); } catch (e) { /* already dead */ }
      es = null;
    }
  }

  function scheduleRetry() {
    if (!wanted || retryTimer) return;
    const wait = backoffMs(attempt);
    attempt += 1;
    retryTimer = setTimeout(() => { retryTimer = null; if (wanted) openStream(); }, wait);
  }

  function openStream() {
    if (!wanted || es) return;
    if (typeof EventSource === 'undefined') {
      setState('error', 'This browser cannot open a live link (no EventSource).');
      return;
    }
    setState(attempt ? 'reconnecting' : 'connecting', null);
    // One /ping first: it turns EventSource's contentless failure into a
    // sentence, and its body is where the app version comes from if `hello`
    // is somehow never seen.
    ping().then((res) => {
      if (!wanted) return;
      if (!res.ok) {
        const why = res.status === 0
          ? 'The Pilot app is not running, or Browser link is off in its settings.'
          : ('The Pilot app answered ' + res.status + '.');
        setState(attempt ? 'reconnecting' : 'error', why);
        scheduleRetry();
        return;
      }
      if (res.body && res.body.appVersion) status.appVersion = res.body.appVersion;
      try {
        es = new EventSource(BASE + '/events');
      } catch (e) {
        setState('error', 'The live link could not be opened: ' + (e && e.message ? e.message : e));
        scheduleRetry();
        return;
      }
      es.onmessage = (ev) => { onFrame(parseFrame(ev && ev.data)); };
      es.onerror = () => {
        // EventSource says nothing about WHY. Close it and drive our own
        // backoff so the status line can at least count the attempts.
        closeStream();
        if (!wanted) { setState('off', null); return; }
        setState('reconnecting', null);
        scheduleRetry();
      };
    });
  }

  function connect() {
    wanted = true;
    writeStore(LINK_KEY, { on: true });
    attempt = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    openStream();
  }

  function disconnect() {
    wanted = false;
    writeStore(LINK_KEY, { on: false });
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    closeStream();
    attempt = 0;
    status.caps = null;
    setState('off', null);
  }

  function toggle() { if (wanted) disconnect(); else connect(); }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    subs.add(fn);
    return function () { subs.delete(fn); };
  }

  // ==========================================================================
  // The toolbar UI. Owned here rather than in an inline page script on purpose:
  // inline bytes count against the shell JS budget, and this file is already
  // excluded from it as a ported-app script.
  // ==========================================================================
  function mountUi() {
    const btn = document.getElementById('tk-pilot-connect');
    const stateEl = document.getElementById('tk-pilot-state');
    const hintEl = document.getElementById('tk-pilot-hint');
    if (!btn && !stateEl) return null;

    function render() {
      const st = snapshotStatus();
      if (stateEl) {
        stateEl.textContent = statusText(st);
        stateEl.classList.toggle('on', st.state === 'connected');
        stateEl.classList.toggle('bad', st.state === 'error');
      }
      if (btn) {
        btn.textContent = wanted ? 'Disconnect Pilot' : 'Connect Pilot app';
        btn.classList.toggle('tk-btn--primary', !wanted);
        btn.setAttribute('aria-pressed', wanted ? 'true' : 'false');
      }
      if (hintEl) {
        hintEl.hidden = st.state !== 'error';
        if (st.state === 'error') hintEl.textContent = st.error || '';
      }
    }

    if (btn) btn.addEventListener('click', () => { toggle(); render(); });
    subscribe((ev) => { if (ev.type === 'status' || ev.type === 'hello' || ev.type === 'map') render(); });
    render();
    return render;
  }

  let installed = false;
  function install() {
    if (installed) return;
    installed = true;
    mountUi();
    // Auto-reconnect for a user who linked before. Deferred a tick so hub.js
    // has installed hubAPI/PilotHubWebHost before the first quest push lands.
    const saved = readStore(LINK_KEY);
    if (saved && saved.on) {
      wanted = true;
      setTimeout(() => { if (wanted) openStream(); }, 0);
    }
  }

  // Test seam: the pure half is exported alongside the live half so the wire
  // decisions can be asserted without a socket.
  return {
    BASE, PROTOCOL, LINK_KEY, MAP_PREF_KEY, DISPLAY_KEYS, DEFAULT_DISPLAY, PREF_DEFAULTS,
    backoffMs, parseFrame, emptyState, reduce, filterSig, wireFilters,
    profilePatch, statusText, normalizeDisplay,
    install, mountUi,
    connect, disconnect, toggle, subscribe,
    command, ping, setMap, navTarget, clearNav, setDisplay, postFilters,
    addPing, removePing, clearPings,
    mapAllowed,
    pref, setPref,
    connected: () => status.state === 'connected',
    linked: () => wanted,
    isApplying: () => applying,
    status: snapshotStatus,
    state: () => live,
  };
}));
