/* tracker.js - the Tracker tab for the Dead by Daylight companion.
 *
 * OWNS: the 'tracker' view (prestige entry, perk-ownership derivation, the
 * prestige planner and the shrine panel) and the ONLY localStorage key this
 * app writes: dbd_tracker_v1.
 *
 * FILE FENCE: this file + css/tracker.css. Nothing else in the app is touched.
 *
 * CONTRACT WITH js/app.js (B1). Everything below is read through a guard, so a
 * missing piece degrades instead of throwing:
 *   DBD.data      {characters, perks, meta, shrine, ...} - app.js seeds these
 *                 as EMPTY dicts and fills them from an async fetch, so every
 *                 read content-tests rather than presence-tests.
 *   DBD.esc(s), DBD.icon(entry, cls), DBD.formatDesc(s)
 *   DBD.openSheet(html, crumb)  - crumb is {label, reopen()}, an OBJECT
 *   DBD.registerView(name, fn), DBD.setView(name)
 *
 * EXPOSES (builds.js consumes this):
 *   DBD.tracker.getPrestige(charId) -> 0..100
 *   DBD.tracker.setPrestige(charId, n) -> the clamped value written
 *   DBD.tracker.ownedTier(perkId, forCharacterId?) -> 0..3
 *   DBD.tracker.isOwned(perkId, forCharacterId?) -> bool
 *   DBD.tracker.unlockPath(perkId) -> {perk, character, name, neededPrestige,
 *                 currentPrestige, ownedTier, text} | null
 *   DBD.tracker.counts() -> {ownedPerks, totalPerks, ownedTiers, totalTiers,
 *                 pct, byRole:{killer|survivor:{owned,total,pct}}}
 *   DBD.tracker.onChange(fn) -> unsubscribe fn
 *   DBD.tracker.resetProfile() -> clears the ACTIVE profile's prestige map and
 *                 perkOverrides (the profile, its name and its settings stay),
 *                 persists IMMEDIATELY, fires onChange, repaints the view if
 *                 it is mounted. Returns the write result. This is what the
 *                 More tab's "Reset tracker profile" button calls.
 *   plus: derivedTier, getOverride, setOverride, clearOverride, planner,
 *         shrine, setPerkWeights, openPerk, flush, storageKey, profile
 *
 * THE DOMAIN RULES (the whole product logic of this tab):
 *   1. Prestiging character X to P1/P2/P3 unlocks tier 1/2/3 of X's three
 *      teachable perks for EVERY character, account-wide. So one per-character
 *      prestige map derives every teachable perk's owned tier:
 *      tier = min(3, prestige of the owning character); 0 = locked.
 *   2. The 27 general perks have no owner (character:null, general:true) and
 *      come out of everyone's bloodweb, so v1 defaults them to tier 3. That is
 *      a simplification, and it is overridable like anything else.
 *   3. A character's OWN three perks are always in their own bloodweb from the
 *      start, regardless of prestige - that is what the forCharacterId
 *      parameter expresses, and it outranks both the override and the
 *      derivation because it is a game fact, not a guess.
 *   4. Bloodweb luck means a player can hold a HIGHER tier than the derivation
 *      says. perkOverrides is a SPARSE layer over the derivation (the isaac
 *      tracker's manual-over-imported pattern): a write whose value equals the
 *      derived value DELETES the key, so the layer only ever holds real
 *      divergence and raising a prestige is never fought by a stale tick.
 *
 * IDS: every dataset is keyed by a stable internal id ("Chuckles" is The
 * Trapper). The UI renders `.name`, never the key. See tools/README.md.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  var LS_KEY = 'dbd_tracker_v1';          /* the ONLY key this app writes */
  var DEFAULT_PROFILE_ID = 'local';
  var DEFAULT_PROFILE_NAME = 'Local';
  var MAX_PRESTIGE = 100;                 /* the game's cap */
  var MAX_TIER = 3;
  var SAVE_DEBOUNCE_MS = 300;
  var PLAN_TOP_N = 5;

  /* ----------------------------------------------------------------- utils */

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function localEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  /* Prefer the shell's escaper so the whole app is consistent; fall back to
     ours if it is missing or throws. EVERY interpolation below goes through
     this - no exceptions. */
  function esc(s) {
    var f = window.DBD && window.DBD.esc;
    if (typeof f === 'function') { try { return f(s == null ? '' : s); } catch (e) { /* fall through */ } }
    return localEsc(s);
  }

  function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }
  function $$(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }

  function norm(s) { return String(s == null ? '' : s).toLowerCase(); }

  function num(n, fallback) {
    var v = Number(n);
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function pctOf(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }

  /* A percentage that is safe to drop into a style attribute: always a finite
     number 0..100 rendered with one decimal, never a caller string. */
  function widthPct(a, b) {
    var p = pctOf(a, b);
    if (p < 0) p = 0; if (p > 100) p = 100;
    return p.toFixed(1);
  }

  function fmtInt(n) {
    var s = String(Math.round(num(n, 0)));
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function ymd(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toISOString().slice(0, 10);
  }

  /* ------------------------------------------------------------------ data */

  function D() { return (window.DBD && window.DBD.data) || null; }
  function dict(name) { var d = D(); return (d && d[name]) || {}; }

  function nonEmpty(o) {
    if (!o || typeof o !== 'object') return false;
    for (var k in o) { if (has(o, k)) return true; }
    return false;
  }

  /* "data exists" is not "data is loaded" - app.js seeds empty dicts. */
  function dataReady() {
    var d = D();
    if (!d) return false;
    return nonEmpty(d.characters) && nonEmpty(d.perks);
  }

  function perksDict() { return dict('perks'); }
  function charsDict() { return dict('characters'); }
  function perk(id) { var p = perksDict()[id]; return p || null; }
  function chr(id) { var c = charsDict()[id]; return c || null; }
  function charName(id) { var c = chr(id); return (c && c.name) || String(id == null ? '' : id); }
  function perkName(id) { var p = perk(id); return (p && p.name) || String(id == null ? '' : id); }

  function charList(role) {
    var C = charsDict(), out = [], k;
    for (k in C) {
      if (!has(C, k)) continue;
      if (role && C[k].role !== role) continue;
      out.push(k);
    }
    out.sort(function (a, b) { return norm(charName(a)).localeCompare(norm(charName(b))); });
    return out;
  }

  function generalPerkList(role) {
    var P = perksDict(), out = [], k;
    for (k in P) {
      if (!has(P, k)) continue;
      var p = P[k];
      if (!p.general && p.character) continue;
      if (role && p.role !== role) continue;
      out.push(k);
    }
    out.sort(function (a, b) { return norm(perkName(a)).localeCompare(norm(perkName(b))); });
    return out;
  }

  function ownPerks(charId) {
    var c = chr(charId);
    var list = (c && Array.isArray(c.perks)) ? c.perks : [];
    var out = [], i;
    for (i = 0; i < list.length; i++) { if (perk(list[i])) out.push(list[i]); }
    return out;
  }

  /* ----------------------------------------------------- store + profiles */

  var store = null;

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object' && p.profiles && typeof p.profiles === 'object') return p;
      }
    } catch (e) { /* corrupt or unavailable - start clean rather than throw */ }
    return { active: null, profiles: {} };
  }

  function ST() { if (!store) store = loadLocal(); return store; }

  /* Lazy ensureProfile: multi-profile from day one (retrofitting profiles
     later orphans everyone's data), but v1 only ever creates 'local'. */
  function ensureProfile() {
    var P = ST();
    var p = (P.active && P.profiles[P.active]) ? P.profiles[P.active] : null;
    if (!p) {
      var first = null, k;
      for (k in P.profiles) { if (has(P.profiles, k)) { first = k; break; } }
      if (first) { P.active = first; p = P.profiles[first]; }
      else {
        P.active = DEFAULT_PROFILE_ID;
        p = P.profiles[DEFAULT_PROFILE_ID] = { name: DEFAULT_PROFILE_NAME, prestige: {}, perkOverrides: {}, settings: {} };
      }
    }
    if (!p.prestige || typeof p.prestige !== 'object') p.prestige = {};
    if (!p.perkOverrides || typeof p.perkOverrides !== 'object') p.perkOverrides = {};
    if (!p.settings || typeof p.settings !== 'object') p.settings = {};
    if (typeof p.name !== 'string') p.name = DEFAULT_PROFILE_NAME;
    return p;
  }

  function persistLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(ST())); return true; }
    catch (e) { return false; }
  }

  /* ------------------------------------------- save pill + change dispatch */

  var saveTimer = null;

  function setPill(text, cls) {
    var el = $('#dbdtSave');
    if (!el) return;
    el.textContent = text;
    el.className = 'dbdt-save' + (cls ? ' ' + cls : '');
  }

  /* Never save synchronously per click: pill goes to "saving..." immediately,
     the write lands 300 ms later, then "saved" / "save failed". */
  function save() {
    setPill('saving...', 'busy');
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (persistLocal()) setPill('saved', ''); else setPill('save failed', 'err');
    }, SAVE_DEBOUNCE_MS);
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var ok = persistLocal();
    setPill(ok ? 'saved' : 'save failed', ok ? '' : 'err');
    return ok;
  }

  var subs = [];
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    subs.push(fn);
    return function () {
      for (var i = 0; i < subs.length; i++) { if (subs[i] === fn) { subs.splice(i, 1); return; } }
    };
  }
  function emit() {
    var list = subs.slice(0), i;
    for (i = 0; i < list.length; i++) { try { list[i](); } catch (e) { /* one bad subscriber must not stop the rest */ } }
  }

  /* quiet = model + save only, no repaint (used while a number field has
     focus, so a keystroke does not rebuild the input out from under it). */
  function changed(quiet) {
    save();
    if (!quiet) paint();
    emit();
  }

  /* ------------------------------------------------------------ derivation */

  function clampTier(n) {
    var v = Math.round(num(n, 0));
    if (v < 0) return 0;
    return v > MAX_TIER ? MAX_TIER : v;
  }
  function clampPrestige(n) {
    var v = Math.round(num(n, 0));
    if (v < 0) return 0;
    return v > MAX_PRESTIGE ? MAX_PRESTIGE : v;
  }

  function getPrestige(charId) {
    if (!charId) return 0;
    var p = ensureProfile();
    return clampPrestige(has(p.prestige, charId) ? p.prestige[charId] : 0);
  }

  /* RULE 1 + RULE 2, with no override layer applied. */
  function derivedTier(perkId) {
    var pk = perk(perkId);
    if (!pk) return 0;
    if (pk.general || !pk.character) return MAX_TIER;
    var pr = getPrestige(pk.character);
    return pr > MAX_TIER ? MAX_TIER : pr;
  }

  function getOverride(perkId) {
    var p = ensureProfile();
    return has(p.perkOverrides, perkId) ? clampTier(p.perkOverrides[perkId]) : null;
  }

  /* RULE 3 (own perks) beats RULE 4 (override) beats RULES 1+2 (derivation). */
  function ownedTier(perkId, forCharacterId) {
    var pk = perk(perkId);
    if (!pk) return 0;
    if (forCharacterId && pk.character && pk.character === forCharacterId) return MAX_TIER;
    var ov = getOverride(perkId);
    if (ov !== null) return ov;
    return derivedTier(perkId);
  }

  function isOwned(perkId, forCharacterId) { return ownedTier(perkId, forCharacterId) > 0; }

  /* RULE 4: equal-to-derived deletes the key. */
  function setOverride(perkId, tier, quiet) {
    var pk = perk(perkId);
    if (!pk) return 0;
    var p = ensureProfile();
    var t = clampTier(tier);
    if (t === derivedTier(perkId)) delete p.perkOverrides[perkId];
    else p.perkOverrides[perkId] = t;
    changed(quiet);
    return t;
  }

  function clearOverride(perkId, quiet) {
    var p = ensureProfile();
    if (has(p.perkOverrides, perkId)) { delete p.perkOverrides[perkId]; changed(quiet); }
    return derivedTier(perkId);
  }

  /* Raising a prestige can make an existing override redundant. Prune those in
     the same write so the sparse layer keeps holding only real divergence. */
  function pruneOverridesFor(charId) {
    var p = ensureProfile();
    var list = ownPerks(charId), i;
    for (i = 0; i < list.length; i++) {
      var id = list[i];
      if (has(p.perkOverrides, id) && clampTier(p.perkOverrides[id]) === derivedTier(id)) delete p.perkOverrides[id];
    }
  }

  function setPrestige(charId, n, quiet) {
    if (!charId) return 0;
    var p = ensureProfile();
    var v = clampPrestige(n);
    if (v === 0) delete p.prestige[charId]; else p.prestige[charId] = v;
    pruneOverridesFor(charId);
    changed(quiet);
    return v;
  }

  /* Wipe everything the player entered on the ACTIVE profile, keeping the
     profile itself (name + settings) so nothing downstream loses its handle.
     Persists IMMEDIATELY rather than through the 300 ms debounce - a reset is
     a deliberate destructive act and must not be lost to a closed tab. Returns
     the write result so the caller can report a failed save. */
  function resetProfile() {
    var p = ensureProfile();
    p.prestige = {};
    p.perkOverrides = {};
    var wrote = flush();
    paint();          /* no-op unless the tracker view is the one mounted */
    emit();
    return wrote;
  }

  function unlockPath(perkId) {
    var pk = perk(perkId);
    if (!pk) return null;
    if (pk.general || !pk.character) return null;      /* nothing to prestige */
    var t = ownedTier(perkId);
    if (t >= MAX_TIER) return null;                    /* already fully owned */
    var need = t + 1;
    if (need > MAX_TIER) need = MAX_TIER;
    var nm = charName(pk.character);
    return {
      perk: perkId,
      character: pk.character,
      name: nm,
      neededPrestige: need,
      currentPrestige: getPrestige(pk.character),
      ownedTier: t,
      text: 'Prestige ' + nm + ' to P' + need
    };
  }

  function counts() {
    var P = perksDict(), id;
    var out = {
      ownedPerks: 0, totalPerks: 0, ownedTiers: 0, totalTiers: 0, pct: 0,
      byRole: {
        killer: { owned: 0, total: 0, pct: 0 },
        survivor: { owned: 0, total: 0, pct: 0 }
      }
    };
    for (id in P) {
      if (!has(P, id)) continue;
      var pk = P[id];
      var role = (pk.role === 'killer' || pk.role === 'survivor') ? pk.role : null;
      var t = ownedTier(id);
      out.totalPerks++;
      out.totalTiers += MAX_TIER;
      out.ownedTiers += t;
      if (role) out.byRole[role].total++;
      if (t > 0) {
        out.ownedPerks++;
        if (role) out.byRole[role].owned++;
      }
    }
    out.pct = pctOf(out.ownedPerks, out.totalPerks);
    out.byRole.killer.pct = pctOf(out.byRole.killer.owned, out.byRole.killer.total);
    out.byRole.survivor.pct = pctOf(out.byRole.survivor.owned, out.byRole.survivor.total);
    return out;
  }

  /* ------------------------------------------------------- prestige planner */

  /* SOFT dependency on data/builds-meta.json: if the file exists and yields a
     usable perk->weight map, the planner ranks by weighted tiers; otherwise it
     ranks by raw tier count. Both paths are first-class - the file is never
     required, and a 404 just leaves WEIGHTS null.

     The file's REAL shape is
       {version, generalNotes, archetypes:{id:{name, role, blurb,
        weights:{perkId: 1..5}}}, synergies:[...]}
     so a perk's weight is the MAX rating it earns across every archetype of
     its own role - the best build it belongs to is what makes it worth
     prestiging for, not its average across builds it has no place in.

     A perk no archetype rates falls back to weight 1, the same as the lowest
     archetype rating: unrated is "no evidence it is special", never "worth
     nothing" (a 0 would erase its tiers from the ranking entirely).

     MIN_WEIGHTED_PERKS is the honesty gate. A parse that resolves fewer than
     this many perk keys is REJECTED outright rather than accepted as a
     near-empty map - otherwise a shape mismatch degrades into "every perk
     weighs 1", which ranks identically to unweighted while the caption claims
     weighting. That exact defect shipped once: the bare-object fallback
     harvested {version: 1} as a one-entry weight map and flipped the state to
     ready. Rejecting keeps WEIGHTS null AND keeps the caption honest. */
  var MIN_WEIGHTED_PERKS = 10;
  var WEIGHTS = null;
  var weightsState = 'idle';    /* idle | loading | ready | absent */

  function weightOf(perkId) {
    if (!WEIGHTS) return 1;
    var w = WEIGHTS[perkId];
    return (typeof w === 'number' && isFinite(w) && w > 0) ? w : 1;
  }

  function firstNumber() {
    var i;
    for (i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }

  /* The real shape: fold every archetype's weights map down to one perk ->
     MAX-rating map. Role-appropriate, stated defensively: a key is dropped
     only when BOTH the perk's role and the archetype's role are known and
     disagree, so an archetype with no role - or a call made before the perk
     dataset has loaded - degrades to "keep it" instead of silently emptying
     the map. */
  function weightsFromArchetypes(A) {
    var out = {}, n = 0, aid;
    for (aid in A) {
      if (!has(A, aid)) continue;
      var a = A[aid];
      if (!a || typeof a !== 'object') continue;
      var w = a.weights;
      if (!w || typeof w !== 'object') continue;
      var arole = (a.role === 'killer' || a.role === 'survivor') ? a.role : null;
      var pid;
      for (pid in w) {
        if (!has(w, pid)) continue;
        var v = Number(w[pid]);
        if (!isFinite(v) || v <= 0) continue;
        var pk = perk(pid);
        if (pk && arole && pk.role && pk.role !== arole) continue;
        if (!has(out, pid)) { out[pid] = v; n++; }
        else if (v > out[pid]) out[pid] = v;
      }
    }
    return n ? out : null;
  }

  /* Fallbacks for a flat map: a top-level perkWeights/weights map, a perks map
     of records carrying a numeric field, or a bare {perkId: number} object. */
  function weightsFromFlatMap(src) {
    if (!src || typeof src !== 'object') return null;
    var out = {}, n = 0, k;
    for (k in src) {
      if (!has(src, k)) continue;
      var v = src[k];
      if (typeof v === 'number' && isFinite(v)) { out[k] = v; n++; continue; }
      if (v && typeof v === 'object') {
        var w = firstNumber(v.weight, v.score, v.value, v.pickRate, v.usage, v.rating);
        if (w !== null) { out[k] = w; n++; }
      }
    }
    return n ? out : null;
  }

  function extractWeights(j) {
    if (!j || typeof j !== 'object') return null;
    var out = null;
    if (j.archetypes && typeof j.archetypes === 'object') out = weightsFromArchetypes(j.archetypes);
    if (!out) {
      var src = null;
      if (j.perkWeights && typeof j.perkWeights === 'object') src = j.perkWeights;
      else if (j.weights && typeof j.weights === 'object') src = j.weights;
      else if (j.perks && typeof j.perks === 'object') src = j.perks;
      else src = j;
      out = weightsFromFlatMap(src);
    }
    if (!out) return null;
    /* the honesty gate - see MIN_WEIGHTED_PERKS above */
    var n = 0, k;
    for (k in out) { if (has(out, k)) n++; }
    return n >= MIN_WEIGHTED_PERKS ? out : null;
  }

  function setPerkWeights(map) {
    if (map && typeof map === 'object') { WEIGHTS = map; weightsState = 'ready'; }
    else { WEIGHTS = null; weightsState = 'absent'; }
    return weightsState;
  }

  function loadWeights() {
    if (weightsState !== 'idle') return;
    weightsState = 'loading';
    if (typeof fetch !== 'function') { weightsState = 'absent'; return; }
    try {
      fetch('/island/apps/dbd/data/builds-meta.json')
        .then(function (r) { if (!r || !r.ok) throw new Error('absent'); return r.json(); })
        .then(function (j) {
          var w = extractWeights(j);
          if (w) { WEIGHTS = w; weightsState = 'ready'; paint(); }
          else weightsState = 'absent';
        })
        .catch(function () { weightsState = 'absent'; });
    } catch (e) { weightsState = 'absent'; }
  }

  /* Rank every character not yet at P3 by the locked perk-tiers that taking
     them to P3 would unlock. gain per perk = MAX_TIER - current owned tier, so
     a tier already held through a manual override is never counted twice. */
  function planner(limit) {
    var C = charsDict(), out = [], cid;
    for (cid in C) {
      if (!has(C, cid)) continue;
      var c = C[cid];
      var pr = getPrestige(cid);
      if (pr >= MAX_TIER) continue;
      var list = ownPerks(cid), i, tiers = 0, score = 0, gains = [];
      for (i = 0; i < list.length; i++) {
        var pid = list[i];
        var t = ownedTier(pid);
        var g = MAX_TIER - t;
        if (g <= 0) continue;
        tiers += g;
        score += g * weightOf(pid);
        gains.push({ perk: pid, name: perkName(pid), from: t, to: MAX_TIER, gain: g });
      }
      if (!tiers) continue;
      out.push({
        character: cid, name: (c && c.name) || cid, role: c.role,
        prestige: pr, tiers: tiers, score: score,
        weighted: (weightsState === 'ready' && !!WEIGHTS),
        perks: gains
      });
    }
    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.tiers !== a.tiers) return b.tiers - a.tiers;
      return norm(a.name).localeCompare(norm(b.name));
    });
    var n = num(limit, 0);
    return n > 0 ? out.slice(0, n) : out;
  }

  /* ----------------------------------------------------------------- shrine */

  /* app.js already fetches data/shrine-static.json into DBD.data.shrine (null
     on failure). Only fall back to our own fetch when the field was never set
     at all - that discriminates "app.js did not run this branch" from
     "app.js tried and the file is missing", so a missing file is not re-fetched
     on every render. */
  var shrineTried = false;

  function shrine() {
    var d = D();
    var s = d ? d.shrine : undefined;
    if (s && Array.isArray(s.perks) && s.perks.length) return s;
    if (d && s === undefined && !shrineTried) {
      shrineTried = true;
      if (typeof fetch === 'function') {
        try {
          fetch('/island/apps/dbd/data/shrine-static.json')
            .then(function (r) { if (!r || !r.ok) throw new Error('absent'); return r.json(); })
            .then(function (j) { if (d) { d.shrine = j || null; paint(); } })
            .catch(function () { if (d) d.shrine = null; });
        } catch (e) { /* leave it undefined; the panel renders its empty state */ }
      }
    }
    return null;
  }

  function shrineStale(s) {
    if (!s || !s.endsAt) return false;
    var t = new Date(s.endsAt).getTime();
    if (isNaN(t)) return false;
    return t < Date.now();
  }

  /* ------------------------------------------------------------- view state */

  var S = { role: 'killer', q: '', below3: false, open: {}, general: false };

  function matchesQuery(charId) {
    var q = norm(S.q).trim();
    if (!q) return true;
    if (norm(charName(charId)).indexOf(q) >= 0) return true;
    var list = ownPerks(charId), i;
    for (i = 0; i < list.length; i++) { if (norm(perkName(list[i])).indexOf(q) >= 0) return true; }
    return false;
  }

  function visibleChars() {
    var ids = charList(S.role), out = [], i;
    for (i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (S.below3 && getPrestige(id) >= MAX_TIER) continue;
      if (!matchesQuery(id)) continue;
      out.push(id);
    }
    return out;
  }

  function visibleGeneral() {
    var ids = generalPerkList(S.role), out = [], i;
    var q = norm(S.q).trim();
    for (i = 0; i < ids.length; i++) {
      if (q && norm(perkName(ids[i])).indexOf(q) < 0) continue;
      out.push(ids[i]);
    }
    return out;
  }

  /* -------------------------------------------------------------- art bits */

  /* Delegate to the shell's icon helper when it is there (it already handles
     icon/iconRemote AND portrait/portraitRemote, lazy loading and the
     placeholder), with a self-contained fallback so this file also renders
     standalone if app.js ever stops exporting it. */
  function art(entry, cls) {
    var f = window.DBD && window.DBD.icon;
    if (typeof f === 'function') { try { return f(entry, cls); } catch (e) { /* fall through */ } }
    var local = entry && (entry.icon || entry.portrait);
    var remote = entry && (entry.iconRemote || entry.portraitRemote);
    var src = local || remote;
    if (!src) return '<span class="dbdt-noart ' + esc(cls || '') + '" aria-hidden="true">?</span>';
    return '<span class="dbd-ic-wrap ' + esc(cls || '') + '"><span class="dbd-ic-inner">' +
      '<img class="dbd-ic" loading="lazy" decoding="async" src="' + esc(src) + '" alt=""></span></span>';
  }

  function pipsHtml(tier) {
    var out = '<span class="dbdt-pips" aria-hidden="true">', i;
    for (i = 1; i <= MAX_TIER; i++) out += '<i class="' + (i <= tier ? 'on' : '') + '"></i>';
    return out + '</span>';
  }

  function tierWord(t) { return t <= 0 ? 'Locked' : ('Tier ' + ['I', 'II', 'III'][t - 1]); }

  /* -------------------------------------------------------------- rendering */

  function statsInnerHtml() {
    var c = counts();
    function bar(label, r) {
      return '<div class="dbdt-bar-row">' +
        '<span class="dbdt-bar-lab">' + esc(label) + '</span>' +
        '<span class="dbdt-bar"><span class="dbdt-bar-fill" style="width:' + widthPct(r.owned, r.total) + '%"></span></span>' +
        '<span class="dbdt-bar-num">' + fmtInt(r.owned) + ' / ' + fmtInt(r.total) + '</span>' +
        '</div>';
    }
    return '<div class="dbdt-total"><b>' + fmtInt(c.ownedPerks) + '</b> / ' + fmtInt(c.totalPerks) +
      ' perks unlocked <span class="dbdt-pctchip">' + esc(c.pct.toFixed(1)) + '%</span></div>' +
      bar('Killer', c.byRole.killer) +
      bar('Survivor', c.byRole.survivor) +
      '<div class="dbdt-fine">' + fmtInt(c.ownedTiers) + ' / ' + fmtInt(c.totalTiers) +
      ' perk tiers owned &middot; general perks counted as tier III unless you override them</div>';
  }

  function headHtml() {
    return '<section class="dbdt-card dbdt-head">' +
      '<div class="dbdt-head-top">' +
      '<h2 class="dbdt-h">Perk unlocks</h2>' +
      '<span class="dbdt-save" id="dbdtSave">saved</span>' +
      '</div>' +
      '<div id="dbdtStats">' + statsInnerHtml() + '</div>' +
      '</section>';
  }

  function rowSummary(charId) {
    var d = Math.min(MAX_TIER, getPrestige(charId));
    return 'unlocks ' + d + '/' + MAX_TIER + ' tiers';
  }

  function quickBtn(charId, n, cur) {
    return '<button class="dbdt-q' + (cur === n ? ' on' : '') + '" data-dbdt-set="' + esc(charId) + ':' + n +
      '" aria-label="Set ' + esc(charName(charId)) + ' to prestige ' + n + '">P' + n + '</button>';
  }

  function perkRowHtml(perkId, forCharacterId) {
    var pk = perk(perkId);
    if (!pk) return '';
    var t = ownedTier(perkId, forCharacterId);
    var acct = ownedTier(perkId);
    var ov = getOverride(perkId);
    var badge = ov !== null ? '<span class="dbdt-tag manual">manual</span>' : '';
    var own = (forCharacterId && pk.character === forCharacterId && acct < MAX_TIER)
      ? '<span class="dbdt-tag own">own perk</span>' : '';
    return '<button class="dbdt-perk' + (t > 0 ? ' has' : '') + '" data-dbdt-perk="' + esc(perkId) + '">' +
      art(pk, 'ic32 diamond') +
      '<span class="dbdt-perk-txt">' +
      '<span class="dbdt-perk-name">' + esc(pk.name) + '</span>' +
      '<span class="dbdt-perk-sub">' + esc(tierWord(t)) + badge + own + '</span>' +
      '</span>' +
      pipsHtml(t) +
      '</button>';
  }

  function charRowHtml(charId) {
    var c = chr(charId);
    if (!c) return '';
    var pr = getPrestige(charId);
    var open = !!S.open[charId];
    var perksHtml = '';
    if (open) {
      var list = ownPerks(charId), i, rows = '';
      for (i = 0; i < list.length; i++) rows += perkRowHtml(list[i], charId);
      perksHtml = '<div class="dbdt-perklist">' + (rows || '<div class="dbdt-fine">No teachables on record.</div>') + '</div>';
    }
    return '<div class="dbdt-row' + (open ? ' open' : '') + '">' +
      '<button class="dbdt-row-main" data-dbdt-expand="' + esc(charId) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      art(c, 'ic32') +
      '<span class="dbdt-row-txt">' +
      '<span class="dbdt-row-name">' + esc(c.name) + '</span>' +
      '<span class="dbdt-row-sum" data-dbdt-sum="' + esc(charId) + '">' + esc(rowSummary(charId)) + '</span>' +
      '</span>' +
      '<span class="dbdt-caret" aria-hidden="true">' + (open ? '&minus;' : '+') + '</span>' +
      '</button>' +
      '<div class="dbdt-ctrl">' +
      '<div class="dbdt-step">' +
      '<button class="dbdt-stepbtn" data-dbdt-bump="' + esc(charId) + ':-1" aria-label="Lower prestige">&minus;</button>' +
      '<input class="dbdt-pnum" type="number" inputmode="numeric" min="0" max="' + MAX_PRESTIGE + '" step="1"' +
      ' value="' + esc(pr) + '" data-dbdt-pnum="' + esc(charId) + '" data-dbdt-focus="p:' + esc(charId) + '"' +
      ' aria-label="Prestige for ' + esc(c.name) + '">' +
      '<button class="dbdt-stepbtn" data-dbdt-bump="' + esc(charId) + ':1" aria-label="Raise prestige">+</button>' +
      '</div>' +
      '<div class="dbdt-quick">' + quickBtn(charId, 1, pr) + quickBtn(charId, 2, pr) + quickBtn(charId, 3, pr) + '</div>' +
      '</div>' +
      perksHtml +
      '</div>';
  }

  function prestigeHtml() {
    var kAll = charList('killer').length, sAll = charList('survivor').length;
    var ids = visibleChars(), i, rows = '';
    for (i = 0; i < ids.length; i++) rows += charRowHtml(ids[i]);
    if (!rows) rows = '<div class="dbdt-empty">No characters match. Clear the search or the P3 filter.</div>';

    var gIds = visibleGeneral(), gRows = '';
    if (S.general) {
      for (i = 0; i < gIds.length; i++) gRows += perkRowHtml(gIds[i], null);
      gRows = '<div class="dbdt-perklist wide">' + (gRows || '<div class="dbdt-fine">No general perks match.</div>') + '</div>';
    }

    return '<section class="dbdt-card">' +
      '<div class="dbdt-sec-h">Prestige</div>' +
      '<div class="dbdt-fine">Prestiging a character to P1 / P2 / P3 unlocks tier I / II / III of their three teachables for every character.</div>' +
      '<div class="dbdt-roletabs" role="tablist">' +
      '<button class="dbdt-roletab' + (S.role === 'killer' ? ' on' : '') + '" data-dbdt-role="killer" role="tab" aria-selected="' + (S.role === 'killer') + '">Killers <span>' + fmtInt(kAll) + '</span></button>' +
      '<button class="dbdt-roletab' + (S.role === 'survivor' ? ' on' : '') + '" data-dbdt-role="survivor" role="tab" aria-selected="' + (S.role === 'survivor') + '">Survivors <span>' + fmtInt(sAll) + '</span></button>' +
      '</div>' +
      '<div class="dbdt-tools">' +
      '<input class="dbdt-search" type="search" placeholder="Search characters or their perks..." value="' + esc(S.q) + '"' +
      ' data-dbdt-q="1" data-dbdt-focus="search" aria-label="Search characters or perks">' +
      '<button class="dbdt-chip' + (S.below3 ? ' on' : '') + '" data-dbdt-below3="1" aria-pressed="' + (S.below3 ? 'true' : 'false') + '">Below P3</button>' +
      '</div>' +
      '<div class="dbdt-rows">' + rows + '</div>' +
      '<button class="dbdt-general" data-dbdt-general="1" aria-expanded="' + (S.general ? 'true' : 'false') + '">' +
      (S.general ? '&minus;' : '+') + ' General ' + esc(S.role) + ' perks <span>' + fmtInt(gIds.length) + '</span>' +
      '</button>' + gRows +
      '</section>';
  }

  function planCardHtml(row, rank) {
    var c = chr(row.character);
    /* each name escaped BEFORE the join, so the separator entity survives */
    var names = [], i;
    for (i = 0; i < row.perks.length; i++) names.push(esc(row.perks[i].name) + ' (+' + esc(row.perks[i].gain) + ')');
    return '<div class="dbdt-plan">' +
      '<span class="dbdt-plan-rank">' + esc(rank) + '</span>' +
      art(c, 'ic32') +
      '<span class="dbdt-plan-txt">' +
      '<span class="dbdt-plan-name">' + esc(row.name) + ' <span class="dbdt-fine">P' + esc(row.prestige) + ' &rarr; P3</span></span>' +
      '<span class="dbdt-plan-gain">+' + esc(row.tiers) + ' perk tier' + (row.tiers === 1 ? '' : 's') +
      (row.weighted ? ' <span class="dbdt-fine">score ' + esc(Math.round(row.score * 10) / 10) + '</span>' : '') + '</span>' +
      '<span class="dbdt-plan-perks">' + names.join(' &middot; ') + '</span>' +
      '</span>' +
      '<button class="dbdt-q" data-dbdt-set="' + esc(row.character) + ':3">P3</button>' +
      '</div>';
  }

  function plannerHtml() {
    var rows = planner(PLAN_TOP_N), i, out = '';
    for (i = 0; i < rows.length; i++) out += planCardHtml(rows[i], i + 1);
    if (!out) out = '<div class="dbdt-empty">Every character is at P3. There is nothing left to unlock.</div>';
    /* The caption may never claim weighting the planner is not doing. */
    var note = (weightsState === 'ready' && WEIGHTS)
      ? 'Ranked by locked perk tiers, weighted by build archetypes.'
      : 'Ranked by locked perk tiers.';
    return '<section class="dbdt-card">' +
      '<div class="dbdt-sec-h">Prestige next</div>' +
      '<div class="dbdt-fine">' + esc(note) + '</div>' +
      out +
      '</section>';
  }

  function shrineRowHtml(row) {
    var pk = perk(row.perk);
    var t = pk ? ownedTier(row.perk) : 0;
    var nm = (pk && pk.name) || row.name || row.perk;
    var owner = pk && pk.character ? charName(pk.character) : (pk && pk.general ? 'General' : '');
    var roleTxt = row.role ? (String(row.role).charAt(0).toUpperCase() + String(row.role).slice(1)) : '';
    /* escape each piece BEFORE the join, so the separator entity survives */
    var sub = [roleTxt, owner].filter(function (x) { return !!x; })
      .map(function (x) { return esc(x); }).join(' &middot; ');
    var badge = t >= MAX_TIER
      ? '<span class="dbdt-badge owned">Owned</span>'
      : (t > 0 ? '<span class="dbdt-badge part">' + esc(tierWord(t)) + '</span>'
               : '<span class="dbdt-badge locked">Locked</span>');
    var hint = '';
    if (t < MAX_TIER) {
      var bits = [];
      if (row.shards != null) bits.push(fmtInt(row.shards) + ' shards');
      if (row.bloodpoints != null) bits.push(fmtInt(row.bloodpoints) + ' BP');
      hint = '<div class="dbdt-fine">Buyable in the shrine' + (bits.length ? ' for ' + esc(bits.join(' + ')) : '') + '</div>';
    }
    var open = pk ? ' data-dbdt-perk="' + esc(row.perk) + '"' : '';
    return '<' + (pk ? 'button' : 'div') + ' class="dbdt-shrine-row"' + open + '>' +
      art(pk || row, 'ic32 diamond') +
      '<span class="dbdt-perk-txt">' +
      '<span class="dbdt-perk-name">' + esc(nm) + '</span>' +
      '<span class="dbdt-perk-sub">' + sub + '</span>' + hint +
      '</span>' + badge +
      '</' + (pk ? 'button' : 'div') + '>';
  }

  function shrineHtml() {
    var s = shrine();
    if (!s) {
      return '<section class="dbdt-card">' +
        '<div class="dbdt-sec-h">Shrine of Secrets</div>' +
        '<div class="dbdt-empty">No shrine snapshot in this build.</div>' +
        '</section>';
    }
    var rows = '', i;
    for (i = 0; i < s.perks.length; i++) rows += shrineRowHtml(s.perks[i] || {});
    var warn = '';
    if (shrineStale(s)) {
      warn = '<div class="dbdt-warn">Shrine data from ' + esc(ymd(s.pulledAt || s.startsAt)) +
        ' &mdash; refresh pending. This rotation ended ' + esc(ymd(s.endsAt)) + '.</div>';
    }
    return '<section class="dbdt-card">' +
      '<div class="dbdt-sec-h">Shrine of Secrets</div>' +
      warn + rows +
      '<div class="dbdt-fine">Snapshot pulled ' + esc(ymd(s.pulledAt)) +
      '. The shrine endpoint blocks cross-origin reads, so this panel refreshes with the data pull, never live.</div>' +
      '</section>';
  }

  /* ------------------------------------------------------------ host + paint */

  function hostFor(arg) {
    if (arg && arg.nodeType === 1) return arg;
    if (typeof arg === 'string') { var e = $(arg); if (e) return e; }
    if (arg && arg.host && arg.host.nodeType === 1) return arg.host;
    if (arg && arg.el && arg.el.nodeType === 1) return arg.el;
    var vh = window.DBD && window.DBD.viewHost;
    if (vh && vh.nodeType === 1) return vh;
    if (typeof vh === 'function') { try { var r = vh('tracker'); if (r && r.nodeType === 1) return r; } catch (e2) { /* keep looking */ } }
    var guesses = ['#app', '#view-tracker', '#trackerView', '[data-view="tracker"]', '#view', '#main'];
    for (var i = 0; i < guesses.length; i++) { var g = $(guesses[i]); if (g) return g; }
    return null;
  }

  var waiting = false, waitTicks = 0;
  function waitForData() {
    if (waiting) return;
    waiting = true;
    var t = setInterval(function () {
      if (dataReady()) { clearInterval(t); waiting = false; paint(); return; }
      if (++waitTicks > 80) { clearInterval(t); waiting = false; }
    }, 125);
  }

  function build() {
    var wrap = document.createElement('div');
    wrap.className = 'dbdt-root dbdt-scope';
    if (!dataReady()) {
      wrap.setAttribute('data-state', 'loading');
      wrap.innerHTML = '<div class="dbdt-loading">Loading the Fog&#8230;</div>';
      waitForData();
      return wrap;
    }
    loadWeights();
    wrap.innerHTML = headHtml() + prestigeHtml() + plannerHtml() + shrineHtml();
    return wrap;
  }

  function attrSafe(v) { return String(v == null ? '' : v).replace(/["\\]/g, ''); }

  var painting = false;

  /* Re-render in place, preserving focus + caret of whatever field the user is
     in (the search box repaints on every keystroke). A no-op when the tracker
     view is not currently mounted, so any mutation can call it safely. */
  function paint() {
    if (painting) return;
    var root = $('.dbdt-root');
    if (!root || !root.parentNode) return;
    painting = true;
    var fk = null, ss = null, se = null;
    try {
      var a = document.activeElement;
      if (a && a.getAttribute && a.getAttribute('data-dbdt-focus')) {
        fk = a.getAttribute('data-dbdt-focus');
        try { ss = a.selectionStart; se = a.selectionEnd; } catch (e) { /* number inputs throw */ }
      }
    } catch (e) { /* no activeElement */ }
    try {
      var next = build();
      root.parentNode.replaceChild(next, root);
      if (fk) {
        var el = $('[data-dbdt-focus="' + attrSafe(fk) + '"]', next);
        if (el && el.focus) {
          try { el.focus(); if (ss != null && el.setSelectionRange) el.setSelectionRange(ss, se); }
          catch (e2) { /* focus is best-effort */ }
        }
      }
    } finally { painting = false; }
  }

  /* Live-refresh only the numbers, for the case where repainting would steal
     focus from a number field mid-keystroke. */
  function refreshStats() {
    var host = $('#dbdtStats');
    if (host) host.innerHTML = statsInnerHtml();
    $$('[data-dbdt-sum]').forEach(function (n) {
      var id = n.getAttribute('data-dbdt-sum');
      if (id) n.textContent = rowSummary(id);
    });
  }

  function renderView(arg) {
    var node = build();
    var host = hostFor(arg);
    if (host) { host.innerHTML = ''; host.appendChild(node); }
    return node.outerHTML;
  }

  /* ------------------------------------------------------------ override sheet */

  function overrideSheetHtml(perkId) {
    var pk = perk(perkId);
    if (!pk) return '<div class="dbdt-scope dbdt-sheet"><div class="dbdt-empty">Perk not found.</div></div>';
    var d = derivedTier(perkId);
    var t = ownedTier(perkId);
    var ov = getOverride(perkId);
    var owner = pk.general || !pk.character ? 'General perk' : charName(pk.character);
    var path = unlockPath(perkId);
    var btns = '', i;
    for (i = 0; i <= MAX_TIER; i++) {
      btns += '<button class="dbdt-tierbtn' + (t === i ? ' on' : '') + '" data-dbdt-ovr="' + esc(perkId) + ':' + i + '">' +
        (i === 0 ? 'Locked' : ['I', 'II', 'III'][i - 1]) + '</button>';
    }
    return '<div class="dbdt-scope dbdt-sheet">' +
      '<div class="sheet-head">' + art(pk, 'ic72 diamond') +
      '<div class="sh-ti"><h3>' + esc(pk.name) + '</h3>' +
      '<div class="sh-sub">' + esc(owner) + (pk.role ? ' &middot; ' + esc(pk.role.charAt(0).toUpperCase() + pk.role.slice(1)) : '') + '</div>' +
      '</div></div>' +
      '<div class="dbdt-sec-h">Owned tier</div>' +
      '<div class="dbdt-tierbtns">' + btns + '</div>' +
      '<div class="dbdt-fine">Derived from your prestige: <b>' + esc(tierWord(d)) + '</b> (' + esc(d) + ')' +
      (ov !== null ? ' &middot; <span class="dbdt-tag manual">manual override active</span>' : '') + '</div>' +
      (ov !== null ? '<button class="dbdt-reset" data-dbdt-ovr-reset="' + esc(perkId) + '">Reset to derived</button>' : '') +
      (path ? '<div class="dbdt-fine path">' + esc(path.text) + ' to unlock ' + esc(tierWord(path.neededPrestige)) + '.</div>' : '') +
      '<div class="dbdt-sec-h">Effect</div>' +
      '<div class="sheet-desc">' + descHtml(pk, t > 0 ? t - 1 : 0) + '</div>' +
      '</div>';
  }

  function descHtml(pk, tierIndex) {
    var raw = (pk.tiered && Array.isArray(pk.descriptionTiers) && pk.descriptionTiers[tierIndex])
      ? pk.descriptionTiers[tierIndex] : pk.description;
    var f = window.DBD && window.DBD.formatDesc;
    if (typeof f === 'function') { try { return f(raw); } catch (e) { /* fall through */ } }
    return localEsc(raw);
  }

  function openOverrideSheet(perkId) {
    var f = window.DBD && window.DBD.openSheet;
    if (typeof f !== 'function') return false;
    try {
      f(overrideSheetHtml(perkId), { label: perkName(perkId), reopen: function () { openOverrideSheet(perkId); } });
      return true;
    } catch (e) { return false; }
  }

  /* ----------------------------------------------------------------- events */

  function pairOf(v) {
    var s = String(v == null ? '' : v);
    var i = s.lastIndexOf(':');
    if (i < 0) return null;
    return { id: s.slice(0, i), n: Number(s.slice(i + 1)) };
  }

  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var role = t.closest('[data-dbdt-role]');
    if (role) { S.role = role.getAttribute('data-dbdt-role') === 'survivor' ? 'survivor' : 'killer'; paint(); return; }

    var b3 = t.closest('[data-dbdt-below3]');
    if (b3) { S.below3 = !S.below3; paint(); return; }

    var gen = t.closest('[data-dbdt-general]');
    if (gen) { S.general = !S.general; paint(); return; }

    var exp = t.closest('[data-dbdt-expand]');
    if (exp) {
      var cid = exp.getAttribute('data-dbdt-expand');
      if (cid) { S.open[cid] = !S.open[cid]; paint(); }
      return;
    }

    var bump = t.closest('[data-dbdt-bump]');
    if (bump) {
      var pb = pairOf(bump.getAttribute('data-dbdt-bump'));
      if (pb) setPrestige(pb.id, getPrestige(pb.id) + pb.n);
      return;
    }

    var setb = t.closest('[data-dbdt-set]');
    if (setb) {
      var ps = pairOf(setb.getAttribute('data-dbdt-set'));
      /* tapping the prestige you already have clears back to P0 */
      if (ps) setPrestige(ps.id, getPrestige(ps.id) === ps.n ? 0 : ps.n);
      return;
    }

    var ovr = t.closest('[data-dbdt-ovr]');
    if (ovr) {
      var po = pairOf(ovr.getAttribute('data-dbdt-ovr'));
      if (po) { setOverride(po.id, po.n); openOverrideSheet(po.id); }
      return;
    }

    var rst = t.closest('[data-dbdt-ovr-reset]');
    if (rst) {
      var rid = rst.getAttribute('data-dbdt-ovr-reset');
      if (rid) { clearOverride(rid); openOverrideSheet(rid); }
      return;
    }

    var pk = t.closest('[data-dbdt-perk]');
    if (pk) {
      var pid = pk.getAttribute('data-dbdt-perk');
      if (pid) openOverrideSheet(pid);
      return;
    }
  }

  function onInput(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-dbdt-q') != null) { S.q = t.value || ''; paint(); return; }
    var pid = t.getAttribute('data-dbdt-pnum');
    if (pid) {
      /* quiet: keep the model live while typing, but do not rebuild the field */
      setPrestige(pid, t.value, true);
      refreshStats();
    }
  }

  function onChangeEvt(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var pid = t.getAttribute('data-dbdt-pnum');
    if (pid) setPrestige(pid, t.value);
  }

  var wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    try {
      document.addEventListener('click', onClick, false);
      document.addEventListener('input', onInput, false);
      document.addEventListener('change', onChangeEvt, false);
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', function () { flush(); }, false);
      }
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
      }, false);
    } catch (e) { /* a hostless environment still gets the API */ }
  }

  /* -------------------------------------------------------------- install */

  function install(DBD) {
    DBD.tracker = {
      /* --- the contract builds.js consumes --- */
      getPrestige: function (charId) { return getPrestige(charId); },
      setPrestige: function (charId, n) { return setPrestige(charId, n); },
      ownedTier: function (perkId, forCharacterId) { return ownedTier(perkId, forCharacterId); },
      isOwned: function (perkId, forCharacterId) { return isOwned(perkId, forCharacterId); },
      unlockPath: function (perkId) { return unlockPath(perkId); },
      counts: counts,
      onChange: onChange,

      /* --- supporting surface --- */
      derivedTier: function (perkId) { return derivedTier(perkId); },
      getOverride: function (perkId) { return getOverride(perkId); },
      setOverride: function (perkId, tier) { return setOverride(perkId, tier); },
      clearOverride: function (perkId) { return clearOverride(perkId); },
      planner: function (limit) { return planner(limit == null ? PLAN_TOP_N : limit); },
      shrine: shrine,
      setPerkWeights: setPerkWeights,
      openPerk: function (perkId) { return openOverrideSheet(perkId); },
      resetProfile: resetProfile,
      flush: flush,
      profile: function () { return ensureProfile(); },
      storageKey: LS_KEY
    };

    wire();
    if (typeof DBD.registerView === 'function') {
      try { DBD.registerView('tracker', renderView); } catch (e) { /* shell will re-ask */ }
    }
    DBD.trackerReady = true;
  }

  var boots = 0;
  (function boot() {
    if (window.DBD && typeof window.DBD.registerView === 'function') { install(window.DBD); return; }
    if (++boots > 400) return;                 /* ~10s, then give up quietly */
    setTimeout(boot, 25);
  }());
}());
