/* loadout.js - the Characters tab for the Dead by Daylight companion.
 *
 * OWNS: the 'chars' view (character select grid + the full-screen loadout
 * screen), the in-memory loadout state, and every sheet it opens.
 *
 * FILE FENCE: this file + css/loadout.css. Nothing else in the app is touched.
 *
 * CONTRACT WITH js/app.js (B1). Everything below is read through a guard, so a
 * missing piece degrades instead of throwing:
 *   DBD.data      {characters, perks, addons, items, offerings, statuses, ...}
 *   DBD.esc(s), DBD.$(sel), DBD.rarityClass(r)
 *   DBD.openSheet(html, crumb), DBD.closeSheet()
 *   DBD.registerView(name, fn), DBD.setView(name)
 *
 * EXPOSES:
 *   DBD.openCharacter(id)  -> switches to the 'chars' view and opens that
 *                             character's loadout screen. Returns true/false.
 *   DBD.loadout.get()      -> a copy of the current loadout
 *   DBD.loadout.set(v)     -> v is an array of perk ids, OR an object
 *                             {character, perks, item, addons, offering}
 *   DBD.loadout.clear()    -> empties every slot, keeps the character
 *   DBD.loadout.setCharacter(id)
 *   DBD.state.loadout      -> the live object (session memory only; the tracker
 *                             lane owns persistence, so NOTHING here writes to
 *                             localStorage)
 *
 * IDS: every dataset is keyed by a stable internal id ("Chuckles" is The
 * Trapper). The UI renders `.name`, never the key. See tools/README.md.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function localEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  // Prefer the shell's escaper so the whole app is consistent; fall back to ours.
  function esc(s) {
    var f = window.DBD && window.DBD.esc;
    if (typeof f === 'function') { try { return f(s == null ? '' : s); } catch (e) { /* fall through */ } }
    return localEsc(s);
  }

  /* Perk / add-on / item / offering text is generated wiki+API prose that
     carries real markup. A survey of every shipped string in data/ finds
     exactly five tags - ul, li, br, b, i - and ZERO attributes anywhere.
     So: escape everything with our own escaper (never DBD.esc, whose exact
     output we do not control), then re-admit only those five bare tags. An
     attribute, a style, a URL or any other tag cannot survive this, because
     the re-admit pattern only matches "&lt;/?tag&gt;" with nothing inside. */
  var RICH_OK = /&lt;(\/?)(ul|ol|li|br|b|i|em|strong)\s*\/?&gt;/gi;
  function rich(s) {
    return localEsc(s).replace(RICH_OK, function (_m, slash, tag) {
      return '<' + slash + tag.toLowerCase() + '>';
    });
  }

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }
  function $$(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }

  function D() { return (window.DBD && window.DBD.data) || null; }

  /* app.js seeds DBD.data with EMPTY dicts and fills them from an async fetch,
     so "data exists" is not the same as "data is loaded". Anything that would
     otherwise render an empty grid has to test for content, not presence. */
  function dataReady() {
    var d = D();
    if (!d || !d.characters || !d.perks) return false;
    for (var k in d.characters) { if (Object.prototype.hasOwnProperty.call(d.characters, k)) return true; }
    return false;
  }
  function dict(name) { var d = D(); return (d && d[name]) || {}; }
  function vals(name) {
    var o = dict(name), out = [], k;
    for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) out.push(o[k]); }
    return out;
  }

  function byName(a, b) {
    var x = String((a && a.name) || ''), y = String((b && b.name) || '');
    return x.localeCompare(y);
  }

  function norm(s) { return String(s == null ? '' : s).toLowerCase(); }

  /* ------------------------------------------------------------- rarities */

  var RARITY_ORDER = { visceral: 0, veryrare: 1, rare: 2, uncommon: 3, common: 4, none: 5 };
  var RARITY_LABEL = {
    common: 'Common', uncommon: 'Uncommon', rare: 'Rare',
    veryrare: 'Very Rare', visceral: 'Visceral', none: 'Standard'
  };

  function rarKey(r) {
    var k = norm(r).replace(/[^a-z]/g, '');
    return RARITY_ORDER.hasOwnProperty(k) ? k : 'none';
  }
  function rarLabel(r) { return RARITY_LABEL[rarKey(r)] || 'Standard'; }
  // Our own class always lands (loadout.css owns these). If the shell also has
  // one, add it alongside so a shared rule can still hook on.
  function rarClass(r) {
    var mine = 'r-' + rarKey(r);
    var f = window.DBD && window.DBD.rarityClass;
    if (typeof f === 'function') {
      try {
        var extra = f(r);
        if (extra && typeof extra === 'string' && extra !== mine) return mine + ' ' + extra;
      } catch (e) { /* ours is enough */ }
    }
    return mine;
  }
  function rarSort(a, b) {
    var d = RARITY_ORDER[rarKey(a && a.rarity)] - RARITY_ORDER[rarKey(b && b.rarity)];
    return d || byName(a, b);
  }

  /* ------------------------------------------------------------------ art */

  /* ALL artwork routes through DBD.icon. It already does lazy-loading, the
     local -> remote chain and - critically - a TERMINAL placeholder via its
     inline onerror. wiki.gg serves its images CORP same-origin, so every
     remote fallback fails in a browser; without a terminal handler a failed
     image renders a broken-image glyph plus overflowing alt text. Never emit
     a bare <img> from this file. noart() is reached only if DBD.icon is
     absent or throws, so that path also lands on a placeholder. */
  function art(entry, cls) {
    var f = window.DBD && window.DBD.icon;
    if (typeof f === 'function') {
      try {
        var h = f(entry, cls || '');
        if (typeof h === 'string' && h) return h;
      } catch (e) { /* fall through to the placeholder */ }
    }
    return noart(cls, entry && entry.name);
  }

  function noart(cls, label) {
    var t = String(label || '?').trim().charAt(0).toUpperCase() || '?';
    return '<span class="dbd-ic-wrap ' + esc(cls || '') + ' miss dbdl-noart" aria-hidden="true">' +
      esc(t) + '</span>';
  }

  /* ---------------------------------------------------------------- state */

  var S = { screen: 'select', role: 'killer', q: '', charId: null };

  function L() {
    var st = window.DBD && window.DBD.state;
    if (!st) return blankLoadout();
    if (!st.loadout) st.loadout = blankLoadout();
    var l = st.loadout;
    if (!Array.isArray(l.perks) || l.perks.length !== 4) l.perks = [null, null, null, null];
    if (!Array.isArray(l.addons) || l.addons.length !== 2) l.addons = [null, null];
    return l;
  }
  function blankLoadout() {
    return { character: null, perks: [null, null, null, null], item: null, addons: [null, null], offering: null };
  }

  function clearGear() { var l = L(); l.item = null; l.addons = [null, null]; l.offering = null; }

  /* ------------------------------------------------------------ selectors */

  function chars(role) {
    return vals('characters').filter(function (c) { return c && c.role === role; }).sort(byName);
  }
  function ch(id) { return (dict('characters')[id]) || null; }
  function perk(id) { return (dict('perks')[id]) || null; }

  function perksForRole(role) {
    return vals('perks').filter(function (p) { return p && p.role === role; });
  }

  /* Teachables first (badged), then general perks, then the rest. */
  function perkPickList(c, q) {
    var role = (c && c.role) || S.role;
    var own = {}, i;
    var teach = [];
    if (c && Array.isArray(c.perks)) {
      for (i = 0; i < c.perks.length; i++) {
        var p = perk(c.perks[i]);
        if (p) { own[p.id] = true; teach.push(p); }
      }
    }
    var rest = perksForRole(role).filter(function (p) { return !own[p.id]; });
    var gen = rest.filter(function (p) { return p.general; }).sort(byName);
    var other = rest.filter(function (p) { return !p.general; }).sort(byName);
    var all = teach.concat(gen, other);
    if (!q) return all;
    var n = norm(q);
    return all.filter(function (p) {
      var owner = p.character ? ch(p.character) : null;
      return norm(p.name).indexOf(n) >= 0 ||
        (owner && norm(owner.name).indexOf(n) >= 0) ||
        (p.general && 'general'.indexOf(n) === 0);
    });
  }

  function addonsForKiller(c) {
    var pid = c && c.power && c.power.id;
    if (!pid) return [];
    return vals('addons').filter(function (a) {
      return a && a.kind === 'power' && Array.isArray(a.forPower) && a.forPower.indexOf(pid) >= 0;
    }).sort(rarSort);
  }
  function addonsForItem(item) {
    var t = item && item.type;
    if (!t) return [];
    return vals('addons').filter(function (a) {
      return a && a.kind === 'item' && a.forItemType === t;
    }).sort(rarSort);
  }
  function survivorItems() {
    return vals('items').filter(function (it) { return it && it.role === 'survivor'; })
      .sort(function (a, b) {
        var ta = String(a.type || 'zz'), tb = String(b.type || 'zz');
        return ta.localeCompare(tb) || rarSort(a, b);
      });
  }
  function offeringsFor(role) {
    return vals('offerings').filter(function (o) {
      return o && (o.role == null || o.role === role);
    }).sort(function (a, b) {
      var ra = a.retired ? 1 : 0, rb = b.retired ? 1 : 0;
      return (ra - rb) || rarSort(a, b);
    });
  }

  function addonPool(c) {
    if (!c) return [];
    if (c.role === 'killer') return addonsForKiller(c);
    var it = L().item ? (dict('items')[L().item] || null) : null;
    return addonsForItem(it);
  }

  function filterList(list, q) {
    if (!q) return list;
    var n = norm(q);
    return list.filter(function (x) { return norm(x && x.name).indexOf(n) >= 0; });
  }

  /* ----------------------------------------------------------- host + paint */

  function hostFor(arg) {
    if (arg && arg.nodeType === 1) return arg;
    if (typeof arg === 'string') { var e = $(arg); if (e) return e; }
    if (arg && arg.host && arg.host.nodeType === 1) return arg.host;
    if (arg && arg.el && arg.el.nodeType === 1) return arg.el;
    var vh = window.DBD && window.DBD.viewHost;
    if (vh && vh.nodeType === 1) return vh;
    if (typeof vh === 'function') { try { var r = vh('chars'); if (r && r.nodeType === 1) return r; } catch (e2) { /* keep looking */ } }
    var guesses = ['#view-chars', '#charsView', '#viewChars', '[data-view="chars"]', '#view', '#views', '#main'];
    for (var i = 0; i < guesses.length; i++) { var g = $(guesses[i]); if (g) return g; }
    return null;
  }

  var painting = false;

  // Re-render in place. Safe to call at any time: a no-op when the chars view
  // is not currently mounted.
  function paint() {
    if (painting) return;
    var root = $('.dbdl-root');
    if (!root || !root.parentNode) return;
    painting = true;
    try { root.parentNode.replaceChild(build(), root); } finally { painting = false; }
  }

  // The registered view renderer. Writes into the host if it got one, and
  // ALWAYS returns the html string, so it satisfies either registerView shape.
  function renderView(arg) {
    var node = build();
    var host = hostFor(arg);
    if (host) { host.innerHTML = ''; host.appendChild(node); }
    return node.outerHTML;
  }

  function build() {
    var wrap = document.createElement('div');
    wrap.className = 'dbdl-root dbdl-scope';
    if (!dataReady()) {
      wrap.setAttribute('data-screen', 'loading');
      wrap.innerHTML = '<div class="dbdl-loading"><span class="dbdl-spark"></span>Loading the Fog&#8230;</div>';
      waitForData();
      return wrap;
    }
    var c = S.screen === 'loadout' ? ch(S.charId) : null;
    if (S.screen === 'loadout' && !c) S.screen = 'select';
    if (c) {
      wrap.setAttribute('data-screen', 'loadout');
      wrap.setAttribute('data-role', c.role);
      wrap.innerHTML = loadoutHtml(c);
    } else {
      wrap.setAttribute('data-screen', 'select');
      wrap.setAttribute('data-role', S.role);
      wrap.innerHTML = selectHtml();
    }
    return wrap;
  }

  var waitTicks = 0, waiting = false;
  function waitForData() {
    if (waiting) return;
    waiting = true;
    var t = setInterval(function () {
      if (dataReady()) { clearInterval(t); waiting = false; paint(); return; }
      if (++waitTicks > 80) { clearInterval(t); waiting = false; }
    }, 125);
  }

  /* --------------------------------------------------------- select screen */

  function selectHtml() {
    var k = chars('killer').length, s = chars('survivor').length;
    var isK = S.role === 'killer';
    return '' +
      '<div class="dbdl-fog" aria-hidden="true"></div>' +
      '<div class="dbdl-rolebar" role="tablist" aria-label="Role">' +
        roleTab('killer', 'Killers', k, isK) +
        roleTab('survivor', 'Survivors', s, !isK) +
      '</div>' +
      '<div class="dbdl-searchwrap">' +
        '<span class="dbdl-searchic" aria-hidden="true">&#8981;</span>' +
        '<input class="dbdl-search" type="search" data-dbdl-q="chars" autocomplete="off" ' +
        'spellcheck="false" placeholder="' + esc(isK ? 'Search killers or powers' : 'Search survivors') + '" ' +
        'aria-label="Search characters" value="' + esc(S.q) + '">' +
      '</div>' +
      '<div class="dbdl-grid" data-dbdl-list="chars">' + cardsHtml() + '</div>';
  }

  function roleTab(role, label, n, on) {
    return '<button type="button" class="dbdl-roletab' + (on ? ' is-on' : '') + '" role="tab" ' +
      'aria-selected="' + (on ? 'true' : 'false') + '" data-dbdl="role" data-role="' + esc(role) + '">' +
      '<span class="dbdl-roletxt">' + esc(label) + '</span>' +
      '<span class="dbdl-count">' + esc(n) + '</span></button>';
  }

  function matchChar(c, n) {
    if (!n) return true;
    if (norm(c.name).indexOf(n) >= 0) return true;
    if (c.power && norm(c.power.name).indexOf(n) >= 0) return true;
    if (c.chapter && norm(c.chapter).indexOf(n) >= 0) return true;
    return false;
  }

  function cardsHtml() {
    var n = norm(S.q);
    var list = chars(S.role).filter(function (c) { return matchChar(c, n); });
    if (!list.length) {
      return '<p class="dbdl-empty">No ' + esc(S.role === 'killer' ? 'killer' : 'survivor') +
        ' matches &#8220;' + esc(S.q) + '&#8221;.</p>';
    }
    return list.map(cardHtml).join('');
  }

  function chapterLine(c) {
    if (c.chapter) return String(c.chapter).replace(/\s*Chapter\s*$/i, '');
    return 'Base Game';
  }

  function cardHtml(c) {
    var sub = c.role === 'killer' ? ((c.power && c.power.name) || chapterLine(c)) : chapterLine(c);
    var sel = L().character === c.id ? ' is-active' : '';
    return '<button type="button" class="dbdl-card' + sel + '" data-dbdl="open" data-id="' + esc(c.id) + '">' +
      '<span class="dbdl-portrait">' +
        art({ portrait: c.portrait, portraitRemote: c.portraitRemote, name: c.name }, 'dbdl-ic-portrait') +
        '<span class="dbdl-vig" aria-hidden="true"></span>' +
      '</span>' +
      '<span class="dbdl-plate">' +
        '<span class="dbdl-cname">' + esc(c.name) + '</span>' +
        '<span class="dbdl-csub">' + esc(sub) + '</span>' +
      '</span></button>';
  }

  /* -------------------------------------------------------- loadout screen */

  function loadoutHtml(c) {
    var isK = c.role === 'killer';
    var portrait = { portrait: c.portrait, portraitRemote: c.portraitRemote, name: c.name };
    var bg = c.portrait || c.portraitRemote || '';

    var hero = '<header class="dbdl-hero">' +
      (bg ? '<span class="dbdl-hero-bg" aria-hidden="true" style="background-image:url(' + esc(bg) + ')"></span>' : '') +
      '<span class="dbdl-hero-scrim" aria-hidden="true"></span>' +
      '<button type="button" class="dbdl-back" data-dbdl="back">' +
        '<span aria-hidden="true">&#8249;</span> ' + esc(isK ? 'All Killers' : 'All Survivors') +
      '</button>' +
      '<div class="dbdl-hero-body">' +
        '<span class="dbdl-hero-art">' + art(portrait, 'dbdl-ic-hero') + '</span>' +
        '<div class="dbdl-hero-txt">' +
          '<p class="dbdl-hero-kick">' + esc(isK ? 'Killer' : 'Survivor') +
            (c.difficulty ? ' <span class="dbdl-dot">&#183;</span> ' + esc(diffLabel(c.difficulty)) : '') + '</p>' +
          '<h2 class="dbdl-hero-name">' + esc(c.name) + '</h2>' +
          '<p class="dbdl-hero-chap">' + esc(chapterLine(c)) + '</p>' +
        '</div>' +
      '</div>' +
    '</header>';

    return hero +
      (isK ? powerCardHtml(c) : loreCardHtml(c)) +
      perkSectionHtml(c) +
      gearSectionHtml(c) +
      teachSectionHtml(c);
  }

  function diffLabel(d) {
    var m = { easy: 'Easy', intermediate: 'Intermediate', hard: 'Hard', veryhard: 'Very Hard' };
    return m[norm(d)] || d;
  }

  function statChip(label, value, unit) {
    if (value == null || value === '') {
      return '<span class="dbdl-stat is-na"><b>&#8212;</b><i>' + esc(label) + '</i></span>';
    }
    return '<span class="dbdl-stat"><b>' + esc(value) + '<u>' + esc(unit || '') + '</u></b><i>' + esc(label) + '</i></span>';
  }

  function powerCardHtml(c) {
    var p = c.power;
    var tr = c.terrorRadius;
    var stats = '<div class="dbdl-stats">' +
      statChip('Movement', c.movementSpeed, ' m/s') +
      statChip('Terror Radius', tr, ' m') +
      '</div>';
    if (!p) return '<section class="dbdl-sec">' + stats + '</section>';
    return '<section class="dbdl-sec">' +
      '<button type="button" class="dbdl-power" data-dbdl="detail" data-kind="power" data-id="' + esc(c.id) + '">' +
        '<span class="dbdl-power-ic">' + art(p, 'ic48') + '</span>' +
        '<span class="dbdl-power-txt">' +
          '<span class="dbdl-power-kick">Power</span>' +
          '<span class="dbdl-power-name">' + esc(p.name) + '</span>' +
          '<span class="dbdl-power-sum">' + esc(p.summary || '') + '</span>' +
        '</span>' +
        '<span class="dbdl-chev" aria-hidden="true">&#8250;</span>' +
      '</button>' + stats +
      (tr == null ? '<p class="dbdl-note">Terror Radius varies with this power and the game ships no base value.</p>' : '') +
    '</section>';
  }

  function loreCardHtml(c) {
    if (!c.lore) return '';
    return '<section class="dbdl-sec"><p class="dbdl-lore">' + esc(c.lore) + '</p></section>';
  }

  /* --- perks -------------------------------------------------------------- */

  function perkSectionHtml(c) {
    var l = L(), i, out = '';
    var used = l.perks.filter(Boolean).length;
    for (i = 0; i < 4; i++) out += perkSlotHtml(i, l.perks[i]);
    return '<section class="dbdl-sec">' +
      '<div class="dbdl-sec-h">' +
        '<h3>Perks <span class="dbdl-of">' + esc(used) + '/4</span></h3>' +
        (used ? '<button type="button" class="dbdl-mini" data-dbdl="clearall">Clear</button>' : '') +
      '</div>' +
      '<div class="dbdl-slots">' + out + '</div>' +
    '</section>';
  }

  function perkSlotHtml(i, id) {
    var p = id ? perk(id) : null;
    var n = i + 1;
    if (!p) {
      return '<div class="dbdl-slot">' +
        '<span class="dbdl-dia is-empty" aria-hidden="true"></span>' +
        '<button type="button" class="dbdl-hit" data-dbdl="pickperk" data-i="' + i + '" ' +
          'aria-label="Perk slot ' + n + ', empty. Choose a perk.">' +
          '<span class="dbdl-plus" aria-hidden="true">+</span>' +
        '</button>' +
        '<span class="dbdl-slot-name is-dim">Perk ' + n + '</span>' +
      '</div>';
    }
    return '<div class="dbdl-slot is-filled">' +
      '<span class="dbdl-dia" aria-hidden="true"></span>' +
      '<button type="button" class="dbdl-hit" data-dbdl="detail" data-kind="perk" data-id="' + esc(p.id) + '" ' +
        'data-slot="' + i + '" aria-label="' + esc(p.name) + ', perk slot ' + n + '">' +
        art(p, 'dbdl-ic-slot') +
      '</button>' +
      '<button type="button" class="dbdl-x" data-dbdl="clearslot" data-kind="perk" data-i="' + i + '" ' +
        'aria-label="Remove ' + esc(p.name) + '">&#215;</button>' +
      '<span class="dbdl-slot-name">' + esc(p.name) + '</span>' +
    '</div>';
  }

  /* --- gear --------------------------------------------------------------- */

  function gearSectionHtml(c) {
    var isK = c.role === 'killer', l = L(), cells = '';
    if (isK) {
      cells += gearCell({
        kick: 'Power', name: (c.power && c.power.name) || '\u2014', rarity: 'none',
        entry: c.power, action: 'detail', data: ' data-kind="power" data-id="' + esc(c.id) + '"', fixed: true
      });
    } else {
      var it = l.item ? (dict('items')[l.item] || null) : null;
      cells += gearCell(it
        ? { kick: 'Item', name: it.name, rarity: it.rarity, entry: it, action: 'detail',
            data: ' data-kind="item" data-id="' + esc(it.id) + '"', clear: ' data-kind="item"' }
        : { kick: 'Item', name: 'Empty', rarity: null, entry: null, action: 'pickitem', data: '', empty: true });
    }

    var pool = addonPool(c);
    for (var i = 0; i < 2; i++) {
      var a = l.addons[i] ? (dict('addons')[l.addons[i]] || null) : null;
      if (a) {
        cells += gearCell({ kick: 'Add-on ' + (i + 1), name: a.name, rarity: a.rarity, entry: a,
          action: 'detail', data: ' data-kind="addon" data-id="' + esc(a.id) + '" data-slot="' + i + '"',
          clear: ' data-kind="addon" data-i="' + i + '"' });
      } else if (!pool.length) {
        cells += gearCell({ kick: 'Add-on ' + (i + 1), name: isK ? 'None' : 'Pick an item', rarity: null,
          entry: null, action: isK ? '' : 'pickitem', data: '', empty: true, locked: true });
      } else {
        cells += gearCell({ kick: 'Add-on ' + (i + 1), name: 'Empty', rarity: null, entry: null,
          action: 'pickaddon', data: ' data-i="' + i + '"', empty: true });
      }
    }

    var o = l.offering ? (dict('offerings')[l.offering] || null) : null;
    cells += gearCell(o
      ? { kick: 'Offering', name: o.name, rarity: o.rarity, entry: o, action: 'detail',
          data: ' data-kind="offering" data-id="' + esc(o.id) + '"', clear: ' data-kind="offering"' }
      : { kick: 'Offering', name: 'Empty', rarity: null, entry: null, action: 'pickoffering', data: '', empty: true });

    return '<section class="dbdl-sec">' +
      '<div class="dbdl-sec-h"><h3>' + esc(isK ? 'Power, Add-ons & Offering' : 'Item, Add-ons & Offering') + '</h3></div>' +
      '<div class="dbdl-gear">' + cells + '</div>' +
    '</section>';
  }

  function gearCell(o) {
    var cls = 'dbdl-gcell ' + rarClass(o.rarity) +
      (o.empty ? ' is-empty' : '') + (o.fixed ? ' is-fixed' : '') + (o.locked ? ' is-locked' : '');
    var inner = o.entry ? art(o.entry, 'dbdl-ic-gear')
      : '<span class="dbdl-plus" aria-hidden="true">' + (o.locked ? '&#8211;' : '+') + '</span>';
    var tag = o.action
      ? '<button type="button" class="dbdl-ghit" data-dbdl="' + esc(o.action) + '"' + (o.data || '') +
        ' aria-label="' + esc(o.kick + ': ' + o.name) + '">' + inner + '</button>'
      : '<span class="dbdl-ghit is-static">' + inner + '</span>';
    return '<div class="' + cls + '">' +
      '<span class="dbdl-gframe" aria-hidden="true"></span>' + tag +
      (o.clear ? '<button type="button" class="dbdl-x" data-dbdl="clearslot"' + o.clear +
        ' aria-label="Remove ' + esc(o.name) + '">&#215;</button>' : '') +
      '<span class="dbdl-gkick">' + esc(o.kick) + '</span>' +
      '<span class="dbdl-gname">' + esc(o.name) + '</span>' +
    '</div>';
  }

  /* --- teachables --------------------------------------------------------- */

  function teachSectionHtml(c) {
    var ids = Array.isArray(c.perks) ? c.perks : [];
    var rows = '';
    for (var i = 0; i < ids.length; i++) {
      var p = perk(ids[i]);
      if (!p) continue;
      rows += '<button type="button" class="dbdl-teach" data-dbdl="detail" data-kind="perk" ' +
        'data-id="' + esc(p.id) + '" data-teach="1">' +
        '<span class="dbdl-teach-ic">' + art(p, 'ic48 diamond') + '</span>' +
        '<span class="dbdl-teach-txt">' +
          '<span class="dbdl-teach-name">' + esc(p.name) + '</span>' +
          '<span class="dbdl-teach-sub">Prestige ' + (i + 1) + ' &#183; Tier ' +
            ['I', 'II', 'III'][i] + ' account-wide</span>' +
        '</span>' +
        '<span class="dbdl-pbadge">P' + (i + 1) + '</span>' +
      '</button>';
    }
    if (!rows) return '';
    return '<section class="dbdl-sec dbdl-teachsec">' +
      '<div class="dbdl-sec-h"><h3>Teachable Perks</h3></div>' +
      '<p class="dbdl-note">Unlock at Prestige 1 / 2 / 3 to make these available to every character.</p>' +
      '<div class="dbdl-teachrow">' + rows + '</div>' +
    '</section>';
  }

  /* --------------------------------------------------------------- sheets */

  /* app.js's crumb is an OBJECT - {label, reopen()} - and it is what drives the
     sheet back-stack (a string is silently ignored and the sheet loses its back
     button). `reopen` must re-run the exact same opener, so every call site
     below hands in a thunk of itself. */
  function openSheet(html, label, reopen) {
    var f = window.DBD && window.DBD.openSheet;
    if (typeof f !== 'function') return false;
    var crumb = (label && typeof reopen === 'function')
      ? { label: String(label), reopen: reopen } : undefined;
    try { f('<div class="dbdl-scope dbdl-sheet">' + html + '</div>', crumb); return true; }
    catch (e) { return false; }
  }
  function closeSheet() {
    var f = window.DBD && window.DBD.closeSheet;
    if (typeof f === 'function') { try { f(); } catch (e) { /* ignore */ } }
  }

  function sheetHead(kick, title, sub) {
    return '<div class="dbdl-sh">' +
      '<p class="dbdl-sh-kick">' + esc(kick) + '</p>' +
      '<h3 class="dbdl-sh-title">' + esc(title) + '</h3>' +
      (sub ? '<p class="dbdl-sh-sub">' + esc(sub) + '</p>' : '') +
    '</div>';
  }

  function searchBox(kind, extra, placeholder) {
    return '<div class="dbdl-searchwrap dbdl-searchwrap-sh">' +
      '<span class="dbdl-searchic" aria-hidden="true">&#8981;</span>' +
      '<input class="dbdl-search" type="search" data-dbdl-q="' + esc(kind) + '"' + (extra || '') +
      ' autocomplete="off" spellcheck="false" aria-label="' + esc(placeholder) + '"' +
      ' placeholder="' + esc(placeholder) + '"></div>';
  }

  /* --- perk picker -------------------------------------------------------- */

  function openPerkPicker(i) {
    var c = ch(S.charId); if (!c) return;
    var list = perkPickList(c, '');
    openSheet(
      sheetHead('Perk slot ' + (i + 1), (c.role === 'killer' ? 'Killer' : 'Survivor') + ' Perks',
        list.length + ' available \u00b7 ' + c.name + '\u2019s teachables first') +
      searchBox('perk', ' data-i="' + i + '"', 'Search perks or owners') +
      '<div class="dbdl-picklist" data-dbdl-list="perk" data-i="' + i + '">' +
        perkRows(list, i, c) + '</div>',
      'Perks', function () { openPerkPicker(i); });
  }

  function perkRows(list, i, c) {
    if (!list.length) return '<p class="dbdl-empty">No perk matches.</p>';
    var own = {};
    if (c && Array.isArray(c.perks)) { for (var k = 0; k < c.perks.length; k++) own[c.perks[k]] = k + 1; }
    var equipped = {};
    L().perks.forEach(function (id, n) { if (id) equipped[id] = n; });
    return list.map(function (p) {
      var owner = p.character ? ch(p.character) : null;
      var sub = p.general ? 'General perk' : (owner ? owner.name : '\u2014');
      var badge = own[p.id] ? '<em class="dbdl-badge">Teachable &#183; P' + own[p.id] + '</em>' : '';
      var here = equipped.hasOwnProperty(p.id);
      return '<div class="dbdl-row' + (here ? ' is-equipped' : '') + '" role="button" tabindex="0" ' +
        'data-dbdl="setperk" data-i="' + i + '" data-id="' + esc(p.id) + '">' +
        '<span class="dbdl-row-ic">' + art(p, 'ic48 diamond') + '</span>' +
        '<span class="dbdl-row-txt">' +
          '<span class="dbdl-row-name">' + esc(p.name) + badge + '</span>' +
          '<span class="dbdl-row-sub">' + esc(sub) +
            (here ? ' &#183; in slot ' + (equipped[p.id] + 1) : '') + '</span>' +
        '</span>' +
        '<button type="button" class="dbdl-row-i" data-dbdl="detail" data-kind="perk" ' +
          'data-id="' + esc(p.id) + '" aria-label="Details for ' + esc(p.name) + '">i</button>' +
      '</div>';
    }).join('');
  }

  /* --- item / add-on / offering pickers ----------------------------------- */

  function openItemPicker() {
    var list = survivorItems();
    openSheet(
      sheetHead('Survivor', 'Items', list.length + ' items \u00b7 add-ons follow the item you pick') +
      searchBox('item', '', 'Search items') +
      '<div class="dbdl-picklist" data-dbdl-list="item">' + itemRows(list) + '</div>',
      'Items', openItemPicker);
  }

  function itemRows(list) {
    if (!list.length) return '<p class="dbdl-empty">No item matches.</p>';
    return list.map(function (it) {
      return simpleRow('setitem', '', it, it.type ? cap(it.type) : 'Special', it.rarity, 'item');
    }).join('');
  }

  function openAddonPicker(i) {
    var c = ch(S.charId); if (!c) return;
    if (c.role === 'survivor' && !L().item) { openItemPicker(); return; }
    var pool = addonPool(c);
    var src = c.role === 'killer'
      ? ((c.power && c.power.name) || 'Power')
      : ((dict('items')[L().item] || {}).name || 'Item');
    openSheet(
      sheetHead('Add-on slot ' + (i + 1), src + ' Add-ons', pool.length + ' available') +
      searchBox('addon', ' data-i="' + i + '"', 'Search add-ons') +
      '<div class="dbdl-picklist" data-dbdl-list="addon" data-i="' + i + '">' + addonRows(pool, i) + '</div>',
      'Add-ons', function () { openAddonPicker(i); });
  }

  function addonRows(list, i) {
    if (!list.length) return '<p class="dbdl-empty">No add-on matches.</p>';
    var used = L().addons;
    return list.map(function (a) {
      var here = used.indexOf(a.id);
      return simpleRow('setaddon', ' data-i="' + i + '"', a, rarLabel(a.rarity), a.rarity, 'addon',
        here >= 0 && here !== i ? 'in slot ' + (here + 1) : '');
    }).join('');
  }

  function openOfferingPicker() {
    var c = ch(S.charId); if (!c) return;
    var list = offeringsFor(c.role);
    openSheet(
      sheetHead('Offering', (c.role === 'killer' ? 'Killer' : 'Survivor') + ' Offerings',
        list.length + ' available') +
      searchBox('offering', '', 'Search offerings') +
      '<div class="dbdl-picklist" data-dbdl-list="offering">' + offeringRows(list) + '</div>',
      'Offerings', openOfferingPicker);
  }

  function offeringRows(list) {
    if (!list.length) return '<p class="dbdl-empty">No offering matches.</p>';
    return list.map(function (o) {
      var sub = rarLabel(o.rarity) + (o.category ? ' \u00b7 ' + cap(o.category) : '');
      return simpleRow('setoffering', '', o, sub, o.rarity, 'offering', o.retired ? 'Retired' : '');
    }).join('');
  }

  function simpleRow(action, extra, e, sub, rarity, kind, note) {
    return '<div class="dbdl-row ' + rarClass(rarity) + '" role="button" tabindex="0" ' +
      'data-dbdl="' + esc(action) + '"' + extra + ' data-id="' + esc(e.id) + '">' +
      '<span class="dbdl-row-ic">' + art(e, 'ic48 diamond ' + rarClass(rarity)) + '</span>' +
      '<span class="dbdl-row-txt">' +
        '<span class="dbdl-row-name">' + esc(e.name) +
          (note ? '<em class="dbdl-badge is-quiet">' + esc(note) + '</em>' : '') + '</span>' +
        '<span class="dbdl-row-sub">' + esc(sub || '') + '</span>' +
      '</span>' +
      '<button type="button" class="dbdl-row-i" data-dbdl="detail" data-kind="' + esc(kind) + '" ' +
        'data-id="' + esc(e.id) + '" aria-label="Details for ' + esc(e.name) + '">i</button>' +
    '</div>';
  }

  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  /* --- detail sheets ------------------------------------------------------ */

  function openDetail(kind, id, slot, fromTeach) {
    if (kind === 'perk') return openPerkDetail(id, slot, fromTeach);
    if (kind === 'power') return openPowerDetail(id);
    var pool = kind === 'addon' ? 'addons' : kind === 'item' ? 'items' : 'offerings';
    var e = dict(pool)[id];
    if (!e) return;
    var sub = rarLabel(e.rarity);
    if (kind === 'addon') {
      if (e.kind === 'power' && e.forPowerNames && e.forPowerNames.length) sub += ' \u00b7 ' + e.forPowerNames.join(', ');
      else if (e.forItemType) sub += ' \u00b7 ' + cap(e.forItemType);
    } else if (kind === 'item' && e.type) { sub += ' \u00b7 ' + cap(e.type); }
    else if (kind === 'offering' && e.category) { sub += ' \u00b7 ' + cap(e.category); }

    var body = e.description || e.effect || '';
    openSheet(
      '<div class="dbdl-dh ' + rarClass(e.rarity) + '">' +
        '<span class="dbdl-dh-ic">' + art(e, 'ic72 diamond ' + rarClass(e.rarity)) + '</span>' +
        '<div class="dbdl-dh-txt"><p class="dbdl-sh-kick">' + esc(cap(kind)) + '</p>' +
          '<h3 class="dbdl-sh-title">' + esc(e.name) + '</h3>' +
          '<p class="dbdl-sh-sub">' + esc(sub) + '</p></div>' +
      '</div>' +
      (e.charges != null ? '<p class="dbdl-fact"><b>' + esc(e.charges) + '</b> charges</p>' : '') +
      '<div class="dbdl-desc">' + rich(body) + '</div>' +
      (e.retired ? '<p class="dbdl-note">Retired &#8211; no longer obtainable in the Bloodweb.</p>' : ''),
      e.name, function () { openDetail(kind, id, slot, fromTeach); });
  }

  function openPowerDetail(charId) {
    var c = ch(charId); if (!c || !c.power) return;
    var p = c.power;
    openSheet(
      '<div class="dbdl-dh">' +
        '<span class="dbdl-dh-ic">' + art(p, 'ic72 diamond') + '</span>' +
        '<div class="dbdl-dh-txt"><p class="dbdl-sh-kick">' + esc(c.name) + '&#8217;s Power</p>' +
          '<h3 class="dbdl-sh-title">' + esc(p.name) + '</h3>' +
          '<p class="dbdl-sh-sub">' + esc(p.summary || '') + '</p></div>' +
      '</div>' +
      '<div class="dbdl-stats dbdl-stats-sh">' +
        statChip('Movement', c.movementSpeed, ' m/s') +
        statChip('Terror Radius', c.terrorRadius, ' m') +
      '</div>' +
      '<div class="dbdl-desc">' + rich(p.description || p.summary || '') + '</div>',
      p.name, function () { openPowerDetail(charId); });
  }

  function openPerkDetail(id, slot, fromTeach) {
    var p = perk(id); if (!p) return;
    var owner = p.character ? ch(p.character) : null;
    var sub = p.general ? 'General perk \u00b7 available to every ' + p.role
      : (owner ? owner.name : '\u2014') + (p.teachableLevel ? ' \u00b7 teachable at level ' + p.teachableLevel : '');
    var equipped = L().perks.indexOf(p.id);
    var target = slot != null ? Number(slot) : (equipped >= 0 ? equipped : firstFree());

    openSheet(
      '<div class="dbdl-dh">' +
        '<span class="dbdl-dh-ic">' + art(p, 'ic72 diamond') + '</span>' +
        '<div class="dbdl-dh-txt"><p class="dbdl-sh-kick">' + esc(cap(p.role)) + ' Perk</p>' +
          '<h3 class="dbdl-sh-title">' + esc(p.name) + '</h3>' +
          '<p class="dbdl-sh-sub">' + esc(sub) + '</p></div>' +
      '</div>' +
      tierBlock(p, 2) +
      statusChips(p) +
      (equipped >= 0
        ? '<button type="button" class="dbdl-act is-off" data-dbdl="clearslot" data-kind="perk" ' +
          'data-i="' + equipped + '">Remove from slot ' + (equipped + 1) + '</button>'
        : '<button type="button" class="dbdl-act" data-dbdl="setperk" data-i="' + target + '" ' +
          'data-id="' + esc(p.id) + '">Equip to slot ' + (target + 1) + '</button>') +
      (fromTeach ? '<p class="dbdl-note">Prestige ' + esc(owner ? owner.name : 'this character') +
        ' to unlock this perk for everyone.</p>' : ''),
      p.name, function () { openPerkDetail(id, slot, fromTeach); });
  }

  function firstFree() {
    var ps = L().perks;
    for (var i = 0; i < 4; i++) { if (!ps[i]) return i; }
    return 0;
  }

  function tierBlock(p, t) {
    var tiers = Array.isArray(p.descriptionTiers) ? p.descriptionTiers : [];
    if (tiers.length < 2) {
      return '<div class="dbdl-desc" data-dbdl-tierbody>' + rich(p.description || '') + '</div>';
    }
    var i, tabs = '';
    var names = ['I', 'II', 'III'];
    for (i = 0; i < tiers.length && i < 3; i++) {
      tabs += '<button type="button" class="tier-tab' + (i === t ? ' on' : '') + '" ' +
        'data-dbdl="tier" data-id="' + esc(p.id) + '" data-t="' + i + '" ' +
        'aria-pressed="' + (i === t ? 'true' : 'false') + '">' + names[i] + '</button>';
    }
    return '<div class="tier-tabs" data-dbdl-tiers>' + tabs + '</div>' +
      '<div class="dbdl-desc" data-dbdl-tierbody>' + rich(tiers[t] || p.description || '') + '</div>';
  }

  function statusChips(p) {
    var ids = Array.isArray(p.statusEffects) ? p.statusEffects : [];
    if (!ids.length) return '';
    var st = dict('statuses'), out = '';
    for (var i = 0; i < ids.length; i++) {
      var s = st[ids[i]];
      if (!s) continue;
      out += '<span class="dbdl-chip is-' + esc(norm(s.kind) || 'both') + '">' +
        art(s, 'dbdl-ic-chip') + esc(s.name) + '</span>';
    }
    return out ? '<div class="dbdl-chips">' + out + '</div>' : '';
  }

  /* --------------------------------------------------------------- actions */

  function setCharacter(id) {
    var c = ch(id); if (!c) return false;
    var l = L();
    if (l.character !== id) {
      // Perks are account-wide once taught, so they survive a same-role swap.
      // Power/item add-ons and the offering do not.
      var prev = l.character ? ch(l.character) : null;
      if (!prev || prev.role !== c.role) l.perks = [null, null, null, null];
      clearGear();
      l.character = id;
    }
    S.charId = id;
    S.role = c.role;
    return true;
  }

  function assign(kind, i, id) {
    var l = L();
    if (kind === 'perk') {
      if (!perk(id)) return;
      var at = l.perks.indexOf(id);
      if (at >= 0 && at !== i) l.perks[at] = null;   // no duplicate perks, as in game
      l.perks[i] = id;
    } else if (kind === 'addon') {
      if (!dict('addons')[id]) return;
      var aa = l.addons.indexOf(id);
      if (aa >= 0 && aa !== i) l.addons[aa] = null;
      l.addons[i] = id;
    } else if (kind === 'item') {
      if (!dict('items')[id]) return;
      if (l.item !== id) l.addons = [null, null];    // add-ons are item-type bound
      l.item = id;
    } else if (kind === 'offering') {
      if (!dict('offerings')[id]) return;
      l.offering = id;
    }
  }

  function clearSlot(kind, i) {
    var l = L();
    if (kind === 'perk') { l.perks[i] = null; }
    else if (kind === 'addon') { l.addons[i] = null; }
    else if (kind === 'item') { l.item = null; l.addons = [null, null]; }
    else if (kind === 'offering') { l.offering = null; }
  }

  /* ------------------------------------------------------------- delegates */

  function onClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-dbdl]');
    if (!el) return;
    var a = el.getAttribute('data-dbdl');
    var id = el.getAttribute('data-id');
    var i = Number(el.getAttribute('data-i') || 0) || 0;

    switch (a) {
      case 'role':
        S.role = el.getAttribute('data-role') === 'survivor' ? 'survivor' : 'killer';
        S.q = ''; paint(); break;

      case 'open':
        ev.preventDefault();
        if (setCharacter(id)) { S.screen = 'loadout'; paint(); scrollTop(); }
        break;

      case 'back':
        S.screen = 'select'; paint(); scrollTop(); break;

      case 'pickperk': openPerkPicker(i); break;
      case 'pickaddon': openAddonPicker(i); break;
      case 'pickitem': openItemPicker(); break;
      case 'pickoffering': openOfferingPicker(); break;

      case 'setperk': assign('perk', i, id); closeSheet(); paint(); break;
      case 'setaddon': assign('addon', i, id); closeSheet(); paint(); break;
      case 'setitem': assign('item', 0, id); closeSheet(); paint(); break;
      case 'setoffering': assign('offering', 0, id); closeSheet(); paint(); break;

      case 'clearslot':
        clearSlot(el.getAttribute('data-kind'), i);
        if (el.closest('.dbdl-sheet')) closeSheet();
        paint(); break;

      case 'clearall': {
        var l = L(); l.perks = [null, null, null, null]; paint(); break;
      }

      case 'detail':
        ev.preventDefault(); ev.stopPropagation();
        openDetail(el.getAttribute('data-kind'), id,
          el.getAttribute('data-slot'), el.getAttribute('data-teach'));
        break;

      case 'tier': {
        var p = perk(id); if (!p) break;
        var t2 = Number(el.getAttribute('data-t') || 0) || 0;
        var body = $('[data-dbdl-tierbody]');
        var tabs = $('[data-dbdl-tiers]');
        var tl = Array.isArray(p.descriptionTiers) ? p.descriptionTiers : [];
        if (body) body.innerHTML = rich(tl[t2] || p.description || '');
        if (tabs) {
          $$('.tier-tab', tabs).forEach(function (b, n) {
            var on = n === t2;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
        }
        break;
      }
      default: break;
    }
  }

  // Search re-renders ONLY the affected list, so the input keeps focus/caret.
  function onInput(ev) {
    var el = ev.target;
    if (!el || !el.getAttribute) return;
    var kind = el.getAttribute('data-dbdl-q');
    if (!kind) return;
    var q = el.value || '';
    var i = Number(el.getAttribute('data-i') || 0) || 0;
    var c = ch(S.charId);

    if (kind === 'chars') {
      S.q = q;
      var grid = $('.dbdl-grid');
      if (grid) grid.innerHTML = cardsHtml();
      return;
    }
    var host = $('[data-dbdl-list="' + kind + '"]');
    if (!host) return;
    if (kind === 'perk') host.innerHTML = perkRows(perkPickList(c, q), i, c);
    else if (kind === 'addon') host.innerHTML = addonRows(filterList(addonPool(c), q), i);
    else if (kind === 'item') host.innerHTML = itemRows(filterList(survivorItems(), q));
    else if (kind === 'offering') host.innerHTML = offeringRows(filterList(offeringsFor(c ? c.role : S.role), q));
  }

  // Keyboard parity for the span-based info affordance inside picker rows.
  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var el = ev.target;
    if (!el || !el.getAttribute || el.getAttribute('role') !== 'button') return;
    if (!el.getAttribute('data-dbdl')) return;
    ev.preventDefault();
    onClick({ target: el, preventDefault: function () {}, stopPropagation: function () {} });
  }

  function scrollTop() {
    try {
      var r = $('.dbdl-root');
      if (r && r.scrollIntoView) r.scrollIntoView({ block: 'start' });
      else window.scrollTo(0, 0);
    } catch (e) { /* non-fatal */ }
  }

  var wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener('click', onClick, false);
    document.addEventListener('input', onInput, false);
    document.addEventListener('keydown', onKey, false);
  }

  /* ------------------------------------------------------------------- API */

  function copyLoadout() {
    var l = L();
    return {
      character: l.character,
      perks: l.perks.slice(0),
      item: l.item,
      addons: l.addons.slice(0),
      offering: l.offering
    };
  }

  function setLoadout(v) {
    var l = L(), i;
    if (Array.isArray(v)) v = { perks: v };
    if (!v || typeof v !== 'object') return copyLoadout();
    if (v.character && ch(v.character)) setCharacter(v.character);
    if (Array.isArray(v.perks)) {
      var next = [null, null, null, null];
      for (i = 0; i < v.perks.length && i < 4; i++) { if (perk(v.perks[i])) next[i] = v.perks[i]; }
      l.perks = next;
    }
    if ('item' in v) l.item = (v.item && dict('items')[v.item]) ? v.item : null;
    if (Array.isArray(v.addons)) {
      var na = [null, null];
      for (i = 0; i < v.addons.length && i < 2; i++) { if (dict('addons')[v.addons[i]]) na[i] = v.addons[i]; }
      l.addons = na;
    }
    if ('offering' in v) l.offering = (v.offering && dict('offerings')[v.offering]) ? v.offering : null;
    paint();
    return copyLoadout();
  }

  function install(DBD) {
    DBD.state = DBD.state || {};
    if (!DBD.state.loadout) DBD.state.loadout = blankLoadout();

    DBD.loadout = {
      get: copyLoadout,
      set: setLoadout,
      clear: function () {
        var l = L();
        l.perks = [null, null, null, null];
        clearGear();
        paint();
        return copyLoadout();
      },
      setCharacter: function (id) { var ok = setCharacter(id); if (ok) paint(); return ok; }
    };

    DBD.openCharacter = function (id) {
      if (!setCharacter(id)) return false;
      /* Called from the wiki tab's perk-sheet owner link: that sheet is still
         open and pageLock('sheet') still has <html>/<body> overflow hidden, so
         without this the user lands on a covered, unscrollable screen. */
      try { if (typeof DBD.closeSheet === 'function') DBD.closeSheet(); } catch (e) { /* non-fatal */ }
      try { if (typeof DBD.pageLock === 'function') DBD.pageLock('sheet', false); } catch (e) { /* non-fatal */ }
      S.screen = 'loadout';
      try { if (typeof DBD.setView === 'function') DBD.setView('chars'); } catch (e) { /* keep going */ }
      paint();
      scrollTop();
      return true;
    };

    wire();
    if (typeof DBD.registerView === 'function') {
      try { DBD.registerView('chars', renderView); } catch (e) { /* shell will re-ask */ }
    }
    DBD.charsReady = true;
  }

  var boots = 0;
  (function boot() {
    if (window.DBD && typeof window.DBD.registerView === 'function') { install(window.DBD); return; }
    if (++boots > 400) return;                 // ~10s, then give up quietly
    setTimeout(boot, 25);
  }());
}());
