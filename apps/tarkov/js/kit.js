// Kit - what the app can work out about YOUR progression from the synced wiki
// data plus the quest state read out of the game's own logs.
//
// PURE on purpose: no fs, no Electron, no DOM. It is loaded two ways, exactly
// like hub.js and hub-items.js - as a plain <script> in the hub window (so the
// Traders view can offer "suggest from my quests" without a round trip through
// main) and via require() from test/kit.test.mjs. Hence the UMD tail.
//
// The honesty rule that shapes every function here: an UNKNOWN is never
// rendered as a zero. A trader level we cannot verify must not hide a quest the
// player can actually take, and a reputation estimate that cannot account for
// commerce must say so rather than quietly reading as fact.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotKit = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==========================================================================
  // shared shape helpers
  // ==========================================================================
  // quests.json is { syncedAt, tasks: [...] }, but every caller in the hub
  // already holds the inner array, so both are accepted rather than making one
  // of the two call sites unwrap it.
  function taskList(quests) {
    if (Array.isArray(quests)) return quests;
    if (quests && Array.isArray(quests.tasks)) return quests.tasks;
    return [];
  }

  // questState is { [taskId]: { status, at, traderId } }. Anything else - a
  // whole-file doc that still has its { updatedAt, state } wrapper, a null -
  // reads as "nothing known", not as a crash.
  function stateMap(questState) {
    if (!questState || typeof questState !== 'object' || Array.isArray(questState)) return {};
    if (questState.state && typeof questState.state === 'object') return questState.state;
    return questState;
  }

  function statusOf(state, taskId) {
    const e = state[taskId];
    return (e && typeof e === 'object') ? (e.status || null) : null;
  }

  // Floats out of the API sum to things like 0.30000000000000004, which then
  // renders as a nine-decimal reputation. Four places is well past anything
  // tarkov shows and kills the artefact.
  function round4(n) {
    return Math.round(n * 10000) / 10000;
  }

  // ==========================================================================
  // trader level estimation
  // ==========================================================================
  // WHY THIS IS AN ESTIMATE, and stays labelled as one:
  //
  //  * Reputation here is the SUM of finishRewards.traderStanding[].standing
  //    over the tasks the log says are finished. That is the only reputation
  //    source this app can observe. It is not the whole story - a trader's
  //    starting reputation is not identical for every trader, some events and
  //    the flea market move standing, and failing a task can cost some - so the
  //    number is a floor on rep earned from quests, not the profile value.
  //  * requiredCommerce is money spent with the trader, which nothing in a log
  //    file reveals. A level gated on it is therefore where the estimate STOPS:
  //    the climb caps below it and the result is flagged uncertain rather than
  //    guessed either way.
  //  * A null playerLevel means the player never told us. The level gate is
  //    then not applied (the alternative - treating unknown as level 0 - would
  //    peg every trader at LL1), and the result is flagged uncertain.
  //
  // Returns { [traderId]: { level, rep, uncertain, reason? } }. `reason` is only
  // present when uncertain is true.
  function estimateTraderLevels(opts) {
    const o = opts || {};
    const tasks = taskList(o.quests);
    const state = stateMap(o.questState);
    const traders = Array.isArray(o.traders) ? o.traders : [];
    const playerLevel = (o.playerLevel == null || o.playerLevel === '')
      ? null : Number(o.playerLevel);

    // ---- rep earned per trader ----
    const rep = {};
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t || statusOf(state, t.id) !== 'finished') continue;
      const stand = (t.finishRewards && Array.isArray(t.finishRewards.traderStanding))
        ? t.finishRewards.traderStanding : [];
      for (let j = 0; j < stand.length; j++) {
        const s = stand[j];
        const n = Number(s && s.standing);
        if (!s || !s.trader || !Number.isFinite(n)) continue;
        rep[s.trader] = (rep[s.trader] || 0) + n;
      }
    }

    const out = {};
    for (let i = 0; i < traders.length; i++) {
      const tr = traders[i];
      if (!tr || !tr.id) continue;
      const earned = round4(rep[tr.id] || 0);
      const levels = (Array.isArray(tr.levels) ? tr.levels.slice() : [])
        .filter((l) => l && Number.isFinite(Number(l.level)))
        .sort((a, b) => Number(a.level) - Number(b.level));

      // A trader with no levels at all (or exactly one - Lightkeeper, the BTR
      // driver, the other service NPCs) is LL1 and there is nothing to be
      // uncertain about.
      if (levels.length <= 1) {
        out[tr.id] = { level: levels.length ? Number(levels[0].level) : 1, rep: earned, uncertain: false };
        continue;
      }

      let best = Number(levels[0].level);
      let uncertain = false;
      let reason = null;
      for (let j = 0; j < levels.length; j++) {
        const L = levels[j];
        if (Number(L.requiredCommerce) > 0) {
          // Cannot be checked from anything we can see, so this level and every
          // level above it are out of reach of the estimate.
          uncertain = true;
          reason = 'commerce';
          break;
        }
        const needLvl = Number(L.requiredPlayerLevel) || 0;
        const needRep = Number(L.requiredReputation) || 0;
        if (playerLevel != null && needLvl > playerLevel) break;
        if (needRep > earned) break;
        if (Number(L.level) > best) best = Number(L.level);
      }
      // 'commerce' is the more specific answer and wins when both apply: an
      // unknown player level only widens the estimate, an unverifiable commerce
      // gate truncates it.
      if (!uncertain && playerLevel == null) {
        uncertain = true;
        reason = 'playerLevel';
      }
      const entry = { level: best, rep: earned, uncertain };
      if (uncertain) entry.reason = reason;
      out[tr.id] = entry;
    }
    return out;
  }

  // The highest minPlayerLevel among the tasks the log says are FINISHED - i.e.
  // a floor on the player's level that needs no input from the player at all.
  // Started tasks do not count: a task can be accepted at its level gate and
  // then... it still proves the gate was met. But `started` is also what the
  // log says for a task the player abandoned mid-wipe, and finished is the
  // stronger, unambiguous signal, so the floor stays conservative.
  // 0 when nothing is finished (never null - this is a floor, and "at least
  // level 0" is true of everyone).
  function inferMinPlayerLevel(quests, questState) {
    const tasks = taskList(quests);
    const state = stateMap(questState);
    let max = 0;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t || statusOf(state, t.id) !== 'finished') continue;
      const n = Number(t.minPlayerLevel);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  // ==========================================================================
  // quest availability
  // ==========================================================================
  // The requirement vocabulary in the data is 'complete' | 'active' | 'failed'
  // (checked across all 517 tasks). 'complete' is the API's word for what the
  // push-notification log calls 'finished', which is the one translation that
  // has to be got right - map it wrong and every prerequisite in the game reads
  // as unmet.
  const REQ_STATUS = {
    complete: 'finished',
    success: 'finished',
    finished: 'finished',
    active: 'started',
    started: 'started',
    failed: 'failed',
  };

  function requirementMet(req, state) {
    // The synced data names the prerequisite `id`; tarkov.dev's own schema
    // calls it `task`. Both are accepted so this cannot break on a field rename.
    const id = (req && (req.task || req.id)) || null;
    if (!id) return true; // a requirement with no task cannot gate anything
    const have = statusOf(state, typeof id === 'object' ? id.id : id);
    const wanted = (Array.isArray(req.status) && req.status.length) ? req.status : ['complete'];
    // ANY of the listed statuses satisfies it - the array is a set of accepted
    // states, not a conjunction.
    for (let i = 0; i < wanted.length; i++) {
      const want = REQ_STATUS[String(wanted[i]).toLowerCase()];
      // an unmodelled status word is treated as 'complete' rather than as
      // permanently unsatisfiable
      if ((want || 'finished') === have) return true;
    }
    return false;
  }

  // traderRequirements in the synced data are { trader, traderId, level }.
  // tarkov.dev also describes them as { requirementType, compareMethod, value,
  // trader }, so both shapes are read. An UNKNOWN trader level never blocks:
  // the whole point of the profile section is that the player opts in to that
  // gate by telling us their loyalty levels.
  function traderRequirementMet(req, traderLevels) {
    if (!req) return true;
    const type = req.requirementType == null ? 'level' : String(req.requirementType);
    if (!/level/i.test(type)) return true; // standing / commerce gates are not modelled
    const id = req.traderId || (typeof req.trader === 'string' ? req.trader : null);
    if (!id) return true;
    const need = Number(req.level != null ? req.level : req.value);
    if (!Number.isFinite(need)) return true;
    const have = traderLevelOf(traderLevels, id);
    if (have == null) return true; // unknown: do not block
    return have >= need;
  }

  // traderLevels may be the plain { id: 3 } map the config stores or the
  // { id: { level } } map estimateTraderLevels returns; both are read.
  function traderLevelOf(traderLevels, id) {
    if (!traderLevels || typeof traderLevels !== 'object') return null;
    const v = traderLevels[id];
    if (v == null) return null;
    const n = Number(typeof v === 'object' ? v.level : v);
    return Number.isFinite(n) ? n : null;
  }

  // 12 of the 517 live tasks carry factionName BEAR or USEC (six matched pairs -
  // Drip-Out, Textile, ...), and only one side of each pair can ever be taken.
  // Everything else is 'Any'. The comparison is case-insensitive because the
  // config stores 'bear'/'usec' and the data spells them 'BEAR'/'USEC'.
  //
  // An UNKNOWN faction never blocks, exactly like an unknown trader level: the
  // player opts into this gate by telling us which side they play.
  function factionAllows(task, faction) {
    const want = (typeof faction === 'string') ? faction.trim().toLowerCase() : '';
    if (want !== 'bear' && want !== 'usec') return true; // not told: permissive
    const need = String((task && task.factionName) || '').trim().toLowerCase();
    if (need !== 'bear' && need !== 'usec') return true; // 'Any', or absent
    return need === want;
  }

  // 'done' | 'active' | 'failed' | 'available' | 'locked'.
  //
  // Mirrors src/quests.js computeAvailable, with three deliberate differences:
  // it answers for ONE task rather than filtering a list, it reports the states
  // computeAvailable simply excludes (done/active/failed) because the hub draws
  // a badge for them, and it also honours traderRequirements and the player's
  // faction, neither of which the overlay has the profile data to check.
  //
  // A FAILED task splits two ways, and the split is the whole point: 16 of the
  // 517 live tasks are `restartable`, and only those can come back. A failed
  // task that is NOT restartable is TERMINAL - it is gone for this wipe - so it
  // gets its own 'failed' badge rather than being re-offered as 'available',
  // which is what the code did before and which sent the player to a trader who
  // has nothing for them.
  //
  // @param faction  'bear' | 'usec' | null. null = unknown = permissive.
  function questAvailability(task, questState, playerLevel, traderLevels, faction) {
    if (!task) return 'locked';
    const state = stateMap(questState);
    const own = statusOf(state, task.id);
    if (own === 'finished') return 'done';
    if (own === 'started') return 'active';
    if (own === 'failed' && !task.restartable) return 'failed';

    if (!factionAllows(task, faction)) return 'locked';

    const reqs = Array.isArray(task.taskRequirements) ? task.taskRequirements : [];
    for (let i = 0; i < reqs.length; i++) if (!requirementMet(reqs[i], state)) return 'locked';

    const lvl = (playerLevel == null || playerLevel === '') ? null : Number(playerLevel);
    const need = Number(task.minPlayerLevel) || 0;
    if (lvl != null && Number.isFinite(lvl) && need > lvl) return 'locked';

    const treqs = Array.isArray(task.traderRequirements) ? task.traderRequirements : [];
    for (let i = 0; i < treqs.length; i++) {
      if (!traderRequirementMet(treqs[i], traderLevels)) return 'locked';
    }
    return 'available';
  }

  // ==========================================================================
  // THE KIT OPTIMIZER
  // ==========================================================================
  // "What can I actually take into a raid for 150k, given MY loyalty levels and
  // MY finished quests" - which is a different question from "what is the best
  // gun in the game", and the difference is entirely gates and money.
  //
  // Three rules shape everything below, and all three exist because the
  // alternative produces a confident, wrong loadout:
  //
  //  1. AN OFFER YOU CANNOT PROVE IS NOT AN OFFER. A trader level we were never
  //     told is treated as UNUSABLE here - the exact opposite of the quest
  //     badge's "unknown never blocks". The asymmetry is deliberate: hiding a
  //     quest costs you a tick on a list, but pricing a kit off an offer you do
  //     not have sends you to the trader screen with the wrong money.
  //  2. EVERY TUNABLE IS IN WEIGHTS. Scoring gameplay is taste, and taste
  //     changes per wipe. Nothing below invents a constant inline.
  //  3. DETERMINISTIC. No Date.now, no Math.random, and every sort has an id
  //     tie-break, so the same profile and the same budget produce a
  //     byte-identical kit twice. A recommender that reshuffles on refresh is
  //     one nobody can compare against yesterday's.

  // The single tuning surface. Everything a person might argue about lives
  // here, so an argument is a one-line diff rather than an archaeology dig.
  const WEIGHTS = {
    // Flea market unlocks at player level 15 (the per-ITEM gate is read off
    // item.flea.minLvl, which the sync already carries, and is applied on top).
    FLEA_MIN_LEVEL: 15,
    // A kit's ammo line is priced as this many rounds. 120 is two-and-a-bit
    // mags of 5.45/5.56 - enough that ammo cost is felt, which is the point.
    ROUNDS_PER_KIT: 120,
    // How many barters deep the pricer will chase. 2 = "a barter whose
    // components are themselves barters", once. Past that the arithmetic stops
    // describing anything a player would actually do in a raid cycle.
    MAX_OFFER_DEPTH: 2,
    // Cheapest-wins ties break here. Trader first (a fixed price you can
    // actually walk up to), then barter (deterministic but fiddly), then flea
    // (a scanned number that may be hours stale).
    SOURCE_RANK: { trader: 0, barter: 1, flea: 2 },

    // Minimum penetration power to be allowed against armour of class N.
    // Index IS the class, so PEN_FLOOR[4] = 30. A round under the floor does
    // not get "a low score", it gets DROPPED: 20-pen ammo against class 5 is
    // not a worse plan, it is not a plan.
    PEN_FLOOR: [0, 10, 17, 23, 30, 37, 45, 50],

    AMMO: {
      W_PEN: 0.55,
      W_DMG: 0.25,
      W_ARMOR_DAMAGE: 0.12,
      W_FRAG: 0.08,
      PEN_LO: 15,      // below this, the pen term is 0
      PEN_SPAN: 35,    // pen 50 saturates the term
      DMG_MAX: 70,
      ARMOR_DAMAGE_MAX: 60,
      // How many ammo choices each weapon is offered. >1 on purpose: coupling
      // a preset to exactly one round leaves the budget repair loop with no
      // way to save money on a gun it otherwise wants.
      PICKS_PER_WEAPON: 3,
    },

    WEAPON: {
      ERGO_REF: 60,
      RECOIL_REF: 60,
      RECOIL_EXP: 0.8,
      RECOIL_MIN: 1,
      MOA_REF: 2.0,
      MOA_MIN: 0.8,
      MOA_EXP: 0.3,
      // Rate of fire. Without this term the formula rewards exactly the three
      // things a bolt-action is best at (high ergonomics, low recoil, tiny MOA)
      // and knows nothing about the one thing it is worst at, so Mosins
      // outranked assault rifles - a confidently wrong answer to "what should I
      // take into a raid". The live data spans 10-1200 rounds/min
      // (ItemPropertiesWeapon.fireRate on the BASE item, not the preset):
      // bolt-actions sit at 30-45, ARs at 600-900.
      //
      // 650 is the reference (the AK-74M / M4 band). The clamp keeps this a
      // TILT, not a verdict: a bolt-action still keeps 0.35^0.2 = 0.81 of its
      // score, so a genuinely excellent sniper rifle can still beat a bad AR,
      // and a 1200-rpm PP-19 gets 1.15^0.2 = 1.03 rather than a runaway bonus.
      // A weapon whose base carries no fireRate scores exactly as it did before.
      FIRERATE_REF: 650,
      FIRERATE_MIN: 0.35,
      FIRERATE_MAX: 1.15,
      FIRERATE_EXP: 0.2,
    },

    ARMOR: {
      CLASS_EXP: 1.6,
      DUR_REF: 60,
      BLUNT_W: 0.5,
      // Mobility. The penalties in the data are NEGATIVE FRACTIONS
      // (-0.09 = -9% movement speed), normalised to percent before these are
      // applied - see normPenaltyPct.
      MOB_SPEED: 1.5,
      MOB_ERGO: 1.0,
      MOB_TURN: 0.5,
      MOB_MIN: 0.4,
      MOB_MAX: 1,
    },

    RIG: {
      // An armoured rig is being asked to do two jobs, so its score is armour
      // with a capacity kicker rather than either one alone.
      CAP_REF: 20,
      CAP_BONUS: 0.35,
    },

    MEDS: {
      // A medkit that cannot stop a heavy bleed is a medkit you die next to.
      HEAVY_BLEED_BONUS: 1.5,
      HEAVY_BLEED_CURE: 'HeavyBleeding',
    },

    // Share of the budget each slot is allowed on the first, greedy pass. The
    // repair loop moves money between slots afterwards; this only decides where
    // it starts.
    BUDGET_SPLIT: {
      weaponAmmo: 0.45,
      armor: 0.25,
      helmet: 0.12,
      rig: 0.08,
      meds: 0.05,
      backpack: 0.05,
    },

    // Budget @ mult; null = unbounded (still reported).
    TIERS: [
      { label: 'Budget', mult: 0.6 },
      { label: 'Balanced', mult: 1 },
      { label: 'Best', mult: null },
    ],

    REPAIR: {
      MAX_ITERS: 120,
      // Under this fraction of the budget the loop starts spending back up: a
      // "150k kit" that costs 40k has not used the money it was given.
      UNDERSPEND: 0.8,
      // The improvement pass takes any move that raises the kit's score by more
      // than this. It exists to stop float dust from being read as a gain and
      // looping the hill-climb on a move worth nothing.
      IMPROVE_EPS: 1e-9,
      // The last thing tried before giving up on a budget. A raid without a
      // backpack is a raid; a raid without a gun, armour or meds is not, so
      // only this one may be dropped to make the money work.
      OPTIONAL_SLOTS: ['backpack'],
      // What an optional slot left EMPTY scores, as a multiple of that slot's
      // budget share, below zero. At 1 a dropped backpack costs a full 0.05 -
      // more than the money it frees can usually buy elsewhere - so the solver
      // gives one up only when it truly cannot stretch, which is the behaviour
      // the OPTIONAL_SLOTS comment above describes.
      //
      // It is ALSO what makes the whole optimiser monotone in the budget. The
      // drop is on the table at every budget rather than only at the ones where
      // a full kit is unaffordable, so raising the budget can only ADD kits to
      // the affordable set - and the best member of a growing set cannot get
      // worse. Without this the score dipped at the exact rouble where a
      // backpack became affordable.
      DROP_PENALTY: 1,
    },

    // The exact solver (see solveExact). MAX_FRONTIER is a refusal threshold,
    // not a quality dial: past it the solver hands the kit back to the
    // hill-climb rather than returning an answer it cannot prove is the best
    // one. On the shipped data the frontier peaks in the low hundreds.
    SOLVER: {
      MAX_FRONTIER: 20000,
      // scores below this apart are the same score; float dust must not decide
      // which of two identical kits the player is shown
      TIE_EPS: 1e-9,
    },

    // Two configurations are always costed - body armour + a plain rig, and an
    // armoured rig instead of both (you cannot wear both in game). Ties go to
    // the conventional loadout, so "the armoured rig won" always means it won
    // on merit.
    CONFIG_TIE_EPS: 1e-9,
  };

  // ==========================================================================
  // small numeric helpers
  // ==========================================================================
  function num(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function clamp01(n) {
    return clamp(Number.isFinite(n) ? n : 0, 0, 1);
  }

  function round4n(n) {
    return Math.round(n * 10000) / 10000;
  }

  // THE SIGN/SCALE TRAP. Every penalty in item-props.json is a negative
  // FRACTION: the 6B43's speedPenalty is -0.09, meaning -9% movement. A scoring
  // formula written against "percent" reads that as -0.09% and the heaviest
  // armour in the game comes out weightless.
  //
  // So: anything inside +/-1.5 is a fraction and gets scaled by 100; anything
  // larger is already a percent and is left alone. A POSITIVE value is read as
  // a penalty magnitude and negated - some sources quote penalties unsigned,
  // and "+9% speed for wearing plates" is not a thing.
  function normPenaltyPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return 0;
    const scaled = Math.abs(n) <= 1.5 ? n * 100 : n;
    return scaled > 0 ? -scaled : scaled;
  }

  // ==========================================================================
  // the offer index: what every item in the game costs YOU, today
  // ==========================================================================
  // Returns Map<itemId, offer> where offer is
  //   { source: 'trader'|'flea'|'barter', rub, trader?, lvl?, native?, limit?,
  //     components?, why[] }
  // and an item with NO usable source is simply absent - never present with a
  // zero or a guessed price.
  //
  // The Map also carries a `notes` property:
  //   { unknownTraders: [ids], fleaBlocked: reason|null }
  // which is how the "you have not told us your Prapor level" empty state gets
  // said out loud instead of silently costing the player half the game's stock.
  function buildOfferIndex(opts) {
    const o = opts || {};
    const W = o.weights || WEIGHTS;
    const items = (o.items && typeof o.items === 'object') ? o.items : {};
    const barterList = Array.isArray(o.barters) ? o.barters : [];
    const state = stateMap(o.questState);
    const traderLevels = (o.traderLevels && typeof o.traderLevels === 'object') ? o.traderLevels : {};
    const playerLevel = (o.playerLevel == null || o.playerLevel === '') ? null : Number(o.playerLevel);
    const fleaAllowed = !!o.fleaAllowed;
    const fleaMin = Number.isFinite(Number(o.fleaMinLevel)) ? Number(o.fleaMinLevel) : W.FLEA_MIN_LEVEL;
    const maxDepth = Number.isFinite(Number(o.maxDepth)) ? Number(o.maxDepth) : W.MAX_OFFER_DEPTH;
    const rank = W.SOURCE_RANK || WEIGHTS.SOURCE_RANK;

    // barters bucketed by what they PRODUCE - the pricer asks "how else could I
    // get this item", which is the opposite of how the file is laid out.
    const bartersFor = {};
    for (let i = 0; i < barterList.length; i++) {
      const b = barterList[i];
      const id = b && b.out && b.out.item;
      if (!id) continue;
      (bartersFor[id] = bartersFor[id] || []).push(b);
    }
    // stable order so two runs pick the same barter out of a price tie
    Object.keys(bartersFor).forEach((k) => {
      bartersFor[k].sort((a, b) => (String(a.id || '') < String(b.id || '') ? -1 : 1));
    });

    const unknownTraders = {};
    let fleaBlocked = null;
    if (!fleaAllowed) fleaBlocked = 'off';
    else if (playerLevel == null) fleaBlocked = 'unknownLevel';
    else if (playerLevel < fleaMin) fleaBlocked = 'level';

    function taskDone(taskId) {
      return !taskId || statusOf(state, taskId) === 'finished';
    }

    // `types` is the sync's own tag list; 'noFlea' is how it marks an item the
    // market will not carry (every round in the game, quest items, ...).
    function isNoFlea(it) {
      return !!(it && Array.isArray(it.types) && it.types.indexOf('noFlea') >= 0);
    }

    // null = "we were never told", which is NOT the same as 0 and is the whole
    // reason this returns null rather than a number.
    function levelFor(traderId) {
      return traderLevelOf(traderLevels, traderId);
    }

    // cheapest wins; ties break by source rank then by the offer's own key, so
    // the result cannot depend on object iteration order
    function better(a, b) {
      if (!a) return b;
      if (!b) return a;
      if (a.rub !== b.rub) return a.rub < b.rub ? a : b;
      const ra = rank[a.source] == null ? 9 : rank[a.source];
      const rb = rank[b.source] == null ? 9 : rank[b.source];
      if (ra !== rb) return ra < rb ? a : b;
      return String(a._key || '') <= String(b._key || '') ? a : b;
    }

    const memo = new Map();

    function bestOfferFor(id, depth, visiting) {
      if (depth === 0 && memo.has(id)) return memo.get(id);
      const it = items[id];
      if (!it) {
        if (depth === 0) memo.set(id, null);
        return null;
      }
      let best = null;

      // ---- cash at a trader ----
      const buys = Array.isArray(it.buy) ? it.buy : [];
      for (let i = 0; i < buys.length; i++) {
        const b = buys[i];
        if (!b || !b.t) continue;
        const rub = num(b.rub, 0);
        if (rub <= 0) continue;
        const lvl = num(b.lvl, 1) || 1;
        const have = levelFor(b.t);
        if (have == null) { unknownTraders[b.t] = true; continue; }
        if (have < lvl) continue;
        if (!taskDone(b.task)) continue;
        const why = ['trader LL' + lvl];
        const limit = num(b.limit, 0);
        if (limit > 0) why.push('limit ' + limit + ' per restock');
        best = better(best, {
          source: 'trader',
          rub,
          trader: b.t,
          lvl,
          native: { price: num(b.price, rub), cur: String(b.cur || 'RUB').toUpperCase() },
          limit,
          why,
          _key: b.t + '/' + lvl,
        });
      }

      // ---- the flea ----
      // Three gates, all real: the market itself opens at FLEA_MIN_LEVEL,
      // individual items carry their own minLvl on top of it, and an item
      // flagged `noFlea` cannot be listed there at all. The sync writes
      // flea: null for those, so this guard is belt-and-braces - but the engine
      // is handed arbitrary item maps by callers and tests, and a noFlea item
      // that still carries a flea block must not be priced off a market it is
      // banned from.
      if (!fleaBlocked && it.flea && !isNoFlea(it)) {
        const f = it.flea;
        const itemMin = num(f.minLvl, 0);
        if (playerLevel >= itemMin) {
          const low = num(f.low, 0);
          const avg = num(f.avg, 0);
          const price = low > 0 ? low : avg;
          if (price > 0) {
            best = better(best, {
              source: 'flea',
              rub: price,
              why: ['flea ' + (low > 0 ? 'low price' : '24h average')
                + (itemMin > 0 ? ' (level ' + itemMin + '+)' : '')],
              _key: 'flea',
            });
          }
        }
      }

      // ---- barter ----
      if (depth < maxDepth) {
        const brs = bartersFor[id] || [];
        const nextVisiting = visiting.concat([id]);
        for (let i = 0; i < brs.length; i++) {
          const br = brs[i];
          const lvl = num(br.minTraderLevel, 1) || 1;
          const have = levelFor(br.trader);
          if (have == null) { if (br.trader) unknownTraders[br.trader] = true; continue; }
          if (have < lvl) continue;
          if (!taskDone(br.taskUnlock)) continue;
          const reqs = Array.isArray(br.req) ? br.req : [];
          // A barter with no requirement would price at zero and beat every
          // real offer in the game. It is bad data, not a free gun.
          if (!reqs.length) continue;
          const outCount = Math.max(1, num(br.out && br.out.count, 1));
          let total = 0;
          let ok = true;
          const components = [];
          for (let j = 0; j < reqs.length; j++) {
            const r = reqs[j];
            if (!r || !r.item) { ok = false; break; }
            // cycle guard: A -> B -> A prices A off itself and never terminates
            if (nextVisiting.indexOf(r.item) >= 0) { ok = false; break; }
            const sub = bestOfferFor(r.item, depth + 1, nextVisiting);
            if (!sub) { ok = false; break; }
            const cnt = Math.max(1, num(r.count, 1));
            total += cnt * sub.rub;
            components.push({ item: r.item, count: cnt, rub: sub.rub });
          }
          if (!ok) continue;
          const rub = Math.round(total / outCount);
          if (!(rub > 0)) continue;
          const why = ['barter at LL' + lvl + ' (' + components.length + ' component'
            + (components.length === 1 ? '' : 's') + ')'];
          const limit = num(br.buyLimit, 0);
          if (limit > 0) why.push('limit ' + limit + ' per restock');
          best = better(best, {
            source: 'barter',
            rub,
            trader: br.trader || null,
            lvl,
            limit,
            components,
            why,
            _key: String(br.id || i),
          });
        }
      }

      if (best) delete best._key;
      if (depth === 0) memo.set(id, best);
      return best;
    }

    const out = new Map();
    const ids = Object.keys(items).sort();
    for (let i = 0; i < ids.length; i++) {
      const off = bestOfferFor(ids[i], 0, []);
      if (off) out.set(ids[i], off);
    }
    out.notes = {
      unknownTraders: Object.keys(unknownTraders).sort(),
      fleaBlocked,
    };
    return out;
  }

  // ==========================================================================
  // the pool: items + props + the offer index, passed as one thing
  // ==========================================================================
  function poolOffer(pool, id) {
    const m = pool && pool.offers;
    if (!m) return null;
    return (typeof m.get === 'function' ? m.get(id) : m[id]) || null;
  }

  function poolProps(pool, id) {
    const p = pool && pool.props;
    return (p && p[id]) || null;
  }

  function poolItem(pool, id) {
    const it = pool && pool.items;
    return (it && it[id]) || null;
  }

  function poolWeights(pool) {
    return (pool && pool.weights) || WEIGHTS;
  }

  function itemName(pool, id) {
    const it = poolItem(pool, id);
    return (it && it.n) || id;
  }

  // Every ranked list ends here: score desc, then cost asc, then id asc. The
  // last term is what makes the whole optimizer reproducible.
  function sortRanked(list) {
    return list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return String(a.item) < String(b.item) ? -1 : 1;
    });
  }

  // ==========================================================================
  // ammo
  // ==========================================================================
  function ammoEfficiency(props, weights) {
    const W = (weights || WEIGHTS).AMMO;
    if (!props) return 0;
    // buckshot quotes damage PER PELLET, so a 8-pellet shell reading as "39
    // damage" would score below a pistol round it would delete.
    const pellets = Math.max(1, num(props.projectileCount, 1));
    const dmg = num(props.damage, 0) * pellets;
    const pen = num(props.penetrationPower, 0);
    return round4n(
      W.W_PEN * clamp01((pen - W.PEN_LO) / W.PEN_SPAN)
      + W.W_DMG * clamp01(dmg / W.DMG_MAX)
      + W.W_ARMOR_DAMAGE * clamp01(num(props.armorDamage, 0) / W.ARMOR_DAMAGE_MAX)
      + W.W_FRAG * clamp01(num(props.fragmentationChance, 0))
    );
  }

  // The hard floor. Index IS the class; anything past the end of the table
  // takes the last entry rather than undefined (which would compare false and
  // silently let every round through).
  function penFloorFor(targetClass, weights) {
    const table = (weights || WEIGHTS).PEN_FLOOR || WEIGHTS.PEN_FLOOR;
    const n = Math.max(0, Math.round(num(targetClass, 0)));
    return num(table[Math.min(n, table.length - 1)], 0);
  }

  // rankAmmo(pool, { caliber, targetClass, allowedAmmo })
  // -> [{ item, name, offer, cost, score, value, why[], pen, eff }]
  // `cost` is a KIT's worth of the round (ROUNDS_PER_KIT), not one bullet: a
  // per-round price makes every round look free next to a rifle.
  function rankAmmo(pool, opts) {
    const o = opts || {};
    const W = poolWeights(pool);
    const rounds = num(o.rounds, W.ROUNDS_PER_KIT) || W.ROUNDS_PER_KIT;
    const floor = penFloorFor(o.targetClass, W);
    const caliber = o.caliber == null ? null : String(o.caliber);
    const allowed = Array.isArray(o.allowedAmmo) && o.allowedAmmo.length ? o.allowedAmmo : null;
    const ids = allowed
      ? allowed.slice().sort()
      : Object.keys((pool && pool.props) || {}).sort();

    const out = [];
    const seen = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (seen[id]) continue;
      seen[id] = true;
      const p = poolProps(pool, id);
      if (!p || p.propertiesType !== 'ItemPropertiesAmmo') continue;
      if (caliber && String(p.caliber) !== caliber) continue;
      const pen = num(p.penetrationPower, 0);
      if (pen < floor) continue;
      const offer = poolOffer(pool, id);
      if (!offer) continue;
      const cost = Math.round(offer.rub * rounds);
      if (!(cost > 0)) continue;
      const eff = ammoEfficiency(p, W);
      const why = [rounds + ' rounds at ' + offer.rub + ' each', 'pen ' + pen];
      why.push.apply(why, offer.why || []);
      out.push({
        slot: 'ammo',
        item: id,
        name: itemName(pool, id),
        offer,
        cost,
        rounds,
        pen,
        eff,
        score: eff,
        value: eff / cost,
        why,
      });
    }
    return sortRanked(out);
  }

  // ==========================================================================
  // weapons (presets)
  // ==========================================================================
  // `fireRate` comes off the BASE item (presets carry no ItemPropertiesWeapon
  // fields), so it is passed in rather than read from presetProps. Absent or
  // junk = the reference rate = a multiplier of exactly 1, which is why adding
  // this term did not move a single score for data that lacks it.
  function weaponScore(presetProps, weights, fireRate) {
    const W = (weights || WEIGHTS).WEAPON;
    const ergo = num(presetProps && presetProps.ergonomics, 0);
    const recoil = Math.max(W.RECOIL_MIN, num(presetProps && presetProps.recoilVertical, W.RECOIL_REF));
    const moa = Math.max(W.MOA_MIN, num(presetProps && presetProps.moa, W.MOA_REF));
    // NOT num(): Number(null) is 0 and passes Number.isFinite, so a base item
    // with no fireRate would silently score as a 0-rpm weapon and take the
    // bottom of the clamp. Only a real, positive rate counts.
    const ref = num(W.FIRERATE_REF, 650) || 650;
    const rpmRaw = Number(fireRate);
    const rpm = (Number.isFinite(rpmRaw) && rpmRaw > 0) ? rpmRaw : ref;
    const rof = clamp(rpm / ref, num(W.FIRERATE_MIN, 0.35), num(W.FIRERATE_MAX, 1.15));
    return round4n(
      (ergo / W.ERGO_REF)
      * Math.pow(W.RECOIL_REF / recoil, W.RECOIL_EXP)
      * Math.pow(W.MOA_REF / moa, W.MOA_EXP)
      * Math.pow(rof, num(W.FIRERATE_EXP, 0.2))
    );
  }

  // Which presets are worth costing. Grouped by baseItem: if a base has a
  // `default` preset, ONLY the defaults survive - the custom builds in the data
  // are mostly unpurchasable trader mock-ups, and letting them through fills
  // the list with guns nobody can buy.
  function usablePresets(pool) {
    const props = (pool && pool.props) || {};
    const byBase = {};
    const ids = Object.keys(props).sort();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const p = props[id];
      if (!p || p.propertiesType !== 'ItemPropertiesPreset') continue;
      const base = p.baseItem;
      if (!base) continue;
      const bp = props[base];
      // no weapon props on the base = no caliber and no allowedAmmo, so there
      // is nothing to couple ammo to. Skipped, not guessed.
      if (!bp || bp.propertiesType !== 'ItemPropertiesWeapon') continue;
      (byBase[base] = byBase[base] || []).push(id);
    }
    const out = [];
    Object.keys(byBase).sort().forEach((base) => {
      const list = byBase[base];
      const defaults = list.filter((id) => !!props[id].default);
      (defaults.length ? defaults : list).forEach((id) => out.push({ preset: id, base }));
    });
    return out;
  }

  // rankWeapons(pool, { targetClass, ammoPicks })
  // Each line couples ONE preset with ONE round and carries the cost of both.
  // A preset with no round that clears the pen floor is dropped entirely: a
  // rifle you cannot feed is not a cheaper rifle.
  function rankWeapons(pool, opts) {
    const o = opts || {};
    const W = poolWeights(pool);
    const picks = Math.max(1, num(o.ammoPicks, W.AMMO.PICKS_PER_WEAPON));
    const presets = usablePresets(pool);
    const ammoCache = {};
    const out = [];

    for (let i = 0; i < presets.length; i++) {
      const { preset, base } = presets[i];
      const offer = poolOffer(pool, preset);
      if (!offer) continue;
      const pp = poolProps(pool, preset);
      const bp = poolProps(pool, base);
      const allowed = Array.isArray(bp.allowedAmmo) ? bp.allowedAmmo : [];
      if (!allowed.length) continue;
      const key = allowed.slice().sort().join(',');
      if (!ammoCache[key]) {
        ammoCache[key] = rankAmmo(pool, { targetClass: o.targetClass, allowedAmmo: allowed });
      }
      const ammo = ammoCache[key];
      if (!ammo.length) continue;

      // the rate of fire lives on the BASE, not on the preset
      const ws = weaponScore(pp, W, bp && bp.fireRate);
      if (!(ws > 0)) continue;

      // best-effect, best-value and cheapest, deduped. Three rungs is what lets
      // the repair loop cut ammo cost without throwing the gun away.
      const wanted = [];
      const push = (a) => { if (a && wanted.indexOf(a) < 0) wanted.push(a); };
      push(ammo[0]);
      push(ammo.slice().sort((a, b) => (b.value - a.value) || (String(a.item) < String(b.item) ? -1 : 1))[0]);
      push(ammo.slice().sort((a, b) => (a.cost - b.cost) || (String(a.item) < String(b.item) ? -1 : 1))[0]);
      const chosen = wanted.slice(0, picks);

      for (let k = 0; k < chosen.length; k++) {
        const a = chosen[k];
        const cost = offer.rub + a.cost;
        const why = ['ergo ' + num(pp.ergonomics, 0) + ', recoil '
          + num(pp.recoilVertical, 0) + ', ' + round4n(num(pp.moa, 0)) + ' MOA'];
        why.push.apply(why, offer.why || []);
        const notes = [];
        // Trader buy limits are per restock and per ROUND for ammo, so a
        // 90-limit round cannot supply a 120-round kit in one visit.
        const lim = num(a.offer && a.offer.limit, 0);
        if (lim > 0 && lim < a.rounds) {
          notes.push('needs ' + Math.ceil(a.rounds / lim) + ' restocks for '
            + a.rounds + ' rounds of ' + a.name);
        }
        out.push({
          slot: 'weaponAmmo',
          item: preset,
          name: itemName(pool, preset),
          base,
          offer,
          cost,
          score: round4n(ws * a.eff),
          value: (ws * a.eff) / cost,
          weaponScore: ws,
          ammo: a,
          extras: [{
            kind: 'ammo',
            item: a.item,
            name: a.name,
            count: a.rounds,
            offer: a.offer,
            cost: a.cost,
            why: a.why,
          }],
          notes,
          why,
        });
      }
    }
    return sortRanked(out);
  }

  // ==========================================================================
  // armour, helmets, plate carriers
  // ==========================================================================
  const PLATE_SLOT_RE = /^(front|back)_plate$/i;
  const SIDE_SLOT_RE = /^(left|right)_side_plate$/i;

  // Cheapest plate that actually meets the target class; if nothing at the
  // target is priceable, the best class that IS - said out loud rather than
  // quietly downgrading the kit's protection.
  function pickPlate(pool, allowedPlates, targetClass) {
    const list = Array.isArray(allowedPlates) ? allowedPlates.slice().sort() : [];
    const target = Math.max(0, Math.round(num(targetClass, 0)));
    let atTarget = null;
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      const p = poolProps(pool, id);
      if (!p) continue;
      const cls = num(p.class, 0);
      if (cls <= 0) continue;
      const offer = poolOffer(pool, id);
      if (!offer) continue;
      const cand = {
        item: id,
        name: itemName(pool, id),
        cls,
        dur: num(p.durability, 0),
        blunt: num(p.bluntThroughput, 0),
        speed: normPenaltyPct(p.speedPenalty),
        ergo: normPenaltyPct(p.ergoPenalty),
        turn: normPenaltyPct(p.turnPenalty),
        offer,
        cost: offer.rub,
      };
      if (cls >= target) {
        if (!atTarget || cand.cost < atTarget.cost
          || (cand.cost === atTarget.cost && cand.item < atTarget.item)) atTarget = cand;
      }
      if (!best || cls > best.cls || (cls === best.cls && (cand.cost < best.cost
        || (cand.cost === best.cost && cand.item < best.item)))) best = cand;
    }
    if (atTarget) { atTarget.met = true; return atTarget; }
    if (best) { best.met = false; return best; }
    return null;
  }

  // Turn an armour/rig/helmet record into the numbers the score needs, filling
  // its plate sockets on the way.
  //
  // The distinction that matters, and that the data draws for us: an armorSlot
  // with `allowedPlates` and no class of its own is an EMPTY SOCKET (front,
  // back, sides) - a carrier without plates in it stops nothing. An armorSlot
  // that carries its own `class` is built-in soft armour and needs no shopping.
  function resolveArmorConfig(pool, id, opts) {
    const o = opts || {};
    const p = poolProps(pool, id);
    const offer = poolOffer(pool, id);
    if (!p) return { ok: false, reason: 'no properties' };
    if (!offer) return { ok: false, reason: 'no offer you can use' };

    const slots = Array.isArray(p.armorSlots) ? p.armorSlots : [];
    const plateSlots = slots.filter((s) => s && Array.isArray(s.allowedPlates) && s.allowedPlates.length);
    const required = plateSlots.filter((s) => PLATE_SLOT_RE.test(String(s.nameId || '')));
    const sides = plateSlots.filter((s) => SIDE_SLOT_RE.test(String(s.nameId || '')));

    // THE APPLES-TO-ORANGES TRAP, re-verified against the shipped data
    // (86 socketed carriers, 79 helmets, 11 soft-only vests):
    //  * on a HELMET or a soft-only vest, props.durability IS the sum of its
    //    armorSlot durabilities, exactly - 79/79 and 11/11 match.
    //  * on a plate CARRIER it never is - 86/86 differ - because the plate
    //    sockets carry allowedPlates and no durability of their own. The
    //    residual is the factory plates the manufacturer shipped it with
    //    (6B43: 510 = 350 soft + 160 of plates; AVS rig: 212 = 112 soft + 100).
    //
    // So a carrier's durability must be rebuilt as "soft layers + the plates we
    // actually chose", which is the same QUANTITY the factory number reports and
    // a different number whenever we buy different plates. Scoring it off ONE
    // plate instead ranked a 100-durability integrated Soviet rig above every
    // plate carrier in the game.
    const softDur = slots.reduce(
      (sum, s) => sum + (s && s.class != null ? num(s.durability, 0) : 0), 0);

    let cost = offer.rub;
    let speed = normPenaltyPct(p.speedPenalty);
    let ergo = normPenaltyPct(p.ergoPenalty);
    let turn = normPenaltyPct(p.turnPenalty);
    const extras = [];
    const why = [];
    const notes = [];

    if (!required.length) {
      // integrated armour (and every helmet): the class on the record IS the
      // protection.
      const cls = num(p.class, 0);
      if (cls <= 0) return { ok: false, reason: 'no armour class' };
      return {
        ok: true,
        effClass: cls,
        dur: num(p.durability, 0),
        blunt: num(p.bluntThroughput, 0),
        speed, ergo, turn,
        cost, offer, extras,
        why: ['class ' + cls + ', ' + num(p.durability, 0) + ' durability'],
        notes,
        met: cls >= Math.round(num(o.targetClass, 0)),
      };
    }

    // a carrier. Front and back are mandatory; without them it is a vest.
    const bySlot = {};
    for (let i = 0; i < required.length; i++) {
      const s = required[i];
      const nameId = String(s.nameId || '').toLowerCase();
      const plate = pickPlate(pool, s.allowedPlates, o.targetClass);
      if (!plate) {
        return {
          ok: false,
          reason: 'no plate you can buy fits the ' + (s.name || nameId) + ' slot',
        };
      }
      bySlot[nameId] = plate;
      cost += plate.cost;
      speed += plate.speed;
      ergo += plate.ergo;
      turn += plate.turn;
      extras.push({
        kind: 'plate',
        slot: s.name || s.nameId,
        item: plate.item,
        name: plate.name,
        count: 1,
        plateDur: plate.dur,
        offer: plate.offer,
        cost: plate.cost,
        why: ['class ' + plate.cls + ', ' + plate.dur + ' durability'].concat(plate.offer.why || []),
      });
      if (!plate.met) {
        notes.push('best ' + (s.name || nameId) + ' plate you can buy is class '
          + plate.cls + ', under the class ' + Math.round(num(o.targetClass, 0)) + ' target');
      }
    }

    if (o.sidePlates) {
      for (let i = 0; i < sides.length; i++) {
        const s = sides[i];
        const plate = pickPlate(pool, s.allowedPlates, o.targetClass);
        // sides are a preference, never a rejection reason
        if (!plate) { notes.push('no side plate available for ' + (s.name || s.nameId)); continue; }
        cost += plate.cost;
        speed += plate.speed;
        ergo += plate.ergo;
        turn += plate.turn;
        extras.push({
          kind: 'plate',
          slot: s.name || s.nameId,
          item: plate.item,
          name: plate.name,
          count: 1,
          plateDur: plate.dur,
          offer: plate.offer,
          cost: plate.cost,
          why: ['class ' + plate.cls + ', ' + plate.dur + ' durability'].concat(plate.offer.why || []),
        });
      }
    }

    const front = bySlot.front_plate || bySlot.back_plate;
    const back = bySlot.back_plate || front;
    // The front plate is the one that eats the shots you are facing, so it sets
    // the kit's effective class - NOT the `class` on the carrier, which only
    // describes whatever plates the manufacturer shipped it with.
    const effClass = front.cls;
    // soft layers + every plate we just bought: the same QUANTITY the carrier's
    // props.durability reports for its factory plates, recomputed for ours
    const plateDur = extras.reduce((sum, e) => sum + num(e.plateDur, 0), 0);
    const dur = softDur + plateDur;
    const blunt = front.blunt > 0 ? front.blunt : num(p.bluntThroughput, 0);
    why.push('class ' + effClass + ' front plate, ' + dur + ' durability');
    if (back && back !== front) why.push('class ' + back.cls + ' back plate');

    return {
      ok: true,
      effClass, dur, blunt,
      speed, ergo, turn,
      cost, offer, extras, why, notes,
      carrier: true,
      met: effClass >= Math.round(num(o.targetClass, 0)),
    };
  }

  // Mobility multiplier in 0.4..1. Penalties arrive normalised to percent, and
  // are NEGATIVE, so every term subtracts.
  function armorMobility(cfg, weights) {
    const A = (weights || WEIGHTS).ARMOR;
    return clamp(
      1 + (A.MOB_SPEED * cfg.speed / 100)
        + (A.MOB_ERGO * cfg.ergo / 100)
        + (A.MOB_TURN * cfg.turn / 100),
      A.MOB_MIN, A.MOB_MAX
    );
  }

  function armorProtection(cfg, weights) {
    const A = (weights || WEIGHTS).ARMOR;
    return Math.pow(Math.max(0, cfg.effClass), A.CLASS_EXP)
      * (Math.max(0, cfg.dur) / A.DUR_REF)
      * (1 + A.BLUNT_W * (1 - clamp01(cfg.blunt)));
  }

  function armorScore(cfg, mobilityWeight, weights) {
    const mob = armorMobility(cfg, weights);
    return round4n(armorProtection(cfg, weights) * Math.pow(mob, num(mobilityWeight, 1)));
  }

  // Shared by rankArmor / rankHelmets / the armoured half of rankRigs.
  function rankArmorLike(pool, ids, slot, opts) {
    const o = opts || {};
    const W = poolWeights(pool);
    const out = [];
    const rejected = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const cfg = resolveArmorConfig(pool, id, o);
      if (!cfg.ok) { rejected.push({ item: id, name: itemName(pool, id), reason: cfg.reason }); continue; }
      const score = armorScore(cfg, o.mobilityWeight, W);
      if (!(score > 0) || !(cfg.cost > 0)) continue;
      const mob = armorMobility(cfg, W);
      const why = cfg.why.slice();
      why.push('mobility ' + Math.round(mob * 100) + '%');
      why.push.apply(why, cfg.offer.why || []);
      out.push({
        slot,
        item: id,
        name: itemName(pool, id),
        offer: cfg.offer,
        cost: cfg.cost,
        score,
        value: score / cfg.cost,
        effClass: cfg.effClass,
        mobility: round4n(mob),
        meetsTarget: !!cfg.met,
        extras: cfg.extras,
        notes: cfg.notes,
        why,
      });
    }
    const ranked = sortRanked(out);
    ranked.rejected = rejected.sort((a, b) => (String(a.item) < String(b.item) ? -1 : 1));
    return ranked;
  }

  function idsOfType(pool, type) {
    const props = (pool && pool.props) || {};
    return Object.keys(props).filter((id) => props[id] && props[id].propertiesType === type).sort();
  }

  // rankArmor(pool, { targetClass, mobilityWeight, sidePlates })
  function rankArmor(pool, opts) {
    return rankArmorLike(pool, idsOfType(pool, 'ItemPropertiesArmor'), 'armor', opts);
  }

  // rankHelmets(pool, { targetClass, mobilityWeight })
  // ItemPropertiesHelmet also covers unarmoured headwear and visors, so the
  // class filter is what separates a helmet from a hat.
  function rankHelmets(pool, opts) {
    const props = (pool && pool.props) || {};
    const ids = idsOfType(pool, 'ItemPropertiesHelmet')
      .filter((id) => num(props[id].class, 0) > 0);
    return rankArmorLike(pool, ids, 'helmet', opts);
  }

  // ==========================================================================
  // rigs
  // ==========================================================================
  function rigCapacity(props) {
    const cap = num(props && props.capacity, 0);
    if (cap > 0) return cap;
    const grids = (props && Array.isArray(props.grids)) ? props.grids : [];
    let sum = 0;
    for (let i = 0; i < grids.length; i++) {
      sum += num(grids[i] && grids[i].width, 0) * num(grids[i] && grids[i].height, 0);
    }
    return sum;
  }

  function rigIsArmored(props) {
    if (!props) return false;
    if (num(props.class, 0) > 0) return true;
    const slots = Array.isArray(props.armorSlots) ? props.armorSlots : [];
    return slots.length > 0;
  }

  // rankRigs(pool, { needArmor, targetClass, mobilityWeight, sidePlates })
  //
  // needArmor splits the list in two on purpose, and it is a GAME rule, not a
  // preference: an armoured rig and a body armour occupy the same slot, so the
  // "armour + plain rig" loadout may only use unarmoured rigs, and the
  // "armoured rig" loadout may only use armoured ones.
  function rankRigs(pool, opts) {
    const o = opts || {};
    const W = poolWeights(pool);
    const props = (pool && pool.props) || {};
    const all = idsOfType(pool, 'ItemPropertiesChestRig');
    const needArmor = !!o.needArmor;
    const ids = all.filter((id) => rigIsArmored(props[id]) === needArmor);

    if (needArmor) {
      const ranked = rankArmorLike(pool, ids, 'rig', o);
      // reweight: an armoured rig is doing two jobs, and a 5-slot plate carrier
      // that carries nothing is not the same buy as a 23-slot one.
      //
      // protScore and capScore are kept SEPARATELY alongside the blended score
      // because the two loadouts can only be compared on shared scales - see
      // normalizeTorso. Collapsing them here is what made an armoured rig tie
      // with "best armour in the game plus best rig in the game".
      const out = ranked.map((r) => {
        const cap = rigCapacity(props[r.item]);
        const mob = num(r.mobility, 1);
        const capScore = round4n(cap * Math.pow(mob, num(o.mobilityWeight, 1)));
        const score = round4n(r.score * (1 + W.RIG.CAP_BONUS * (cap / W.RIG.CAP_REF)));
        const why = r.why.slice();
        why.unshift(cap + ' slots of storage');
        return Object.assign({}, r, {
          score,
          value: score / r.cost,
          capacity: cap,
          protScore: r.score,
          capScore,
          armored: true,
          why,
        });
      });
      const sorted = sortRanked(out);
      sorted.rejected = ranked.rejected;
      return sorted;
    }

    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const p = props[id];
      const offer = poolOffer(pool, id);
      if (!offer) continue;
      const cap = rigCapacity(p);
      if (!(cap > 0)) continue;
      const cfg = {
        effClass: 0, dur: 0, blunt: 0,
        speed: normPenaltyPct(p.speedPenalty),
        ergo: normPenaltyPct(p.ergoPenalty),
        turn: normPenaltyPct(p.turnPenalty),
      };
      const mob = armorMobility(cfg, W);
      const score = round4n(cap * Math.pow(mob, num(o.mobilityWeight, 1)));
      const why = [cap + ' slots of storage', 'mobility ' + Math.round(mob * 100) + '%'];
      why.push.apply(why, offer.why || []);
      out.push({
        slot: 'rig',
        item: id,
        name: itemName(pool, id),
        offer,
        cost: offer.rub,
        score,
        value: score / offer.rub,
        capacity: cap,
        protScore: 0, // an unarmoured rig stops nothing, and must not pretend to
        capScore: score,
        mobility: round4n(mob),
        armored: false,
        extras: [],
        notes: [],
        why,
      });
    }
    const ranked = sortRanked(out);
    ranked.rejected = [];
    return ranked;
  }

  // ==========================================================================
  // backpacks
  // ==========================================================================
  function rankBackpacks(pool, opts) {
    const o = opts || {};
    const W = poolWeights(pool);
    const props = (pool && pool.props) || {};
    const ids = idsOfType(pool, 'ItemPropertiesBackpack');
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const p = props[id];
      const offer = poolOffer(pool, id);
      if (!offer) continue;
      const cap = rigCapacity(p);
      if (!(cap > 0)) continue;
      const cfg = {
        effClass: 0, dur: 0, blunt: 0,
        speed: normPenaltyPct(p.speedPenalty),
        ergo: normPenaltyPct(p.ergoPenalty),
        turn: normPenaltyPct(p.turnPenalty),
      };
      const mob = armorMobility(cfg, W);
      const score = round4n(cap * Math.pow(mob, num(o.mobilityWeight, 1)));
      const why = [cap + ' slots of storage', 'mobility ' + Math.round(mob * 100) + '%'];
      why.push.apply(why, offer.why || []);
      out.push({
        slot: 'backpack',
        item: id,
        name: itemName(pool, id),
        offer,
        cost: offer.rub,
        score,
        value: score / offer.rub,
        capacity: cap,
        mobility: round4n(mob),
        extras: [],
        notes: [],
        why,
      });
    }
    return sortRanked(out);
  }

  // ==========================================================================
  // meds
  // ==========================================================================
  // One medkit plus one painkiller, costed as a single line - which is how the
  // slot is actually filled. The bonus for HeavyBleeding is not cosmetic: a kit
  // that cannot stop a heavy bleed is a kit you bleed out wearing.
  function rankMeds(pool, opts) {
    const W = poolWeights(pool);
    const props = (pool && pool.props) || {};
    const cure = W.MEDS.HEAVY_BLEED_CURE;

    // cheapest painkiller per use
    let pk = null;
    const pkIds = idsOfType(pool, 'ItemPropertiesPainkiller');
    for (let i = 0; i < pkIds.length; i++) {
      const id = pkIds[i];
      const offer = poolOffer(pool, id);
      if (!offer) continue;
      const uses = Math.max(1, num(props[id].uses, 1));
      const per = offer.rub / uses;
      const cand = { item: id, name: itemName(pool, id), offer, cost: offer.rub, uses, per };
      if (!pk || per < pk.per || (per === pk.per && cand.item < pk.item)) pk = cand;
    }

    const ids = idsOfType(pool, 'ItemPropertiesMedKit');
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const p = props[id];
      const offer = poolOffer(pool, id);
      if (!offer) continue;
      const hp = num(p.hitpoints, 0);
      if (!(hp > 0)) continue;
      const cures = Array.isArray(p.cures) ? p.cures : [];
      const heavy = cures.indexOf(cure) >= 0;
      const score = round4n(hp * (heavy ? W.MEDS.HEAVY_BLEED_BONUS : 1));
      const extras = [];
      const notes = [];
      let cost = offer.rub;
      if (pk) {
        extras.push({
          kind: 'painkiller',
          item: pk.item,
          name: pk.name,
          count: 1,
          offer: pk.offer,
          cost: pk.cost,
          why: [pk.uses + ' uses'].concat(pk.offer.why || []),
        });
        cost += pk.cost;
      } else {
        notes.push('no painkiller you can buy - bring one from stash');
      }
      const why = [hp + ' HP' + (heavy ? ', stops heavy bleeds' : ', no heavy-bleed cure')];
      why.push.apply(why, offer.why || []);
      out.push({
        slot: 'meds',
        item: id,
        name: itemName(pool, id),
        offer,
        cost,
        score,
        value: score / cost,
        heavyBleed: heavy,
        extras,
        notes,
        why,
      });
    }
    return sortRanked(out);
  }

  // ==========================================================================
  // assembly
  // ==========================================================================
  // Two loadouts are always costed, because in game they are mutually
  // exclusive and which one wins depends entirely on the budget:
  //   'armor+rig'   - body armour AND an unarmoured rig
  //   'armored-rig' - an armoured rig INSTEAD of both
  const CONFIGS = [
    { id: 'armor+rig', slots: ['weaponAmmo', 'armor', 'helmet', 'rig', 'meds', 'backpack'], armoredRig: false },
    { id: 'armored-rig', slots: ['weaponAmmo', 'helmet', 'rig', 'meds', 'backpack'], armoredRig: true },
  ];

  // The marker repair leaves when a configuration has bottomed out. It says
  // "this configuration", never "your traders", because repair only ever sees
  // one of the two loadouts - the false version of this sentence claimed a
  // 95,618 kit was the cheapest available while the other configuration bottomed
  // out at 86,718.
  const FLOOR_NOTE = 'nothing cheaper is available - this is the cheapest kit'
    + ' this configuration can be built from';

  // Slot scores live on wildly different scales (an armour score is in the
  // hundreds, an ammo score is under 1), so nothing can be compared until each
  // is normalised against the best thing in its OWN list. After this every slot
  // contributes 0..1 and the budget split is what weights them.
  function normalizeList(list) {
    let max = 0;
    for (let i = 0; i < list.length; i++) if (list[i].score > max) max = list[i].score;
    if (!(max > 0)) return list.map((l) => Object.assign({}, l, { norm: 0 }));
    return list.map((l) => Object.assign({}, l, { norm: l.score / max }));
  }

  // THE COMPARISON THAT PER-LIST NORMALISATION GETS WRONG.
  //
  // Normalising each slot against its own best means the best armoured rig in
  // the game scores 1.0 and so does the best body armour, so at an unbounded
  // budget the two loadouts TIE - and the tie-break then hands "Best" to a kit
  // with no body armour in it. That is not a close call, it is an artefact.
  //
  // The fix is to put both loadouts on the SAME two scales: protection is
  // normalised against the best protection available in either list, capacity
  // against the best capacity available in either list. The armoured rig then
  // scores a share-weighted blend of the two, and can only reach 1.0 by being
  // simultaneously the best-protecting AND the best-carrying thing on offer -
  // which no rig is.
  function normalizeTorso(armorList, plainRigs, armoredRigs, weights) {
    const W = weights || WEIGHTS;
    const wArmor = num(W.BUDGET_SPLIT.armor, 0);
    const wRig = num(W.BUDGET_SPLIT.rig, 0);
    const wSum = wArmor + wRig;

    let protMax = 0;
    let capMax = 0;
    const seeProt = (v) => { if (v > protMax) protMax = v; };
    const seeCap = (v) => { if (v > capMax) capMax = v; };
    armorList.forEach((a) => seeProt(num(a.score, 0)));
    armoredRigs.forEach((r) => { seeProt(num(r.protScore, 0)); seeCap(num(r.capScore, 0)); });
    plainRigs.forEach((r) => seeCap(num(r.capScore, r.score)));

    const pd = protMax > 0 ? protMax : 1;
    const cd = capMax > 0 ? capMax : 1;

    const armor = armorList.map((a) => Object.assign({}, a, { norm: num(a.score, 0) / pd }));
    const rig = plainRigs.map((r) => Object.assign({}, r, { norm: num(r.capScore, r.score) / cd }));
    const armored = armoredRigs.map((r) => Object.assign({}, r, {
      norm: wSum > 0
        ? ((wArmor * (num(r.protScore, 0) / pd)) + (wRig * (num(r.capScore, 0) / cd))) / wSum
        : 0,
    }));

    // greedyPick takes the first entry that fits, so the list order has to
    // follow the number the score is actually judged on
    const byNorm = (l) => l.sort((a, b) => (b.norm - a.norm)
      || (a.cost - b.cost)
      || (String(a.item) < String(b.item) ? -1 : 1));
    return { armor: byNorm(armor), rig: byNorm(rig), armored: byNorm(armored) };
  }

  function splitFor(config, slot, weights) {
    const s = (weights || WEIGHTS).BUDGET_SPLIT;
    // the armoured rig is paid for out of the armour AND rig shares, because it
    // is standing in for both
    if (config.armoredRig && slot === 'rig') return num(s.armor, 0) + num(s.rig, 0);
    return num(s[slot], 0);
  }

  function kitTotal(lines) {
    let t = 0;
    Object.keys(lines).forEach((k) => { if (lines[k]) t += lines[k].cost; });
    return t;
  }

  // `droppable` is the set of slots this kit COULD have filled and did not -
  // an optional slot with a non-empty pool. Leaving one out is not free: it
  // scores DROP_PENALTY slot-shares below zero, so "dropped the backpack" shows
  // up in the number and not only in a note. A slot with nothing priced in it,
  // or one the player switched off, is not charged - there was no choice to
  // make.
  function kitScore(lines, config, weights, droppable) {
    const W = weights || WEIGHTS;
    const penalty = num(W.REPAIR.DROP_PENALTY, 1);
    const charge = droppable || {};
    let s = 0;
    for (let i = 0; i < config.slots.length; i++) {
      const slot = config.slots[i];
      const line = lines[slot];
      if (line) s += splitFor(config, slot, W) * line.norm;
      else if (charge[slot]) s -= splitFor(config, slot, W) * penalty;
    }
    return s;
  }

  // The greedy first pass: best thing in each slot that fits that slot's share.
  // Deliberately dumb - the repair loop is what makes it good.
  //
  // `emptyNotes` is a slot -> sentence map supplied by the caller, which is the
  // only layer that knows WHY a slot came back empty (see emptySlotReasons).
  // Hard-coding one cause here was a real bug: the weapon slot said "set a
  // trader loyalty level" even when every level WAS set and the actual gate was
  // the penetration floor, which sends the player to the wrong screen.
  function greedyPick(pools, config, budget, weights, emptyNotes) {
    const lines = {};
    const notes = [];
    const reasons = emptyNotes || {};
    for (let i = 0; i < config.slots.length; i++) {
      const slot = config.slots[i];
      const list = pools[slot] || [];
      if (!list.length) {
        notes.push(reasons[slot]
          || ('nothing in the ' + slot + ' slot is priced with your traders and quests'));
        lines[slot] = null;
        continue;
      }
      const share = budget === Infinity ? Infinity : budget * splitFor(config, slot, weights);
      let pick = null;
      for (let j = 0; j < list.length; j++) {
        if (list[j].cost <= share) { pick = list[j]; break; }
      }
      if (!pick) {
        // nothing fits the share: take the cheapest and let repair sort out the
        // total, rather than silently dropping the slot
        pick = list.reduce((a, b) => {
          if (!a) return b;
          if (b.cost !== a.cost) return b.cost < a.cost ? b : a;
          return String(b.item) < String(a.item) ? b : a;
        }, null);
      }
      lines[slot] = pick;
    }
    return { lines, notes };
  }

  // THE MONOTONICITY PASS, and the bug it exists for.
  //
  // The two passes below it each have a gate, and between those gates is a hole
  // a bigger budget can fall into. Observed on the shipped data: budget 365,000
  // scored 0.7876 at 301,754, and budget 368,000 scored 0.7662 at 332,135 - MORE
  // money bought a WORSE kit. The mechanism was three steps:
  //   1. the greedy pass takes a marginally better weapon the moment the 45%
  //      weapon share crosses its price,
  //   2. the down pass pays for it by gutting the cheapest-to-cut slot (the
  //      backpack, whose norm fell from 1.0 to 0.43 for a 0.015 weapon gain),
  //   3. and nothing ever puts it back: the down pass only fires OVER budget,
  //      and the up pass only fires under 0.8x of it.
  //
  // This pass has no such gate. It takes any single-slot move that raises the
  // kit's score without breaking the budget, preferring the ones that cost
  // nothing extra, and runs to a fixpoint. Every step strictly raises the score
  // by more than IMPROVE_EPS, and no step can push the total over budget, so it
  // terminates and cannot re-trigger the down pass.
  function improveStep(pools, config, lines, budget, weights, dropped) {
    const W = weights || WEIGHTS;
    const eps = num(W.REPAIR.IMPROVE_EPS, 1e-9);
    const finite = budget !== Infinity && Number.isFinite(budget);
    const room = finite ? budget - kitTotal(lines) : Infinity;
    // score up at no extra cost - always worth taking, and taken first
    let free = null;
    // score up for money the budget actually has left
    let paid = null;

    for (let i = 0; i < config.slots.length; i++) {
      const slot = config.slots[i];
      // a slot given up to fit the budget must not be bought straight back -
      // that is the same infinite loop the underspend pass guards against
      if (dropped && dropped[slot]) continue;
      const weight = splitFor(config, slot, W);
      if (!(weight > 0)) continue;
      const cur = lines[slot];
      const list = pools[slot] || [];
      const curCost = cur ? cur.cost : 0;
      const curNorm = cur ? cur.norm : 0;
      for (let j = 0; j < list.length; j++) {
        const c = list[j];
        const gain = (c.norm - curNorm) * weight;
        if (!(gain > eps)) continue;
        const added = c.cost - curCost;
        if (added <= 0) {
          if (!free || gain > free.gain
            || (gain === free.gain && (added < free.added
              || (added === free.added && String(c.item) < String(free.cand.item))))) {
            free = { slot, cand: c, gain, added };
          }
        } else if (added <= room) {
          const ratio = gain / added;
          if (!paid || ratio > paid.ratio
            || (ratio === paid.ratio && (gain > paid.gain
              || (gain === paid.gain && String(c.item) < String(paid.cand.item))))) {
            paid = { slot, cand: c, gain, ratio };
          }
        }
      }
    }
    return free || paid;
  }

  // Bounded, deterministic hill-climb. Down first (a kit over budget is not a
  // kit), then up (a 150k kit that costs 40k has not spent the money it was
  // given), then the ungated improvement pass above. Every step is the best
  // score-per-rouble trade available.
  function repair(pools, config, lines, budget, weights) {
    const W = weights || WEIGHTS;
    const notes = [];
    let iters = 0;
    const finite = budget !== Infinity && Number.isFinite(budget);
    const optional = W.REPAIR.OPTIONAL_SLOTS || [];
    // A slot dropped to make the money work must not be bought straight back by
    // the underspend pass - that is an infinite loop with a note on it.
    const dropped = {};
    let floored = false;

    while (iters++ < W.REPAIR.MAX_ITERS) {
      const total = kitTotal(lines);
      if (finite && total > budget) {
        let best = null;
        for (let i = 0; i < config.slots.length; i++) {
          const slot = config.slots[i];
          const cur = lines[slot];
          if (!cur) continue;
          const list = pools[slot] || [];
          const weight = splitFor(config, slot, W);
          for (let j = 0; j < list.length; j++) {
            const c = list[j];
            if (c.cost >= cur.cost) continue;
            const saved = cur.cost - c.cost;
            const loss = Math.max(0, cur.norm - c.norm) * weight;
            const ratio = loss / saved;
            if (!best || ratio < best.ratio
              || (ratio === best.ratio && (saved > best.saved
                || (saved === best.saved && String(c.item) < String(best.cand.item))))) {
              best = { slot, cand: c, ratio, saved };
            }
          }
        }
        if (best) { lines[best.slot] = best.cand; continue; }

        // last resort: give up a slot the raid can survive without
        let droppedOne = false;
        for (let i = 0; i < optional.length; i++) {
          const slot = optional[i];
          if (!lines[slot]) continue;
          notes.push('dropped the ' + slot + ' to fit the budget');
          lines[slot] = null;
          dropped[slot] = true;
          droppedOne = true;
          break;
        }
        if (droppedOne) continue;

        // Scoped to the CONFIGURATION on purpose. This function only ever sees
        // one of the two loadouts, so it cannot honestly claim anything about
        // the cheapest kit in the game - the other configuration may well have
        // a lower floor. assembleKits owns the kit-level number.
        //
        // Said once, and then the loop falls through to the improvement pass
        // rather than stopping: a kit at its price floor can still be holding a
        // same-price item that a better one could replace for nothing.
        if (!floored) { notes.push(FLOOR_NOTE); floored = true; }
      }

      if (finite && total < budget * W.REPAIR.UNDERSPEND) {
        let best = null;
        const room = budget - total;
        for (let i = 0; i < config.slots.length; i++) {
          const slot = config.slots[i];
          if (dropped[slot]) continue;
          const cur = lines[slot];
          const list = pools[slot] || [];
          const weight = splitFor(config, slot, W);
          const curCost = cur ? cur.cost : 0;
          const curNorm = cur ? cur.norm : 0;
          for (let j = 0; j < list.length; j++) {
            const c = list[j];
            const added = c.cost - curCost;
            if (added <= 0 || added > room) continue;
            const gain = c.norm - curNorm;
            if (gain <= 0) continue;
            const ratio = gain / added;
            if (!best || ratio > best.ratio
              || (ratio === best.ratio && String(c.item) < String(best.cand.item))) {
              best = { slot, cand: c, ratio };
            }
          }
        }
        if (best) { lines[best.slot] = best.cand; continue; }
        // nothing fits the leftover room at THIS threshold - fall through to
        // the improvement pass rather than stopping, or a kit that is merely
        // 79% spent never gets its free upgrades
      }

      const step = improveStep(pools, config, lines, budget, W, dropped);
      if (step) { lines[step.slot] = step.cand; continue; }
      break;
    }
    return notes;
  }

  // ==========================================================================
  // the exact pass: what makes "a bigger budget cannot buy a worse kit" a
  // property rather than a hope
  // ==========================================================================
  // Anything that costs MORE than another candidate in the same slot and scores
  // no better can never appear in a best kit. Dropping those leaves the slot's
  // Pareto frontier - on the shipped data, 5 to 12 entries against pools of 6
  // to 208.
  //
  // Sorted cost ascending, and the frontier is built with a STRICT improvement
  // test, so of several candidates at the same cost and score the cheapest and
  // then the lowest id survives. That is what keeps the solve reproducible.
  function paretoFront(list) {
    const s = (list || []).slice().sort((a, b) => (a.cost - b.cost)
      || (b.norm - a.norm)
      || (String(a.item) < String(b.item) ? -1 : 1));
    const out = [];
    let best = -Infinity;
    for (let i = 0; i < s.length; i++) {
      if (s[i].norm > best) { out.push(s[i]); best = s[i].norm; }
    }
    return out;
  }

  // Choosing one item per slot to maximise a weighted sum of norms under one
  // cost ceiling is a multiple-choice knapsack. Over the frontiers above it is
  // a tiny one, so it is solved exactly rather than climbed: combine the slots
  // one at a time, keeping only the non-dominated (cost, score) states.
  //
  // EXACTNESS IS THE WHOLE POINT. A hill-climb - however many passes it is
  // given - lands in whatever local optimum its starting point drains into, and
  // that starting point moves with the budget. That is precisely how 368,000
  // roubles bought a worse kit than 365,000 did. An exact solve has no starting
  // point: the set of affordable kits only GROWS with the budget, so the best
  // member of that set cannot get worse.
  //
  // Returns { lines, cost, score } or null when NOTHING is affordable at this
  // ceiling (the caller then falls back to the hill-climb, which bottoms out at
  // the cheapest kit the configuration can build and says so).
  function solveExact(pools, config, budget, weights, droppable) {
    const W = weights || WEIGHTS;
    const S = W.SOLVER || WEIGHTS.SOLVER;
    const eps = num(S.TIE_EPS, 1e-9);
    const maxFront = Math.max(1, num(S.MAX_FRONTIER, 20000));
    const penalty = num(W.REPAIR.DROP_PENALTY, 1);
    const finite = budget !== Infinity && Number.isFinite(budget);
    const charge = droppable || {};

    let front = [{ cost: 0, score: 0, pick: {}, key: '' }];
    for (let i = 0; i < config.slots.length; i++) {
      const slot = config.slots[i];
      const weight = splitFor(config, slot, W);
      const list = paretoFront(pools[slot] || []);
      const choices = [];
      // "nothing here" is a real option for a slot with nothing priced and for
      // one the raid can survive without - the second at a price (see
      // DROP_PENALTY). It is NOT an option for a gun, body armour or meds the
      // player can actually afford.
      if (!list.length || charge[slot]) choices.push(null);
      for (let j = 0; j < list.length; j++) choices.push(list[j]);

      const next = [];
      for (let a = 0; a < front.length; a++) {
        const node = front[a];
        for (let b = 0; b < choices.length; b++) {
          const c = choices[b];
          const cost = node.cost + (c ? c.cost : 0);
          if (finite && cost > budget) continue;
          const pick = Object.assign({}, node.pick);
          pick[slot] = c || null;
          const delta = c
            ? (weight * c.norm)
            : (charge[slot] ? -(weight * penalty) : 0);
          next.push({
            cost,
            score: node.score + delta,
            pick,
            key: node.key + '|' + (c ? String(c.item) : '-'),
          });
        }
      }
      if (!next.length) return null;

      // dominance prune: cheapest first, and a state only survives if it scores
      // strictly better than everything cheaper than it
      next.sort((x, y) => (x.cost - y.cost)
        || (y.score - x.score)
        || (x.key < y.key ? -1 : (x.key > y.key ? 1 : 0)));
      const kept = [];
      let bestScore = -Infinity;
      for (let n = 0; n < next.length; n++) {
        if (next[n].score > bestScore + eps) { kept.push(next[n]); bestScore = next[n].score; }
      }
      // A frontier this size means the data is nothing like the game's. Refuse
      // rather than return an answer that is neither exact nor bounded.
      if (kept.length > maxFront) return null;
      front = kept;
    }

    let best = null;
    for (let i = 0; i < front.length; i++) {
      const n = front[i];
      if (!best
        || n.score > best.score + eps
        || (Math.abs(n.score - best.score) <= eps
          && (n.cost < best.cost || (n.cost === best.cost && n.key < best.key)))) {
        best = n;
      }
    }
    if (!best) return null;
    return { lines: best.pick, cost: best.cost, score: best.score };
  }

  // WHY A SLOT CAME BACK EMPTY, said honestly.
  //
  // The weapon slot is the one that empties most often and the one whose cause
  // is least guessable, and the old text named exactly one cause - "set at least
  // one trader loyalty level" - which it printed even when every level WAS set
  // and the real gate was the penetration floor. Three causes are separable
  // from what the pool already knows, so all three are said:
  //   * nothing is priced at all (no loyalty levels, no flea)
  //   * ammunition is priced but none of it clears the class floor
  //   * ammunition clears, but no weapon that can fire it has an offer
  //
  // Returns a slot -> sentence map for greedyPick; a slot absent from it falls
  // back to the generic wording.
  function emptySlotReasons(pool, opts) {
    const o = opts || {};
    const W = poolWeights(pool);
    const out = {};

    // the backpack is the one slot the player can switch off, and "nothing is
    // priced" is a lie when they asked for nothing
    if (o.noBackpack) out.backpack = 'backpack skipped by preference';

    const props = (pool && pool.props) || {};
    const floor = penFloorFor(o.targetClass, W);
    const ids = Object.keys(props).sort();
    let ammoPriced = false;
    let bestPen = null;
    let clears = false;
    for (let i = 0; i < ids.length; i++) {
      const p = props[ids[i]];
      if (!p || p.propertiesType !== 'ItemPropertiesAmmo') continue;
      if (!poolOffer(pool, ids[i])) continue;
      ammoPriced = true;
      const pen = num(p.penetrationPower, 0);
      if (bestPen == null || pen > bestPen) bestPen = pen;
      if (pen >= floor) clears = true;
    }

    if (!ammoPriced) {
      // EVERY round in the game is flagged noFlea, so ammo can only come from a
      // trader or a barter. With no loyalty levels set nothing can be fed, and
      // therefore no weapon is offered at all.
      out.weaponAmmo = o.noTraderLevels
        ? 'no weapon is priced - ammunition cannot be bought on the flea, so a'
          + ' weapon needs at least one trader loyalty level set'
        : 'no weapon is priced - no ammunition at all can be bought with your'
          + ' trader levels and finished quests';
    } else if (!clears) {
      out.weaponAmmo = 'no weapon is priced - the best round you can buy'
        + ' penetrates ' + (bestPen == null ? 0 : round4n(bestPen))
        + ', under the ' + floor + ' the class '
        + Math.max(0, Math.round(num(o.targetClass, 0)))
        + ' target needs. Lower the target class or raise a trader level.';
    } else {
      out.weaponAmmo = 'no weapon is priced - ammunition that clears the class '
        + Math.max(0, Math.round(num(o.targetClass, 0)))
        + ' floor is on sale, but no weapon that fires it is';
    }
    return out;
  }

  // assembleKits({ items, props, barters, questState, profile, budget,
  //                targetClass, mobilityWeight, fleaAllowed, fleaMinLevel,
  //                prefs: { sidePlates, backpack }, weights })
  // -> { kits: [ {label,total,score,lines,notes,...} x3 ], offers, pools, notes }
  function assembleKits(opts) {
    const o = opts || {};
    const W = o.weights || WEIGHTS;
    const profile = o.profile || {};
    const prefs = o.prefs || {};
    // A non-finite POSITIVE budget means "no ceiling", exactly like the Best
    // tier's null multiplier. num() would have folded Infinity to 0 and priced
    // an unbounded request as a kit nobody can afford anything in.
    const rawBudget = Number(o.budget);
    const budget = Number.isFinite(rawBudget)
      ? Math.max(0, rawBudget)
      : (rawBudget > 0 ? Infinity : 0);
    const targetClass = Math.max(0, Math.round(num(o.targetClass, 4)));
    const mobilityWeight = clamp(num(o.mobilityWeight, 1), 0, 2);

    const offers = o.offers || buildOfferIndex({
      items: o.items,
      barters: o.barters,
      questState: o.questState,
      traderLevels: profile.traderLevels,
      playerLevel: profile.playerLevel,
      fleaAllowed: o.fleaAllowed,
      fleaMinLevel: o.fleaMinLevel,
      weights: W,
    });

    const pool = { items: o.items || {}, props: o.props || {}, offers, weights: W };
    const rankOpts = { targetClass, mobilityWeight, sidePlates: !!prefs.sidePlates };

    const armorList = rankArmor(pool, rankOpts);
    const helmetList = rankHelmets(pool, rankOpts);
    const weaponList = rankWeapons(pool, rankOpts);
    const plainRigs = rankRigs(pool, Object.assign({ needArmor: false }, rankOpts));
    const armoredRigs = rankRigs(pool, Object.assign({ needArmor: true }, rankOpts));
    const medsList = rankMeds(pool, rankOpts);
    const packList = prefs.backpack === false ? [] : rankBackpacks(pool, rankOpts);

    const torso = normalizeTorso(armorList, plainRigs, armoredRigs, W);
    const poolsA = {
      weaponAmmo: normalizeList(weaponList),
      armor: torso.armor,
      helmet: normalizeList(helmetList),
      rig: torso.rig,
      meds: normalizeList(medsList),
      backpack: normalizeList(packList),
    };
    const poolsB = {
      weaponAmmo: poolsA.weaponAmmo,
      helmet: poolsA.helmet,
      rig: torso.armored,
      meds: poolsA.meds,
      backpack: poolsA.backpack,
    };
    const poolsFor = (config) => (config.armoredRig ? poolsB : poolsA);

    const traderLevels = (profile.traderLevels && typeof profile.traderLevels === 'object')
      ? profile.traderLevels : {};
    const noTraderLevels = !Object.keys(traderLevels)
      .some((t) => traderLevelOf(traderLevels, t) != null);
    const emptyNotes = emptySlotReasons(pool, {
      targetClass,
      noTraderLevels,
      noBackpack: prefs.backpack === false,
    });

    const kits = (W.TIERS || WEIGHTS.TIERS).map((tier) => {
      const cap = tier.mult == null ? Infinity : budget * tier.mult;
      const cands = [];
      for (let i = 0; i < CONFIGS.length; i++) {
        const config = CONFIGS[i];
        const pools = poolsFor(config);
        // greedyPick runs either way: it is the only layer that says WHY a slot
        // came back empty, and that is true of the exact answer too.
        const g = greedyPick(pools, config, cap, W, emptyNotes);
        // which optional slots were a CHOICE at all - one with nothing priced
        // in it, or switched off by preference, was never on the table
        const droppable = {};
        (W.REPAIR.OPTIONAL_SLOTS || []).forEach((slot) => {
          if (config.slots.indexOf(slot) >= 0 && (pools[slot] || []).length) droppable[slot] = true;
        });

        const exact = solveExact(pools, config, cap, W, droppable);
        let lines;
        let notes;
        if (exact) {
          lines = exact.lines;
          notes = g.notes.slice();
          Object.keys(droppable).forEach((slot) => {
            if (!lines[slot]) notes.push('dropped the ' + slot + ' to fit the budget');
          });
        } else {
          // NOTHING fits this ceiling (or the frontier was too large to solve
          // honestly). The hill-climb bottoms out at the cheapest kit this
          // configuration can build, and its notes say so.
          lines = g.lines;
          notes = g.notes.concat(repair(pools, config, lines, cap, W));
        }
        cands.push({
          config,
          lines,
          notes,
          score: kitScore(lines, config, W, droppable),
          total: kitTotal(lines),
        });
      }

      // WHICH CONFIGURATION WINS depends on whether the budget is reachable at
      // all. When one of them fits, the question is "which is better" and the
      // answer is the score, with ties going to the conventional loadout so
      // "the armoured rig won" always means it won on merit. When NEITHER fits,
      // the question is "which costs least" - handing back the pricier of two
      // unaffordable kits helps nobody, and it is what made the cheapest-kit
      // note a lie.
      const fits = cands.filter((c) => cap === Infinity || c.total <= cap);
      const pick = fits.length ? fits : cands;
      let best = null;
      for (let i = 0; i < pick.length; i++) {
        const cand = pick[i];
        if (!best) { best = cand; continue; }
        const better = fits.length
          ? (cand.score > best.score + W.CONFIG_TIE_EPS
            || (Math.abs(cand.score - best.score) <= W.CONFIG_TIE_EPS && cand.total < best.total))
          : (cand.total < best.total
            || (cand.total === best.total && cand.score > best.score + W.CONFIG_TIE_EPS));
        if (better) best = cand;
      }
      // the true floor across BOTH loadouts, which is the only number the
      // kit-level note is allowed to quote
      let cheapest = cands[0].total;
      for (let i = 1; i < cands.length; i++) {
        if (cands[i].total < cheapest) cheapest = cands[i].total;
      }

      const lines = [];
      const notes = best.notes.slice();
      for (let i = 0; i < best.config.slots.length; i++) {
        const slot = best.config.slots[i];
        const l = best.lines[slot];
        if (!l) continue;
        lines.push({
          slot,
          item: l.item,
          name: l.name,
          offer: l.offer,
          cost: l.cost,
          score: l.score,
          norm: round4n(l.norm),
          extras: l.extras || [],
          why: l.why || [],
          effClass: l.effClass,
          capacity: l.capacity,
          meetsTarget: l.meetsTarget,
        });
        (l.notes || []).forEach((n) => { if (notes.indexOf(n) < 0) notes.push(n); });
      }
      if (cap !== Infinity && best.total > cap) {
        // best.total === cheapest here, because nothing fitting existed and the
        // selection above is cost-first - so this number is checkable, not a
        // claim about a kit the player was never shown.
        notes.push('this is over the ' + Math.round(cap) + ' budget - the cheapest kit'
          + ' your traders can sell you costs ' + Math.round(cheapest));
      }
      return {
        label: tier.label,
        config: best.config.id,
        budget: cap === Infinity ? null : Math.round(cap),
        total: best.total,
        score: round4n(best.score),
        lines,
        notes,
      };
    });

    const notes = [];
    const un = (offers.notes && offers.notes.unknownTraders) || [];
    if (un.length) {
      notes.push('unknownTraderLevels:' + un.length);
    }
    if (offers.notes && offers.notes.fleaBlocked) {
      notes.push('flea:' + offers.notes.fleaBlocked);
    }

    return {
      kits,
      offers,
      pools: { A: poolsA, B: poolsB },
      targetClass,
      mobilityWeight,
      notes,
      unknownTraders: un,
      fleaBlocked: (offers.notes && offers.notes.fleaBlocked) || null,
    };
  }

  return {
    taskList,
    stateMap,
    statusOf,
    REQ_STATUS,
    requirementMet,
    traderRequirementMet,
    traderLevelOf,
    estimateTraderLevels,
    inferMinPlayerLevel,
    factionAllows,
    questAvailability,
    // ---- the kit optimizer ----
    WEIGHTS,
    CONFIGS,
    clamp,
    clamp01,
    normPenaltyPct,
    buildOfferIndex,
    ammoEfficiency,
    penFloorFor,
    rankAmmo,
    weaponScore,
    usablePresets,
    rankWeapons,
    pickPlate,
    resolveArmorConfig,
    armorMobility,
    armorProtection,
    armorScore,
    rankArmor,
    rankHelmets,
    rigCapacity,
    rigIsArmored,
    rankRigs,
    rankBackpacks,
    rankMeds,
    normalizeList,
    normalizeTorso,
    splitFor,
    greedyPick,
    improveStep,
    repair,
    paretoFront,
    solveExact,
    emptySlotReasons,
    FLOOR_NOTE,
    assembleKits,
  };
}));
