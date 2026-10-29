/* builds.js - the Builds-tab SURFACE of the Deadlock Companion (L2, NEW-GAME-TEMPLATE section 9).
 *
 * OWNER: the P4 "ui" lane. FILE FENCE: this file + css/builds.css. The SCORING lives in
 * js/generator.js (the P4 "engine" lane, window.DL_ENGINE). This file never scores, ranks or invents
 * a number: it collects the inputs, hands them to the engine, and prints what comes back in purchase
 * order with LOCAL icons and the receipts under every item, each sample size printed in the open
 * (never behind a tooltip).
 *
 * Reads ONLY data/*.json: heroes/items/rules/meta through window.DL_APP.S (loaded by the shell),
 * analytics.json through DL_APP.loadAnalytics() (the shared memoised fetch) and data/generator.json
 * (the engine configuration build_data.mjs resolves). Every number printed here is one of: an item
 * cost from items.json, a step from rules.json, a count of picks, or text/fields the engine returned.
 * tools/validate.mjs group BUILDS-TAB fails the build if a numeric literal of 100 or more appears in
 * this file, and asserts that every number shown here equals the same number on the other tabs.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW IT PLUGS IN
 * ---------------------------------------------------------------------------------------------
 * js/app.js renders the Builds tab as search + freshness/patch stamp + ruling + TOOL BODY, and the
 * TOOL BODY is window.DL_BUILDS.render() when one is registered. window.DL_BUILDS below is a GETTER
 * that answers only while window.DL_ENGINE.create exists, so a missing or crashed engine script
 * leaves the shell's own starter-build viewer in place instead of a planner that cannot run, and
 * the load order between generator.js and this file does not matter.
 *
 * THE ENGINE CONTRACT consumed (js/generator.js, read 2026-10-24):
 *   DL_ENGINE.create({heroes, items, rules, analytics, generator, meta}) -> engine
 *   engine.sanitize(inputs) -> {hero, goals, enemies, locks, phase, budget, extraSlots}
 *   engine.generate(inputs) -> {ok, errors[], inputs, budget{value,text}, slots{base,extra,total,used},
 *       spent, left, actives{used,cap}, invest[{slot,spend,next{at}}], matchups[{enemy,text}],
 *       threats[{label}], ruleNote, build[{item, locked, order, alt{item}, receipts[{kind,text,matches}]}]}
 *   engine.budgetFor(hero, inputs) -> {value, text} | null
 *   engine.goals[{id,label,help}]  engine.phases[{id,label,help,extraSlots}]
 *   engine.limits{maxGoals,maxEnemies,maxLocks}  engine.slots{base,extraMax,maxActive}
 *   engine.legalItems() -> [itemId]
 * RECEIPT RULE (template section 9): a receipt that states a percentage measured over matches must
 * carry its sample size (a numeric `matches`, or "N matches" / "N item purchases" in its text). One
 * that does not is NOT printed; the item says how many reasons were held back and why. Receipts of
 * the kinds goal / component / investment / lock quote item stats and shop rules from items.json and
 * rules.json (no sample exists for those), and validate.mjs BUILDS-TAB asserts each of those numbers
 * against the item record.
 *
 * STATE: the inputs live in the active profile's override layer (DL_APP.ovSet('builds', 'inputs'))
 * inside the one localStorage blob deadlock_companion_v1. No second key, no element ids: every
 * lookup is a data-db-* attribute inside the root the shell hands over. The result is not stored:
 * the engine is deterministic, so the same inputs rebuild it.
 */
