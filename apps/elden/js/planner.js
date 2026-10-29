/* planner.js - the build planner and stat calculator (Lane P3 L7).
 *
 * OWNED BY: P3 L7 (Planner + AR). FILE FENCE: js/planner.js, js/ar.js,
 * css/planner.css, tools/ar-golden.mjs, tools/validate/ar.mjs,
 * tools/stages.d/55-ar-golden.json.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT LIVES
 * ---------------------------------------------------------------------------
 * The planner is NOT a tab. It is the second half of the Builds tab
 * (PLAN.md section 10), reached at #builds/planner[/<guide-slug>], and
 * js/builds.js (lane P3 L6) hosts it by calling:
 *
 *     ER.planner.mount(el)          once, with an element to render into
 *     ER.planner.show(params)       every time the route lands on it
 *     ER.planner.loadGuide(slug)    from a guide page's "Load into Planner"
 *
 * Everything else this file exposes is for the other lanes:
 *
 *     ER.planner.stats()            the current 8 stats + level + class
 *     ER.planner.arFor(rec, stats, upgradeLevel, affinity[, opts])
 *     ER.planner.canWield(rec, stats[, opts])
 *
 * If js/builds.js has not landed yet, the Builds tab renders the shell's
 * honest placeholder. This file watches for that ONE case and takes the pane
 * over, so the planner is reachable and reviewable on its own. The takeover is
 * keyed on the shell's `.soon-panel` marker, so the moment builds.js exists it
 * never fires. It never calls ER.registerTab, because that would clobber the
 * Builds lane's own registration.
 *
 * ---------------------------------------------------------------------------
 * THE MATH IS NOT IN THIS FILE
 * ---------------------------------------------------------------------------
 * js/ar.js is the port of the MIT weapon calculator and is DOM-free so the
 * validator can load the same bytes in Node. This file fetches the regulation
 * payload (data/weapon-calc.json - 1.4 MB, deliberately NOT in the shell's 21
 * boot files) the first time the planner is opened, hands it to ar.js, and
 * renders. Until it lands, every AR cell says so rather than showing a zero.
 *
 * ---------------------------------------------------------------------------
 * STATE
 * ---------------------------------------------------------------------------
 * ONE localStorage key, elden_planner_v1 (registry syncKeys), holding the
 * working build, the named loadouts and the list UI preferences. Saves are
 * debounced 300 ms behind a visible save pill. Every read and write is in a
 * try/catch: a private window with storage disabled must still render a
 * working planner, it just cannot remember one.
 *
 * STYLE. Classic script, ES2019, ASCII only, no modules. Every interpolated
 * value goes through esc(). No inline handlers - all delegated.
 */
