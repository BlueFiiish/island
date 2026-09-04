// Pilot Hub - the trader browser.
//
// Loaded two ways, exactly like the other hub views: as a plain <script> in the
// hub window and via require() from test/hub.test.mjs. EVERY DOM touch lives
// behind render().
//
// What this view is FOR: "what can I actually buy from this trader right now",
// which is a different question from "what does this trader sell". The
// difference is the loyalty gate and the task lock, and both of them are easy
// to render wrongly in a way that still looks plausible - an offer shown at LL1
// that really needs LL4 is a wasted trip to the trader screen. So the gating
// arithmetic is pure and tested, and the DOM layer only draws what it returns.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubTraders = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const Kit = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('../kit.js')
    : (typeof globalThis !== 'undefined' ? globalThis.PilotKit : null);

  const MAX_LOYALTY = 4;

  // ==========================================================================
  // PURE: what a trader sells for cash
  // ==========================================================================
  // items.json denormalises every trader offer onto the ITEM (item.buy[] =
  // "who sells me this"), so a trader's stock list is a sweep of all 5,312
  // items rather than a lookup. That is ~5k iterations per level change, which
  // is nothing next to building the DOM for it.
  //
  // `maxLevel` is the loyalty level the player says they have: an offer at
  // lvl 3 is invisible at LL2, which is the whole point. maxLevel null/0 means
  // "no gate" - show everything, labelled with the level each offer needs.
  //
  // The TASK lock is a separate axis and is deliberately not applied here: this
  // function answers "what is at or under my loyalty level", and the caller
  // decides whether to hide the task-locked rows or merely label them.
  function traderCashOffers(items, traderId, maxLevel) {
    const map = (items && typeof items === 'object') ? items : {};
    const cap = Number(maxLevel);
    const gated = Number.isFinite(cap) && cap > 0;
    const out = [];
    const ids = Object.keys(map);
    for (let i = 0; i < ids.length; i++) {
      const it = map[ids[i]];
      const buys = (it && Array.isArray(it.buy)) ? it.buy : [];
      for (let j = 0; j < buys.length; j++) {
        const b = buys[j];
        if (!b || b.t !== traderId) continue;
        const lvl = Number(b.lvl) || 1;
        if (gated && lvl > cap) continue;
        out.push({ id: ids[i], item: it, offer: b, level: lvl, task: b.task || null });
      }
    }
    return out;
  }

  // The handbook chain on an item runs leaf -> root, so the LAST entry is the
  // top-level bucket ("Weapon parts & mods", "Medication"), which is the right
  // grain for a section header. Anything with no chain lands in 'Other' rather
  // than being dropped.
  function offerCategory(item, categories) {
    const hb = (item && Array.isArray(item.hb)) ? item.hb : [];
    const cats = (categories && categories.handbookCategories) || {};
    for (let i = hb.length - 1; i >= 0; i--) {
      const c = cats[hb[i]];
      if (c && c.name) return c.name;
    }
    const ic = (categories && categories.itemCategories) || {};
    const own = item && ic[item.cat];
    return (own && own.name) || 'Other';
  }

  // Grouped by category, categories alphabetical, items alphabetical inside.
  // Deterministic on purpose: the list must not reshuffle when a loyalty level
  // changes, or comparing LL3 with LL4 is impossible by eye.
  function groupOffers(offers, categories) {
    const byName = {};
    (Array.isArray(offers) ? offers : []).forEach((o) => {
      if (!o) return;
      const name = offerCategory(o.item, categories);
      (byName[name] = byName[name] || []).push(o);
    });
    return Object.keys(byName).sort().map((name) => ({
      name,
      offers: byName[name].sort((a, b) => {
        const an = String((a.item && a.item.n) || '');
        const bn = String((b.item && b.item.n) || '');
        if (an !== bn) return an < bn ? -1 : 1;
        return a.level - b.level;
      }),
    }));
  }

  // ==========================================================================
  // PURE: task locks
  // ==========================================================================
  // An offer or barter can carry a task id: it does not exist for you until
  // that task is FINISHED. This answers, for one such id, which of the three
  // states it is in - and it is the piece the view was missing, which is why a
  // barter stayed labelled "needs <quest>" forever, including for a player who
  // had finished that quest three wipes ago.
  //
  // Returns null (no task gate), 'done' (finished - the gate is open) or
  // 'pending' (unstarted, started or failed - it is not).
  function taskLockState(taskId, questState) {
    if (!taskId) return null;
    const state = (questState && typeof questState === 'object') ? questState : {};
    const rec = state[taskId];
    const status = (rec && typeof rec === 'object') ? rec.status : rec;
    return String(status || '') === 'finished' ? 'done' : 'pending';
  }

  // Is this row usable RIGHT NOW at the level being shown? The loyalty gate is
  // already applied by the two functions above, so what is left is the task.
  function offerIsUsable(taskId, questState) {
    return taskLockState(taskId, questState) !== 'pending';
  }

  // ==========================================================================
  // PURE: barters
  // ==========================================================================
  // Same loyalty gate. Task locks are NOT applied here - they are LABELLED by
  // the view (and optionally hidden by its "Hide locked" checkbox), because
  // "you cannot buy this yet, and here is the quest that opens it" is more
  // useful to a player than a silently shorter list.
  function traderBarters(barters, traderId, maxLevel) {
    const list = Array.isArray(barters) ? barters : [];
    const cap = Number(maxLevel);
    const gated = Number.isFinite(cap) && cap > 0;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || b.trader !== traderId) continue;
      const lvl = Number(b.minTraderLevel) || 1;
      if (gated && lvl > cap) continue;
      out.push(b);
    }
    return out.sort((a, b) => (Number(a.minTraderLevel) || 1) - (Number(b.minTraderLevel) || 1));
  }

  // Barters bucketed by the loyalty level that unlocks them, ascending. This is
  // the shape the view draws ("LL1 / LL2 / ..."), and it is what makes the
  // difference between two loyalty levels legible.
  function bartersByLevel(barters) {
    const byLevel = {};
    (Array.isArray(barters) ? barters : []).forEach((b) => {
      const lvl = Number(b && b.minTraderLevel) || 1;
      (byLevel[lvl] = byLevel[lvl] || []).push(b);
    });
    return Object.keys(byLevel)
      .map(Number)
      .sort((a, b) => a - b)
      .map((level) => ({ level, barters: byLevel[level] }));
  }

  // ==========================================================================
  // PURE: loyalty
  // ==========================================================================
  // Exactly the loyalty levels this trader actually has, ascending. A
  // hard-coded 1..4 picker would offer Lightkeeper LL4, which does not exist.
  //
  // TWO real shapes in the live data, and neither is 1..4:
  //   * the service NPCs (Lightkeeper, the BTR driver, Ref's friends) have a
  //     single level
  //   * FENCE is numbered 0, 1, 2 - his "loyalty" is a reputation scale that
  //     starts at zero. LL0 is dropped here on purpose: the config contract
  //     stores 1..4, and Fence LL1 already shows every LL0 offer (the gate is
  //     `offer.lvl <= selected`), so nothing is hidden by not offering it.
  function loyaltyChoices(trader) {
    const levels = (trader && Array.isArray(trader.levels)) ? trader.levels : [];
    const seen = {};
    const out = [];
    levels.map((l) => Number(l && l.level))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_LOYALTY)
      .sort((a, b) => a - b)
      .forEach((n) => { if (!seen[n]) { seen[n] = true; out.push(n); } });
    return out.length ? out : [1];
  }

  // What level to show a trader at: what the player said, else LL1. Never an
  // estimate - the estimate is offered behind a button, so a guess can never
  // silently become the thing the inventory is filtered by.
  function selectedLevel(profile, traderId, trader) {
    const levels = (profile && profile.traderLevels) || {};
    const n = Number(levels[traderId]);
    const choices = loyaltyChoices(trader);
    // membership, not a range: the picker's <option> list is built from the
    // same array, so a stored value outside it would set a select to a value
    // that has no option and the control would read as blank
    if (Number.isInteger(n) && choices.indexOf(n) >= 0) return n;
    return choices[0];
  }

  // The LL requirement table rows, straight off the trader record.
  function levelRows(trader) {
    const levels = (trader && Array.isArray(trader.levels)) ? trader.levels : [];
    return levels.slice()
      .sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0))
      .map((l) => ({
        level: Number(l.level) || 0,
        playerLevel: Number(l.requiredPlayerLevel) || 0,
        reputation: Number(l.requiredReputation) || 0,
        commerce: Number(l.requiredCommerce) || 0,
      }));
  }

  // ==========================================================================
  // Everything below touches the DOM and only ever runs inside render().
  // ==========================================================================
  function render(mount, ctx, param) {
    const el = ctx.el;
    const clear = ctx.clear;
    const items = ctx.items || {};
    const traders = (ctx.traders || []).slice()
      .sort((a, b) => (String(a.name || '') < String(b.name || '') ? -1 : 1));

    const state = { selected: param || null, hideLocked: false };

    const wrap = el('div', 'split-wrap traders-wrap');
    const left = el('div', 'split-left');
    const right = el('div', 'split-right');
    wrap.appendChild(left);
    wrap.appendChild(right);
    mount.appendChild(wrap);

    function itemName(id) {
      const it = items[id];
      return (it && it.n) || id;
    }

    function traderById(id) {
      return (ctx.traderById && ctx.traderById[id]) || null;
    }

    function taskName(id) {
      const t = ctx.questById && ctx.questById[id];
      return (t && t.name) || null;
    }

    function miniItem(id, count) {
      const d = el('div', 'mini-item');
      const img = document.createElement('img');
      img.className = 'mini-icon';
      img.loading = 'lazy';
      img.alt = '';
      const src = ctx.imgUrl('item', id);
      if (src) img.src = src;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      d.appendChild(img);
      d.appendChild(el('span', 'mini-name', itemName(id)));
      if (count && Number(count) > 1) d.appendChild(el('span', 'mini-count', 'x' + count));
      d.title = 'Open in Items';
      d.addEventListener('click', () => ctx.go('items', id));
      return d;
    }

    // ---- the card grid ----
    function paintCards() {
      clear(left);
      const grid = el('div', 'trader-cards');
      traders.forEach((t) => {
        const card = el('div', 'trader-card' + (state.selected === t.id ? ' selected' : ''));
        const img = document.createElement('img');
        img.className = 'trader-portrait big';
        img.alt = '';
        const src = ctx.imgUrl('trader', t.id);
        if (src) img.src = src;
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        card.appendChild(img);

        const body = el('div', 'trader-card-body');
        body.appendChild(el('div', 'trader-name', t.name || t.id));
        const meta = el('div', 'muted');
        const bits = [];
        if (t.currency) bits.push(t.currency);
        const choices = loyaltyChoices(t);
        bits.push(choices.length > 1 ? ('LL1-' + choices[choices.length - 1]) : 'no loyalty levels');
        meta.textContent = bits.join(' - ');
        body.appendChild(meta);
        if (t.resetTime) {
          const reset = el('div', 'muted', 'restock ' + resetLabel(t.resetTime));
          body.appendChild(reset);
        }

        // The loyalty picker lives on the CARD as well as in the detail pane:
        // setting four traders' levels is the first thing anyone does here, and
        // making that a four-click round trip through the detail pane would be
        // the wrong shape.
        const pick = el('div', 'll-pick');
        pick.appendChild(el('span', 'muted', 'my LL'));
        const sel = document.createElement('select');
        choices.forEach((n) => {
          const o = document.createElement('option');
          o.value = String(n);
          o.textContent = String(n);
          sel.appendChild(o);
        });
        sel.value = String(selectedLevel(ctx.profile, t.id, t));
        sel.addEventListener('click', (e) => e.stopPropagation());
        sel.addEventListener('change', (e) => {
          e.stopPropagation();
          setLevel(t.id, Number(sel.value));
        });
        pick.appendChild(sel);
        body.appendChild(pick);
        card.appendChild(body);

        card.addEventListener('click', () => select(t.id));
        grid.appendChild(card);
      });
      left.appendChild(grid);
    }

    // ISO timestamp -> something a person can read without doing timezone maths
    // in their head. Never renders a raw ISO string at the user.
    function resetLabel(iso) {
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return String(iso);
      const mins = Math.round((t - Date.now()) / 60000);
      if (mins <= 0) return 'due now';
      if (mins < 60) return 'in ' + mins + 'm';
      return 'in ' + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
    }

    // The level is written through main (which re-validates it) and comes back
    // on the 'profile' push; the local copy is updated too so the picker does
    // not visibly snap back while the round trip happens.
    function setLevel(traderId, level) {
      const next = {};
      Object.keys(ctx.profile.traderLevels || {}).forEach((k) => { next[k] = ctx.profile.traderLevels[k]; });
      next[traderId] = level;
      ctx.profile.traderLevels = next;
      ctx.saveProfile({ traderLevels: next });
      paintCards();
      if (state.selected) renderDetail(state.selected);
    }

    function select(id) {
      state.selected = id;
      paintCards();
      renderDetail(id);
    }

    // ---- detail ----
    function renderDetail(id) {
      const t = traderById(id);
      clear(right);
      if (!t) {
        right.appendChild(el('div', 'detail-empty', 'Pick a trader.'));
        return;
      }
      const level = selectedLevel(ctx.profile, t.id, t);

      const head = el('div', 'detail-head');
      const img = document.createElement('img');
      img.className = 'detail-img';
      img.alt = '';
      const src = ctx.imgUrl('trader', t.id);
      if (src) img.src = src;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      head.appendChild(img);

      const headText = el('div', 'detail-headtext');
      headText.appendChild(el('h2', null, t.name || t.id));
      if (t.description) headText.appendChild(el('div', 'detail-short', t.description));
      const facts = el('div', 'detail-facts');
      if (t.currency) facts.appendChild(el('span', null, 'deals in ' + t.currency));
      if (t.resetTime) facts.appendChild(el('span', null, 'restock ' + resetLabel(t.resetTime)));
      facts.appendChild(el('span', null, 'showing LL' + level));
      headText.appendChild(facts);
      head.appendChild(headText);
      right.appendChild(head);

      // ---- loyalty requirements + the estimate ----
      const rows = levelRows(t);
      if (rows.length) {
        const s = ctx.section('Loyalty levels');
        // its OWN class, not trade-table: that one paints its second column in
        // the money colour, and "player level 36" is not money
        const table = el('table', 'll-table');
        const thead = document.createElement('thead');
        const hdr = document.createElement('tr');
        ['Level', 'Player lvl', 'Reputation', 'Commerce'].forEach((h) => hdr.appendChild(el('th', null, h)));
        thead.appendChild(hdr);
        table.appendChild(thead);
        const body = document.createElement('tbody');
        rows.forEach((r) => {
          const tr = document.createElement('tr');
          if (r.level === level) tr.className = 'here';
          tr.appendChild(el('td', null, 'LL' + r.level));
          tr.appendChild(el('td', null, r.playerLevel ? String(r.playerLevel) : '-'));
          tr.appendChild(el('td', null, r.reputation ? String(r.reputation) : '-'));
          tr.appendChild(el('td', null, r.commerce ? ctx.formatRub(r.commerce) : '-'));
          body.appendChild(tr);
        });
        table.appendChild(body);
        s.appendChild(table);

        const suggest = el('button', 'wiki-btn', 'Suggest from my quests');
        suggest.type = 'button';
        const verdict = el('div', 'muted suggest-verdict', '');
        suggest.addEventListener('click', () => {
          const est = Kit ? Kit.estimateTraderLevels({
            quests: ctx.quests,
            questState: ctx.questState,
            traders: ctx.traders,
            playerLevel: ctx.profile.playerLevel,
          }) : null;
          const mine = est && est[t.id];
          clear(verdict);
          if (!mine) {
            verdict.textContent = 'No quest data to estimate from yet.';
            return;
          }
          // The estimate is OFFERED, never applied silently: it is a floor from
          // quest standing alone, and a wrong loyalty level here would hide
          // real offers.
          const parts = ['Estimate: LL' + mine.level + ' (' + mine.rep + ' rep from finished tasks)'];
          if (mine.uncertain) {
            parts.push(mine.reason === 'commerce'
              ? 'capped here - a higher level needs money spent, which no log records'
              : 'your player level is unknown, so the level gate was not applied');
          }
          // The reputation this is built from comes from the quest log, and the
          // log only goes back to the day Pilot was installed. Everything the
          // player finished before that is invisible, so the number can only
          // ever be a FLOOR - saying so is the difference between a useful hint
          // and a wrong answer worn with confidence.
          parts.push('this is a floor - quests finished before Pilot was installed are not counted');
          verdict.appendChild(el('span', null, parts.join(' - ')));
          // A DOWNGRADE is never offered as a button. The estimate cannot see
          // your history, so "you look like LL1" against a stored LL3 means the
          // log is short, not that the player was wrong - and one careless click
          // would hide two loyalty levels of real offers.
          if (mine.level > level) {
            const apply = el('button', 'wiki-btn', 'Set LL' + mine.level);
            apply.type = 'button';
            apply.addEventListener('click', () => setLevel(t.id, mine.level));
            verdict.appendChild(document.createTextNode(' '));
            verdict.appendChild(apply);
          } else if (mine.level < level) {
            verdict.appendChild(el('div', 'muted',
              'Lower than the LL' + level + ' you have set, which is expected'
              + ' if you played before installing Pilot. Left as you set it.'));
          }
        });
        s.appendChild(suggest);
        s.appendChild(verdict);
        right.appendChild(s);
      }

      // ---- the task-lock control ----
      // Honest name, honest scope: this HIDES the rows whose task is not
      // finished. Without it the rows are all still listed and merely labelled,
      // which is the right default (a quest you have not done yet is a thing to
      // go and do) but is not the same as "what can I buy right now".
      const lockBox = el('div', 'lock-toggle');
      const lockChk = document.createElement('input');
      lockChk.type = 'checkbox';
      lockChk.id = 'hide-locked';
      lockChk.checked = state.hideLocked;
      lockChk.addEventListener('change', () => {
        state.hideLocked = !!lockChk.checked;
        renderDetail(state.selected);
      });
      const lockLbl = document.createElement('label');
      lockLbl.htmlFor = 'hide-locked';
      lockLbl.className = 'muted';
      lockLbl.textContent = 'Hide offers behind an unfinished task';
      lockBox.appendChild(lockChk);
      lockBox.appendChild(lockLbl);
      right.appendChild(lockBox);

      // ---- cash offers ----
      const allOffers = traderCashOffers(items, t.id, level);
      const offers = state.hideLocked
        ? allOffers.filter((o) => offerIsUsable(o.task, ctx.questState))
        : allOffers;
      const hiddenOffers = allOffers.length - offers.length;
      const groups = groupOffers(offers, ctx.categories);
      const cash = ctx.section('Sells for cash at LL' + level + ' (' + offers.length
        + (hiddenOffers ? ', ' + hiddenOffers + ' hidden' : '') + ')');
      if (!offers.length) {
        cash.appendChild(el('p', 'muted', 'Nothing in the synced data at this loyalty level.'));
      }
      groups.forEach((g) => {
        const box = el('div', 'offer-group');
        box.appendChild(el('div', 'offer-group-head', g.name + ' (' + g.offers.length + ')'));
        const table = el('table', 'trade-table');
        const body = document.createElement('tbody');
        g.offers.forEach((o) => {
          const tr = document.createElement('tr');
          const nameCell = document.createElement('td');
          const icon = document.createElement('img');
          icon.className = 'mini-icon';
          icon.loading = 'lazy';
          icon.alt = '';
          const isrc = ctx.imgUrl('item', o.id);
          if (isrc) icon.src = isrc;
          icon.addEventListener('error', () => { icon.style.visibility = 'hidden'; });
          nameCell.appendChild(icon);
          const link = el('span', 'offer-name', (o.item && o.item.n) || o.id);
          link.addEventListener('click', () => ctx.go('items', o.id));
          nameCell.appendChild(link);
          nameCell.className = 'offer-name-cell';
          tr.appendChild(nameCell);

          const cur = String(o.offer.cur || 'RUB').toUpperCase();
          tr.appendChild(el('td', null, ctx.formatCurrency(o.offer.price, cur)
            + (cur === 'RUB' ? '' : ' (' + ctx.formatRub(o.offer.rub) + ')')));
          tr.appendChild(el('td', 'muted', 'LL' + o.level));
          const notes = [];
          // A task-locked offer is not an offer until the task is done, and the
          // task NAME is the actionable half of that - but ONLY while the task
          // is actually unfinished. The quest log tells us that, so a note that
          // ignored it ("needs Debut" to a player who finished Debut) was
          // telling the player something false about their own account.
          const lock = taskLockState(o.task, ctx.questState);
          if (lock === 'pending') notes.push('needs "' + (taskName(o.task) || 'a task') + '"');
          else if (lock === 'done') notes.push('unlocked - "' + (taskName(o.task) || 'a task') + '" done');
          if (Number(o.offer.limit) > 0) notes.push('limit ' + o.offer.limit);
          tr.appendChild(el('td', lock === 'done' ? 'muted note-done' : 'muted', notes.join(' - ')));
          body.appendChild(tr);
        });
        table.appendChild(body);
        box.appendChild(table);
        cash.appendChild(box);
      });
      right.appendChild(cash);

      // ---- barters ----
      const allBarters = traderBarters(ctx.barters, t.id, level);
      const barters = state.hideLocked
        ? allBarters.filter((b) => offerIsUsable(b && b.taskUnlock, ctx.questState))
        : allBarters;
      const hiddenBarters = allBarters.length - barters.length;
      const bs = ctx.section('Barters at LL' + level + ' (' + barters.length
        + (hiddenBarters ? ', ' + hiddenBarters + ' hidden' : '') + ')');
      if (!barters.length) {
        bs.appendChild(el('p', 'muted', 'No barters in the synced data at this loyalty level.'));
      }
      bartersByLevel(barters).forEach((bucket) => {
        const box = el('div', 'offer-group');
        box.appendChild(el('div', 'offer-group-head', 'LL' + bucket.level + ' (' + bucket.barters.length + ')'));
        bucket.barters.forEach((b) => {
          const line = el('div', 'barter-line');
          const outRow = el('div', 'barter-reqs');
          if (b.out && b.out.item) outRow.appendChild(miniItem(b.out.item, b.out.count));
          line.appendChild(outRow);
          const forRow = el('div', 'barter-reqs');
          forRow.appendChild(el('span', 'muted', 'for'));
          (Array.isArray(b.req) ? b.req : []).forEach((r) => {
            if (r && r.item) forRow.appendChild(miniItem(r.item, r.count));
          });
          line.appendChild(forRow);
          const notes = [];
          const block = taskLockState(b.taskUnlock, ctx.questState);
          if (block === 'pending') notes.push('needs "' + (taskName(b.taskUnlock) || 'a task') + '"');
          else if (block === 'done') notes.push('unlocked - "' + (taskName(b.taskUnlock) || 'a task') + '" done');
          if (Number(b.buyLimit) > 0) notes.push('limit ' + b.buyLimit);
          if (notes.length) {
            line.appendChild(el('div', block === 'done' ? 'muted note-done' : 'muted', notes.join(' - ')));
          }
          box.appendChild(line);
        });
        bs.appendChild(box);
      });
      right.appendChild(bs);
    }

    // ---- first paint ----
    paintCards();
    renderDetail(state.selected);

    return {
      focus: (id) => { if (id) select(id); },
      refresh: () => { paintCards(); if (state.selected) renderDetail(state.selected); },
    };
  }

  return {
    MAX_LOYALTY,
    traderCashOffers,
    offerCategory,
    groupOffers,
    taskLockState,
    offerIsUsable,
    traderBarters,
    bartersByLevel,
    loyaltyChoices,
    selectedLevel,
    levelRows,
    render,
  };
}));