(function () {
  'use strict';

  var STEPS = [
    { id: 'hero', label: 'Hero' },
    { id: 'goals', label: 'Goals' },
    { id: 'enemies', label: 'Enemies' },
    { id: 'locks', label: 'Locks' },
    { id: 'phase', label: 'When' }
  ];
  var SLOT_ORDER = ['weapon', 'vitality', 'spirit'];
  var SLOT_LABEL = { weapon: 'Weapon', vitality: 'Vitality', spirit: 'Spirit' };

  /* ------------------------------------------------------------------ helpers */

  function A() { return window.DL_APP || null; }
  function api() {
    var e = window.DL_ENGINE;
    return e && typeof e.create === 'function' ? e : null;
  }
  function esc(s) { return A().esc(s); }
  function num(n) { return A().num(n); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function S() { return A().S; }
  function heroes() { return (S().groups.heroes || []).slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); }); }
  function hero(id) { return id ? A().ent('heroes:' + id) : null; }
  function item(id) { return id ? A().ent('items:' + id) : null; }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function plural(n, one, many) { return num(n) + ' ' + (n === 1 ? one : many); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  /* ------------------------------------------------------------------ engine load */

  var ENG = null;        // engine instance
  var LOADING = null;    // Promise while analytics.json + generator.json load
  var LOAD_ERR = null;

  /* data/generator.json, fetched once and shared by the engine start-up and the offline prefetch below. A failed
     fetch is forgotten so the next caller tries again (the first try may have been made offline). */
  var GEN_P = null;
  function loadGenerator() {
    if (!GEN_P) {
      GEN_P = fetch('/island/apps/deadlock/data/generator.json', { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('data/generator.json -> HTTP ' + r.status);
        return r.json();
      }).catch(function (err) { GEN_P = null; throw err; });
    }
    return GEN_P;
  }

  function ensureEngine() {
    if (ENG || LOADING || LOAD_ERR || !api()) return LOADING;
    LOADING = Promise.all([A().loadAnalytics(), loadGenerator()]).then(function (res) {
      var s = S();
      ENG = api().create({ heroes: s.groups.heroes || [], items: s.groups.items || [], rules: s.rules || {}, analytics: res[0], generator: res[1], meta: s.meta || {} });
      LOADING = null;
    }).catch(function (err) {
      LOAD_ERR = err && err.message ? err.message : String(err);
      LOADING = null;
    });
    return LOADING;
  }

  /* Budget stepper: the step is the cheapest shop tier and the ceiling is every slot the engine allows
     filled at the dearest normal tier - both from the data, nothing typed here. */
  function tierPrices() {
    var its = S().groups.items || [];
    var t = ((S().rules || {}).itemPriceByTier || []).filter(function (x, i) {
      return isNum(x) && x > 0 && its.some(function (it) { return it.tier === i && !it.streetBrawl; });
    });
    return t.sort(function (a, b) { return a - b; });
  }
  function budgetStep() { var t = tierPrices(); return t.length ? t[0] : null; }
  function budgetMax() {
    var t = tierPrices();
    var sl = ENG && ENG.slots;
    return t.length && sl && isNum(sl.base) && isNum(sl.extraMax) ? t[t.length - 1] * (sl.base + sl.extraMax) : null;
  }

  /* ------------------------------------------------------------------ state */

  var INP = null;        // engine-sanitised inputs
  var EXAMPLE = false;   // true while the shown hero/phase are the engine's defaults, not the user's choice
  var OWNER = null;     // the profile object INP was read from (a profile switch reloads it)
  var UI = { open: false, step: 'hero', heroQ: '', itemQ: '', itemSlot: 'all', running: false, result: null, resultKey: null, error: null, view: null };
  var ROOT = null;
  var SEQ = 0;

  function loadInputs() {
    var p = A().prof();
    if (INP && OWNER === p) return INP;
    OWNER = p;
    var raw = A().ovGet(p, 'builds', 'inputs', null);
    var seed = raw && typeof raw === 'object' ? copy(raw) : {};
    if (!hero(seed.hero) && A().myHero()) seed.hero = A().myHero();
    INP = seed;
    // Example state: nothing saved and no hero chosen, so the engine's own default hero is shown as an example.
    EXAMPLE = !hero(seed.hero) && !seed.phase;
    UI.result = null; UI.resultKey = null; UI.error = null; UI.view = null;
    if (ENG) INP = ENG.sanitize(INP);
    return INP;
  }

  function setInputs(fn) {
    fn(INP);
    if (ENG) INP = ENG.sanitize(INP);
    var save = copy(INP);
    if (EXAMPLE) { delete save.hero; delete save.phase; }   // keep the example state across reloads
    A().ovSet('builds', 'inputs', save);
  }

  function keyOf(p) { return JSON.stringify([p.hero, p.goals, p.enemies, p.locks, p.phase, p.budget, p.extraSlots]); }
  function has(list, x) { return (list || []).indexOf(x) !== -1; }

  /* ---------------------------------------------------------- receipts */

  var PCT_RX = /\d\s*%/;
  var SAMPLE_RX = /([\d,]{2,}\s+(matches|games|item purchases|purchases)\b|\bof\s+[\d,]{3,}\))/i;

  /* Receipt kinds whose numbers are item stats or shop rules straight from items.json / rules.json
     (the same figures the Items tab and More show), not rates measured over matches. */
  var DATA_KINDS = { goal: 1, component: 1, investment: 1, lock: 1 };

  function receiptAllowed(r) {
    if (DATA_KINDS[r.kind]) return true;
    if (!PCT_RX.test(r.text)) return true;
    return isNum(r.matches) || SAMPLE_RX.test(r.text);
  }

  function viewOf(res) {
    var rows = [];
    var unresolved = 0;
    for (var i = 0; i < (res.build || []).length; i++) {
      var b = res.build[i];
      var it = item(b.item);
      if (!it) { unresolved++; continue; }
      var shown = [], held = 0;
      for (var j = 0; j < (b.receipts || []).length; j++) {
        var r = b.receipts[j];
        if (!r || typeof r.text !== 'string' || !r.text.trim()) continue;
        if (r.kind === 'lock') continue;   // the Locked chip already says it
        if (receiptAllowed(r)) shown.push(r); else held++;
      }
      rows.push({ b: b, it: it, receipts: shown, held: held });
    }
    return { rows: rows, unresolved: unresolved };
  }

  /* ------------------------------------------------------------------ engine run */

  function run() {
    if (!ENG || !INP || !hero(INP.hero) || UI.running) return;
    var seq = ++SEQ;
    var key = keyOf(INP);
    var inputs = copy(INP);
    UI.running = true; UI.error = null;
    paint();
    setTimeout(function () {
      var res = null, err = null;
      try { res = ENG.generate(inputs); } catch (e) { err = e && e.message ? e.message : String(e); }
      if (seq !== SEQ) return;
      UI.running = false;
      if (err) { UI.error = err; UI.result = null; UI.resultKey = null; UI.view = null; }
      else { UI.result = res; UI.resultKey = key; UI.view = viewOf(res); }
      paint();
    }, 0);
  }

  function goRun() {
    UI.open = false;
    run();
    var r = ROOT && ROOT.querySelector('[data-db-result]');
    if (r && r.scrollIntoView) { try { r.scrollIntoView({ block: 'start' }); } catch (e) { /* no-op */ } }
  }

  /* ------------------------------------------------------------------ html: planner card */

  function phaseOf(id) { return ENG ? ENG.phases.filter(function (x) { return x.id === id; })[0] || null : null; }
  function goalOf(id) { return ENG ? ENG.goals.filter(function (x) { return x.id === id; })[0] || null : null; }

  function whenLabel() {
    var ph = phaseOf(INP.phase);
    var s = INP.phase === 'custom' ? (isNum(INP.budget) ? num(INP.budget) + ' souls to spend' : 'Your own budget (not set)') : ph ? ph.label : 'Pick when';
    if (ENG && isNum(INP.extraSlots) && INP.extraSlots > 0) s += ', ' + plural(INP.extraSlots, 'extra slot', 'extra slots');
    return s;
  }

  function miniIcons(list, group, emptyText) {
    if (!list || !list.length) return '<span class="dbp-v faint">' + esc(emptyText) + '</span>';
    var h = '<span class="dbp-icons">';
    for (var i = 0; i < list.length; i++) {
      var e = A().ent(group + ':' + list[i]);
      if (e) h += '<span class="dbp-mini" title="' + esc(e.name) + '">' + A().iconHtml(e, 28) + '</span>';
    }
    return h + '<span class="dbp-count">' + esc(String(list.length)) + '</span></span>';
  }

  function row(step, key, valueHtml, icon) {
    return '<button class="dbp-row" data-db-open="' + step + '">' + (icon || '') + '<span class="dbp-t"><span class="dbp-k">' + esc(key) + '</span>' +
      valueHtml + '</span><span class="dbp-chev">Change</span></button>';
  }

  function cardHtml() {
    var h = '<div class="card dbp" data-db-card>';
    h += '<div class="dbp-h"><b>Build planner</b><span class="faint small">Tap a line to change it</span></div>';
    if (LOAD_ERR) return h + '<div class="note warn">The build engine could not load its data (' + esc(LOAD_ERR) + '). If you are offline, reconnect once and reload: the data is saved for offline use in the background.</div></div>';
    if (!ENG) return h + '<div class="dbp-wait muted small">Loading the match numbers for the build engine...</div></div>';
    var hh = hero(INP.hero);
    var gnames = INP.goals.map(function (g) { var x = goalOf(g); return x ? x.label : g; });
    h += row('hero', 'Hero', '<span class="dbp-v">' + esc(hh ? (EXAMPLE ? 'Example: ' : '') + hh.name : 'Pick a hero') + '</span>', hh ? A().iconHtml(hh, 44) : '<span class="dbp-ph">?</span>');
    h += row('goals', 'Goals (up to ' + ENG.limits.maxGoals + ')', '<span class="dbp-v">' + (gnames.length ? esc(gnames.join(', ')) : '<span class="faint">None - match numbers only</span>') + '</span>');
    h += row('enemies', 'Enemy heroes (optional)', miniIcons(INP.enemies, 'heroes', 'Not set'));
    h += row('locks', 'Items you want for sure (optional)', miniIcons(INP.locks, 'items', 'None locked'));
    h += row('phase', 'When in the match', '<span class="dbp-v">' + esc(whenLabel()) + '</span>');
    h += '<button class="dbp-go" data-db-go' + (UI.running ? ' disabled' : '') + '>' + (UI.running ? 'Working...' : 'Make my build') + '</button>';
    return h + '</div>';
  }

  /* ------------------------------------------------------------------ html: result */

  function patchLine() {
    var m = S().meta || {};
    var p = m.patch || (m.analytics && m.analytics.window && m.analytics.window.patch) || {};
    var bits = [];
    if (p.title) bits.push('patch ' + p.title);
    if (m.pulledAt) bits.push('pulled ' + A().prettyDate(m.pulledAt));
    return bits.length ? 'Match numbers from ' + bits.join(', ') + '.' : '';
  }

  function receiptHtml(r) {
    var h = '<li class="k-' + esc(r.kind || 'note') + '">' + esc(r.text);
    if (isNum(r.matches) && r.text.indexOf(num(r.matches)) === -1) h += ' <span class="dbr-n">' + esc(plural(r.matches, 'match', 'matches')) + '</span>';
    return h + '</li>';
  }

  /* Investment steps in souls only: the bonus values carry no unit the sources state. */
  function investLine(x) {
    var s = num(x.spend) + ' souls';
    var cb = ((S().rules || {}).costBonuses || {})[x.slot] || [];
    var reached = null;
    for (var i = 0; i < cb.length; i++) if (cb[i] && isNum(cb[i].gold_threshold) && cb[i].gold_threshold <= x.spend) reached = cb[i].gold_threshold;
    s += reached != null ? ', past the ' + num(reached) + ' step' : ', below the first step';
    if (x.next && isNum(x.next.at)) s += '; next step at ' + num(x.next.at);
    return s + '.';
  }

  var HOW_HTML = '<details class="card dbr-how"><summary>How the engine decides</summary>' +
    '<p>It looks at every shop item a normal match sells (Street Brawl items are left out) and gives each one a score for this hero:</p><ul>' +
    '<li>What players of this hero did with it: how often they bought it, and how those matches went compared with the other items of the same price. Small samples count for less, and a rate with too few matches behind it is never printed.</li>' +
    '<li>How well its stats fit your goals.</li>' +
    '<li>Whether it answers what the enemy heroes you picked lean on.</li>' +
    '<li>Whether players of this hero usually buy it later than this budget.</li></ul>' +
    '<p>Then it works out how many items of each price fit your souls and slots, fills that mix with the best-scoring items, and keeps trying one-for-one swaps until none helps. It counts the investment bonus for each item type, keeps items with a button under the cap and never puts an item in the same build as its own component.</p>' +
    '<p>Same choices, same build, every time: nothing in it is random. Nothing here is checked in game.</p></details>';

  function resultHtml() {
    var h = '<section class="dbr" data-db-result>';
    if (!ENG || !INP || !hero(INP.hero)) return h + '</section>';
    if (UI.running && !UI.result) return h + '<div class="card muted">Working out a build...</div></section>';
    if (UI.error) {
      return h + '<div class="card"><b>No build this time.</b><p class="small muted" style="margin:6px 0 0">The engine stopped with: ' + esc(UI.error) +
        '</p><div class="actrow"><button class="tbtn" data-db-go>Try again</button></div></div></section>';
    }
    var R = UI.result, V = UI.view;
    if (!R || !V) return h + '</section>';
    var hh = hero(R.hero || INP.hero);
    h += '<h3 class="sh">Your build</h3>';
    if (!R.ok) {
      return h + '<div class="note warn">' + (R.errors && R.errors.length ? R.errors : ['The engine could not make a build for these choices.']).map(esc).join('<br />') + '</div>' +
        '<div class="actrow"><button class="tbtn" data-db-open="phase">Change when in the match</button></div></section>';
    }
    var cost = 0;
    for (var i = 0; i < V.rows.length; i++) if (isNum(V.rows[i].it.cost) && !V.rows[i].it.streetBrawl) cost += V.rows[i].it.cost;
    var ph = phaseOf(R.inputs && R.inputs.phase);
    h += '<div class="card dbr-head">' + (hh ? A().iconHtml(hh, 44) : '') + '<div class="dbr-ht"><b>' + (EXAMPLE ? esc('Example build: ' + (hh ? hh.name : '') + (ph ? ', ' + ph.label.toLowerCase() : '') + ' - pick your hero') : esc(hh ? hh.name : '') + (ph ? ' - ' + esc(ph.label) : '')) + '</b>' +
      '<span class="small muted">' + esc(plural(V.rows.length, 'item', 'items')) + ', ' + esc(num(cost)) + ' souls' +
      (R.budget && isNum(R.budget.value) ? ' of ' + esc(num(R.budget.value)) : '') + '</span>' +
      (patchLine() ? '<span class="small faint">' + esc(patchLine()) + '</span>' : '') + '</div></div>';
    h += '<p class="dbr-rule">This is the best build the app found in real match numbers, not a proof that nothing better exists.</p>';
    if (UI.resultKey !== keyOf(INP)) h += '<div class="note warn">You changed the planner after this build was made. <button class="gl" data-db-go>Make it again</button></div>';
    if (R.budget && R.budget.text) h += '<p class="small muted dbr-bud"><b>Budget:</b> ' + esc(R.budget.text) + '</p>';
    if (!V.rows.length) {
      h += '<div class="card muted">Nothing in the shop fits this budget.</div>';
    } else {
      h += '<p class="small faint dbr-order">In the order to buy them. Tap an item for what it does.</p><ol class="dbr-list">';
      for (var k = 0; k < V.rows.length; k++) {
        var rw = V.rows[k], b = rw.b, it = rw.it;
        h += '<li class="dbr-item slot-' + esc(it.slot) + '">';
        h += '<button class="dbr-top" data-ent="items:' + esc(it.id) + '"><span class="dbr-num">' + esc(String(k + 1)) + '</span>' + A().iconHtml(it, 44) +
          '<span class="dbr-nm"><span class="dbr-name">' + esc(it.name) + '</span><span class="dbr-chips">' +
          '<span class="chip t-' + esc(it.slot) + '">' + esc(SLOT_LABEL[it.slot] || it.slot) + '</span>' +
          (isNum(it.cost) && !it.streetBrawl ? '<span class="chip cost">' + esc(num(it.cost)) + ' souls</span>' : '') +
          (b.locked ? '<span class="chip hero">Locked by you</span>' : '') +
          (it.isActive ? '<span class="chip">Has a button</span>' : '') + '</span></span></button>';
        if (rw.receipts.length) h += '<ul class="dbr-rc">' + rw.receipts.map(receiptHtml).join('') + '</ul>';
        else if (!rw.held) h += '<p class="dbr-none">No reason came back for this pick.</p>';
        if (rw.held) h += '<p class="dbr-none">' + esc(plural(rw.held, 'reason was', 'reasons were')) + ' left out because ' + (rw.held === 1 ? 'it gave' : 'they gave') + ' a number with no match count behind it.</p>';
        var alt = b.alt && item(b.alt.item);
        h += '<div class="dbr-foot">' + (alt ? '<span class="small faint">Next best swap:</span> <button class="gl" data-ent="items:' + esc(alt.id) + '">' + esc(alt.name) + '</button>' : '') +
          '<button class="tbtn dbr-lockbtn' + (b.locked ? ' on' : '') + '" data-db-togglelock="' + esc(it.id) + '" aria-pressed="' + (b.locked ? 'true' : 'false') + '">' + (b.locked ? 'Unlock' : 'Lock') + '</button></div>';
        h += '</li>';
      }
      h += '</ol>';
    }
    // The build against the rules: slots, buttons, investment steps (engine figures, souls from items.json).
    h += '<div class="card dbr-spend"><div class="dbr-sh">This build and the shop rules</div>';
    if (R.slots && isNum(R.slots.used) && isNum(R.slots.total)) {
      h += '<p class="small dbr-p">Uses ' + esc(String(R.slots.used)) + ' of ' + esc(String(R.slots.total)) + ' item slots (' + esc(String(R.slots.base)) + ' to start, ' +
        esc(String(R.slots.extra)) + ' extra). ' + (R.actives && isNum(R.actives.used) ? esc(plural(R.actives.used, 'item has', 'items have')) + ' a button, of ' + esc(String(R.actives.cap)) + ' allowed.' : '') + '</p>';
    }
    if (isNum(R.left)) h += '<p class="small dbr-p">' + esc(num(R.left)) + ' souls left over.</p>';
    var inv = (R.invest || []).filter(function (x) { return x && x.spend > 0; });
    for (var q = 0; q < inv.length; q++) {
      h += '<div class="dbr-sp"><span class="chip t-' + esc(inv[q].slot) + '">' + esc(SLOT_LABEL[inv[q].slot] || inv[q].slot) + '</span><span class="small">' + esc(investLine(inv[q])) + '</span></div>';
    }
    h += '<div class="linkrow">' + (A().ent('mechanics:shop-tiers-and-investment') ? '<button class="lchip" data-ent="mechanics:shop-tiers-and-investment">What investment steps do</button>' : '') +
      (A().ent('mechanics:item-slots-and-flex-slots') ? '<button class="lchip" data-ent="mechanics:item-slots-and-flex-slots">Item slots</button>' : '') + '</div>';
    if (R.ruleNote) h += '<p class="small faint dbr-p" style="margin-top:8px">' + esc(R.ruleNote) + '</p>';
    h += '</div>';
    if ((R.matchups || []).length) {
      h += '<div class="card"><div class="dbr-sh">Against the heroes you picked</div><ul class="dbr-rc dbr-flat">' + R.matchups.map(function (m) {
        return receiptHtml({ kind: 'matchup', text: String(m.text || ''), matches: null });
      }).join('') + '</ul>';
      if ((R.threats || []).length) {
        h += '<p class="small muted dbr-p">What their players lean on, more than the average hero: ' + R.threats.map(function (t) { return esc(t.label); }).join(', ') + '. Items that answer it count for more.</p>';
      } else {
        h += '<p class="small muted dbr-p">These heroes lean on no item type clearly more than the average hero, so they do not change the picks.</p>';
      }
      h += '</div>';
    }
    if (V.unresolved) h += '<div class="note warn">' + esc(plural(V.unresolved, 'pick', 'picks')) + ' named an item this app does not have and ' + (V.unresolved === 1 ? 'was' : 'were') + ' left out.</div>';
    h += HOW_HTML;
    if (hh) h += '<div class="actrow"><button class="tbtn" data-ent="heroes:' + esc(hh.id) + '">Open ' + esc(hh.name) + '</button><button class="tbtn" data-db-open="goals">Change the planner</button></div>';
    return h + '</section>';
  }

  /* ------------------------------------------------------------------ html: the bottom sheet */

  function stepDone(id) {
    if (id === 'hero') return !!hero(INP.hero);
    if (id === 'goals') return INP.goals.length > 0;
    if (id === 'enemies') return INP.enemies.length > 0;
    if (id === 'locks') return INP.locks.length > 0;
    if (id === 'phase') return INP.phase !== 'custom' || isNum(INP.budget);
    return false;
  }

  function heroGrid(multi) {
    var q = norm(UI.heroQ);
    var list = heroes().filter(function (x) { return !q || norm(x.name).indexOf(q) !== -1 || norm(x.typeLabel).indexOf(q) !== -1; });
    if (!list.length) return '<div class="dbs-empty">No hero matches that.</div>';
    var full = multi && INP.enemies.length >= ENG.limits.maxEnemies;
    return '<div class="dbs-grid">' + list.map(function (x) {
      var on = multi ? has(INP.enemies, x.id) : INP.hero === x.id;
      var dis = multi && !on && full;
      return '<button class="dbs-hero' + (on ? ' on' : '') + '" data-db-' + (multi ? 'enemy' : 'hero') + '="' + esc(x.id) + '"' + (dis ? ' disabled' : '') +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' + A().iconHtml(x, 44) + '<span class="dbs-hn">' + esc(x.name) + '</span>' +
        (multi && x.id === INP.hero ? '<span class="dbs-you">you</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function itemList() {
    var q = norm(UI.itemQ);
    var legal = ENG.legalItems().map(item).filter(Boolean);
    var its = legal.filter(function (x) {
      if (UI.itemSlot !== 'all' && x.slot !== UI.itemSlot) return false;
      return !q || norm(x.name).indexOf(q) !== -1;
    }).sort(function (a, b) {
      return SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || a.tier - b.tier || String(a.name).localeCompare(String(b.name));
    });
    if (!its.length) return '<div class="dbs-empty">No item matches that.</div>';
    var full = INP.locks.length >= ENG.limits.maxLocks;
    return its.map(function (x) {
      var on = has(INP.locks, x.id);
      return '<button class="dbs-item slot-' + esc(x.slot) + (on ? ' on' : '') + '" data-db-lock="' + esc(x.id) + '"' + (!on && full ? ' disabled' : '') +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' + A().iconHtml(x, 36) + '<span class="dbs-in">' + esc(x.name) + '</span>' +
        '<span class="chip cost">' + esc(num(x.cost)) + '</span><span class="dbs-tick">' + (on ? '&#10003;' : '+') + '</span></button>';
    }).join('');
  }

  function cnt(a, b) { return '<span class="dbs-cnt">' + esc(String(a)) + (b != null ? ' of ' + esc(String(b)) : '') + '</span>'; }

  function stepBody(step) {
    var h = '';
    if (step === 'hero') {
      h += '<p class="dbs-lede">Who are you playing?</p>';
      h += '<input class="search dbs-q" data-db-q="hero" type="search" autocomplete="off" spellcheck="false" placeholder="Filter heroes" value="' + esc(UI.heroQ) + '" />';
      h += '<div data-db-list="hero">' + heroGrid(false) + '</div>';
    } else if (step === 'goals') {
      var mg = ENG.limits.maxGoals;
      h += '<p class="dbs-lede">What should this build do? Pick up to ' + esc(String(mg)) + ', or none to go on match numbers alone. ' + cnt(INP.goals.length, mg) + '</p>';
      h += ENG.goals.map(function (g) {
        var on = has(INP.goals, g.id);
        return '<button class="dbs-goal' + (on ? ' on' : '') + '" data-db-goal="' + esc(g.id) + '"' + (!on && INP.goals.length >= mg ? ' disabled' : '') +
          ' aria-pressed="' + (on ? 'true' : 'false') + '"><span class="dbs-gl">' + esc(g.label) + '</span>' + (g.help ? '<span class="dbs-gh">' + esc(g.help) + '</span>' : '') +
          '<span class="dbs-tick">' + (on ? '&#10003;' : '+') + '</span></button>';
      }).join('');
    } else if (step === 'enemies') {
      h += '<p class="dbs-lede">Who is on the other team? Optional - skip it if you do not know yet. ' + cnt(INP.enemies.length, ENG.limits.maxEnemies) +
        (INP.enemies.length ? ' <button class="gl" data-db-clear="enemies">Clear</button>' : '') + '</p>';
      h += '<input class="search dbs-q" data-db-q="hero" type="search" autocomplete="off" spellcheck="false" placeholder="Filter heroes" value="' + esc(UI.heroQ) + '" />';
      h += '<div data-db-list="enemy">' + heroGrid(true) + '</div>';
    } else if (step === 'locks') {
      h += '<p class="dbs-lede">Any item you want in the build no matter what? Optional. The engine builds around it and says what the lock cost you. ' +
        cnt(INP.locks.length, ENG.limits.maxLocks) + (INP.locks.length ? ' <button class="gl" data-db-clear="locks">Clear</button>' : '') + '</p>';
      h += '<input class="search dbs-q" data-db-q="item" type="search" autocomplete="off" spellcheck="false" placeholder="Filter items" value="' + esc(UI.itemQ) + '" />';
      h += '<div class="chiprow">' + ['all'].concat(SLOT_ORDER).map(function (s) {
        return '<button class="fbtn' + (s !== 'all' ? ' t-' + s : '') + (UI.itemSlot === s ? ' on' : '') + '" data-db-slot="' + esc(s) + '">' + esc(s === 'all' ? 'All' : SLOT_LABEL[s]) + '</button>';
      }).join('') + '</div>';
      h += '<div data-db-list="item">' + itemList() + '</div>';
    } else if (step === 'phase') {
      h += '<p class="dbs-lede">How far into the match should the build reach? That sets how many souls it can spend.</p>';
      h += ENG.phases.map(function (x) {
        var on = INP.phase === x.id;
        var bf = hero(INP.hero) ? ENG.budgetFor(INP.hero, { phase: x.id }) : null;
        return '<button class="dbs-goal' + (on ? ' on' : '') + '" data-db-phase="' + esc(x.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '"><span class="dbs-gl">' + esc(x.label) + '</span>' +
          '<span class="dbs-gh">' + esc(bf && bf.text ? bf.text : x.help || '') + '</span><span class="dbs-tick">' + (on ? '&#10003;' : '') + '</span></button>';
      }).join('');
      var st = budgetStep(), mx = budgetMax();
      if (st && mx) {
        var cu = INP.phase === 'custom';
        h += '<div class="dbs-budget' + (cu ? ' on' : '') + '"><div class="dbs-gl">Or set your own soul budget</div>';
        h += '<div class="dbs-step"><button class="tbtn" data-db-budget="-1" aria-label="Fewer souls">&minus;</button><span class="dbs-bv">' +
          (cu && isNum(INP.budget) ? esc(num(INP.budget)) + ' souls' : 'Off') + '</span><button class="tbtn" data-db-budget="1" aria-label="More souls">+</button></div>';
        h += '<p class="small faint" style="margin:6px 0 0">Each tap is ' + esc(num(st)) + ' souls, the price of the cheapest shop items.</p></div>';
      }
      var sl = ENG.slots || {};
      if (isNum(sl.extraMax) && sl.extraMax > 0) {
        h += '<div class="dbs-budget"><div class="dbs-gl">Extra item slots open</div>';
        h += '<div class="dbs-step"><button class="tbtn" data-db-extra="-1" aria-label="Fewer extra slots">&minus;</button><span class="dbs-bv">' + esc(String(INP.extraSlots)) +
          ' of ' + esc(String(sl.extraMax)) + '</span><button class="tbtn" data-db-extra="1" aria-label="More extra slots">+</button></div>';
        h += '<p class="small faint" style="margin:6px 0 0">Extra slots open as enemy Walkers fall. The sources do not agree on slot numbers yet and none of this is checked in game. ' +
          (A().ent('mechanics:item-slots-and-flex-slots') ? '<button class="gl" data-ent="mechanics:item-slots-and-flex-slots">Item slots</button>' : '') + '</p></div>';
      }
    }
    return h;
  }

  function sheetHtml() {
    if (!UI.open || !ENG) return '<div data-db-sheet hidden></div>';
    var idx = 0;
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === UI.step) idx = i;
    var last = idx === STEPS.length - 1;
    var h = '<div class="dbs" data-db-sheet><div class="dbs-back" data-db-close></div>' +
      '<div class="dbs-body" role="dialog" aria-modal="true" aria-label="Build planner">';
    h += '<div class="dbs-top"><div class="sheet-grab"></div><div class="dbs-tr">';
    h += '<div class="dbs-steps">' + STEPS.map(function (s) {
      return '<button class="dbs-sc' + (s.id === UI.step ? ' on' : '') + (stepDone(s.id) ? ' done' : '') + '" data-db-step="' + s.id + '">' + esc(s.label) + '</button>';
    }).join('') + '</div><button class="tbtn dbs-x" data-db-close>Close</button></div></div>';
    h += '<div class="dbs-main" data-db-main>' + stepBody(UI.step) + '</div>';
    var canGo = !!hero(INP.hero) && stepDone('phase');
    h += '<div class="dbs-foot">' +
      (idx > 0 ? '<button class="tbtn" data-db-step="' + STEPS[idx - 1].id + '">Back</button>' : '') +
      (UI.step !== 'hero' ? '<button class="dbp-go dbs-go" data-db-go' + (canGo ? '' : ' disabled') + '>Make my build</button>' : '') +
      (!last ? '<button class="tbtn dbs-next" data-db-step="' + STEPS[idx + 1].id + '">' + (UI.step === 'hero' || stepDone(UI.step) ? 'Next' : 'Skip') + '</button>' : '') +
      '</div>';
    return h + '</div></div>';
  }

  /* ------------------------------------------------------------------ painting */

  function swap(sel, html) {
    if (!ROOT) return;
    var el = ROOT.querySelector(sel);
    if (!el) return;
    var t = document.createElement('div');
    t.innerHTML = html;
    if (t.firstChild) el.parentNode.replaceChild(t.firstChild, el);
  }

  function lockScroll(on) {
    try { document.body.style.overflow = on ? 'hidden' : ''; } catch (e) { /* no-op */ }
  }

  function paintSheet(keepScroll) {
    if (!ROOT || !ROOT.isConnected) return;
    var main = ROOT.querySelector('[data-db-main]');
    var top = keepScroll && main ? main.scrollTop : 0;
    swap('[data-db-sheet]', sheetHtml());
    var m2 = ROOT.querySelector('[data-db-main]');
    if (m2) m2.scrollTop = top;
    lockScroll(UI.open);
  }

  function paint() {
    if (!ROOT || !ROOT.isConnected) return;
    swap('[data-db-card]', cardHtml());
    swap('[data-db-result]', resultHtml());
    paintSheet(true);
  }

  function paintList(kind) {
    var box = ROOT && ROOT.querySelector('[data-db-list="' + kind + '"]');
    if (box) box.innerHTML = kind === 'item' ? itemList() : heroGrid(kind === 'enemy');
  }

  function openSheet(step) {
    if (!ENG) return;
    UI.open = true;
    UI.step = step || 'hero';
    UI.heroQ = ''; UI.itemQ = '';
    paintSheet(false);
  }

  function closeSheet() {
    UI.open = false;
    paint();   // card + result too: an edited planner must show the stale-result banner
  }

  function toggleIn(list, id, max) {
    var i = list.indexOf(id);
    if (i !== -1) list.splice(i, 1);
    else if (list.length < max) list.push(id);
  }

  /* ------------------------------------------------------------------ events */

  function changed() { paintSheet(true); swap('[data-db-card]', cardHtml()); }

  function onClick(ev) {
    var t = ev.target;
    if (!t || !t.closest || !ENG) return;
    var b;
    if (t.closest('[data-db-close]')) { closeSheet(); return; }
    if ((b = t.closest('[data-db-open]'))) { openSheet(b.getAttribute('data-db-open')); return; }
    if ((b = t.closest('[data-db-step]'))) { UI.step = b.getAttribute('data-db-step'); UI.heroQ = ''; UI.itemQ = ''; paintSheet(false); return; }
    if (t.closest('[data-db-go]')) { if (hero(INP.hero)) goRun(); return; }
    if ((b = t.closest('[data-db-hero]'))) {
      var hid = b.getAttribute('data-db-hero');
      setInputs(function (p) { EXAMPLE = false; p.hero = hid; p.enemies = (p.enemies || []).filter(function (x) { return x !== hid; }); });
      UI.step = 'goals'; UI.heroQ = '';
      paintSheet(false); swap('[data-db-card]', cardHtml());
      return;
    }
    if ((b = t.closest('[data-db-enemy]'))) { var e = b.getAttribute('data-db-enemy'); setInputs(function (p) { toggleIn(p.enemies, e, ENG.limits.maxEnemies); }); changed(); return; }
    if ((b = t.closest('[data-db-goal]'))) { var g = b.getAttribute('data-db-goal'); setInputs(function (p) { toggleIn(p.goals, g, ENG.limits.maxGoals); }); changed(); return; }
    if ((b = t.closest('[data-db-lock]'))) { var l = b.getAttribute('data-db-lock'); setInputs(function (p) { toggleIn(p.locks, l, ENG.limits.maxLocks); }); changed(); return; }
    if ((b = t.closest('[data-db-togglelock]'))) {
      var tl = b.getAttribute('data-db-togglelock');
      setInputs(function (p) { toggleIn(p.locks, tl, ENG.limits.maxLocks); });
      run();
      return;
    }
    if ((b = t.closest('[data-db-slot]'))) { UI.itemSlot = b.getAttribute('data-db-slot'); paintSheet(true); return; }
    if ((b = t.closest('[data-db-clear]'))) {
      var k = b.getAttribute('data-db-clear');
      setInputs(function (p) { if (k === 'enemies') p.enemies = []; else if (k === 'locks') p.locks = []; });
      changed();
      return;
    }
    if ((b = t.closest('[data-db-phase]'))) {
      var ph = phaseOf(b.getAttribute('data-db-phase'));
      if (ph) setInputs(function (p) { EXAMPLE = false; p.phase = ph.id; p.budget = null; p.extraSlots = ph.extraSlots; });
      changed();
      return;
    }
    if ((b = t.closest('[data-db-budget]'))) {
      var d = Number(b.getAttribute('data-db-budget'));
      var st = budgetStep(), mx = budgetMax();
      if (!st || !mx) return;
      setInputs(function (p) {
        var cur = p.phase === 'custom' && isNum(p.budget) ? p.budget : 0;
        EXAMPLE = false; p.phase = 'custom';
        p.budget = Math.min(mx, Math.max(st, cur + d * st));
      });
      changed();
      return;
    }
    if ((b = t.closest('[data-db-extra]'))) {
      var dx = Number(b.getAttribute('data-db-extra'));
      var em = ENG.slots && ENG.slots.extraMax;
      setInputs(function (p) { p.extraSlots = Math.min(em, Math.max(0, (p.extraSlots || 0) + dx)); });
      changed();
      return;
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var k = t.getAttribute('data-db-q');
    if (k === 'hero') { UI.heroQ = t.value || ''; paintList(UI.step === 'enemies' ? 'enemy' : 'hero'); }
    else if (k === 'item') { UI.itemQ = t.value || ''; paintList('item'); }
  }

  var KEYS = false;
  function bindKeys() {
    if (KEYS) return;
    KEYS = true;
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || !UI.open || !ROOT || !ROOT.isConnected) return;
      var es = document.querySelector('.sheet');   // the entity sheet sits above the planner and closes first
      if (es && !es.hidden) return;
      closeSheet();
    });
  }

  /* ------------------------------------------------------------------ the surface */

  function render() {
    if (!A()) return '';
    loadInputs();
    return '<div class="dbw">' + cardHtml() + resultHtml() + sheetHtml() + '</div>';
  }

  function arrive() {
    // Deterministic engine: rebuild the saved plan on arrival so the tab opens on a real build.
    if (ENG && INP && hero(INP.hero) && !UI.running && !UI.open && !UI.error && UI.resultKey !== keyOf(INP)) run();
  }

  function afterRender(root) {
    ROOT = root;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    bindKeys();
    lockScroll(UI.open);
    if (!ENG && !LOAD_ERR) {
      var pr = ensureEngine();
      if (pr) pr.then(function () {
        if (ENG && INP) INP = ENG.sanitize(INP);
        if (ROOT === root && root.isConnected) { paint(); arrive(); }
      });
      return;
    }
    arrive();
  }

  /* ------------------------------------------------------------------ offline prefetch
     This tab loads data/generator.json and data/analytics.json LAZILY, and the service worker only runtime-caches a file
     the first time something fetches it - so a phone that never opened this tab while online had neither file offline
     and the tab showed 'Failed to fetch' (round 2 finding). Fix: once the page has loaded and the browser is idle, fetch
     both (the worker's stale-while-revalidate route stores them) and ALSO ask the worker to store them itself with its
     fi-warm message, which works on the very first visit before the worker controls the page. Both are small
     (analytics is the larger) and happen once per stamp. tools/validate.mjs BUILDS-TAB runs this file headless and
     fails if either file is not prefetched, or if a data file exists that is neither read at boot nor prefetched. */
  var WARM_SLUG = 'deadlock';
  function warmOffline() {
    var a = A();
    if (!a) return;
    var pa = a.loadAnalytics();
    if (pa && pa.catch) pa.catch(function () {});
    var pg = loadGenerator();
    if (pg && pg.catch) pg.catch(function () {});
    var nav = window.navigator;
    if (!nav || !nav.serviceWorker || !nav.serviceWorker.ready || typeof URL !== 'function') return;
    nav.serviceWorker.ready.then(function (reg) {
      var target = nav.serviceWorker.controller || (reg && reg.active);
      if (!target) return;
      var urls = ['/island/apps/deadlock/data/analytics.json', '/island/apps/deadlock/data/generator.json'].map(function (u) { return new URL(u, window.location.href).href; });
      target.postMessage({ type: 'fi-warm', slug: WARM_SLUG, urls: urls });
    }).catch(function () {});
  }
  function scheduleWarm() {
    var go = function () { try { warmOffline(); } catch (e) { /* offline prefetch is best effort */ } };
    var idle = function () {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(go);
      else setTimeout(go, 0);
    };
    if (!window.document || window.document.readyState === 'complete' || typeof window.addEventListener !== 'function') idle();
    else window.addEventListener('load', idle);
  }
  scheduleWarm();

  var SURFACE = { render: render, afterRender: afterRender };
  var OTHER = window.DL_BUILDS || null;   // keep anything registered before this file
  try {
    Object.defineProperty(window, 'DL_BUILDS', {
      configurable: true,
      enumerable: true,
      get: function () { return api() ? SURFACE : OTHER; },
      set: function (v) { OTHER = v; }
    });
  } catch (e) {
    window.DL_BUILDS = SURFACE;
  }
})();
