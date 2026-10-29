/* app.js - the Elden Ring companion shell and the whole window.ER API.
 *
 * OWNED BY: P3 L5 (shell + Start + Wiki). FILE FENCE: this file, js/wiki.js,
 * js/start.js, index.html, css/style.css, css/start.css, css/wiki.css.
 *
 * WHAT LIVES HERE
 *   - the ER namespace every other lane codes against (see PLAN.md section 12)
 *   - the data loader (21 files) with per-file error rendering
 *   - the id index (ER.byId / ER.groupOf) over every dataset that has ids
 *   - the DLC mode engine (Shadow of the Erdtree), shaped after Terraria's
 *     MOD_DEFS / srcOn / applyMode so the picker mods will reuse is already here
 *   - ER.prefs over the single elden_prefs_v1 blob, 300 ms debounced, with a
 *     visible save-state pill
 *   - the bottom sheet (dvh, scroll-locked, backdrop / Escape / browser-back)
 *   - the tab registry + the NATIVE hash router (registry nativeHashRouting:true)
 *   - the global search that aggregates entities, glossary and every tab's own
 *     search(q)
 *   - the freshness stamp, the attribution line, the warm-sprites post and the
 *     one service-worker registration literal the island registry neuters
 *
 * TWO WORLDS. The app runs standalone (python -m http.server) AND mounted in
 * the fiiiish-app island shell. Under the shell the <head> is discarded and
 * #topbar / #siteFoot are stripped, so every lookup for #shareBtn, #patchPill
 * and #footNote is null-guarded and declared in registry.strippedIdsOk. Mode is
 * stamped on <html>, <body> AND the mount node, because the shell's PostCSS
 * pass collapses body[data-mode] onto its own mount selector.
 *
 * STYLE. Classic script, ES2019, ASCII only, no modules, no bundler. Every
 * value interpolated into HTML goes through esc(). No inline event handlers -
 * everything is delegated from the document.
 */
