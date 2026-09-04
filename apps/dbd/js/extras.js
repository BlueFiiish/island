/* extras.js - the More tab for the Dead by Daylight companion.
 *
 * OWNS: the 'more' view - four panels behind one chip row:
 *   Counters  killer grid -> per-killer counterplay sheet (data/counters-meta.json)
 *   Maps      realm-grouped browser over data/maps.json
 *   Tomes     honest placeholder; no public API exposes live tome data
 *   About     data freshness, attribution, tracker reset (only if the API has one)
 *
 * FILE FENCE: this file + css/extras.css + data/counters-meta.json. Nothing else.
 *
 * CONTRACT WITH js/app.js. Everything is read through a guard so a missing
 * piece degrades instead of throwing:
 *   DBD.data      {characters, perks, maps, meta, ...} - app.js seeds these as
 *                 EMPTY dicts and fills them from an async fetch, so every read
 *                 CONTENT-tests (Object.keys(...).length) rather than presence-tests.
 *   DBD.esc(s), DBD.formatDesc(s), DBD.icon(entry, cls), DBD.rarityClass(r)
 *   DBD.openSheet(html, crumb)   - crumb is {label, reopen()}, an OBJECT
 *   DBD.registerView(name, fn), DBD.setView(name), DBD.openCharacter(id)
 *   DBD.tracker.*  - OPTIONAL. tracker.js may not have installed yet (or at
 *                 all), so every call is lazy + try/catch'd at the call site.
 *
 * STORAGE: this file touches localStorage ZERO times. tracker.js owns the only
 * key this app writes (dbd_tracker_v1) and owns resetting it too - the About
 * panel's reset button renders only if DBD.tracker exposes a reset function,
 * and hides itself otherwise rather than reaching into storage behind its back.
 *
 * NETWORK: exactly one fetch, '/island/apps/dbd/data/counters-meta.json', lazily on first
 * paint of the Counters panel. Nothing else leaves the page.
 *
 * IDS: every dataset is keyed by a stable internal id ("Chuckles" is The
 * Trapper, "K22" is The Twins). The UI renders `.name`, never the key.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  var COUNTERS_URL = '/island/apps/dbd/data/counters-meta.json';
  var WIKI_URL = 'https://deadbydaylight.wiki.gg/';

  var SECTIONS = [
    { id: 'counters', label: 'Counters', em: '&#9876;' },
    { id: 'maps', label: 'Maps', em: '&#128506;' },
    { id: 'tomes', label: 'Tomes', em: '&#128220;' },
    { id: 'about', label: 'About', em: '&#8505;' }
  ];

  /* Module-local state. DBD.state is app.js's; this tab does not extend it. */
  var S = { section: 'counters', q: '' };

  var COUNTERS = null;              /* parsed counters-meta.json */
  var countersState = 'idle';       /* idle | loading | ready | error */
  var countersErr = '';

  var DBD = null;                   /* captured at install() */

  /* ----------------------------------------------------------------- utils */

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /* Local fallbacks so a partially-loaded core still escapes. app.js's esc is
     preferred whenever it is present - it is the same algorithm. */
  function esc(s) {
    if (DBD && typeof DBD.esc === 'function') return DBD.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }
  function fmt(s) {
    if (DBD && typeof DBD.formatDesc === 'function') return DBD.formatDesc(s);
    return esc(s);
  }
  function icon(entry, cls) {
    if (DBD && typeof DBD.icon === 'function') return DBD.icon(entry, cls);
    return '<span class="dbd-ic-wrap ' + esc(cls || 'ic32') + ' miss"></span>';
  }
  function q1(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }
  function dict(o) { return (o && typeof o === 'object') ? o : {}; }
  function count(o) { return Object.keys(dict(o)).length; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(dict(o), k); }

  function characters() { return dict(DBD && DBD.data && DBD.data.characters); }
  function perks() { return dict(DBD && DBD.data && DBD.data.perks); }
  function mapsRoot() {
    var m = (DBD && DBD.data && DBD.data.maps) || {};
    return { realms: dict(m.realms), maps: dict(m.maps) };
  }
  function meta() { return dict(DBD && DBD.data && DBD.data.meta); }

  function charName(id) {
    var c = characters()[id];
    return (c && c.name) ? c.name : id;
  }

  function byName(a, b) {
    return String(a || '').localeCompare(String(b || ''));
  }

  function killerIds() {
    var C = characters(), out = [], id;
    for (id in C) {
      if (!has(C, id)) continue;
      if (C[id] && C[id].role === 'killer') out.push(id);
    }
    out.sort(function (a, b) { return byName(C[a] && C[a].name, C[b] && C[b].name); });
    return out;
  }

  /* Tracker is optional and installs asynchronously. Never cache the handle. */
  function tracker() {
    var t = DBD && DBD.tracker;
    return (t && typeof t === 'object') ? t : null;
  }
  function ownedTier(perkKey) {
    var t = tracker();
    if (!t || typeof t.ownedTier !== 'function') return null;
    try {
      var n = t.ownedTier(perkKey);
      return (typeof n === 'number' && isFinite(n)) ? n : null;
    } catch (e) { return null; }
  }
  function unlockText(perkKey) {
    var t = tracker();
    if (!t || typeof t.unlockPath !== 'function') return '';
    try {
      var up = t.unlockPath(perkKey);
      return (up && up.text) ? String(up.text) : '';
    } catch (e) { return ''; }
  }
  /* tracker.js owns its storage; if it ever exposes a reset we surface it, and
     if it does not we render nothing rather than clearing localStorage here. */
  var RESET_NAMES = ['reset', 'resetProfile', 'clearProfile', 'wipe'];
  function resetFn() {
    var t = tracker(), i;
    if (!t) return null;
    for (i = 0; i < RESET_NAMES.length; i++) {
      if (typeof t[RESET_NAMES[i]] === 'function') {
        return { name: RESET_NAMES[i], fn: t[RESET_NAMES[i]] };
      }
    }
    return null;
  }

  /* --------------------------------------------------------- counters data */

  function loadCounters() {
    if (countersState === 'loading' || countersState === 'ready') return;
    countersState = 'loading';
    var done = function (state, payload) {
      countersState = state;
      if (state === 'ready') COUNTERS = payload; else countersErr = String(payload || 'unknown error');
      repaintPanel();
    };
    try {
      fetch(COUNTERS_URL).then(function (r) {
        if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'));
        return r.json();
      }).then(function (j) {
        if (!j || typeof j !== 'object' || !j.vs) throw new Error('malformed counters file');
        done('ready', j);
      }).catch(function (err) {
        done('error', err && err.message);
      });
    } catch (err) {
      done('error', err && err.message);
    }
  }

  function counterFor(killerId) {
    if (!COUNTERS) return null;
    var vs = dict(COUNTERS.vs);
    return has(vs, killerId) ? vs[killerId] : null;
  }

  /* -------------------------------------------------------------- fragments */

  function bulletsHtml(list, cls) {
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '';
    return '<ul class="dbx-bullets' + (cls ? ' ' + cls : '') + '">' + arr.map(function (b) {
      return '<li>' + esc(b) + '</li>';
    }).join('') + '</ul>';
  }

  function perkChipHtml(perkKey) {
    var P = perks();
    var p = has(P, perkKey) ? P[perkKey] : null;
    if (!p) {
      /* A key that does not resolve is a data bug, not a crash. Say so quietly. */
      return '<div class="dbx-perk missing"><span class="dbx-perk-name">' + esc(perkKey) +
        '</span><span class="dbx-perk-sub">not in this data pull</span></div>';
    }
    var tier = ownedTier(perkKey);
    var badge = '';
    var hint = '';
    if (tier != null) {
      if (tier >= 3) badge = '<span class="dbx-badge own">Owned III</span>';
      else if (tier >= 1) badge = '<span class="dbx-badge own">Owned ' + ['', 'I', 'II', 'III'][tier] + '</span>';
      else {
        badge = '<span class="dbx-badge lock">Locked</span>';
        var t = unlockText(perkKey);
        if (t) hint = '<span class="dbx-perk-hint">' + esc(t) + '</span>';
      }
    }
    var owner = p.general ? 'General perk' : (p.character ? charName(p.character) : 'Survivor perk');
    return '<button class="dbx-perk" data-dbx-perk="' + esc(perkKey) + '">' +
      icon(p, 'ic48 diamond') +
      '<span class="dbx-perk-txt">' +
        '<span class="dbx-perk-name">' + esc(p.name) + '</span>' +
        '<span class="dbx-perk-sub">' + esc(owner) + '</span>' +
        hint +
      '</span>' + badge + '</button>';
  }

  function perkRowHtml(keys) {
    var arr = Array.isArray(keys) ? keys : [];
    if (!arr.length) return '';
    return '<div class="dbx-perkrow">' + arr.map(perkChipHtml).join('') + '</div>';
  }

  /* ----------------------------------------------------------- perk sheet */

  function perkSheetHtml(perkKey) {
    var P = perks();
    var p = has(P, perkKey) ? P[perkKey] : null;
    if (!p) return '<div class="hint">Perk not found in this data pull.</div>';
    var tier = ownedTier(perkKey);
    var owner = p.general ? 'General perk' : (p.character ? charName(p.character) : '');
    var role = p.role ? (p.role.charAt(0).toUpperCase() + p.role.slice(1)) : '';
    var status = '';
    if (tier != null) {
      status = tier >= 1
        ? '<div class="dbx-sheet-note own">Owned at tier ' + ['', 'I', 'II', 'III'][Math.min(3, tier)] + '</div>'
        : '<div class="dbx-sheet-note lock">Locked' + (unlockText(perkKey) ? ' &middot; ' + esc(unlockText(perkKey)) : '') + '</div>';
    }
    var desc = (p.tiered && Array.isArray(p.descriptionTiers) && p.descriptionTiers.length)
      ? p.descriptionTiers[p.descriptionTiers.length - 1]
      : p.description;
    return '<div class="sheet-head">' + icon(p, 'ic72 diamond') +
      '<div class="sh-ti"><h3>' + esc(p.name) + '</h3>' +
      '<div class="sh-sub">' + esc(role ? role + ' perk' : 'Perk') + (owner ? ' &middot; ' + esc(owner) : '') + '</div>' +
      '</div></div>' + status +
      '<div class="sheet-desc">' + fmt(desc) + '</div>';
  }

  function openPerkSheet(perkKey, backCrumb) {
    if (!DBD || typeof DBD.openSheet !== 'function') return;
    var P = perks();
    var label = (has(P, perkKey) && P[perkKey].name) ? P[perkKey].name : 'Perk';
    DBD.openSheet(perkSheetHtml(perkKey), {
      label: label,
      reopen: function () { openPerkSheet(perkKey, backCrumb); }
    });
  }

  /* -------------------------------------------------------- counter sheet */

  function counterSheetHtml(killerId) {
    var C = characters();
    var k = has(C, killerId) ? C[killerId] : null;
    if (!k) return '<div class="hint">Killer not found.</div>';
    var c = counterFor(killerId);
    var powerName = (k.power && k.power.name) ? k.power.name : '';
    var head = '<div class="sheet-head">' + icon(k, 'ic72') +
      '<div class="sh-ti"><h3>' + esc(k.name) + '</h3>' +
      '<div class="sh-sub">' + (powerName ? esc(powerName) : 'Killer') + '</div>' +
      (k.movementSpeed != null
        ? '<div class="sh-sub faint">' + esc(k.movementSpeed) + ' m/s' +
          (k.terrorRadius != null ? ' &middot; ' + esc(k.terrorRadius) + ' m terror radius' : '') + '</div>'
        : '') +
      '</div></div>';

    if (!c) {
      return head + '<div class="hint faint">No counterplay notes on record for this killer yet.</div>';
    }

    var out = head;
    if (c.threat) out += '<div class="dbx-threat"><span class="dbx-threat-lab">Threat</span>' + esc(c.threat) + '</div>';
    if (c.fromPowerText) {
      out += '<div class="dbx-src">Written from this killer\'s in-game power description rather than from played experience.</div>';
    }
    if (Array.isArray(c.counters) && c.counters.length) {
      out += '<div class="sec-h">Counterplay</div>' + bulletsHtml(c.counters);
    }
    if (Array.isArray(c.perks) && c.perks.length) {
      out += '<div class="sec-h">Perks that help</div>' + perkRowHtml(c.perks);
    }
    if (Array.isArray(c.avoid) && c.avoid.length) {
      out += '<div class="sec-h">Common mistakes</div>' + bulletsHtml(c.avoid, 'bad');
    }
    if (typeof (DBD && DBD.openCharacter) === 'function') {
      out += '<div class="dbx-actions"><button class="link-btn" data-dbx-char="' + esc(killerId) + '">' +
        'Open ' + esc(k.name) + ' in Characters' + '</button></div>';
    }
    return out;
  }

  function openCounterSheet(killerId) {
    if (!DBD || typeof DBD.openSheet !== 'function') return;
    DBD.openSheet(counterSheetHtml(killerId), {
      label: charName(killerId),
      reopen: function () { openCounterSheet(killerId); }
    });
  }

  /* ------------------------------------------------------------ map sheets */

  function mapSheetHtml(mapId) {
    var M = mapsRoot().maps;
    var m = has(M, mapId) ? M[mapId] : null;
    if (!m) return '<div class="hint">Map not found.</div>';
    var kn = (Array.isArray(m.killers) ? m.killers : []).map(charName).filter(Boolean);
    return '<div class="sheet-head">' + icon(m, 'ic72') +
      '<div class="sh-ti"><h3>' + esc(m.name) + '</h3>' +
      '<div class="sh-sub">' + esc(m.realm || '') + '</div>' +
      (kn.length
        ? '<div class="sh-sub faint">Killer: ' + esc(kn.join(', ')) + '</div>'
        : '<div class="sh-sub faint">No killer tied to this map</div>') +
      '</div></div>' +
      (m.description
        ? '<div class="sheet-desc">' + fmt(m.description) + '</div>'
        : '<div class="hint faint">No description on record.</div>');
  }

  function openMapSheet(mapId, realmId) {
    if (!DBD || typeof DBD.openSheet !== 'function') return;
    var M = mapsRoot().maps;
    var label = (has(M, mapId) && M[mapId].name) ? M[mapId].name : 'Map';
    DBD.openSheet(mapSheetHtml(mapId), {
      label: label,
      reopen: function () { openMapSheet(mapId, realmId); }
    });
  }

  function realmSheetHtml(realmId) {
    var root = mapsRoot();
    var r = has(root.realms, realmId) ? root.realms[realmId] : null;
    if (!r) return '<div class="hint">Realm not found.</div>';
    var ids = (Array.isArray(r.maps) ? r.maps : []).filter(function (id) { return has(root.maps, id); });
    ids.sort(function (a, b) { return byName(root.maps[a].name, root.maps[b].name); });
    var rows = ids.map(function (id) {
      var m = root.maps[id];
      var kn = (Array.isArray(m.killers) ? m.killers : []).map(charName).filter(Boolean);
      return '<button class="dbx-maprow" data-dbx-map="' + esc(id) + '" data-dbx-realm="' + esc(realmId) + '">' +
        icon(m, 'ic48') +
        '<span class="dbx-maprow-txt">' +
          '<span class="dbx-maprow-name">' + esc(m.name) + '</span>' +
          '<span class="dbx-maprow-sub">' + (kn.length ? esc(kn.join(', ')) : 'No killer tied to this map') + '</span>' +
        '</span><span class="dbx-caret">&rsaquo;</span></button>';
    }).join('');
    return '<div class="sheet-head"><div class="sh-ti"><h3>' + esc(r.name || realmId) + '</h3>' +
      '<div class="sh-sub">' + ids.length + ' map' + (ids.length === 1 ? '' : 's') + '</div></div></div>' +
      (rows ? '<div class="dbx-maplist">' + rows + '</div>' : '<div class="hint faint">No maps on record for this realm.</div>');
  }

  function openRealmSheet(realmId) {
    if (!DBD || typeof DBD.openSheet !== 'function') return;
    var root = mapsRoot();
    var label = (has(root.realms, realmId) && root.realms[realmId].name) ? root.realms[realmId].name : 'Realm';
    DBD.openSheet(realmSheetHtml(realmId), {
      label: label,
      reopen: function () { openRealmSheet(realmId); }
    });
  }

  /* ---------------------------------------------------------- panel: counters */

  function countersPanelHtml() {
    if (!count(characters())) {
      return '<div class="hint"><div class="big">&#8987;</div>Loading character data...</div>';
    }
    if (countersState === 'error') {
      return '<div class="hint"><div class="big">&#9888;</div>Couldn\'t load the counters file.' +
        '<div class="faint">' + esc(countersErr) + '</div></div>';
    }
    var ids = killerIds();
    var q = String(S.q || '').trim().toLowerCase();
    if (q) {
      var C = characters();
      ids = ids.filter(function (id) {
        var k = C[id];
        var hay = String(k.name || '') + ' ' + String((k.power && k.power.name) || '');
        return hay.toLowerCase().indexOf(q) !== -1;
      });
    }

    var loading = (countersState !== 'ready')
      ? '<div class="dbx-note">Loading counterplay notes...</div>' : '';

    var covered = 0;
    if (countersState === 'ready') {
      killerIds().forEach(function (id) { if (counterFor(id)) covered++; });
    }

    var grid = ids.length
      ? '<div class="dbx-grid">' + ids.map(function (id) {
          var k = characters()[id];
          var ready = countersState === 'ready' && !!counterFor(id);
          return '<button class="dbx-kcard' + (ready ? ' has' : '') + '" data-dbx-killer="' + esc(id) + '">' +
            icon(k, 'ic48') +
            '<span class="dbx-kname">' + esc(k.name) + '</span>' +
            '<span class="dbx-ksub">' + esc((k.power && k.power.name) || '') + '</span>' +
            '</button>';
        }).join('') + '</div>'
      : '<div class="hint"><div class="big">&#128269;</div>No killer matches that search.</div>';

    var fundamentals = '';
    if (countersState === 'ready' && COUNTERS && COUNTERS.general) {
      var g = COUNTERS.general;
      if (Array.isArray(g.survivorFundamentals) && g.survivorFundamentals.length) {
        fundamentals += '<div class="dbx-card"><div class="dbx-card-h">Survivor fundamentals</div>' +
          bulletsHtml(g.survivorFundamentals) + '</div>';
      }
      if (Array.isArray(g.killerFundamentals) && g.killerFundamentals.length) {
        fundamentals += '<div class="dbx-card"><div class="dbx-card-h">Killer fundamentals</div>' +
          bulletsHtml(g.killerFundamentals) + '</div>';
      }
    }

    return '<div class="search-wrap">' +
      '<span class="search-ic">&#128269;</span>' +
      '<input class="search" id="dbxKillerSearch" type="search" placeholder="Search killers..." value="' + esc(S.q) + '" />' +
      '</div>' +
      '<div class="dbx-sub">' +
        (countersState === 'ready'
          ? esc(covered + ' of ' + killerIds().length + ' killers have counterplay notes')
          : 'Counterplay notes') +
      '</div>' + loading + grid + fundamentals;
  }

  /* ------------------------------------------------------------- panel: maps */

  function mapsPanelHtml() {
    var root = mapsRoot();
    var realmIds = Object.keys(root.realms);
    if (!realmIds.length) {
      return '<div class="hint"><div class="big">&#8987;</div>Loading map data...</div>';
    }
    realmIds.sort(function (a, b) { return byName(root.realms[a].name || a, root.realms[b].name || b); });

    var cards = realmIds.map(function (rid) {
      var r = root.realms[rid];
      var ids = (Array.isArray(r.maps) ? r.maps : []).filter(function (id) { return has(root.maps, id); });
      /* Thumbnail: the first map in the realm that actually has art. Many maps
         ship neither image nor imageRemote (meta.artUnresolved) - DBD.icon's
         neutral placeholder covers those, so a realm with no art at all still
         renders a tile rather than a hole. */
      var thumb = null, i;
      for (i = 0; i < ids.length; i++) {
        var m = root.maps[ids[i]];
        if (m && (m.image || m.imageRemote)) { thumb = m; break; }
      }
      if (!thumb && ids.length) thumb = root.maps[ids[0]];
      return '<button class="dbx-realm" data-dbx-realm-open="' + esc(rid) + '">' +
        icon(thumb, 'ic48') +
        '<span class="dbx-realm-txt">' +
          '<span class="dbx-realm-name">' + esc(r.name || rid) + '</span>' +
          '<span class="dbx-realm-sub">' + ids.length + ' map' + (ids.length === 1 ? '' : 's') + '</span>' +
        '</span><span class="dbx-caret">&rsaquo;</span></button>';
    }).join('');

    return '<div class="dbx-sub">' + esc(realmIds.length + ' realms, ' + count(root.maps) + ' maps') + '</div>' +
      '<div class="dbx-realmlist">' + cards + '</div>' +
      '<div class="dbx-card"><div class="dbx-card-h">Loop guides</div>' +
      '<p class="dbx-p">Per-tile loop breakdowns are not in this build. What is here is the realm ' +
      'and map roster with the killer each map is tied to, plus the in-game description.</p></div>';
  }

  /* ------------------------------------------------------------ panel: tomes */

  function tomesPanelHtml() {
    return '<div class="dbx-card"><div class="dbx-card-h">&#128220; Tomes</div>' +
      '<p class="dbx-p">Tome and challenge tracking is coming in a later update.</p>' +
      '<p class="dbx-p faint">There is no public API that exposes live tome data - the community API ' +
      'this app is built on has no tome endpoint, and the tomes path on dbd.tricky.lol returns 404. ' +
      'Rather than ship an invented or hand-frozen tome list that quietly goes stale, this panel ' +
      'shows nothing until a real source exists.</p></div>';
  }

  /* ------------------------------------------------------------ panel: about */

  function aboutPanelHtml() {
    var m = meta();
    var c = dict(m.counts);
    var when = '';
    if (m.pulledAt) {
      try { when = new Date(m.pulledAt).toISOString().slice(0, 10); } catch (e) { when = String(m.pulledAt); }
    }

    var rows = [
      ['Killers', c.killers], ['Survivors', c.survivors], ['Perks', c.perks],
      ['Powers', c.powers], ['Add-ons', c.addons], ['Items', c.items],
      ['Offerings', c.offerings], ['Status effects', c.statuses],
      ['Maps', c.maps], ['Realms', c.realms]
    ].filter(function (r) { return r[1] != null; }).map(function (r) {
      return '<div class="dbx-stat"><span class="dbx-stat-n">' + esc(r[1]) + '</span>' +
        '<span class="dbx-stat-l">' + esc(r[0]) + '</span></div>';
    }).join('');

    var freshness = '<div class="dbx-card"><div class="dbx-card-h">Data</div>' +
      (when
        ? '<p class="dbx-p">Last synced <b>' + esc(when) + '</b>.</p>'
        : '<p class="dbx-p faint">No sync date on record.</p>') +
      (rows ? '<div class="dbx-stats">' + rows + '</div>' : '') +
      '</div>';

    var attrList = Array.isArray(m.attribution) ? m.attribution : [];
    var lic = dict(m.licence);
    var licLines = Object.keys(lic).map(function (k) {
      return '<li><b>' + esc(k) + '</b> - ' + esc(lic[k]) + '</li>';
    }).join('');

    var credits = '<div class="dbx-card"><div class="dbx-card-h">Attribution and licence</div>' +
      (attrList.length ? bulletsHtml(attrList) : '<p class="dbx-p faint">No attribution on record.</p>') +
      (licLines ? '<ul class="dbx-bullets fine">' + licLines + '</ul>' : '') +
      '<p class="dbx-p"><a class="link" href="' + WIKI_URL + '" target="_blank" rel="noopener noreferrer">' +
      'Dead by Daylight Wiki (deadbydaylight.wiki.gg)</a></p>' +
      '<p class="dbx-p faint">Counterplay notes in the Counters panel are hand-written for this app ' +
      'and are opinion, not sourced game data.</p></div>';

    var t = tracker();
    var reset = resetFn();
    var trackerCard = '<div class="dbx-card"><div class="dbx-card-h">Tracker profile</div>' +
      (t
        ? '<p class="dbx-p faint">Your prestige and perk-ownership data is stored on this device only, ' +
          'by the Tracker tab. Nothing is uploaded.</p>'
        : '<p class="dbx-p faint">The Tracker tab has not loaded, so no profile data is available here.</p>') +
      (reset
        ? '<button class="dbx-danger" data-dbx-reset="1">Reset tracker profile</button>' +
          '<p class="dbx-p faint">This clears every prestige value and perk override on this device.</p>'
        : '') +
      '</div>';

    return freshness + trackerCard + credits;
  }

  /* ----------------------------------------------------------------- render */

  function chipsHtml() {
    return '<div class="wiki-chips" id="dbxChips">' + SECTIONS.map(function (s) {
      return '<button class="tbtn' + (S.section === s.id ? ' on' : '') + '" data-dbx-section="' + s.id + '">' +
        s.em + ' ' + s.label + '</button>';
    }).join('') + '</div>';
  }

  function panelHtml() {
    if (S.section === 'maps') return mapsPanelHtml();
    if (S.section === 'tomes') return tomesPanelHtml();
    if (S.section === 'about') return aboutPanelHtml();
    return countersPanelHtml();
  }

  /* Repaint only the panel, so an async counters load does not blow away the
     search box the user is typing in. */
  function repaintPanel() {
    var host = q1('#dbxPanel');
    if (!host) return;
    var focused = document.activeElement;
    var keepFocus = !!(focused && focused.id === 'dbxKillerSearch');
    host.innerHTML = panelHtml();
    if (keepFocus) {
      var input = q1('#dbxKillerSearch');
      if (input) { try { input.focus(); input.selectionStart = input.value.length; } catch (e) { /* fine */ } }
    }
  }

  function renderView(mount) {
    if (!mount) return;
    var cur = SECTIONS.filter(function (s) { return s.id === S.section; })[0] || SECTIONS[0];
    mount.innerHTML =
      '<div class="view dbx-root">' +
        '<h2 class="vh">' + cur.em + ' ' + esc(cur.label) + '</h2>' +
        chipsHtml() +
        '<div id="dbxPanel">' + panelHtml() + '</div>' +
      '</div>';
    if (S.section === 'counters') loadCounters();
  }

  /* ------------------------------------------------------------------ wiring */

  function onClick(e) {
    var t = e && e.target;
    if (!t || !t.closest) return;

    var sec = t.closest('[data-dbx-section]');
    if (sec) {
      S.section = sec.getAttribute('data-dbx-section');
      S.q = '';
      var app = q1('#app');
      if (app) renderView(app);
      if (S.section === 'counters') loadCounters();
      return;
    }

    var kb = t.closest('[data-dbx-killer]');
    if (kb) { openCounterSheet(kb.getAttribute('data-dbx-killer')); return; }

    var pb = t.closest('[data-dbx-perk]');
    if (pb) { openPerkSheet(pb.getAttribute('data-dbx-perk')); return; }

    var ch = t.closest('[data-dbx-char]');
    if (ch) {
      var cid = ch.getAttribute('data-dbx-char');
      try {
        if (typeof DBD.closeSheet === 'function') DBD.closeSheet();
        if (typeof DBD.openCharacter === 'function') DBD.openCharacter(cid);
      } catch (err) { /* the sheet stays put; nothing to recover */ }
      return;
    }

    var ro = t.closest('[data-dbx-realm-open]');
    if (ro) { openRealmSheet(ro.getAttribute('data-dbx-realm-open')); return; }

    var mp = t.closest('[data-dbx-map]');
    if (mp) { openMapSheet(mp.getAttribute('data-dbx-map'), mp.getAttribute('data-dbx-realm')); return; }

    var rs = t.closest('[data-dbx-reset]');
    if (rs) {
      var r = resetFn();
      if (!r) return;
      var ok = true;
      try {
        ok = window.confirm('Reset the tracker profile on this device? Every prestige value and perk override will be cleared.');
      } catch (err) { ok = true; }
      if (!ok) return;
      try { r.fn.call(tracker()); } catch (err) { /* tracker owns the failure path */ }
      repaintPanel();
      return;
    }
  }

  function onInput(e) {
    var t = e && e.target;
    if (!t || t.id !== 'dbxKillerSearch') return;
    S.q = t.value || '';
    /* Repaint the grid only - rebuilding the whole panel would drop the caret. */
    var host = q1('#dbxPanel');
    if (!host) return;
    var grid = host.querySelector('.dbx-grid');
    var hint = host.querySelector('.hint');
    var frag = document.createElement('div');
    frag.innerHTML = countersPanelHtml();
    var newGrid = frag.querySelector('.dbx-grid');
    var newHint = frag.querySelector('.hint');
    var oldNode = grid || hint;
    var newNode = newGrid || newHint;
    if (oldNode && newNode) oldNode.parentNode.replaceChild(newNode, oldNode);
  }

  var wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    try {
      document.addEventListener('click', onClick, false);
      document.addEventListener('input', onInput, false);
    } catch (e) { /* a hostless environment still gets the view fn */ }
  }

  /* ----------------------------------------------------------------- install */

  function install(host) {
    DBD = host;
    wire();
    if (typeof DBD.registerView === 'function') {
      try { DBD.registerView('more', renderView); } catch (e) { /* shell will re-ask */ }
    }
    DBD.extrasReady = true;
    /* Exposed for the node harness and for any later lane that needs the
       counterplay dataset without re-fetching it. */
    DBD.extras = {
      renderMore: renderView,
      sections: function () { return SECTIONS.map(function (s) { return s.id; }); },
      counters: function () { return COUNTERS; },
      loadCounters: loadCounters,
      countersUrl: COUNTERS_URL
    };
  }

  var boots = 0;
  (function boot() {
    if (window.DBD && typeof window.DBD.registerView === 'function') { install(window.DBD); return; }
    if (++boots > 400) return;                 /* ~10s, then give up quietly */
    setTimeout(boot, 25);
  }());
}());
