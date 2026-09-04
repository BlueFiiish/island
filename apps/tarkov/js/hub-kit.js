// Pilot Hub - the kit optimizer.
//
// Loaded two ways, exactly like the other hub views: as a plain <script> in the
// hub window and via require() from test/hub.test.mjs. EVERY DOM touch lives
// behind render().
//
// What this view is FOR: "what should I take into this raid for 150k", answered
// against YOUR loyalty levels and YOUR finished quests rather than against a
// tier list written by someone with every trader maxed. All of the arithmetic
// is in src/kit.js, which is pure and tested; this file is the controls, the
// three cards, and the honesty about what could not be priced.
//
// The rule that shapes the rendering: a kit line must show WHERE the money
// goes. A card that says "Balanced - 141k" and nothing else is a number you
// cannot act on; every line therefore carries its source, its loyalty level and
// the plates or rounds folded into its price.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubKit = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const Kit = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('../kit.js')
    : (typeof globalThis !== 'undefined' ? globalThis.PilotKit : null);

  // ==========================================================================
  // PURE: the control surface
  // ==========================================================================
  const BUDGET_CHIPS = [75000, 150000, 300000, 500000];
  const DEFAULT_BUDGET = 150000;
  const MIN_BUDGET = 1000;
  // A budget nobody will ever type, high enough that the "Best" tier is never
  // the only way to see an expensive kit, low enough that a fat-fingered paste
  // cannot hand the optimizer a number that overflows the formatting.
  const MAX_BUDGET = 100000000;
  const CLASS_CHOICES = [2, 3, 4, 5, 6];
  const DEFAULT_CLASS = 4;
  const MOBILITY = { min: 0, max: 2, step: 0.25, default: 1 };
  // Mirrors Kit.WEIGHTS.FLEA_MIN_LEVEL. Read off the module when it is there so
  // the two cannot drift; the literal is the fallback for a test that loads
  // this file alone.
  const FLEA_MIN_LEVEL = (Kit && Kit.WEIGHTS && Kit.WEIGHTS.FLEA_MIN_LEVEL) || 15;

  // Blank, junk and negative all land on the default rather than on 0: a
  // budget of zero produces three empty cards and no explanation.
  function clampBudget(v) {
    // '' and '   ' are what an emptied number input hands back, and Number('')
    // is 0 - which would silently clamp a cleared box to the minimum instead of
    // putting the default back in it.
    if (v == null || String(v).trim() === '') return DEFAULT_BUDGET;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_BUDGET;
    if (n < MIN_BUDGET) return MIN_BUDGET;
    if (n > MAX_BUDGET) return MAX_BUDGET;
    return n;
  }

  function clampClass(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_CLASS;
    return CLASS_CHOICES.indexOf(n) >= 0 ? n : DEFAULT_CLASS;
  }

  function clampMobility(v) {
    // Same trap clampBudget documents above, and the same fix: Number('') and
    // Number(null) are 0, which is FINITE, so a cleared slider read as "protection
    // at any weight" rather than as the balanced default it is documented to be.
    // Only a real number is clamped; nothing at all puts the default back.
    if (v == null || String(v).trim() === '') return MOBILITY.default;
    const n = Number(v);
    if (!Number.isFinite(n)) return MOBILITY.default;
    return Math.min(MOBILITY.max, Math.max(MOBILITY.min, n));
  }

  // The flea starts ON only if it would actually work. Defaulting it on for a
  // level 8 character produces a kit list identical to the flea being off, and
  // then the toggle looks broken.
  function fleaDefault(playerLevel) {
    const n = Number(playerLevel);
    return Number.isFinite(n) && n >= FLEA_MIN_LEVEL;
  }

  function mobilityLabel(w) {
    const n = clampMobility(w);
    if (n <= 0.25) return 'protection at any weight';
    if (n < 0.85) return 'leans protection';
    if (n <= 1.15) return 'balanced';
    if (n < 1.75) return 'leans mobility';
    return 'mobility first';
  }

  // The one-line "where did this price come from". Everything the player needs
  // to walk up to a screen and buy it.
  function sourceChip(offer, traderName) {
    if (!offer) return { text: 'no offer', cls: 'src-none' };
    const name = traderName || 'Trader';
    if (offer.source === 'flea') return { text: 'flea', cls: 'src-flea' };
    if (offer.source === 'barter') {
      const n = (offer.components || []).length;
      return {
        text: name + ' LL' + (offer.lvl || 1) + ' barter (' + n + ')',
        cls: 'src-barter',
      };
    }
    return { text: name + ' LL' + (offer.lvl || 1), cls: 'src-trader' };
  }

  // The score is already 0..1 (the share of a perfect kit this one reaches), so
  // this is only a rounding - but it is the number the bar is drawn from and a
  // NaN width silently collapses the bar to nothing.
  function scoreBarPct(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return 0;
    return Math.round(Math.min(1, Math.max(0, n)) * 100);
  }

  function isOverBudget(kit) {
    return !!(kit && kit.budget != null && kit.total > kit.budget);
  }

  // 'Budget - fits 90,000' / 'Best - unbounded'. The budget half is what makes
  // three cards comparable at a glance.
  function budgetLabel(kit, formatRub) {
    if (!kit) return '';
    const f = formatRub || String;
    if (kit.budget == null) return 'no cap';
    return 'up to ' + f(kit.budget);
  }

  // What an extras row says. Plates and rounds are folded into the LINE cost
  // already, so these are shown as included rather than as separate purchases -
  // rendering them as additions would make every card look double-priced.
  function extraLabel(extra) {
    if (!extra) return '';
    if (extra.kind === 'ammo') return (extra.count || 0) + ' x ' + (extra.name || extra.item);
    if (extra.kind === 'plate') return (extra.slot || 'plate') + ': ' + (extra.name || extra.item);
    if (extra.kind === 'painkiller') return 'painkiller: ' + (extra.name || extra.item);
    return String(extra.name || extra.item || '');
  }

  const SLOT_LABEL = {
    weaponAmmo: 'Weapon',
    armor: 'Body armour',
    helmet: 'Helmet',
    rig: 'Rig',
    meds: 'Meds',
    backpack: 'Backpack',
  };

  function slotLabel(slot) {
    return SLOT_LABEL[slot] || String(slot || '');
  }

  // The profile line under the controls. A trader we were never told about is
  // shown as a gap, not skipped: the gap IS the actionable information, because
  // the pricer refuses every offer behind it.
  function traderLevelRows(profile, traders) {
    const levels = (profile && profile.traderLevels) || {};
    return (Array.isArray(traders) ? traders : [])
      .filter((t) => t && t.id)
      .map((t) => {
        const n = Number(levels[t.id]);
        return {
          id: t.id,
          name: t.name || t.id,
          level: Number.isInteger(n) && n > 0 ? n : null,
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
  }

  function hasAnyTraderLevel(profile) {
    const levels = (profile && profile.traderLevels) || {};
    return Object.keys(levels).some((k) => Number(levels[k]) > 0);
  }

  // Sixteen "Prapor LL4" tags is four lines of chrome that pushes the actual
  // kits below the fold, and fifteen of them say nothing the player needs to
  // act on. Only the GAPS are actionable, so only the gaps are listed.
  const MAX_UNSET_SHOWN = 6;

  function profileSummary(profile, traders) {
    const rows = traderLevelRows(profile, traders);
    const unset = rows.filter((r) => r.level == null);
    const total = rows.length;
    const set = total - unset.length;
    let text;
    if (!total) text = 'Priced against your finished quests.';
    else if (!unset.length) {
      text = 'Priced against all ' + total + ' loyalty levels and your finished quests.';
    } else if (!set) {
      text = 'No loyalty levels are set, so no trader stock can be priced.';
    } else {
      text = 'Priced against ' + set + ' of ' + total
        + ' loyalty levels and your finished quests. Not set:';
    }
    const shown = unset.slice(0, MAX_UNSET_SHOWN).map((r) => r.name);
    const more = Math.max(0, unset.length - shown.length);
    return { text, total, set, unset: unset.map((r) => r.name), shown, more };
  }

  // Three identical cards that all say "nothing could be priced" is worse than
  // one sentence explaining why. This is what decides between them.
  function allKitsEmpty(res) {
    const kits = (res && res.kits) || [];
    if (!kits.length) return true;
    return kits.every((k) => !k.lines || !k.lines.length);
  }

  // The engine's own account of why no weapon could be priced. Returned as a
  // sentence, or null when it did not say - the caller then falls back to the
  // generic line rather than inventing a cause.
  function weaponReason(res) {
    const kits = (res && res.kits) || [];
    for (let i = 0; i < kits.length; i++) {
      const notes = (kits[i] && kits[i].notes) || [];
      for (let j = 0; j < notes.length; j++) {
        if (typeof notes[j] === 'string' && notes[j].indexOf('no weapon is priced') === 0) {
          // 'no weapon is priced - <cause>' reads better here as just the cause
          const dash = notes[j].indexOf(' - ');
          const cause = dash > 0 ? notes[j].slice(dash + 3) : notes[j];
          return cause.charAt(0).toUpperCase() + cause.slice(1)
            + (/[.!?]$/.test(cause) ? '' : '.');
        }
      }
    }
    return null;
  }

  // Both switched off means there is no money in the world, and three empty
  // cards with no explanation is the worst thing this view can do.
  function emptyReason(profile, fleaAllowed) {
    if (hasAnyTraderLevel(profile)) return null;
    if (fleaAllowed && fleaDefault(profile && profile.playerLevel)) return null;
    return 'noSources';
  }

  // ==========================================================================
  // Everything below touches the DOM and only ever runs inside render().
  // ==========================================================================
  function render(mount, ctx, param) {
    const el = ctx.el;
    const clear = ctx.clear;

    const state = {
      budget: DEFAULT_BUDGET,
      targetClass: DEFAULT_CLASS,
      mobility: MOBILITY.default,
      flea: fleaDefault(ctx.profile && ctx.profile.playerLevel),
      sidePlates: false,
      result: null,
      error: null,
      // A deep link like '#/kit/300000' is how another view could hand this one
      // a budget. Never trusted beyond being a number.
      touched: false,
    };
    const deep = clampBudget(param);
    if (param && String(param).replace(/[^0-9]/g, '') !== '') state.budget = deep;

    const wrap = el('div', 'kit-wrap');
    const controls = el('div', 'kit-controls');
    const results = el('div', 'kit-results');
    wrap.appendChild(controls);
    wrap.appendChild(results);
    mount.appendChild(wrap);

    function traderName(id) {
      const t = ctx.traderById && ctx.traderById[id];
      return (t && t.name) || 'Unknown trader';
    }

    // ---- controls ----
    let budgetInput = null;
    let fleaBox = null;
    let fleaHint = null;
    let sideBox = null;
    let mobOut = null;
    let generateBtn = null;
    let profileLine = null;

    function row(label) {
      const r = el('div', 'kit-row');
      if (label != null) r.appendChild(el('span', 'kit-row-label', label));
      return r;
    }

    function paintControls() {
      clear(controls);

      // budget
      const rBudget = row('Budget');
      budgetInput = document.createElement('input');
      budgetInput.type = 'number';
      budgetInput.className = 'kit-budget';
      budgetInput.min = String(MIN_BUDGET);
      budgetInput.max = String(MAX_BUDGET);
      budgetInput.step = '5000';
      budgetInput.value = String(state.budget);
      budgetInput.addEventListener('change', () => {
        state.budget = clampBudget(budgetInput.value);
        budgetInput.value = String(state.budget);
        paintChips();
      });
      rBudget.appendChild(budgetInput);
      rBudget.appendChild(el('span', 'muted', 'roubles'));
      const chips = el('div', 'kit-chips');
      rBudget.appendChild(chips);
      controls.appendChild(rBudget);

      function paintChips() {
        clear(chips);
        BUDGET_CHIPS.forEach((n) => {
          const c = el('button', 'chip kit-chip' + (state.budget === n ? ' on' : ''),
            ctx.formatRub(n));
          c.type = 'button';
          c.addEventListener('click', () => {
            state.budget = n;
            if (budgetInput) budgetInput.value = String(n);
            paintChips();
          });
          chips.appendChild(c);
        });
      }
      paintChips();

      // target class + mobility
      const rFight = row('Expect armour');
      const clsSel = document.createElement('select');
      CLASS_CHOICES.forEach((n) => {
        const o = document.createElement('option');
        o.value = String(n);
        o.textContent = 'class ' + n;
        clsSel.appendChild(o);
      });
      clsSel.value = String(state.targetClass);
      clsSel.addEventListener('change', () => { state.targetClass = clampClass(clsSel.value); });
      rFight.appendChild(clsSel);
      rFight.appendChild(el('span', 'muted', 'sets the minimum penetration your ammo must have'));
      controls.appendChild(rFight);

      const rMob = row('Mobility');
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'kit-slider';
      slider.min = String(MOBILITY.min);
      slider.max = String(MOBILITY.max);
      slider.step = String(MOBILITY.step);
      slider.value = String(state.mobility);
      mobOut = el('span', 'muted kit-mob-out', mobilityLabel(state.mobility));
      slider.addEventListener('input', () => {
        state.mobility = clampMobility(slider.value);
        mobOut.textContent = mobilityLabel(state.mobility);
      });
      rMob.appendChild(slider);
      rMob.appendChild(mobOut);
      controls.appendChild(rMob);

      // flea + side plates
      const rOpts = row('Sources');
      const fleaLabel = el('label', 'kit-check');
      fleaBox = document.createElement('input');
      fleaBox.type = 'checkbox';
      fleaBox.checked = !!state.flea;
      fleaBox.addEventListener('change', () => { state.flea = !!fleaBox.checked; paintFleaHint(); });
      fleaLabel.appendChild(fleaBox);
      fleaLabel.appendChild(el('span', null, 'Use the flea market'));
      rOpts.appendChild(fleaLabel);
      fleaHint = el('span', 'muted');
      rOpts.appendChild(fleaHint);

      const sideLabel = el('label', 'kit-check');
      sideBox = document.createElement('input');
      sideBox.type = 'checkbox';
      sideBox.checked = !!state.sidePlates;
      sideBox.addEventListener('change', () => { state.sidePlates = !!sideBox.checked; });
      sideLabel.appendChild(sideBox);
      sideLabel.appendChild(el('span', null, 'Buy side plates'));
      rOpts.appendChild(sideLabel);
      controls.appendChild(rOpts);
      paintFleaHint();

      // profile line
      profileLine = el('div', 'kit-profile');
      controls.appendChild(profileLine);
      paintProfile();

      const rGo = row(null);
      generateBtn = el('button', 'kit-generate', 'Generate kits');
      generateBtn.type = 'button';
      generateBtn.addEventListener('click', generate);
      rGo.appendChild(generateBtn);
      controls.appendChild(rGo);
    }

    function paintFleaHint() {
      if (!fleaHint) return;
      const lvl = ctx.profile && ctx.profile.playerLevel;
      if (!state.flea) { fleaHint.textContent = ''; return; }
      if (lvl == null || lvl === '') {
        fleaHint.textContent = 'set your player level on Traders - the flea is ignored until then';
      } else if (Number(lvl) < FLEA_MIN_LEVEL) {
        fleaHint.textContent = 'the flea opens at level ' + FLEA_MIN_LEVEL
          + ' - you are level ' + Number(lvl);
      } else {
        fleaHint.textContent = '';
      }
    }

    function paintProfile() {
      if (!profileLine) return;
      clear(profileLine);
      const sum = profileSummary(ctx.profile, ctx.traders);
      profileLine.appendChild(el('span', 'muted', sum.text));
      if (sum.shown.length) {
        const box = el('span', 'kit-lls');
        sum.shown.forEach((name) => box.appendChild(el('span', 'tag kit-ll kit-ll-unset', name)));
        if (sum.more) box.appendChild(el('span', 'muted', '+' + sum.more + ' more'));
        profileLine.appendChild(box);
      }
      const link = el('button', 'kit-link', 'Set them on Traders');
      link.type = 'button';
      link.addEventListener('click', () => ctx.go('traders', ''));
      profileLine.appendChild(link);
    }

    // ---- generating ----
    function generate() {
      state.touched = true;
      state.error = null;
      if (!Kit || typeof Kit.assembleKits !== 'function') {
        state.error = 'kit.js did not load, so nothing can be priced.';
        state.result = null;
        paintResults();
        return;
      }
      if (generateBtn) { generateBtn.disabled = true; generateBtn.textContent = 'Working...'; }
      try {
        state.result = Kit.assembleKits({
          items: ctx.items || {},
          props: ctx.itemProps || {},
          barters: ctx.barters || [],
          questState: ctx.questState || {},
          profile: ctx.profile || {},
          budget: state.budget,
          targetClass: state.targetClass,
          mobilityWeight: state.mobility,
          fleaAllowed: state.flea,
          prefs: { sidePlates: state.sidePlates },
        });
      } catch (e) {
        state.result = null;
        state.error = 'The optimizer failed: ' + (e && e.message ? e.message : String(e));
      }
      if (generateBtn) { generateBtn.disabled = false; generateBtn.textContent = 'Generate kits'; }
      paintResults();
    }

    // ---- results ----
    function paintResults() {
      clear(results);

      if (state.error) {
        results.appendChild(el('div', 'detail-empty bad', state.error));
        return;
      }

      if (!state.result) {
        const why = emptyReason(ctx.profile, state.flea);
        const box = el('div', 'detail-empty');
        if (why === 'noSources') {
          box.appendChild(el('p', null,
            'Nothing can be priced yet: no trader loyalty levels are set, and the flea market'
            + ' is off or locked.'));
          box.appendChild(el('p', 'muted',
            'Set at least one loyalty level on Traders, or turn the flea on if you are level '
            + FLEA_MIN_LEVEL + ' or above. Ammunition is never sold on the flea, so a weapon'
            + ' always needs a trader.'));
          const go = el('button', null, 'Open Traders');
          go.type = 'button';
          go.addEventListener('click', () => ctx.go('traders', ''));
          box.appendChild(go);
        } else {
          box.appendChild(el('p', null, 'Pick a budget and press Generate kits.'));
        }
        results.appendChild(box);
        return;
      }

      const res = state.result;

      // Three cards that all read "nothing could be priced" is six repetitions
      // of one fact. Say it once, with the reason and the way out.
      if (allKitsEmpty(res)) {
        const box = el('div', 'detail-empty');
        box.appendChild(el('p', null, 'Nothing could be priced with what the app knows about you.'));
        const bits = [];
        if (res.unknownTraders && res.unknownTraders.length) {
          bits.push('Stock from ' + res.unknownTraders.length + ' trader'
            + (res.unknownTraders.length === 1 ? ' was' : 's was')
            + ' skipped because their loyalty level is not set.');
        }
        if (res.fleaBlocked === 'off') bits.push('The flea market is switched off.');
        if (res.fleaBlocked === 'level') {
          bits.push('The flea market opens at level ' + FLEA_MIN_LEVEL + '.');
        }
        if (res.fleaBlocked === 'unknownLevel') {
          bits.push('Your player level is not set, so the flea was left out.');
        }
        // kit.js works out WHICH of the several possible causes emptied the
        // weapon slot - no loyalty levels, no ammunition on sale, nothing that
        // clears the penetration floor, or no gun to fire it. Say the one it
        // found. Asserting "ammunition always needs a trader" here regardless
        // sent a player whose levels were all set to the wrong screen.
        const why = weaponReason(res);
        if (why) bits.push(why);
        else bits.push('Ammunition is never sold on the flea, so a weapon always needs a trader.');
        box.appendChild(el('p', 'muted', bits.join(' ')));
        const go = el('button', null, 'Open Traders');
        go.type = 'button';
        go.addEventListener('click', () => ctx.go('traders', ''));
        box.appendChild(go);
        results.appendChild(box);
        return;
      }

      if (res.unknownTraders && res.unknownTraders.length) {
        const warn = el('div', 'kit-warn');
        warn.appendChild(el('span', null, 'Stock from ' + res.unknownTraders.length
          + ' trader' + (res.unknownTraders.length === 1 ? '' : 's')
          + ' was skipped: their loyalty level is not set.'));
        const go = el('button', 'kit-link', 'Set them');
        go.type = 'button';
        go.addEventListener('click', () => ctx.go('traders', ''));
        warn.appendChild(go);
        results.appendChild(warn);
      }

      const grid = el('div', 'kit-grid');
      (res.kits || []).forEach((kit) => grid.appendChild(kitCard(kit)));
      results.appendChild(grid);
    }

    function kitCard(kit) {
      const card = el('div', 'kit-card' + (isOverBudget(kit) ? ' over' : ''));

      const head = el('div', 'kit-card-head');
      head.appendChild(el('div', 'kit-label', kit.label));
      head.appendChild(el('div', 'muted kit-cap', budgetLabel(kit, ctx.formatRub)));
      card.appendChild(head);

      const totalRow = el('div', 'kit-total-row');
      totalRow.appendChild(el('span', 'kit-total' + (isOverBudget(kit) ? ' bad' : ''),
        ctx.formatRub(kit.total)));
      totalRow.appendChild(el('span', 'muted kit-config',
        kit.config === 'armored-rig' ? 'armoured rig, no body armour' : 'armour + rig'));
      card.appendChild(totalRow);

      const bar = el('div', 'kit-bar');
      const fill = el('div', 'kit-bar-fill');
      fill.style.width = scoreBarPct(kit.score) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el('div', 'muted kit-score', scoreBarPct(kit.score)
        + '% of a perfect kit at this target'));

      if (!kit.lines || !kit.lines.length) {
        card.appendChild(el('p', 'muted', 'Nothing in this kit could be priced.'));
      }
      (kit.lines || []).forEach((line) => card.appendChild(kitLine(line)));

      if (kit.notes && kit.notes.length) {
        const notes = el('div', 'kit-notes');
        kit.notes.forEach((n) => notes.appendChild(el('div', 'kit-note', n)));
        card.appendChild(notes);
      }
      return card;
    }

    function kitLine(line) {
      const box = el('div', 'kit-line');

      const top = el('div', 'kit-line-top');
      const img = document.createElement('img');
      img.className = 'mini-icon';
      img.loading = 'lazy';
      img.alt = '';
      const src = ctx.imgUrl('item', line.item);
      if (src) img.src = src;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      top.appendChild(img);

      const mid = el('div', 'kit-line-mid');
      mid.appendChild(el('div', 'muted kit-slot', slotLabel(line.slot)));
      const name = el('span', 'offer-name', line.name || line.item);
      name.title = 'Open in Items';
      name.addEventListener('click', () => ctx.go('items', line.item));
      mid.appendChild(name);
      top.appendChild(mid);

      const right = el('div', 'kit-line-right');
      right.appendChild(el('div', 'kit-cost', ctx.formatRub(line.cost)));
      const chip = sourceChip(line.offer, traderName(line.offer && line.offer.trader));
      right.appendChild(el('div', 'tag ' + chip.cls, chip.text));
      top.appendChild(right);
      box.appendChild(top);

      const facts = [];
      if (line.effClass) facts.push('class ' + line.effClass);
      if (line.capacity) facts.push(line.capacity + ' slots');
      if (line.meetsTarget === false) facts.push('under your armour target');
      if (facts.length) box.appendChild(el('div', 'muted kit-facts', facts.join(' - ')));

      (line.extras || []).forEach((e) => {
        const ex = el('div', 'kit-extra');
        const eimg = document.createElement('img');
        eimg.className = 'mini-icon tiny';
        eimg.loading = 'lazy';
        eimg.alt = '';
        const esrc = ctx.imgUrl('item', e.item);
        if (esrc) eimg.src = esrc;
        eimg.addEventListener('error', () => { eimg.style.visibility = 'hidden'; });
        ex.appendChild(eimg);
        const label = el('span', 'kit-extra-name', extraLabel(e));
        label.title = 'Open in Items';
        label.addEventListener('click', () => ctx.go('items', e.item));
        ex.appendChild(label);
        ex.appendChild(el('span', 'muted kit-extra-cost', 'in price: ' + ctx.formatRub(e.cost)));
        box.appendChild(ex);
      });

      if (line.why && line.why.length) {
        box.appendChild(el('div', 'muted kit-why', line.why.join(' - ')));
      }
      return box;
    }

    // ---- first paint ----
    paintControls();
    // Auto-run when the profile already says enough to price something. Making
    // someone press a button to see a view they just opened is a wasted click
    // when the answer needs no input from them.
    if (hasAnyTraderLevel(ctx.profile)) generate();
    else paintResults();

    return {
      focus: (p) => {
        if (!p) return;
        const n = clampBudget(p);
        if (String(p).replace(/[^0-9]/g, '') === '') return;
        state.budget = n;
        if (budgetInput) budgetInput.value = String(n);
        generate();
      },
      // The shell calls this when quest state or the profile changes - both of
      // which change what can be bought, so a kit on screen priced against the
      // old profile is now a lie.
      refresh: () => {
        paintProfile();
        paintFleaHint();
        if (state.result || state.touched) generate();
        else paintResults();
      },
    };
  }

  return {
    BUDGET_CHIPS,
    DEFAULT_BUDGET,
    MIN_BUDGET,
    MAX_BUDGET,
    CLASS_CHOICES,
    DEFAULT_CLASS,
    MOBILITY,
    FLEA_MIN_LEVEL,
    SLOT_LABEL,
    clampBudget,
    clampClass,
    clampMobility,
    fleaDefault,
    mobilityLabel,
    sourceChip,
    scoreBarPct,
    isOverBudget,
    budgetLabel,
    extraLabel,
    slotLabel,
    traderLevelRows,
    hasAnyTraderLevel,
    MAX_UNSET_SHOWN,
    profileSummary,
    allKitsEmpty,
    emptyReason,
    weaponReason,
    render,
  };
}));
