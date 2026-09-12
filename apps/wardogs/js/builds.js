/* WARDOGS Companion - the Builds tab (L2 tool surface).
 *
 * LANE FENCE. This file and css/builds.css are the whole Builds-tab UI. The
 * SCORING ENGINE is a separate lane and a separate file; nothing in here scores
 * anything, ranks anything, or knows a single game fact. This file only:
 *   1. collects the brief (what you are building, what you want, what you are
 *      up against, what must be in it, what you can spend),
 *   2. hands that brief to the engine,
 *   3. renders what comes back with a receipt under every pick, and
 *   4. refuses to print anything the engine cannot back.
 *
 * DATA RULE. Every game number on this tab is read live out of data/*.json
 * through app.js's already-loaded `S.groups` / `S.byId`. There is no second
 * dataset, no fetch in this file, and no game number, price, level or entity
 * name typed into this source. tools/validate.mjs group J asserts all of that
 * by scanning this file - see "J. builds tool" there.
 *
 * ---------------------------------------------------------------------------
 * THE ENGINE CONTRACT  (the engine lane implements this; the UI never assumes)
 * ---------------------------------------------------------------------------
 * The engine lane ships a file loaded AFTER this one that sets:
 *
 *   window.WD_ENGINE = {
 *     version: 'string',                 // shown on the tab, so a stale engine is visible
 *     basis: {                           // what the scoring rests on, or null if none
 *       label: 'string',                 //   e.g. "ranked matches sampled by <source>"
 *       n: 12300, nUnit: 'matches',      //   REQUIRED whenever label is present
 *       pulledAt: 'ISO-8601'             //   when that sample was taken
 *     } | null,
 *     goals: [ {id, label, help} ],      // OPTIONAL. If present it REPLACES the UI's
 *                                        // intent chips and is authoritative.
 *     phases: [ {id, label, budget} ],   // OPTIONAL. budget is a number of dollars.
 *     generate(input) -> result | Promise<result>
 *   }
 *
 * input (built by this file, never by the engine):
 *   { version:1, level, weapon, goals[], enemy[], locks[], phase, budget,
 *     owned[], pins[] }
 *   - weapon / enemy / locks / owned / pins are "<group>:<id>" keys into S.byId.
 *
 * result:
 *   { ok:true,
 *     build: [ { key, slot, order, receipts:[receipt], lock:{text,n,nUnit,runnerUp} } ],
 *     totals: { cost, weight },          // OPTIONAL - see THE ARITHMETIC RULE
 *     unfilled: [ {slot, reason} ],
 *     notes: [ 'string' ] }
 *   or { ok:false, error:'plain sentence a beginner can act on' }
 *
 * receipt:
 *   { kind: 'data'|'rule'|'goal'|'counter'|'lock'|'note',
 *     text: 'one plain sentence',
 *     n: 12300, nUnit: 'matches',        // REQUIRED for kind 'data', else omitted
 *     source: 'string' }                 // optional provenance shown in small text
 *
 * THE SAMPLE-SIZE RULE, enforced here and not merely documented:
 *   a receipt of kind 'data' WITHOUT a finite n >= 1 is DROPPED and counted as a
 *   contract violation which the tab prints. That is the template's "if a number
 *   has no sample behind it, print no number" turned into a gate. Sample sizes
 *   render as a visible badge next to the sentence - never a tooltip, never a
 *   title attribute.
 *
 * THE ARITHMETIC RULE:
 *   the totals this tab prints are ALWAYS recomputed here from data/*.json, so
 *   the cost and weight on this tab cannot disagree with the same numbers on the
 *   Weapons and Items tabs or in the vault wiki. If the engine also sends
 *   totals and they differ, the UI still prints its own and shows the
 *   disagreement rather than silently picking one.
 *
 * THE KEY RULE:
 *   a pick whose key is not in S.byId is DROPPED and counted. The engine cannot
 *   put an entity on screen that the dataset does not contain.
 *
 * WITHOUT AN ENGINE the whole input surface still works and persists; the
 * generate button is disabled and says exactly what is missing. The UI never
 * invents a loadout to fill the space.
 */
'use strict';

