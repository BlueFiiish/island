/* ar.js - attack power, scaling and requirement math for the Elden Ring companion.
 *
 * OWNED BY: P3 L7 (Planner + AR). FILE FENCE: js/ar.js, js/planner.js,
 * css/planner.css, tools/ar-golden.mjs, tools/validate/ar.mjs,
 * tools/stages.d/55-ar-golden.json.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * A faithful port of the attack-power math in
 * ThomasJClark/elden-ring-weapon-calculator (MIT), specifically
 *   src/calculator/calculator.ts   getWeaponAttack + adjustAttributesForTwoHanding
 *   src/regulationData.ts          decodeRegulationData (the per-upgrade-level
 *                                  expansion of attack and attributeScaling, the
 *                                  calcCorrectGraph defaults, and the status
 *                                  attackElementCorrect rows the game does not
 *                                  store per weapon)
 * read from the upstream master branch on 2026-09-01. Nothing here is guessed:
 * every constant below is either in that source or in the regulation payload
 * this file is handed.
 *
 * It is PUBLIC MATH over shipped game data - a calculator, never a generator
 * (PLAN.md section 1, "Tool depth"). It predicts nothing and ranks nothing.
 *
 * ---------------------------------------------------------------------------
 * THE FORMULA, IN ONE PLACE
 * ---------------------------------------------------------------------------
 * For each attack-power type t (5 damage types, then 7 status types):
 *
 *   base(t, L)   = unupgradedAttack[t] * reinforce[L].attack[t]
 *                  ... then any statusSpEffectParam rows for this weapon at
 *                      level L OVERWRITE the status entries outright.
 *   scaling(a,L) = unupgradedScaling[a] * reinforce[L].attributeScaling[a]
 *
 *   if any REQUIREMENT the type scales with is unmet:
 *       multiplier = 1 - 0.4                       (the flat -40% penalty)
 *   else
 *       multiplier = 1 + SUM over attributes a that type t scales with of
 *                        curve(t)[statValue(a)] * scaling(a, L)
 *
 *   attackPower(t) = base(t, L) * multiplier
 *
 * Three details that are easy to get wrong and are the reason this is a port
 * rather than a re-write from a wiki article:
 *
 *   1. WHICH attributes a damage type scales with is per weapon, from
 *      AttackElementCorrectParam - not "the weapon scales with STR so all its
 *      damage does". Status types are NOT in that param at all; upstream adds
 *      them by hand, and in vanilla only poison, bleed, sleep and madness scale
 *      (with Arcane). Scarlet rot, frost and death blight do not scale at all.
 *   2. An AttackElementCorrect entry may be a NUMBER instead of `true`, in
 *      which case the contribution is that number re-based against the weapon's
 *      +0 scaling: (n * scaling(a, L)) / scaling(a, 0).
 *   3. The requirement penalty is per DAMAGE TYPE, not per weapon: on a
 *      split-damage weapon an unmet Faith requirement can gut the holy half and
 *      leave the physical half untouched.
 *
 * ---------------------------------------------------------------------------
 * NO DOM, NO NETWORK
 * ---------------------------------------------------------------------------
 * This file must load in Node (tools/validate/ar.mjs requires it) and in the
 * browser from the same bytes, so it touches neither `document` nor `fetch`.
 * The regulation payload is HANDED to it: the browser side is js/planner.js
 * (which fetches data/weapon-calc.json), the Node side is validate/ar.mjs.
 *
 * STYLE. Classic script, ES2019, ASCII only, no modules, no bundler.
 */
