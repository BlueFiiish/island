/* WARDOGS loadout generator - THE ENGINE.
 *
 * Pure. No DOM, no fetch, no globals it did not create, no Date, no Math.random.
 * Runs identically in the browser (window.WDGenEngine) and in Node, which is how
 * tools/validate.mjs group K proves it - the gate loads THIS file and runs real
 * builds against the shipped data.
 *
 * WHAT IT IS ------------------------------------------------------------------
 * The L2 rung of the tool ladder (NEW-GAME-TEMPLATE section 9): a stats-driven
 * generator. Inputs are the player's WARDOG level, up to three GOALS, an optional
 * ENEMY roster (real entity keys - the vehicles, weapons and factions the other
 * side is fielding), optional LOCKED core items, and a cash budget. It scores
 * every LEGAL candidate for every loadout slot, fills the real slot count with a
 * greedy pass and then a swap pass, and prints a receipt under every pick.
 *
 * THE MISSING TERM, STATED PLAINLY ---------------------------------------------
 * L2 wants each candidate scored partly by its win-rate lift with a sample size.
 * WARDOGS is pre-release and publishes no match outcomes at all, so that term is
 * wired through this file and is EMPTY: `analytics.matchOutcomes.available` is
 * false, the term contributes exactly zero, and the engine prints NO percentage
 * and NO sample size anywhere. That is the spec's own rule - if a number has no
 * sample behind it, print no number - rather than an invented figure. Every
 * number a receipt does print is a number the source published, carried in the
 * line's `cites` array so the gate can check it against data/*.json.
 *
 * The lift and its sample size are treated as ONE thing, and the rule is
 * enforced rather than described. matchOutcomeTerm() scores zero unless
 * matchOutcomes publishes `samples >= 1`, so an outcome model that declares
 * itself available with no sample cannot steer a pick; when it does score it
 * becomes a visible scored part and outcomeLine() prints it as the only receipt
 * of kind 'data', always carrying its n; and toReceipts() DROPS any 'data' line
 * that reaches it without an n rather than relabelling it, which is what it used
 * to do. `basis` is read out of the rule model at warm() time for the same
 * reason - so the tab's "no match-outcome sample behind it" sentence is a fact
 * about the data rather than a literal that can go stale.
 *
 * THE BUDGET IS OPTIONAL --------------------------------------------------------
 * `input.budget` is a finite number of dollars OR null, and null means the player
 * set no limit - the DEFAULT state of the tab. Nothing compares against it
 * directly; affordability goes through affordable(), and the "your budget ran
 * out" reason is only ever printed when a real cap really did turn a candidate
 * away. build() re-checks that invariant on the finished result.
 *
 * WHERE NUMBERS LIVE -----------------------------------------------------------
 * Nowhere in this file. Game facts come from data/*.json at call time; the slot
 * model, tag rules, goal weights and tuning come from data/analytics.json. This
 * file contains no entity id, no entity name, no category string and no price,
 * weight or level - validate.mjs group K asserts exactly that, so a future edit
 * cannot quietly hardcode one.
 *
 * DETERMINISM ------------------------------------------------------------------
 * Same data + same input = byte-identical output, always. Every sort is total:
 * score desc, then price asc, then id asc. No set/object iteration order is ever
 * load-bearing. The gate builds twice and compares.
 *
 * ASCII only.
 */