(function () {
  'use strict';

  var ER = (window.ER = window.ER || {});

  /* ------------------------------------------------------------------ base */
  /* ONE '/island/apps/elden/' literal per asset root. The island assembler rewrites these to
     /island/apps/elden/... ; data JSON carries BARE prefixes ("/island/apps/elden/sprites/x.webp")
     and is resolved through ER.asset so both worlds agree. */
  var ASSET_BASE = '/island/apps/elden/';
  var DATA_BASE = '/island/apps/elden/data/';

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  ER.$ = $;
  ER.$$ = $$;
  ER.esc = esc;
  ER.asset = function (p) {
    if (!p) return '';
    var s = String(p);
    if (/^(?:[a-z]+:|\/\/|\/)/i.test(s)) return s;
    return ASSET_BASE + s.replace(/^(?:\.\/)+/, '');
  };

  var STAT_NAMES = {
    vig: 'Vigor', mind: 'Mind', end: 'Endurance', str: 'Strength',
    dex: 'Dexterity', int: 'Intelligence', fai: 'Faith', arc: 'Arcane',
    phys: 'Physical', mag: 'Magic', fire: 'Fire', ligt: 'Lightning',
    holy: 'Holy', strike: 'Strike', slash: 'Slash', pierce: 'Pierce',
    boost: 'Guard boost', immunity: 'Immunity', robustness: 'Robustness',
    focus: 'Focus', vitality: 'Vitality', bleed: 'Bleed', frost: 'Frost',
    poison: 'Poison', rot: 'Scarlet Rot', sleep: 'Sleep', madness: 'Madness'
  };
  ER.fmt = {
    num: function (n) {
      if (n === null || n === undefined || n === '') return '-';
      var v = Number(n);
      if (!isFinite(v)) return String(n);
      return Math.abs(v % 1) > 0.0001 ? String(Math.round(v * 10) / 10) : v.toLocaleString('en-US');
    },
    stat: function (k) {
      return STAT_NAMES[k] || String(k || '');
    },
    date: function (iso) {
      if (!iso) return 'unknown';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso).slice(0, 10);
      var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return d.getUTCDate() + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    }
  };

  /* ------------------------------------------------------- prefs (one blob) */
  /* elden_prefs_v1 is the shell's ONE key. Everything nests inside it, so the
     island /import allowlist and the ls-unique gate only ever see three keys
     across the whole app (tracker + planner own the other two). */
  var PREFS_KEY = 'elden_prefs_v1';
  var PREFS = {};
  var prefsTimer = null;

  function readPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw == null) return {};
      var v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
      return v;
    } catch (e) {
      return {};
    }
  }
  function setSaveState(state) {
    var pill = $('#savePill');
    if (!pill) return;
    if (!state) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    pill.className = 'save-pill ' + state;
    pill.textContent = state === 'saving' ? 'saving...' : state === 'saved' ? 'saved' : 'save failed';
    if (state === 'saved') {
      clearTimeout(setSaveState._t);
      setSaveState._t = setTimeout(function () {
        var p = $('#savePill');
        if (p && p.classList.contains('saved')) p.hidden = true;
      }, 1600);
    }
  }
  function savePrefsSoon() {
    setSaveState('saving');
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(function () {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(PREFS));
        setSaveState('saved');
      } catch (e) {
        setSaveState('failed');
      }
    }, 300);
  }
  ER.prefs = {
    get: function (key, def) {
      return Object.prototype.hasOwnProperty.call(PREFS, key) ? PREFS[key] : def;
    },
    set: function (key, val) {
      PREFS[key] = val;
      savePrefsSoon();
    }
  };

  /* ------------------------------------------------------------ mode engine */
  /* Shape copied from projects/terraria/app/js/app.js (MOD_DEFS / srcOn /
     applyMode). Base game is always on; Shadow of the Erdtree is the toggle,
     and it is the picker future mods will reuse. Untagged content counts as
     base and is NEVER hidden. */
  var MOD_DEFS = [
    {
      id: 'base',
      name: 'Elden Ring',
      badge: '',
      always: true,
      desc: 'The base game. Always on.'
    },
    {
      id: 'sote',
      name: 'Shadow of the Erdtree',
      badge: 'SotE',
      desc: 'The expansion. Turn it on and its weapons, spells, bosses and regions merge into every list.'
    }
  ];
  var TOGGLEABLE = MOD_DEFS.filter(function (m) {
    return !m.always;
  }).map(function (m) {
    return m.id;
  });
  ER.modes = { sote: false };
  ER.modDefs = MOD_DEFS;

  function srcOn(src) {
    return src !== 'sote' || !!ER.modes.sote;
  }
  ER.srcOn = srcOn;

  var MODE_CBS = [];
  ER.onModeChange = function (cb) {
    if (typeof cb === 'function') MODE_CBS.push(cb);
  };

  function modeName() {
    return ER.modes.sote ? 'sote' : 'base';
  }
  ER.modeName = modeName;

  function initModes() {
    var stored = ER.prefs.get('modes', null);
    if (stored && typeof stored === 'object') {
      TOGGLEABLE.forEach(function (id) {
        ER.modes[id] = !!stored[id];
      });
    }
  }
  function applyMode(fire) {
    var m = modeName();
    try {
      document.documentElement.setAttribute('data-mode', m);
      if (document.body) document.body.setAttribute('data-mode', m);
      var mount = $('#app') && $('#app').closest('[data-app]');
      if (mount) mount.setAttribute('data-mode', m);
    } catch (e) {}
    renderModeBar();
    renderStamp();
    warmSprites();
    if (fire !== false) {
      MODE_CBS.forEach(function (cb) {
        try {
          cb(ER.modes);
        } catch (e) {}
      });
    }
  }
  ER.applyMode = applyMode;
  ER.setMode = function (id, on) {
    if (TOGGLEABLE.indexOf(id) === -1) return;
    if (!!ER.modes[id] === !!on) return;
    ER.modes[id] = !!on;
    var out = {};
    TOGGLEABLE.forEach(function (k) {
      out[k] = !!ER.modes[k];
    });
    ER.prefs.set('modes', out);
    closeSheet();
    applyMode(true);
  };

  /* The chip that says which world you are looking at. It lives outside
     #topbar so it survives the shell strip - the mode identity has to be
     visible in both worlds. */
  function renderModeBar() {
    var host = $('#modebar');
    if (!host) return;
    var on = !!ER.modes.sote;
    host.innerHTML =
      '<button class="modechip ' + (on ? 'sote' : 'base') + '" type="button" data-modepicker aria-haspopup="dialog">' +
      '<span class="dot" aria-hidden="true"></span>' +
      '<span class="mode-nm">' + (on ? 'Base + Shadow of the Erdtree' : 'Base game') + '</span>' +
      '<span class="mode-caret" aria-hidden="true">&rsaquo;</span>' +
      '</button>';
  }

  /* Counts are DERIVED from the loaded data, never written down. */
  function modeCounts(id) {
    var n = 0;
    ARRAY_GROUPS.forEach(function (g) {
      var arr = ER.data[g];
      if (!Array.isArray(arr) || g === 'mapPins') return;
      arr.forEach(function (r) {
        if ((r && r.src) === 'sote' ? id === 'sote' : id === 'base') n++;
      });
    });
    return n;
  }
  ER.modePickerSheet = function () {
    var rows = MOD_DEFS.map(function (m) {
      var on = m.always ? true : !!ER.modes[m.id];
      var n = modeCounts(m.id);
      var toggle = m.always
        ? '<span class="mod-tog on base" role="img" aria-label="Always on"></span>'
        : '<span class="mod-tog' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') +
          '" data-modetoggle="' + esc(m.id) + '" tabindex="0"></span>';
      return (
        '<div class="mod-row"' + (m.always ? '' : ' data-modetoggle="' + esc(m.id) + '"') + '>' +
        '<span class="mod-body"><span class="mod-nm">' + esc(m.name) +
        (m.badge ? ' <span class="src-badge">' + esc(m.badge) + '</span>' : '') + '</span>' +
        '<span class="mod-desc">' + esc(m.desc) + '</span>' +
        '<span class="mod-count">' + ER.fmt.num(n) + ' entries in this app</span></span>' +
        toggle +
        '</div>'
      );
    }).join('');
    openSheet({
      title: 'What are you playing?',
      sub: 'Your pick is remembered on this device',
      icon: '&#9737;',
      html:
        '<div class="mod-sheet">' + rows + '</div>' +
        '<p class="sheet-note">With the expansion off, nothing from Shadow of the Erdtree is mixed in - lists, ' +
        'guides, the planner and the map all stay base game, so nothing you see spoils a region you have not bought ' +
        'or reached. Turn it on and everything merges into one world, with a <span class="src-badge">SotE</span> ' +
        'badge on every expansion entry.</p>',
      key: 'modes'
    });
  };

  /* ------------------------------------------------------------------ data */
  var FILES = [
    ['weapons', 'weapons.json'],
    ['armor', 'armor.json'],
    ['armorSets', 'armor-sets.json'],
    ['talismans', 'talismans.json'],
    ['spells', 'spells.json'],
    ['ashes', 'ashes.json'],
    ['spirits', 'spirits.json'],
    ['items', 'items.json'],
    ['bosses', 'bosses.json'],
    ['graces', 'graces.json'],
    ['regions', 'regions.json'],
    ['npcs', 'npcs.json'],
    ['quests', 'quests.json'],
    ['classes', 'classes.json'],
    ['mechanics', 'mechanics.json'],
    ['guides', 'guides.json'],
    ['mapManifest', 'map-manifest.json'],
    ['mapPins', 'map-pins.json'],
    ['glossary', 'glossary.json'],
    ['start', 'start.json'],
    ['meta', 'meta.json']
  ];
  /* Datasets that are arrays of id-bearing records. Order matters only for the
     search ranking below (earlier groups win ties). */
  var ARRAY_GROUPS = [
    'weapons', 'armor', 'armorSets', 'talismans', 'spells', 'ashes', 'spirits',
    'items', 'bosses', 'npcs', 'quests', 'graces', 'regions', 'classes',
    'guides', 'mapPins'
  ];
  ER.arrayGroups = ARRAY_GROUPS;

  ER.data = {};
  FILES.forEach(function (f) {
    ER.data[f[0]] = f[0] === 'mechanics' || f[0] === 'start' || f[0] === 'meta' || f[0] === 'mapManifest' ? {} : [];
  });

  var INDEX = Object.create(null); /* id -> {rec, group} */
  ER.byId = function (id) {
    var e = id ? INDEX[id] : null;
    return e ? e.rec : undefined;
  };
  ER.groupOf = function (id) {
    var e = id ? INDEX[id] : null;
    return e ? e.group : undefined;
  };
  /* Slug lookup inside one dataset - what the #wiki/<group>/<slug> route needs. */
  var SLUGS = Object.create(null); /* group -> slug -> rec */
  ER.bySlug = function (group, slug) {
    var m = SLUGS[group];
    return m ? m[slug] : undefined;
  };

  /* Mechanics arrives as ONE document, but the Wiki tab needs entities. The
     attributes, the status effects and the big derived tables are turned into
     records with the same common fields as every other dataset, so byId,
     search, cross-links and openEntity all work on them unchanged. Their prose
     comes from the dataset (never invented here); only the section labels are
     ours. A table the pipeline left EMPTY on purpose (mechanics.gaps) produces
     no entity at all rather than an empty page. */
  function mechanicsEntities() {
    var m = ER.data.mechanics || {};
    var out = [];
    (m.attributes || []).forEach(function (a) {
      if (!a || !a.key) return;
      out.push({
        id: 'mech-attr-' + a.key,
        name: a.name || ER.fmt.stat(a.key),
        slug: 'attribute-' + a.key,
        src: 'base',
        icon: null,
        mechKind: 'attribute',
        attrKey: a.key,
        desc: a.desc || '',
        softCaps: (a.softCaps && a.softCaps.length ? a.softCaps : (m.softCaps || {})[a.key]) || [],
        wiki: a.wiki || a.name || ''
      });
    });
    (m.statusEffects || []).forEach(function (s) {
      if (!s || !s.name) return;
      out.push({
        id: 'mech-status-' + (s.slug || s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
        name: s.name,
        slug: 'status-' + (s.slug || s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
        src: 'base',
        icon: null,
        mechKind: 'status',
        desc: s.effect || '',
        status: s,
        wiki: s.name
      });
    });
    if ((m.runeCost || []).length) {
      out.push({
        id: 'mech-sys-rune-cost',
        name: 'Rune cost per level',
        slug: 'rune-cost',
        src: 'base',
        icon: null,
        mechKind: 'table',
        table: 'runeCost',
        desc: 'What every single level costs, and what a level target costs in total.',
        wiki: 'Level'
      });
    }
    if ((m.scadutree || []).length) {
      out.push({
        id: 'mech-sys-scadutree',
        name: 'Scadutree Blessing',
        slug: 'scadutree-blessing',
        src: 'sote',
        icon: null,
        mechKind: 'table',
        table: 'scadutree',
        desc: 'The expansion has its own power curve, separate from your level.',
        wiki: 'Scadutree Blessing'
      });
    }
    return out;
  }

  function buildIndex() {
    INDEX = Object.create(null);
    SLUGS = Object.create(null);
    function add(group, rec) {
      if (!rec) return;
      if (rec.id && !INDEX[rec.id]) INDEX[rec.id] = { rec: rec, group: group };
      if (rec.slug) {
        if (!SLUGS[group]) SLUGS[group] = Object.create(null);
        if (!SLUGS[group][rec.slug]) SLUGS[group][rec.slug] = rec;
      }
    }
    ARRAY_GROUPS.forEach(function (g) {
      var arr = ER.data[g];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (r) {
        add(g, r);
      });
    });
    ER.mechanics = mechanicsEntities();
    ER.mechanics.forEach(function (r) {
      add('mechanics', r);
    });
  }

  var readyResolve, readyReject, READY_SETTLED = false;
  function makeReady() {
    READY_SETTLED = false;
    ER.ready = new Promise(function (res, rej) {
      readyResolve = res;
      readyReject = rej;
    });
    ER.ready.catch(function () {}); /* never an unhandled rejection */
  }
  makeReady();

  function fetchOne(file) {
    return fetch(DATA_BASE + file, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadData() {
    var failures = [];
    return Promise.all(
      FILES.map(function (f) {
        return fetchOne(f[1]).then(
          function (json) {
            ER.data[f[0]] = json;
          },
          function (err) {
            failures.push({ file: f[1], key: f[0], why: (err && err.message) || 'failed' });
          }
        );
      })
    ).then(function () {
      if (failures.length) {
        var e = new Error('data load failed');
        e.failures = failures;
        throw e;
      }
      buildIndex();
    });
  }

  function renderDataError(failures) {
    var host = $('#app');
    if (!host) return;
    host.innerHTML =
      '<section class="panel err-panel">' +
      '<h2 class="err-h">The data did not load</h2>' +
      '<p class="err-p">This app keeps everything it knows in local data files. ' +
      (failures.length === 1 ? 'One of them' : failures.length + ' of them') +
      ' could not be read, so nothing below would be trustworthy. Nothing is broken on your side - try again, ' +
      'and if it keeps failing you are probably offline on a first visit.</p>' +
      '<ul class="err-list">' +
      failures
        .map(function (f) {
          return '<li><code>data/' + esc(f.file) + '</code> <span class="err-why">' + esc(f.why) + '</span></li>';
        })
        .join('') +
      '</ul>' +
      '<button class="btn primary" type="button" data-retry>Try again</button>' +
      '</section>';
  }

  /* ----------------------------------------------------------- page locking */
  /* Reason-counted so two overlays cannot unlock each other. Both the document
     element and the body are pinned: mounted in the island shell the page is a
     tall scroller of its own, and iOS will hand the swipe to whichever of the
     two is the viewport scroller if only one is locked. */
  var PAGE_LOCKS = {};
  var LOCK_COUNT = 0;
  function pageLock(reason, on) {
    if (on && !PAGE_LOCKS[reason]) {
      PAGE_LOCKS[reason] = 1;
      LOCK_COUNT++;
    } else if (!on && PAGE_LOCKS[reason]) {
      delete PAGE_LOCKS[reason];
      LOCK_COUNT--;
    }
    var v = LOCK_COUNT > 0 ? 'hidden' : '';
    try {
      document.documentElement.style.overflow = v;
      document.body.style.overflow = v;
    } catch (e) {}
  }
  ER.pageLock = pageLock;

  /* ------------------------------------------------------------ bottom sheet */
  /* Deeply tap-through: an entity sheet links to its drops, its set, its ash,
     its region. Every open pushes a crumb so there is always a way back that is
     not "close and find it again". The browser back button pops the sheet
     before it pops the route (one pushState per open sheet stack). */
  var SHEET_STACK = [];
  var SHEET_ACTIONS = [];
  var SHEET_HISTORY = false;

  function sheetKey(o) {
    return (o && (o.key || o.title)) || '';
  }

  function paintSheet(opts) {
    var body = $('#sheetBody');
    var wrap = $('#sheet');
    if (!body || !wrap) return;
    SHEET_ACTIONS = (opts.actions || []).filter(function (a) {
      return a && a.label;
    });
    var prev = SHEET_STACK[SHEET_STACK.length - 2];
    var back = prev
      ? '&larr; ' + esc(String(prev.title || 'Back').slice(0, 26))
      : '&times; Close';
    var actions = SHEET_ACTIONS.length
      ? '<div class="sheet-actions">' +
        SHEET_ACTIONS.map(function (a, i) {
          return '<button class="btn' + (i === 0 ? ' primary' : '') + '" type="button" data-sheet-act="' + i + '">' + esc(a.label) + '</button>';
        }).join('') +
        '</div>'
      : '';
    /* opts.title, and every value a caller interpolates into opts.html, are
       escaped by the caller. opts.sub and opts.icon are the two fields that
       take MARKUP by contract (the SotE badge sits inline in the sub line, the
       icon is an HTML entity) - every producer of those in this app builds them
       from esc()'d parts or from a literal. Nothing user-typed reaches either. */
    body.innerHTML =
      '<div class="sheet-grab" aria-hidden="true"></div>' +
      '<div class="sheet-nav"><button class="sheet-back" type="button" data-sheet-back>' + back + '</button></div>' +
      '<header class="sheet-head">' +
      (opts.icon ? '<span class="sheet-icon" aria-hidden="true">' + opts.icon + '</span>' : '') +
      '<div class="sheet-heads"><h2 class="sheet-title">' + esc(opts.title || '') + '</h2>' +
      (opts.sub ? '<p class="sheet-sub">' + opts.sub + '</p>' : '') +
      '</div></header>' +
      '<div class="sheet-content">' + (opts.html || '') + '</div>' +
      actions;
    body.scrollTop = 0;
    wrap.hidden = false;
    pageLock('sheet', true);
    /* Move focus into the dialog so a screen reader lands on the new content
       and Escape has somewhere to be heard from. preventScroll keeps the page
       behind the sheet exactly where the reader left it. */
    try {
      body.setAttribute('tabindex', '-1');
      body.focus({ preventScroll: true });
    } catch (e) {}
  }

  function openSheet(opts) {
    if (!opts) return;
    var top = SHEET_STACK[SHEET_STACK.length - 1];
    if (!top || sheetKey(top) !== sheetKey(opts)) SHEET_STACK.push(opts);
    else SHEET_STACK[SHEET_STACK.length - 1] = opts;
    if (!SHEET_HISTORY) {
      try {
        history.pushState({ erSheet: 1 }, '');
        SHEET_HISTORY = true;
      } catch (e) {}
    }
    paintSheet(opts);
  }

  function hideSheet() {
    var wrap = $('#sheet');
    SHEET_STACK.length = 0;
    SHEET_ACTIONS = [];
    if (wrap) wrap.hidden = true;
    pageLock('sheet', false);
  }

  function closeSheet(fromPop) {
    var wasOpen = SHEET_STACK.length > 0;
    hideSheet();
    if (!fromPop && SHEET_HISTORY && wasOpen) {
      SHEET_HISTORY = false;
      try {
        history.back();
      } catch (e) {}
    } else {
      SHEET_HISTORY = false;
    }
  }

  function sheetBack() {
    SHEET_STACK.pop();
    var prev = SHEET_STACK[SHEET_STACK.length - 1];
    if (!prev) return closeSheet();
    paintSheet(prev);
  }
  ER.sheet = { open: openSheet, close: closeSheet, back: sheetBack };

  /* -------------------------------------------------------------- toast */
  var toastTimer = null;
  ER.toast = function (msg) {
    var t = $('#erToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'erToast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = String(msg || '');
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('on');
    }, 2400);
  };

  /* ------------------------------------------------------------ tab registry */
  /* The five tabs are declared here so the bar is complete even before the
     other lanes' scripts exist; registerTab() supplies the implementation and
     may override the label, icon and order. A tab with no implementation
     renders an honest placeholder instead of a blank pane. */
  var TAB_DEFS = [
    { id: 'start', label: 'Start', icon: '&#127775;', order: 10 },
    { id: 'wiki', label: 'Wiki', icon: '&#128220;', order: 20 },
    { id: 'builds', label: 'Builds', icon: '&#9876;', order: 30 },
    { id: 'tracker', label: 'Tracker', icon: '&#128203;', order: 40 },
    { id: 'map', label: 'Map', icon: '&#128506;', order: 50 }
  ];
  var TABS = {};
  TAB_DEFS.forEach(function (d) {
    TABS[d.id] = { id: d.id, label: d.label, icon: d.icon, order: d.order, impl: null, pane: null, mounted: false };
  });
  var CUR_TAB = null;

  ER.registerTab = function (id, def) {
    if (!id || !def) return;
    var t = TABS[id] || (TABS[id] = { id: id, label: id, icon: '&#9670;', order: 900, impl: null, pane: null, mounted: false });
    if (def.label) t.label = def.label;
    if (def.icon) t.icon = def.icon;
    if (typeof def.order === 'number') t.order = def.order;
    t.impl = def;
    if (BOOTED) {
      renderTabBar();
      if (CUR_TAB === id) showTab(id, CUR_PARAMS, true);
    }
  };

  function tabList() {
    return Object.keys(TABS)
      .map(function (k) {
        return TABS[k];
      })
      .sort(function (a, b) {
        return a.order - b.order || (a.id < b.id ? -1 : 1);
      });
  }

  function renderTabBar() {
    var bar = $('#tabbar');
    if (!bar) return;
    bar.innerHTML = tabList()
      .map(function (t) {
        return (
          '<button class="tab' + (t.id === CUR_TAB ? ' on' : '') + '" type="button" data-tab="' + esc(t.id) + '"' +
          (t.id === CUR_TAB ? ' aria-current="page"' : '') + '>' +
          '<span class="ic" aria-hidden="true">' + t.icon + '</span><span class="tl">' + esc(t.label) + '</span></button>'
        );
      })
      .join('');
  }

  function paneFor(t) {
    if (t.pane) return t.pane;
    var host = $('#app');
    if (!host) return null;
    var el = document.createElement('section');
    el.className = 'pane pane-' + t.id;
    el.setAttribute('data-pane', t.id);
    el.hidden = true;
    host.appendChild(el);
    t.pane = el;
    return el;
  }

  function placeholder(t) {
    return (
      '<div class="panel soon-panel">' +
      '<h2 class="soon-h">' + esc(t.label) + '</h2>' +
      '<p class="soon-p">This section has not been wired up in this build yet. Everything else in the app works ' +
      'without it - the tab is here so the shape of the app never changes under you.</p>' +
      '</div>'
    );
  }

  var CUR_PARAMS = [];
  function showTab(id, params, force) {
    var t = TABS[id];
    if (!t) return;
    if (CUR_TAB && CUR_TAB !== id && TABS[CUR_TAB]) {
      var old = TABS[CUR_TAB];
      if (old.pane) old.pane.hidden = true;
      if (old.impl && typeof old.impl.hide === 'function') {
        try {
          old.impl.hide();
        } catch (e) {}
      }
    }
    var pane = paneFor(t);
    if (!pane) return;
    var changed = CUR_TAB !== id;
    CUR_TAB = id;
    CUR_PARAMS = params || [];
    pane.hidden = false;
    if (t.impl && typeof t.impl.mount === 'function' && (!t.mounted || force)) {
      t.mounted = true;
      try {
        t.impl.mount(pane);
      } catch (e) {
        pane.innerHTML = '<div class="panel err-panel"><h2 class="err-h">This tab failed to start</h2>' +
          '<p class="err-p">' + esc((e && e.message) || 'unknown error') + '</p></div>';
      }
    } else if (!t.impl && !t.mounted) {
      t.mounted = true;
      pane.innerHTML = placeholder(t);
    }
    if (t.impl && typeof t.impl.show === 'function') {
      try {
        t.impl.show(CUR_PARAMS);
      } catch (e) {}
    }
    renderTabBar();
    if (changed) {
      try {
        window.scrollTo(0, 0);
      } catch (e) {}
    }
  }

  /* ---------------------------------------------------------------- router */
  /* NATIVE hash routing (registry nativeHashRouting:true - the shell's shim
     no-ops). Routes: #start | #wiki/<group>/<slug> | #builds[/<guide>] |
     #builds/planner[/<guide>] | #tracker | #map/<world>[/pin/<id>|/guide/<slug>].
     Anything unknown lands on #start rather than a blank screen. */
  function parseHash() {
    var h = String(location.hash || '').replace(/^#\/?/, '');
    if (!h) return [];
    return h.split('/').filter(Boolean).map(function (p) {
      try {
        return decodeURIComponent(p);
      } catch (e) {
        return p;
      }
    });
  }
  function route() {
    var parts = parseHash();
    var id = parts[0];
    if (!id) return showTab('start', []);
    if (!TABS[id]) {
      try {
        history.replaceState(null, '', '#start');
      } catch (e) {}
      return showTab('start', []);
    }
    showTab(id, parts.slice(1));
  }
  ER.navigate = function (tab, params) {
    var parts = [tab].concat(params || []).map(function (p) {
      return encodeURIComponent(String(p));
    });
    var next = '#' + parts.join('/');
    if (location.hash === next) route();
    else location.hash = next;
  };
  ER.currentTab = function () {
    return CUR_TAB;
  };

  /* --------------------------------------------------------- global search */
  /* One field, every tab (template section 8: "I heard a word, what is it" is
     the most common beginner action). Entities first, ranked prefix over
     substring; then glossary terms; then whatever each tab contributes through
     its own search(q). Every result is DLC-filtered through srcOn. */
  var GROUP_LABEL = {
    weapons: 'Weapon', armor: 'Armour', armorSets: 'Armour set', talismans: 'Talisman',
    spells: 'Spell', ashes: 'Ash of War', spirits: 'Spirit Ash', items: 'Item',
    bosses: 'Boss', npcs: 'NPC', quests: 'Quest', graces: 'Site of Grace',
    regions: 'Region', classes: 'Class', guides: 'Build guide', mechanics: 'Mechanic',
    mapPins: 'Map pin'
  };
  ER.groupLabel = function (g) {
    return GROUP_LABEL[g] || g || '';
  };
  var GROUP_ICON = {
    weapons: '&#9876;', armor: '&#128737;', armorSets: '&#128737;', talismans: '&#128142;',
    spells: '&#10024;', ashes: '&#128293;', spirits: '&#128123;', items: '&#127746;',
    bosses: '&#128128;', npcs: '&#128100;', quests: '&#128220;', graces: '&#128367;',
    regions: '&#127956;', classes: '&#127907;', guides: '&#128736;', mechanics: '&#9881;'
  };
  ER.groupIcon = function (g) {
    return GROUP_ICON[g] || '&#9670;';
  };

  function searchEntities(q, cap) {
    var ql = q.toLowerCase();
    var exact = [], starts = [], has = [];
    var groups = ARRAY_GROUPS.filter(function (g) {
      return g !== 'mapPins';
    }).concat(['mechanics']);
    groups.forEach(function (g) {
      var arr = g === 'mechanics' ? ER.mechanics || [] : ER.data[g];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (r) {
        if (!r || !r.name || !srcOn(r.src)) return;
        var n = String(r.name).toLowerCase();
        var i = n.indexOf(ql);
        if (i === -1) return;
        var row = {
          title: r.name,
          sub: GROUP_LABEL[g] || g,
          icon: GROUP_ICON[g] || '&#9670;',
          id: r.id,
          group: g,
          go: (function (id) {
            return function () {
              ER.openEntity(id);
            };
          })(r.id)
        };
        if (n === ql) exact.push(row);
        else if (i === 0) starts.push(row);
        else has.push(row);
      });
    });
    return exact.concat(starts, has).slice(0, cap || 30);
  }

  ER.search = function (q) {
    var query = String(q || '').trim();
    if (query.length < 2) return [];
    var out = searchEntities(query, 24);
    var ql = query.toLowerCase();
    (ER.data.glossary || []).forEach(function (g) {
      if (!g || !g.term) return;
      if (String(g.term).toLowerCase().indexOf(ql) === -1) return;
      out.push({
        title: g.term,
        sub: 'Word you will hear',
        icon: '&#128218;',
        go: (function (entry) {
          return function () {
            openSheet({
              title: entry.term,
              sub: 'Word you will hear',
              icon: '&#128218;',
              html: '<p class="lede">' + esc(entry.def) + '</p>',
              key: 'gloss:' + entry.slug
            });
          };
        })(g)
      });
    });
    tabList().forEach(function (t) {
      if (!t.impl || typeof t.impl.search !== 'function') return;
      var rows = [];
      try {
        rows = t.impl.search(query) || [];
      } catch (e) {
        rows = [];
      }
      rows.forEach(function (r) {
        if (r && r.title) out.push(r);
      });
    });
    return out.slice(0, 40);
  };

  var SUGGEST = [];
  function renderSuggest(rows) {
    var box = $('#erSuggest');
    if (!box) return;
    SUGGEST = rows || [];
    if (!SUGGEST.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.innerHTML = SUGGEST.map(function (r, i) {
      return (
        '<button class="sug-row" type="button" data-sug="' + i + '">' +
        '<span class="sug-ic" aria-hidden="true">' + (r.icon || '&#9670;') + '</span>' +
        '<span class="sug-body"><span class="sug-t">' + esc(r.title) + '</span>' +
        (r.sub ? '<span class="sug-s">' + esc(r.sub) + '</span>' : '') + '</span></button>'
      );
    }).join('');
    box.hidden = false;
  }
  function clearSuggest() {
    renderSuggest([]);
  }
  ER.clearSearch = function () {
    var f = $('#erSearch');
    if (f) f.value = '';
    var c = $('#erSearchClear');
    if (c) c.hidden = true;
    clearSuggest();
  };

  /* ------------------------------------------------------- stamp + licence */
  /* Freshness is part of the IA, not a footer: the pill says which patch the
     numbers describe and when they were pulled. Both elements are stripped by
     the island shell (which renders its own), so both lookups are guarded. */
  function stampText() {
    var meta = ER.data.meta || {};
    var bits = [];
    if (meta.gameVersion) bits.push('Patch ' + meta.gameVersion);
    if (ER.modes.sote) bits.push('SotE');
    if (meta.pulledAt) bits.push(ER.fmt.date(meta.pulledAt));
    return bits.length ? bits.join(' - ') : 'Elden Ring';
  }
  ER.stampText = stampText;

  function renderStamp() {
    var pill = $('#patchPill');
    if (pill) pill.textContent = stampText();
    var foot = $('#footNote');
    var meta = ER.data.meta || {};
    if (foot && meta.attribution) foot.textContent = meta.attribution;
  }
  ER.renderStamp = renderStamp;

  /* --------------------------------------------------- warm sprites (R3/S9) */
  /* The island service worker gives this route its own bucket
     (fi-sprites-elden-<hash>) but it cannot know WHICH files the current mode
     needs - only the app does. Generic message shape, the one make-sw's
     `Array.isArray(data.tiers)` branch reads. Paths are posted RELATIVE to the
     sprites dir, because the worker prepends its own base; standalone they are
     bare already, mounted they carry the island prefix, so both are stripped
     back to the last "/island/apps/elden/sprites/".
     BOTH halves race - the data fetch and the worker becoming available finish
     in either order - so this is a no-op until both exist and is called from
     each side plus on every mode flip. */
  var SW_TARGET = null;
  var SPRITE_TIERS = null;
  var SPRITE_RE = /^.*\/?sprites\//;

  function spriteTiers() {
    if (SPRITE_TIERS) return SPRITE_TIERS;
    var base = Object.create(null), sote = Object.create(null);
    ARRAY_GROUPS.forEach(function (g) {
      var arr = ER.data[g];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (r) {
        if (!r || !r.icon) return;
        var f = String(r.icon).replace(SPRITE_RE, '');
        if (!f || f === String(r.icon)) return; /* not under sprites/ - skip, never guess */
        if (r.src === 'sote') sote[f] = 1;
        else base[f] = 1;
      });
    });
    /* A file both tiers reference belongs to base: it is needed with the DLC
       off, so it must never be downloaded twice or stranded in tier 2. */
    Object.keys(base).forEach(function (f) {
      delete sote[f];
    });
    SPRITE_TIERS = { base: Object.keys(base), sote: Object.keys(sote) };
    return SPRITE_TIERS;
  }

  function warmSprites() {
    if (!SW_TARGET || !ER.data.meta || !ER.data.meta.pulledAt) return;
    try {
      var t = spriteTiers();
      SW_TARGET.postMessage({
        type: 'warm-sprites',
        stamp: String(ER.data.meta.pulledAt || ''),
        tiers: [['base', t.base], ['sote', t.sote]],
        wantTiers: ER.modes.sote ? ['base', 'sote'] : ['base']
      });
    } catch (e) {}
  }

  /* ------------------------------------------------- missing-icon fallback */
  /* Sprites are FromSoftware's and some entities (most bosses) legitimately
     have none. A broken <img> would otherwise render as a torn-page glyph on
     every row. Captured, not inline: no inline event handlers anywhere. */
  document.addEventListener(
    'error',
    function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'IMG' || !el.classList.contains('er-ic')) return;
      var wrap = el.parentNode;
      if (!wrap) return;
      wrap.classList.add('noimg');
      el.remove();
    },
    true
  );

  /* ------------------------------------------------------ event delegation */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var retry = t.closest('[data-retry]');
    if (retry) {
      boot();
      return;
    }
    var tab = t.closest('[data-tab]');
    if (tab) {
      ER.navigate(tab.getAttribute('data-tab'), []);
      return;
    }
    if (t.closest('[data-sheet-close]')) {
      closeSheet();
      return;
    }
    if (t.closest('[data-sheet-back]')) {
      sheetBack();
      return;
    }
    var act = t.closest('[data-sheet-act]');
    if (act) {
      var i = Number(act.getAttribute('data-sheet-act'));
      var a = SHEET_ACTIONS[i];
      if (a && typeof a.onClick === 'function') {
        try {
          a.onClick();
        } catch (err) {}
      }
      return;
    }
    if (t.closest('[data-modepicker]')) {
      ER.modePickerSheet();
      return;
    }
    var mt = t.closest('[data-modetoggle]');
    if (mt) {
      var id = mt.getAttribute('data-modetoggle');
      ER.setMode(id, !ER.modes[id]);
      return;
    }
    var sug = t.closest('[data-sug]');
    if (sug) {
      var row = SUGGEST[Number(sug.getAttribute('data-sug'))];
      ER.clearSearch();
      var f = $('#erSearch');
      if (f) f.blur();
      if (row && typeof row.go === 'function') row.go();
      return;
    }
    /* The one generic entity link every lane can emit. */
    var ent = t.closest('[data-entity]');
    if (ent) {
      ER.openEntity(ent.getAttribute('data-entity'));
      return;
    }
    var sb = t.closest('#shareBtn');
    if (sb) {
      var url = location.href;
      if (navigator.share) {
        navigator.share({ title: document.title, url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(
          function () {
            ER.toast('Link copied');
          },
          function () {}
        );
      }
      return;
    }
    /* A tap anywhere else dismisses the suggestion list. */
    if (!t.closest('#appbar')) clearSuggest();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var box = $('#erSuggest');
      if (box && !box.hidden) {
        clearSuggest();
        return;
      }
      var wrap = $('#sheet');
      if (wrap && !wrap.hidden) closeSheet();
    }
    /* The mode switches are real switches, so they answer to the keyboard. */
    if (e.key === ' ' || e.key === 'Enter') {
      var t = e.target;
      if (t && t.closest && t.getAttribute && t.getAttribute('role') === 'switch') {
        var id = t.getAttribute('data-modetoggle');
        if (id) {
          e.preventDefault();
          ER.setMode(id, !ER.modes[id]);
        }
      }
    }
  });

  window.addEventListener('popstate', function () {
    if (SHEET_STACK.length) {
      SHEET_HISTORY = false;
      closeSheet(true);
      return;
    }
    route();
  });
  window.addEventListener('hashchange', function () {
    /* A hash change while a sheet is open drops the sheet without a
       history.back() - the hash change IS the navigation. SHEET_HISTORY has to
       be cleared by hand here, or the next sheet skips its pushState and the
       one after that cannot be closed with the back button. */
    if (SHEET_STACK.length) {
      hideSheet();
      SHEET_HISTORY = false;
    }
    route();
  });

  var searchTimer = null;
  document.addEventListener('input', function (e) {
    if (!e.target || e.target.id !== 'erSearch') return;
    var v = e.target.value;
    var c = $('#erSearchClear');
    if (c) c.hidden = !v;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      renderSuggest(ER.search(v));
    }, 120);
  });
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#erSearchClear')) ER.clearSearch();
  });

  /* ------------------------------------------------- entity API fallbacks */
  /* js/wiki.js REPLACES both of these at load time with the real renderers.
     They exist here so that a lane calling ER.openEntity() before (or without)
     the wiki script degrades to something honest instead of throwing. */
  ER.entityCardHtml = function (rec) {
    if (!rec) return '';
    return '<span class="ecard">' + esc(rec.name || rec.id || '') + '</span>';
  };
  ER.openEntity = function (id) {
    var rec = ER.byId(id);
    if (!rec) {
      ER.toast('Nothing here yet');
      return;
    }
    openSheet({
      title: rec.name || String(id),
      sub: ER.groupLabel(ER.groupOf(id)),
      icon: ER.groupIcon(ER.groupOf(id)),
      html: '<p class="lede">' + esc(rec.desc || '') + '</p>',
      key: 'ent:' + id
    });
  };

  /* ------------------------------------------------------------------ boot */
  var BOOTED = false;
  function boot() {
    var host = $('#app');
    if (host) host.innerHTML = '<div class="loading"><span class="rune" aria-hidden="true">&#9737;</span><p>Lighting the grace...</p></div>';
    Object.keys(TABS).forEach(function (k) {
      TABS[k].pane = null;
      TABS[k].mounted = false;
    });
    CUR_TAB = null;
    /* A retry after a failed first load needs a FRESH promise: the old one is
       already rejected and every lane awaiting it would never mount. */
    if (READY_SETTLED) makeReady();
    loadData().then(
      function () {
        if (host) host.innerHTML = '';
        BOOTED = true;
        initModes();
        applyMode(false);
        renderTabBar();
        route();
        MODE_CBS.forEach(function (cb) {
          try {
            cb(ER.modes);
          } catch (e) {}
        });
        warmSprites();
        READY_SETTLED = true;
        readyResolve(ER.data);
      },
      function (err) {
        renderDataError((err && err.failures) || [{ file: 'data', why: (err && err.message) || 'failed' }]);
        READY_SETTLED = true;
        readyReject(err);
      }
    );
  }

  PREFS = readPrefs();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* The ONE service-worker registration in this app. The island registry
     neuters it with a jsReplace swap to Promise.resolve() - NOT reject, because
     the warm-sprites handshake hangs off this chain and a rejected stand-in
     would skip it silently (see NEW-GAME-TEMPLATE 1D). */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      Promise.resolve()
        .then(function () {
          return navigator.serviceWorker.ready;
        })
        .then(function (reg) {
          SW_TARGET = navigator.serviceWorker.controller || (reg && reg.active) || null;
          warmSprites();
        })
        .catch(function () {});
    });
  }
})();
