/* Deadlock L2 build generator - THE ENGINE (NEW-GAME-TEMPLATE section 9, depth L2).
 *
 * Stats-driven, deterministic, explainable. No simulator, no randomness, no clock.
 * Same inputs -> same build, always (tools/validate.mjs group GENERATOR runs it twice and compares).
 *
 * READS ONLY data/*.json, handed in by the caller:
 *   heroes.json, items.json, rules.json, analytics.json, generator.json (+ meta.json for labels).
 * TYPES NO GAME NUMBER. Every price, threshold, slot count, weight and sample floor comes from the data;
 * the only literals here are 0, 1, 2, 10, 60 and 100 (counting, percent, minutes, one decimal place).
 * tools/validate.mjs fails the build if any other numeric literal appears in this file.
 *
 * ENGINE (per legal item i, for the chosen hero h):
 *   (a) evidence E  = what h's players did with i: buy share, plus the win rate of those matches
 *                     compared with the OTHER items of the same tier on h (late items look better
 *                     because winning players can afford them; a same-tier comparison removes most of
 *                     that), shrunk toward zero when the sample is small.
 *   (b) goals G     = the chosen goals' weights on i's stat keys (data/generator.json goals[].items).
 *   (c) counters C  = enemy threats (an enemy hero's players put more of their item souls into a kind
 *                     of item than the average hero does) times i's weight as an answer to that threat.
 *   timing T        = how far past the budget h's players usually are when they buy i.
 *   q = 1 + wE*E + F*(wG*G + wC*C) - wT*T (floored at qMin); i is worth cost * q.
 *   F (the fit cap) = min(1, buyShare / buyShareFloor), cut further by negativeLiftDamp when i loses
 *   against its own tier: a goal or an enemy can lift an item players of h really buy, never one almost
 *   nobody buys. An item that loses against its own tier AND sits under the buy-share floor gets F = 0.
 *   PICK GATE (a lock is the only way past it): an item with fewer than minSample matches on h (no sample,
 *   no rate to print, no evidence to stand on), or one that loses against its own tier while under the
 *   buy-share floor, is never picked.
 *   (d) investment  = the per-type investment bonus (rules.costBonuses) on the build's spend.
 *   (e) components  = an item and anything it is built from never share a build (buying the bigger
 *                     item uses the component up); the buy order says which component to buy first.
 * SEARCH: locked items first, then a greedy pass (best marginal gain that keeps the build legal),
 * then a swap pass (best one-for-one swap, then greedy again) until nothing improves.
 * HARD CONSTRAINTS (a build the game would refuse is a bug): the soul budget, the slot count
 * (rules.slots base + the extra slots the player says are open), the active-item cap, no Street Brawl
 * item, no item with its own component, no duplicates.
 *
 * Exposed as window.DL_ENGINE in the browser and module.exports under node (tools/validate.mjs).
 */