(function (globalScope) {
  'use strict';

  /* ---------------------------------------------------------------- constants
     AttackPowerType, from src/calculator/attackPowerTypes.ts. The numbers are
     the game's own; the names on the right are this app's data-contract keys
     (PLAN.md section 5: baseAr{phys,mag,fire,ligt,holy}, status{bleed,frost,
     poison,rot,sleep,madness}). */
  var DAMAGE_TYPES = [
    [0, 'phys'],
    [1, 'mag'],
    [2, 'fire'],
    [3, 'ligt'],
    [4, 'holy']
  ];
  var STATUS_TYPES = [
    [5, 'poison'],
    [6, 'rot'],
    [7, 'bleed'],
    [8, 'frost'],
    [9, 'sleep'],
    [10, 'madness'],
    [11, 'deathblight']
  ];
  var DAMAGE_KEYS = DAMAGE_TYPES.map(function (p) { return p[1]; });
  var STATUS_KEYS = STATUS_TYPES.map(function (p) { return p[1]; });

  var ATTRIBUTES = ['str', 'dex', 'int', 'fai', 'arc'];

  /* calculator.ts: `ineffectiveAttributePenalty = 0.4`. */
  var UNMET_PENALTY = 0.4;

  /* regulationData.ts: the two ids the decoder falls back to when a weapon does
     not name its own curve for a type. The payload carries these too and the
     payload wins - these are only the fallback of the fallback. */
  var DEFAULT_DAMAGE_GRAPH = 0;
  var DEFAULT_STATUS_GRAPH = 6;

  /* regulationData.ts: WeaponType ids that can only ever be two-handed, so they
     always take the Strength bonus. LIGHT_BOW, BOW, GREATBOW, BALLISTA. */
  var ALWAYS_TWO_HANDED = { 50: 1, 51: 1, 53: 1, 56: 1 };

  /* regulationData.ts decodeRegulationData: status effects are not stored in
     AttackElementCorrectParam because they are identical for every weapon, so
     the decoder writes them onto every row. In VANILLA (reforgedQuirks off)
     scarlet rot, frost and death blight get `{arc: undefined}` - which is to
     say they do not scale with anything, and can never take the unmet-
     requirement penalty either. Keeping the empty objects here rather than
     omitting them is deliberate: it documents that the absence is a decision. */
  var STATUS_SCALING = {
    5: { arc: true },   /* poison */
    6: {},              /* scarlet rot - does not scale in vanilla */
    7: { arc: true },   /* bleed */
    8: {},              /* frost - does not scale in vanilla */
    9: { arc: true },   /* sleep */
    10: { arc: true },  /* madness */
    11: {}              /* death blight - does not scale in vanilla */
  };

  /* uiUtils.ts affinityOptions (vanilla). -1 is upstream's fake id for a weapon
     that takes no affinity at all. */
  var AFFINITY_NAMES = {
    '-1': 'Unique',
    0: 'Standard',
    1: 'Heavy',
    2: 'Keen',
    3: 'Quality',
    4: 'Fire',
    5: 'Flame Art',
    6: 'Lightning',
    7: 'Sacred',
    8: 'Magic',
    9: 'Cold',
    10: 'Poison',
    11: 'Blood',
    12: 'Occult'
  };
  /* The order the in-game infusion menu uses, which is not numeric order. */
  var AFFINITY_ORDER = [0, 1, 2, 3, 8, 4, 5, 6, 7, 9, 10, 11, 12, -1];

  /* ------------------------------------------------------------------ helpers */

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  function slugifyAffinity(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function zeroed(keys) {
    var o = {};
    for (var i = 0; i < keys.length; i++) o[keys[i]] = 0;
    return o;
  }

  /* -------------------------------------------------------------- the module */

  var AR = {};

  AR.DAMAGE_KEYS = DAMAGE_KEYS.slice();
  AR.STATUS_KEYS = STATUS_KEYS.slice();
  AR.ATTRIBUTES = ATTRIBUTES.slice();
  AR.UNMET_PENALTY = UNMET_PENALTY;

  var REG = null;          /* the loaded regulation payload */
  var DECODED = null;      /* row name -> decoded weapon, memoised */
  var LOAD_ERROR = null;

  /* ------------------------------------------------------------------ load */
  /* The payload is app/data/weapon-calc.json, produced by
     tools/extract_regulation.mjs from the MIT regulation bundle. Its
     calcCorrectGraphs arrive ALREADY EVALUATED (index = attribute value 1..148,
     value = the scaling multiplier at that value), which is the one thing this
     port does differently from upstream, where evaluateCalcCorrectGraph runs on
     the client. The shape is asserted here rather than trusted, because a
     half-valid payload that silently produces plausible-looking numbers is the
     worst possible failure for a calculator. */
  AR.load = function (payload) {
    LOAD_ERROR = null;
    var why = AR.checkPayload(payload);
    if (why) {
      REG = null;
      DECODED = null;
      LOAD_ERROR = why;
      throw new Error('ar.js: ' + why);
    }
    REG = payload;
    DECODED = {};
    return AR;
  };

  AR.checkPayload = function (p) {
    if (!p || typeof p !== 'object') return 'regulation payload is not an object';
    var need = ['calcCorrectGraphs', 'attackElementCorrects', 'reinforceTypes', 'statusSpEffectParams', 'rows', 'byWeaponName'];
    for (var i = 0; i < need.length; i++) {
      if (!p[need[i]] || typeof p[need[i]] !== 'object') return 'regulation payload has no "' + need[i] + '" object';
    }
    var g0 = p.calcCorrectGraphs[String(DEFAULT_DAMAGE_GRAPH)];
    var g6 = p.calcCorrectGraphs[String(DEFAULT_STATUS_GRAPH)];
    if (!Array.isArray(g0) || !Array.isArray(g6)) return 'the two default calcCorrectGraphs (0 and 6) are missing or are not evaluated arrays';
    if (g0.length < 149) return 'calcCorrectGraph 0 stops at attribute value ' + (g0.length - 1) + ' - it must reach 148 (99 Strength two-handed)';
    var rowNames = Object.keys(p.rows);
    if (rowNames.length < 100) return 'regulation payload holds only ' + rowNames.length + ' weapon rows';
    var probe = p.rows[rowNames[0]];
    if (!probe || !Array.isArray(probe.attack) || !Array.isArray(probe.attributeScaling)) {
      return 'weapon row "' + rowNames[0] + '" is not in the encoded shape (attack / attributeScaling pairs)';
    }
    return null;
  };

  AR.ready = function () {
    return !!REG;
  };
  AR.loadError = function () {
    return LOAD_ERROR;
  };
  AR.gameVersion = function () {
    return REG ? String(REG.gameVersion || '') : '';
  };
  AR.rowCount = function () {
    return REG ? Object.keys(REG.rows).length : 0;
  };
  /* Escape hatch for the validator and for tools that want the raw payload
     back without re-reading the file. Never mutated by this module. */
  AR.regulation = function () {
    return REG;
  };

  function requireReg() {
    if (!REG) throw new Error('ar.js: no regulation payload loaded - call ER.ar.load(weaponCalcJson) first');
    return REG;
  }

  /* ------------------------------------------------------- affinity plumbing */
  /* A weapons.json record carries `calc`, the regulation weaponName. The
     payload's byWeaponName maps that name to {affinityId: rowName}, which is
     how one wiki-level weapon expands into up to 13 regulation rows. */

  function affinityMap(rec) {
    var reg = requireReg();
    var key = rec && (rec.calc || rec.name);
    var m = key ? reg.byWeaponName[key] : null;
    return m || null;
  }

  AR.affinityName = function (id) {
    var n = AFFINITY_NAMES[String(id)];
    return n || ('Affinity ' + id);
  };

  /* Every affinity this weapon can actually take, in menu order. */
  AR.affinitiesFor = function (rec) {
    var m = affinityMap(rec);
    if (!m) return [];
    var have = {};
    Object.keys(m).forEach(function (k) { have[String(Number(k))] = m[k]; });
    var out = [];
    AFFINITY_ORDER.forEach(function (id) {
      var row = have[String(id)];
      if (row === undefined) return;
      out.push({ id: id, name: AR.affinityName(id), slug: slugifyAffinity(AR.affinityName(id)), row: row });
    });
    /* Anything the payload knows that the vanilla order does not (a modded
       regulation, one day) still ships rather than vanishing. */
    Object.keys(have).forEach(function (k) {
      var id = Number(k);
      if (AFFINITY_ORDER.indexOf(id) >= 0) return;
      out.push({ id: id, name: AR.affinityName(id), slug: slugifyAffinity(AR.affinityName(id)), row: have[k] });
    });
    return out;
  };

  /* `affinity` may be null/undefined (the weapon's own default), a numeric id,
     an affinity name ("Heavy"), or a slug ("flame-art"). */
  AR.resolveAffinity = function (rec, affinity) {
    var list = AR.affinitiesFor(rec);
    if (!list.length) return null;
    if (affinity === null || affinity === undefined || affinity === '') return list[0];
    var i;
    if (typeof affinity === 'number' || /^-?\d+$/.test(String(affinity))) {
      var id = Number(affinity);
      for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }
    var want = slugifyAffinity(affinity);
    for (i = 0; i < list.length; i++) if (list[i].slug === want) return list[i];
    return null;
  };

  AR.rowNameFor = function (rec, affinity) {
    var a = AR.resolveAffinity(rec, affinity);
    return a ? a.row : null;
  };

  /* ------------------------------------------------------------ the decoder */
  /* regulationData.ts decodeRegulationData, one row at a time and memoised,
     because the browser only ever needs a handful of the 3,295 rows. */

  function decodeRow(rowName) {
    var reg = requireReg();
    if (DECODED[rowName]) return DECODED[rowName];

    var w = reg.rows[rowName];
    if (!w) throw new Error('ar.js: no regulation row named "' + rowName + '"');

    var reinforce = reg.reinforceTypes[String(w.reinforceTypeId)];
    if (!Array.isArray(reinforce) || !reinforce.length) {
      throw new Error('ar.js: row "' + rowName + '" names reinforceTypeId ' + w.reinforceTypeId + ', which the payload does not carry');
    }
    var aecBase = reg.attackElementCorrects[String(w.attackElementCorrectId)];
    if (!aecBase) {
      throw new Error('ar.js: row "' + rowName + '" names attackElementCorrectId ' + w.attackElementCorrectId + ', which the payload does not carry');
    }

    /* Which attributes each type scales with: the weapon's own row for damage,
       the fixed vanilla rows for status. */
    var aec = {};
    var t;
    for (t in aecBase) if (Object.prototype.hasOwnProperty.call(aecBase, t)) aec[String(Number(t))] = aecBase[t];
    for (t in STATUS_SCALING) if (Object.prototype.hasOwnProperty.call(STATUS_SCALING, t)) aec[t] = STATUS_SCALING[t];

    /* Which curve each type uses. */
    var ids = w.calcCorrectGraphIds || {};
    var graphs = {};
    var i;
    function curveFor(type, dflt) {
      var id = ids[String(type)];
      if (id === undefined || id === null) id = ids[type];
      if (id === undefined || id === null) id = dflt;
      var c = reg.calcCorrectGraphs[String(id)];
      if (!Array.isArray(c)) {
        throw new Error('ar.js: row "' + rowName + '" wants calcCorrectGraph ' + id + ' for type ' + type + ', which the payload does not carry');
      }
      return c;
    }
    for (i = 0; i < DAMAGE_TYPES.length; i++) graphs[DAMAGE_TYPES[i][0]] = curveFor(DAMAGE_TYPES[i][0], DEFAULT_DAMAGE_GRAPH);
    for (i = 0; i < STATUS_TYPES.length; i++) graphs[STATUS_TYPES[i][0]] = curveFor(STATUS_TYPES[i][0], DEFAULT_STATUS_GRAPH);

    /* Base attack and base scaling at EVERY upgrade level this weapon has. */
    var statusIds = w.statusSpEffectParamIds || null;
    var attack = reinforce.map(function (p) {
      var at = {};
      (w.attack || []).forEach(function (pair) {
        at[pair[0]] = num(pair[1], 0) * num(p.attack ? p.attack[pair[0]] : 0, 0);
      });
      if (statusIds) {
        var offsets = [p.statusSpEffectId1, p.statusSpEffectId2, p.statusSpEffectId3];
        for (var k = 0; k < statusIds.length; k++) {
          var spId = statusIds[k];
          if (!spId) continue;
          var row = reg.statusSpEffectParams[String(spId + num(offsets[k], 0))];
          if (!row) continue;
          /* Object.assign semantics: a status param OVERWRITES, it does not add. */
          for (var tk in row) if (Object.prototype.hasOwnProperty.call(row, tk)) at[Number(tk)] = num(row[tk], 0);
        }
      }
      return at;
    });

    var scaling = reinforce.map(function (p) {
      var sc = {};
      (w.attributeScaling || []).forEach(function (pair) {
        var mult = p.attributeScaling ? p.attributeScaling[pair[0]] : 1;
        sc[pair[0]] = num(pair[1], 0) * num(mult, 0);
      });
      return sc;
    });

    var dec = {
      rowName: rowName,
      weaponName: w.weaponName,
      affinityId: num(w.affinityId, 0),
      weaponType: num(w.weaponType, 0),
      requirements: w.requirements || {},
      attack: attack,
      scaling: scaling,
      aec: aec,
      graphs: graphs,
      maxUpgrade: reinforce.length - 1,
      paired: !!w.paired,
      sorceryTool: !!w.sorceryTool,
      incantationTool: !!w.incantationTool,
      dlc: !!w.dlc
    };
    DECODED[rowName] = dec;
    return dec;
  }
  AR.decodeRow = decodeRow;

  /* ---------------------------------------------------------- scaling letters */
  /* scalingTiers is [[threshold, letter], ...] descending; upstream picks the
     first tier the value clears. Below the last tier there is no letter at all
     (the weapon does not scale with that attribute). */
  AR.scalingLetter = function (value) {
    var v = num(value, 0);
    var tiers = (REG && REG.scalingTiers) || [];
    for (var i = 0; i < tiers.length; i++) {
      if (v >= tiers[i][0]) return tiers[i][1];
    }
    return null;
  };

  AR.maxUpgrade = function (rec, affinity) {
    var row = AR.rowNameFor(rec, affinity);
    if (!row) return 0;
    return decodeRow(row).maxUpgrade;
  };

  /* Requirements are a property of the ROW, not of the wiki record: an infused
     weapon can ask for different stats than its standard version. */
  AR.requirements = function (rec, affinity) {
    var row = AR.rowNameFor(rec, affinity);
    var out = { str: 0, dex: 0, int: 0, fai: 0, arc: 0 };
    if (!row) {
      var r = (rec && rec.reqs) || {};
      ATTRIBUTES.forEach(function (a) { out[a] = num(r[a], 0); });
      return out;
    }
    var req = decodeRow(row).requirements;
    ATTRIBUTES.forEach(function (a) { out[a] = num(req[a], 0); });
    return out;
  };

  AR.scalingAt = function (rec, upgradeLevel, affinity) {
    var out = {};
    var row = AR.rowNameFor(rec, affinity);
    if (!row) {
      ATTRIBUTES.forEach(function (a) { out[a] = { letter: null, value: 0 }; });
      return out;
    }
    var dec = decodeRow(row);
    var lvl = clampLevel(dec, upgradeLevel);
    ATTRIBUTES.forEach(function (a) {
      var v = num(dec.scaling[lvl][a], 0);
      out[a] = { letter: v ? AR.scalingLetter(v) : null, value: v };
    });
    return out;
  };

  function clampLevel(dec, upgradeLevel) {
    var l = Math.round(num(upgradeLevel, 0));
    if (!(l >= 0)) l = 0;
    if (l > dec.maxUpgrade) l = dec.maxUpgrade;
    return l;
  }

  /* ------------------------------------------------------- requirement check */
  /* Two-handing, from calculator.ts adjustAttributesForTwoHanding: +50%
     Strength, floored; paired weapons never get it; bows and ballistae always
     do. The bonus counts for the REQUIREMENT check as well as for scaling,
     which is why a 2-hand toggle can turn a red weapon green. */
  AR.effectiveStats = function (dec, stats, twoHanding) {
    var out = {};
    ATTRIBUTES.forEach(function (a) { out[a] = Math.max(1, Math.round(num(stats ? stats[a] : 0, 0))); });
    var th = !!twoHanding;
    if (dec && dec.paired) th = false;
    if (dec && ALWAYS_TWO_HANDED[dec.weaponType]) th = true;
    if (th) out.str = Math.floor(out.str * 1.5);
    out.twoHanding = th;
    return out;
  };

  AR.unmetFor = function (rec, stats, affinity, opts) {
    var row = AR.rowNameFor(rec, affinity);
    var unmet = [];
    var reqs, eff;
    if (row) {
      var dec = decodeRow(row);
      eff = AR.effectiveStats(dec, stats, opts && opts.twoHanding);
      reqs = dec.requirements;
    } else {
      eff = AR.effectiveStats(null, stats, opts && opts.twoHanding);
      reqs = (rec && rec.reqs) || {};
    }
    ATTRIBUTES.forEach(function (a) {
      var r = num(reqs[a], 0);
      if (r > 0 && eff[a] < r) unmet.push(a);
    });
    return unmet;
  };

  /* canWield is deliberately broad: it answers the Planner's "what can I use
     right now" list for weapons AND for spells, which carry reqs{int,fai,arc}
     rather than a regulation row. A record with no requirements at all is
     wieldable - that is the honest answer for a talisman or a consumable. */
  AR.canWield = function (rec, stats, opts) {
    if (!rec) return false;
    if (rec.reqs && !rec.calc) {
      var ok = true;
      ATTRIBUTES.forEach(function (a) {
        var r = num(rec.reqs[a], 0);
        if (r > 0 && num(stats ? stats[a] : 0, 0) < r) ok = false;
      });
      return ok;
    }
    if (!rec.calc || !REG) {
      if (!rec.reqs) return true;
      var ok2 = true;
      ATTRIBUTES.forEach(function (a) {
        var r = num(rec.reqs[a], 0);
        if (r > 0 && num(stats ? stats[a] : 0, 0) < r) ok2 = false;
      });
      return ok2;
    }
    return AR.unmetFor(rec, stats, (opts && opts.affinity) || null, opts).length === 0;
  };

  /* ------------------------------------------------------------ attack power */
  /* calculator.ts getWeaponAttack, one for one. */
  AR.attack = function (rec, stats, upgradeLevel, affinity, opts) {
    opts = opts || {};
    var res = {
      ready: false,
      row: null,
      affinity: null,
      upgradeLevel: 0,
      maxUpgrade: 0,
      twoHanding: false,
      total: null,
      byType: zeroed(DAMAGE_KEYS),
      base: zeroed(DAMAGE_KEYS),
      bonus: zeroed(DAMAGE_KEYS),
      status: zeroed(STATUS_KEYS),
      unmet: [],
      penalised: [],
      scaling: null,
      reqs: null,
      spellScaling: null,
      why: null
    };
    if (!REG) {
      res.why = LOAD_ERROR || 'the attack calculator has not loaded yet';
      return res;
    }
    var aff = AR.resolveAffinity(rec, affinity === undefined ? null : affinity);
    if (!aff) {
      res.why = 'no regulation row for "' + ((rec && (rec.name || rec.calc)) || 'that weapon') + '"'
        + (affinity ? ' with the ' + affinity + ' affinity' : '');
      return res;
    }

    var dec = decodeRow(aff.row);
    var lvl = clampLevel(dec, upgradeLevel);
    var eff = AR.effectiveStats(dec, stats, opts.twoHanding);

    var unmet = [];
    ATTRIBUTES.forEach(function (a) {
      var r = num(dec.requirements[a], 0);
      if (r > 0 && eff[a] < r) unmet.push(a);
    });

    var penalised = [];
    var byType = zeroed(DAMAGE_KEYS);
    var baseOut = zeroed(DAMAGE_KEYS);
    var status = zeroed(STATUS_KEYS);
    var spell = null;
    var isTool = dec.sorceryTool || dec.incantationTool;

    var all = DAMAGE_TYPES.concat(STATUS_TYPES);
    for (var i = 0; i < all.length; i++) {
      var type = all[i][0];
      var key = all[i][1];
      var isDamage = i < DAMAGE_TYPES.length;

      var base = num(dec.attack[lvl][type], 0);
      if (!base && !isTool) continue;

      var scalesWith = dec.aec[String(type)] || {};
      var totalScaling = 1;
      var hitByPenalty = false;

      var blocked = false;
      for (var u = 0; u < unmet.length; u++) {
        if (scalesWith[unmet[u]]) { blocked = true; break; }
      }
      if (blocked) {
        totalScaling = 1 - UNMET_PENALTY;
        hitByPenalty = true;
        if (isDamage) penalised.push(key);
      } else {
        for (var s = 0; s < ATTRIBUTES.length; s++) {
          var attr = ATTRIBUTES[s];
          var correct = scalesWith[attr];
          if (!correct) continue;
          var sc;
          if (correct === true) {
            sc = num(dec.scaling[lvl][attr], 0);
          } else {
            /* A numeric AttackElementCorrect is a fraction of the weapon's own
               +0 scaling. Upstream divides unguarded; a zero denominator there
               would produce NaN and poison the whole row, so this port treats
               "no base scaling to re-base against" as no contribution and says
               so, rather than shipping a NaN that renders as a blank cell. */
            var base0 = num(dec.scaling[0][attr], 0);
            sc = base0 ? (num(correct, 0) * num(dec.scaling[lvl][attr], 0)) / base0 : 0;
          }
          if (!sc) continue;
          var curve = dec.graphs[type];
          var at = eff[attr];
          if (at < 1) at = 1;
          if (at > curve.length - 1) at = curve.length - 1;
          totalScaling += num(curve[at], 0) * sc;
        }
      }

      if (base) {
        var value = base * totalScaling;
        if (isDamage) {
          byType[key] = value;
          baseOut[key] = base;
        } else {
          status[key] = value;
        }
      }
      if (isDamage && isTool) {
        if (!spell) spell = {};
        spell[key] = 100 * totalScaling;
      }
      if (hitByPenalty && !isDamage) {
        /* recorded so the UI can say WHY a bleed number looks wrong */
        res.penalisedStatus = res.penalisedStatus || [];
        res.penalisedStatus.push(key);
      }
    }

    var total = 0;
    DAMAGE_KEYS.forEach(function (k) { total += byType[k]; });

    res.ready = true;
    res.row = aff.row;
    res.affinity = { id: aff.id, name: aff.name, slug: aff.slug };
    res.upgradeLevel = lvl;
    res.maxUpgrade = dec.maxUpgrade;
    res.twoHanding = !!eff.twoHanding;
    res.total = total;
    res.byType = byType;
    res.base = baseOut;
    res.bonus = (function () {
      var b = zeroed(DAMAGE_KEYS);
      DAMAGE_KEYS.forEach(function (k) { b[k] = byType[k] - baseOut[k]; });
      return b;
    })();
    res.status = status;
    res.unmet = unmet;
    res.penalised = penalised;
    res.spellScaling = spell;
    res.scaling = (function () {
      var o = {};
      ATTRIBUTES.forEach(function (a) {
        var v = num(dec.scaling[lvl][a], 0);
        o[a] = { letter: v ? AR.scalingLetter(v) : null, value: v };
      });
      return o;
    })();
    res.reqs = (function () {
      var o = {};
      ATTRIBUTES.forEach(function (a) { o[a] = num(dec.requirements[a], 0); });
      return o;
    })();
    res.sorceryTool = dec.sorceryTool;
    res.incantationTool = dec.incantationTool;
    return res;
  };

  /* ------------------------------------------------------------------ export */
  /* Same bytes in both worlds: CommonJS for tools/validate/ar.mjs (there is no
     package.json in app/, so Node reads this .js as CommonJS), and window.ER.ar
     for the browser. The browser branch never assumes the shell has run - it
     creates the ER namespace if app.js has not yet, exactly as app.js does. */
  if (typeof module === 'object' && module && module.exports) {
    module.exports = AR;
  }
  if (globalScope && typeof globalScope === 'object') {
    var ER = (globalScope.ER = globalScope.ER || {});
    ER.ar = AR;
  }
})(typeof window !== 'undefined' ? window : null);
