// Pilot Hub - the WEB host adapter.
//
// WEB ONLY. Nothing in the Electron app loads this file: hub.html does not
// reference it, preload-hub.js does not reference it, and package.json's build
// `files` list ships src/** but the desktop hub never runs it because no script
// tag pulls it in. It exists so the Fiiiish App island can mount the exact same
// hub route modules over static JSON instead of over ipc.
//
// What it is: the eight-method `hubAPI` contract that preload-hub.js exposes,
// reimplemented against fetch() + localStorage, plus the two host hooks hub.js
// feature-detects (PILOT_IMG_URL, PILOT_SET_QUEST_STATUS).
//
// The contract that shapes every decision here: hub.js NEVER trusts its own
// optimism. It sends a profile patch and waits for the host to echo the
// ACCEPTED value back on the 'profile' push before ctx.profile moves. So this
// file validates exactly as hard as main.js does and echoes SYNCHRONOUSLY -
// an adapter that accepted a level of 999 would put the hub in a state the
// desktop app can never be in, which is the fastest way to make the ported
// modules drift.
//
// Load order in the page: this file BEFORE hub.js. hub.js reads globalThis
// .hubAPI inside start(), and start() runs on load.
//
// Config: globalThis.PILOT_WEB_CONFIG = { dataBase, imgBase } must be set
// before this file installs (or before install() is called by hand).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubWebAdapter = api;
  // Same guard hub.js uses for start(): in node (the tests) there is no
  // document and nothing installs itself, so a test can drive install() with
  // its own stubs.
  if (typeof document !== 'undefined') api.install();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==========================================================================
  // PURE: config, validation, url building
  // ==========================================================================
  const PROFILE_KEY = 'island.tarkov.profile.v1';

  // Every file the hub route modules ask for, by the exact name they ask for.
  // An allowlist rather than a path sanitiser because on the web there is no
  // filesystem to escape from - the risk is not traversal, it is a typo'd name
  // turning into a request the CDN answers with an HTML 404 page that then
  // parses as "not JSON" three layers away from the cause.
  const DATA_NAMES = [
    'wiki/meta.json',
    'wiki/items.json',
    'wiki/items-desc.json',
    'wiki/item-props.json',
    'wiki/categories.json',
    'wiki/traders.json',
    'wiki/barters.json',
    'wiki/quests.json',
    'wiki/mapsinfo.json',
    'wiki/levels.json',
    // the overlay-era data dir; markers.json is the one the map view will want
    // when the island ships interactive markers
    'maps.json',
    'markers.json',
    'tasks.json',
    'loot-items.json',
  ];

  // data/svg/<Basemap>.svg - hub-maps.js builds this name off mapsinfo, so the
  // set is data-driven and cannot be listed above. Same shape rule main.js's
  // read-data enforces: one segment, no traversal.
  const SVG_RE = /^svg\/[A-Za-z0-9_-]{1,64}\.svg$/;

  // data/loot/<normalizedName>.json - the loose-loot spawn points for one map,
  // asked for by the interactive map view. Data-driven off maps.json for the
  // same reason as the basemaps, and held to the same one-segment shape.
  const LOOT_RE = /^loot\/[A-Za-z0-9_-]{1,64}\.json$/;

  function isAllowedName(name) {
    const s = String(name == null ? '' : name);
    if (DATA_NAMES.indexOf(s) >= 0) return true;
    return SVG_RE.test(s) || LOOT_RE.test(s);
  }

  // Mirrors HUB_IMG_ID_RE / HUB_IMG_SLUG_RE in main.js and ID_RE / SLUG_RE in
  // hub.js. hub.js has ALREADY validated by the time PILOT_IMG_URL is called,
  // so this is belt-and-braces for a direct caller, not the boundary.
  const ID_RE = /^[0-9a-z]{24}$/;
  const SLUG_RE = /^[0-9a-z][0-9a-z().-]{0,63}$/;

  // Task ids in the push-notification log and in quests.json are 24 hex - a
  // tighter rule than the item/trader one, and the same one src/quests.js uses.
  const TASK_ID_RE = /^[0-9a-f]{24}$/i;
  const TRADER_ID_RE = /^[0-9a-z]{24}$/;
  const QUEST_STATUSES = ['started', 'finished', 'failed'];
  const MAX_PLAYER_LEVEL = 79;
  const FACTIONS = ['bear', 'usec'];

  // The same host allowlist main.js's open-external enforces (HUB_EXTERNAL_HOSTS).
  const EXTERNAL_HOSTS = [
    'escapefromtarkov.fandom.com',
    'tarkov.dev',
    'www.tarkov.dev',
  ];

  // Copies of src/config.js's normalizers, not imports: this file has to run as
  // a plain <script> with no bundler, exactly like every other renderer file.
  // If one of these drifts from config.js the web port starts accepting
  // profiles the desktop app would refuse, so they are kept literal.
  function normalizePlayerLevel(v) {
    if (v == null || v === '') return null;
    if (typeof v !== 'number') return null;
    if (!Number.isInteger(v) || v < 1 || v > MAX_PLAYER_LEVEL) return null;
    return v;
  }

  function normalizeFaction(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    return FACTIONS.indexOf(s) >= 0 ? s : null;
  }

  function normalizeTraderLevels(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    Object.keys(v).forEach((k) => {
      if (!TRADER_ID_RE.test(k)) return;
      const n = Number(v[k]);
      if (!Number.isInteger(n) || n < 1 || n > 4) return;
      out[k] = n;
    });
    return out;
  }

  // Quest state as the log watcher produces it: taskId -> { status, at }.
  // Anything that is not a known status word, or is keyed by something that is
  // not a task id, is DROPPED rather than repaired - a junk key here is handed
  // straight to a lookup by kit.js.
  function normalizeQuestState(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    Object.keys(v).forEach((k) => {
      if (!TASK_ID_RE.test(k)) return;
      const e = v[k];
      if (!e || typeof e !== 'object') return;
      const status = String(e.status || '').toLowerCase();
      if (QUEST_STATUSES.indexOf(status) < 0) return;
      const at = Number(e.at);
      const row = { status, at: Number.isFinite(at) && at > 0 ? at : null };
      if (typeof e.traderId === 'string' && TRADER_ID_RE.test(e.traderId)) row.traderId = e.traderId;
      out[k] = row;
    });
    return out;
  }

  // One shape for everything this adapter persists. questState rides along in
  // the SAME localStorage record as the profile on purpose: they are written
  // together, read together, and a half-restored pair (level without progress)
  // is worse than neither.
  function normalizeStored(doc) {
    const d = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {};
    return {
      playerLevel: normalizePlayerLevel(typeof d.playerLevel === 'number' ? d.playerLevel : null),
      faction: normalizeFaction(d.faction),
      traderLevels: normalizeTraderLevels(d.traderLevels),
      questState: normalizeQuestState(d.questState),
    };
  }

  // What the 'profile' push carries - deliberately NOT the questState, because
  // main.js's profile push does not carry it either and hub.js reads exactly
  // these three keys off it.
  function profileOf(stored) {
    return {
      playerLevel: stored.playerLevel,
      faction: stored.faction,
      traderLevels: stored.traderLevels,
    };
  }

  function joinUrl(base, name) {
    const b = String(base == null ? '' : base).replace(/\/+$/, '');
    const n = String(name == null ? '' : name).replace(/^\/+/, '');
    return b + '/' + n;
  }

  // '?v=<syncedAt>' rather than a no-store fetch: the data is immutable between
  // syncs, so it SHOULD sit in the browser cache forever - the version key is
  // what makes a new sync visible without asking every viewer to hard-refresh.
  function versioned(url, v) {
    if (v == null || v === '') return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(String(v));
  }

  // Same rules as main.js's open-external, in the same order: https, no
  // embedded credentials, no explicit port, host on the allowlist.
  function externalAllowed(url) {
    let u;
    try { u = new URL(String(url)); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (u.port) return false;
    return EXTERNAL_HOSTS.indexOf(u.hostname.toLowerCase()) >= 0;
  }

  // The four kinds hub.js's imgUrl knows. item512 goes straight to tarkov.dev
  // rather than into the repo: the 512px art is ~2 GB across 5,312 items and is
  // only ever wanted one image at a time in the detail pane.
  function imgUrlFor(imgBase, kind, id) {
    const s = String(id == null ? '' : id);
    if (kind === 'boss') {
      if (!SLUG_RE.test(s) || s.indexOf('..') >= 0) return '';
      return joinUrl(imgBase, 'bosses/' + s + '.webp');
    }
    if (!ID_RE.test(s)) return '';
    if (kind === 'item') return joinUrl(imgBase, 'items/' + s + '.webp');
    if (kind === 'trader') return joinUrl(imgBase, 'traders/' + s + '.webp');
    if (kind === 'item512') return 'https://assets.tarkov.dev/' + s + '-512.webp';
    return '';
  }

  // ==========================================================================
  // The host. Everything below touches fetch/localStorage/window.
  // ==========================================================================
  function create(cfg) {
    const conf = cfg || {};
    const dataBase = String(conf.dataBase == null ? '.' : conf.dataBase);
    const imgBase = String(conf.imgBase == null ? 'img' : conf.imgBase);

    let stored = normalizeStored(null);
    let meta = null;
    let syncing = false;
    const subs = { quests: [], profile: [], wiki: [], updater: [] };

    function emit(chan, payload) {
      const list = subs[chan] || [];
      for (let i = 0; i < list.length; i++) {
        try { list[i](payload); } catch (e) {
          console.error('hub-web-adapter: a ' + chan + ' subscriber threw: '
            + (e && e.message ? e.message : e));
        }
      }
    }

    // localStorage throws outright in a few real browser configurations
    // (private mode quota, site data blocked), and a hub that refuses to boot
    // because progress could not be remembered is far worse than a hub that
    // forgets. Both directions are therefore best-effort.
    function loadStored() {
      let raw = null;
      try {
        raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(PROFILE_KEY) : null;
      } catch (e) { raw = null; }
      if (!raw) return normalizeStored(null);
      try { return normalizeStored(JSON.parse(raw)); } catch (e) {
        console.error('hub-web-adapter: the stored profile is not valid JSON - starting empty');
        return normalizeStored(null);
      }
    }

    function persist() {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(PROFILE_KEY, JSON.stringify(stored));
      } catch (e) {
        console.error('hub-web-adapter: the profile could not be saved: '
          + (e && e.message ? e.message : e));
      }
    }

    function dataVersion() {
      const v = meta && meta.syncedAt;
      return (v == null || v === '') ? null : v;
    }

    function fetchText(name, bust) {
      const url = versioned(joinUrl(dataBase, name), bust);
      return fetch(url, { credentials: 'omit' }).then((res) => {
        // Every non-OK answer is null, exactly like main.js's read-data, which
        // returns null for anything it cannot read. A 404 is the normal case
        // (a file this build does not ship); anything else is logged so a
        // broken deploy is not silently indistinguishable from a missing file.
        if (!res || !res.ok) {
          if (res && res.status !== 404) {
            console.error('hub-web-adapter: ' + name + ' answered ' + res.status);
          }
          return null;
        }
        return res.text();
      });
    }

    // ---- the eight hubAPI methods ----

    // Mirrors main.js's 'get-hub-init' field for field. hub.js reads gameMode,
    // hasWiki, wikiMeta, syncing, questState, profile and updater off this; the
    // rest are carried so the two hosts answer the same question the same way.
    function getInit() {
      return fetchText('wiki/meta.json', Date.now()).then((text) => {
        let doc = null;
        if (text != null) {
          try { doc = JSON.parse(text); } catch (e) {
            console.error('hub-web-adapter: meta.json is not valid JSON: ' + e.message);
          }
        }
        meta = (doc && typeof doc === 'object') ? doc : null;
        stored = loadStored();
        // Boot echo. hub.js also seeds ctx.questState off the init payload
        // below, so this is belt-and-braces for it - but it is load-bearing for
        // any OTHER subscriber the island page registered (its own progress
        // readout), which would otherwise sit empty until the first edit.
        emit('quests', { state: stored.questState });
        return {
          gameMode: (meta && typeof meta.gameMode === 'string') ? meta.gameMode : 'regular',
          hasWiki: !!meta,
          // There is no writable data dir and no installer on the web; both are
          // answered honestly rather than omitted, so a consumer that reads
          // them gets a defined value instead of undefined.
          hasWritableDataDir: false,
          packaged: false,
          testMode: false,
          wikiMeta: meta,
          // The web copy is whatever the deploy shipped; there is no local sync
          // that could make it fresher, so it never "needs" one.
          needsWikiSync: false,
          syncing: false,
          questState: stored.questState,
          profile: profileOf(stored),
          // Registered but never fired (see onUpdaterStatus). 'idle' is the one
          // state hub.js's renderUpdateLine deliberately renders as nothing.
          updater: {
            state: 'idle',
            version: null,
            current: null,
            error: null,
            portable: false,
            gameRunning: false,
            text: '',
            actionable: false,
            action: null,
          },
        };
      });
    }

    function readData(name) {
      if (!isAllowedName(name)) {
        console.error('hub-web-adapter: refused a read of ' + String(name));
        return Promise.resolve(null);
      }
      return fetchText(name, dataVersion());
    }

    // There is nothing to sync on the web - the data is whatever the deploy
    // shipped. What this DOES is re-check meta.json past the cache, which is
    // exactly what "Sync now" should mean here: pick up a deploy that landed
    // while the tab was open. It drives the same state machine main.js drives,
    // so hub.js's boot screen and footer need no web-specific branch.
    function syncWikiNow() {
      if (syncing) return;
      syncing = true;
      // Synchronous, because hub.js arms a 1500ms watchdog the moment it asks
      // and puts the boot screen back into a retryable state if nothing answers.
      emit('wiki', { state: 'running', syncing: true, progress: 'checking for new data' });
      fetchText('wiki/meta.json', Date.now()).then((text) => {
        if (text == null) throw new Error('the data could not be reached');
        let doc;
        try { doc = JSON.parse(text); } catch (e) {
          throw new Error('the data index is not valid JSON');
        }
        if (!doc || typeof doc !== 'object') throw new Error('the data index is empty');
        meta = doc;
        syncing = false;
        emit('wiki', { state: 'done', syncing: false, meta: meta });
      }).catch((e) => {
        syncing = false;
        emit('wiki', {
          state: 'error',
          syncing: false,
          error: (e && e.message) ? e.message : String(e),
          meta: meta,
        });
      });
    }

    // Validated exactly as hard as main.js's 'save-profile' handler, including
    // the rule that a JUNK value refuses the WHOLE save rather than being
    // clamped: silently turning a typed 999 into 79 would show the player
    // quests they cannot take, and a faction that quietly failed to save would
    // show them the other side's tasks forever.
    //
    // Returns nothing (fire and forget, like the ipc send). The accepted value
    // comes back on the 'profile' push, synchronously, before this returns.
    function saveProfile(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
      const next = {
        playerLevel: stored.playerLevel,
        faction: stored.faction,
        traderLevels: stored.traderLevels,
      };
      if (Object.prototype.hasOwnProperty.call(patch, 'playerLevel')) {
        const lvl = normalizePlayerLevel(patch.playerLevel);
        if (lvl == null && patch.playerLevel != null && patch.playerLevel !== '') return;
        next.playerLevel = lvl;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'faction')) {
        const fac = normalizeFaction(patch.faction);
        if (fac == null && patch.faction != null && patch.faction !== '') return;
        next.faction = fac;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'traderLevels')) {
        const tl = patch.traderLevels;
        if (!tl || typeof tl !== 'object' || Array.isArray(tl)) return;
        const clean = normalizeTraderLevels(tl);
        // one bad entry refuses the whole map, so a caller bug cannot half-write
        if (Object.keys(clean).length !== Object.keys(tl).length) return;
        next.traderLevels = clean;
      }
      stored.playerLevel = next.playerLevel;
      stored.faction = next.faction;
      stored.traderLevels = next.traderLevels;
      persist();
      emit('profile', profileOf(stored));
    }

    function openExternal(url) {
      if (!externalAllowed(url)) return Promise.resolve(false);
      try {
        // noopener AND noreferrer: the opened page must not get a handle back
        // to this window, and the hub is not a referrer anyone needs.
        const w = window.open(String(url), '_blank', 'noopener,noreferrer');
        if (w) w.opener = null;
        return Promise.resolve(true);
      } catch (e) {
        console.error('hub-web-adapter: open-external failed: '
          + (e && e.message ? e.message : e));
        return Promise.resolve(false);
      }
    }

    function subscribe(chan) {
      return function (cb) {
        if (typeof cb === 'function') subs[chan].push(cb);
      };
    }

    // ---- the two host hooks hub.js feature-detects ----

    function imgUrl(kind, id) {
      return imgUrlFor(imgBase, kind, id);
    }

    // The write the desktop app deliberately does not have. status is one of
    // 'started' | 'finished' | 'failed', or null to forget the task entirely.
    // Echoes on the 'quests' push in the SAME payload shape main.js broadcasts
    // ({ state }), so hub.js's subscriber and every badge downstream of it need
    // no idea which host they are talking to.
    function setQuestStatus(taskId, status) {
      const id = String(taskId == null ? '' : taskId);
      if (!TASK_ID_RE.test(id)) return false;
      if (status == null) {
        if (!Object.prototype.hasOwnProperty.call(stored.questState, id)) return false;
        delete stored.questState[id];
      } else {
        const s = String(status).toLowerCase();
        if (QUEST_STATUSES.indexOf(s) < 0) return false;
        stored.questState[id] = { status: s, at: Date.now() };
      }
      persist();
      emit('quests', { state: stored.questState });
      return true;
    }

    // Wholesale replacement, for the importers the island page owns (a Pilot
    // quest-state.json, a TarkovTracker export). Same normalize + echo path, so
    // an import cannot put a shape in that a hand-marked task could not.
    function importQuestState(next) {
      stored.questState = normalizeQuestState(next);
      persist();
      emit('quests', { state: stored.questState });
      return stored.questState;
    }

    const hubAPI = {
      getInit,
      readData,
      syncWikiNow,
      openExternal,
      saveProfile,
      onQuests: subscribe('quests'),
      onProfile: subscribe('profile'),
      onWikiSyncStatus: subscribe('wiki'),
      onUpdaterStatus: subscribe('updater'),
      // There is no updater on the web. Registered above and never fired;
      // this is here so a click on a line that cannot exist is still a no-op
      // rather than a TypeError.
      updaterAction: function () {},
    };

    return {
      hubAPI,
      imgUrl,
      setQuestStatus,
      importQuestState,
      // for the page and the tests
      getStored: () => stored,
      config: { dataBase, imgBase },
    };
  }

  // Installs onto the globals hub.js reads. Idempotent: a second call on a page
  // that already has an adapter is ignored, so a stray duplicate script tag
  // cannot silently replace a host that already has subscribers on it.
  let installed = null;
  function install(cfg) {
    if (installed) return installed;
    const conf = cfg
      || (typeof globalThis !== 'undefined' ? globalThis.PILOT_WEB_CONFIG : null)
      || {};
    const host = create(conf);
    globalThis.hubAPI = host.hubAPI;
    globalThis.PILOT_IMG_URL = host.imgUrl;
    globalThis.PILOT_SET_QUEST_STATUS = host.setQuestStatus;
    globalThis.PilotHubWebHost = host;
    installed = host;
    return host;
  }

  // Test seam only. The desktop app never loads this file at all, so nothing
  // here is reachable from Electron.
  function reset() {
    installed = null;
  }

  return {
    PROFILE_KEY,
    DATA_NAMES,
    SVG_RE,
    LOOT_RE,
    EXTERNAL_HOSTS,
    TASK_ID_RE,
    QUEST_STATUSES,
    isAllowedName,
    normalizePlayerLevel,
    normalizeFaction,
    normalizeTraderLevels,
    normalizeQuestState,
    normalizeStored,
    profileOf,
    joinUrl,
    versioned,
    externalAllowed,
    imgUrlFor,
    create,
    install,
    reset,
  };
}));