(function () {
  /* app.js is a classic script, so its top-level bindings are reachable by bare
     name from here. If it failed to parse there is nothing to attach to. */
  if (typeof S === 'undefined' || typeof esc !== 'function') return;

  var MAX_GOALS = 3;

  /* The single canonical sentence. Rendered in two places from ONE constant so
     the two can never drift. This is UI chrome - it makes a claim about the
     TOOL, not about WARDOGS. */
  var RULING = 'This tab shows the best loadout the generator could find in the numbers on this page. ' +
    'It is not a proof that nothing better exists.';

  /* INTENT CHIPS - what the player wants, in their own words. These are not
     game facts: none of them asserts a stat, a number or a behaviour. Each one
     is offered only when `dep` names a group the dataset actually shipped, so a
     group that disappears from a future pull removes its chip instead of
     leaving a promise the data cannot keep. validate.mjs group J parses the
     `dep:` values below and fails if any of them is not a real group.
     If the engine declares its own goals, the engine wins and this list is
     never shown. */
  var GOAL_DEFAULTS = [
    { id: 'cheap', dep: 'weapons', label: 'Spend as little as I can', help: 'Prefer things that cost less to buy back after a death.' },
    { id: 'light', dep: 'gear', label: 'Keep the weight down', help: 'Prefer the lighter option when two picks are close.' },
    { id: 'range', dep: 'weapons', label: 'Fight at longer range', help: 'Lean the loadout towards reaching further.' },
    { id: 'armour', dep: 'vehicles', label: 'Have an answer to vehicles', help: 'Make room for something that can hurt armour.' },
    { id: 'hold', dep: 'deployables', label: 'Hold one position', help: 'Favour a kit that can sit somewhere and stay there.' },
    { id: 'mobile', dep: 'vehicles', label: 'Move around the map fast', help: 'Favour getting places over standing and trading.' },
    { id: 'medic', dep: 'medical', label: 'Keep my squad up', help: 'Make room for healing and reviving other people.' }
  ];

  /* Which groups the "must include" picker offers. A group qualifies by DATA
     shape - it has at least one record the source gave a price or an unlock
     level - not by a list of group names typed here. */
  function lockableGroups() {
    var out = [];
    for (var i = 0; i < S.gmeta.length; i++) {
      var k = S.gmeta[i].key;
      var rows = S.groups[k] || [];
      for (var j = 0; j < rows.length; j++) {
        if (typeof rows[j].price === 'number' || rows[j].wardogLevel || rows[j].unlockPrice) { out.push(k); break; }
      }
    }
    return out;
  }

  /* The enemy picker offers the sides you can be up against plus the hardware
     you can run into. Same rule: derived from what the dataset contains. */
  function enemyGroups() {
    var out = [];
    var want = ['factions', 'vehicles', 'weapons'];
    for (var i = 0; i < want.length; i++) if ((S.groups[want[i]] || []).length) out.push(want[i]);
    return out;
  }

  /* --------------------------------------------------------------- state */

  var LAST = null;      // last engine result, already sanitised
  var LAST_SIG = null;  // the brief that produced it
  var BUSY = false;
  var ERR = null;       // engine error string
  var VIOL = [];        // contract violations found in the last result
  var PICKER = null;    // {kind, q} while the picker sheet is open

  /* ------------------------------------------------------ brief storage */

  /* Stored through app.js's own sparse override layer, so it lives inside the
     active loadout profile, is saved by the same debounced writer, and is
     carried by the same backup/restore path as everything else. */
  function bget(key, dflt) { return ovGet(prof(), 'brief', key, dflt); }
  function bset(key, val) { ovSet('brief', key, val); }

  function briefGoals() {
    var raw = bget('goals', []);
    if (!Array.isArray(raw)) return [];
    var allowed = {};
    var list = goalList();
    for (var i = 0; i < list.length; i++) allowed[list[i].id] = 1;
    var out = [];
    for (var j = 0; j < raw.length; j++) if (allowed[raw[j]] && out.indexOf(raw[j]) === -1) out.push(raw[j]);
    return out.slice(0, MAX_GOALS);
  }
  function briefKeys(key) {
    var raw = bget(key, []);
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) if (ent(raw[i]) && out.indexOf(raw[i]) === -1) out.push(raw[i]);
    return out;
  }
  function briefWeapon() {
    var k = bget('weapon', null);
    return (k && ent(k)) ? k : null;
  }
  function briefBudget() {
    var v = bget('budget', null);
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return isFinite(n) && n >= 0 ? n : null;
  }
  function briefPhase() {
    var p = bget('phase', null);
    var ph = enginePhases();
    for (var i = 0; i < ph.length; i++) if (ph[i].id === p) return p;
    return null;
  }

  function ownedKeys() {
    var out = [];
    for (var i = 0; i < S.gmeta.length; i++) {
      var gk = S.gmeta[i].key;
      var rows = S.groups[gk] || [];
      for (var j = 0; j < rows.length; j++) {
        var k = keyOf(gk, rows[j].id);
        if (isOwned(k)) out.push(k);
      }
    }
    return out;
  }

  function currentInput() {
    return {
      version: 1,
      level: myLevel(),
      weapon: briefWeapon(),
      goals: briefGoals(),
      enemy: briefKeys('enemy'),
      locks: briefKeys('locks'),
      phase: briefPhase(),
      budget: briefBudget(),
      owned: ownedKeys(),
      pins: prof().pins.slice()
    };
  }
  function signature(inp) { return JSON.stringify(inp); }

  /* ----------------------------------------------------------- engine io */

  function engine() {
    var e = window.WD_ENGINE;
    return (e && typeof e.generate === 'function') ? e : null;
  }
  function engineGoals() {
    var e = engine();
    if (!e || !Array.isArray(e.goals) || !e.goals.length) return null;
    var out = [];
    for (var i = 0; i < e.goals.length; i++) {
      var g = e.goals[i];
      if (g && g.id && g.label) out.push({ id: String(g.id), label: String(g.label), help: g.help ? String(g.help) : '' });
    }
    return out.length ? out : null;
  }
  function enginePhases() {
    var e = engine();
    if (!e || !Array.isArray(e.phases)) return [];
    var out = [];
    for (var i = 0; i < e.phases.length; i++) {
      var p = e.phases[i];
      if (p && p.id && p.label) out.push({ id: String(p.id), label: String(p.label), budget: typeof p.budget === 'number' ? p.budget : null });
    }
    return out;
  }
  function goalList() {
    var eg = engineGoals();
    if (eg) return eg;
    var out = [];
    for (var i = 0; i < GOAL_DEFAULTS.length; i++) {
      var g = GOAL_DEFAULTS[i];
      if ((S.groups[g.dep] || []).length) out.push(g);
    }
    return out;
  }

  /* An engine that is present but does not meet the contract is a louder
     problem than one that is absent, so it is checked and named. */
  function engineFaults() {
    var e = engine();
    if (!e) return [];
    var f = [];
    if (!e.version) f.push('the engine does not say which version it is, so a stale one cannot be spotted');
    if (e.basis && (!isFinite(e.basis.n) || e.basis.n < 1)) f.push('the engine names what its numbers rest on but gives no sample size for it');
    if (e.goals && !Array.isArray(e.goals)) f.push('the engine sent goals that are not a list');
    if (e.phases && !Array.isArray(e.phases)) f.push('the engine sent phases that are not a list');
    return f;
  }

  /* ------------------------------------------------------- sanitisation */

  /* Everything the engine hands back passes through here before a single pixel
     of it reaches the screen. Nothing that fails a rule is repaired quietly -
     it is dropped and recorded, and the tab prints what was dropped. */
  function sanitise(res) {
    VIOL = [];
    if (!res || typeof res !== 'object') { ERR = 'The generator returned nothing this tab could read.'; return null; }
    if (res.ok === false) { ERR = res.error ? String(res.error) : 'The generator could not build a loadout from that.'; return null; }
    ERR = null;

    var picks = [];
    var raw = Array.isArray(res.build) ? res.build : [];
    for (var i = 0; i < raw.length; i++) {
      var p = raw[i];
      if (!p || !p.key) { VIOL.push('a pick arrived with no entity on it and was dropped'); continue; }
      var e = ent(p.key);
      if (!e) { VIOL.push('a pick named "' + p.key + '", which is not in this dataset, and was dropped'); continue; }
      picks.push({
        key: p.key,
        gk: p.key.slice(0, p.key.indexOf(':')),
        e: e,
        slot: p.slot ? String(p.slot) : '',
        order: isFinite(p.order) ? Number(p.order) : (i + 1),
        receipts: cleanReceipts(p.receipts, p.key),
        lock: cleanLock(p.lock, p.key)
      });
    }
    picks.sort(function (a, b) { return a.order - b.order; });

    var unfilled = [];
    if (Array.isArray(res.unfilled)) {
      for (var u = 0; u < res.unfilled.length; u++) {
        var s = res.unfilled[u];
        if (s && s.slot) unfilled.push({ slot: String(s.slot), reason: s.reason ? String(s.reason) : '' });
      }
    }
    var notes = [];
    if (Array.isArray(res.notes)) for (var n = 0; n < res.notes.length; n++) if (res.notes[n]) notes.push(String(res.notes[n]));

    var mine = recompute(picks);
    if (res.totals && typeof res.totals === 'object') {
      if (isFinite(res.totals.cost) && Number(res.totals.cost) !== mine.cost) {
        VIOL.push('the generator totalled the cost differently from the prices in this dataset; the figure shown is the one summed from the data');
      }
      if (isFinite(res.totals.weight) && Math.round(Number(res.totals.weight) * 100) !== Math.round(mine.weight * 100)) {
        VIOL.push('the generator totalled the weight differently from the weights in this dataset; the figure shown is the one summed from the data');
      }
    }
    return { picks: picks, unfilled: unfilled, notes: notes, totals: mine };
  }

  function cleanReceipts(list, key) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || !r.text) continue;
      var kind = r.kind ? String(r.kind) : 'note';
      var n = isFinite(r.n) ? Number(r.n) : null;
      if (kind === 'data' && !(n !== null && n >= 1)) {
        VIOL.push('a win-rate style claim on "' + key + '" arrived with no sample size behind it and was dropped');
        continue;
      }
      out.push({
        kind: kind,
        text: String(r.text),
        n: n,
        nUnit: r.nUnit ? String(r.nUnit) : '',
        source: r.source ? String(r.source) : ''
      });
    }
    return out;
  }

  function cleanLock(lock, key) {
    if (!lock || !lock.text) return null;
    var n = isFinite(lock.n) ? Number(lock.n) : null;
    var ru = lock.runnerUp && ent(lock.runnerUp) ? lock.runnerUp : null;
    if (lock.runnerUp && !ru) VIOL.push('the runner-up quoted against the lock on "' + key + '" is not in this dataset and was not shown');
    return { text: String(lock.text), n: n, nUnit: lock.nUnit ? String(lock.nUnit) : '', runnerUp: ru };
  }

  /* THE ARITHMETIC RULE. Totals are summed here, from the same fields the
     Weapons and Items tabs and the vault wiki print. */
  function recompute(picks) {
    var cost = 0, weight = 0, priced = 0, weighed = 0;
    for (var i = 0; i < picks.length; i++) {
      var e = picks[i].e;
      if (typeof e.price === 'number') { cost += e.price; priced++; }
      if (typeof e.weightKg === 'number') { weight += e.weightKg; weighed++; }
    }
    return { cost: cost, weight: Math.round(weight * 100) / 100, priced: priced, weighed: weighed, of: picks.length };
  }

  /* -------------------------------------------------- derived price tiers */

  /* Quick-pick budgets. Every value is a real price that exists in the dataset
     - four points across the spread of what things actually cost - so no amount
     on this tab was invented by the UI. */
  function priceTiers() {
    var vals = [];
    for (var i = 0; i < S.gmeta.length; i++) {
      var rows = S.groups[S.gmeta[i].key] || [];
      for (var j = 0; j < rows.length; j++) {
        var p = rows[j].price;
        if (typeof p === 'number' && p > 0 && vals.indexOf(p) === -1) vals.push(p);
      }
    }
    vals.sort(function (a, b) { return a - b; });
    if (vals.length < 4) return vals;
    var at = [0.25, 0.5, 0.75, 1];
    var out = [];
    for (var q = 0; q < at.length; q++) {
      var v = vals[Math.min(vals.length - 1, Math.floor((vals.length - 1) * at[q]))];
      if (out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  /* ---------------------------------------------------------- rendering */

  function viewHtml() {
    var m = S.meta || {};
    var h = '<div class="view">';
    h += searchHtml('Search anything while you plan');

    h += '<h2 class="vh">Loadout builder</h2>';

    /* Freshness and the patch, on this tab specifically (IA standard). */
    h += '<div class="card"><div class="fresh">' +
      '<span>Data pulled <b>' + esc(prettyDate(m.pulledAt)) + '</b></span><span class="faint">&middot;</span>' +
      '<span>Reflects <b>' + esc(m.pulledAtVersion || '') + '</b></span>' +
      (engine() && window.WD_ENGINE.version ? '<span class="faint">&middot;</span><span>Generator <b>' + esc(window.WD_ENGINE.version) + '</b></span>' : '') +
      '</div>' +
      '<p class="small muted" style="margin:8px 0 0">' + esc(m.disclaimer || '') + '</p></div>';

    h += '<div class="ruling">' + esc(RULING) + '</div>';

    h += briefHtml();
    h += generateBarHtml();
    h += resultHtml();
    h += pinsHtml();
    h += profileHtml();

    h += '</div>';
    return h;
  }

  /* ------------------------------------------------------------- inputs */

  function briefHtml() {
    var h = '<div class="b-brief">';

    /* 1. the thing the build is built around. */
    var wk = briefWeapon();
    h += '<div class="b-block">';
    h += '<div class="b-lab">1. What are you building around?</div>';
    if (wk) {
      var w = ent(wk);
      var wgk = wk.slice(0, wk.indexOf(':'));
      h += '<div class="b-picked">' + iconHtml(w, wgk, 44) +
        '<span class="b-picked-b"><span class="b-picked-n">' + esc(nameOf(w, wgk)) + '</span>' +
        '<span class="b-picked-m">' + esc(w.category || '') + (w.caliber ? ' &middot; ' + esc(w.caliber) : '') + '</span></span>' +
        '<button class="b-x" data-bclear="weapon" aria-label="Clear the chosen weapon">Change</button></div>';
    } else {
      h += '<button class="b-open" data-bpicker="weapon">Choose a primary weapon</button>' +
        '<p class="b-help">Pick nothing and the generator is free to choose the weapon too.</p>';
    }
    h += '</div>';

    /* 2. goals, up to three. */
    var goals = goalList();
    var chosen = briefGoals();
    h += '<div class="b-block">';
    h += '<div class="b-lab">2. What do you want out of it? <span class="b-count">' + chosen.length + ' of ' + MAX_GOALS + '</span></div>';
    if (!goals.length) {
      h += '<div class="b-empty">The generator has not told this tab which goals it can weigh, and this app will not offer a goal it cannot act on.</div>';
    } else {
      h += '<div class="b-goals">';
      for (var i = 0; i < goals.length; i++) {
        var on = chosen.indexOf(goals[i].id) !== -1;
        var full = !on && chosen.length >= MAX_GOALS;
        h += '<button class="b-goal' + (on ? ' on' : '') + (full ? ' off' : '') + '" data-bgoal="' + esc(goals[i].id) + '"' + (full ? ' disabled' : '') + '>' +
          '<span class="b-goal-n">' + esc(goals[i].label) + '</span>' +
          (goals[i].help ? '<span class="b-goal-h">' + esc(goals[i].help) + '</span>' : '') +
          '</button>';
      }
      h += '</div>';
      if (chosen.length >= MAX_GOALS) h += '<p class="b-help">Three is the limit. Drop one to swap it.</p>';
    }
    h += '</div>';

    /* 3. enemy roster - optional. */
    var enemy = briefKeys('enemy');
    h += '<div class="b-block">';
    h += '<div class="b-lab">3. What are you up against? <span class="b-opt">optional</span></div>';
    h += keyChipsHtml(enemy, 'enemy');
    h += '<button class="b-open small" data-bpicker="enemy">' + (enemy.length ? 'Add or remove' : 'Name the side or the hardware') + '</button>';
    h += '<p class="b-help">Leave it empty if you do not know yet. The generator only adjusts for what you tell it.</p>';
    h += '</div>';

    /* 4. locks. */
    var locks = briefKeys('locks');
    h += '<div class="b-block">';
    h += '<div class="b-lab">4. Anything that has to be in it? <span class="b-opt">optional</span></div>';
    h += keyChipsHtml(locks, 'locks');
    h += '<div class="row wrap g6">';
    h += '<button class="b-open small" data-bpicker="locks">' + (locks.length ? 'Add or remove' : 'Lock an item in') + '</button>';
    if (prof().pins.length) h += '<button class="b-open small" data-block-pins>Lock everything I pinned (' + prof().pins.length + ')</button>';
    if (locks.length) h += '<button class="b-open small" data-bclear="locks">Clear the locks</button>';
    h += '</div>';
    h += '<p class="b-help">A locked pick is kept whatever it scores, and the tab prints what keeping it cost you.</p>';
    h += '</div>';

    /* 5. budget / phase. */
    var phases = enginePhases();
    var budget = briefBudget();
    var phase = briefPhase();
    h += '<div class="b-block">';
    h += '<div class="b-lab">5. What can you spend?</div>';
    if (phases.length) {
      h += '<div class="chiprow">';
      for (var p = 0; p < phases.length; p++) {
        h += '<button class="fbtn' + (phase === phases[p].id ? ' on' : '') + '" data-bphase="' + esc(phases[p].id) + '">' + esc(phases[p].label) + '</button>';
      }
      h += '</div>';
    }
    h += '<div class="b-budget"><span class="b-cur">$</span>' +
      '<input id="bBudget" type="number" min="0" step="100" inputmode="numeric" placeholder="cash in the bank" value="' +
      (budget === null ? '' : esc(budget)) + '" /></div>';
    var tiers = priceTiers();
    if (tiers.length) {
      h += '<div class="chiprow">';
      for (var t = 0; t < tiers.length; t++) {
        h += '<button class="fbtn' + (budget === tiers[t] ? ' on' : '') + '" data-bbudget="' + esc(tiers[t]) + '">' + esc(money(tiers[t])) + '</button>';
      }
      h += '<button class="fbtn' + (budget === null ? ' on' : '') + '" data-bbudget="">No limit</button>';
      h += '</div>';
      h += '<p class="b-help">Those quick amounts are real prices out of this dataset, not round numbers someone picked.</p>';
    }
    h += '<div class="lvlctl" style="margin-top:10px"><label for="lvl" class="small muted">WARDOG level</label>' +
      '<input id="lvl" type="number" min="1" max="200" inputmode="numeric" value="' + esc(myLevel()) + '" />' +
      '<span class="small faint">Nothing above this level is offered to you.</span></div>';
    h += '</div>';

    h += '</div>';
    return h;
  }

  function keyChipsHtml(keys, which) {
    if (!keys.length) return '';
    var h = '<div class="b-keys">';
    for (var i = 0; i < keys.length; i++) {
      var e = ent(keys[i]);
      if (!e) continue;
      var gk = keys[i].slice(0, keys[i].indexOf(':'));
      h += '<span class="b-key">' + iconHtml(e, gk, 28) +
        '<span class="b-key-n">' + esc(nameOf(e, gk)) + '</span>' +
        '<button class="b-key-x" data-bdrop="' + esc(which) + '" data-bkey="' + esc(keys[i]) + '" aria-label="Remove ' + esc(nameOf(e, gk)) + '">&#10005;</button></span>';
    }
    h += '</div>';
    return h;
  }

  /* ------------------------------------------------------- generate bar */

  function generateBarHtml() {
    var eng = engine();
    var faults = engineFaults();
    var h = '<div class="b-gen">';
    if (!eng) {
      h += '<button class="b-go off" disabled>Generate a loadout</button>';
      h += '<p class="b-gen-why">The scoring generator is not installed on this build yet, so there is nothing to run your brief through. ' +
        'Everything you set above is saved and will be used the moment it lands. This tab will not make up a loadout to fill the gap.</p>';
    } else {
      var sig = signature(currentInput());
      var stale = LAST && LAST_SIG !== sig;
      h += '<button class="b-go" data-bgo>' + (BUSY ? 'Working...' : (LAST ? 'Generate again' : 'Generate a loadout')) + '</button>';
      if (stale) h += '<p class="b-stale">Your brief changed since the loadout below was made. Generate again to match it.</p>';
      if (eng.basis && eng.basis.label) {
        h += '<p class="b-gen-why">Scored against ' + esc(eng.basis.label) + ' ' + nBadge(eng.basis.n, eng.basis.nUnit, true) +
          (eng.basis.pulledAt ? ', sampled ' + esc(prettyDate(eng.basis.pulledAt)) : '') + '.</p>';
      } else {
        h += '<p class="b-gen-why">This generator has no match-outcome sample behind it, so it will give you reasons rather than percentages.</p>';
      }
    }
    for (var i = 0; i < faults.length; i++) h += '<p class="b-fault">Generator contract: ' + esc(faults[i]) + '.</p>';
    h += '</div>';
    return h;
  }

  /* Sample size as a VISIBLE badge. Never a tooltip, never a title attribute. */
  function nBadge(n, unit, inline) {
    if (!isFinite(n) || n < 1) return '';
    var txt = 'n = ' + Number(n).toLocaleString('en-US') + (unit ? ' ' + unit : '');
    return '<span class="b-n' + (inline ? ' inline' : '') + '">' + esc(txt) + '</span>';
  }

  /* ---------------------------------------------------------- the result */

  function resultHtml() {
    if (ERR) {
      return '<div class="b-block b-err"><div class="b-lab">No loadout</div><p class="b-help">' + esc(ERR) + '</p></div>';
    }
    if (BUSY) return '<div class="b-block"><div class="b-empty">Working through the numbers...</div></div>';
    if (!LAST) return '';

    var r = LAST;
    var t = r.totals;
    var budget = briefBudget();
    var h = '<div class="b-res">';
    h += '<h3 class="sh">In the order you buy it</h3>';

    h += '<div class="card tight"><div class="fresh">' +
      '<span>Total cost <b>' + esc(money(t.cost)) + '</b></span><span class="faint">&middot;</span>' +
      '<span>Carried weight <b>' + esc(t.weight) + ' kg</b></span>' +
      (budget !== null ? '<span class="faint">&middot;</span><span>' + (t.cost <= budget ? 'Left over <b>' + esc(money(budget - t.cost)) + '</b>' : '<b class="b-over">' + esc(money(t.cost - budget)) + ' over budget</b>') + '</span>' : '') +
      '</div>' +
      '<p class="small faint" style="margin:6px 0 0">Summed here from the prices and weights in this dataset, so these totals match the same figures on the Weapons and Items tabs. ' +
      esc(t.priced) + ' of ' + esc(t.of) + ' picks publish a price and ' + esc(t.weighed) + ' publish a weight.</p></div>';

    for (var i = 0; i < r.picks.length; i++) h += pickHtml(r.picks[i], i + 1);

    if (r.unfilled.length) {
      h += '<h3 class="sh">Left empty</h3>';
      for (var u = 0; u < r.unfilled.length; u++) {
        h += '<div class="b-unfilled"><b>' + esc(r.unfilled[u].slot) + '</b>' +
          (r.unfilled[u].reason ? '<span> - ' + esc(r.unfilled[u].reason) + '</span>' : '') + '</div>';
      }
    }
    if (r.notes.length) {
      h += '<h3 class="sh">Worth knowing</h3>';
      for (var n = 0; n < r.notes.length; n++) h += '<p class="b-note">' + esc(r.notes[n]) + '</p>';
    }
    if (VIOL.length) {
      h += '<h3 class="sh">Dropped before it reached you</h3>';
      for (var v = 0; v < VIOL.length; v++) h += '<p class="b-viol">' + esc(VIOL[v]) + '</p>';
    }

    h += '<p class="b-ruling-foot">' + esc(RULING) + '</p>';
    h += '</div>';
    return h;
  }

  function pickHtml(p, ord) {
    var nm = nameOf(p.e, p.gk);
    var h = '<div class="b-pick">';
    h += '<button class="b-pick-top" data-ent="' + esc(p.key) + '">';
    h += '<span class="b-ord">' + esc(ord) + '</span>';
    h += iconHtml(p.e, p.gk, 44);
    h += '<span class="b-pick-b"><span class="b-pick-n">' + esc(nm) + '</span>' +
      '<span class="b-pick-m">' + esc(p.slot || groupTitle(p.gk)) + (p.e.category ? ' &middot; ' + esc(p.e.category) : '') + '</span></span>';
    h += '<span class="b-pick-c">' + costChips(p.e) + '</span>';
    h += '</button>';

    if (p.receipts.length) {
      h += '<ul class="b-rcts">';
      for (var i = 0; i < p.receipts.length; i++) {
        var r = p.receipts[i];
        h += '<li class="b-rct k-' + esc(r.kind) + '">' +
          '<span class="b-rct-t">' + esc(r.text) + '</span>' +
          nBadge(r.n, r.nUnit, false) +
          (r.source ? '<span class="b-rct-s">' + esc(r.source) + '</span>' : '') +
          '</li>';
      }
      h += '</ul>';
    } else {
      h += '<p class="b-rct-none">The generator gave no reason for this pick.</p>';
    }

    if (p.lock) {
      h += '<div class="b-lock"><span class="b-lock-tag">Locked by you</span>' +
        '<span class="b-lock-t">' + esc(p.lock.text) + '</span>' +
        nBadge(p.lock.n, p.lock.nUnit, false) +
        (p.lock.runnerUp ? ' <button class="lchip" data-ent="' + esc(p.lock.runnerUp) + '">' + esc(nameOf(ent(p.lock.runnerUp), p.lock.runnerUp.slice(0, p.lock.runnerUp.indexOf(':')))) + '</button>' : '') +
        '</div>';
    }
    h += '</div>';
    return h;
  }

  /* ------------------------------------------------------- pins, profile */

  function pinsHtml() {
    var pins = prof().pins;
    var h = '<h3 class="sh">Pinned (' + pins.length + ')</h3>';
    if (!pins.length) {
      return h + '<div class="card muted small">Nothing pinned yet. Open any weapon, attachment or vehicle and tap Pin to park it here, then lock the pinned set into the brief above.</div>';
    }
    var cost = 0, weight = 0;
    for (var i = 0; i < pins.length; i++) {
      var e = ent(pins[i]);
      if (!e) continue;
      if (typeof e.price === 'number') cost += e.price;
      if (typeof e.weightKg === 'number') weight += e.weightKg;
    }
    h += '<div class="card tight"><div class="fresh"><span>Total cost <b>' + esc(money(cost)) +
      '</b></span><span class="faint">&middot;</span><span>Carried weight <b>' +
      esc(Math.round(weight * 100) / 100) + ' kg</b></span></div>' +
      '<p class="small faint" style="margin:6px 0 0">Summed from the pinned entries that publish a price or a weight. Entries the source never priced are not counted.</p></div>';
    for (var j = 0; j < pins.length; j++) {
      var pe = ent(pins[j]);
      if (!pe) continue;
      var gk = pins[j].slice(0, pins[j].indexOf(':'));
      h += '<button class="rowcard" data-ent="' + esc(pins[j]) + '">' + iconHtml(pe, gk, 44) +
        '<span class="rb"><span class="rn">' + esc(nameOf(pe, gk)) + '</span>' +
        '<span class="rm">' + esc(groupTitle(gk)) + (pe.category ? ' &middot; ' + esc(pe.category) : '') + '</span></span>' +
        '<span class="rc">' + costChips(pe) + '</span></button>';
    }
    return h;
  }

  function profileHtml() {
    var h = '<h3 class="sh">Loadout slot</h3><div class="card">';
    h += '<div class="lvlctl"><label for="prof" class="small muted">Saving to</label>' +
      '<select id="prof" class="profsel">';
    var ids = Object.keys(ST.profiles);
    for (var i = 0; i < ids.length; i++) {
      h += '<option value="' + esc(ids[i]) + '"' + (ids[i] === ST.active ? ' selected' : '') + '>' + esc(ST.profiles[ids[i]].name) + '</option>';
    }
    h += '</select>' +
      '<button class="tbtn" data-newprof>New</button>' +
      '<button class="tbtn" data-renprof>Rename</button>' +
      (ids.length > 1 ? '<button class="tbtn danger" data-delprof>Delete</button>' : '') +
      '</div>';
    h += '<p class="small faint" style="margin:8px 0 0">Your brief, your pins and your unlock ticks are saved per slot, on this device only.</p>';
    h += '</div>';
    return h;
  }

  /* -------------------------------------------------------- picker sheet */

  /* Reuses the app's ONE bottom sheet, which already lives inside the mounted
     app tree - a sheet appended to document.body would sit outside the shell's
     scoped stylesheet and render unstyled on the island route. */
  function openPicker(kind) {
    var sh = document.querySelector('#sheet');
    var body = document.querySelector('#sheetBody');
    if (!sh || !body) return;
    PICKER = { kind: kind, q: '' };
    body.innerHTML = pickerHtml();
    body.scrollTop = 0;
    sh.hidden = false;
    sheetOpen = true;
    try { document.body.style.overflow = 'hidden'; } catch (e) { /* no-op */ }
  }

  function pickerBodyRefresh() {
    var box = document.querySelector('#bPickList');
    if (box) box.innerHTML = pickerRowsHtml();
    var cnt = document.querySelector('#bPickCount');
    if (cnt) cnt.textContent = pickerCountText();
  }

  function pickerTitle() {
    if (!PICKER) return '';
    if (PICKER.kind === 'weapon') return 'Choose a primary weapon';
    if (PICKER.kind === 'enemy') return 'What are you up against?';
    return 'Lock something in';
  }

  function pickerCountText() {
    if (!PICKER || PICKER.kind === 'weapon') return '';
    var sel = briefKeys(PICKER.kind);
    return sel.length + ' selected';
  }

  function pickerHtml() {
    var h = '<button class="sheet-close" data-close>Close</button><div class="sheet-grab"></div>';
    h += '<h3>' + esc(pickerTitle()) + '</h3>';
    h += '<div class="ssub" id="bPickCount">' + esc(pickerCountText()) + '</div>';
    h += '<div class="search-wrap"><span class="search-ic">&#128269;</span>' +
      '<input id="bq" class="search" type="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Filter this list" value="' + esc(PICKER.q) + '" /></div>';
    h += '<div id="bPickList">' + pickerRowsHtml() + '</div>';
    return h;
  }

  function pickerGroups() {
    if (!PICKER) return [];
    if (PICKER.kind === 'weapon') return ['weapons'];
    if (PICKER.kind === 'enemy') return enemyGroups();
    return lockableGroups();
  }

  function pickerRowsHtml() {
    if (!PICKER) return '';
    var q = String(PICKER.q || '').toLowerCase().trim();
    var lvl = myLevel();
    var sel = PICKER.kind === 'weapon' ? [] : briefKeys(PICKER.kind);
    var gs = pickerGroups();
    var h = '';
    var shown = 0;
    var head = '';
    for (var g = 0; g < gs.length; g++) {
      var gk = gs[g];
      var rows = S.groups[gk] || [];
      for (var i = 0; i < rows.length; i++) {
        var e = rows[i];
        var nm = nameOf(e, gk);
        if (q && (nm + ' ' + (e.category || '') + ' ' + (e.summary || '')).toLowerCase().indexOf(q) === -1) continue;
        /* Never offer something the account cannot have. A class-gated entry
           carries a string, not a number, and is left visible because the data
           does not support that comparison. */
        if (PICKER.kind !== 'enemy' && gatedAbove(e, lvl)) continue;
        if (shown >= 60) { h += '<p class="b-help">More matches than fit here. Type to narrow it.</p>'; g = gs.length; break; }
        var k = keyOf(gk, e.id);
        var title = groupTitle(gk);
        if (title !== head) { head = title; h += '<h3 class="sh">' + esc(title) + '</h3>'; }
        var on = sel.indexOf(k) !== -1;
        h += '<button class="rowcard b-pickrow' + (on ? ' on' : '') + '" data-bpick="' + esc(k) + '">' +
          iconHtml(e, gk, 44) +
          '<span class="rb"><span class="rn">' + esc(nm) + '</span>' +
          '<span class="rm">' + esc(e.summary || '') + '</span></span>' +
          '<span class="rc">' + costChips(e) + (on ? '<span class="chip on">Chosen</span>' : '') + '</span></button>';
        shown++;
      }
    }
    if (!shown) h = '<div class="card muted small">Nothing here matches that, or everything that does is above your WARDOG level.</div>';
    return h;
  }

  function closePicker() {
    PICKER = null;
    if (typeof closeSheet === 'function') closeSheet();
  }

  /* ------------------------------------------------------------ actions */

  function runGenerate() {
    var eng = engine();
    if (!eng || BUSY) return;
    var inp = currentInput();
    BUSY = true; ERR = null;
    repaint();
    var res;
    try { res = eng.generate(inp); }
    catch (err) { BUSY = false; LAST = null; ERR = 'The generator failed while building that: ' + (err && err.message ? err.message : String(err)); repaint(); return; }
    if (res && typeof res.then === 'function') {
      res.then(function (r) { finish(r, inp); }, function (err) {
        BUSY = false; LAST = null;
        ERR = 'The generator failed while building that: ' + (err && err.message ? err.message : String(err));
        repaint();
      });
    } else {
      finish(res, inp);
    }
  }

  function finish(res, inp) {
    BUSY = false;
    LAST = sanitise(res);
    LAST_SIG = LAST ? signature(inp) : null;
    repaint();
    try {
      var el = document.querySelector('.b-res');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    } catch (e) { /* no-op */ }
  }

  /* app.js's render() repaints #app. This function must never be named
     `render` itself - a local of that name would shadow the global one and this
     tab would silently stop repainting. */
  function repaint() { if (typeof render === 'function' && S.view === 'builds') render(); }

  function toggleInList(which, key) {
    var list = briefKeys(which);
    var i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1); else list.push(key);
    bset(which, list);
  }

  /* ------------------------------------------------------------- events */

  /* app.js's own document click listener was registered first and returns
     without stopping propagation, so both run. Every selector below is unique
     to this file - nothing here shadows data-ent, data-goto or data-igroup. */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;

    if (PICKER) {
      var pick = t.closest('[data-bpick]');
      if (pick) {
        var k = pick.getAttribute('data-bpick');
        if (PICKER.kind === 'weapon') { bset('weapon', k); closePicker(); repaint(); }
        else { toggleInList(PICKER.kind, k); pickerBodyRefresh(); }
        return;
      }
      /* The app's own close button and backdrop hid the sheet; this puts the
         chosen values back on screen. */
      if (t.closest('[data-close]')) { PICKER = null; repaint(); return; }
    }

    var open = t.closest('[data-bpicker]');
    if (open) { openPicker(open.getAttribute('data-bpicker')); return; }

    var clr = t.closest('[data-bclear]');
    if (clr) {
      var what = clr.getAttribute('data-bclear');
      if (what === 'weapon') { bset('weapon', null); openPicker('weapon'); }
      else { bset(what, []); repaint(); }
      return;
    }

    var drop = t.closest('[data-bdrop]');
    if (drop) { toggleInList(drop.getAttribute('data-bdrop'), drop.getAttribute('data-bkey')); repaint(); return; }

    var goal = t.closest('[data-bgoal]');
    if (goal) {
      if (goal.disabled) return;
      var id = goal.getAttribute('data-bgoal');
      var cur = briefGoals();
      var gi = cur.indexOf(id);
      if (gi >= 0) cur.splice(gi, 1);
      else if (cur.length < MAX_GOALS) cur.push(id);
      bset('goals', cur);
      repaint();
      return;
    }

    if (t.closest('[data-block-pins]')) {
      var locks = briefKeys('locks');
      var pins = prof().pins;
      for (var i = 0; i < pins.length; i++) if (ent(pins[i]) && locks.indexOf(pins[i]) === -1) locks.push(pins[i]);
      bset('locks', locks);
      repaint();
      return;
    }

    var ph = t.closest('[data-bphase]');
    if (ph) {
      var pid = ph.getAttribute('data-bphase');
      bset('phase', briefPhase() === pid ? null : pid);
      var phs = enginePhases();
      for (var p = 0; p < phs.length; p++) if (phs[p].id === pid && typeof phs[p].budget === 'number') bset('budget', phs[p].budget);
      repaint();
      return;
    }

    var bb = t.closest('[data-bbudget]');
    if (bb) {
      var raw = bb.getAttribute('data-bbudget');
      bset('budget', raw === '' ? null : parseInt(raw, 10));
      repaint();
      return;
    }

    if (t.closest('[data-bgo]')) { runGenerate(); return; }
  });

  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (!t) return;
    if (t.id === 'bq' && PICKER) { PICKER.q = t.value || ''; pickerBodyRefresh(); return; }
    if (t.id === 'bBudget' && S.view === 'builds') {
      var v = t.value;
      var n = parseInt(v, 10);
      bset('budget', (v === '' || !isFinite(n) || n < 0) ? null : n);
      return;
    }
  });

  /* Level is committed on blur, not per keystroke: re-rendering the view on
     every digit would take the focus out of the field mid-number. */
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t) return;
    if ((t.id === 'lvl' || t.id === 'bBudget') && S.view === 'builds') repaint();
  });

  /* ---------------------------------------------------------- public api */

  window.WD_BUILDS = {
    render: viewHtml,
    /* Exposed so a verifier can assert the contract without a live engine. */
    contract: {
      maxGoals: MAX_GOALS,
      ruling: RULING,
      receiptKinds: ['data', 'rule', 'goal', 'counter', 'lock', 'note'],
      dataReceiptNeedsSample: true,
      totalsRecomputedFromData: true,
      unknownKeysDropped: true
    },
    /* Test seam: hand it an engine result and get back exactly what the tab
       would render, plus the violations it would print. No side effects. */
    dryRun: function (res) {
      var keepV = VIOL, keepE = ERR;
      var out = sanitise(res);
      var v = VIOL, e = ERR;
      VIOL = keepV; ERR = keepE;
      return { result: out, violations: v, error: e };
    }
  };
})();