(function () {
  'use strict';

  var ER = window.ER;
  if (!ER) {
    if (window.console && console.error) console.error('planner.js: window.ER is not ready; the planner was not installed.');
    return;
  }

  /* ------------------------------------------------------------- constants */

  var KEY = 'elden_planner_v1';
  var SAVE_DEBOUNCE = 300;
  var STATS = ['vig', 'mind', 'end', 'str', 'dex', 'int', 'fai', 'arc'];
  var SCALE_STATS = ['str', 'dex', 'int', 'fai', 'arc'];
  var MAX_STAT = 99;
  var LIST_PAGE = 40;

  var DMG_LABEL = { phys: 'Phys', mag: 'Magic', fire: 'Fire', ligt: 'Lightning', holy: 'Holy' };
  var STATUS_LABEL = {
    bleed: 'Bleed', frost: 'Frost', poison: 'Poison', rot: 'Scarlet Rot',
    sleep: 'Sleep', madness: 'Madness', deathblight: 'Death Blight'
  };

  /* ---------------------------------------------------------------- helpers */

  function esc(s) {
    if (ER && typeof ER.esc === 'function') return ER.esc(s);
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function statName(k) {
    if (ER && ER.fmt && typeof ER.fmt.stat === 'function') return ER.fmt.stat(k);
    return k;
  }
  function fmtNum(n) {
    if (ER && ER.fmt && typeof ER.fmt.num === 'function') return ER.fmt.num(n);
    return String(n);
  }
  function toast(m) {
    if (ER && typeof ER.toast === 'function') ER.toast(m);
  }
  function asset(p) {
    if (ER && typeof ER.asset === 'function') return ER.asset(p);
    return String(p || '');
  }
  function srcOn(src) {
    if (ER && typeof ER.srcOn === 'function') return ER.srcOn(src);
    return true;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function int(v, d) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : d;
  }
  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
  function floor(n) { return Math.floor(n + 1e-9); }

  /* ----------------------------------------------------------------- state */

  var STATE = null;
  var HOST = null;          /* the element builds.js (or the fallback) gave us */
  var ROOT = null;          /* our own .er-planner element inside it */
  var MOUNTED = false;
  var CALC_STATE = 'idle';  /* idle | loading | ready | failed */
  var CALC_WHY = '';
  var SAVE_TIMER = null;
  var SAVE_PILL_TIMER = null;
  var RENDER_TIMER = null;
  var LIST_SHOWN = LIST_PAGE;
  var GUIDE_GEAR = {};      /* id -> 'early'|'mid'|'late' from loadGuide */
  var GUIDE_SLUG = null;

  function defaults() {
    return {
      v: 1,
      classId: null,
      stats: null,             /* filled from the class on first paint */
      upgrade: null,           /* null = "as high as this weapon goes" */
      affinity: 'auto',        /* 'auto' = each weapon's own default row */
      twoHanding: false,
      scadutree: 0,
      armor: { head: null, chest: null, arms: null, legs: null },
      compare: [],
      loadouts: [],
      ui: { sort: 'ar', onlyWieldable: false, cls: '', q: '', section: {} }
    };
  }

  function readState() {
    var base = defaults();
    try {
      var raw = localStorage.getItem(KEY);
      if (raw == null) return base;
      var v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return base;
      /* Merge field by field: a blob written by an older build must not be able
         to remove a field this build depends on. */
      base.classId = typeof v.classId === 'string' ? v.classId : null;
      base.provisional = false;
      if (v.stats && typeof v.stats === 'object') {
        base.stats = {};
        STATS.forEach(function (s) { base.stats[s] = clamp(int(v.stats[s], 1), 1, MAX_STAT); });
      }
      base.upgrade = v.upgrade === null || v.upgrade === undefined ? null : clamp(int(v.upgrade, 0), 0, 25);
      base.affinity = typeof v.affinity === 'string' ? v.affinity : 'auto';
      base.twoHanding = !!v.twoHanding;
      base.scadutree = clamp(int(v.scadutree, 0), 0, 20);
      if (v.armor && typeof v.armor === 'object') {
        ['head', 'chest', 'arms', 'legs'].forEach(function (slot) {
          base.armor[slot] = typeof v.armor[slot] === 'string' ? v.armor[slot] : null;
        });
      }
      base.compare = arr(v.compare).filter(function (x) { return typeof x === 'string'; }).slice(0, 2);
      base.loadouts = arr(v.loadouts).filter(function (l) { return l && typeof l === 'object' && l.name; }).slice(0, 40);
      if (v.ui && typeof v.ui === 'object') {
        base.ui.sort = typeof v.ui.sort === 'string' ? v.ui.sort : 'ar';
        base.ui.onlyWieldable = !!v.ui.onlyWieldable;
        base.ui.cls = typeof v.ui.cls === 'string' ? v.ui.cls : '';
        base.ui.q = typeof v.ui.q === 'string' ? v.ui.q : '';
        base.ui.section = v.ui.section && typeof v.ui.section === 'object' ? v.ui.section : {};
      }
      return base;
    } catch (e) {
      return base;
    }
  }

  function savePill(text, cls) {
    var pill = ROOT && ROOT.querySelector('#erpSave');
    if (!pill) return;
    pill.textContent = text;
    pill.className = 'erp-save' + (cls ? ' ' + cls : '');
    pill.hidden = false;
    clearTimeout(SAVE_PILL_TIMER);
    if (cls === 'ok') {
      SAVE_PILL_TIMER = setTimeout(function () {
        if (pill) pill.hidden = true;
      }, 1600);
    }
  }

  function save() {
    savePill('Saving...', 'busy');
    clearTimeout(SAVE_TIMER);
    SAVE_TIMER = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(STATE));
        savePill('Saved', 'ok');
      } catch (e) {
        savePill('Not saved on this device', 'err');
      }
    }, SAVE_DEBOUNCE);
  }

  /* ------------------------------------------------------------ data access */

  function classes() {
    return arr(ER.data && ER.data.classes);
  }
  function mechanics() {
    return (ER.data && ER.data.mechanics) || {};
  }
  function weapons() {
    return arr(ER.data && ER.data.weapons);
  }
  function spells() {
    return arr(ER.data && ER.data.spells);
  }
  function armorPieces() {
    return arr(ER.data && ER.data.armor);
  }
  function guides() {
    return arr(ER.data && ER.data.guides);
  }

  function classById(id) {
    var list = classes();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function currentClass() {
    return classById(STATE.classId) || classes()[0] || null;
  }

  /* The lowest each stat can go: you never un-spend a class's starting stats. */
  function classBase() {
    var c = currentClass();
    var out = {};
    STATS.forEach(function (s) { out[s] = c && c.stats ? clamp(int(c.stats[s], 1), 1, MAX_STAT) : 1; });
    return out;
  }
  function classLevel() {
    var c = currentClass();
    return c ? int(c.level, 1) : 1;
  }

  /* Called on every paint AND at script load, which is BEFORE ER.ready has
     resolved and therefore before classes.json exists. A build initialised
     without the class list is marked provisional and re-initialised from the
     real starting stats the first time the data is actually there - otherwise
     a fresh planner would open on eight 1s. */
  function ensureStats() {
    var haveClasses = classes().length > 0;
    if (!STATE.classId && haveClasses) {
      /* Wretch is the blank slate - level 1, ten in everything - which is the
         honest default for a planner that has not been told anything yet. */
      var list = classes();
      var pick = list[0];
      for (var i = 0; i < list.length; i++) if (list[i].slug === 'wretch') pick = list[i];
      STATE.classId = pick.id;
    }
    var base = classBase();
    if (!STATE.stats || (STATE.provisional && haveClasses)) {
      STATE.stats = {};
      STATS.forEach(function (s) { STATE.stats[s] = base[s]; });
      STATE.provisional = !haveClasses;
      return;
    }
    STATS.forEach(function (s) {
      STATE.stats[s] = clamp(int(STATE.stats[s], base[s]), base[s], MAX_STAT);
    });
  }

  function level() {
    var base = classBase();
    var lv = classLevel();
    STATS.forEach(function (s) { lv += STATE.stats[s] - base[s]; });
    return lv;
  }

  /* Cumulative rune cost from mechanics.runeCost, which is the wiki's 713-row
     Level table (see tools/README.md). Runes spent = total(level) - total(class
     level): the class's own starting levels were never paid for. */
  function runeTable() {
    var t = arr(mechanics().runeCost);
    if (!RUNE_INDEX || RUNE_INDEX.src !== t) {
      RUNE_INDEX = { src: t, byLevel: {} };
      t.forEach(function (r) { RUNE_INDEX.byLevel[int(r.level, -1)] = r; });
    }
    return RUNE_INDEX;
  }
  var RUNE_INDEX = null;

  function runeInfo() {
    var idx = runeTable();
    var lv = level();
    var here = idx.byLevel[lv];
    var start = idx.byLevel[classLevel()];
    if (!here || !start) return null;
    return {
      level: lv,
      spent: int(here.total, 0) - int(start.total, 0),
      toNext: idx.byLevel[lv + 1] ? int(here.toNext, 0) : null,
      maxLevel: idx.byLevel[713] ? 713 : null
    };
  }

  /* ------------------------------------------------- the attack calculator */

  var CALC_PROMISE = null;

  function loadCalc() {
    if (CALC_PROMISE) return CALC_PROMISE;
    if (!ER.ar) {
      CALC_STATE = 'failed';
      CALC_WHY = 'js/ar.js did not load, so attack power cannot be calculated.';
      CALC_PROMISE = Promise.resolve(false);
      return CALC_PROMISE;
    }
    if (ER.ar.ready()) {
      CALC_STATE = 'ready';
      CALC_PROMISE = Promise.resolve(true);
      return CALC_PROMISE;
    }
    CALC_STATE = 'loading';
    /* No dot-slash literal of our own: ER.asset owns the single base constant
       (js/app.js), so this resolves correctly standalone AND inside the island
       shell, where the assembler has rewritten that one base. */
    CALC_PROMISE = fetch(asset('data/weapon-calc.json'), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        ER.ar.load(json);
        CALC_STATE = 'ready';
        return true;
      })
      .catch(function (e) {
        CALC_STATE = 'failed';
        CALC_WHY = 'The attack calculator data (data/weapon-calc.json) could not be read: '
          + ((e && e.message) || 'unknown error') + '.';
        return false;
      });
    return CALC_PROMISE;
  }

  function calcReady() {
    return CALC_STATE === 'ready' && ER.ar && ER.ar.ready();
  }

  /* The upgrade level to show a weapon at: the pinned one, clamped to what this
     weapon can actually reach, or its maximum when nothing is pinned. */
  function upgradeFor(rec) {
    var max = calcReady() ? ER.ar.maxUpgrade(rec, affinityFor(rec)) : (rec.upgrade === 'somber' ? 10 : rec.upgrade === 'none' ? 0 : 25);
    if (STATE.upgrade === null || STATE.upgrade === undefined) return max;
    return clamp(STATE.upgrade, 0, max);
  }

  function affinityFor(rec) {
    if (!STATE.affinity || STATE.affinity === 'auto') return null;
    if (!calcReady()) return null;
    var list = ER.ar.affinitiesFor(rec);
    for (var i = 0; i < list.length; i++) if (list[i].slug === STATE.affinity) return list[i].id;
    /* Not infusable, or does not take this affinity: fall back to its own row
       rather than hiding the weapon or showing a wrong number. */
    return null;
  }

  var AR_CACHE = null;
  function arCacheKey() {
    return STATS.map(function (s) { return STATE.stats[s]; }).join(',') + '|'
      + String(STATE.upgrade) + '|' + STATE.affinity + '|' + (STATE.twoHanding ? '2' : '1');
  }
  function arOf(rec) {
    if (!calcReady()) return null;
    var key = arCacheKey();
    if (!AR_CACHE || AR_CACHE.key !== key) AR_CACHE = { key: key, map: {} };
    var id = rec.id || rec.name;
    if (AR_CACHE.map[id] !== undefined) return AR_CACHE.map[id];
    var out = null;
    try {
      out = ER.ar.attack(rec, STATE.stats, upgradeFor(rec), affinityFor(rec), { twoHanding: STATE.twoHanding });
    } catch (e) {
      out = null;
    }
    AR_CACHE.map[id] = out;
    return out;
  }

  /* ---------------------------------------------------------- public API */

  ER.planner = {
    mount: mount,
    show: show,
    hide: function () {},
    stats: function () {
      ensureStats();
      var out = { level: level(), classId: STATE.classId, className: currentClass() ? currentClass().name : null };
      STATS.forEach(function (s) { out[s] = STATE.stats[s]; });
      return out;
    },
    setStats: function (patch) {
      ensureStats();
      var base = classBase();
      STATS.forEach(function (s) {
        if (patch && patch[s] !== undefined) STATE.stats[s] = clamp(int(patch[s], base[s]), base[s], MAX_STAT);
      });
      AR_CACHE = null;
      save();
      render();
    },
    loadGuide: loadGuide,
    arFor: function (rec, stats, upgradeLevel, affinity, opts) {
      if (!ER.ar) return null;
      if (!ER.ar.ready()) {
        loadCalc();
        return null;
      }
      var o = opts || {};
      if (o.twoHanding === undefined) o = { twoHanding: !!(STATE && STATE.twoHanding) };
      return ER.ar.attack(rec, stats || (STATE && STATE.stats), upgradeLevel, affinity, o);
    },
    canWield: function (rec, stats, opts) {
      if (!ER.ar) return false;
      var o = opts || {};
      if (o.twoHanding === undefined) o.twoHanding = !!(STATE && STATE.twoHanding);
      return ER.ar.canWield(rec, stats || (STATE && STATE.stats), o);
    },
    shareCode: shareCode,
    applyShareCode: applyShareCode,
    calcReady: calcReady,
    search: search
  };

  /* -------------------------------------------------------------- share code */
  /* base64url of "classId|v,m,e,s,d,i,f,a|upgrade|affinity|2h". Deliberately
     tiny and human-inspectable once decoded; it carries no personal data, so it
     is safe to paste anywhere. */

  function b64encode(s) {
    try {
      return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) {
      return '';
    }
  }
  function b64decode(s) {
    try {
      var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
      while (t.length % 4) t += '=';
      return decodeURIComponent(escape(atob(t)));
    } catch (e) {
      return '';
    }
  }

  function shareCode() {
    ensureStats();
    var parts = [
      STATE.classId || '',
      STATS.map(function (s) { return STATE.stats[s]; }).join(','),
      STATE.upgrade === null ? '' : String(STATE.upgrade),
      STATE.affinity || 'auto',
      STATE.twoHanding ? '2' : '1'
    ];
    return b64encode(parts.join('|'));
  }

  function applyShareCode(code) {
    var raw = b64decode(code);
    if (!raw) return false;
    var parts = raw.split('|');
    if (parts.length < 2) return false;
    var nums = String(parts[1]).split(',');
    if (nums.length !== STATS.length) return false;
    if (parts[0] && classById(parts[0])) STATE.classId = parts[0];
    STATE.stats = {};
    var base = classBase();
    STATS.forEach(function (s, i) { STATE.stats[s] = clamp(int(nums[i], base[s]), 1, MAX_STAT); });
    ensureStats();
    STATE.upgrade = parts[2] === '' || parts[2] === undefined ? null : clamp(int(parts[2], 0), 0, 25);
    STATE.affinity = parts[3] || 'auto';
    STATE.twoHanding = parts[4] === '2';
    AR_CACHE = null;
    save();
    return true;
  }

  /* ------------------------------------------------------------- loadGuide */
  /* PLAN section 10: "Load into Planner" preloads the class, the guide's
     HIGHEST stat target and its late gear. The late gear is not equipped (this
     planner does not equip weapons); it is MARKED, so it floats to the top of
     the attack-power list and the first two go into the compare slots. */

  function guideBySlug(slug) {
    var list = guides();
    for (var i = 0; i < list.length; i++) {
      if (list[i].slug === slug || list[i].id === slug) return list[i];
    }
    return null;
  }

  function loadGuide(slug) {
    /* The share-link route (#builds/planner/s/<code>) reaches builds.js as a
       "guide slug" of "s" before show() ever sees it, so those two sentinels
       are refused silently rather than telling the player a guide is missing. */
    if (slug === 's' || slug === 'code') return false;
    var g = guideBySlug(slug);
    if (!g) {
      toast('That build guide is not in this app yet.');
      return false;
    }
    if (g.classId && classById(g.classId)) STATE.classId = g.classId;
    var targets = arr(g.stats && g.stats.targets).slice().sort(function (a, b) { return int(a.level, 0) - int(b.level, 0); });
    var top = targets[targets.length - 1];
    if (top) {
      STATE.stats = {};
      var base = classBase();
      STATS.forEach(function (s) { STATE.stats[s] = clamp(int(top[s], base[s]), 1, MAX_STAT); });
    }
    ensureStats();

    GUIDE_GEAR = {};
    GUIDE_SLUG = g.slug || g.id;
    ['early', 'mid', 'late'].forEach(function (tier) {
      arr(g.gear && g.gear[tier]).forEach(function (id) { GUIDE_GEAR[id] = tier; });
    });
    var late = arr(g.gear && g.gear.late).filter(function (id) {
      var rec = ER.byId ? ER.byId(id) : null;
      return rec && ER.groupOf && ER.groupOf(id) === 'weapons';
    });
    if (late.length) STATE.compare = late.slice(0, 2);

    AR_CACHE = null;
    save();
    render();
    return true;
  }

  /* ------------------------------------------------------ tab search hook */
  /* builds.js may forward its search(q) here; the planner answers with the
     loadouts it holds, because nothing else in it is an entity the shell's own
     entity search would not already find. */
  function search(q) {
    var needle = String(q || '').toLowerCase().trim();
    if (!needle || !STATE) return [];
    var out = [];
    arr(STATE.loadouts).forEach(function (l) {
      if (String(l.name).toLowerCase().indexOf(needle) < 0) return;
      out.push({
        title: l.name,
        sub: 'Saved build - level ' + int(l.level, 0),
        icon: '\u2699',
        go: function () {
          applyLoadout(l.id);
          if (typeof ER.navigate === 'function') ER.navigate('builds', ['planner']);
        }
      });
    });
    return out;
  }

  /* =========================================================== RENDERING === */

  function mount(el) {
    HOST = el || HOST;
    if (!HOST) return;
    if (!STATE) STATE = readState();
    ensureStats();
    if (!ROOT || ROOT.parentNode !== HOST) {
      HOST.innerHTML = '';
      ROOT = document.createElement('div');
      ROOT.className = 'er-planner';
      HOST.appendChild(ROOT);
      wire(ROOT);
    }
    MOUNTED = true;
    render();
    loadCalc().then(function () {
      AR_CACHE = null;
      render();
    });
  }

  /* True while our rendered tree is still in the document. js/builds.js repaints
     its whole body on every route into #builds/planner, which throws away the
     node we mounted into and does NOT re-mount us (its plannerMounted latch is
     already true). It calls show() straight afterwards, so this is the hook
     where we notice we have been detached and re-attach to the fresh host. */
  function attached() {
    if (!ROOT) return false;
    if (typeof ROOT.isConnected === 'boolean') return ROOT.isConnected;
    return document.contains ? document.contains(ROOT) : true;
  }

  /* [data-planner-host] is js/builds.js's published slot for us. */
  function liveHost() {
    var el = document.querySelector('[data-planner-host]');
    if (el) return el;
    return HOST && attachedNode(HOST) ? HOST : null;
  }
  function attachedNode(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    return document.contains ? document.contains(el) : true;
  }

  function show(params) {
    var p = arr(params).slice();
    if (p[0] === 'planner') p = p.slice(1);
    var host = liveHost();
    if (host && (!attached() || ROOT.parentNode !== host)) mount(host);
    else if (!MOUNTED && HOST) mount(HOST);
    if (!p.length) return;
    if (p[0] === 's' || p[0] === 'code') {
      if (p[1] && applyShareCode(p[1])) {
        toast('Build loaded from a shared code.');
        render();
      } else {
        toast('That share code could not be read.');
      }
      return;
    }
    loadGuide(p[0]);
  }

  function render() {
    if (!ROOT) return;
    clearTimeout(RENDER_TIMER);
    RENDER_TIMER = setTimeout(paint, 0);
  }
  function renderNow() {
    clearTimeout(RENDER_TIMER);
    paint();
  }

  function paint() {
    if (!ROOT) return;
    ensureStats();
    var focus = document.activeElement;
    var focusKey = focus && ROOT.contains(focus) ? focus.getAttribute('data-keep') : null;
    var scroll = null;
    var rail = ROOT.querySelector('.erp-classrail');
    if (rail) scroll = rail.scrollLeft;

    ROOT.innerHTML =
      header() +
      classPanel() +
      statPanel() +
      loadPanel() +
      attackPanel() +
      comparePanel() +
      spellPanel() +
      scaduPanel() +
      loadoutPanel() +
      footNote();

    if (focusKey) {
      var again = ROOT.querySelector('[data-keep="' + focusKey.replace(/"/g, '') + '"]');
      if (again && typeof again.focus === 'function') {
        try {
          again.focus();
          if (again.setSelectionRange && again.value) again.setSelectionRange(again.value.length, again.value.length);
        } catch (e) {}
      }
    }
    if (scroll !== null) {
      var r2 = ROOT.querySelector('.erp-classrail');
      if (r2) r2.scrollLeft = scroll;
    }
  }

  /* ------------------------------------------------------------- header */

  function header() {
    var info = runeInfo();
    var c = currentClass();
    return '' +
      '<div class="erp-head">' +
      '<div class="erp-head-top">' +
      '<h2 class="erp-title">Build Planner</h2>' +
      '<span class="erp-save" id="erpSave" role="status" hidden></span>' +
      '</div>' +
      '<div class="erp-level">' +
      '<div class="erp-level-n"><span class="erp-level-label">Rune level</span><b>' + esc(String(level())) + '</b></div>' +
      '<div class="erp-level-meta">' +
      (info
        ? '<span><b>' + esc(fmtNum(info.spent)) + '</b> runes from ' + esc(c ? c.name : 'the start') + '</span>' +
          (info.toNext !== null ? '<span><b>' + esc(fmtNum(info.toNext)) + '</b> to the next level</span>' : '<span>maximum level</span>')
        : '<span class="erp-warn">the rune-cost table is not in this build</span>') +
      '</div>' +
      '</div>' +
      '</div>';
  }

  function footNote() {
    var m = mechanics();
    return '<p class="erp-foot">Attack power, scaling letters and requirement penalties are computed from the game\'s own '
      + 'regulation tables' + (m.gameVersion ? ' (version ' + esc(m.gameVersion) + ')' : '')
      + ', using the same maths as the open-source Elden Ring weapon calculator. Nothing here is an opinion - '
      + 'it is the number the game would show you.</p>';
  }

  /* ----------------------------------------------------------- section box */

  function section(id, title, sub, body, opts) {
    opts = opts || {};
    var open = STATE.ui.section[id];
    if (open === undefined) open = opts.openByDefault !== false;
    return '' +
      '<section class="erp-sec' + (open ? '' : ' closed') + '" data-sec="' + esc(id) + '">' +
      '<button class="erp-sec-head" type="button" data-toggle-sec="' + esc(id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="erp-sec-title">' + esc(title) + '</span>' +
      (sub ? '<span class="erp-sec-sub">' + esc(sub) + '</span>' : '') +
      '<span class="erp-sec-chev" aria-hidden="true"></span>' +
      '</button>' +
      '<div class="erp-sec-body"' + (open ? '' : ' hidden') + '>' + body + '</div>' +
      '</section>';
  }

  /* -------------------------------------------------------------- classes */

  function classPanel() {
    var list = classes().filter(function (c) { return srcOn(c.src); });
    if (!list.length) {
      return section('class', 'Starting class', null,
        '<p class="erp-empty">The class list has not been built into this app yet.</p>');
    }
    var cur = currentClass();
    var chips = list.map(function (c) {
      var on = cur && c.id === cur.id;
      return '<button class="erp-class' + (on ? ' on' : '') + '" type="button" data-class="' + esc(c.id) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
        + (c.icon ? '<img class="erp-class-ic" src="' + esc(asset(c.icon)) + '" alt="" loading="lazy" decoding="async" />' : '<span class="erp-class-ic ph" aria-hidden="true"></span>')
        + '<span class="erp-class-n">' + esc(c.name) + '</span>'
        + '<span class="erp-class-l">Lv ' + esc(String(int(c.level, 1))) + '</span>'
        + '</button>';
    }).join('');
    var note = cur && cur.goodFor
      ? '<p class="erp-class-note"><b>' + esc(cur.name) + '</b> - ' + esc(cur.goodFor)
        + (cur.desc ? '. ' + esc(String(cur.desc).replace(/\s+/g, ' ').trim()) : '') + '</p>'
      : '';
    return section('class', 'Starting class',
      cur ? cur.name + ' - level ' + int(cur.level, 1) : null,
      '<div class="erp-classrail">' + chips + '</div>' + note +
      '<p class="erp-hint">Changing class re-floors every stat to that class\'s starting values. Anything you had spent above them is kept.</p>');
  }

  /* ---------------------------------------------------------------- stats */

  function softCapsFor(stat) {
    var sc = mechanics().softCaps || {};
    return arr(sc[stat]).slice().sort(function (a, b) { return int(a.level, 0) - int(b.level, 0); });
  }

  function statRow(stat) {
    var base = classBase()[stat];
    var v = STATE.stats[stat];
    var caps = softCapsFor(stat);
    /* The bar, the soft-cap markers and the slider all measure from the class's
       STARTING value, not from 1: those points were never yours to spend, the
       slider cannot go below them, and a bar on a different scale from the
       thumb sitting under it reads as a bug. A cap below the class base is
       therefore already passed and is not drawn. */
    var span = Math.max(1, MAX_STAT - base);
    var pct = ((v - base) / span) * 100;

    var marks = caps.map(function (c) {
      var lv = int(c.level, 0);
      if (lv <= base || lv > MAX_STAT) return '';
      var left = ((lv - base) / span) * 100;
      var past = v >= lv;
      return '<span class="erp-cap' + (past ? ' past' : '') + '" style="left:' + (Math.round(left * 100) / 100) + '%"'
        + ' title="' + esc(c.label ? c.label + ' at ' + lv : 'soft cap at ' + lv) + '">'
        + '<i aria-hidden="true"></i><b>' + esc(String(lv)) + '</b></span>';
    }).join('');

    /* Compact on purpose: "first soft cap 18 - second soft cap 60 - hard cap 80"
       wraps onto a second line on a 390 px screen and shoves the row about.
       The full wording still lives on each marker's title. */
    var softLv = [];
    var hardLv = [];
    caps.forEach(function (c) {
      var lv = int(c.level, 0);
      if (!lv) return;
      if (/hard/i.test(String(c.label || ''))) hardLv.push(lv);
      else softLv.push(lv);
    });
    var capBits = [];
    if (softLv.length) capBits.push('soft ' + softLv.join('/'));
    if (hardLv.length) capBits.push('hard ' + hardLv.join('/'));
    var capLine = capBits.length ? esc(capBits.join(' \u00b7 ')) : 'no published cap';

    return '' +
      '<div class="erp-stat' + (v >= MAX_STAT ? ' maxed' : '') + '" data-stat="' + esc(stat) + '">' +
      '<div class="erp-stat-top">' +
      '<span class="erp-stat-name">' + esc(statName(stat)) + '</span>' +
      '<span class="erp-stat-caps">' + capLine + '</span>' +
      '</div>' +
      '<div class="erp-stat-ctl">' +
      '<button class="erp-step" type="button" data-step="' + esc(stat) + '" data-by="-1" aria-label="Lower ' + esc(statName(stat)) + '">&minus;</button>' +
      '<input class="erp-num" type="number" inputmode="numeric" min="' + base + '" max="' + MAX_STAT + '" value="' + v + '"' +
      ' data-num="' + esc(stat) + '" data-keep="num-' + esc(stat) + '" aria-label="' + esc(statName(stat)) + ' value" />' +
      '<button class="erp-step" type="button" data-step="' + esc(stat) + '" data-by="1" aria-label="Raise ' + esc(statName(stat)) + '">+</button>' +
      '</div>' +
      '<div class="erp-bar">' +
      '<span class="erp-bar-fill" style="width:' + (Math.round(pct * 100) / 100) + '%"></span>' +
      marks +
      '</div>' +
      '<input class="erp-range" type="range" min="' + base + '" max="' + MAX_STAT + '" value="' + v + '"' +
      ' data-range="' + esc(stat) + '" data-keep="range-' + esc(stat) + '" aria-label="' + esc(statName(stat)) + ' slider" />' +
      '</div>';
  }

  function statPanel() {
    var rows = STATS.map(statRow).join('');
    var attrs = arr(mechanics().attributes);
    var help = attrs.length
      ? '<p class="erp-hint">A soft cap is the point where the next point buys you noticeably less than the last one did. '
        + 'The markers on each bar are the caps the game\'s own scaling curves actually show - they are derived, not remembered.</p>'
      : '';
    return section('stats', 'Stats', 'level ' + level(), '<div class="erp-stats">' + rows + '</div>' + help);
  }

  /* --------------------------------------------------------- equip load */

  function armorBySlot(slot) {
    var id = STATE.armor[slot];
    if (!id || !ER.byId) return null;
    var rec = ER.byId(id);
    return rec && rec.slot === slot ? rec : null;
  }

  function loadPanel() {
    var pieces = armorPieces();
    var slots = ['head', 'chest', 'arms', 'legs'];
    var m = mechanics();

    if (!pieces.length) {
      return section('load', 'Weight and equip load', null,
        '<p class="erp-empty">Armour has not been built into this app yet, so there is nothing to weigh. '
        + 'The moment the armour set lands, this section fills itself in.</p>', { openByDefault: false });
    }

    var totalWeight = 0;
    var totalPoise = 0;
    var picked = 0;
    var rows = slots.map(function (slot) {
      var rec = armorBySlot(slot);
      if (rec) {
        picked++;
        totalWeight += Number(rec.weight) || 0;
        totalPoise += Number(rec.poise) || 0;
      }
      var options = pieces
        .filter(function (p) { return p.slot === slot && srcOn(p.src); })
        .sort(function (a, b) { return String(a.name) < String(b.name) ? -1 : 1; })
        .map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (rec && rec.id === p.id ? ' selected' : '') + '>'
            + esc(p.name) + ' (' + esc(fmtNum(p.weight)) + ')</option>';
        }).join('');
      return '<label class="erp-slot"><span class="erp-slot-n">' + esc(slot.charAt(0).toUpperCase() + slot.slice(1)) + '</span>'
        + '<select class="erp-select" data-armor="' + esc(slot) + '" data-keep="armor-' + esc(slot) + '">'
        + '<option value="">- none -</option>' + options + '</select></label>';
    }).join('');

    var weaponWeight = 0;
    arr(STATE.compare).forEach(function (id) {
      var rec = ER.byId ? ER.byId(id) : null;
      if (rec && rec.weight) weaponWeight += Number(rec.weight) || 0;
    });

    var loadLine;
    if (arr(m.equipLoad).length) {
      loadLine = '<p class="erp-hint">Load brackets come from the shipped equip-load table.</p>';
    } else {
      var c = currentClass();
      var startLoad = c && c.derived ? Number(c.derived.equipLoad) : null;
      loadLine = '<p class="erp-hint">The game\'s equip-load-per-Endurance table is a <b>known gap in this build\'s data</b> '
        + '(it is reported by name every time the data is refreshed), so this panel weighs your gear but will not guess a '
        + 'load percentage.' + (startLoad ? ' For scale, ' + esc(c.name) + ' starts with ' + esc(fmtNum(startLoad)) + ' equip load.' : '') + '</p>';
    }

    return section('load', 'Weight and equip load',
      picked ? fmtNum(Math.round(totalWeight * 10) / 10) + ' armour weight' : 'nothing equipped',
      '<div class="erp-slots">' + rows + '</div>' +
      '<div class="erp-loadsum">' +
      '<div><span>Armour weight</span><b>' + esc(fmtNum(Math.round(totalWeight * 10) / 10)) + '</b></div>' +
      '<div><span>Armour poise</span><b>' + esc(fmtNum(Math.round(totalPoise * 10) / 10)) + '</b></div>' +
      '<div><span>Compared weapons</span><b>' + esc(fmtNum(Math.round(weaponWeight * 10) / 10)) + '</b></div>' +
      '<div class="tot"><span>Total carried</span><b>' + esc(fmtNum(Math.round((totalWeight + weaponWeight) * 10) / 10)) + '</b></div>' +
      '</div>' + loadLine, { openByDefault: false });
  }

  /* ------------------------------------------------------- attack power */

  function affinityOptions() {
    var seen = {};
    var out = [{ slug: 'auto', name: 'Each weapon\'s own' }];
    if (!calcReady()) return out;
    var list = weapons();
    for (var i = 0; i < list.length && i < 200; i++) {
      var affs = ER.ar.affinitiesFor(list[i]);
      for (var j = 0; j < affs.length; j++) {
        if (affs[j].id < 0) continue;
        if (seen[affs[j].slug]) continue;
        seen[affs[j].slug] = 1;
        out.push({ slug: affs[j].slug, name: affs[j].name });
      }
    }
    return out;
  }

  function weaponClasses() {
    var seen = {};
    weapons().forEach(function (w) {
      if (!srcOn(w.src)) return;
      if (w.class) seen[w.class] = 1;
    });
    return Object.keys(seen).sort();
  }

  function scoredWeapons() {
    var q = String(STATE.ui.q || '').toLowerCase().trim();
    var cls = STATE.ui.cls || '';
    var only = !!STATE.ui.onlyWieldable;
    var list = [];
    weapons().forEach(function (w) {
      if (!srcOn(w.src)) return;
      if (cls && w.class !== cls) return;
      if (q && String(w.name).toLowerCase().indexOf(q) < 0) return;
      var r = arOf(w);
      /* Before the regulation payload lands there is no honest requirement
         answer, so the "only what I can wield" filter deliberately does not
         pretend to have one - the list is simply not filtered yet. */
      var unmet = r ? r.unmet : [];
      if (only && r && unmet.length) return;
      list.push({ rec: w, ar: r, unmet: unmet, guide: GUIDE_GEAR[w.id] || null });
    });
    var sort = STATE.ui.sort;
    list.sort(function (a, b) {
      if (a.guide && !b.guide) return -1;
      if (!a.guide && b.guide) return 1;
      if (sort === 'name') return String(a.rec.name) < String(b.rec.name) ? -1 : 1;
      if (sort === 'weight') return (Number(a.rec.weight) || 0) - (Number(b.rec.weight) || 0);
      var av = a.ar && a.ar.total !== null ? a.ar.total : -1;
      var bv = b.ar && b.ar.total !== null ? b.ar.total : -1;
      if (bv !== av) return bv - av;
      return String(a.rec.name) < String(b.rec.name) ? -1 : 1;
    });
    return list;
  }

  function arRow(item) {
    var w = item.rec;
    var r = item.ar;
    var total = r && r.total !== null ? floor(r.total) : null;
    var split = r ? Object.keys(r.byType).filter(function (k) { return r.byType[k] > 0; }) : [];
    var letters = r && r.scaling
      ? SCALE_STATS.filter(function (s) { return r.scaling[s].letter; })
        .map(function (s) {
          return '<span class="erp-let"><i>' + esc(statName(s).slice(0, 3)) + '</i>' + esc(r.scaling[s].letter) + '</span>';
        }).join('')
      : '';
    var inCompare = arr(STATE.compare).indexOf(w.id) >= 0;
    return '' +
      '<li class="erp-w' + (item.unmet.length ? ' unmet' : '') + (item.guide ? ' guided' : '') + '">' +
      '<button class="erp-w-main" type="button" data-weapon="' + esc(w.id) + '">' +
      (w.icon ? '<img class="erp-w-ic" src="' + esc(asset(w.icon)) + '" alt="" loading="lazy" decoding="async" />' : '<span class="erp-w-ic ph" aria-hidden="true"></span>') +
      '<span class="erp-w-txt">' +
      '<span class="erp-w-n">' + esc(w.name) +
      (item.guide ? '<span class="erp-tag guide">' + esc(item.guide) + '</span>' : '') +
      (w.src === 'sote' ? '<span class="erp-tag sote">SotE</span>' : '') + '</span>' +
      '<span class="erp-w-sub">' + esc(w.class || '') +
      (r && r.affinity && r.affinity.id > 0 ? ' &middot; ' + esc(r.affinity.name) : '') +
      (r ? ' &middot; +' + r.upgradeLevel : '') +
      '</span>' +
      (letters ? '<span class="erp-w-let">' + letters + '</span>' : '') +
      '</span>' +
      '<span class="erp-w-ar">' +
      (total === null ? '<b class="pending">-</b>' : '<b>' + esc(String(total)) + '</b>') +
      (split.length > 1 ? '<i>' + split.map(function (k) { return esc(DMG_LABEL[k]); }).join(' + ') + '</i>' : '<i>AR</i>') +
      (item.unmet.length ? '<em class="erp-unmet">' + esc(item.unmet.map(function (s) { return statName(s).slice(0, 3); }).join(' ')) + ' short</em>' : '') +
      '</span>' +
      '</button>' +
      '<button class="erp-w-cmp' + (inCompare ? ' on' : '') + '" type="button" data-compare="' + esc(w.id) + '"' +
      ' aria-pressed="' + (inCompare ? 'true' : 'false') + '" aria-label="Compare ' + esc(w.name) + '">&#8646;</button>' +
      '</li>';
  }

  function attackPanel() {
    var list = weapons();
    if (!list.length) {
      return section('attack', 'Attack power at your stats', null,
        '<p class="erp-empty">No weapons in this build yet.</p>');
    }
    if (CALC_STATE === 'failed') {
      return section('attack', 'Attack power at your stats', null,
        '<p class="erp-empty err">' + esc(CALC_WHY) + ' Everything else on this page still works.</p>' +
        '<button class="erp-btn" type="button" data-retry-calc>Try loading it again</button>');
    }

    var scored = scoredWeapons();
    var shown = scored.slice(0, LIST_SHOWN);
    var affs = affinityOptions();
    var maxUp = STATE.upgrade === null ? 25 : STATE.upgrade;

    var controls = '' +
      '<div class="erp-ctl-grid">' +
      '<label class="erp-field"><span>Upgrade</span>' +
      '<select class="erp-select" data-upgrade data-keep="upgrade">' +
      '<option value=""' + (STATE.upgrade === null ? ' selected' : '') + '>As high as it goes</option>' +
      (function () {
        var o = '';
        for (var i = 0; i <= 25; i++) o += '<option value="' + i + '"' + (STATE.upgrade === i ? ' selected' : '') + '>+' + i + '</option>';
        return o;
      })() +
      '</select></label>' +
      '<label class="erp-field"><span>Affinity</span>' +
      '<select class="erp-select" data-affinity data-keep="affinity">' +
      affs.map(function (a) {
        return '<option value="' + esc(a.slug) + '"' + (STATE.affinity === a.slug ? ' selected' : '') + '>' + esc(a.name) + '</option>';
      }).join('') +
      '</select></label>' +
      '<label class="erp-field"><span>Sort by</span>' +
      '<select class="erp-select" data-sort data-keep="sort">' +
      ['ar:Attack power', 'name:Name', 'weight:Weight'].map(function (p) {
        var bits = p.split(':');
        return '<option value="' + bits[0] + '"' + (STATE.ui.sort === bits[0] ? ' selected' : '') + '>' + esc(bits[1]) + '</option>';
      }).join('') +
      '</select></label>' +
      '<label class="erp-field"><span>Type</span>' +
      '<select class="erp-select" data-wclass data-keep="wclass">' +
      '<option value="">All types</option>' +
      weaponClasses().map(function (c) {
        return '<option value="' + esc(c) + '"' + (STATE.ui.cls === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') +
      '</select></label>' +
      '</div>' +
      '<div class="erp-ctl-row">' +
      '<input class="erp-search" type="search" placeholder="Filter these weapons" value="' + esc(STATE.ui.q) + '"' +
      ' data-wq data-keep="wq" aria-label="Filter weapons by name" autocomplete="off" spellcheck="false" />' +
      '<button class="erp-toggle' + (STATE.ui.onlyWieldable ? ' on' : '') + '" type="button" data-only aria-pressed="' + (STATE.ui.onlyWieldable ? 'true' : 'false') + '">Only what I can wield</button>' +
      '<button class="erp-toggle' + (STATE.twoHanding ? ' on' : '') + '" type="button" data-twohand aria-pressed="' + (STATE.twoHanding ? 'true' : 'false') + '">Two-handed</button>' +
      '</div>';

    var body;
    if (!calcReady()) {
      body = '<p class="erp-loading">Reading the game\'s attack tables' + (CALC_STATE === 'loading' ? '...' : '') + '</p>';
    } else if (!scored.length) {
      body = '<p class="erp-empty">Nothing matches those filters. ' +
        (STATE.ui.onlyWieldable ? 'Try turning off "only what I can wield" - your stats may be short by a point or two.' : '') + '</p>';
    } else {
      body = '<ul class="erp-wlist">' + shown.map(arRow).join('') + '</ul>' +
        (scored.length > shown.length
          ? '<button class="erp-btn more" type="button" data-more>Show ' + Math.min(LIST_PAGE, scored.length - shown.length) + ' more of ' + fmtNum(scored.length) + '</button>'
          : '<p class="erp-count">' + esc(fmtNum(scored.length)) + ' armament' + (scored.length === 1 ? '' : 's') + ' shown</p>');
    }

    var sub = calcReady()
      ? scored.length + ' shown' + (STATE.twoHanding ? ', two-handed' : '') + (maxUp !== 25 && STATE.upgrade !== null ? ', at +' + STATE.upgrade : '')
      : 'loading';

    return section('attack', 'Attack power at your stats', sub, controls + body);
  }

  /* ------------------------------------------------------------- compare */

  function compareCell(id) {
    var rec = ER.byId ? ER.byId(id) : null;
    if (!rec) return '<div class="erp-cmp-cell empty"><p>Pick a weapon from the list above.</p></div>';
    var r = arOf(rec);
    var rows = '';
    if (r && r.ready) {
      rows += cmpRow('Total AR', String(floor(r.total)), true);
      ER.ar.DAMAGE_KEYS.forEach(function (k) {
        if (r.byType[k] > 0) rows += cmpRow(DMG_LABEL[k], String(floor(r.byType[k])));
      });
      ER.ar.STATUS_KEYS.forEach(function (k) {
        if (r.status[k] > 0) rows += cmpRow(STATUS_LABEL[k], String(floor(r.status[k])));
      });
      rows += cmpRow('Upgrade', '+' + r.upgradeLevel + ' of +' + r.maxUpgrade);
      SCALE_STATS.forEach(function (s) {
        if (r.scaling[s].letter) rows += cmpRow(statName(s) + ' scaling', r.scaling[s].letter);
      });
      SCALE_STATS.forEach(function (s) {
        if (r.reqs[s] > 0) {
          rows += cmpRow(statName(s) + ' needed', String(r.reqs[s]), false, r.unmet.indexOf(s) >= 0);
        }
      });
    } else {
      rows = cmpRow('Attack power', 'not loaded yet');
    }
    if (rec.weight) rows += cmpRow('Weight', fmtNum(rec.weight));
    if (rec.critical) rows += cmpRow('Critical', String(rec.critical));

    return '<div class="erp-cmp-cell">' +
      '<div class="erp-cmp-head">' +
      (rec.icon ? '<img src="' + esc(asset(rec.icon)) + '" alt="" loading="lazy" decoding="async" />' : '') +
      '<span>' + esc(rec.name) + '</span>' +
      '<button class="erp-cmp-x" type="button" data-uncompare="' + esc(rec.id) + '" aria-label="Remove ' + esc(rec.name) + ' from the comparison">&times;</button>' +
      '</div>' +
      '<dl class="erp-cmp-rows">' + rows + '</dl>' +
      '</div>';
  }
  function cmpRow(k, v, strong, bad) {
    return '<div class="erp-cmp-row' + (strong ? ' strong' : '') + (bad ? ' bad' : '') + '">'
      + '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>';
  }

  function comparePanel() {
    var ids = arr(STATE.compare).slice(0, 2);
    var body = '<div class="erp-cmp">' + compareCell(ids[0]) + compareCell(ids[1]) + '</div>';
    if (ids.length && ids[0] && ids[1] && calcReady()) {
      var a = ER.byId(ids[0]);
      var b = ER.byId(ids[1]);
      var ra = a ? arOf(a) : null;
      var rb = b ? arOf(b) : null;
      if (ra && rb && ra.ready && rb.ready) {
        var diff = floor(ra.total) - floor(rb.total);
        body += '<p class="erp-cmp-verdict">' +
          (diff === 0
            ? 'Dead level on raw attack power at these stats.'
            : esc((diff > 0 ? a.name : b.name)) + ' hits for <b>' + Math.abs(diff) + '</b> more at these stats.') +
          ' Raw AR is not the whole story - reach, speed, the ash of war and status build-up all matter, and none of them are in this number.</p>';
      }
    }
    return section('compare', 'Compare two weapons',
      ids.filter(Boolean).length + ' of 2 picked', body, { openByDefault: false });
  }

  /* -------------------------------------------------------------- spells */

  function spellPanel() {
    var list = spells();
    if (!list.length) {
      return section('spells', 'Spells you can cast', null,
        '<p class="erp-empty">Spells have not been built into this app yet.</p>', { openByDefault: false });
    }
    var castable = [];
    var locked = [];
    list.forEach(function (s) {
      if (!srcOn(s.src)) return;
      var need = [];
      ['int', 'fai', 'arc'].forEach(function (a) {
        var r = int(s.reqs && s.reqs[a], 0);
        if (r > 0 && STATE.stats[a] < r) need.push(a + ' ' + r);
      });
      (need.length ? locked : castable).push({ rec: s, need: need });
    });
    castable.sort(function (a, b) { return String(a.rec.name) < String(b.rec.name) ? -1 : 1; });
    locked.sort(function (a, b) { return String(a.rec.name) < String(b.rec.name) ? -1 : 1; });

    function spellRow(x) {
      var s = x.rec;
      return '<li class="erp-sp' + (x.need.length ? ' locked' : '') + '">' +
        '<button type="button" data-entity-open="' + esc(s.id) + '">' +
        (s.icon ? '<img src="' + esc(asset(s.icon)) + '" alt="" loading="lazy" decoding="async" />' : '<span class="erp-w-ic ph" aria-hidden="true"></span>') +
        '<span class="erp-sp-txt"><b>' + esc(s.name) + '</b><i>' + esc(s.school || s.type || '') +
        (s.fp ? ' &middot; ' + esc(String(s.fp)) + ' FP' : '') + (s.slots ? ' &middot; ' + esc(String(s.slots)) + ' slot' + (s.slots > 1 ? 's' : '') : '') + '</i></span>' +
        (x.need.length ? '<em>' + esc(x.need.join(', ')) + '</em>' : '') +
        '</button></li>';
    }

    var body = '<p class="erp-hint">' + esc(String(castable.length)) + ' of ' + esc(String(castable.length + locked.length))
      + ' spells are within reach at these stats.</p>' +
      '<ul class="erp-splist">' + castable.slice(0, 60).map(spellRow).join('') + '</ul>' +
      (locked.length ? '<h4 class="erp-subh">Just out of reach</h4><ul class="erp-splist">'
        + locked.slice(0, 20).map(spellRow).join('') + '</ul>' : '');
    return section('spells', 'Spells you can cast', castable.length + ' castable', body, { openByDefault: false });
  }

  /* ----------------------------------------------------------- scadutree */

  function scaduPanel() {
    if (!ER.modes || !ER.modes.sote) return '';
    var table = arr(mechanics().scadutree);
    if (!table.length) {
      return section('scadu', 'Scadutree Blessing', null,
        '<p class="erp-empty">The blessing table is not in this build\'s data.</p>');
    }
    var lvl = clamp(STATE.scadutree, 0, table.length - 1);
    var row = table[lvl] || table[0];
    var dealt = Math.round((Number(row.damageDealt) || 1) * 1000) / 10;
    var taken = Math.round((Number(row.damageReceived) || 1) * 1000) / 10;
    return section('scadu', 'Scadutree Blessing', 'level ' + lvl,
      '<p class="erp-hint">In the Land of Shadow your rune level barely matters. This is the stat that does: '
      + 'fragments raise the damage you deal and cut the damage you take, and nothing else in the expansion moves those numbers as much.</p>' +
      '<div class="erp-scadu">' +
      '<div class="erp-scadu-n"><b>' + esc(String(lvl)) + '</b><span>blessing level</span></div>' +
      '<input class="erp-range" type="range" min="0" max="' + (table.length - 1) + '" value="' + lvl + '" data-scadu aria-label="Scadutree blessing level" />' +
      '</div>' +
      '<div class="erp-loadsum">' +
      '<div><span>Damage you deal</span><b>' + esc(String(dealt)) + '%</b></div>' +
      '<div><span>Damage you take</span><b>' + esc(String(taken)) + '%</b></div>' +
      '<div><span>Fragments to here</span><b>' + esc(fmtNum(row.totalFragments)) + '</b></div>' +
      (row.softCap ? '<div class="tot"><span>Soft cap</span><b>yes</b></div>' : '') +
      '</div>');
  }

  /* ------------------------------------------------------------ loadouts */

  function loadoutPanel() {
    var list = arr(STATE.loadouts);
    var rows = list.length
      ? '<ul class="erp-lo">' + list.map(function (l) {
        return '<li><button class="erp-lo-load" type="button" data-loadout="' + esc(l.id) + '">' +
          '<b>' + esc(l.name) + '</b><i>level ' + esc(String(int(l.level, 0))) +
          (l.className ? ' &middot; ' + esc(l.className) : '') + '</i></button>' +
          '<button class="erp-lo-del" type="button" data-delloadout="' + esc(l.id) + '" aria-label="Delete ' + esc(l.name) + '">&times;</button></li>';
      }).join('') + '</ul>'
      : '<p class="erp-empty">No saved builds yet. Save one and it stays on this device.</p>';

    return section('loadouts', 'Saved builds and sharing', list.length + ' saved',
      '<div class="erp-ctl-row">' +
      '<input class="erp-search" type="text" placeholder="Name this build" data-loname data-keep="loname" aria-label="Name for the build you are saving" autocomplete="off" />' +
      '<button class="erp-btn" type="button" data-saveloadout>Save</button>' +
      '</div>' + rows +
      '<div class="erp-share">' +
      '<button class="erp-btn" type="button" data-sharecode>Copy a share link</button>' +
      '<p class="erp-hint">The link carries your class, your eight stats and the upgrade and affinity you are looking at - '
      + 'nothing else. Anyone who opens it lands on this planner with your build already set up.</p>' +
      '</div>', { openByDefault: false });
  }

  function applyLoadout(id) {
    var list = arr(STATE.loadouts);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var l = list[i];
      if (l.classId && classById(l.classId)) STATE.classId = l.classId;
      if (l.stats) {
        STATE.stats = {};
        STATS.forEach(function (s) { STATE.stats[s] = clamp(int(l.stats[s], 1), 1, MAX_STAT); });
      }
      STATE.upgrade = l.upgrade === null || l.upgrade === undefined ? null : clamp(int(l.upgrade, 0), 0, 25);
      STATE.affinity = l.affinity || 'auto';
      STATE.twoHanding = !!l.twoHanding;
      if (l.armor) {
        ['head', 'chest', 'arms', 'legs'].forEach(function (slot) {
          STATE.armor[slot] = typeof l.armor[slot] === 'string' ? l.armor[slot] : null;
        });
      }
      ensureStats();
      AR_CACHE = null;
      save();
      renderNow();
      toast('Loaded "' + l.name + '".');
      return true;
    }
    return false;
  }

  function saveLoadout(name) {
    var n = String(name || '').trim().slice(0, 48);
    if (!n) {
      toast('Give the build a name first.');
      return;
    }
    var c = currentClass();
    var entry = {
      id: 'lo-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 4096).toString(36),
      name: n,
      savedAt: new Date().toISOString(),
      level: level(),
      classId: STATE.classId,
      className: c ? c.name : null,
      stats: JSON.parse(JSON.stringify(STATE.stats)),
      upgrade: STATE.upgrade,
      affinity: STATE.affinity,
      twoHanding: STATE.twoHanding,
      armor: JSON.parse(JSON.stringify(STATE.armor))
    };
    var list = arr(STATE.loadouts).filter(function (l) { return l.name !== n; });
    list.unshift(entry);
    STATE.loadouts = list.slice(0, 40);
    save();
    renderNow();
    toast('Saved "' + n + '".');
  }

  /* -------------------------------------------------------- weapon sheet */

  function openWeaponSheet(id) {
    var rec = ER.byId ? ER.byId(id) : null;
    if (!rec) return;
    if (!calcReady()) {
      if (typeof ER.openEntity === 'function') ER.openEntity(id);
      return;
    }
    var r = arOf(rec);
    var lines = '';
    if (r && r.ready) {
      lines += '<div class="erp-sheet-ar"><b>' + floor(r.total) + '</b><span>attack power at your stats, +' + r.upgradeLevel
        + (r.affinity && r.affinity.id > 0 ? ', ' + esc(r.affinity.name) : '') + (r.twoHanding ? ', two-handed' : '') + '</span></div>';
      lines += '<dl class="erp-cmp-rows">';
      ER.ar.DAMAGE_KEYS.forEach(function (k) {
        if (r.byType[k] > 0) {
          lines += cmpRow(DMG_LABEL[k], floor(r.byType[k]) + '  (' + floor(r.base[k]) + ' base + ' + floor(r.bonus[k]) + ' from stats)');
        }
      });
      ER.ar.STATUS_KEYS.forEach(function (k) {
        if (r.status[k] > 0) lines += cmpRow(STATUS_LABEL[k], String(floor(r.status[k])));
      });
      lines += '</dl>';
      if (r.unmet.length) {
        lines += '<p class="erp-sheet-warn">You are short on ' +
          esc(r.unmet.map(statName).join(' and ')) +
          '. Every damage type that scales with '
          + (r.unmet.length > 1 ? 'those stats' : 'that stat') + ' loses 40% flat - that is why '
          + (r.penalised.length ? esc(r.penalised.map(function (k) { return DMG_LABEL[k]; }).join(' and ')) + ' looks' : 'the number looks')
          + ' so poor. Meeting the requirement exactly is enough; there is no bonus for going past it beyond normal scaling.</p>';
      }
      var scal = SCALE_STATS.filter(function (s) { return r.scaling[s].letter; });
      if (scal.length) {
        lines += '<h4 class="erp-subh">Scaling at +' + r.upgradeLevel + '</h4><dl class="erp-cmp-rows">';
        scal.forEach(function (s) {
          lines += cmpRow(statName(s), r.scaling[s].letter + '  (' + Math.round(r.scaling[s].value * 100) + '%)');
        });
        lines += '</dl>';
      }
      if (r.spellScaling) {
        lines += '<h4 class="erp-subh">Spell scaling</h4><dl class="erp-cmp-rows">';
        Object.keys(r.spellScaling).forEach(function (k) {
          lines += cmpRow(DMG_LABEL[k], String(Math.round(r.spellScaling[k])));
        });
        lines += '</dl>';
      }
    } else {
      lines = '<p class="erp-empty">' + esc((r && r.why) || 'No attack table for this armament.') + '</p>';
    }

    var actions = [
      {
        label: arr(STATE.compare).indexOf(rec.id) >= 0 ? 'Remove from compare' : 'Add to compare',
        onClick: function () {
          toggleCompare(rec.id);
          ER.sheet.close();
        }
      }
    ];
    if (typeof ER.openEntity === 'function') {
      actions.push({ label: 'Full entry', onClick: function () { ER.openEntity(rec.id); } });
    }
    ER.sheet.open({
      title: rec.name,
      sub: esc(rec.class || 'Armament'),
      icon: rec.icon ? '<img class="erp-sheet-ic" src="' + esc(asset(rec.icon)) + '" alt="" />' : '',
      html: lines,
      actions: actions,
      key: 'planner:' + rec.id
    });
  }

  function toggleCompare(id) {
    var list = arr(STATE.compare).slice();
    var at = list.indexOf(id);
    if (at >= 0) list.splice(at, 1);
    else {
      list.push(id);
      if (list.length > 2) list.shift();
    }
    STATE.compare = list;
    save();
    renderNow();
  }

  /* ------------------------------------------------------------- wiring */

  function setStat(stat, value) {
    var base = classBase()[stat];
    var v = clamp(int(value, base), base, MAX_STAT);
    if (STATE.stats[stat] === v) return;
    STATE.stats[stat] = v;
    AR_CACHE = null;
    save();
  }

  /* The half-dozen things that must track a slider in real time, done by hand
     so the expensive parts (487 attack-power rows) can wait for the release. */
  function liveStatUpdate(stat, rangeEl) {
    if (!ROOT) return;
    var v = STATE.stats[stat];
    if (rangeEl && Number(rangeEl.value) !== v) rangeEl.value = v;
    var box = ROOT.querySelector('[data-num="' + stat + '"]');
    if (box) box.value = v;
    var wrap = rangeEl && rangeEl.closest ? rangeEl.closest('.erp-stat') : ROOT.querySelector('.erp-stat[data-stat="' + stat + '"]');
    if (wrap) {
      var base = classBase()[stat];
      var span = Math.max(1, MAX_STAT - base);
      var fill = wrap.querySelector('.erp-bar-fill');
      if (fill) fill.style.width = (((v - base) / span) * 100) + '%';
      qsa('.erp-cap', wrap).forEach(function (cap) {
        var at = parseInt((cap.querySelector('b') || {}).textContent, 10);
        if (isFinite(at)) cap.classList.toggle('past', v >= at);
      });
      wrap.classList.toggle('maxed', v >= MAX_STAT);
    }
    var lvl = ROOT.querySelector('.erp-level-n b');
    if (lvl) lvl.textContent = String(level());
    var info = runeInfo();
    var meta = ROOT.querySelector('.erp-level-meta');
    if (meta && info) {
      var c = currentClass();
      meta.innerHTML = '<span><b>' + esc(fmtNum(info.spent)) + '</b> runes from ' + esc(c ? c.name : 'the start') + '</span>'
        + (info.toNext !== null ? '<span><b>' + esc(fmtNum(info.toNext)) + '</b> to the next level</span>' : '<span>maximum level</span>');
    }
    var attack = ROOT.querySelector('.erp-sec[data-sec="attack"]');
    if (attack) attack.classList.add('stale');
  }

  function wire(root) {
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var el;

      if ((el = t.closest('[data-toggle-sec]'))) {
        var sid = el.getAttribute('data-toggle-sec');
        var open = STATE.ui.section[sid];
        if (open === undefined) open = true;
        STATE.ui.section[sid] = !open;
        save();
        renderNow();
        return;
      }
      if ((el = t.closest('[data-class]'))) {
        var cid = el.getAttribute('data-class');
        if (cid !== STATE.classId) {
          STATE.classId = cid;
          ensureStats();
          AR_CACHE = null;
          save();
          renderNow();
        }
        return;
      }
      if ((el = t.closest('[data-step]'))) {
        setStat(el.getAttribute('data-step'), STATE.stats[el.getAttribute('data-step')] + int(el.getAttribute('data-by'), 0));
        renderNow();
        return;
      }
      if ((el = t.closest('[data-only]'))) {
        STATE.ui.onlyWieldable = !STATE.ui.onlyWieldable;
        LIST_SHOWN = LIST_PAGE;
        save();
        renderNow();
        return;
      }
      if ((el = t.closest('[data-twohand]'))) {
        STATE.twoHanding = !STATE.twoHanding;
        AR_CACHE = null;
        save();
        renderNow();
        return;
      }
      if ((el = t.closest('[data-more]'))) {
        LIST_SHOWN += LIST_PAGE;
        renderNow();
        return;
      }
      if ((el = t.closest('[data-retry-calc]'))) {
        CALC_PROMISE = null;
        CALC_STATE = 'idle';
        loadCalc().then(function () {
          AR_CACHE = null;
          renderNow();
        });
        renderNow();
        return;
      }
      if ((el = t.closest('[data-compare]'))) {
        toggleCompare(el.getAttribute('data-compare'));
        return;
      }
      if ((el = t.closest('[data-uncompare]'))) {
        toggleCompare(el.getAttribute('data-uncompare'));
        return;
      }
      if ((el = t.closest('[data-weapon]'))) {
        openWeaponSheet(el.getAttribute('data-weapon'));
        return;
      }
      if ((el = t.closest('[data-entity-open]'))) {
        if (typeof ER.openEntity === 'function') ER.openEntity(el.getAttribute('data-entity-open'));
        return;
      }
      if ((el = t.closest('[data-loadout]'))) {
        applyLoadout(el.getAttribute('data-loadout'));
        return;
      }
      if ((el = t.closest('[data-delloadout]'))) {
        var did = el.getAttribute('data-delloadout');
        STATE.loadouts = arr(STATE.loadouts).filter(function (l) { return l.id !== did; });
        save();
        renderNow();
        return;
      }
      if ((el = t.closest('[data-saveloadout]'))) {
        var field = root.querySelector('[data-loname]');
        saveLoadout(field ? field.value : '');
        return;
      }
      if ((el = t.closest('[data-sharecode]'))) {
        copyShareLink();
        return;
      }
    });

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var stat = t.getAttribute('data-range');
      if (stat) {
        /* Do NOT repaint mid-drag: rebuilding the DOM under a finger cancels
           the drag on touch and steals focus on desktop. Update the cheap live
           parts only, mark the attack list stale, and repaint on release. */
        setStat(stat, t.value);
        liveStatUpdate(stat, t);
        return;
      }
      if (t.hasAttribute('data-wq')) {
        STATE.ui.q = t.value;
        LIST_SHOWN = LIST_PAGE;
        save();
        render();
        return;
      }
      if (t.hasAttribute('data-scadu')) {
        STATE.scadutree = int(t.value, 0);
        save();
        render();
      }
    });

    root.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-range')) {
        renderNow();
        return;
      }
      var stat = t.getAttribute('data-num');
      if (stat) {
        setStat(stat, t.value);
        renderNow();
        return;
      }
      if (t.hasAttribute('data-upgrade')) {
        STATE.upgrade = t.value === '' ? null : int(t.value, 0);
        AR_CACHE = null;
        save();
        renderNow();
        return;
      }
      if (t.hasAttribute('data-affinity')) {
        STATE.affinity = t.value || 'auto';
        AR_CACHE = null;
        save();
        renderNow();
        return;
      }
      if (t.hasAttribute('data-sort')) {
        STATE.ui.sort = t.value;
        LIST_SHOWN = LIST_PAGE;
        save();
        renderNow();
        return;
      }
      if (t.hasAttribute('data-wclass')) {
        STATE.ui.cls = t.value;
        LIST_SHOWN = LIST_PAGE;
        save();
        renderNow();
        return;
      }
      var slot = t.getAttribute('data-armor');
      if (slot) {
        STATE.armor[slot] = t.value || null;
        save();
        renderNow();
      }
    });
  }

  function copyShareLink() {
    var code = shareCode();
    if (!code) {
      toast('This browser cannot build a share code.');
      return;
    }
    var base = String(location.href).split('#')[0];
    var url = base + '#builds/planner/s/' + code;
    var done = function () { toast('Share link copied.'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url, done); });
        return;
      }
    } catch (e) {}
    fallbackCopy(url, done);
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      toast('Could not copy - the link is ' + text);
    }
  }

  /* ------------------------------------------------- DLC mode + fallback */

  if (typeof ER.onModeChange === 'function') {
    ER.onModeChange(function () {
      AR_CACHE = null;
      if (MOUNTED) render();
    });
  }

  /* The takeover described in the header. It only ever fires while the Builds
     tab is showing the SHELL'S OWN placeholder, which stops existing the moment
     js/builds.js registers a real implementation. */
  function fallbackHost() {
    if (MOUNTED) return;
    if (typeof ER.currentTab === 'function' && ER.currentTab() !== 'builds') return;
    var pane = document.querySelector('[data-pane="builds"]');
    if (!pane) return;
    /* Fire ONLY on the shell's own untouched placeholder (app.js renders a
       single .soon-panel whose heading is the tab label). js/builds.js has its
       own .soon-panel for other reasons, always nested inside its chrome, so
       requiring the pane to hold exactly that one node keeps this from ever
       hijacking a Builds tab that is working. */
    if (pane.children.length !== 1) return;
    var only = pane.firstElementChild;
    if (!only || !only.classList || !only.classList.contains('soon-panel')) return;
    var h = only.querySelector('.soon-h');
    if (!h || h.textContent.replace(/\s+/g, ' ').trim() !== 'Builds') return;
    var wrap = document.createElement('div');
    wrap.className = 'erp-standalone';
    wrap.innerHTML = '<p class="erp-standalone-note">The build guides are not in this build yet. '
      + 'The planner below is complete and works on its own.</p>';
    pane.innerHTML = '';
    pane.appendChild(wrap);
    var host = document.createElement('div');
    wrap.appendChild(host);
    mount(host);
    var parts = String(location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'builds') show(parts.slice(1));
  }

  function scheduleFallback() {
    setTimeout(fallbackHost, 0);
  }
  if (ER.ready && typeof ER.ready.then === 'function') {
    ER.ready.then(scheduleFallback, function () {});
  }
  window.addEventListener('hashchange', scheduleFallback);
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('[data-tab="builds"]')) scheduleFallback();
  });

  /* State is read at load, not at mount, so ER.planner.stats() answers
     correctly for any lane that asks before the Builds tab is ever opened. */
  STATE = readState();
  ensureStats();
})();