;(function (root) {
  'use strict';

  /* ------------------------------------------------------------ utilities */

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      var m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      if (m) { var n = parseFloat(m[0]); return isFinite(n) ? n : null; }
    }
    return null;
  }
  function str(v) { return v == null ? '' : String(v); }
  function low(v) { return str(v).toLowerCase().trim(); }
  function arr(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }
  function firstField(rec, names) {
    for (var i = 0; i < names.length; i++) {
      if (rec && rec[names[i]] !== undefined && rec[names[i]] !== null && rec[names[i]] !== '') {
        return { field: names[i], value: rec[names[i]] };
      }
    }
    return null;
  }
  function money(n) {
    if (n === 0) return 'free';
    return '$' + Number(n).toLocaleString('en-US');
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  /* THE BUDGET IS OPTIONAL, AND "no cap" IS NOT "$0".
     input.budget is either a finite non-negative number of dollars or NULL,
     and NULL means the player set no limit at all - which is the DEFAULT state
     of the tab ("No limit" is the chip that starts selected). Everything that
     tests affordability goes through affordable(); nothing compares against
     input.budget directly, because that is exactly how the default state came
     to be floored to $0: a null budget failed `spend + cost > 0` for every
     priced candidate, so an unlimited wallet bought FEWER items than a $200
     one and the tab told the player their budget had run out. */
  function hasBudget(input) { return typeof input.budget === 'number'; }
  function affordable(input, spend, cost) {
    return !hasBudget(input) || spend + cost <= input.budget;
  }

  /* A total order. Score, then a PUBLISHED price beats an unpublished one, then
     the cheaper thing, then the id - so two runs of the same input can never
     disagree about a tie.
     The price-published rung exists because an item the source never priced
     counts as zero against the budget, which used to let it win every tie at a
     low budget and recommend a gun nobody can be told the cost of. */
  function bySlotRank(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var ah = typeof a.price === 'number' ? 0 : 1, bh = typeof b.price === 'number' ? 0 : 1;
    if (ah !== bh) return ah - bh;
    var ap = a.priceForSort, bp = b.priceForSort;
    if (ap !== bp) return ap - bp;
    return a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0;
  }

  /* ------------------------------------------------------------- preparing */

  function prepare(data, analytics) {
    var ctx = {
      data: data,
      an: analytics,
      byKey: {},
      byNameLower: {},
      groupsOf: {}
    };
    var keys = Object.keys(data).sort();
    for (var i = 0; i < keys.length; i++) {
      var gk = keys[i];
      var list = data[gk];
      if (!Array.isArray(list)) continue;
      ctx.groupsOf[gk] = list;
      for (var j = 0; j < list.length; j++) {
        var r = list[j];
        ctx.byKey[gk + ':' + r.id] = { group: gk, rec: r };
        var nm = low(r.name || r.term);
        if (nm && !ctx.byNameLower[gk + '|' + nm]) ctx.byNameLower[gk + '|' + nm] = r;
      }
    }
    ctx.f = (analytics && analytics.fields) || {};
    ctx.pat = (analytics && analytics.patterns) || {};
    ctx.tagById = {};
    var tags = (analytics && analytics.tags) || [];
    for (var t = 0; t < tags.length; t++) ctx.tagById[tags[t].id] = tags[t];
    ctx.goalById = {};
    var goals = (analytics && analytics.goals) || [];
    for (var g = 0; g < goals.length; g++) ctx.goalById[goals[g].id] = goals[g];
    ctx.enemyRules = (analytics && analytics.enemyRules) || [];
    ctx.enemyRuleById = {};
    for (var e = 0; e < ctx.enemyRules.length; e++) ctx.enemyRuleById[ctx.enemyRules[e].id] = ctx.enemyRules[e];
    ctx.slotById = {};
    var sl = (analytics && analytics.slots) || [];
    for (var s = 0; s < sl.length; s++) ctx.slotById[sl[s].id] = sl[s];
    return ctx;
  }

  /* ------------------------------------------------------- field accessors */

  function priceOf(ctx, rec) {
    var f = firstField(rec, ctx.f.price || ['price']);
    return f ? num(f.value) : null;
  }
  function priceCite(ctx, group, rec) {
    var names = ctx.f.price || ['price'];
    for (var i = 0; i < names.length; i++) {
      if (typeof rec[names[i]] === 'number') return { group: group, id: rec.id, field: names[i], value: rec[names[i]] };
    }
    return null;
  }
  function weightOf(ctx, rec) {
    var f = firstField(rec, ctx.f.weight || ['weightKg']);
    return f ? num(f.value) : null;
  }
  function unlockOf(ctx, rec) {
    var names = ctx.f.unlock || ['unlockPrice'];
    for (var i = 0; i < names.length; i++) {
      var v = rec[names[i]];
      if (typeof v === 'number') return { field: names[i], value: v };
    }
    return null;
  }

  /* TWO KINDS OF GATE in one field. A NUMBER is the account-wide WARDOG level.
     A STRING is a per-class XP gate the source spells out itself. Comparing the
     two would invent a requirement, so they are resolved separately. */
  function gateOf(ctx, rec) {
    var names = ctx.f.gate || ['wardogLevel'];
    for (var i = 0; i < names.length; i++) {
      var v = rec[names[i]];
      if (typeof v === 'number') return { kind: 'account', level: v, field: names[i], raw: v };
      if (typeof v === 'string' && v) {
        var re = new RegExp(ctx.pat.classGate || '^(.+?)\\s+Lvl\\s+(\\d+)$', 'i');
        var m = v.match(re);
        if (m) return { kind: 'class', cls: m[1].trim(), level: parseInt(m[2], 10), field: names[i], raw: v };
        return { kind: 'unparsed', field: names[i], raw: v };
      }
    }
    return null;
  }
  /* The ACCOUNT level is a hard constraint - the app knows it, so an item above
     it is never suggested. A CLASS gate is not: nothing in the app or the data
     knows your Assault track, and the six tracks all rise at once regardless of
     what you are "playing". Excluding on a number nobody has would hide most of
     the good kit on a guess, so a class-gated pick is allowed through and its
     receipt says plainly that this is a gate the tab cannot check for you. That
     is the same rule app.js already applies on the item lists (gatedAbove). */
  function meetsGate(ctx, rec, input) {
    var g = gateOf(ctx, rec);
    if (!g) return true;
    if (g.kind === 'account') return input.wardogLevel >= g.level;
    return true;
  }

  /* --------------------------------------------------------------- scoring */

  /* Pool statistics. Every `norm` scorer is relative TO THE POOL FOR THIS SLOT,
     so there is not one magic threshold in the engine: "cheap" means cheap for
     the thing being chosen, and it re-derives itself on every patch. */
  function poolStats(ctx, pool, tagIds) {
    var stats = {};
    for (var i = 0; i < tagIds.length; i++) {
      var tag = ctx.tagById[tagIds[i]];
      if (!tag) continue;
      var sc = tag.scorer;
      if (sc.op !== 'norm' && sc.op !== 'invnorm' && sc.op !== 'normSuffix' && sc.op !== 'joinNorm' && sc.op !== 'countIn') continue;
      var min = null, max = null;
      for (var j = 0; j < pool.length; j++) {
        var v = rawNumberFor(ctx, pool[j].group, pool[j].rec, sc);
        if (v === null) continue;
        if (min === null || v < min) min = v;
        if (max === null || v > max) max = v;
      }
      stats[tag.id] = { min: min, max: max };
    }
    return stats;
  }

  function rawNumberFor(ctx, group, rec, sc) {
    if (sc.op === 'norm' || sc.op === 'invnorm') return num(rec[sc.field]);
    if (sc.op === 'normSuffix') {
      var s = str(rec[sc.field]);
      if (!s) return null;
      return num(s);
    }
    if (sc.op === 'countIn') {
      var t = str(rec[sc.field]);
      if (!t) return null;
      var m = t.match(/\d+/g);
      if (!m) return null;
      var total = 0;
      for (var i = 0; i < m.length; i++) total += parseInt(m[i], 10);
      return total;
    }
    if (sc.op === 'joinNorm') {
      var j = joinTarget(ctx, group, rec, sc.join);
      return j ? num(j.rec[sc.take]) : null;
    }
    return null;
  }

  function joinTarget(ctx, group, rec, joinName) {
    var jd = (ctx.an.joins || {})[joinName];
    if (!jd || jd.from !== group) return null;
    var key = low(rec[jd.field]);
    if (!key) return null;
    var target = ctx.byNameLower[jd.to + '|' + key];
    return target ? { group: jd.to, rec: target } : null;
  }

  function normalise(v, st) {
    if (v === null || !st || st.min === null || st.max === null) return 0;
    if (st.max === st.min) return 0;
    return (v - st.min) / (st.max - st.min);
  }

  function tagScore(ctx, group, rec, tag, stats) {
    var sc = tag.scorer;
    var st = stats[tag.id];
    switch (sc.op) {
      case 'norm': return normalise(rawNumberFor(ctx, group, rec, sc), st);
      case 'invnorm': {
        var v = rawNumberFor(ctx, group, rec, sc);
        if (v === null) return 0;
        return 1 - normalise(v, st);
      }
      case 'normSuffix': return normalise(rawNumberFor(ctx, group, rec, sc), st);
      case 'countIn': return normalise(rawNumberFor(ctx, group, rec, sc), st);
      case 'joinNorm': return normalise(rawNumberFor(ctx, group, rec, sc), st);
      case 'ordinal': {
        var scale = (ctx.an.ordinals || {})[sc.ordinal] || [];
        var idx = scale.indexOf(str(rec[sc.field]));
        if (idx < 0 || scale.length < 2) return 0;
        return idx / (scale.length - 1);
      }
      case 'flag': {
        var vals = arr(rec[sc.field]).map(low).join(' ');
        return vals.indexOf(low(sc.match)) !== -1 ? 1 : 0;
      }
      case 'catFlag': return new RegExp(sc.match, 'i').test(str(rec.category)) ? 1 : 0;
      case 'nameFlag': return new RegExp(sc.match, 'i').test(str(rec.name)) ? 1 : 0;
      case 'groupFlag': return new RegExp(sc.match, 'i').test(str(rec[sc.field])) ? 1 : 0;
      case 'anyFlag': {
        var re = new RegExp(sc.match, 'i');
        for (var i = 0; i < sc.fields.length; i++) {
          var joined = arr(rec[sc.fields[i]]).map(str).join(' ');
          if (re.test(joined)) return 1;
        }
        return 0;
      }
      case 'absent': {
        for (var k = 0; k < sc.fields.length; k++) {
          var vv = rec[sc.fields[k]];
          if (vv !== undefined && vv !== null && vv !== '') return 0;
        }
        return 1;
      }
      default: return 0;
    }
  }

  /* The weight vector: the selected goals (decayed by the order the player
     ranked them) plus the enemy conditions. This is the whole of the scoring
     intent, in one object, so a receipt can name the goal a pick served. */
  function weightVector(ctx, input) {
    var decay = ((ctx.an.tuning || {}).weights || {}).goalRankDecay || [1];
    var enemyW = ((ctx.an.tuning || {}).weights || {}).enemyWeight;
    if (typeof enemyW !== 'number') enemyW = 1;
    var w = {}, byGoal = {}, byEnemy = {};
    for (var i = 0; i < input.goals.length; i++) {
      var goal = ctx.goalById[input.goals[i]];
      if (!goal) continue;
      var d = typeof decay[i] === 'number' ? decay[i] : decay[decay.length - 1];
      var ws = goal.weights || {};
      var tk = Object.keys(ws).sort();
      for (var a = 0; a < tk.length; a++) {
        w[tk[a]] = (w[tk[a]] || 0) + ws[tk[a]] * d;
        (byGoal[tk[a]] = byGoal[tk[a]] || []).push(goal.id);
      }
    }
    var prefer = {}, preferBy = {};
    var seenRule = {};
    for (var e = 0; e < input.enemyMatches.length; e++) {
      var cond = ctx.enemyRuleById[input.enemyMatches[e].ruleId];
      /* One rule counts ONCE however many enemy entities tripped it. Three
         helicopters do not make the anti-air launcher three times better. */
      if (!cond || seenRule[cond.id]) continue;
      seenRule[cond.id] = true;
      var ew = cond.weights || {};
      var ek = Object.keys(ew).sort();
      for (var b = 0; b < ek.length; b++) {
        w[ek[b]] = (w[ek[b]] || 0) + ew[ek[b]] * enemyW;
        (byEnemy[ek[b]] = byEnemy[ek[b]] || []).push(cond.id);
      }
      /* A named preference for one specific entity - the armour rule points at
         a particular ammunition type, and nothing about that type's own fields
         would ever reveal it. The key is resolved and hard-checked at build
         time by tools/build_analytics.mjs, so it cannot rot into a silent no-op. */
      if (cond.prefer && cond.prefer.key) {
        var pw = typeof cond.prefer.weight === 'number' ? cond.prefer.weight : enemyW;
        prefer[cond.prefer.key] = (prefer[cond.prefer.key] || 0) + pw;
        (preferBy[cond.prefer.key] = preferBy[cond.prefer.key] || []).push(cond.id);
      }
    }
    return { w: w, byGoal: byGoal, byEnemy: byEnemy, prefer: prefer, preferBy: preferBy, tagIds: Object.keys(w).sort() };
  }

  /* ------------------------------------------------------------- legality */

  function slotPool(ctx, slot, input, state) {
    var out = [];
    var gs = slot.groups || [];
    for (var i = 0; i < gs.length; i++) {
      var list = ctx.groupsOf[gs[i]] || [];
      for (var j = 0; j < list.length; j++) {
        var rec = list[j];
        if (slot.categories && slot.categories.indexOf(rec.category) === -1) continue;
        if (!meetsGate(ctx, rec, input)) continue;
        /* "Only what I already own" is a HARD constraint when the player asks
           for it: the one-time unlock is a separate wall from the price, and a
           full wallet is not a full locker. */
        if (input.onlyOwned && unlockOf(ctx, rec) && !input.ownedUnlocks[gs[i] + ':' + rec.id]) continue;
        if (!legal(ctx, slot, gs[i], rec, input, state)) continue;
        out.push({ group: gs[i], rec: rec });
      }
    }
    return out;
  }

  /* Named structural rules. Each one is a rule the GAME enforces - a build that
     breaks one is a bug, not a suggestion - so these are hard filters, never
     score penalties. */
  function legal(ctx, slot, group, rec, input, state) {
    var rule = slot.legality;
    if (!rule) return true;
    var primary = state.picks.primary && state.picks.primary[0];
    if (rule === 'quickSlot') {
      return new RegExp(ctx.pat.quickSlot || 'quick', 'i').test(str(rec[(ctx.f.slotType || ['slotType'])[0]]));
    }
    if (rule === 'specSlot') {
      var st = str(rec[(ctx.f.slotType || ['slotType'])[0]]);
      /* A row in the slot's OWN group that names no slot type is a
         specialization by virtue of where it lives. A row borrowed from another
         group (the medic's bag lives with the medical items) has to say so. */
      if (!st) return group === (slot.groups || [])[0];
      return new RegExp(ctx.pat.specSlot || 'spec', 'i').test(st);
    }
    if (!primary) return false;
    var p = primary.rec;
    var takesField = (ctx.f.takesAttachments || ['acceptsAttachments'])[0];
    var calField = (ctx.f.calibre || ['caliber'])[0];
    if (rule === 'primaryTakesAttachments') return p[takesField] === true;
    if (rule === 'primaryTakesAttachmentsAndCalibre') {
      if (p[takesField] !== true) return false;
      if (!rec[calField]) return true;
      return low(rec[calField]) === low(p[calField]);
    }
    if (rule === 'fitsPrimary') {
      var fitsField = (ctx.f.fits || ['weapons'])[0];
      var grpField = (ctx.f.fitsGroup || ['weaponGroup'])[0];
      var fits = arr(rec[fitsField]).map(low);
      var pname = low(p.name);
      /* THE WEAPON'S OWN CARD WINS. A magazine may name a weapon whose card says
         it takes nothing - the source's shared-magazine sentence names three
         such rifles - and fitting one anyway would build a loadout the game
         would refuse. The data keeps both readings; this refuses the overlap. */
      if (fits.indexOf(pname) !== -1) return p[takesField] !== false;
      if (fits.length) return false;
      /* A magazine that names NO weapon is one the source describes as shared.
         It then fits on calibre, and only on a weapon that takes attachments. */
      if (!rec[calField] || !p[calField]) return false;
      return low(rec[calField]) === low(p[calField]) && p[takesField] === true;
    }
    if (rule === 'primaryCalibre') {
      var cal = calibreRowFor(ctx, p);
      if (!cal) return false;
      var types = arr(cal[(ctx.f.ammoTypes || ['ammoTypes'])[0]]).map(low);
      var nm = low(rec.name), ing = low(rec[(ctx.f.inGameName || ['inGameName'])[0]]);
      if (types.indexOf(nm) === -1 && (!ing || types.indexOf(ing) === -1)) return false;
      var gate = (ctx.an.ammoGates || {})[rec.id];
      if (!gate || !gate.level) return true;
      var lvl = num(cal[gate.level]);
      if (lvl === null) return true;
      return input.wardogLevel >= lvl;
    }
    return true;
  }

  function calibreRowFor(ctx, weaponRec) {
    var jd = (ctx.an.joins || {}).weaponCalibre;
    if (!jd) return null;
    var key = low(weaponRec[jd.field]);
    if (!key) return null;
    return ctx.byNameLower[jd.to + '|' + key] || null;
  }

  /* -------------------------------------------------------------- receipts */

  /* A receipt LINE is text plus the exact facts it quotes. Every number in the
     text is present in `cites` with the group, id and field it came out of, so
     the gate can prove the app never prints a figure data/*.json does not hold.
     A line with no cites contains no number - that is the invariant. */
  function line(text, cites, kind, source, n, nUnit) {
    var l = { text: text, cites: cites || [], kind: kind || 'note', source: source || '' };
    /* A sample size rides ON the line that makes the claim. The Builds-tab
       contract REQUIRES n on a receipt of kind 'data' and drops the receipt
       without one, so the two can never be separated here either. */
    if (typeof n === 'number' && isFinite(n)) { l.n = n; l.nUnit = nUnit || 'matches'; }
    return l;
  }
  /* Provenance a reader can chase: the exact file and field the figure came out
     of. Never a URL - the source attribution is the app's job, once, not a
     repeated claim under every pick. */
  function src(group, field) { return 'data/' + group + '.json - ' + field; }

  function costLine(ctx, group, rec) {
    var pc = priceCite(ctx, group, rec);
    if (!pc) return line('The source publishes no price for this, so it is not counted in the totals below.', [], 'note');
    if (pc.value === 0) return line('Costs nothing to take into a match.', [pc], 'rule', src(group, pc.field));
    return line('Costs ' + money(pc.value) + ' to take into a match.', [pc], 'rule', src(group, pc.field));
  }
  function weightLine(ctx, group, rec) {
    var names = ctx.f.weight || ['weightKg'];
    for (var i = 0; i < names.length; i++) {
      if (typeof rec[names[i]] === 'number') {
        return line('Weighs ' + rec[names[i]] + ' kg.', [{ group: group, id: rec.id, field: names[i], value: rec[names[i]] }], 'rule', src(group, names[i]));
      }
    }
    return null;
  }
  function gateLine(ctx, group, rec) {
    var g = gateOf(ctx, rec);
    if (!g) return null;
    if (g.kind === 'account') {
      return line('Opens at WARDOG level ' + g.level + '.', [{ group: group, id: rec.id, field: g.field, value: g.raw }], 'rule', src(group, g.field));
    }
    return line('Opens at ' + g.raw + '. That is a class track, not your account level, and this tab has no way to read it - check it in game before you count on this pick.',
      [{ group: group, id: rec.id, field: g.field, value: g.raw }], 'rule', src(group, g.field));
  }
  function unlockLine(ctx, group, rec) {
    var u = unlockOf(ctx, rec);
    if (!u) return null;
    /* "on top of that price" only reads correctly when a price was printed a
       line above. For the entries the source never priced, saying it anyway
       points at a figure that is not there. */
    var hasPrice = !!priceCite(ctx, group, rec);
    return line('Carries a one-time unlock of ' + money(u.value) +
      (hasPrice ? ' on top of that price.' : ', separate from whatever it costs to take into a match.'),
      [{ group: group, id: rec.id, field: u.field, value: u.value }], 'rule', src(group, u.field));
  }

  /* The outcome receipt. It is the ONLY line this engine emits of kind 'data',
     it is emitted only when the pick actually scored on the outcome term, and
     it always carries the sample. There is deliberately no branch that emits it
     without one: outcomeSample() returning null means the term scored zero, so
     the part this reads is never there. Today that is every call. */
  function outcomeLine(ctx, parts) {
    var s = outcomeSample(ctx);
    if (!s) return null;
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i].outcome) continue;
      return line('Kits carrying this come out ahead in the ' + s.label + ' behind this tab.', [], 'data',
        'data/analytics.json - matchOutcomes' + (s.source ? ' (' + s.source + ')' : ''), s.n, s.unit);
    }
    return null;
  }

  /* The "why this one" line. It names the tag that earned the pick and quotes
     the published field behind it - never a score, never a percentage. */
  function reasonLine(ctx, group, rec, tagId, wv, omitFields) {
    var tag = ctx.tagById[tagId];
    if (!tag) return null;
    var cite = tag.cite || {};
    var field = cite.field;
    /* Do not re-print a figure a line above already printed. The cost line
       always leads, so a "costs little" reason says why without repeating the
       price - and carries no cite, because it now carries no number. */
    if (field && !cite.join && omitFields && omitFields.indexOf(field) !== -1) field = null;
    var value = null, citeGroup = group, citeId = rec.id;
    if (cite.join) {
      var j = joinTarget(ctx, group, rec, cite.join);
      if (!j) return null;
      value = j.rec[field];
      citeGroup = j.group; citeId = j.rec.id;
    } else if (field) {
      value = rec[field];
    }
    var who = [];
    var gs = (wv.byGoal[tagId] || []);
    for (var i = 0; i < gs.length; i++) {
      var goal = ctx.goalById[gs[i]];
      if (goal && who.indexOf(goal.label) === -1) who.push(goal.label);
    }
    var lead = tag.label.charAt(0).toUpperCase() + tag.label.slice(1);
    var suffix = who.length ? ' - which is what "' + who.join('" and "') + '" asks for.' : '.';
    if (value === undefined || value === null || value === '') {
      return line(lead + suffix, [], 'goal');
    }
    var shown = Array.isArray(value) ? value.join(', ') : String(value);
    var label = ((ctx.an.fieldLabels || {})[field] || field);
    return line(lead + ' (' + label + ' ' + shown + ')' + suffix,
      [{ group: citeGroup, id: citeId, field: field, value: value }], 'goal', src(citeGroup, field));
  }

  /* A counter line is only printed when the pick ACTUALLY scored on a tag that
     enemy condition boosts - measured against the real slot pool, not asserted.
     Otherwise every optic would claim to answer snipers. */
  function counterLines(ctx, input, parts, key, wv) {
    var out = [];
    var scored = {};
    for (var p = 0; p < parts.length; p++) if (parts[p].contrib > 0 && parts[p].tag) scored[parts[p].tag] = true;
    var preferredBy = (wv.preferBy && wv.preferBy[key]) || [];
    var done = {};
    for (var i = 0; i < input.enemyMatches.length; i++) {
      var m = input.enemyMatches[i];
      var cond = ctx.enemyRuleById[m.ruleId];
      if (!cond || done[cond.id]) continue;
      var hit = preferredBy.indexOf(cond.id) !== -1;
      if (!hit) {
        var keys = Object.keys(cond.weights || {}).sort();
        for (var k = 0; k < keys.length; k++) if (scored[keys[k]]) { hit = true; break; }
      }
      if (!hit) continue;
      done[cond.id] = true;
      /* Name the actual entity the player listed, not an abstraction. */
      out.push(line('Answers the ' + m.name + ' you listed, which is ' + cond.label + '. ' + cond.because,
        [{ group: m.key.slice(0, m.key.indexOf(':')), id: m.key.slice(m.key.indexOf(':') + 1), field: 'name', value: m.name }],
        'counter'));
    }
    return out;
  }

  /* --------------------------------------------------------------- solving */

  /* A total order over scored parts needs one key per part shape. '~' sorts
     after every tag id and every group:id key, so the outcome part is last on a
     tie without ever colliding with a real one. */
  function partKey(p) {
    if (p.tag) return str(p.tag);
    if (p.prefer) return str(p.prefer);
    return p.outcome ? '~outcome' : '~';
  }

  function candidateScore(ctx, group, rec, wv, stats) {
    var total = 0, parts = [];
    for (var i = 0; i < wv.tagIds.length; i++) {
      var tag = ctx.tagById[wv.tagIds[i]];
      if (!tag) continue;
      var s = tagScore(ctx, group, rec, tag, stats);
      if (s <= 0) continue;
      var contrib = s * wv.w[tag.id];
      total += contrib;
      parts.push({ tag: tag.id, contrib: contrib });
    }
    var pk = wv.prefer && wv.prefer[group + ':' + rec.id];
    if (typeof pk === 'number') { total += pk; parts.push({ tag: null, prefer: group + ':' + rec.id, contrib: pk }); }
    /* The win-rate term. Empty by declaration while no outcome source exists -
       it adds nothing and prints nothing. When one does exist it becomes a
       scored PART like any other, so build() can print it with its sample size
       instead of it moving the ranking off the receipt. */
    var mt = matchOutcomeTerm(ctx, group, rec);
    if (mt !== 0) { total += mt; parts.push({ tag: null, outcome: true, contrib: mt }); }
    parts.sort(function (a, b) {
      if (b.contrib !== a.contrib) return b.contrib - a.contrib;
      var ak = partKey(a), bk = partKey(b);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    return { score: total, parts: parts };
  }

  /* THE SAMPLE SIZE IS PART OF THE TERM, NOT A LABEL BOLTED ONTO IT.
     L2 wants each candidate scored partly by its win-rate lift WITH a sample
     size. Those are one thing, not two: builds.js DROPS a receipt of kind
     'data' that arrives without a finite n, so a lift the tab is forbidden to
     explain would move picks invisibly - a hidden number, which is the one
     thing this engine exists not to produce. So an outcome model that declares
     itself available without publishing how many matches it rests on scores
     NOTHING and is reported, rather than quietly steering the build.
     Returns null when there is no usable sample - which is every call today,
     because WARDOGS is pre-release and matchOutcomes.available is false. */
  function outcomeSample(ctx) {
    var mo = ctx.an.matchOutcomes || {};
    if (!mo.available) return null;
    var n = num(mo.samples);
    if (n === null || n < 1) return null;
    return {
      n: Math.floor(n),
      unit: str(mo.sampleUnit) || 'matches',
      source: str(mo.source),
      label: str(mo.label) || 'match outcomes'
    };
  }
  function matchOutcomeTerm(ctx, group, rec) {
    var mo = ctx.an.matchOutcomes || {};
    if (!mo.available || !outcomeSample(ctx)) return 0;
    var w = ((ctx.an.tuning || {}).weights || {}).matchOutcomeWeight;
    var lift = ((mo.lift || {})[group + ':' + rec.id]);
    if (typeof lift !== 'number') return 0;
    return lift * (typeof w === 'number' ? w : 1);
  }

  function rankPool(ctx, pool, wv) {
    var stats = poolStats(ctx, pool, wv.tagIds);
    var ranked = [];
    for (var i = 0; i < pool.length; i++) {
      var c = candidateScore(ctx, pool[i].group, pool[i].rec, wv, stats);
      var p = priceOf(ctx, pool[i].rec);
      ranked.push({
        group: pool[i].group, rec: pool[i].rec, score: c.score, parts: c.parts,
        price: p, priceForSort: p === null ? 0 : p
      });
    }
    ranked.sort(bySlotRank);
    return ranked;
  }

  function slotCount(ctx, slot, input, state) {
    if (typeof slot.count === 'number') return slot.count;
    if (slot.count === 'backpackSlings') {
      var bp = state.picks.backpack && state.picks.backpack[0];
      if (!bp) return 0;
      var n = num(bp.rec.slingSlots);
      return n === null ? 0 : n;
    }
    if (slot.count === 'vestQuickSlots') {
      var v = state.picks.vest && state.picks.vest[0];
      if (!v) return 0;
      var cap = (ctx.an.vestQuickSlots || {})[v.rec.id];
      if (typeof cap === 'number') return cap;
      /* The source describes this vest's quick slots in words, not a number.
         The engine does not invent one; it fills up to a stated ceiling and the
         receipt says so. */
      var lim = ((ctx.an.tuning || {}).limits || {}).maxQuickWhenUncapped;
      return typeof lim === 'number' ? lim : 0;
    }
    if (slot.count === 'optional') return input.includeVehicle ? 1 : 0;
    return 0;
  }

  function spendOf(state) {
    var total = 0;
    var ids = Object.keys(state.picks).sort();
    for (var i = 0; i < ids.length; i++) {
      var list = state.picks[ids[i]];
      for (var j = 0; j < list.length; j++) if (typeof list[j].price === 'number') total += list[j].price;
    }
    return total;
  }
  function totalScore(state) {
    var total = 0;
    var ids = Object.keys(state.picks).sort();
    for (var i = 0; i < ids.length; i++) {
      var list = state.picks[ids[i]];
      for (var j = 0; j < list.length; j++) total += list[j].score;
    }
    return total;
  }

  function alreadyPicked(state, group, id) {
    var ids = Object.keys(state.picks);
    for (var i = 0; i < ids.length; i++) {
      var list = state.picks[ids[i]];
      for (var j = 0; j < list.length; j++) if (list[j].group === group && list[j].rec.id === id) return true;
    }
    return false;
  }

  function solve(ctx, input, wv, opts) {
    var slots = ctx.an.slots || [];
    var state = { picks: {}, locked: {}, unfilled: [], notes: [] };
    var i, j;

    /* 1. LOCKS FIRST. A locked core item is a hard constraint, exactly like the
       budget - the rest of the build is solved around it. Locks are placed in
       SLOT publication order, not the order the player tapped them, so a locked
       rifle is already in place when a locked magazine is tested for fit: a lock
       the game would refuse is reported, never silently shipped. */
    if (!opts.ignoreLocks) {
      var pending = [];
      for (i = 0; i < input.locks.length; i++) {
        var lk = input.locks[i];
        var hit = ctx.byKey[lk];
        if (!hit) { state.notes.push({ kind: 'lock-unknown', key: lk }); continue; }
        var slot = slotForRecord(ctx, hit.group, hit.rec, input, state);
        if (!slot) { state.notes.push({ kind: 'lock-no-slot', key: lk }); continue; }
        pending.push({ order: slots.indexOf(slot), slot: slot, hit: hit, key: lk });
      }
      pending.sort(function (a, b) { return a.order - b.order || (a.key < b.key ? -1 : 1); });
      for (i = 0; i < pending.length; i++) {
        var pd = pending[i];
        if (!meetsGate(ctx, pd.hit.rec, input)) { state.notes.push({ kind: 'lock-above-level', key: pd.key }); continue; }
        if (!legal(ctx, pd.slot, pd.hit.group, pd.hit.rec, input, state)) { state.notes.push({ kind: 'lock-illegal', key: pd.key }); continue; }
        state.picks[pd.slot.id] = state.picks[pd.slot.id] || [];
        var pr = priceOf(ctx, pd.hit.rec);
        state.picks[pd.slot.id].push({
          group: pd.hit.group, rec: pd.hit.rec, score: 0, parts: [],
          price: pr, priceForSort: pr === null ? 0 : pr, locked: true
        });
        state.locked[pd.slot.id] = (state.locked[pd.slot.id] || 0) + 1;
      }
    }

    /* 2. GREEDY, in the slot order analytics publishes - a slot whose legality
       depends on another always comes after it. */
    for (i = 0; i < slots.length; i++) {
      fillSlot(ctx, slots[i], input, wv, state);
    }

    /* 3. SWAP PASS. Try every legal alternative in every slot; take any strict
       improvement that still fits the budget. Repeats to a fixed point or the
       published pass cap, so the run always terminates and always identically. */
    var maxPasses = ((ctx.an.tuning || {}).limits || {}).maxSwapPasses;
    if (typeof maxPasses !== 'number') maxPasses = 1;
    for (var pass = 0; pass < maxPasses; pass++) {
      var changed = false;
      for (i = 0; i < slots.length; i++) {
        if (swapSlot(ctx, slots[i], input, wv, state)) changed = true;
      }
      if (!changed) break;
    }
    return state;
  }

  /* Which slot would accept this record? First match in publication order, so a
     lock lands in the same slot every time. */
  function slotForRecord(ctx, group, rec, input, state) {
    var slots = ctx.an.slots || [];
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if ((s.groups || []).indexOf(group) === -1) continue;
      if (s.categories && s.categories.indexOf(rec.category) === -1) continue;
      return s;
    }
    return null;
  }

  function fillSlot(ctx, slot, input, wv, state) {
    var want = slotCount(ctx, slot, input, state);
    state.picks[slot.id] = state.picks[slot.id] || [];
    var have = state.picks[slot.id].length;
    if (have >= want) {
      /* More picks than the game gives slots - only possible from locks. The
         extras are dropped and REPORTED. Keeping them would print a loadout the
         game would refuse, which the spec calls a bug rather than a suggestion. */
      if (have > want) {
        var cut = state.picks[slot.id].slice(want);
        state.picks[slot.id] = state.picks[slot.id].slice(0, want);
        for (var d = 0; d < cut.length; d++) {
          state.notes.push({ kind: 'lock-no-room', key: cut[d].group + ':' + cut[d].rec.id, slot: slot.id, label: slot.label });
        }
      }
      rescoreSlot(ctx, slot, input, wv, state);
      return;
    }
    var pool = slotPool(ctx, slot, input, state);
    if (!pool.length) {
      if (want > 0) state.unfilled.push({ slot: slot.id, label: slot.label, why: 'no-legal-candidate' });
      return;
    }
    var ranked = rankPool(ctx, pool, wv);
    var spend = spendOf(state);
    /* WHY a slot came back short is a fact, not a guess. `costBlocked` records
       that at least one otherwise-legal candidate was turned away on price, so
       the "your budget ran out" reason is only ever printed when a budget
       actually did the turning away. Everything else - a pool already emptied
       by picks in other slots - gets its own reason. */
    var costBlocked = false;
    for (var i = 0; i < ranked.length && state.picks[slot.id].length < want; i++) {
      var c = ranked[i];
      if (alreadyPicked(state, c.group, c.rec.id)) continue;
      var cost = typeof c.price === 'number' ? c.price : 0;
      if (!affordable(input, spend, cost)) { costBlocked = true; continue; }
      state.picks[slot.id].push(c);
      spend += cost;
    }
    if (state.picks[slot.id].length < want) {
      /* Required slots never come back empty on budget alone while a free legal
         option exists - the game lets you deploy with the starter kit. */
      for (var k = ranked.length - 1; k >= 0 && state.picks[slot.id].length < want; k--) {
        var cheap = ranked[k];
        if (alreadyPicked(state, cheap.group, cheap.rec.id)) continue;
        var cc = typeof cheap.price === 'number' ? cheap.price : 0;
        if (!affordable(input, spend, cc)) { costBlocked = true; continue; }
        state.picks[slot.id].push(cheap);
        spend += cc;
      }
    }
    if (state.picks[slot.id].length < want) {
      state.unfilled.push({
        slot: slot.id,
        label: slot.label,
        why: (costBlocked && hasBudget(input)) ? 'budget' : 'pool-exhausted'
      });
    }
    rescoreSlot(ctx, slot, input, wv, state);
  }

  /* A locked pick enters with score 0 because it was placed before its pool
     existed. Rescore it against its real pool so the totals and the swap pass
     compare like with like. */
  function rescoreSlot(ctx, slot, input, wv, state) {
    var list = state.picks[slot.id] || [];
    if (!list.length) return;
    var pool = slotPool(ctx, slot, input, state);
    var ranked = rankPool(ctx, pool, wv);
    var byId = {};
    for (var i = 0; i < ranked.length; i++) byId[ranked[i].group + ':' + ranked[i].rec.id] = ranked[i];
    for (var j = 0; j < list.length; j++) {
      var m = byId[list[j].group + ':' + list[j].rec.id];
      if (m) { list[j].score = m.score; list[j].parts = m.parts; }
    }
  }

  function swapSlot(ctx, slot, input, wv, state) {
    var list = state.picks[slot.id] || [];
    if (!list.length) return false;
    var pool = slotPool(ctx, slot, input, state);
    if (pool.length < 2) return false;
    var ranked = rankPool(ctx, pool, wv);
    var changed = false;
    for (var idx = 0; idx < list.length; idx++) {
      if (list[idx].locked) continue;
      var cur = list[idx];
      var best = cur, bestScore = cur.score;
      for (var i = 0; i < ranked.length; i++) {
        var c = ranked[i];
        if (c.rec.id === cur.rec.id && c.group === cur.group) continue;
        if (alreadyPicked(state, c.group, c.rec.id)) continue;
        if (c.score <= bestScore) continue;
        var spend = spendOf(state) - (typeof cur.price === 'number' ? cur.price : 0);
        var cost = typeof c.price === 'number' ? c.price : 0;
        if (!affordable(input, spend, cost)) continue;
        best = c; bestScore = c.score;
      }
      if (best !== cur) {
        list[idx] = best;
        changed = true;
        /* A parent slot decides its dependants' legality and count, so anything
           downstream is rebuilt rather than left pointing at the old parent. */
        if (dependantsOf(ctx, slot.id).length) rebuildDependants(ctx, slot.id, input, wv, state);
      }
    }
    return changed;
  }

  function dependantsOf(ctx, slotId) {
    var out = [];
    var slots = ctx.an.slots || [];
    for (var i = 0; i < slots.length; i++) if (slots[i].dependsOn === slotId) out.push(slots[i]);
    return out;
  }
  function rebuildDependants(ctx, slotId, input, wv, state) {
    var deps = dependantsOf(ctx, slotId);
    for (var i = 0; i < deps.length; i++) {
      var d = deps[i];
      var keepLocked = (state.picks[d.id] || []).filter(function (p) { return p.locked; });
      state.picks[d.id] = keepLocked;
      state.unfilled = state.unfilled.filter(function (u) { return u.slot !== d.id; });
      fillSlot(ctx, d, input, wv, state);
      rebuildDependants(ctx, d.id, input, wv, state);
    }
  }

  /* ----------------------------------------------------------------- build */

  function normaliseInput(ctx, raw) {
    var an = ctx.an || {};
    var limits = (an.tuning || {}).limits || {};
    var maxGoals = typeof limits.maxGoals === 'number' ? limits.maxGoals : 3;
    var input = {
      role: low(raw && raw.role) || '',
      wardogLevel: 1,
      goals: [],
      enemy: [],
      enemyMatches: [],
      enemyUnmatched: [],
      locks: [],
      budget: null,
      includeVehicle: false,
      onlyOwned: !!(raw && raw.onlyOwned),
      ownedUnlocks: {}
    };
    var own = (raw && raw.ownedUnlocks) || {};
    var owk = Object.keys(own).sort();
    for (var o = 0; o < owk.length; o++) if (own[owk[o]]) input.ownedUnlocks[owk[o]] = true;
    var lvl = num(raw && raw.wardogLevel);
    input.wardogLevel = lvl === null || lvl < 1 ? 1 : Math.floor(lvl);
    var gs = arr(raw && raw.goals);
    for (var g = 0; g < gs.length && input.goals.length < maxGoals; g++) {
      if (ctx.goalById[gs[g]] && input.goals.indexOf(gs[g]) === -1) input.goals.push(gs[g]);
    }
    /* The enemy roster arrives as REAL ENTITY KEYS - the vehicles, weapons and
       factions the player says the other side is fielding. Each one is matched
       against the published rules, and the match carries the entity's own name
       so a receipt can say "answers the L2A6 you listed" rather than an
       abstraction. An entity that trips no rule is kept and reported, never
       silently ignored. */
    var es = arr(raw && raw.enemy);
    for (var e = 0; e < es.length; e++) {
      var k = es[e];
      if (!ctx.byKey[k] || input.enemy.indexOf(k) !== -1) continue;
      input.enemy.push(k);
      var hit = ctx.byKey[k];
      var matched = false;
      for (var r = 0; r < ctx.enemyRules.length; r++) {
        var rule = ctx.enemyRules[r];
        if (!rule.when || rule.when.group !== hit.group) continue;
        if (rule.when.field) {
          var re = new RegExp(rule.when.matches, 'i');
          if (!re.test(str(hit.rec[rule.when.field]))) continue;
        }
        input.enemyMatches.push({ ruleId: rule.id, key: k, name: hit.rec.name || hit.rec.id });
        matched = true;
      }
      if (!matched) input.enemyUnmatched.push({ key: k, name: hit.rec.name || hit.rec.id });
    }
    input.enemyMatches.sort(function (a, b) {
      if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    var ls = arr(raw && raw.locks);
    for (var l = 0; l < ls.length; l++) {
      if (ctx.byKey[ls[l]] && input.locks.indexOf(ls[l]) === -1) input.locks.push(ls[l]);
    }
    /* A vehicle is bought separately from a loadout, so the vehicle slot only
       fills when the player has explicitly put one in Must include. Nothing
       else turns it on - guessing that they wanted one would spend their money
       for them. */
    for (var v = 0; v < input.locks.length; v++) {
      var lg = input.locks[v].slice(0, input.locks[v].indexOf(':'));
      for (var q = 0; q < (ctx.an.slots || []).length; q++) {
        var sq = ctx.an.slots[q];
        if (sq.count === 'optional' && (sq.groups || []).indexOf(lg) !== -1) input.includeVehicle = true;
      }
    }
    /* A CAP EXISTS ONLY WHEN A FINITE NUMBER WAS GIVEN.
       null, undefined, '', Infinity and anything unparseable all mean "the
       player named no limit", and are kept as null rather than coerced to a
       number. A cap of $0 is still a real, honourable cap - the player typed a
       zero - so it is distinguished from having typed nothing. A negative
       figure is clamped to $0 because you cannot owe the armoury. */
    var rawB = raw ? raw.budget : null;
    if (rawB === null || rawB === undefined || rawB === '' || rawB === true || rawB === false) {
      input.budget = null;
    } else {
      var b = num(rawB);
      input.budget = b === null ? null : (b < 0 ? 0 : Math.floor(b));
    }
    return input;
  }

  function build(ctx, rawInput) {
    var input = normaliseInput(ctx, rawInput);
    var wv = weightVector(ctx, input);
    var mo = ctx.an.matchOutcomes || {};

    var state = solve(ctx, input, wv, { ignoreLocks: false });

    /* What the locks cost. Solved a second time with the locks removed, and the
       two builds diffed - so "this lock cost you X" is a measured difference,
       not an assertion. */
    var free = input.locks.length ? solve(ctx, input, wv, { ignoreLocks: true }) : null;

    var out = {
      ok: true,
      ruling: ctx.an.ruling,
      matchOutcomes: {
        available: !!mo.available,
        why: mo.why || '',
        rule: mo.rule || ''
      },
      freshness: { pulledAt: ctx.an.pulledAt, version: ctx.an.pulledAtVersion },
      input: input,
      slots: [],
      unfilled: state.unfilled.slice(),
      notes: state.notes.slice(),
      unanswered: [],
      inert: [],
      totals: null,
      warnings: []
    };

    var slots = ctx.an.slots || [];
    var spend = 0, weight = 0, unlockOwed = 0, unpriced = 0;
    var spendCites = [], weightCites = [], unlockCites = [];

    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var list = state.picks[slot.id] || [];
      var want = slotCount(ctx, slot, input, state);
      if (!list.length && !want) continue;
      var entry = { slotId: slot.id, label: slot.label, want: want, picks: [] };

      if (slot.count === 'vestQuickSlots') {
        var vest = state.picks.vest && state.picks.vest[0];
        var cap = vest ? (ctx.an.vestQuickSlots || {})[vest.rec.id] : undefined;
        if (vest && typeof cap !== 'number') {
          entry.note = 'The source describes this vest\'s quick slots in words rather than a count, so this list is not capped by a published number.';
        }
      }

      for (var j = 0; j < list.length; j++) {
        var p = list[j];
        var lines = [];
        var cl = costLine(ctx, p.group, p.rec); lines.push(cl);
        if (!cl.cites.length) unpriced++;
        var gl = gateLine(ctx, p.group, p.rec); if (gl) lines.push(gl);
        var ul = unlockLine(ctx, p.group, p.rec); if (ul) lines.push(ul);
        var ol = outcomeLine(ctx, p.parts); if (ol) lines.push(ol);
        var top = p.parts.slice(0, 2);
        for (var t = 0; t < top.length; t++) {
          if (!top[t].tag) continue; /* a named preference speaks for itself in its counter line */
          var rl = reasonLine(ctx, p.group, p.rec, top[t].tag, wv, (ctx.f.price || ['price']).concat(ctx.f.weight || ['weightKg']));
          if (rl) lines.push(rl);
        }
        var cls_ = counterLines(ctx, input, p.parts, p.group + ':' + p.rec.id, wv);
        for (var c = 0; c < cls_.length; c++) lines.push(cls_[c]);
        var wl = weightLine(ctx, p.group, p.rec); if (wl) lines.push(wl);
        if (!top.length && !p.locked) {
          lines.push(line('Nothing you asked for points at this slot, so this is the cheapest legal option rather than a recommendation.', [], 'note'));
        }

        var lockCost = null;
        if (p.locked && free) lockCost = lockCostFor(ctx, slot, p, state, free, input, wv);

        entry.picks.push({
          key: p.group + ':' + p.rec.id,
          group: p.group,
          id: p.rec.id,
          name: p.rec.name || p.rec.term || p.rec.id,
          category: p.rec.category || '',
          icon: p.rec.icon || '',
          locked: !!p.locked,
          price: typeof p.price === 'number' ? p.price : null,
          lines: lines,
          lockCost: lockCost
        });

        if (typeof p.price === 'number') {
          spend += p.price;
          spendCites.push({ group: p.group, id: p.rec.id, field: priceCite(ctx, p.group, p.rec).field, value: p.price });
        }
        var wn = weightOf(ctx, p.rec);
        if (wn !== null) {
          weight += wn;
          weightCites.push({ group: p.group, id: p.rec.id, field: (ctx.f.weight || ['weightKg'])[0], value: wn });
        }
        var uo = unlockOf(ctx, p.rec);
        if (uo && !input.ownedUnlocks[p.group + ':' + p.rec.id]) {
          unlockOwed += uo.value;
          unlockCites.push({ group: p.group, id: p.rec.id, field: uo.field, value: uo.value });
        }
      }
      out.slots.push(entry);
    }

    out.totals = {
      spend: spend,
      spendLine: line('This kit costs ' + money(spend) + ' to put on the ground.', spendCites, 'rule'),
      budget: input.budget,
      budgetLine: hasBudget(input)
        ? line('Your budget was ' + money(input.budget) + '.', [], 'note')
        : line('You set no cash limit, so nothing here was left out on price.', [], 'note'),
      remaining: hasBudget(input) ? input.budget - spend : null,
      weight: round2(weight),
      weightLine: line('It weighs ' + round2(weight) + ' kg in total.', weightCites, 'rule'),
      unlockOwed: unlockOwed,
      unlockLine: unlockOwed > 0
        ? line('On top of that, ' + money(unlockOwed) + ' of one-time unlocks are owed on picks you have not marked as owned.', unlockCites, 'rule')
        : null,
      unpriced: unpriced,
      unpricedLine: unpriced > 0
        ? line('The source publishes no price for ' + unpriced + ' of these picks, so the cash total is a floor, not the full bill.', [], 'note')
        : null
    };

    /* AN ENEMY NOTHING IN THIS KIT ANSWERS.
       A counter adjustment can be outbid - one specialization slot, two threats
       - and the quiet failure mode is a build that looks like it covered the
       roster because the roster was on screen. So every matched rule that no
       pick scored against is said out loud, naming the entity the player
       listed. Nothing here is invented: the check is whether any pick's own
       scored tags overlap the rule's, measured on the finished build. */
    var answered = {};
    for (var si = 0; si < out.slots.length; si++) {
      var sl2 = state.picks[out.slots[si].slotId] || [];
      for (var pi = 0; pi < sl2.length; pi++) {
        var prt = sl2[pi].parts || [];
        for (var qi = 0; qi < prt.length; qi++) {
          if (prt[qi].contrib > 0 && prt[qi].tag) answered[prt[qi].tag] = true;
          if (prt[qi].prefer) answered['#' + prt[qi].prefer] = true;
        }
      }
    }
    var reported = {};
    for (var em = 0; em < input.enemyMatches.length; em++) {
      var mm = input.enemyMatches[em];
      var rr = ctx.enemyRuleById[mm.ruleId];
      if (!rr || reported[rr.id]) continue;
      var wkeys = Object.keys(rr.weights || {});
      if (!wkeys.length && !rr.prefer) {
        /* A rule with no weights cannot go "unanswered" - it was never going to
           move a pick. But the player ticked something and deserves to be told
           it changed nothing, rather than left to assume it did. */
        reported[rr.id] = true;
        out.inert.push({ ruleId: rr.id, key: mm.key, name: mm.name, because: rr.because });
        continue;
      }
      var covered = false;
      for (var wi = 0; wi < wkeys.length; wi++) if (answered[wkeys[wi]]) { covered = true; break; }
      if (!covered && rr.prefer && answered['#' + rr.prefer.key]) covered = true;
      if (covered) { reported[rr.id] = true; continue; }
      reported[rr.id] = true;
      out.unanswered.push({ ruleId: rr.id, key: mm.key, name: mm.name, label: rr.label, because: rr.because });
    }

    /* THE UNBOUNDED-BUDGET INVARIANT, CHECKED RATHER THAN ASSUMED.
       With no cap, affordable() can never turn a candidate away, so no slot can
       be short "on budget" and no total can be over one. This is the exact
       claim the shipped bug violated while every unit above it looked correct,
       so it is re-tested on the finished result: if it ever fails, the
       misleading reason is replaced with the honest one and the result carries
       a warning, instead of the tab telling a player with no limit that their
       budget ran out. */
    if (!hasBudget(input)) {
      for (var bz = 0; bz < out.unfilled.length; bz++) {
        if (out.unfilled[bz].why === 'budget') {
          out.unfilled[bz].why = 'pool-exhausted';
          if (out.warnings.indexOf('budget-reason-without-a-budget') === -1) {
            out.warnings.push('budget-reason-without-a-budget');
          }
        }
      }
    }

    if (hasBudget(input) && spend > input.budget) out.warnings.push('over-budget');
    if (hasBudget(input) && unlockOwed > input.budget) out.warnings.push('unlocks-exceed-budget');
    if (!input.goals.length) out.warnings.push('no-goals');
    if (!mo.available) out.warnings.push('no-match-outcome-data');
    /* A model that says it has outcomes but publishes no sample size is a
       louder failure than having none at all, because it looks like the L2 term
       is live. It scores nothing (see matchOutcomeTerm) and it says so. */
    if (mo.available && !outcomeSample(ctx)) out.warnings.push('outcome-model-without-a-sample');

    return out;
  }

  /* What a lock cost, measured: the runner-up it displaced in its own slot, the
     price difference, and anything the unlocked build could afford that this
     one could not. */
  function lockCostFor(ctx, slot, pick, state, free, input, wv) {
    var alt = (free.picks[slot.id] || [])[0];
    var out = { runnerUp: null, priceDelta: null, dropped: [], lines: [] };
    if (alt && !(alt.group === pick.group && alt.rec.id === pick.rec.id)) {
      out.runnerUp = { key: alt.group + ':' + alt.rec.id, name: alt.rec.name || alt.rec.id };
      if (typeof pick.price === 'number' && typeof alt.price === 'number') {
        out.priceDelta = pick.price - alt.price;
        var d = out.priceDelta;
        var verb = d > 0 ? 'more' : d < 0 ? 'less' : 'the same as';
        out.lines.push(line(
          'Locking this took the slot from ' + alt.rec.name + ', which is what the numbers picked on their own, and ' +
          (d === 0 ? 'costs the same.' : 'costs ' + money(Math.abs(d)) + ' ' + verb + '.'),
          [
            { group: alt.group, id: alt.rec.id, field: 'name', value: alt.rec.name }
          ].concat(d === 0 ? [] : [
            { group: pick.group, id: pick.rec.id, field: priceCite(ctx, pick.group, pick.rec).field, value: pick.price },
            { group: alt.group, id: alt.rec.id, field: priceCite(ctx, alt.group, alt.rec).field, value: alt.price }
          ]), 'lock', src(pick.group, 'price')
        ));
      } else {
        out.lines.push(line('Locking this took the slot from ' + alt.rec.name + ', which is what the numbers picked on their own.',
          [{ group: alt.group, id: alt.rec.id, field: 'name', value: alt.rec.name }], 'lock'));
      }
    }
    /* Slots the unlocked build filled and this one could not. */
    var slots = ctx.an.slots || [];
    for (var i = 0; i < slots.length; i++) {
      var sid = slots[i].id;
      var mine = (state.picks[sid] || []).length;
      var theirs = (free.picks[sid] || []).length;
      if (theirs > mine) {
        var lost = (free.picks[sid] || [])[mine];
        if (lost) out.dropped.push({ slot: sid, label: slots[i].label, group: lost.group, id: lost.rec.id, name: lost.rec.name || lost.rec.id });
      }
    }
    if (out.dropped.length) {
      var names = [], cites = [];
      for (var d2 = 0; d2 < out.dropped.length; d2++) {
        names.push(out.dropped[d2].name + ' in the ' + out.dropped[d2].label.toLowerCase() + ' slot');
        cites.push({ group: out.dropped[d2].group, id: out.dropped[d2].id, field: 'name', value: out.dropped[d2].name });
      }
      out.lines.push(line('Paying for it left no room for ' + names.join(', ') + '.', cites, 'lock'));
    }
    return out;
  }

  var WDGenEngine = {
    prepare: prepare,
    build: build,
    /* exported for the gate and for the UI's pool previews */
    _internals: {
      gateOf: gateOf, meetsGate: meetsGate, slotPool: slotPool, rankPool: rankPool,
      weightVector: weightVector, priceOf: priceOf, weightOf: weightOf, unlockOf: unlockOf,
      slotCount: slotCount, money: money,
      /* exported so a gate can assert the sample-size rule and the optional
         budget directly, instead of inferring them from a finished build */
      outcomeSample: outcomeSample, affordable: affordable, hasBudget: hasBudget,
      normaliseInput: normaliseInput, toReceipts: toReceipts
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = WDGenEngine;
  root.WDGenEngine = WDGenEngine;

  /* ==================================================================== */
  /*  THE BUILDS-TAB ADAPTER                                              */
  /* ==================================================================== */
  /*
   * Everything above is the pure engine and knows nothing about the app. This
   * last section is the thin shim that meets the contract published in the
   * header of js/builds.js: it sets window.WD_ENGINE, translates that tab's
   * brief into the engine's input, and translates the engine's result back.
   *
   * It runs only in a browser. In Node (the gate) `document` is absent and this
   * whole block is skipped, so validate.mjs exercises the engine itself rather
   * than a shim around it.
   *
   * basis: NULL as it stands, and null BECAUSE OF THE DATA rather than because
   * of this literal. The contract makes a sample size mandatory the moment an
   * engine names what its numbers rest on, and this engine's numbers rest on a
   * static stat page with no match outcomes behind it, so declaring a basis
   * today would be a lie the tab would also reject. warm() therefore RECOMPUTES
   * this from analytics.matchOutcomes every load: null while there is no sample,
   * and a real {label, n, nUnit, pulledAt} the moment one exists. On today's
   * data no receipt of kind 'data' is emitted at all, so none can carry a
   * percentage; and toReceipts() drops any that ever arrives without an n.
   */
  if (typeof document === 'undefined' || typeof fetch !== 'function') return;

  var ENGINE_VERSION = '1.0.0';
  var ANALYTICS_URL = '/island/apps/wardogs/data/analytics.json';
  var pending = null;   /* Promise<ctx>, memoised - the rule model is fetched once */
  var loaded = null;    /* the resolved ctx, once it exists */

  /* app.js is a classic script, so its top-level `S` is reachable here by bare
     name - the same seam js/builds.js uses. If app.js failed to parse there is
     nothing to build against. */
  function appGroups() {
    if (typeof S === 'undefined' || !S || !S.groups) return null;
    return S.groups;
  }

  function ready() {
    if (loaded) return Promise.resolve(loaded);
    if (pending) return pending;
    pending = fetch(ANALYTICS_URL, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('analytics.json returned ' + r.status);
      return r.json();
    }).then(function (an) {
      var g = appGroups();
      if (!g) throw new Error('the dataset has not finished loading');
      loaded = { ctx: prepare(g, an), an: an };
      return loaded;
    }).catch(function (err) {
      pending = null;   /* a failed fetch must be retryable, not sticky */
      throw err;
    });
    return pending;
  }

  /* Warm the rule model as soon as app.js's fetch has landed, so the first tap
     on Generate does not also pay for one, and so the tab's goal chips can be
     replaced by the ones the scorer actually weights.
     This POLLS rather than hooking app.js, because the engine loads last and
     app.js's data fetch is async - there is no event to listen for that does
     not mean editing app.js, and this lane does not own that file. The poll is
     bounded, stops the moment it succeeds, and costs nothing if it never does:
     generate() loads the model itself and reports properly on failure. */
  var warmTries = 0;
  function warm() {
    if (loaded) return;
    if (!appGroups() || !Object.keys(appGroups()).length) {
      if (++warmTries > 80) return;      /* ~10s, then give up quietly */
      setTimeout(warm, 125);
      return;
    }
    ready().then(function (L) {
      var gs = (L.an.goals || []), out = [];
      for (var i = 0; i < gs.length; i++) out.push({ id: gs[i].id, label: gs[i].label, help: gs[i].help || '' });
      root.WD_ENGINE.goals = out;
      /* BASIS - what the scoring rests on, declared FROM the rule model rather
         than typed here. It stays null while matchOutcomes is unavailable or
         carries no sample size, which is what the shipped dataset says today
         and why the tab prints "no match-outcome sample behind it". Reading it
         from the data means that sentence can never go stale as a literal: the
         day an outcome source with a real n lands, the tab names it and its
         sample with no edit to this file. */
      var os = outcomeSample(L.ctx);
      root.WD_ENGINE.basis = os
        ? { label: os.label, n: os.n, nUnit: os.unit, pulledAt: str(L.an.pulledAt) }
        : null;
      /* The tab reads window.WD_ENGINE on every repaint, so it only needs to be
         told to repaint - and only if the player is looking at it. */
      try {
        if (typeof S !== 'undefined' && S && S.view === 'builds' && typeof render === 'function') render();
      } catch (e) { /* a repaint is a nicety, never a failure */ }
    }).catch(function () { /* reported at generate time */ });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(warm, 0); });
  } else {
    setTimeout(warm, 0);
  }

  /* --------------------------------------------------------- translation */

  function toEngineInput(inp) {
    var locks = [];
    var i;
    /* The chosen primary is a lock like any other - it just came from a
       different picker. Putting it first makes it the one the rest is solved
       around, which is what a player choosing a weapon means. */
    if (inp && inp.weapon) locks.push(String(inp.weapon));
    if (inp && Array.isArray(inp.locks)) {
      for (i = 0; i < inp.locks.length; i++) if (locks.indexOf(inp.locks[i]) === -1) locks.push(String(inp.locks[i]));
    }
    var owned = {};
    if (inp && Array.isArray(inp.owned)) for (i = 0; i < inp.owned.length; i++) owned[inp.owned[i]] = true;
    return {
      wardogLevel: inp && inp.level,
      goals: (inp && inp.goals) || [],
      enemy: (inp && inp.enemy) || [],
      locks: locks,
      budget: inp && inp.budget,
      ownedUnlocks: owned
    };
  }

  /* kind 'data' is the contract's slot for a win-rate style claim, and the tab
     DROPS one that arrives without a sample size. The previous version of this
     function relabelled such a line as a 'rule' instead, which would have let a
     future unsampled claim walk straight past that gate wearing a different
     hat. It does not relabel any more: a 'data' line keeps its kind and carries
     its n, and one without an n is DROPPED here at the source with the reason
     recorded, so the rule is enforced on both sides of the seam. */
  function toReceipts(lines, dropped) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.kind === 'data' && !(typeof l.n === 'number' && isFinite(l.n) && l.n >= 1)) {
        if (dropped) dropped.push(l.text);
        continue;
      }
      var r = { kind: l.kind, text: l.text, source: l.source || '' };
      if (typeof l.n === 'number' && isFinite(l.n)) { r.n = l.n; r.nUnit = l.nUnit || 'matches'; }
      out.push(r);
    }
    return out;
  }

  function toContractResult(res, inp, ctx) {
    var build = [], order = 0, notes = [], i, j;
    var droppedClaims = [];

    for (i = 0; i < res.slots.length; i++) {
      var slot = res.slots[i];
      if (slot.note) notes.push(slot.label + ': ' + slot.note);
      for (j = 0; j < slot.picks.length; j++) {
        var p = slot.picks[j];
        order++;
        var row = {
          key: p.key,
          slot: slot.label,
          order: order,
          receipts: toReceipts(p.lines, droppedClaims)
        };
        if (p.locked && p.lockCost && p.lockCost.lines.length) {
          var txt = [];
          for (var t = 0; t < p.lockCost.lines.length; t++) txt.push(p.lockCost.lines[t].text);
          row.lock = {
            text: txt.join(' '),
            runnerUp: p.lockCost.runnerUp ? p.lockCost.runnerUp.key : null
          };
        } else if (p.locked) {
          row.lock = { text: 'You asked for this, and it cost nothing to include - it is what the numbers would have picked anyway.', runnerUp: null };
        }
        build.push(row);
      }
    }

    var unfilled = [];
    for (i = 0; i < res.unfilled.length; i++) {
      var u = res.unfilled[i];
      /* One reason per cause, and never the budget one unless a budget was set
         and actually turned a candidate away. */
      var reason;
      if (u.why === 'budget') reason = 'Your budget ran out before this slot.';
      else if (u.why === 'pool-exhausted') reason = 'The source lists nothing further for this slot that is not already in this kit.';
      else reason = 'Nothing the source lists can legally go here with the rest of this kit.';
      unfilled.push({ slot: u.label, reason: reason });
    }

    /* NOTES. Every one of these is a caveat about THIS result, and every one
       exists because the alternative was to let the tab imply something the
       data does not support. */
    if (!res.input.goals.length) {
      notes.push('You picked nothing for this kit to be for, so this is the cheapest legal loadout your level allows rather than a recommendation.');
    }
    if (res.totals.unpricedLine) notes.push(res.totals.unpricedLine.text);
    if (res.totals.unlockLine) notes.push(res.totals.unlockLine.text);
    if (droppedClaims.length) {
      notes.push(droppedClaims.length + (droppedClaims.length === 1 ? ' line was' : ' lines were') +
        ' left off the receipts because they made a win-rate style claim with no sample size behind them. Nothing here is scored on them.');
    }
    if (res.warnings.indexOf('outcome-model-without-a-sample') !== -1) {
      notes.push('The rule model says it has match-outcome data but does not say how many matches it rests on, so that term was ignored entirely and these picks are scored on published stats alone.');
    }
    if (res.warnings.indexOf('unlocks-exceed-budget') !== -1) {
      notes.push('Those one-time unlocks come to more than the cash you entered. They are a separate wall from the price, so a full wallet is not a full locker.');
    }

    var classGated = 0;
    for (i = 0; i < build.length; i++) {
      for (j = 0; j < build[i].receipts.length; j++) {
        if (build[i].receipts[j].text.indexOf('class track') !== -1) { classGated++; break; }
      }
    }
    if (classGated) {
      notes.push(classGated + (classGated === 1 ? ' pick sits' : ' picks sit') +
        ' behind a class track rather than your account level. Nothing here can read those, so they are shown with the requirement rather than hidden on a guess.');
    }

    for (i = 0; i < res.inert.length; i++) {
      notes.push('You listed ' + res.inert[i].name + '. ' + res.inert[i].because);
    }
    for (i = 0; i < res.unanswered.length; i++) {
      var ua = res.unanswered[i];
      notes.push('You listed the ' + ua.name + ' and nothing in this kit scored against it. ' + ua.because);
    }
    for (i = 0; i < res.input.enemyUnmatched.length; i++) {
      notes.push('Nothing the source publishes about ' + res.input.enemyUnmatched[i].name + ' changes what you should carry, so listing it moved no pick.');
    }
    for (i = 0; i < res.notes.length; i++) {
      var n = res.notes[i];
      var hit = ctx.byKey[n.key];
      var nm = hit ? (hit.rec.name || hit.rec.id) : n.key;
      if (n.kind === 'lock-illegal') {
        notes.push(nm + ' cannot legally go on the weapon this kit uses, so it was left out rather than printed as a loadout the game would refuse.');
      } else if (n.kind === 'lock-above-level') {
        notes.push(nm + ' is above your WARDOG level, so it was left out.');
      } else if (n.kind === 'lock-no-room') {
        notes.push(nm + ' had no slot left in the ' + String(n.label || '').toLowerCase() + ', so it was left out.');
      } else if (n.kind === 'lock-unknown' || n.kind === 'lock-no-slot') {
        notes.push(nm + ' is not something that goes into a loadout, so it was left out.');
      }
    }
    if (inp && inp.phase) {
      notes.push('This generator publishes no phase budgets - WARDOGS does not divide a match into buy phases - so only the cash figure was used.');
    }

    return {
      ok: true,
      build: build,
      totals: { cost: res.totals.spend, weight: res.totals.weight },
      unfilled: unfilled,
      notes: notes
    };
  }

  root.WD_ENGINE = {
    version: ENGINE_VERSION,
    basis: null,
    /* The tab's own intent chips are replaced by these, because these are the
       ones the scorer actually weights. A chip the engine ignores is worse than
       no chip. */
    /* Starts empty and is filled by warm() the moment the rule model lands. An
       empty list is the documented "engine declares no goals" case, so the tab
       shows its own chips until then rather than an empty picker. */
    goals: [],
    /* No phases. WARDOGS does not divide a match into buy phases, and inventing
       three budget tiers here would be three numbers with nothing behind them.
       The tab's own budget field, which it derives from real prices in the
       dataset, is the whole of the economy input. */
    phases: [],
    generate: function (inp) {
      return ready().then(function (L) {
        var res = build(L.ctx, toEngineInput(inp));
        return toContractResult(res, inp, L.ctx);
      }).catch(function (err) {
        return {
          ok: false,
          error: 'The loadout generator could not load its rule model (' +
            (err && err.message ? err.message : String(err)) +
            '). Everything else on this page still works; try again in a moment.'
        };
      });
    }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
