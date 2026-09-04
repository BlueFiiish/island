// Pilot Hub - the quest browser.
//
// Loaded two ways, exactly like hub.js / hub-items.js: as a plain <script> in
// the hub window and via require() from test/hub.test.mjs. EVERY DOM touch
// lives behind render(); everything above it is pure, because the parts that
// are easy to get quietly wrong here - what counts as done, what the kappa
// numerator is, which tasks a filter keeps - are all decidable without a
// document, and all of them are the kind of wrong that still LOOKS right in a
// screenshot.
//
// The badge is the whole point of this view, and it is computed by src/kit.js
// (questAvailability), not here: the overlay's quest arrows and this list must
// never disagree about whether a task is takeable.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubQuests = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // In node this is a require; in the hub window kit.js has already run its own
  // UMD tail and left PilotKit on the global. Neither path is allowed to be a
  // DOM touch, which is why kit.js is pure.
  const Kit = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('../kit.js')
    : (typeof globalThis !== 'undefined' ? globalThis.PilotKit : null);

  // ==========================================================================
  // PURE: status decoration
  // ==========================================================================
  const STATUS_ORDER = {
    active: 0, available: 1, locked: 2, failed: 3, done: 4,
  };
  const STATUS_LABEL = {
    done: 'done', active: 'active', available: 'available', locked: 'locked', failed: 'failed',
  };
  const STATUS_FILTERS = [
    { id: '', label: 'All statuses' },
    { id: 'active', label: 'Active' },
    { id: 'available', label: 'Available' },
    { id: 'locked', label: 'Locked' },
    { id: 'failed', label: 'Failed' },
    { id: 'done', label: 'Done' },
  ];

  // The three faction answers. null is FIRST and is the default, because
  // "unknown" is the permissive state - it shows both sides' tasks, which is
  // what the app did before anyone could say which side they play.
  const FACTION_CHOICES = [
    { id: '', label: 'Faction: any' },
    { id: 'bear', label: 'BEAR' },
    { id: 'usec', label: 'USEC' },
  ];

  // One pass over the task list, stamping the badge each task should carry.
  // Returns NEW wrapper objects rather than mutating the shared task records -
  // those are the same objects the detail pane and the trader view read.
  function decorateTasks(tasks, questState, playerLevel, traderLevels, faction) {
    const list = Array.isArray(tasks) ? tasks : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t || !t.id) continue;
      out.push({
        task: t,
        status: Kit ? Kit.questAvailability(t, questState, playerLevel, traderLevels, faction) : 'locked',
      });
    }
    return out;
  }

  function summarize(rows) {
    const c = {
      done: 0, active: 0, available: 0, locked: 0, failed: 0, total: 0,
    };
    (rows || []).forEach((r) => {
      if (!r) return;
      c.total++;
      if (Object.prototype.hasOwnProperty.call(c, r.status)) c[r.status]++;
    });
    return c;
  }

  // Kappa progress is done-over-required, and the DENOMINATOR is every task
  // flagged kappaRequired - not every task in the game. Counting anything else
  // produces a percentage that looks plausible and is wrong.
  function kappaProgress(rows) {
    let done = 0;
    let total = 0;
    (rows || []).forEach((r) => {
      if (!r || !r.task || !r.task.kappaRequired) return;
      total++;
      if (r.status === 'done') done++;
    });
    return { done, total };
  }

  // Real Kappa needs roughly 200 tasks. The synced data flags THIRTEEN of them,
  // because upstream's kappaRequired field is incomplete - so "Kappa 4/13" read
  // as a third of the way to Kappa when it is nowhere near it, which is the
  // worst kind of wrong: a number that is arithmetically correct and tells the
  // player something false.
  //
  // Under the threshold the label says out loud that the denominator is the
  // FLAGGED count and that the source data is short. Over it (if a future sync
  // carries the full set) the plain label comes back.
  const KAPPA_MIN_CREDIBLE_TOTAL = 50;

  function kappaLabel(kap) {
    const done = Number(kap && kap.done) || 0;
    const total = Number(kap && kap.total) || 0;
    if (!total) return 'Kappa: no tasks flagged in this data';
    if (total < KAPPA_MIN_CREDIBLE_TOTAL) {
      return 'Kappa: ' + done + '/' + total + ' flagged (source data incomplete)';
    }
    return 'Kappa ' + done + '/' + total;
  }

  // ==========================================================================
  // PURE: manual done-marking
  // ==========================================================================
  // Only offered when the HOST can write quest state (ctx.setQuestStatus). In
  // the desktop app it cannot: the state there is a read of the game's own
  // push-notification log, and a button that overwrote it would let the badges
  // disagree with the game. So this is feature-detected, not configured.
  //
  // Reset is offered only for a task the host has actually recorded something
  // for - a "Reset" on a task that was never touched does nothing and reads as
  // a broken button. Pure so exactly that rule is testable without a document.
  function questMarkActions(entry) {
    const out = [
      { id: 'finished', label: 'Mark done' },
      { id: 'started', label: 'Mark started' },
    ];
    if (entry) out.push({ id: null, label: 'Reset' });
    return out;
  }

  // ==========================================================================
  // PURE: filters
  // ==========================================================================
  // 'ground-zero' -> 'Ground Zero'. mapsinfo.json is not loaded on this route
  // (it is a whole extra file for one dropdown), and task.maps[] carries only
  // the normalized name, so the label is derived.
  function prettyMapName(normalized) {
    return String(normalized == null ? '' : normalized)
      .split('-')
      .filter((p) => p.length)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  // Every map any task points at, once, alphabetically. Built from the data so
  // a map added in a future patch appears without a code change.
  function mapOptions(tasks) {
    const seen = {};
    (Array.isArray(tasks) ? tasks : []).forEach((t) => {
      const maps = (t && Array.isArray(t.maps)) ? t.maps : [];
      maps.forEach((m) => {
        const key = m && m.normalizedName;
        if (key && !seen[key]) seen[key] = prettyMapName(key);
      });
      // a task with a single map field and no maps[] still deserves an entry
      if (!maps.length && t && t.mapNormalized && !seen[t.mapNormalized]) {
        seen[t.mapNormalized] = t.map || prettyMapName(t.mapNormalized);
      }
    });
    return Object.keys(seen).sort().map((id) => ({ id, label: seen[id] }));
  }

  function taskOnMap(task, normalized) {
    if (!normalized) return true;
    const maps = (task && Array.isArray(task.maps)) ? task.maps : [];
    for (let i = 0; i < maps.length; i++) if (maps[i] && maps[i].normalizedName === normalized) return true;
    return task && task.mapNormalized === normalized;
  }

  // Name + trader, case-insensitive substring. Deliberately NOT the objective
  // text: a search that matches on a hidden field returns tasks whose row shows
  // no reason for being there.
  function taskMatchesQuery(task, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return true;
    if (String((task && task.name) || '').toLowerCase().indexOf(q) >= 0) return true;
    return String((task && task.trader) || '').toLowerCase().indexOf(q) >= 0;
  }

  function matchesQuestFilters(row, opts) {
    const o = opts || {};
    if (!row || !row.task) return false;
    if (o.status && row.status !== o.status) return false;
    if (o.kappa && !row.task.kappaRequired) return false;
    if (o.lightkeeper && !row.task.lightkeeperRequired) return false;
    if (o.map && !taskOnMap(row.task, o.map)) return false;
    return taskMatchesQuery(row.task, o.query);
  }

  function filterQuests(rows, opts) {
    const list = Array.isArray(rows) ? rows : [];
    const out = [];
    for (let i = 0; i < list.length; i++) if (matchesQuestFilters(list[i], opts)) out.push(list[i]);
    return out;
  }

  // ==========================================================================
  // PURE: grouping
  // ==========================================================================
  // Tasks by their giving trader, traders alphabetically, tasks by level gate
  // then name - which is the order a player actually works through them.
  // A task with no traderId still gets a group rather than vanishing.
  function groupByTrader(rows) {
    const byId = {};
    const order = [];
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (!r || !r.task) return;
      const id = r.task.traderId || '';
      if (!byId[id]) {
        byId[id] = { traderId: id, traderName: r.task.trader || 'Unknown trader', rows: [] };
        order.push(id);
      }
      byId[id].rows.push(r);
    });
    order.sort((a, b) => {
      const an = byId[a].traderName;
      const bn = byId[b].traderName;
      return an < bn ? -1 : (an > bn ? 1 : 0);
    });
    return order.map((id) => {
      byId[id].rows.sort((a, b) => {
        const al = Number(a.task.minPlayerLevel) || 0;
        const bl = Number(b.task.minPlayerLevel) || 0;
        if (al !== bl) return al - bl;
        const an = String(a.task.name || '');
        const bn = String(b.task.name || '');
        return an < bn ? -1 : (an > bn ? 1 : 0);
      });
      return byId[id];
    });
  }

  // ==========================================================================
  // PURE: objective text
  // ==========================================================================
  // The tags that change what an objective actually demands. FiR in particular
  // is the difference between a five-minute errand and an hour of raids, so it
  // is never folded into the description text.
  function objectiveTags(obj) {
    const tags = [];
    if (!obj) return tags;
    if (obj.optional) tags.push('optional');
    if (obj.foundInRaid) tags.push('found in raid');
    if (Number(obj.count) > 1) tags.push('x' + obj.count);
    const wearing = Array.isArray(obj.wearing) ? obj.wearing.length : 0;
    if (wearing) tags.push('gear required');
    const usingWeapon = Array.isArray(obj.usingWeapon) ? obj.usingWeapon.length : 0;
    if (usingWeapon) tags.push('specific weapon');
    const parts = Array.isArray(obj.bodyParts) ? obj.bodyParts : [];
    if (parts.length) tags.push(parts.join('/'));
    const maps = Array.isArray(obj.maps) ? obj.maps : [];
    if (maps.length) tags.push(maps.map((m) => prettyMapName(m && m.normalizedName)).join(' / '));
    return tags;
  }

  // Every item id an objective references, flattened and de-duplicated. The
  // shapes differ by objective type (items[] on findItem/giveItem, a single
  // `item`, `containsAll`), so they are all read rather than assuming one.
  function objectiveItemIds(obj) {
    const out = [];
    const seen = {};
    const push = (v) => {
      if (!v) return;
      const id = typeof v === 'string' ? v : (v.id || v.item || null);
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    };
    if (!obj) return out;
    (Array.isArray(obj.items) ? obj.items : []).forEach(push);
    push(obj.item);
    (Array.isArray(obj.containsAll) ? obj.containsAll : []).forEach(push);
    (Array.isArray(obj.markerItem) ? obj.markerItem : [obj.markerItem]).forEach(push);
    return out;
  }

  // ==========================================================================
  // Everything below touches the DOM and only ever runs inside render().
  // ==========================================================================
  function render(mount, ctx, param) {
    const el = ctx.el;
    const clear = ctx.clear;
    const tasks = ctx.quests || [];
    const items = ctx.items || {};

    const state = {
      query: '',
      status: '',
      map: '',
      kappa: false,
      lightkeeper: false,
      selected: param || null,
      open: {},   // traderId -> expanded
      rows: [],
    };

    // ---- layout ----
    const wrap = el('div', 'split-wrap quests-wrap');
    const left = el('div', 'split-left');
    const right = el('div', 'split-right');
    wrap.appendChild(left);
    wrap.appendChild(right);
    mount.appendChild(wrap);

    // ---- progress header ----
    const head = el('div', 'quest-head');
    const summaryEl = el('div', 'quest-summary');
    const kappaEl = el('div', 'quest-kappa');
    head.appendChild(summaryEl);
    head.appendChild(kappaEl);

    // The player level lives HERE rather than in a settings screen, because it
    // is the input that changes what this very list says: with no level the
    // gate is not applied at all (unknown is permissive), so a task the player
    // cannot take still badges available. One box, next to the number it moves.
    const levelBox = el('div', 'level-box');
    levelBox.appendChild(el('span', 'muted', 'my level'));
    const levelInput = document.createElement('input');
    levelInput.type = 'number';
    levelInput.min = '1';
    levelInput.max = '79';
    levelInput.className = 'level-input';
    levelInput.placeholder = '?';
    levelBox.appendChild(levelInput);
    const inferBtn = el('button', 'chip', '');
    inferBtn.type = 'button';
    levelBox.appendChild(inferBtn);

    // The faction picker sits next to the level box for the same reason the
    // level box is here at all: it is an input that changes what THIS list
    // says. Twelve tasks in the live data are BEAR-only or USEC-only, and with
    // no faction set both halves of every pair badge as takeable - which is
    // never true for any one character.
    const facBox = el('div', 'level-box faction-box');
    facBox.appendChild(el('span', 'muted', 'my faction'));
    const facSel = document.createElement('select');
    facSel.className = 'faction-select';
    FACTION_CHOICES.forEach((f) => {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.id ? f.label : 'None';
      facSel.appendChild(o);
    });
    facSel.title = 'BEAR/USEC-only tasks are locked for the other side. "None" shows both.';
    facBox.appendChild(facSel);
    levelBox.appendChild(facBox);
    head.appendChild(levelBox);
    left.appendChild(head);

    function syncFactionBox() {
      const cur = ctx.profile.faction || '';
      if (document.activeElement !== facSel) facSel.value = cur;
    }

    function commitFaction(raw) {
      const s = String(raw == null ? '' : raw).trim().toLowerCase();
      const next = (s === 'bear' || s === 'usec') ? s : null;
      ctx.profile.faction = next;
      ctx.saveProfile({ faction: next });
      recompute();
      renderDetail(state.selected);
    }

    facSel.addEventListener('change', () => commitFaction(facSel.value));

    function syncLevelBox() {
      const cur = ctx.profile.playerLevel;
      // never fight the user mid-type: only re-seed when the box is not focused
      if (document.activeElement !== levelInput) {
        levelInput.value = cur == null ? '' : String(cur);
      }
      const floor = Kit ? Kit.inferMinPlayerLevel(tasks, ctx.questState) : 0;
      // The floor is a FACT from finished tasks ("you accepted something gated
      // at 15, so you are at least 15"), offered as a one-click fill. It is
      // never applied on its own - it is a floor, not the level.
      if (floor > 0 && cur !== floor) {
        inferBtn.textContent = 'at least ' + floor + '?';
        inferBtn.title = 'the highest level gate among the tasks you have finished';
        inferBtn.classList.remove('hidden');
      } else {
        inferBtn.classList.add('hidden');
      }
    }

    function commitLevel(raw) {
      const s = String(raw == null ? '' : raw).trim();
      if (s === '') {
        ctx.profile.playerLevel = null;
        ctx.saveProfile({ playerLevel: null });
        recompute();
        return;
      }
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > 79) {
        // main would refuse it anyway; snapping back here is the honest echo
        syncLevelBox();
        return;
      }
      ctx.profile.playerLevel = n;
      ctx.saveProfile({ playerLevel: n });
      recompute();
    }

    levelInput.addEventListener('change', () => commitLevel(levelInput.value));
    levelInput.addEventListener('blur', () => commitLevel(levelInput.value));
    inferBtn.addEventListener('click', () => {
      const floor = Kit ? Kit.inferMinPlayerLevel(tasks, ctx.questState) : 0;
      if (floor > 0) commitLevel(floor);
    });

    // ---- controls ----
    const controls = el('div', 'items-controls');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'items-search';
    search.placeholder = 'Search task or trader...';
    search.spellcheck = false;
    controls.appendChild(search);

    const selRow = el('div', 'items-selects');
    const statusSel = document.createElement('select');
    STATUS_FILTERS.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label;
      statusSel.appendChild(o);
    });
    selRow.appendChild(statusSel);

    const mapSel = document.createElement('select');
    const anyMap = document.createElement('option');
    anyMap.value = '';
    anyMap.textContent = 'All maps';
    mapSel.appendChild(anyMap);
    mapOptions(tasks).forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      mapSel.appendChild(o);
    });
    selRow.appendChild(mapSel);
    controls.appendChild(selRow);

    const chipBox = el('div', 'items-chips');
    const kappaChip = el('button', 'chip', 'Kappa only');
    kappaChip.type = 'button';
    kappaChip.addEventListener('click', () => {
      state.kappa = !state.kappa;
      kappaChip.classList.toggle('on', state.kappa);
      recompute();
    });
    chipBox.appendChild(kappaChip);
    const lkChip = el('button', 'chip', 'Lightkeeper only');
    lkChip.type = 'button';
    lkChip.addEventListener('click', () => {
      state.lightkeeper = !state.lightkeeper;
      lkChip.classList.toggle('on', state.lightkeeper);
      recompute();
    });
    chipBox.appendChild(lkChip);
    controls.appendChild(chipBox);

    const countEl = el('div', 'items-count', '');
    controls.appendChild(countEl);
    left.appendChild(controls);

    const listEl = el('div', 'quest-list');
    left.appendChild(listEl);

    // ---- helpers ----
    function traderName(id) {
      const t = ctx.traderById && ctx.traderById[id];
      return (t && t.name) || 'Unknown trader';
    }

    function itemName(id) {
      const it = items[id];
      return (it && it.n) || id;
    }

    function taskById(id) {
      return (ctx.questById && ctx.questById[id]) || null;
    }

    function badge(status) {
      const b = el('span', 'badge badge-' + status, STATUS_LABEL[status] || status);
      return b;
    }

    // A clickable item chip that routes to the Items detail pane.
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

    // A clickable task chip that stays on this route and focuses the detail
    // pane - which is what makes the prerequisite chain walkable.
    function taskLink(id, fallbackLabel) {
      const t = taskById(id);
      const name = (t && t.name) || fallbackLabel || id;
      const a = el('button', 'task-link', name);
      a.type = 'button';
      if (t) {
        const st = Kit ? Kit.questAvailability(t, ctx.questState, ctx.profile.playerLevel, ctx.profile.traderLevels, ctx.profile.faction) : null;
        if (st) a.appendChild(badge(st));
      }
      a.addEventListener('click', () => ctx.go('quests', id));
      return a;
    }

    // ---- list ----
    function recompute() {
      state.rows = decorateTasks(tasks, ctx.questState, ctx.profile.playerLevel,
        ctx.profile.traderLevels, ctx.profile.faction);
      const all = summarize(state.rows);
      const kap = kappaProgress(state.rows);
      clear(summaryEl);
      summaryEl.appendChild(el('span', 'sum sum-done', all.done + ' done'));
      summaryEl.appendChild(el('span', 'sum sum-active', all.active + ' active'));
      summaryEl.appendChild(el('span', 'sum sum-available', all.available + ' available'));
      summaryEl.appendChild(el('span', 'sum sum-locked', all.locked + ' locked'));
      // only shown when there is one: a permanent "0 failed" is noise
      if (all.failed) summaryEl.appendChild(el('span', 'sum sum-failed', all.failed + ' failed'));
      kappaEl.textContent = kappaLabel(kap);
      kappaEl.title = kap.total && kap.total < KAPPA_MIN_CREDIBLE_TOTAL
        ? 'Only ' + kap.total + ' tasks carry the kappaRequired flag in the synced data;'
          + ' the real Kappa list is roughly 200. This is not your Kappa progress.'
        : '';
      syncLevelBox();
      syncFactionBox();

      const shown = filterQuests(state.rows, {
        status: state.status,
        map: state.map,
        kappa: state.kappa,
        lightkeeper: state.lightkeeper,
        query: state.query,
      });
      countEl.textContent = shown.length + ' of ' + state.rows.length + ' tasks';
      paintList(groupByTrader(shown));
    }

    function paintList(groups) {
      clear(listEl);
      if (!groups.length) {
        listEl.appendChild(el('div', 'detail-empty', 'No tasks match those filters.'));
        return;
      }
      groups.forEach((g) => {
        const box = el('div', 'trader-group');
        const header = el('button', 'trader-header');
        header.type = 'button';
        const portrait = document.createElement('img');
        portrait.className = 'trader-portrait';
        portrait.alt = '';
        const src = ctx.imgUrl('trader', g.traderId);
        if (src) portrait.src = src;
        portrait.addEventListener('error', () => { portrait.style.visibility = 'hidden'; });
        header.appendChild(portrait);
        header.appendChild(el('span', 'trader-name', g.traderName));
        const counts = summarize(g.rows);
        header.appendChild(el('span', 'trader-count',
          g.rows.length + ' - ' + counts.done + ' done'));
        // Collapsed by default would hide everything on first open, so the
        // default is OPEN and the memory is only of what the user has closed.
        const open = state.open[g.traderId] !== false;
        header.appendChild(el('span', 'trader-caret', open ? '-' : '+'));
        header.addEventListener('click', () => {
          state.open[g.traderId] = !(state.open[g.traderId] !== false);
          recompute();
        });
        box.appendChild(header);

        if (open) {
          const rowsEl = el('div', 'trader-tasks');
          g.rows.forEach((r) => {
            const row = el('div', 'quest-row' + (state.selected === r.task.id ? ' selected' : ''));
            row.appendChild(badge(r.status));
            row.appendChild(el('span', 'quest-name', r.task.name || r.task.id));
            const marks = el('span', 'quest-marks');
            if (r.task.kappaRequired) {
              const k = el('span', 'mark mark-kappa', 'K');
              k.title = 'required for Kappa';
              marks.appendChild(k);
            }
            if (r.task.lightkeeperRequired) {
              const l = el('span', 'mark mark-lk', 'L');
              l.title = 'required for Lightkeeper';
              marks.appendChild(l);
            }
            row.appendChild(marks);
            row.appendChild(el('span', 'quest-lvl',
              Number(r.task.minPlayerLevel) > 0 ? 'lv' + r.task.minPlayerLevel : ''));
            row.addEventListener('click', () => select(r.task.id));
            rowsEl.appendChild(row);
          });
          box.appendChild(rowsEl);
        }
        listEl.appendChild(box);
      });
    }

    function select(id) {
      state.selected = id;
      recompute();
      renderDetail(id);
    }

    // ---- detail ----
    function renderDetail(id) {
      const t = taskById(id);
      clear(right);
      if (!t) {
        right.appendChild(el('div', 'detail-empty',
          id ? 'That task is not in the synced data.' : 'Pick a task.'));
        return;
      }
      const status = Kit
        ? Kit.questAvailability(t, ctx.questState, ctx.profile.playerLevel,
          ctx.profile.traderLevels, ctx.profile.faction)
        : 'locked';

      const head2 = el('div', 'detail-head quest-detail-head');
      const portrait = document.createElement('img');
      portrait.className = 'detail-portrait';
      portrait.alt = '';
      const psrc = ctx.imgUrl('trader', t.traderId);
      if (psrc) portrait.src = psrc;
      portrait.addEventListener('error', () => { portrait.style.visibility = 'hidden'; });
      head2.appendChild(portrait);

      const headText = el('div', 'detail-headtext');
      const h2 = el('h2', null, t.name || t.id);
      headText.appendChild(h2);
      const badgeRow = el('div', 'detail-badges');
      badgeRow.appendChild(badge(status));
      if (t.kappaRequired) badgeRow.appendChild(el('span', 'mark mark-kappa', 'Kappa'));
      if (t.lightkeeperRequired) badgeRow.appendChild(el('span', 'mark mark-lk', 'Lightkeeper'));
      headText.appendChild(badgeRow);

      const facts = el('div', 'detail-facts');
      facts.appendChild(el('span', null, t.trader || traderName(t.traderId)));
      if (Number(t.minPlayerLevel) > 0) facts.appendChild(el('span', null, 'level ' + t.minPlayerLevel));
      const mapNames = (Array.isArray(t.maps) ? t.maps : [])
        .map((m) => prettyMapName(m && m.normalizedName)).filter((s) => s);
      if (mapNames.length) facts.appendChild(el('span', null, mapNames.join(', ')));
      else if (t.map) facts.appendChild(el('span', null, t.map));
      if (Number(t.experience) > 0) facts.appendChild(el('span', null, t.experience + ' XP'));
      // 'Any' is the overwhelming majority and saying it on every task is noise;
      // BEAR-only / USEC-only is the whole reason the picker exists.
      const fac = String(t.factionName || '').trim();
      if (fac && fac.toLowerCase() !== 'any') facts.appendChild(el('span', null, fac + ' only'));
      headText.appendChild(facts);

      (Array.isArray(t.traderRequirements) ? t.traderRequirements : []).forEach((tr) => {
        const need = tr && (tr.level != null ? tr.level : tr.value);
        if (need == null) return;
        headText.appendChild(el('div', 'muted',
          'Requires ' + (tr.trader || traderName(tr.traderId)) + ' LL' + need));
      });

      // Manual done-marking. Absent entirely unless the host can write quest
      // state (see questMarkActions above), so the Electron build renders
      // exactly what it always did.
      if (typeof ctx.setQuestStatus === 'function') {
        const markRow = el('div', 'quest-mark-row');
        markRow.appendChild(el('span', 'muted', 'my progress'));
        questMarkActions(ctx.questState && ctx.questState[t.id]).forEach((a) => {
          const b = el('button', 'chip quest-mark', a.label);
          b.type = 'button';
          // The host echoes the write back on its 'quests' push, which is what
          // actually moves ctx.questState and re-renders - same contract the
          // profile editors already follow, so the UI can never show a state
          // the host refused.
          b.addEventListener('click', () => { ctx.setQuestStatus(t.id, a.id); });
          markRow.appendChild(b);
        });
        headText.appendChild(markRow);
      }

      if (t.wiki) {
        const btn = el('button', 'wiki-btn', 'Open wiki page');
        btn.type = 'button';
        btn.addEventListener('click', () => {
          if (ctx.api && ctx.api.openExternal) ctx.api.openExternal(t.wiki);
        });
        headText.appendChild(btn);
      }
      head2.appendChild(headText);
      right.appendChild(head2);

      // ---- objectives ----
      const objs = Array.isArray(t.objectives) ? t.objectives : [];
      if (objs.length) {
        const s = ctx.section('Objectives');
        objs.forEach((o) => {
          const line = el('div', 'objective');
          line.appendChild(el('div', 'objective-text', o.description || o.type || ''));
          const tags = objectiveTags(o);
          if (tags.length) {
            const tagRow = el('div', 'objective-tags');
            tags.forEach((tg) => tagRow.appendChild(el('span', 'tag', tg)));
            line.appendChild(tagRow);
          }
          const ids = objectiveItemIds(o).filter((x) => items[x]);
          if (ids.length) {
            const row = el('div', 'barter-reqs');
            ids.forEach((x) => row.appendChild(miniItem(x, o.count)));
            line.appendChild(row);
          }
          s.appendChild(line);
        });
        right.appendChild(s);
      }

      // ---- prerequisites + successors ----
      const reqs = Array.isArray(t.taskRequirements) ? t.taskRequirements : [];
      if (reqs.length) {
        const s = ctx.section('Requires first');
        const row = el('div', 'link-row');
        reqs.forEach((r) => {
          const rid = r && (r.task || r.id);
          if (!rid) return;
          const link = taskLink(typeof rid === 'object' ? rid.id : rid);
          const wanted = (Array.isArray(r.status) && r.status.length) ? r.status.join('/') : 'complete';
          // 'complete' is the common case and adding it to every chip is noise;
          // an 'active' or 'failed' prerequisite is genuinely unusual and has
          // to be visible.
          if (wanted !== 'complete') link.appendChild(el('span', 'tag', wanted));
          row.appendChild(link);
        });
        s.appendChild(row);
        right.appendChild(s);
      }
      const succ = Array.isArray(t.successors) ? t.successors : [];
      if (succ.length) {
        const s = ctx.section('Unlocks (' + succ.length + ')');
        const row = el('div', 'link-row');
        succ.forEach((sid) => row.appendChild(taskLink(sid)));
        s.appendChild(row);
        right.appendChild(s);
      }

      // ---- keys ----
      const keys = Array.isArray(t.neededKeys) ? t.neededKeys : [];
      if (keys.length) {
        const s = ctx.section('Keys');
        keys.forEach((k) => {
          const line = el('div', 'barter-line');
          line.appendChild(el('div', 'barter-head', k.map || prettyMapName(k.mapId) || 'Any map'));
          const row = el('div', 'barter-reqs');
          (Array.isArray(k.keys) ? k.keys : []).forEach((kid) => row.appendChild(miniItem(kid, 1)));
          line.appendChild(row);
          s.appendChild(line);
        });
        right.appendChild(s);
      }

      // ---- rewards ----
      renderRewards('On completion', t.finishRewards, Number(t.experience) || 0);
      renderRewards('On accepting', t.startRewards, 0);

      // ---- the awkward extras ----
      const other = Array.isArray(t.otherRequirements) ? t.otherRequirements : [];
      if (other.length) {
        const s = ctx.section('Other requirements');
        other.forEach((o) => {
          const traders = (Array.isArray(o.traders) ? o.traders : []).map(traderName).join(', ');
          s.appendChild(el('div', 'muted',
            String(o.type || 'requirement') + (traders ? ' - ' + traders : '')));
        });
        right.appendChild(s);
      }
      const fails = Array.isArray(t.failConditions) ? t.failConditions : [];
      if (fails.length) {
        const s = ctx.section('Fails if');
        fails.forEach((f) => {
          const line = el('div', 'muted');
          if (f.description) {
            line.textContent = f.description;
          } else if (f.task) {
            const ft = taskById(f.task);
            line.textContent = String(f.type || 'taskStatus') + ': '
              + ((ft && ft.name) || f.task)
              + ((Array.isArray(f.status) && f.status.length) ? ' -> ' + f.status.join('/') : '');
          } else {
            line.textContent = String(f.type || 'condition');
          }
          s.appendChild(line);
        });
        right.appendChild(s);
      }
    }

    function renderRewards(title, rewards, xp) {
      const r = rewards || {};
      const standing = Array.isArray(r.traderStanding) ? r.traderStanding : [];
      const gifts = Array.isArray(r.items) ? r.items : [];
      const unlocks = Array.isArray(r.offerUnlock) ? r.offerUnlock : [];
      const traderUnlock = Array.isArray(r.traderUnlock) ? r.traderUnlock : [];
      const skills = Array.isArray(r.skillLevelReward) ? r.skillLevelReward : [];
      if (!xp && !standing.length && !gifts.length && !unlocks.length
        && !traderUnlock.length && !skills.length) return;

      const s = ctx.section(title);
      const rows = [];
      if (xp) rows.push({ k: 'Experience', v: String(xp) });
      standing.forEach((st) => {
        const n = Number(st && st.standing);
        if (!Number.isFinite(n)) return;
        rows.push({
          k: traderName(st.trader) + ' rep',
          // signed on purpose: a task that COSTS reputation with a trader is a
          // fact the player needs before accepting it
          v: (n > 0 ? '+' : '') + (Math.round(n * 1000) / 1000),
        });
      });
      skills.forEach((sk) => {
        if (!sk || !sk.name) return;
        rows.push({ k: String(sk.name) + ' skill', v: '+' + (sk.level == null ? '?' : sk.level) });
      });
      if (rows.length) s.appendChild(ctx.table(rows));

      if (gifts.length) {
        const row = el('div', 'barter-reqs');
        gifts.forEach((g) => { if (g && g.item) row.appendChild(miniItem(g.item, g.count)); });
        s.appendChild(row);
      }
      traderUnlock.forEach((tu) => {
        const tid = (tu && (tu.id || tu.trader)) || tu;
        s.appendChild(el('div', 'muted', 'Unlocks trader: ' + traderName(tid)));
      });
      unlocks.forEach((u) => {
        if (!u) return;
        const line = el('div', 'unlock-line');
        line.appendChild(el('span', 'muted', 'Unlocks at '
          + traderName(u.trader) + ' LL' + (u.level == null ? '?' : u.level) + ':'));
        if (u.item) line.appendChild(miniItem(u.item, u.count));
        s.appendChild(line);
      });
      right.appendChild(s);
    }

    // ---- wiring ----
    let searchTimer = null;
    search.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = search.value; recompute(); }, 90);
    });
    statusSel.addEventListener('change', () => { state.status = statusSel.value; recompute(); });
    mapSel.addEventListener('change', () => { state.map = mapSel.value; recompute(); });

    // ---- first paint ----
    recompute();
    renderDetail(state.selected);

    return {
      // a deep link into this route: focus the task, do not rebuild the tree
      focus: (id) => {
        if (!id) return;
        select(id);
        const row = listEl.querySelector('.quest-row.selected');
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      },
      // a quest event or a profile save moved every badge
      refresh: () => { recompute(); renderDetail(state.selected); },
    };
  }

  return {
    STATUS_ORDER,
    STATUS_LABEL,
    STATUS_FILTERS,
    FACTION_CHOICES,
    KAPPA_MIN_CREDIBLE_TOTAL,
    questMarkActions,
    decorateTasks,
    summarize,
    kappaProgress,
    kappaLabel,
    prettyMapName,
    mapOptions,
    taskOnMap,
    taskMatchesQuery,
    matchesQuestFilters,
    filterQuests,
    groupByTrader,
    objectiveTags,
    objectiveItemIds,
    render,
  };
}));