(function (root) {
  'use strict';

  var HUNDRED = 100;
  var TEN = 10;

  function pct1(a, b) {
    // identical arithmetic to tools/lib/common.mjs pct(a, b, 1), so cross-tab numbers are equal bit for bit
    return b > 0 ? Math.round(((HUNDRED * a) / b) * TEN) / TEN : null;
  }
  function round1(v) { return Math.round(v * TEN) / TEN; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtPct(v) { return (Math.round(v * TEN) / TEN).toFixed(1) + '%'; }
  function fmtPts(v) { var r = round1(v); return (r > 0 ? '+' : '') + r.toFixed(1) + ' points'; }
  function byId(arr) { var m = {}; for (var i = 0; i < arr.length; i++) m[arr[i].id] = arr[i]; return m; }
  function cmpId(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function create(D) {
    if (!D || !D.heroes || !D.items || !D.rules || !D.analytics || !D.generator) throw new Error('engine needs heroes, items, rules, analytics and generator data');
    var G = D.generator;
    var W = G.weights;
    var EV = G.evidence;
    var CO = G.counters;
    var LIM = G.limits;
    var SL = G.slots;
    var MIN = EV.minSample;
    var AN = D.analytics;
    var heroMap = byId(D.heroes);
    var itemMap = byId(D.items);
    var legal = D.items.filter(function (i) { return !i.streetBrawl; });
    var legalSet = {};
    legal.forEach(function (i) { legalSet[i.id] = true; });
    var goalMap = byId(G.goals);
    var phaseMap = byId(G.phases);
    var SLOTS = Object.keys(D.rules.costBonuses || {});

    // ---- (e) component closure: every item's transitive components
    var compClosure = {};
    function compsOf(id, seen) {
      if (compClosure[id]) return compClosure[id];
      var out = [];
      var it = itemMap[id];
      seen = seen || {};
      if (seen[id]) return out;
      seen[id] = true;
      (it && it.components || []).forEach(function (c) {
        if (out.indexOf(c) < 0) out.push(c);
        compsOf(c, seen).forEach(function (cc) { if (out.indexOf(cc) < 0) out.push(cc); });
      });
      compClosure[id] = out;
      return out;
    }
    legal.forEach(function (i) { compsOf(i.id); });
    function conflicts(a, b) { return compsOf(a).indexOf(b) >= 0 || compsOf(b).indexOf(a) >= 0; }

    // ---- (d) investment
    function bonusAt(slot, spend) {
      var arr = D.rules.costBonuses[slot] || [];
      var b = 0;
      for (var i = 0; i < arr.length; i++) if (spend >= arr[i].gold_threshold) b = arr[i].bonus;
      return b;
    }
    function topBonus(slot) {
      var arr = D.rules.costBonuses[slot] || [];
      return arr.length ? arr[arr.length - 1].bonus : 1;
    }

    // ---- per-hero numbers (memoised)
    var heroCache = {};
    function heroBase(h) {
      var a = AN.heroes[h];
      if (!a) return null;
      return { matches: a.matches, wins: a.wins, winRate: pct1(a.wins, a.matches), souls: a.perMatch ? a.perMatch.souls : null };
    }
    function heroCtx(h) {
      if (heroCache[h]) return heroCache[h];
      var a = AN.heroes[h];
      var mine = (AN.itemsByHero && AN.itemsByHero[h]) || {};
      var baseWr = a ? a.wins / a.matches : 0;
      var st = {};
      var tierN = {}, tierW = {};
      legal.forEach(function (it) {
        var v = mine[it.id];
        if (!v || !a) return;
        var s = { matches: v[0], wins: v[1], buySeconds: v[2] };
        s.buyShare = pct1(v[0], a.matches);
        s.share = v[0] / a.matches;
        if (v[0] >= MIN) {
          s.winRate = pct1(v[1], v[0]);
          // identical arithmetic to build_data.mjs topItems lift
          s.lift = Math.round(((v[1] / v[0] - baseWr) * HUNDRED) * TEN) / TEN;
          tierN[it.tier] = (tierN[it.tier] || 0) + v[0];
          tierW[it.tier] = (tierW[it.tier] || 0) + v[1];
        }
        st[it.id] = s;
      });
      // evidence E and the same-tier comparison
      var E = {};
      var F = {};
      var ok = {};
      legal.forEach(function (it) {
        var s = st[it.id];
        if (!s) { E[it.id] = 0; F[it.id] = 0; ok[it.id] = false; return; }
        var L = 0;
        if (s.winRate != null) {
          var on = (tierN[it.tier] || 0) - s.matches;
          var ow = (tierW[it.tier] || 0) - s.wins;
          if (on >= MIN) {
            s.tierOthers = { matches: on, winRate: pct1(ow, on) };
            s.tierLift = (s.wins / s.matches - ow / on) * HUNDRED;
            L = clamp(s.tierLift / EV.liftScalePct, -1, 1) * (s.matches / (s.matches + EV.shrinkMatches));
          }
        }
        E[it.id] = EV.liftShare * L + EV.buyShareShare * s.share;
        // fit cap: how much of a goal / counter lift this item is allowed to keep on this hero
        var f = Math.min(1, s.share / EV.buyShareFloor);
        var loses = s.tierLift != null && s.tierLift < 0;
        if (loses) f = f * (1 - EV.negativeLiftDamp * clamp(-s.tierLift / EV.liftScalePct, 0, 1));
        // a tier-loser almost nobody buys gets no lift at all and is never picked unless locked
        var rare = loses && s.share < EV.buyShareFloor;
        F[it.id] = rare ? 0 : f;
        ok[it.id] = s.matches >= MIN && !rare;
      });
      // timing: expected item souls already bought when h's players usually buy it
      var timed = legal.filter(function (it) { return st[it.id] && st[it.id].matches >= MIN; })
        .sort(function (x, y) { return (st[x.id].buySeconds - st[y.id].buySeconds) || cmpId(x.id, y.id); });
      var before = {};
      var run = 0;
      for (var k = 0; k < timed.length; k++) {
        before[timed[k].id] = run;
        run += st[timed[k].id].share * timed[k].cost;
      }
      heroCache[h] = { base: heroBase(h), stat: st, E: E, F: F, eligible: ok, spendBefore: before };
      return heroCache[h];
    }
    function heroItemStat(h, i) { var c = heroCtx(h); return c.stat[i] || null; }

    // ---- (c) enemy threat shares
    function measureWeight(t, it) {
      var m = t.measure;
      if (m.slot) return it.slot === m.slot ? 1 : 0;
      var g = goalMap[m.goal];
      var e = g && g.items[it.id];
      return e && e.w >= G.measureMinWeight ? e.w : 0;
    }
    var shareCache = {};
    function threatShare(t, h) {
      var key = t.id + '|' + h;
      if (key in shareCache) return shareCache[key];
      var mine = (AN.itemsByHero && AN.itemsByHero[h]) || {};
      var tot = 0, hit = 0;
      legal.forEach(function (it) {
        var v = mine[it.id];
        if (!v) return;
        var souls = v[0] * it.cost;
        tot += souls;
        hit += souls * measureWeight(t, it);
      });
      shareCache[key] = tot > 0 ? hit / tot : null;
      return shareCache[key];
    }
    var avgCache = {};
    function threatAvg(t) {
      if (t.id in avgCache) return avgCache[t.id];
      var s = 0, n = 0;
      D.heroes.forEach(function (h) { var v = threatShare(t, h.id); if (v != null) { s += v; n++; } });
      avgCache[t.id] = n ? s / n : null;
      return avgCache[t.id];
    }
    function threatsFor(enemies) {
      var out = [];
      if (!enemies.length) return out;
      G.threats.forEach(function (t) {
        var avg = threatAvg(t);
        if (!avg) return;
        var level = 0;
        var who = [];
        enemies.forEach(function (e) {
          var sh = threatShare(t, e);
          var base = AN.heroes[e];
          if (sh == null || !base) return;
          var ex = Math.min(CO.excessCap, sh / avg - 1);
          if (ex >= CO.minExcess) {
            level += ex;
            who.push({ hero: e, share: sh, matches: base.matches });
          }
        });
        level = level / enemies.length;
        if (who.length) out.push({ id: t.id, label: t.label, noun: t.noun, level: level, avg: avg, enemies: who, answerItems: t.answerItems });
      });
      return out;
    }

    // ---- inputs
    function sanitize(inp) {
      inp = inp || {};
      var hero = heroMap[inp.hero] ? inp.hero : D.heroes.slice().sort(function (a, b) { return cmpId(a.name, b.name); })[0].id;
      var uniq = function (arr, ok, max) {
        var out = [];
        (Array.isArray(arr) ? arr : []).forEach(function (x) { if (typeof x === 'string' && ok(x) && out.indexOf(x) < 0 && out.length < max) out.push(x); });
        return out;
      };
      var goals = uniq(inp.goals, function (g) { return !!goalMap[g]; }, LIM.maxGoals);
      var enemies = uniq(inp.enemies, function (e) { return !!heroMap[e] && !!AN.heroes[e]; }, LIM.maxEnemies);
      var locks = uniq(inp.locks, function (i) { return !!legalSet[i]; }, LIM.maxLocks);
      var phase = phaseMap[inp.phase] || inp.phase === 'custom' ? inp.phase : G.phases[0].id;
      var ph = phaseMap[phase];
      var extra = Number.isInteger(inp.extraSlots) ? clamp(inp.extraSlots, 0, SL.extraMax) : ph ? ph.extraSlots : 0;
      var budget = null;
      if (phase === 'custom') budget = Number.isFinite(inp.budget) && inp.budget >= 0 ? Math.floor(inp.budget) : null;
      return { hero: hero, goals: goals, enemies: enemies, locks: locks, phase: phase, budget: budget, extraSlots: extra };
    }
    function budgetFor(h, inp) {
      if (inp.phase === 'custom') {
        if (inp.budget == null) return null;
        return { value: inp.budget, kind: 'custom', text: fmtInt(inp.budget) + ' souls, the budget you typed.' };
      }
      var ph = phaseMap[inp.phase];
      if (ph.budgetFrom === 'heroAverageNetWorth') {
        var a = AN.heroes[h];
        var hn = heroMap[h].name;
        if (!a || !a.perMatch || !(a.perMatch.souls > 0)) return null;
        return { value: a.perMatch.souls, kind: ph.id, matches: a.matches, text: fmtInt(a.perMatch.souls) + ' souls: what ' + hn + ' players end a match with on average (' + fmtInt(a.matches) + ' matches).' };
      }
      return { value: ph.budget, kind: ph.id, text: fmtInt(ph.budget) + ' souls: the total a player holds at level ' + ph.level + ' (' + fmtInt(ph.soulsEarned) + ' earned, plus the ' + fmtInt(ph.startSouls) + ' every player starts with).' };
    }

    // ---- scoring
    // the ONE pick-gate test: generate() filters its candidates with it and the validator calls it through api.pickable
    function canPick(ctx, id) { return !!ctx.eligible[id]; }
    // how much of the goal and counter lift an item may keep on this hero (0..1); qOf multiplies by it and api.fitCap reports it
    function fitOf(ctx, id) { return ctx.F[id]; }
    // The reason printed for a cut must be the cut's real cause (verifier r4: "few Haze players buy it" on an item 62.7% of
    // Haze players buy, cut only because it loses to its own tier). Causes mirror the fit cap above: a buy share under
    // buyShareFloor, a negative tierLift, or both (no rate here: goal and counter receipts print no rate; the evidence card has it).
    function capNote(ctx, id, f, hn) {
      if (!(f < 1)) return '';
      var s = ctx.stat[id] || {};
      var it = itemMap[id] || {};
      var low = s.share != null && s.share < EV.buyShareFloor;
      var loses = s.tierLift != null && s.tierLift < 0;
      var why = [];
      if (low) why.push('few ' + hn + ' players buy it');
      if (loses) why.push('it wins less often than other tier ' + it.tier + ' items on ' + hn);
      if (!why.length) return '';
      return ' Its pull is reduced here, because ' + why.join(' and ') + '.';
    }
    function qOf(ctx, goals, threats, budget, id) {
      var it = itemMap[id];
      var g = 0;
      goals.forEach(function (gid) { var e = goalMap[gid].items[id]; if (e) g += e.w; });
      if (goals.length) g = g / goals.length;
      var c = 0;
      threats.forEach(function (t) { var e = t.answerItems[id]; if (e) c += t.level * e.w; });
      var tm = 0;
      if (ctx.spendBefore[id] != null && budget > 0) tm = clamp((ctx.spendBefore[id] + it.cost - budget) / budget, 0, 1);
      var q = 1 + W.evidence * ctx.E[id] + fitOf(ctx, id) * (W.goals * g + W.counters * c) - W.timing * tm;
      return { q: Math.max(W.qMin, q), g: g, c: c, t: tm, f: fitOf(ctx, id) };
    }

    function generate(rawInputs, opts) {
      opts = opts || {};
      var inp = sanitize(rawInputs);
      var h = inp.hero;
      var hero = heroMap[h];
      var ctx = heroCtx(h);
      var res = { ok: false, errors: [], inputs: inp, hero: h, build: [] };
      if (!ctx.base) { res.errors.push('No match numbers for ' + hero.name + ' in this data.'); return res; }
      var bud = budgetFor(h, inp);
      if (!bud) { res.errors.push(inp.phase === 'custom' ? 'Type a soul budget to build for.' : 'No budget could be worked out for this phase from the data.'); return res; }
      res.budget = bud;
      var R = bud.value;
      var K = SL.base + inp.extraSlots;
      res.slots = { base: SL.base, extra: inp.extraSlots, total: K };
      var threats = threatsFor(inp.enemies);
      res.threats = threats;

      var Q = {};
      legal.forEach(function (it) { Q[it.id] = qOf(ctx, inp.goals, threats, R, it.id); });

      function cost(B) { var s = 0; for (var i = 0; i < B.length; i++) s += itemMap[B[i]].cost; return s; }
      function actives(B) { var n = 0; for (var i = 0; i < B.length; i++) if (itemMap[B[i]].isActive) n++; return n; }
      function spendBySlot(B) {
        var o = {};
        SLOTS.forEach(function (s) { o[s] = 0; });
        B.forEach(function (id) { o[itemMap[id].slot] = (o[itemMap[id].slot] || 0) + itemMap[id].cost; });
        return o;
      }
      function J(B) {
        var v = 0;
        for (var i = 0; i < B.length; i++) v += itemMap[B[i]].cost * Q[B[i]].q;
        var sp = spendBySlot(B);
        SLOTS.forEach(function (s) { v += W.investment * sp[s] * bonusAt(s, sp[s]) / topBonus(s); });
        return v;
      }
      function legalBuild(B) {
        if (B.length > K) return false;
        if (cost(B) > R) return false;
        if (actives(B) > SL.maxActive) return false;
        for (var i = 0; i < B.length; i++) for (var j = i + 1; j < B.length; j++) if (B[i] === B[j] || conflicts(B[i], B[j])) return false;
        return true;
      }

      // locks must be legal on their own
      var L = inp.locks.slice();
      var lc = cost(L);
      if (lc > R) res.errors.push('Your locked items cost ' + fmtInt(lc) + ' souls, more than the budget of ' + fmtInt(R) + '.');
      if (L.length > K) res.errors.push('You locked ' + L.length + ' items but this build has ' + K + ' slots.');
      if (actives(L) > SL.maxActive) res.errors.push('You locked ' + actives(L) + ' active items; at most ' + SL.maxActive + ' can be owned at once.');
      for (var a1 = 0; a1 < L.length; a1++) for (var a2 = a1 + 1; a2 < L.length; a2++) {
        if (conflicts(L[a1], L[a2])) {
          var big = compsOf(L[a1]).indexOf(L[a2]) >= 0 ? L[a1] : L[a2];
          var small = big === L[a1] ? L[a2] : L[a1];
          res.errors.push(itemMap[small].name + ' is built into ' + itemMap[big].name + ': buying ' + itemMap[big].name + ' uses it up, so both cannot be in one build.');
        }
      }
      if (res.errors.length) return res;

      var B = L.slice();
      var isLocked = function (id) { return L.indexOf(id) >= 0; };
      // PICK GATE: only items with a real sample on this hero (>= minSample matches) that are not rare tier-losers may be picked; a lock is the one way past
      var pickable = legal.filter(function (it) { return isLocked(it.id) || canPick(ctx, it.id); });

      // ---- greedy pass, seeded by the best PRICE MIX. Value is cost * q, so a plain "biggest gain
      // first" greedy would always grab the most expensive item and strand the slot count. Instead the
      // engine first picks how many items of each price fit the souls AND the slots (an exhaustive count
      // over the few shop prices, using each price's best q values), then fills that mix greedily.
      var prices = [];
      legal.forEach(function (it) { if (prices.indexOf(it.cost) < 0) prices.push(it.cost); });
      prices.sort(function (x, y) { return x - y; });
      var pool = {};
      prices.forEach(function (p) {
        pool[p] = pickable.filter(function (it) {
          if (it.cost !== p || isLocked(it.id)) return false;
          for (var z = 0; z < L.length; z++) if (conflicts(it.id, L[z])) return false;
          return true;
        }).map(function (it) { return it.id; }).sort(function (x, y) { return (Q[y].q - Q[x].q) || cmpId(x, y); });
      });
      var freeSlots = K - L.length;
      var freeSouls = R - lc;
      var bestMix = null, bestVal = -1;
      (function walk(t, slotsLeft, soulsLeft, mix, val) {
        if (t === prices.length) {
          if (val > bestVal) { bestVal = val; bestMix = mix.slice(); }
          return;
        }
        var p = prices[t];
        var maxN = Math.min(slotsLeft, Math.floor(soulsLeft / p), pool[p].length);
        var add = 0;
        for (var n = 0; n <= maxN; n++) {
          if (n > 0) add += Q[pool[p][n - 1]].q * p;
          mix.push(n);
          walk(t + 1, slotsLeft - n, soulsLeft - n * p, mix, val + add);
          mix.pop();
        }
      })(0, freeSlots, freeSouls, [], 0);
      if (bestMix) {
        prices.forEach(function (p, t) {
          var want = bestMix[t], got = 0;
          for (var k = 0; k < pool[p].length && got < want; k++) {
            var nb = B.concat([pool[p][k]]);
            if (legalBuild(nb)) { B = nb; got++; }
          }
        });
      }
      var cur = J(B);
      function greedy() {
        for (;;) {
          var best = null, bestJ = cur;
          for (var i = 0; i < pickable.length; i++) {
            var id = pickable[i].id;
            if (B.indexOf(id) >= 0) continue;
            var nb = B.concat([id]);
            if (!legalBuild(nb)) continue;
            var nj = J(nb);
            if (nj > bestJ) { bestJ = nj; best = id; }
          }
          if (!best) return;
          B.push(best);
          cur = bestJ;
        }
      }
      greedy();
      for (var round = 0; round < LIM.swapRounds; round++) {
        var bo = null, bi = null, bj = cur;
        for (var o = 0; o < B.length; o++) {
          if (isLocked(B[o])) continue;
          for (var i = 0; i < pickable.length; i++) {
            var id = pickable[i].id;
            if (B.indexOf(id) >= 0) continue;
            var nb = B.slice();
            nb[o] = id;
            if (!legalBuild(nb)) continue;
            var nj = J(nb);
            if (nj > bj) { bj = nj; bo = o; bi = id; }
          }
        }
        if (bi == null) break;
        B[bo] = bi;
        cur = bj;
        greedy();
      }

      res.score = cur; // internal: compared for lock receipts, never printed (it has no sample behind it)

      // ---- buy order: when this hero's players usually buy it (sampled), else by tier
      var orderKey = function (id) {
        var s = ctx.stat[id];
        if (s && s.matches >= MIN) return s.buySeconds;
        var g = AN.items && AN.items[id];
        return g && g[0] >= MIN ? g[2] : null;
      };
      B.sort(function (x, y) {
        var kx = orderKey(x), ky = orderKey(y);
        if (kx != null && ky != null && kx !== ky) return kx - ky;
        if ((kx == null) !== (ky == null)) return kx == null ? 1 : -1;
        return (itemMap[x].tier - itemMap[y].tier) || cmpId(x, y);
      });

      var spendRun = {};
      SLOTS.forEach(function (s) { spendRun[s] = 0; });
      var hn = hero.name;
      res.build = B.map(function (id, idx) {
        var it = itemMap[id];
        var s = ctx.stat[id];
        var qq = Q[id];
        var rc = [];
        if (isLocked(id)) rc.push({ kind: 'lock', text: 'You locked this item.' });
        // (a) evidence
        if (s && s.matches >= MIN) {
          rc.push({
            kind: 'evidence', matches: s.matches, winRate: s.winRate, buyShare: s.buyShare, lift: s.lift, base: ctx.base.winRate,
            text: 'Bought in ' + fmtPct(s.buyShare) + ' of ' + hn + ' matches. Those games were won ' + fmtPct(s.winRate) + ' of the time (' + fmtInt(s.matches) + ' matches); ' + hn + ' wins ' + fmtPct(ctx.base.winRate) + ' overall.'
          });
          if (s.tierOthers) {
            rc.push({
              kind: 'tier', matches: s.tierOthers.matches, winRate: s.tierOthers.winRate,
              text: 'Other tier ' + it.tier + ' items on ' + hn + ' were won ' + fmtPct(s.tierOthers.winRate) + ' of the time (' + fmtInt(s.tierOthers.matches) + ' item purchases), so this one is ' + fmtPts(s.winRate - s.tierOthers.winRate) + ' against its own tier.'
            });
          }
        } else {
          rc.push({ kind: 'evidence-thin', text: 'Too few ' + hn + ' matches with this item (under ' + fmtInt(MIN) + ') to print a win rate.' });
        }
        // (b) goals
        inp.goals.forEach(function (gid) {
          var e = goalMap[gid].items[id];
          if (e && qq.f > 0) rc.push({ kind: 'goal', goal: gid, text: 'Serves your goal "' + goalMap[gid].label + '": ' + e.why.join(', ') + '.' + capNote(ctx, id, qq.f, hn) });
        });
        // (c) counters
        threats.forEach(function (t) {
          var e = t.answerItems[id];
          if (!e || qq.f <= 0) return;
          rc.push({
            kind: 'counter', threat: t.id, matches: t.enemies.map(function (x) { return x.matches; }),
            text: 'Answers the enemy ' + t.label + ' (' + e.why.join(', ') + '): ' + t.enemies.map(function (x) {
              return heroMap[x.hero].name + ' players put ' + fmtPct(x.share * HUNDRED) + ' of their item souls into ' + t.noun + ' (' + fmtInt(x.matches) + ' matches)';
            }).join('; ') + '; the average hero puts ' + fmtPct(t.avg * HUNDRED) + '.' + capNote(ctx, id, qq.f, hn)
          });
        });
        // (d) investment thresholds crossed in buy order
        var before = spendRun[it.slot];
        var after = before + it.cost;
        spendRun[it.slot] = after;
        var b0 = bonusAt(it.slot, before), b1 = bonusAt(it.slot, after);
        if (b1 > b0) {
          var thr = (D.rules.costBonuses[it.slot] || []).filter(function (x) { return x.gold_threshold > before && x.gold_threshold <= after; });
          var last = thr[thr.length - 1];
          var stepsAll = D.rules.costBonuses[it.slot] || [];
          var stepNo = stepsAll.indexOf(last) + 1;   // the sources state no unit for the bonus value, so receipts name the step, never the bare number
          rc.push({ kind: 'investment', text: 'Takes your ' + it.slot + ' items to ' + fmtInt(after) + ' souls, past the ' + fmtInt(last.gold_threshold) + '-soul step: the ' + it.slot + ' investment bonus reaches step ' + stepNo + ' of ' + stepsAll.length + '.' });
        }
        // timing
        if (s && s.matches >= MIN) {
          rc.push({ kind: 'timing', matches: s.matches, text: hn + ' players buy it around minute ' + round1(s.buySeconds / 60).toFixed(1) + ' on average (' + fmtInt(s.matches) + ' matches).' + (qq.t > 0 ? ' That is usually later in the match than this budget.' : '') });
        }
        // (e) components
        (it.components || []).forEach(function (cid) {
          var c = itemMap[cid];
          if (c) rc.push({ kind: 'component', text: 'Built from ' + c.name + ' (' + fmtInt(c.cost) + ' souls): buy that first and its price comes off this item.' });
        });
        return { item: id, name: it.name, slot: it.slot, tier: it.tier, cost: it.cost, isActive: !!it.isActive, locked: isLocked(id), order: idx + 1, receipts: rc };
      });

      // next-best swap per picked item (no number of its own)
      if (LIM.alternativesPerItem > 0) {
        res.build.forEach(function (row, o) {
          if (row.locked) return;
          var best = null, bj = -Infinity;
          var Bc = res.build.map(function (r) { return r.item; });
          for (var i = 0; i < pickable.length; i++) {
            var id = pickable[i].id;
            if (Bc.indexOf(id) >= 0) continue;
            var nb = Bc.slice();
            nb[o] = id;
            if (!legalBuild(nb)) continue;
            var nj = J(nb);
            if (nj > bj) { bj = nj; best = id; }
          }
          if (best) row.alt = { item: best, name: itemMap[best].name };
        });
      }

      // locked items: what each lock cost versus the runner-up
      if (!opts.noLockReceipts) {
        L.forEach(function (lid) {
          var free = generate({ hero: h, goals: inp.goals, enemies: inp.enemies, locks: L.filter(function (x) { return x !== lid; }), phase: inp.phase, budget: inp.budget, extraSlots: inp.extraSlots }, { noLockReceipts: true });
          var row = res.build.filter(function (r) { return r.item === lid; })[0];
          if (!free.ok || !row) return;
          var freeIds = free.build.map(function (r) { return r.item; });
          if (freeIds.indexOf(lid) >= 0) { row.receipts.push({ kind: 'lock-cost', text: 'The engine picks it even without the lock.' }); return; }
          var mine = res.build.map(function (r) { return r.item; });
          var instead = freeIds.filter(function (x) { return mine.indexOf(x) < 0; });
          var parts = instead.map(function (x) {
            var sx = ctx.stat[x];
            return itemMap[x].name + (sx && sx.matches >= MIN ? ' (bought in ' + fmtPct(sx.buyShare) + ' of ' + hn + ' matches, won ' + fmtPct(sx.winRate) + ' of ' + fmtInt(sx.matches) + ')' : '');
          });
          var verdict = free.score > res.score ? ', and it scores that build higher for your inputs.' : ', and it scores that build no higher than this one.';
          var ns = instead.filter(function (x) { return ctx.stat[x] && ctx.stat[x].matches >= MIN; }).map(function (x) { return ctx.stat[x].matches; });
          row.receipts.push({ kind: 'lock-cost', items: instead, matches: ns, text: parts.length ? 'Without the lock the engine would buy ' + parts.join(' and ') + ' instead' + verdict : 'Without the lock the engine changes other picks around it.' });
          row.runnerUp = instead;
        });
      }

      var ids = res.build.map(function (r) { return r.item; });
      res.spent = cost(ids);
      res.left = R - res.spent;
      res.slots.used = ids.length;
      res.actives = { used: actives(ids), cap: SL.maxActive };
      var sp = spendBySlot(ids);
      res.invest = SLOTS.map(function (s) {
        var nxt = (D.rules.costBonuses[s] || []).filter(function (x) { return x.gold_threshold > sp[s]; })[0] || null;
        return { slot: s, spend: sp[s], bonus: bonusAt(s, sp[s]), next: nxt ? { at: nxt.gold_threshold, bonus: nxt.bonus } : null };
      });
      res.matchups = inp.enemies.map(function (e) {
        var v = AN.counters && AN.counters[h] && AN.counters[h][e];
        if (v && v[0] >= MIN) return { enemy: e, matches: v[0], winRate: pct1(v[1], v[0]), text: hn + ' won ' + fmtPct(pct1(v[1], v[0])) + ' of ' + fmtInt(v[0]) + ' matches against ' + heroMap[e].name + '.' };
        return { enemy: e, matches: v ? v[0] : 0, winRate: null, text: 'Too few ' + hn + ' matches against ' + heroMap[e].name + ' to print a win rate.' };
      });
      res.ruleNote = 'Slot rule used: ' + SL.base + ' slots, plus up to ' + SL.extraMax + ' more once enemy Walkers fall, and at most ' + SL.maxActive + ' active items (' + SL.source.replace(/ \(.*\)$/, '') + '). The sources disagree on slots and nothing here is checked in game.';
      res.ok = true;
      return res;
    }

    return {
      generate: generate,
      sanitize: sanitize,
      heroItemStat: heroItemStat,
      fitCap: function (h, i) { var c = heroCtx(h); var f = fitOf(c, i); return f == null ? null : f; },
      pickable: function (h, i) { return canPick(heroCtx(h), i); },
      // diagnostic for tools/validate.mjs: how much one goal set moves this item's quality factor q on this hero (no enemies, no timing)
      goalLift: function (h, goals, i) {
        var c = heroCtx(h);
        var gs = sanitize({ hero: h, goals: goals }).goals;
        return qOf(c, gs, [], 0, i).q - qOf(c, [], [], 0, i).q;
      },
      heroBase: heroBase,
      budgetFor: function (h, inp) { return budgetFor(h, sanitize(Object.assign({}, inp, { hero: h }))); },
      legalItems: function () { return legal.map(function (i) { return i.id; }); },
      componentsOf: function (id) { return compsOf(id).slice(); },
      goals: G.goals.map(function (g) { return { id: g.id, label: g.label, help: g.help }; }),
      phases: G.phases.map(function (p) { return { id: p.id, label: p.label, help: p.help, extraSlots: p.extraSlots }; }),
      limits: LIM,
      slots: SL,
      minSample: MIN
    };
  }

  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DL_ENGINE = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
