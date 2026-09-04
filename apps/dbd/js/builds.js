/* builds.js - the Builds tab for the Dead by Daylight companion.
 *
 * OWNS: the 'builds' view (build generator, roulette, share codes) and the
 * sheets it opens. FILE FENCE: this file + css/builds.css + the hand-curated
 * data/builds-meta.json. Nothing else in the app is touched.
 *
 * CONTRACT WITH js/app.js (B1). Everything is read through a guard so a
 * missing piece degrades instead of throwing:
 *   DBD.data {characters, perks, ...}  - seeded EMPTY, filled by an async
 *                                        fetch, so presence != loaded. Every
 *                                        gate below content-tests, never
 *                                        truthiness.
 *   DBD.esc(s), DBD.$(sel)
 *   DBD.openSheet(html, crumb)  - crumb is {label, reopen()}
 *   DBD.registerView(name, fn), DBD.setView(name)
 *
 * CONTRACT WITH js/loadout.js (B2):
 *   DBD.loadout.set(v) / .setCharacter(id), DBD.openCharacter(id)
 *   ORDER MATTERS: setCharacter() wipes the perk array on a ROLE change, so
 *   the character is always assigned BEFORE the perks are written.
 *
 * CONTRACT WITH js/tracker.js (B5) - loads AFTER this file, so it is read
 * LAZILY at render/interaction time and never captured at boot:
 *   DBD.tracker.isOwned(perkId, forCharacterId?)  -> bool
 *   DBD.tracker.ownedTier(perkId, forCharacterId?) -> 0..3
 *   DBD.tracker.unlockPath(perkId) -> {text}|null
 *   DBD.tracker.onChange(fn)
 *   With NO tracker present: every perk is treated as owned, the owned-only
 *   toggle is hidden and no unlock hint is rendered.
 *
 * IDS: perks.json is keyed by inconsistent internal ids ("SelfSufficient" is
 * Unbreakable, "K26P02" is Scourge Hook: Pain Resonance). The UI renders
 * `.name`, never the key. Share codes carry keys, never names.
 *
 * NO localStorage IS WRITTEN HERE. The tracker lane owns persistence; share
 * codes are stateless.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function localEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  function esc(s) {
    var f = window.DBD && window.DBD.esc;
    if (typeof f === 'function') { try { return f(s == null ? '' : s); } catch (e) { /* fall through */ } }
    return localEsc(s);
  }

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function D() { return (window.DBD && window.DBD.data) || null; }

  function dict(name) {
    var d = D();
    return (d && d[name] && typeof d[name] === 'object') ? d[name] : {};
  }

  /* app.js seeds DBD.data with EMPTY dicts and fills them from an async fetch,
     so "the dict exists" is not "the dict is loaded". Content-test. */
  function dataReady() {
    var p = dict('perks'), k;
    for (k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) return true; }
    return false;
  }

  function perk(id) {
    var p = dict('perks')[id];
    return (p && typeof p === 'object') ? p : null;
  }

  function chr(id) {
    var c = dict('characters')[id];
    return (c && typeof c === 'object') ? c : null;
  }

  function perkName(id) {
    var p = perk(id);
    return p && p.name ? String(p.name).trim() : String(id);
  }

  /* ALL artwork routes through DBD.icon (app.js), exactly as loadout.js does.
     DBD.icon owns lazy-loading, the local -> remote chain and a TERMINAL
     placeholder via its inline onerror - and, critically, it emits the
     .dbd-ic-wrap > .dbd-ic-inner > img.dbd-ic box that every SIZING rule keys
     off (style.css sizes by the wrap's class; loadout.css adds
     .dbd-ic-wrap.dbdl-ic-slot { width:100%; height:100% }).
     A bare <img> has NO sizing rule anywhere: its intrinsic 128px width blew
     the 4-up diamond row out to 542px and gave the whole page a horizontal
     scrollbar at 390px (browser-verified defect, 2026-08-31). Never emit a
     bare <img> from this file - always pass a wrap class that some stylesheet
     actually sizes, and see the defensive floor in css/builds.css. */
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

  /* Perk prose carries real markup (ul/li/br/b/i) and zero attributes. Escape
     with our own escaper, then re-admit exactly those bare tags. */
  var RICH_OK = /&lt;(\/?)(ul|ol|li|br|b|i|em|strong)\s*\/?&gt;/gi;
  function rich(s) {
    return localEsc(s).replace(RICH_OK, function (_m, slash, tag) {
      return '<' + slash + tag.toLowerCase() + '>';
    });
  }

  /* ---------------------------------------------------------- tracker seam */

  function TR() {
    var t = window.DBD && window.DBD.tracker;
    return (t && typeof t === 'object') ? t : null;
  }

  /* True only when the tracker exposes an ownership answer we can act on.
     Anything less and the whole owned-only feature stays hidden. */
  function trackerLive() {
    var t = TR();
    return !!(t && (typeof t.isOwned === 'function' || typeof t.ownedTier === 'function'));
  }

  function isOwned(id) {
    var t = TR(), r;
    if (!t) return true;
    try {
      if (typeof t.isOwned === 'function') {
        r = t.isOwned(id, S.charId || undefined);
        return r !== false;
      }
      if (typeof t.ownedTier === 'function') {
        r = t.ownedTier(id, S.charId || undefined);
        return !(typeof r === 'number' && r <= 0);
      }
    } catch (e) { /* a throwing tracker must not break the generator */ }
    return true;
  }

  function ownedTier(id) {
    var t = TR(), r;
    if (!t || typeof t.ownedTier !== 'function') return null;
    try { r = t.ownedTier(id, S.charId || undefined); } catch (e) { return null; }
    return (typeof r === 'number' && r > 0 && r <= 3) ? r : null;
  }

  function unlockHint(id) {
    var t = TR(), r;
    if (!t || typeof t.unlockPath !== 'function') return '';
    try { r = t.unlockPath(id); } catch (e) { return ''; }
    if (!r) return '';
    if (typeof r === 'string') return r;
    if (typeof r === 'object' && typeof r.text === 'string') return r.text;
    return '';
  }

  var trackerBound = false;
  function bindTracker() {
    if (trackerBound) return;
    var t = TR();
    if (!t || typeof t.onChange !== 'function') return;
    trackerBound = true;
    try {
      t.onChange(function () {
        if (window.DBD && window.DBD.state && window.DBD.state.view === 'builds') paint();
      });
    } catch (e) { trackerBound = false; }
  }

  /* ----------------------------------------------------------------- state */

  var S = {
    role: 'survivor',
    charId: null,
    ownedOnly: true,
    ownedTouched: false,   // once Josia flips it, stop auto-defaulting
    spice: 0.35,
    result: null,
    showBest: false,
    importErr: '',
    importCode: ''
  };

  var META = null;         // parsed builds-meta.json
  var METAERR = '';
  var metaLoading = false;

  function loadMeta() {
    if (META || metaLoading) return;
    metaLoading = true;
    var done = function (obj, err) {
      metaLoading = false;
      if (obj && obj.archetypes) { META = obj; METAERR = ''; }
      else { METAERR = err || 'malformed'; }
      if (window.DBD && window.DBD.state && window.DBD.state.view === 'builds') paint();
    };
    try {
      fetch('/island/apps/dbd/data/builds-meta.json')
        .then(function (r) { return r.json(); })
        .then(function (j) { done(j, null); })
        .catch(function (e) { done(null, (e && e.message) || 'fetch failed'); });
    } catch (e) { done(null, (e && e.message) || 'fetch failed'); }
  }

  function archetypes(role) {
    if (!META || !META.archetypes) return [];
    var out = [], id;
    for (id in META.archetypes) {
      if (!Object.prototype.hasOwnProperty.call(META.archetypes, id)) continue;
      var a = META.archetypes[id];
      if (a && a.role === role) out.push({ id: id, name: a.name || id, blurb: a.blurb || '', weights: a.weights || {} });
    }
    return out;
  }

  function archetypeById(id) {
    if (!META || !META.archetypes || !id) return null;
    var a = META.archetypes[id];
    if (!a) return null;
    return { id: id, name: a.name || id, blurb: a.blurb || '', weights: a.weights || {}, role: a.role };
  }

  /* synergy pairs, indexed both ways, resolved once per meta load */
  var SYN = null;
  function synergies() {
    if (SYN) return SYN;
    SYN = {};
    var list = (META && Array.isArray(META.synergies)) ? META.synergies : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !Array.isArray(s.perks) || s.perks.length < 2) continue;
      var a = s.perks[0], b = s.perks[1];
      if (!perk(a) || !perk(b)) continue;
      (SYN[a] = SYN[a] || []).push({ other: b, note: s.note || '' });
      (SYN[b] = SYN[b] || []).push({ other: a, note: s.note || '' });
    }
    return SYN;
  }

  /* ---------------------------------------------------------------- engine */

  function rolePool(role) {
    var p = dict('perks'), out = [], k;
    for (k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      if (p[k] && p[k].role === role) out.push(k);
    }
    return out;
  }

  var TIER_WHY = {
    5: 'Defines a {a} build.',
    4: 'Core to {a}.',
    3: 'Solid {a} pick.',
    2: 'Situational in {a}.',
    1: 'Filler, but it still serves {a}.'
  };

  function whyFor(weight, archName) {
    var t = TIER_WHY[weight] || 'Rounds out {a}.';
    return t.replace('{a}', archName);
  }

  /* score = weight + jitter. spice 0 -> no jitter at all (pure meta order),
     spice 1 -> +/-2.5, which is enough for a weight-2 perk to beat a weight-5
     but not enough to make the result feel random. */
  function jitter(spice) {
    return (Math.random() - 0.5) * 5 * Math.max(0, Math.min(1, spice));
  }

  function eligible(id, ownedOnly, role) {
    var p = perk(id);
    if (!p || p.role !== role) return false;
    if (ownedOnly && !isOwned(id)) return false;
    return true;
  }

  /* The pick engine. Returns [{id, weight, locked}] of length <= 4.
     Constraints: no duplicates; owned-only honoured when asked; at least one
     weight-5 anchor whenever an eligible one exists; short results are filled
     from the role pool rather than shipping an empty slot. */
  function pickFour(weights, ownedOnly, role) {
    var scored = [], id, seen = {};
    for (id in weights) {
      if (!Object.prototype.hasOwnProperty.call(weights, id)) continue;
      if (seen[id]) continue;
      if (!eligible(id, ownedOnly, role)) continue;
      seen[id] = 1;
      var w = weights[id];
      if (typeof w !== 'number' || !(w >= 1 && w <= 5)) w = 1;
      scored.push({ id: id, weight: w, score: w + jitter(S.spice) });
    }
    scored.sort(function (a, b) { return b.score - a.score; });

    var picks = scored.slice(0, 4);

    // anchor rule: a build with no weight-5 perk in it is not the archetype.
    var hasAnchor = picks.some(function (x) { return x.weight === 5; });
    if (!hasAnchor) {
      var anchors = scored.filter(function (x) { return x.weight === 5; });
      if (anchors.length && picks.length) {
        var worstAt = 0;
        for (var i = 1; i < picks.length; i++) {
          if (picks[i].weight < picks[worstAt].weight) worstAt = i;
        }
        picks[worstAt] = anchors[0];
      }
    }

    // fill: role perks not already used, owned first when the filter is on.
    if (picks.length < 4) {
      var used = {};
      picks.forEach(function (x) { used[x.id] = 1; });
      var pool = rolePool(role).filter(function (k) {
        return !used[k] && !(ownedOnly && !isOwned(k));
      });
      shuffle(pool);
      while (picks.length < 4 && pool.length) {
        var k2 = pool.pop();
        used[k2] = 1;
        picks.push({ id: k2, weight: 0, score: 0 });
      }
    }

    return picks.slice(0, 4).map(function (x) {
      return { id: x.id, weight: x.weight, locked: !isOwned(x.id) };
    });
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = arr[i];
      arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* The unrestricted reference build: top four by raw weight, no jitter, no
     owned filter. Deterministic on purpose - it is a comparison, not a roll. */
  function bestFour(weights, role) {
    var scored = [], id;
    for (id in weights) {
      if (!Object.prototype.hasOwnProperty.call(weights, id)) continue;
      if (!perk(id) || perk(id).role !== role) continue;
      scored.push({ id: id, weight: weights[id] });
    }
    scored.sort(function (a, b) {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return perkName(a.id).localeCompare(perkName(b.id));
    });
    return scored.slice(0, 4).map(function (x) {
      return { id: x.id, weight: x.weight, locked: !isOwned(x.id) };
    });
  }

  function decorate(picks, archName) {
    var syn = synergies();
    var ids = picks.map(function (p) { return p.id; });
    return picks.map(function (p) {
      var why = p.weight ? whyFor(p.weight, archName) : 'Filler - nothing left in this archetype you own.';
      var pairs = syn[p.id] || [];
      for (var i = 0; i < pairs.length; i++) {
        if (ids.indexOf(pairs[i].other) !== -1) {
          why += ' ' + pairs[i].note;
          break;
        }
      }
      return { id: p.id, weight: p.weight, locked: p.locked, why: why, hint: p.locked ? unlockHint(p.id) : '' };
    });
  }

  function generate(archId) {
    var a = archetypeById(archId);
    if (!a) return;
    S.role = a.role;
    var ownedOnly = S.ownedOnly && trackerLive();
    var picks = pickFour(a.weights, ownedOnly, a.role);
    S.result = {
      mode: 'archetype',
      archetypeId: archId,
      archetypeName: a.name,
      role: a.role,
      charId: S.charId,
      picks: decorate(picks, a.name),
      best: decorate(bestFour(a.weights, a.role), a.name)
    };
    S.showBest = false;
    paint();
  }

  function roulette(kind) {
    var role = S.role;
    if (kind === 'archetype') {
      var list = archetypes(role);
      if (!list.length) return;
      generate(list[Math.floor(Math.random() * list.length)].id);
      return;
    }
    var ownedOnly = (kind === 'owned') && trackerLive();
    var pool = rolePool(role).filter(function (k) { return !(ownedOnly && !isOwned(k)); });
    shuffle(pool);
    var picks = pool.slice(0, 4).map(function (k) {
      return { id: k, weight: 0, locked: !isOwned(k) };
    });
    var label = kind === 'owned' ? 'Roulette (owned)' : 'Roulette (everything)';
    S.result = {
      mode: 'roulette',
      archetypeId: null,
      archetypeName: label,
      role: role,
      charId: S.charId,
      picks: picks.map(function (p) {
        return {
          id: p.id, weight: 0, locked: p.locked,
          why: 'Pure chance. No archetype, no plan.',
          hint: p.locked ? unlockHint(p.id) : ''
        };
      }),
      best: []
    };
    S.showBest = false;
    paint();
  }

  /* ----------------------------------------------------------- share codes */

  function b64urlEncode(str) {
    var ascii = String(str).replace(/[^\x20-\x7E]/g, '?');
    try {
      return btoa(ascii).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) { return ''; }
  }

  function b64urlDecode(code) {
    var s = String(code == null ? '' : code).trim().replace(/-/g, '+').replace(/_/g, '/');
    s = s.replace(/[^A-Za-z0-9+/=]/g, '');
    if (!s) return null;
    while (s.length % 4) s += '=';
    try { return atob(s); } catch (e) { return null; }
  }

  function shareCode(result) {
    if (!result || !result.picks || !result.picks.length) return '';
    var payload = {
      v: 1,
      r: result.role,
      c: result.charId || null,
      p: result.picks.map(function (p) { return p.id; })
    };
    var json;
    try { json = JSON.stringify(payload); } catch (e) { return ''; }
    return b64urlEncode(json);
  }

  /* Returns {ok:true, result} or {ok:false, error}. Every id is re-validated
     against the LOCAL dataset, and ownership is recomputed for the person
     reading the code, never carried inside it. */
  function importCode(code) {
    var raw = b64urlDecode(code);
    if (!raw) return { ok: false, error: 'That is not a valid build code.' };
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return { ok: false, error: 'That code is damaged.' }; }
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'That code is damaged.' };
    if (obj.v !== 1) return { ok: false, error: 'That code is from a different version.' };
    if (obj.r !== 'survivor' && obj.r !== 'killer') return { ok: false, error: 'That code has no valid role.' };
    if (!Array.isArray(obj.p) || obj.p.length < 1 || obj.p.length > 4) {
      return { ok: false, error: 'That code does not hold four perks.' };
    }
    var seen = {}, picks = [], i, id, p;
    for (i = 0; i < obj.p.length; i++) {
      id = obj.p[i];
      if (typeof id !== 'string') return { ok: false, error: 'That code holds a perk this app does not know.' };
      if (seen[id]) return { ok: false, error: 'That code repeats a perk.' };
      p = perk(id);
      if (!p) return { ok: false, error: 'That code holds a perk this app does not know.' };
      if (p.role !== obj.r) return { ok: false, error: 'That code mixes killer and survivor perks.' };
      seen[id] = 1;
      picks.push(id);
    }
    var charId = null;
    if (obj.c != null) {
      if (typeof obj.c !== 'string' || !chr(obj.c)) return { ok: false, error: 'That code names a character this app does not know.' };
      if (chr(obj.c).role !== obj.r) return { ok: false, error: 'That code pairs the wrong character with the role.' };
      charId = obj.c;
    }
    S.role = obj.r;
    S.charId = charId;
    return {
      ok: true,
      result: {
        mode: 'import',
        archetypeId: null,
        archetypeName: 'Imported build',
        role: obj.r,
        charId: charId,
        picks: picks.map(function (k) {
          var locked = !isOwned(k);
          return {
            id: k, weight: 0, locked: locked,
            why: 'From a shared code.',
            hint: locked ? unlockHint(k) : ''
          };
        }),
        best: []
      }
    };
  }

  /* ------------------------------------------------------------------ html */

  function roleTab(role, label) {
    var on = S.role === role;
    return '<button type="button" class="dbdl-roletab' + (on ? ' is-on' : '') + '" ' +
      'data-bld="role" data-role="' + role + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '">' +
      esc(label) + '</button>';
  }

  function charSelectHtml() {
    var c = dict('characters'), ids = [], k;
    for (k in c) {
      if (!Object.prototype.hasOwnProperty.call(c, k)) continue;
      if (c[k] && c[k].role === S.role) ids.push(k);
    }
    ids.sort(function (a, b) { return String(c[a].name).localeCompare(String(c[b].name)); });
    var opts = '<option value="">Any ' + (S.role === 'killer' ? 'killer' : 'survivor') + '</option>';
    for (var i = 0; i < ids.length; i++) {
      opts += '<option value="' + esc(ids[i]) + '"' + (S.charId === ids[i] ? ' selected' : '') + '>' +
        esc(c[ids[i]].name) + '</option>';
    }
    return '<label class="bld-field">' +
      '<span class="bld-label">Character</span>' +
      '<select class="bld-select" data-bld="char" aria-label="Character">' + opts + '</select>' +
      '</label>';
  }

  function optionsHtml() {
    var live = trackerLive();
    var owned = live
      ? '<button type="button" class="bld-toggle' + (S.ownedOnly ? ' is-on' : '') + '" data-bld="owned" ' +
        'aria-pressed="' + (S.ownedOnly ? 'true' : 'false') + '">' +
        '<span class="bld-tick" aria-hidden="true">' + (S.ownedOnly ? '&#10003;' : '&#8211;') + '</span>' +
        'Only perks I own</button>'
      : '<p class="bld-note">No tracker data yet, so every perk is treated as unlocked.</p>';
    var pct = Math.round(S.spice * 100);
    return '<div class="bld-opts">' + owned +
      '<label class="bld-field bld-spice">' +
      '<span class="bld-label">Spice <b id="bldSpiceOut">' + pct + '%</b></span>' +
      '<input class="bld-range" type="range" min="0" max="100" step="5" value="' + pct + '" ' +
      'data-bld="spice" aria-label="Spice: how far from the meta the roll may wander">' +
      '<span class="bld-ends"><i>meta</i><i>chaos</i></span>' +
      '</label></div>';
  }

  function archCardsHtml() {
    var list = archetypes(S.role);
    if (!list.length) return '<p class="bld-note">No archetypes for this role.</p>';
    var cur = S.result && S.result.archetypeId;
    return '<div class="bld-archs">' + list.map(function (a) {
      return '<button type="button" class="bld-arch' + (cur === a.id ? ' is-on' : '') + '" ' +
        'data-bld="gen" data-arch="' + esc(a.id) + '">' +
        '<span class="bld-arch-n">' + esc(a.name) + '</span>' +
        '<span class="bld-arch-b">' + esc(a.blurb) + '</span>' +
        '</button>';
    }).join('') + '</div>';
  }

  function rouletteHtml() {
    var live = trackerLive();
    return '<div class="bld-roul">' +
      (live ? '<button type="button" class="dbdl-mini" data-bld="roul" data-kind="owned">&#127922; Random (owned)</button>' : '') +
      '<button type="button" class="dbdl-mini" data-bld="roul" data-kind="all">&#127922; Random (everything)</button>' +
      '<button type="button" class="dbdl-mini" data-bld="roul" data-kind="archetype">&#127922; Random archetype</button>' +
      '</div>';
  }

  function slotHtml(p, i) {
    var e = perk(p.id);
    var tier = ownedTier(p.id);
    var n = i + 1;
    var cls = 'dbdl-slot is-filled' + (p.locked ? ' bld-locked' : '');
    return '<div class="' + cls + '">' +
      '<span class="dbdl-dia" aria-hidden="true"></span>' +
      '<button type="button" class="dbdl-hit" data-bld="detail" data-id="' + esc(p.id) + '" ' +
      'aria-label="' + esc(perkName(p.id)) + ', perk slot ' + n + (p.locked ? ', locked' : '') + '">' +
      art(e, 'dbdl-ic-slot') +
      '</button>' +
      (p.locked ? '<span class="bld-lock" aria-hidden="true">&#128274;</span>' : '') +
      (tier ? '<span class="bld-tier" aria-hidden="true">' + ['I', 'II', 'III'][tier - 1] + '</span>' : '') +
      '<span class="dbdl-slot-name">' + esc(perkName(p.id)) + '</span>' +
      '</div>';
  }

  function whyRowHtml(p) {
    return '<li class="bld-why' + (p.locked ? ' is-locked' : '') + '">' +
      '<b>' + esc(perkName(p.id)) + '</b>' +
      '<span>' + esc(p.why) + '</span>' +
      (p.locked
        ? '<em>' + esc(p.hint || 'Not unlocked on this account yet.') + '</em>'
        : '') +
      '</li>';
  }

  function bestHtml(r) {
    if (!r.best || !r.best.length) return '';
    var same = r.best.every(function (b) {
      return r.picks.some(function (p) { return p.id === b.id; });
    });
    var body = S.showBest
      ? '<div class="bld-best-body">' +
        (same ? '<p class="bld-note">Same four. You already own the best version of this build.</p>' : '') +
        '<div class="dbdl-slots">' + r.best.map(slotHtml).join('') + '</div>' +
        '<ul class="bld-whys">' + r.best.map(function (b) {
          return '<li class="bld-why' + (b.locked ? ' is-locked' : '') + '">' +
            '<b>' + esc(perkName(b.id)) + '</b>' +
            '<span>' + esc(b.locked ? 'Locked for you right now.' : 'You already own this.') + '</span>' +
            (b.locked ? '<em>' + esc(b.hint || 'Not unlocked on this account yet.') + '</em>' : '') +
            '</li>';
        }).join('') + '</ul>' +
        '</div>'
      : '';
    return '<div class="bld-best">' +
      '<button type="button" class="dbdl-mini" data-bld="best" aria-expanded="' + (S.showBest ? 'true' : 'false') + '">' +
      (S.showBest ? '&#9662; Hide' : '&#9656; Show') + ' the build if you unlocked everything</button>' +
      body + '</div>';
  }

  function resultHtml() {
    var r = S.result;
    if (!r) {
      return '<section class="dbdl-sec bld-empty">' +
        '<p class="bld-note">Pick an archetype above and it will roll you four perks, tell you why it chose each one, and hand you a code you can send to a friend.</p>' +
        '</section>';
    }
    var code = shareCode(r);
    var who = r.charId && chr(r.charId) ? chr(r.charId).name : null;
    return '<section class="dbdl-sec bld-result">' +
      '<div class="dbdl-sec-h"><h3>' + esc(r.archetypeName) +
      (who ? ' <span class="dbdl-of">' + esc(who) + '</span>' : '') + '</h3>' +
      '<button type="button" class="dbdl-mini" data-bld="reroll">Reroll</button></div>' +
      '<div class="dbdl-slots">' + r.picks.map(slotHtml).join('') + '</div>' +
      '<ul class="bld-whys">' + r.picks.map(whyRowHtml).join('') + '</ul>' +
      '<div class="bld-actions">' +
      '<button type="button" class="bld-primary" data-bld="apply">Apply to loadout</button>' +
      '</div>' +
      bestHtml(r) +
      (code
        ? '<div class="bld-share"><span class="bld-label">Share code</span>' +
          '<div class="bld-coderow"><code class="bld-code" id="bldCode">' + esc(code) + '</code>' +
          '<button type="button" class="dbdl-mini" data-bld="copy">Copy</button></div>' +
          '<p class="bld-note" id="bldCopyMsg" hidden></p></div>'
        : '') +
      '</section>';
  }

  function importHtml() {
    return '<section class="dbdl-sec">' +
      '<div class="dbdl-sec-h"><h3>Load a code</h3></div>' +
      '<div class="bld-coderow">' +
      '<input class="bld-input" type="text" inputmode="latin" autocomplete="off" spellcheck="false" ' +
      'placeholder="Paste a build code" data-bld="importbox" aria-label="Paste a build code" value="' + esc(S.importCode) + '">' +
      '<button type="button" class="dbdl-mini" data-bld="import">Load</button>' +
      '</div>' +
      (S.importErr ? '<p class="bld-err">' + esc(S.importErr) + '</p>' : '') +
      '<p class="bld-note">Perks are checked against your own data, so a shared build shows what <b>you</b> still have to unlock.</p>' +
      '</section>';
  }

  function viewHtml() {
    if (!dataReady()) {
      return '<div class="dbdl-scope bld-root"><p class="bld-note">Loading perk data...</p></div>';
    }
    if (!META) {
      return '<div class="dbdl-scope bld-root"><p class="bld-note">' +
        (METAERR ? 'Build data unavailable (' + esc(METAERR) + '). The rest of the app still works.' : 'Loading build data...') +
        '</p></div>';
    }
    return '<div class="dbdl-scope bld-root">' +
      '<div class="dbdl-fog" aria-hidden="true"></div>' +
      '<div class="dbdl-rolebar" role="tablist" aria-label="Role">' +
      roleTab('killer', 'Killer') + roleTab('survivor', 'Survivor') +
      '</div>' +
      '<div class="bld-setup">' + charSelectHtml() + optionsHtml() + '</div>' +
      archCardsHtml() +
      rouletteHtml() +
      resultHtml() +
      importHtml() +
      '</div>';
  }

  /* ---------------------------------------------------------------- sheets */

  function perkSheetHtml(id) {
    var e = perk(id);
    if (!e) return '<div class="dbdl-scope"><p class="bld-note">Perk not found.</p></div>';
    var locked = !isOwned(id);
    var tier = ownedTier(id);
    var owner = e.general ? 'General' : (chr(e.character) ? chr(e.character).name : '');
    return '<div class="dbdl-scope bld-sheet">' +
      '<div class="bld-sheet-head">' +
      '<span class="bld-sheet-ic"><span class="dbdl-dia dbdl-dia-md" aria-hidden="true"></span>' +
      art(e, 'bld-ic-sheet') + '</span>' +
      '<div><h3>' + esc(e.name) + '</h3>' +
      '<p class="bld-sheet-sub">' +
      esc((e.role === 'killer' ? 'Killer' : 'Survivor') + ' perk') +
      (owner ? ' &middot; ' + esc(owner) : '') +
      (tier ? ' &middot; Tier ' + ['I', 'II', 'III'][tier - 1] : '') +
      '</p></div></div>' +
      (locked
        ? '<p class="bld-err">&#128274; ' + esc(unlockHint(id) || 'You have not unlocked this perk yet.') + '</p>'
        : '') +
      '<div class="bld-sheet-desc">' + rich(e.description) + '</div>' +
      '</div>';
  }

  function openPerk(id) {
    var o = window.DBD && window.DBD.openSheet;
    if (typeof o !== 'function') return;
    try {
      o(perkSheetHtml(id), { label: perkName(id), reopen: function () { openPerk(id); } });
    } catch (e) { /* a failing sheet must not break the view */ }
  }

  /* --------------------------------------------------------------- actions */

  function applyToLoadout() {
    var r = S.result;
    if (!r || !r.picks.length) return;
    var lo = window.DBD && window.DBD.loadout;
    var ids = r.picks.map(function (p) { return p.id; });
    // ORDER: character FIRST. setCharacter() wipes the perk array whenever the
    // ROLE changes, so writing perks before it would silently lose them.
    if (lo && r.charId && typeof lo.setCharacter === 'function') {
      try { lo.setCharacter(r.charId); } catch (e) { /* keep going */ }
    }
    if (lo && typeof lo.set === 'function') {
      try { lo.set(ids); } catch (e) { /* keep going */ }
    }
    if (r.charId && typeof window.DBD.openCharacter === 'function') {
      try { if (window.DBD.openCharacter(r.charId)) return; } catch (e) { /* fall through */ }
    }
    if (typeof window.DBD.setView === 'function') {
      try { window.DBD.setView('chars'); } catch (e) { /* nothing else to do */ }
    }
  }

  function copyCode() {
    var el = $('#bldCode');
    var msg = $('#bldCopyMsg');
    if (!el) return;
    var text = el.textContent || '';
    var done = function (ok) {
      if (!msg) return;
      msg.hidden = false;
      msg.textContent = ok ? 'Copied.' : 'Could not copy - select the code and copy it by hand.';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    done(false);
  }

  /* ------------------------------------------------------------ delegation */

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-bld]') : null;
    if (!t) return;
    var what = t.getAttribute('data-bld');

    if (what === 'role') {
      var role = t.getAttribute('data-role');
      if (role !== 'killer' && role !== 'survivor') return;
      if (S.role === role) return;
      S.role = role;
      S.charId = null;
      S.result = null;
      S.showBest = false;
      paint();
      return;
    }
    if (what === 'owned') {
      S.ownedOnly = !S.ownedOnly;
      S.ownedTouched = true;
      // A bare repaint left the ALREADY-GENERATED build on screen unchanged, so
      // switching the filter ON could leave locked perks sitting in a build the
      // toggle now claimed was owned-only: the control visibly lied. Re-roll the
      // same archetype (same role, same character) under the new filter.
      // Imported builds are somebody else's and are never re-rolled; a pure
      // roulette result has no archetype to re-roll and is left alone.
      if (S.result && S.result.archetypeId) { generate(S.result.archetypeId); return; }
      paint();
      return;
    }
    if (what === 'gen') { generate(t.getAttribute('data-arch')); return; }
    if (what === 'reroll') {
      if (S.result && S.result.archetypeId) generate(S.result.archetypeId);
      else if (S.result && S.result.mode === 'roulette') roulette(S.result.archetypeName.indexOf('owned') !== -1 ? 'owned' : 'all');
      return;
    }
    if (what === 'roul') { roulette(t.getAttribute('data-kind')); return; }
    if (what === 'best') { S.showBest = !S.showBest; paint(); return; }
    if (what === 'detail') { openPerk(t.getAttribute('data-id')); return; }
    if (what === 'apply') { applyToLoadout(); return; }
    if (what === 'copy') { copyCode(); return; }
    if (what === 'import') {
      var box = $('[data-bld="importbox"]');
      var code = box ? box.value : S.importCode;
      S.importCode = code;
      var res = importCode(code);
      if (res.ok) { S.result = res.result; S.showBest = false; S.importErr = ''; }
      else { S.importErr = res.error; }
      paint();
      return;
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var what = t.getAttribute('data-bld');
    if (what === 'spice') {
      var v = Number(t.value);
      if (!isFinite(v)) return;
      S.spice = Math.max(0, Math.min(1, v / 100));
      var out = $('#bldSpiceOut');
      if (out) out.textContent = Math.round(S.spice * 100) + '%';
      return;
    }
    if (what === 'importbox') { S.importCode = t.value; return; }
  }

  function onChange(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-bld') !== 'char') return;
    var v = t.value || '';
    S.charId = (v && chr(v) && chr(v).role === S.role) ? v : null;
    if (S.result) { S.result.charId = S.charId; }
    paint();
  }

  var wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener('click', onClick, false);
    document.addEventListener('input', onInput, false);
    document.addEventListener('change', onChange, false);
  }

  /* ----------------------------------------------------------------- paint */

  function paint() {
    var mount = $('#app');
    if (!mount) return;
    if (!(window.DBD && window.DBD.state && window.DBD.state.view === 'builds')) return;
    render(mount);
  }

  function render(mount) {
    if (!mount) return;
    loadMeta();
    bindTracker();
    // Default the owned-only filter ON the first time a tracker actually shows
    // up, but never fight a choice Josia has already made.
    if (!S.ownedTouched) S.ownedOnly = trackerLive();
    mount.innerHTML = viewHtml();
  }

  /* ------------------------------------------------------------------ boot */

  var boots = 0;
  (function boot() {
    if (window.DBD && typeof window.DBD.registerView === 'function') {
      wire();
      try { window.DBD.registerView('builds', render); } catch (e) { /* shell will re-ask */ }
      window.DBD.buildsReady = true;
      return;
    }
    if (++boots > 400) return;                 // ~10s, then give up quietly
    setTimeout(boot, 25);
  }());

  /* Test seam: node harnesses import these directly. Never used by the UI. */
  if (typeof module === 'object' && module && module.exports) {
    module.exports = {
      _state: S,
      _setMeta: function (m) { META = m; SYN = null; },
      pickFour: pickFour,
      bestFour: bestFour,
      decorate: decorate,
      shareCode: shareCode,
      importCode: importCode,
      b64urlEncode: b64urlEncode,
      b64urlDecode: b64urlDecode,
      generate: generate,
      roulette: roulette,
      isOwned: isOwned,
      unlockHint: unlockHint,
      trackerLive: trackerLive,
      viewHtml: viewHtml,
      render: render
    };
  }
}());
