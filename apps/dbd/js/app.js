/* DBD Companion — vanilla JS PWA
   Data: data/*.json — see tools/README.md for exact shapes.

   This file is the CORE (namespace, boot, sheet/pageLock, view router,
   icon/rarity helpers) plus the Perks tab, which is actually a full wiki
   browser over six sections (Perks / Add-ons / Items / Offerings /
   Statuses / Maps) — registered here as the 'wiki' view.

   Everything hangs off ONE global: window.DBD. Other scripts (loadout.js,
   builds.js, tracker.js, extras.js) load after this file and call
   DBD.registerView(name, fn) to fill in the other tabs. A tab with no
   registered view renders a styled "coming soon" panel — see render().

   CRITICAL data note (tools/README.md): record KEYS are internal ids
   ("Chuckles" = The Trapper). ALWAYS render `name`, never the key. */
'use strict';

window.DBD = window.DBD || {};

(function (DBD) {

  // ===========================================================================
  // Small DOM/string helpers
  // ===========================================================================
  DBD.esc = function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Minimal hyperscript-style element builder for the few places DOM nodes
  // (rather than an HTML string) are more convenient — e.g. wiring a live
  // listener onto a freshly built node before it is inserted.
  // DBD.el('button', {class:'x', onclick:fn}, 'Label') -> HTMLElement
  DBD.el = function el(tag, attrs, children) {
    const node = document.createElement(tag);
    attrs = attrs || {};
    for (const k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      const v = attrs[k];
      if (k.slice(0, 2) === 'on' && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'class') {
        node.className = v;
      } else if (v !== false && v != null) {
        node.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children != null) {
      const kids = Array.isArray(children) ? children : [children];
      kids.forEach(function (c) {
        if (c == null) return;
        node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      });
    }
    return node;
  };

  // Null-safe query — every caller still MUST guard the result before use
  // (a stripped id returns null when this app is mounted in the shell).
  DBD.$ = function $(sel, root) { return (root || document).querySelector(sel); };
  DBD.$$ = function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); };

  // Whitelist unescape: descriptions ship with a handful of REAL formatting
  // tags from the source data (verified against every dataset — see
  // tools/README.md icon section for the equivalent icon-resolution rigor).
  // esc() runs first with NO exceptions, then exactly this whitelist is
  // re-allowed. Anything not on the list stays escaped/inert.
  const DESC_TAG_RE = /&lt;(\/?(?:b|i|ul|li))&gt;/g;
  const DESC_BR_RE = /&lt;br\s*\/?&gt;/g;
  DBD.formatDesc = function formatDesc(raw) {
    if (raw == null) return '';
    let s = DBD.esc(raw);
    s = s.replace(DESC_TAG_RE, '<$1>').replace(DESC_BR_RE, '<br>');
    // statuses.json carries plain wikitext, not HTML: fold real newlines and
    // '''bold''' markers into something readable. Harmless no-op on the
    // records above, which have no literal newlines or triple-quotes.
    s = s.replace(/\n/g, '<br>').replace(/'''([^']+?)'''/g, '<b>$1</b>');
    return s;
  };

  // ===========================================================================
  // Icon helper — local-first, remote fallback, neutral placeholder.
  // Handles all three shapes the data ships: icon/iconRemote (perks, addons,
  // items, offerings, statuses, powers), portrait/portraitRemote (characters),
  // image/imageRemote (maps — 36 of 60 have neither, by design; see meta.json
  // artUnresolved).
  // ===========================================================================
  const PLACEHOLDER_SVG =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
        '<rect width="48" height="48" rx="6" fill="#1a1a20"/>' +
        '<text x="24" y="31" font-family="sans-serif" font-size="22" fill="#6f6f7a" text-anchor="middle">?</text>' +
      '</svg>'
    );

  function iconFields(entry) {
    if (!entry) return [null, null];
    if (entry.icon !== undefined) return [entry.icon, entry.iconRemote];
    if (entry.portrait !== undefined) return [entry.portrait, entry.portraitRemote];
    if (entry.image !== undefined) return [entry.image, entry.imageRemote];
    return [null, null];
  }

  DBD.icon = function icon(entry, cls) {
    cls = cls || 'ic32';
    const pair = iconFields(entry);
    const local = pair[0], remote = pair[1];
    if (!local && !remote) {
      return '<span class="dbd-ic-wrap ' + DBD.esc(cls) + ' miss"><span class="dbd-ic-inner">' +
        '<img class="dbd-ic" src="' + PLACEHOLDER_SVG + '" alt="" loading="lazy"></span></span>';
    }
    const src = local || remote;
    const remoteAttr = (local && remote) ? ' data-remote="' + DBD.esc(remote) + '"' : '';
    return '<span class="dbd-ic-wrap ' + DBD.esc(cls) + '"><span class="dbd-ic-inner">' +
      '<img class="dbd-ic" src="' + DBD.esc(src) + '"' + remoteAttr +
      ' loading="lazy" alt="" onerror="DBD.iconErr(this)"></span></span>';
  };

  // Local -> remote -> neutral placeholder. Exposed on window because it is
  // wired via an inline onerror attribute (same pattern as terraria's sprErr).
  window.DBD.iconErr = function iconErr(img) {
    if (img.dataset.step !== '1' && img.dataset.remote) {
      img.dataset.step = '1';
      img.src = img.dataset.remote;
      return;
    }
    img.onerror = null;
    img.src = PLACEHOLDER_SVG;
    const wrap = img.closest('.dbd-ic-wrap');
    if (wrap) wrap.classList.add('miss');
  };

  // ===========================================================================
  // Rarity -> CSS class. common=brown, uncommon=yellow, rare=green,
  // veryrare=purple, ultrarare/iridescent=pink, event=orange. The live data
  // also carries 'visceral' (a distinct DBD tier below common) and 'none'
  // (no rarity, e.g. some offerings) — both get their own neutral treatment
  // rather than being forced into the six named tiers.
  // ===========================================================================
  const RARITY_MAP = {
    common: 'rar-common',
    uncommon: 'rar-uncommon',
    rare: 'rar-rare',
    veryrare: 'rar-veryrare',
    ultrarare: 'rar-ultrarare',
    iridescent: 'rar-ultrarare',
    event: 'rar-event',
    visceral: 'rar-visceral',
    none: 'rar-none'
  };
  DBD.rarityClass = function rarityClass(r) {
    const key = String(r == null ? '' : r).toLowerCase().replace(/[^a-z]/g, '');
    return RARITY_MAP[key] || 'rar-none';
  };
  DBD.rarityLabel = function rarityLabel(r) {
    if (r == null || r === 'none') return null;
    const key = String(r).toLowerCase();
    const known = {
      common: 'Common', uncommon: 'Uncommon', rare: 'Rare', veryrare: 'Very Rare',
      ultrarare: 'Ultra Rare', iridescent: 'Iridescent', event: 'Event', visceral: 'Visceral'
    };
    return known[key.replace(/[^a-z]/g, '')] || (r.charAt(0).toUpperCase() + r.slice(1));
  };

  // ===========================================================================
  // Page-lock (reason-counted, so an overlapping lock — e.g. a sheet opened
  // from within another full-page overlay — can't unlock the page out from
  // under the overlay that's still up). Locks BOTH documentElement and body:
  // this app also runs mounted inside the fiiiish-app shell, whose page is
  // its own tall scroller, and only locking one lets iOS hand the swipe to
  // whichever element is actually the viewport scroller. Copied from
  // terraria/app/js/app.js's pageLock().
  // ===========================================================================
  const PAGE_LOCKS = new Set();
  DBD.pageLock = function pageLock(reason, on) {
    if (on) PAGE_LOCKS.add(reason); else PAGE_LOCKS.delete(reason);
    const v = PAGE_LOCKS.size ? 'hidden' : '';
    document.documentElement.style.overflow = v;
    document.body.style.overflow = v;
  };

  // ===========================================================================
  // Bottom-sheet + back-stack. openSheet(html, crumb) — crumb is optional
  // {label, reopen()}; reopen() re-renders that exact sheet when the user
  // taps back. Re-opening the crumb already on top does not push a dup.
  // ===========================================================================
  const SHEET_STACK = [];
  // M5: every sheet gets a permanent header row - a back crumb when there is
  // one to go back to, and an ALWAYS-present X close button (routes through
  // the same [data-close] delegation as the backdrop tap) so closing never
  // depends on knowing to tap the backdrop.
  function sheetChromeHtml() {
    const back = SHEET_STACK.length >= 2
      ? '<button class="sheet-back" data-sheet-back>&larr; ' + DBD.esc(SHEET_STACK[SHEET_STACK.length - 2].label) + '</button>'
      : '<span></span>';
    return '<div class="sheet-chrome">' + back + '<button class="sheet-x" data-close aria-label="Close">&times;</button></div>';
  }
  DBD.openSheet = function openSheet(html, crumb) {
    if (crumb && typeof crumb.reopen === 'function') {
      const top = SHEET_STACK[SHEET_STACK.length - 1];
      if (!top || top.label !== crumb.label) SHEET_STACK.push(crumb);
    }
    const body = DBD.$('#sheetBody');
    const sheet = DBD.$('#sheet');
    if (!body || !sheet) return;
    body.innerHTML = sheetChromeHtml() + html;
    body.scrollTop = 0;
    sheet.hidden = false;
    DBD.pageLock('sheet', true);
  };
  DBD.closeSheet = function closeSheet() {
    SHEET_STACK.length = 0;
    const sheet = DBD.$('#sheet');
    if (sheet) sheet.hidden = true;
    DBD.pageLock('sheet', false);
  };
  DBD.sheetBack = function sheetBack() {
    SHEET_STACK.pop();
    const prev = SHEET_STACK[SHEET_STACK.length - 1];
    if (!prev) return DBD.closeSheet();
    prev.reopen();
  };
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) DBD.closeSheet();
    else if (e.target.closest('[data-sheet-back]')) DBD.sheetBack();
  });
  // M5: Escape closes the sheet - routes through the same DBD.closeSheet()
  // as the backdrop tap and the new X button, so there is exactly one close
  // path regardless of how it was triggered.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    const sheet = DBD.$('#sheet');
    if (sheet && !sheet.hidden) DBD.closeSheet();
  });

  // ===========================================================================
  // View router. Other files call DBD.registerView(name, fn) at load time
  // (script order = registration order); fn(mountEl) renders into mountEl.
  // An unregistered view (a tab whose owning file hasn't shipped yet) gets a
  // styled "coming soon" panel instead of a blank screen.
  // ===========================================================================
  const VIEWS = {};
  const TAB_META = {
    chars: { label: 'Characters', em: '&#128100;' },
    wiki: { label: 'Perks', em: '&#128220;' },
    builds: { label: 'Builds', em: '&#129513;' },
    tracker: { label: 'Tracker', em: '&#128202;' },
    more: { label: 'More', em: '&#8943;' }
  };
  DBD.registerView = function registerView(name, renderFn) { VIEWS[name] = renderFn; };

  function comingSoonHtml(name) {
    const meta = TAB_META[name] || { label: name, em: '&#8943;' };
    return '<div class="view"><div class="hint"><div class="big">' + meta.em + '</div>' +
      DBD.esc(meta.label) + ' is coming soon.<div class="faint">This tab is being built in a parallel session.</div></div></div>';
  }

  DBD.render = function render() {
    const app = DBD.$('#app');
    if (!app) return;
    const fn = VIEWS[DBD.state.view];
    if (typeof fn === 'function') { fn(app); return; }
    app.innerHTML = comingSoonHtml(DBD.state.view);
  };

  DBD.setView = function setView(name) {
    DBD.state.view = name;
    // H2: a sheet left open across a tab switch floats over the new view
    // with the scroll lock still held - close the WHOLE stack (not just pop
    // one crumb) every time the view changes, same path a backdrop tap uses.
    DBD.closeSheet();
    DBD.$$('#tabbar .tab').forEach(function (t) { t.classList.toggle('on', t.dataset.view === name); });
    window.scrollTo(0, 0);
    DBD.render();
    // M4: keep the URL hash in sync with every PROGRAMMATIC view switch too
    // (owner links, tab taps, a future apply-to-loadout flow) - not just the
    // shell's own hash-driven navigation. replaceState (not pushState) so
    // switching tabs doesn't pollute back/forward history. Works both
    // standalone and mounted in the island shell; guarded for any
    // environment without a working History API.
    if (window.history && typeof window.history.replaceState === 'function') {
      try { window.history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    }
  };

  // ===========================================================================
  // State + data
  // ===========================================================================
  DBD.state = {
    // Default view is 'chars' (Characters) - lobby feel for a loadout
    // companion. boot() re-derives the real initial view from the URL hash
    // (H1) and falls back to 'wiki' if loadout.js failed to register 'chars'
    // (see fix #5) - this constant only matters before that runs.
    view: 'chars',
    wikiSection: 'perks',
    filters: { role: 'all', addonKind: 'power', addonPower: '', addonItemType: '', statusSystem: 'all' },
    search: ''
  };
  DBD.data = { characters: {}, perks: {}, addons: {}, items: {}, offerings: {}, statuses: {}, powers: {}, maps: { realms: {}, maps: {} }, meta: {} };
  // D4 boot resilience: per-dataset load flags. A section whose backing file
  // hasn't landed yet (the lazy group in boot()) renders a loading state
  // instead of a lying "no results" — see renderWikiGrid()/updateWikiCount().
  DBD.data._loaded = {};

  function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ' '); }

  // ===========================================================================
  // WIKI browser (the 'wiki' view, tab-labelled "Perks"). Six sections, each
  // reading straight off DBD.data — no derived indexes needed at this scale
  // (largest section is 946 add-ons).
  // ===========================================================================
  const WIKI_SECTIONS = [
    { id: 'perks', label: 'Perks', em: '&#128220;' },
    { id: 'addons', label: 'Add-ons', em: '&#129517;' },
    { id: 'items', label: 'Items', em: '&#127920;' },
    { id: 'offerings', label: 'Offerings', em: '&#127991;' },
    { id: 'statuses', label: 'Statuses', em: '&#10052;' },
    { id: 'maps', label: 'Maps', em: '&#128506;' }
  ];
  const SECTIONS_WITH_ROLE = { perks: true, addons: true, items: true, offerings: true };
  // Which boot()-fetched dataset backs each section, so the grid/count can
  // tell "empty because filtered" apart from "empty because not downloaded
  // yet" (D4). Keys match DBD.data._loaded's keys, set in boot().
  const SECTION_DATASET_KEY = { perks: 'perks', addons: 'addons', items: 'items', offerings: 'offerings', statuses: 'statuses', maps: 'maps' };

  function sectionRecords(section) {
    if (section === 'maps') return DBD.data.maps.maps || {};
    return DBD.data[section] || {};
  }

  function matchesRole(entry, role) {
    if (role === 'all') return true;
    return entry.role === role || entry.role == null;
  }

  // L1: cards already display the owner character (perks) - the search box
  // should match it too, same as the loadout picker's owner search.
  // ownerName is precomputed per-record by filteredIds() so a search over
  // 946 add-ons doesn't rebuild a power->character map per keystroke.
  function matchesSearch(entry, q, ownerName) {
    if (!q) return true;
    const hay = (entry.name + ' ' + (ownerName || '') + ' ' + stripTags(entry.description || entry.effect || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function ownerNameForPerk(entry) {
    if (!entry.character) return '';
    const ch = DBD.data.characters[entry.character];
    return ch ? ch.name : '';
  }

  // Power add-ons carry the POWER's name (forPowerNames, e.g. "Bear Trap"),
  // not the killer's - resolve killer name via each character's own power,
  // so searching "trapper" finds his add-ons the same way it finds his perks.
  function buildPowerNameToCharacterName() {
    const map = {};
    const chars = DBD.data.characters || {};
    for (const id in chars) {
      const p = chars[id].power;
      if (p && p.name) map[p.name] = chars[id].name;
    }
    return map;
  }

  function matchesAddonFilter(entry, f) {
    if (entry.kind !== f.addonKind) return false;
    if (f.addonKind === 'power' && f.addonPower) {
      if (!(entry.forPowerNames || []).includes(f.addonPower)) return false;
    }
    if (f.addonKind === 'item' && f.addonItemType) {
      if (entry.forItemType !== f.addonItemType) return false;
    }
    return true;
  }

  function matchesStatusFilter(entry, f) {
    if (f.statusSystem === 'all') return true;
    return entry.system === f.statusSystem;
  }

  function filteredIds(section) {
    const recs = sectionRecords(section);
    const f = DBD.state.filters;
    const q = DBD.state.search.trim().toLowerCase();
    // Only build the power->character map when it can possibly matter: an
    // active query against the addons section.
    const powerMap = (section === 'addons' && q) ? buildPowerNameToCharacterName() : null;
    return Object.keys(recs).filter(function (id) {
      const e = recs[id];
      let ownerName = '';
      if (section === 'perks') ownerName = ownerNameForPerk(e);
      else if (powerMap && e.kind === 'power') ownerName = (e.forPowerNames || []).map(function (pn) { return powerMap[pn] || ''; }).join(' ');
      if (!matchesSearch(e, q, ownerName)) return false;
      if (SECTIONS_WITH_ROLE[section] && !matchesRole(e, f.role)) return false;
      if (section === 'addons' && !matchesAddonFilter(e, f)) return false;
      if (section === 'statuses' && !matchesStatusFilter(e, f)) return false;
      return true;
    }).sort(function (a, b) { return recs[a].name.localeCompare(recs[b].name); });
  }

  function sectionChipsHtml() {
    return '<div class="wiki-chips" id="wikiSectionChips">' + WIKI_SECTIONS.map(function (s) {
      return '<button class="tbtn' + (DBD.state.wikiSection === s.id ? ' on' : '') + '" data-wiki-section="' + s.id + '">' +
        s.em + ' ' + s.label + '</button>';
    }).join('') + '</div>';
  }

  function roleChipsHtml() {
    if (!SECTIONS_WITH_ROLE[DBD.state.wikiSection]) return '';
    const roles = [['all', 'All'], ['killer', 'Killer'], ['survivor', 'Survivor']];
    return '<div class="wiki-chips sub" id="wikiRoleChips">' + roles.map(function (r) {
      return '<button class="tbtn sm' + (DBD.state.filters.role === r[0] ? ' on' : '') + '" data-wiki-role="' + r[0] + '">' + r[1] + '</button>';
    }).join('') + '</div>';
  }

  function addonFilterHtml() {
    if (DBD.state.wikiSection !== 'addons') return '';
    const f = DBD.state.filters;
    const kindChips = ['power', 'item'].map(function (k) {
      return '<button class="tbtn sm' + (f.addonKind === k ? ' on' : '') + '" data-addon-kind="' + k + '">' +
        (k === 'power' ? 'Power add-ons' : 'Item add-ons') + '</button>';
    }).join('');
    let selectHtml = '';
    if (f.addonKind === 'power') {
      const powerNames = Array.from(new Set(Object.values(DBD.data.addons)
        .filter(function (a) { return a.kind === 'power'; })
        .flatMap(function (a) { return a.forPowerNames || []; })
      )).sort();
      selectHtml = '<select class="wiki-select" id="addonPowerSelect"><option value="">Every power</option>' +
        powerNames.map(function (n) { return '<option value="' + DBD.esc(n) + '"' + (f.addonPower === n ? ' selected' : '') + '>' + DBD.esc(n) + '</option>'; }).join('') +
        '</select>';
    } else {
      const itemTypes = Array.from(new Set(Object.values(DBD.data.addons)
        .filter(function (a) { return a.kind === 'item' && a.forItemType; })
        .map(function (a) { return a.forItemType; })
      )).sort();
      selectHtml = '<select class="wiki-select" id="addonItemTypeSelect"><option value="">Every item type</option>' +
        itemTypes.map(function (t) { return '<option value="' + DBD.esc(t) + '"' + (f.addonItemType === t ? ' selected' : '') + '>' + DBD.esc(t) + '</option>'; }).join('') +
        '</select>';
    }
    return '<div class="wiki-chips sub">' + kindChips + '</div><div class="wiki-subrow">' + selectHtml + '</div>';
  }

  function statusFilterHtml() {
    if (DBD.state.wikiSection !== 'statuses') return '';
    const f = DBD.state.filters;
    const opts = [['all', 'All'], ['status-effect', 'Status effects'], ['proficiency-indicator', 'Proficiency']];
    return '<div class="wiki-chips sub">' + opts.map(function (o) {
      return '<button class="tbtn sm' + (f.statusSystem === o[0] ? ' on' : '') + '" data-status-system="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }

  function cardHtml(section, id, entry) {
    const rar = entry.rarity && entry.rarity !== 'none' ? ' ' + DBD.rarityClass(entry.rarity) : '';
    const subLine = section === 'perks'
      ? (entry.general ? 'General' : (DBD.data.characters[entry.character] ? DBD.data.characters[entry.character].name : ''))
      : (entry.role ? (entry.role.charAt(0).toUpperCase() + entry.role.slice(1)) : (entry.realm || ''));
    return '<button class="wiki-card' + rar + '" data-wiki-open="' + section + ':' + DBD.esc(id) + '">' +
      DBD.icon(entry, 'ic48 diamond') +
      '<span class="wc-name">' + DBD.esc(entry.name) + '</span>' +
      (subLine ? '<span class="wc-sub">' + DBD.esc(subLine) + '</span>' : '') +
      '</button>';
  }

  function renderWikiGrid() {
    const grid = DBD.$('#wikiGrid');
    if (!grid) return;
    const section = DBD.state.wikiSection;
    const datasetKey = SECTION_DATASET_KEY[section];
    if (datasetKey && !DBD.data._loaded[datasetKey]) {
      grid.innerHTML = '<div class="hint"><div class="big">&#8987;</div>Loading ' + DBD.esc(section) + '&hellip;<div class="faint">This dataset is still downloading &mdash; it will fill in automatically.</div></div>';
      return;
    }
    const recs = sectionRecords(section);
    const ids = filteredIds(section);
    if (!ids.length) {
      // L2: a role filter carried over from another section (e.g. Killer,
      // still set from Add-ons) against a section like Items - whose 53
      // records are ALL survivor-role - reads as a silent dead end. Name the
      // filter and make it tappable instead of a generic "no results".
      if (SECTIONS_WITH_ROLE[section] && DBD.state.filters.role !== 'all') {
        const roleLabel = DBD.state.filters.role.charAt(0).toUpperCase() + DBD.state.filters.role.slice(1);
        grid.innerHTML = '<div class="hint"><div class="big">&#128269;</div>No results.' +
          '<div class="faint">Try a different search.</div>' +
          '<button class="tbtn role-clear-btn" id="clearRoleFilterBtn">Role filter: ' + DBD.esc(roleLabel) + ' &mdash; tap to clear</button></div>';
        return;
      }
      grid.innerHTML = '<div class="hint"><div class="big">&#128269;</div>No results.<div class="faint">Try a different search or filter.</div></div>';
      return;
    }
    grid.innerHTML = ids.map(function (id) { return cardHtml(section, id, recs[id]); }).join('');
  }

  // D3 fix: role/addon-kind/status/section chips used to call renderWikiGrid()
  // directly and skip the #wikiCount update entirely (only the search box
  // updated it) - the badge would show a stale total against a freshly
  // filtered grid. ONE path now updates both together; every filter control
  // below calls this instead of renderWikiGrid() alone.
  function updateWikiCount() {
    const count = DBD.$('#wikiCount');
    if (!count) return;
    const section = DBD.state.wikiSection;
    const datasetKey = SECTION_DATASET_KEY[section];
    if (datasetKey && !DBD.data._loaded[datasetKey]) { count.textContent = 'loading…'; return; }
    count.textContent = filteredIds(section).length + ' / ' + Object.keys(sectionRecords(section)).length;
  }
  function renderWikiResults() {
    renderWikiGrid();
    updateWikiCount();
  }

  function renderWikiControls() {
    const host = DBD.$('#wikiControls');
    if (!host) return;
    host.innerHTML = sectionChipsHtml() + roleChipsHtml() + addonFilterHtml() + statusFilterHtml();
  }

  function renderWiki(mount) {
    const meta = WIKI_SECTIONS.find(function (s) { return s.id === DBD.state.wikiSection; }) || WIKI_SECTIONS[0];
    mount.innerHTML =
      '<div class="view">' +
      '<h2 class="vh">' + meta.em + ' ' + DBD.esc(meta.label) + ' <span class="muted count" id="wikiCount"></span></h2>' +
      '<div class="search-wrap">' +
      '<span class="search-ic">&#128269;</span>' +
      '<input class="search" id="wikiSearch" type="search" placeholder="Search ' + DBD.esc(meta.label.toLowerCase()) + '..." value="' + DBD.esc(DBD.state.search) + '" />' +
      '<button class="search-clear" id="wikiSearchClear"' + (DBD.state.search ? '' : ' hidden') + '>&times;</button>' +
      '</div>' +
      '<div id="wikiControls"></div>' +
      '<div class="wiki-grid" id="wikiGrid"></div>' +
      '</div>';
    renderWikiControls();
    renderWikiResults();

    const input = DBD.$('#wikiSearch');
    if (input) {
      input.addEventListener('input', function () {
        DBD.state.search = input.value;
        const clr = DBD.$('#wikiSearchClear'); if (clr) clr.hidden = !input.value;
        renderWikiResults();
      });
    }
    const clr = DBD.$('#wikiSearchClear');
    if (clr) clr.addEventListener('click', function () {
      DBD.state.search = '';
      if (input) input.value = '';
      clr.hidden = true;
      renderWikiResults();
    });
  }

  // ---- wiki detail sheets ----------------------------------------------------
  function tierSelectorHtml(entry, activeTier) {
    if (!entry.tiered || !Array.isArray(entry.descriptionTiers) || entry.descriptionTiers.length < 2) return '';
    return '<div class="tier-tabs">' + entry.descriptionTiers.map(function (_, i) {
      return '<button class="tier-tab' + (i === activeTier ? ' on' : '') + '" data-tier="' + i + '">' +
        ['I', 'II', 'III'][i] + '</button>';
    }).join('') + '</div>';
  }

  function ownerCharacterHtml(characterId) {
    const ch = DBD.data.characters[characterId];
    if (!ch) return '';
    if (typeof DBD.openCharacter === 'function') {
      return '<button class="link-btn" data-open-character="' + DBD.esc(characterId) + '">' + DBD.esc(ch.name) + '</button>';
    }
    return DBD.esc(ch.name);
  }

  function perkSheetHtml(id, tier) {
    const entry = DBD.data.perks[id];
    if (!entry) return '<div class="hint">Perk not found.</div>';
    // L3: default to tier III (index 2) - the reference tier players expect,
    // and matches the loadout sheet's own default (was: wiki opened on I).
    tier = typeof tier === 'number' ? tier : 2;
    const desc = entry.tiered && entry.descriptionTiers && entry.descriptionTiers[tier]
      ? entry.descriptionTiers[tier] : entry.description;
    return '<div class="sheet-head">' + DBD.icon(entry, 'ic72 diamond') +
      '<div class="sh-ti"><h3>' + DBD.esc(entry.name) + '</h3>' +
      '<div class="sh-sub">' + (entry.role ? entry.role.charAt(0).toUpperCase() + entry.role.slice(1) + ' perk' : 'Perk') +
      (entry.general ? ' &middot; General' : (entry.character ? ' &middot; ' + ownerCharacterHtml(entry.character) : '')) +
      '</div></div></div>' +
      tierSelectorHtml(entry, tier) +
      '<div class="sheet-desc" id="perkDescBody">' + DBD.formatDesc(desc) + '</div>' +
      ((entry.statusEffects || []).length ? '<div class="sec-h">Status effects</div><div class="chip-row">' +
        entry.statusEffects.map(function (s) { const st = DBD.data.statuses[s]; return '<span class="chip">' + DBD.esc(st ? st.name : s) + '</span>'; }).join('') + '</div>' : '');
  }
  function openPerkSheet(id, tier) {
    DBD.openSheet(perkSheetHtml(id, tier), { label: DBD.data.perks[id] ? DBD.data.perks[id].name : 'Perk', reopen: function () { openPerkSheet(id, tier); } });
    DBD.$$('#sheetBody .tier-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { openPerkSheet(id, Number(btn.dataset.tier)); });
    });
    const openChar = DBD.$('#sheetBody [data-open-character]');
    if (openChar && typeof DBD.openCharacter === 'function') {
      openChar.addEventListener('click', function () { DBD.openCharacter(openChar.dataset.openCharacter); });
    }
  }

  function addonSheetHtml(id) {
    const entry = DBD.data.addons[id];
    if (!entry) return '<div class="hint">Add-on not found.</div>';
    const rarLabel = DBD.rarityLabel(entry.rarity);
    const parent = entry.kind === 'power'
      ? (entry.forPowerNames || []).join(', ')
      : (entry.forItemType || '');
    return '<div class="sheet-head">' + DBD.icon(entry, 'ic72 diamond ' + DBD.rarityClass(entry.rarity)) +
      '<div class="sh-ti"><h3>' + DBD.esc(entry.name) + '</h3>' +
      '<div class="sh-sub">' + (rarLabel ? rarLabel + ' &middot; ' : '') + (entry.role ? entry.role.charAt(0).toUpperCase() + entry.role.slice(1) : '') + '</div>' +
      (parent ? '<div class="sh-sub faint">For ' + DBD.esc(parent) + '</div>' : '') +
      '</div></div>' +
      '<div class="sheet-desc">' + DBD.formatDesc(entry.description) + '</div>';
  }
  function openAddonSheet(id) {
    DBD.openSheet(addonSheetHtml(id), { label: DBD.data.addons[id] ? DBD.data.addons[id].name : 'Add-on', reopen: function () { openAddonSheet(id); } });
  }

  function itemSheetHtml(id) {
    const entry = DBD.data.items[id];
    if (!entry) return '<div class="hint">Item not found.</div>';
    const rarLabel = DBD.rarityLabel(entry.rarity);
    return '<div class="sheet-head">' + DBD.icon(entry, 'ic72 diamond ' + DBD.rarityClass(entry.rarity)) +
      '<div class="sh-ti"><h3>' + DBD.esc(entry.name) + '</h3>' +
      '<div class="sh-sub">' + (rarLabel ? rarLabel + ' &middot; ' : '') + 'Item' +
      (entry.charges != null ? ' &middot; ' + entry.charges + ' charges' : '') + '</div></div></div>' +
      '<div class="sheet-desc">' + DBD.formatDesc(entry.description) + '</div>';
  }
  function openItemSheet(id) {
    DBD.openSheet(itemSheetHtml(id), { label: DBD.data.items[id] ? DBD.data.items[id].name : 'Item', reopen: function () { openItemSheet(id); } });
  }

  function offeringSheetHtml(id) {
    const entry = DBD.data.offerings[id];
    if (!entry) return '<div class="hint">Offering not found.</div>';
    const rarLabel = DBD.rarityLabel(entry.rarity);
    return '<div class="sheet-head">' + DBD.icon(entry, 'ic72 diamond ' + DBD.rarityClass(entry.rarity)) +
      '<div class="sh-ti"><h3>' + DBD.esc(entry.name) + '</h3>' +
      '<div class="sh-sub">' + (rarLabel ? rarLabel + ' &middot; ' : '') + (entry.role ? entry.role.charAt(0).toUpperCase() + entry.role.slice(1) : 'Both roles') +
      (entry.retired ? ' &middot; Retired' : '') + '</div></div></div>' +
      '<div class="sheet-desc">' + DBD.formatDesc(entry.effect) + '</div>';
  }
  function openOfferingSheet(id) {
    DBD.openSheet(offeringSheetHtml(id), { label: DBD.data.offerings[id] ? DBD.data.offerings[id].name : 'Offering', reopen: function () { openOfferingSheet(id); } });
  }

  function statusSheetHtml(id) {
    const entry = DBD.data.statuses[id];
    if (!entry) return '<div class="hint">Status not found.</div>';
    return '<div class="sheet-head">' + DBD.icon(entry, 'ic72 diamond') +
      '<div class="sh-ti"><h3>' + DBD.esc(entry.name) + '</h3>' +
      '<div class="sh-sub">' + (entry.kind ? entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1) : '') +
      (entry.system === 'proficiency-indicator' ? ' &middot; Proficiency indicator' : ' &middot; Status effect') + '</div></div></div>' +
      '<div class="sheet-desc">' + DBD.formatDesc(entry.description) + '</div>';
  }
  function openStatusSheet(id) {
    DBD.openSheet(statusSheetHtml(id), { label: DBD.data.statuses[id] ? DBD.data.statuses[id].name : 'Status', reopen: function () { openStatusSheet(id); } });
  }

  function mapSheetHtml(id) {
    const entry = DBD.data.maps.maps[id];
    if (!entry) return '<div class="hint">Map not found.</div>';
    const killers = (entry.killers || []).map(function (cid) { const c = DBD.data.characters[cid]; return c ? c.name : cid; });
    return '<div class="sheet-head">' + DBD.icon(entry, 'ic72') +
      '<div class="sh-ti"><h3>' + DBD.esc(entry.name) + '</h3>' +
      '<div class="sh-sub">' + DBD.esc(entry.realm || '') + '</div>' +
      (killers.length ? '<div class="sh-sub faint">Killer: ' + DBD.esc(killers.join(', ')) + '</div>' : '') +
      '</div></div>' +
      (entry.description ? '<div class="sheet-desc">' + DBD.formatDesc(entry.description) + '</div>' : '<div class="hint faint">No description on record.</div>');
  }
  function openMapSheet(id) {
    DBD.openSheet(mapSheetHtml(id), { label: DBD.data.maps.maps[id] ? DBD.data.maps.maps[id].name : 'Map', reopen: function () { openMapSheet(id); } });
  }

  const OPEN_BY_SECTION = {
    perks: function (id) { openPerkSheet(id, 2); },
    addons: openAddonSheet,
    items: openItemSheet,
    offerings: openOfferingSheet,
    statuses: openStatusSheet,
    maps: openMapSheet
  };

  function wireWikiDelegation() {
    document.body.addEventListener('click', function (e) {
      const sectionBtn = e.target.closest('[data-wiki-section]');
      if (sectionBtn) {
        DBD.state.wikiSection = sectionBtn.dataset.wikiSection;
        DBD.state.search = '';
        renderWiki(DBD.$('#app'));
        return;
      }
      const roleBtn = e.target.closest('[data-wiki-role]');
      if (roleBtn) {
        // D8: a stale search query against a newly role-filtered grid reads
        // as a confusing empty state - clear it (and the visible input,
        // hence the full renderWiki() rather than a controls-only patch) on
        // every role switch, same as a section switch already did.
        DBD.state.filters.role = roleBtn.dataset.wikiRole;
        DBD.state.search = '';
        renderWiki(DBD.$('#app'));
        return;
      }
      const kindBtn = e.target.closest('[data-addon-kind]');
      if (kindBtn) {
        DBD.state.filters.addonKind = kindBtn.dataset.addonKind;
        DBD.state.filters.addonPower = '';
        DBD.state.filters.addonItemType = '';
        renderWikiControls();
        renderWikiResults();
        return;
      }
      const statusBtn = e.target.closest('[data-status-system]');
      if (statusBtn) {
        DBD.state.filters.statusSystem = statusBtn.dataset.statusSystem;
        renderWikiControls();
        renderWikiResults();
        return;
      }
      const clearRoleBtn = e.target.closest('#clearRoleFilterBtn');
      if (clearRoleBtn) {
        DBD.state.filters.role = 'all';
        renderWikiControls();
        renderWikiResults();
        return;
      }
      const card = e.target.closest('[data-wiki-open]');
      if (card) {
        const parts = card.dataset.wikiOpen.split(':');
        const section = parts[0], id = parts.slice(1).join(':');
        const opener = OPEN_BY_SECTION[section];
        if (opener) opener(id);
      }
    });
    document.body.addEventListener('change', function (e) {
      if (e.target.id === 'addonPowerSelect') { DBD.state.filters.addonPower = e.target.value; renderWikiResults(); }
      if (e.target.id === 'addonItemTypeSelect') { DBD.state.filters.addonItemType = e.target.value; renderWikiResults(); }
    });
  }

  DBD.registerView('wiki', renderWiki);

  // ===========================================================================
  // Freshness stamp + attribution (meta.json is the source of truth — never
  // hardcode a date or count here).
  // ===========================================================================
  function renderStamp() {
    const m = DBD.data.meta || {};
    const pill = DBD.$('#patchPill');
    if (pill) {
      const when = m.pulledAt ? new Date(m.pulledAt).toISOString().slice(0, 10) : '';
      pill.innerHTML = '<b>DBD</b>' + (when ? '<span class="synced">synced ' + DBD.esc(when) + '</span>' : '');
      pill.title = m.pulledAt ? 'Data pulled ' + m.pulledAt : '';
    }
    const foot = DBD.$('#footNote');
    if (foot && Array.isArray(m.attribution) && m.attribution.length) {
      foot.textContent = m.attribution.join(' · ');
    }
  }

  function share() {
    const url = location.href.split('#')[0];
    if (navigator.share) { navigator.share({ title: 'DBD Companion', url: url }).catch(function () {}); }
    else if (navigator.clipboard) { navigator.clipboard.writeText(url); alert('Link copied!'); }
  }

  // ===========================================================================
  // Boot (D4 resilience, 2026-08-31 revision)
  //
  // A single Promise.all across all 10 JSON files had two failure modes: one
  // hung fetch (no timeout) blanked the screen forever, and even a clean run
  // held first paint hostage to the heaviest file (addons.json, 0.66 MB)
  // before anything - including the Characters/Builds tabs, which need none
  // of it - could render. Split into exactly two groups instead:
  //   CRITICAL - meta, characters, perks. Awaited; the app renders once these
  //     three land, matching what index.html's default 'wiki' view needs for
  //     its Perks section plus the freshness stamp.
  //   LAZY - everything else. Fetched in the background AFTER first paint;
  //     each file flips DBD.data._loaded[name] as it resolves (success OR
  //     failure - a permanently-failed file must stop claiming "loading"),
  //     then DBD.render() re-runs so a wiki section sitting on a not-yet-
  //     landed file (see SECTION_DATASET_KEY) swaps from its loading state to
  //     real content, or to an honest empty state if the fetch never came in.
  // Every fetch carries its own ~15s AbortController timeout, so one dead
  // network request degrades a single dataset instead of hanging the boot.
  // ===========================================================================
  const FETCH_TIMEOUT_MS = 15000;
  function fetchJsonTimeout(name) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch('/island/apps/dbd/data/' + name + '.json', { signal: ctrl.signal })
      .then(function (r) { if (!r.ok) throw new Error(name + '.json HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(timer); });
  }

  const DATA_ASSIGN = {
    characters: function (v) { DBD.data.characters = v || {}; },
    perks: function (v) { DBD.data.perks = v || {}; },
    addons: function (v) { DBD.data.addons = v || {}; },
    items: function (v) { DBD.data.items = v || {}; },
    offerings: function (v) { DBD.data.offerings = v || {}; },
    statuses: function (v) { DBD.data.statuses = v || {}; },
    powers: function (v) { DBD.data.powers = v || {}; },
    maps: function (v) { DBD.data.maps = v || { realms: {}, maps: {} }; },
    meta: function (v) { DBD.data.meta = v || {}; },
    'shrine-static': function (v) { DBD.data.shrine = v || null; }
  };

  function showBootError(message) {
    const app = DBD.$('#app');
    if (!app) return;
    app.innerHTML = '<div class="hint"><div class="big">&#9888;</div>Couldn\'t load data.' +
      '<div class="faint">' + DBD.esc(message) + '</div>' +
      '<button class="tbtn" id="bootRetry" style="margin-top:12px">Retry</button></div>';
    const retry = DBD.$('#bootRetry');
    if (retry) retry.addEventListener('click', function () { boot(); });
  }

  function wireChromeOnce() {
    if (DBD._chromeWired) return;
    DBD._chromeWired = true;
    wireWikiDelegation();
    DBD.$$('#tabbar .tab').forEach(function (t) { t.addEventListener('click', function () { DBD.setView(t.dataset.view); }); });
    const sb = DBD.$('#shareBtn'); if (sb) sb.addEventListener('click', share);
  }

  async function boot() {
    const CRITICAL = ['meta', 'characters', 'perks'];
    const LAZY = ['addons', 'items', 'offerings', 'statuses', 'powers', 'maps', 'shrine-static'];

    try {
      const results = await Promise.all(CRITICAL.map(fetchJsonTimeout));
      CRITICAL.forEach(function (name, i) { DATA_ASSIGN[name](results[i]); DBD.data._loaded[name] = true; });
      if (!Object.keys(DBD.data.characters).length || !Object.keys(DBD.data.perks).length) {
        throw new Error('core dataset (characters/perks) came back empty');
      }
    } catch (err) {
      showBootError(err && err.name === 'AbortError' ? 'Request timed out after 15s. Check your connection and retry.' : (err.message || String(err)));
      return;
    }

    renderStamp();
    wireChromeOnce();

    // H1: the island shell's hash-routing shim fires target.click() on the
    // matching tab at PARSE time - before wireChromeOnce() (which runs only
    // after the CRITICAL await above) has attached any tab listeners. A cold
    // load of /island/dbd/#chars therefore booted into the default view no
    // matter what that default was. Self-handle it here instead: read
    // location.hash directly and setView() it if it names a registered view,
    // with no dependency on the shim's early click ever landing.
    // Fix #5: default is 'chars' (Characters - lobby feel), falling back to
    // 'wiki' only if loadout.js failed to register it.
    const hashView = String(location.hash || '').replace('#', '').trim();
    const defaultView = VIEWS['chars'] ? 'chars' : 'wiki';
    const initialView = (hashView && VIEWS[hashView]) ? hashView : defaultView;
    DBD.setView(initialView);

    // LAZY group: does not block first paint. Each file is independently
    // caught so one bad dataset can't take the others down with it.
    Promise.all(LAZY.map(function (name) {
      return fetchJsonTimeout(name)
        .then(function (v) { DATA_ASSIGN[name](v); })
        .catch(function () { /* leave DBD.data[name] at its {} default */ })
        .finally(function () { DBD.data._loaded[name] = true; });
    })).then(function () {
      DBD.render();    // swap any section still showing "Loading..." to real content
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // D6: register the app's own service worker for the STANDALONE run so
  // "works offline" (index.html's own description) is actually true before
  // this app is assembled into the island shell. Deliberately its own
  // single-line, stable-literal statement: the shell's registry `jsReplace`
  // step neuters exactly this call site by swapping the literal for
  // `Promise.resolve()` (see NEW-GAME-TEMPLATE.md's terraria resolve-not-
  // reject note) once this route is mounted, at which point the shell owns
  // the one service worker for the whole app. `.catch()` on its own means
  // the swap-in `Promise.resolve().catch(...)` stays perfectly valid too.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      Promise.resolve().catch(function () {});
    });
  }

})(window.DBD);
