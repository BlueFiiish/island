// Pilot Hub - the item browser.
//
// Loaded two ways on purpose, exactly like floors.js / squad.js / hub.js: as a
// plain <script> in the hub window and via require() from test/hub.test.mjs.
// EVERY DOM touch lives behind render(); everything above it is pure and
// covered by the tests, because the parts that are easy to get quietly wrong
// here - search ranking, the virtualisation window, per-slot value - are all
// decidable without a document.
//
// THE SIZE PROBLEM: 5,312 items. Rendering them all is ~5,300 rows with an
// <img> each, which janks the window on every keystroke. So the list is
// virtualised: only the ~40 rows that can actually be seen (plus a small
// overscan) exist in the DOM at a time, and the scrollbar is kept honest with
// padding above and below. windowRange() is that arithmetic, on its own, so it
// can be tested at the edges rather than eyeballed.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubItems = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Fixed row height. Virtualisation needs to know where row N is without
  // measuring it, so rows are not allowed to size themselves.
  const ROW_H = 44;
  const OVERSCAN = 6;

  // ==========================================================================
  // PURE: search
  // ==========================================================================
  // Rank, low is better:
  //   0  exact hit on the full name or the short name ("M4A1")
  //   1  prefix hit    ("m4" -> "M4A1")
  //   2  substring hit ("bleed" -> "Esmarch tourniquet"... eventually)
  //  -1  no hit
  // Short name is checked alongside the full name and at the same rank on
  // purpose: in Tarkov the short name IS what an item is called out loud, and
  // typing "gzhel" must find "Gzhel-K armor" ahead of anything that merely
  // contains the word.
  function matchRank(name, shortName, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return 0; // no query: everything matches, equally
    const n = String(name == null ? '' : name).toLowerCase();
    const s = String(shortName == null ? '' : shortName).toLowerCase();
    if (n === q || s === q) return 0;
    if (n.indexOf(q) === 0 || s.indexOf(q) === 0) return 1;
    if (n.indexOf(q) >= 0 || s.indexOf(q) >= 0) return 2;
    return -1;
  }

  // Rank first, then base price, then the SHORTER name, then alphabetical.
  //
  // The price tie-break is not a value judgement, it is the fix for a real
  // collision: THREE items answer to the short name "M4A1" - the rifle, its
  // upper receiver and its front sight - so they all rank 0 and the length
  // tie-break alone handed the top slot to "M4A1 5.56x45 upper receiver".
  // When several items share a name, the one the search meant is the whole
  // item, and a whole item is always worth more than its parts. Length still
  // decides when price cannot ("M4A1" above "M4A1 5.56x45 muzzle brake").
  function compareSearch(a, b) {
    if (a._rank !== b._rank) return a._rank - b._rank;
    const ab = Number(a.base) || 0;
    const bb = Number(b.base) || 0;
    if (ab !== bb) return bb - ab;
    const an = String(a.n || '');
    const bn = String(b.n || '');
    if (an.length !== bn.length) return an.length - bn.length;
    return an < bn ? -1 : (an > bn ? 1 : 0);
  }

  // Returns a NEW array; never mutates the caller's list. _rank is stamped on
  // the entries because the sort needs it and re-deriving it inside the
  // comparator would re-run the match O(n log n) times.
  function searchItems(entries, query) {
    const list = Array.isArray(entries) ? entries : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const rank = matchRank(it.n, it.s, query);
      if (rank < 0) continue;
      it._rank = rank;
      out.push(it);
    }
    return out.sort(compareSearch);
  }

  // ==========================================================================
  // PURE: filters
  // ==========================================================================
  // `hb` is a handbook category id. items.json denormalises the whole ancestor
  // chain into item.hb, so picking "Weapons" matches every rifle under it with
  // no tree walk at read time.
  function matchesFilters(item, opts) {
    const o = opts || {};
    if (o.hb) {
      const hb = Array.isArray(item.hb) ? item.hb : [];
      if (hb.indexOf(o.hb) < 0) return false;
    }
    const types = Array.isArray(o.types) ? o.types : [];
    if (types.length) {
      const own = Array.isArray(item.types) ? item.types : [];
      // AND, not OR: chips narrow. Two chips that cannot co-occur giving an
      // empty list is the honest answer, not a bug.
      for (let i = 0; i < types.length; i++) if (own.indexOf(types[i]) < 0) return false;
    }
    return true;
  }

  function filterItems(entries, opts) {
    const list = Array.isArray(entries) ? entries : [];
    const out = [];
    for (let i = 0; i < list.length; i++) if (matchesFilters(list[i], opts)) out.push(list[i]);
    return out;
  }

  // Every distinct tarkov.dev type in the data, most common first. Built from
  // the data rather than hard-coded so a new type in a future patch shows up as
  // a chip instead of silently not existing.
  function distinctTypes(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const counts = {};
    for (let i = 0; i < list.length; i++) {
      const t = Array.isArray(list[i].types) ? list[i].types : [];
      for (let j = 0; j < t.length; j++) counts[t[j]] = (counts[t[j]] || 0) + 1;
    }
    return Object.keys(counts)
      .map((type) => ({ type, count: counts[type] }))
      .sort((a, b) => (b.count - a.count) || (a.type < b.type ? -1 : 1));
  }

  // ==========================================================================
  // PURE: values and sorting
  // ==========================================================================
  function fleaAvg(item) {
    const f = item && item.flea;
    const n = f ? Number(f.avg) : NaN;
    return Number.isFinite(n) ? n : 0;
  }

  // Roubles per inventory slot - the number that actually decides what comes
  // out of a raid, because a backpack is measured in slots, not in items.
  // 0 for anything flea-banned or with junk dimensions, so it sorts last
  // rather than dividing by zero.
  function perSlotValue(item) {
    const avg = fleaAvg(item);
    if (!avg) return 0;
    const w = Number(item && item.w);
    const h = Number(item && item.h);
    const slots = (Number.isFinite(w) && Number.isFinite(h)) ? w * h : 0;
    if (slots <= 0) return 0;
    return avg / slots;
  }

  // The row text, not the number. perSlotValue returns 0 for anything with no
  // flea average (a listed item whose price has not been scanned yet, or junk
  // dimensions), and formatRub(0) is a literal "0 roubles" - a per-slot value
  // the item does not have. An absent row beats a wrong one.
  function perSlotText(item, formatRub) {
    const v = perSlotValue(item);
    if (!(v > 0)) return '';
    return typeof formatRub === 'function' ? formatRub(v) : String(v);
  }

  function bestSell(item) {
    const sell = (item && Array.isArray(item.sell)) ? item.sell : [];
    let best = null;
    for (let i = 0; i < sell.length; i++) {
      const n = Number(sell[i] && sell[i].rub);
      if (!Number.isFinite(n)) continue;
      if (!best || n > best.rub) best = { t: sell[i].t, rub: n };
    }
    return best;
  }

  const SORTS = [
    { id: 'name', label: 'Name (A-Z)' },
    { id: 'flea', label: 'Flea average' },
    { id: 'perslot', label: 'Value per slot' },
    { id: 'base', label: 'Base price' },
    { id: 'sell', label: 'Best trader sell' },
  ];

  // Name ascending; every money sort descending, because "what is worth most"
  // is the only question anyone asks of them. Ties fall back to name so the
  // order is stable between renders (Array.prototype.sort is stable in modern
  // engines, but the list is rebuilt from scratch on every keystroke).
  function compareBy(sortKey) {
    const byName = (a, b) => {
      const an = String(a.n || '');
      const bn = String(b.n || '');
      return an < bn ? -1 : (an > bn ? 1 : 0);
    };
    if (sortKey === 'flea') return (a, b) => (fleaAvg(b) - fleaAvg(a)) || byName(a, b);
    if (sortKey === 'perslot') return (a, b) => (perSlotValue(b) - perSlotValue(a)) || byName(a, b);
    if (sortKey === 'base') return (a, b) => ((Number(b.base) || 0) - (Number(a.base) || 0)) || byName(a, b);
    if (sortKey === 'sell') {
      return (a, b) => {
        const av = bestSell(a) ? bestSell(a).rub : 0;
        const bv = bestSell(b) ? bestSell(b).rub : 0;
        return (bv - av) || byName(a, b);
      };
    }
    return byName;
  }

  function sortItems(entries, sortKey) {
    return (Array.isArray(entries) ? entries.slice() : []).sort(compareBy(sortKey));
  }

  // ==========================================================================
  // PURE: a one-shot loader that forgets a FAILED load
  // ==========================================================================
  // The detail pane pulls item-props.json (3.4 MB) and items-desc.json (800 KB)
  // on the first item anyone opens and holds the promise from then on. Holding a
  // promise that RESOLVED NULL - a read that failed because the file was mid-
  // sync, missing or unparseable - meant every stat table and every description
  // stayed blank for the rest of the session, with no way back but a restart.
  //
  // So a null result drops the cached promise (and asks the shell to drop its
  // own cached parse of the same name, or the retry would just be handed the
  // same null), and the next detail view tries again. A successful load is
  // still cached exactly once.
  function makeRetryingLoader(load, name, forget) {
    let pending = null;
    return function () {
      if (pending) return pending;
      const drop = () => {
        pending = null;
        if (typeof forget === 'function') {
          try { forget(name); } catch (e) { /* the shell's cache is best-effort */ }
        }
      };
      pending = Promise.resolve()
        .then(() => load(name))
        .then((doc) => {
          if (!doc) drop();
          return doc || null;
        }, (e) => {
          drop();
          console.error('hub: ' + name + ' could not be loaded: ' + (e && e.message ? e.message : e));
          return null;
        });
      return pending;
    };
  }

  // ==========================================================================
  // PURE: virtualisation
  // ==========================================================================
  // Which rows to build, and how much empty space to leave above and below them
  // so the scrollbar still describes the WHOLE list. Everything is clamped:
  // a scrollTop past the end (momentum scrolling, a shrinking filter) must
  // return an empty-but-valid window, never negative padding.
  function windowRange(scrollTop, rowHeight, viewportHeight, total, overscan) {
    const rh = Number(rowHeight) > 0 ? Number(rowHeight) : ROW_H;
    const n = Math.max(0, Math.floor(Number(total) || 0));
    const over = Math.max(0, Math.floor(Number(overscan) || 0));
    const top = Math.max(0, Number(scrollTop) || 0);
    const vh = Math.max(0, Number(viewportHeight) || 0);
    let start = Math.floor(top / rh) - over;
    if (start < 0) start = 0;
    if (start > n) start = n;
    let end = Math.ceil((top + vh) / rh) + over;
    if (end > n) end = n;
    if (end < start) end = start;
    return { start, end, padTop: start * rh, padBottom: (n - end) * rh };
  }

  // ==========================================================================
  // PURE: category tree
  // ==========================================================================
  // categories.json is a flat id -> { name, parent, children } map. The
  // dropdown wants it depth-first and alphabetical. `seen` is not paranoia:
  // one bad parent pointer in synced data would otherwise hang the window.
  function flattenCategoryTree(cats) {
    const map = (cats && typeof cats === 'object') ? cats : {};
    const ids = Object.keys(map);
    const childrenOf = {};
    const roots = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const parent = (map[id] || {}).parent;
      if (parent && Object.prototype.hasOwnProperty.call(map, parent)) {
        (childrenOf[parent] = childrenOf[parent] || []).push(id);
      } else {
        roots.push(id);
      }
    }
    const nameOf = (id) => String((map[id] || {}).name || id);
    const byName = (a, b) => (nameOf(a) < nameOf(b) ? -1 : (nameOf(a) > nameOf(b) ? 1 : 0));
    const out = [];
    const seen = {};
    function walk(id, depth) {
      if (seen[id]) return;
      seen[id] = true;
      out.push({ id, name: nameOf(id), depth });
      (childrenOf[id] || []).sort(byName).forEach((c) => walk(c, depth + 1));
    }
    roots.sort(byName).forEach((id) => walk(id, 0));
    return out;
  }

  // ==========================================================================
  // PURE: stat tables
  // ==========================================================================
  function humanizeKey(k) {
    const s = String(k || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  // 'Caliber556x45NATO' -> '5.56x45 NATO'. Cosmetic only; the raw value is kept
  // when the shape is anything other than the one the API actually uses.
  function prettyCaliber(v) {
    const s = String(v == null ? '' : v);
    const m = /^Caliber(\d+)(?:x(\d+))?(.*)$/.exec(s);
    if (!m) return s;
    let head = m[1];
    if (head.length >= 3) head = head.slice(0, 1) + '.' + head.slice(1);
    return head + (m[2] ? 'x' + m[2] : '') + (m[3] ? ' ' + m[3] : '');
  }

  function num(v, digits) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const d = digits == null ? 0 : digits;
    const p = Math.pow(10, d);
    return String(Math.round(n * p) / p);
  }

  function pctOf(v, digits) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return num(n * 100, digits == null ? 0 : digits) + '%';
  }

  function push(rows, k, v) {
    if (v == null || v === '') return;
    rows.push({ k, v: String(v) });
  }

  // One row list per propertiesType. Anything the API adds that is not modelled
  // below still shows up, via the scalar fallback - an unknown stat rendering
  // as a plain key/value beats it silently not being there.
  function propRows(props) {
    const p = (props && typeof props === 'object') ? props : null;
    if (!p) return [];
    const rows = [];
    const type = String(p.propertiesType || '');
    switch (type) {
      case 'ItemPropertiesAmmo':
        push(rows, 'Caliber', prettyCaliber(p.caliber));
        push(rows, 'Damage', num(p.damage));
        push(rows, 'Penetration power', num(p.penetrationPower));
        push(rows, 'Armor damage', p.armorDamage == null ? null : num(p.armorDamage) + '%');
        push(rows, 'Fragmentation', pctOf(p.fragmentationChance));
        push(rows, 'Ricochet', pctOf(p.ricochetChance));
        push(rows, 'Velocity', p.initialSpeed == null ? null : num(p.initialSpeed) + ' m/s');
        push(rows, 'Projectiles', Number(p.projectileCount) > 1 ? num(p.projectileCount) : null);
        push(rows, 'Tracer', p.tracer ? ('yes (' + (p.tracerColor || 'unknown') + ')') : 'no');
        push(rows, 'Stack size', num(p.stackMaxSize));
        return rows;
      case 'ItemPropertiesArmor':
      case 'ItemPropertiesHelmet':
      case 'ItemPropertiesArmorAttachment':
      case 'ItemPropertiesGlasses':
        push(rows, 'Armor class', num(p.class));
        push(rows, 'Durability', num(p.durability));
        push(rows, 'Material', p.material || (p.armorSlots && p.armorSlots[0] && p.armorSlots[0].name) || null);
        push(rows, 'Armor type', p.armorType && p.armorType !== 'None' ? p.armorType : null);
        push(rows, 'Blunt throughput', pctOf(p.bluntThroughput, 1));
        push(rows, 'Zones', Array.isArray(p.zones) && p.zones.length ? String(p.zones.length) : null);
        push(rows, 'Movement', p.speedPenalty ? pctOf(p.speedPenalty) : null);
        push(rows, 'Turn', p.turnPenalty ? pctOf(p.turnPenalty) : null);
        push(rows, 'Ergonomics', p.ergoPenalty ? pctOf(p.ergoPenalty) : null);
        push(rows, 'Blindness protection', p.blindnessProtection ? pctOf(p.blindnessProtection) : null);
        if (Array.isArray(p.armorSlots) && p.armorSlots.length) {
          const plates = p.armorSlots.reduce((acc, s) => {
            const allowed = s && (s.allowedPlates || (s.filters && s.filters.allowedItems));
            return acc + (Array.isArray(allowed) ? allowed.length : 0);
          }, 0);
          push(rows, 'Plate slots', p.armorSlots.length + (plates ? ' (' + plates + ' plates fit)' : ''));
        }
        return rows;
      case 'ItemPropertiesWeapon':
        push(rows, 'Caliber', prettyCaliber(p.caliber));
        push(rows, 'Ergonomics', num(p.ergonomics));
        push(rows, 'Fire rate', p.fireRate == null ? null : num(p.fireRate) + ' rpm');
        push(rows, 'Fire modes', Array.isArray(p.fireModes) && p.fireModes.length ? p.fireModes.join(', ') : null);
        push(rows, 'Recoil vertical', num(p.recoilVertical));
        push(rows, 'Recoil horizontal', num(p.recoilHorizontal));
        push(rows, 'Effective distance', p.effectiveDistance == null ? null : num(p.effectiveDistance) + ' m');
        push(rows, 'Durability', num(p.maxDurability));
        push(rows, 'Ammo types', Array.isArray(p.allowedAmmo) ? String(p.allowedAmmo.length) : null);
        push(rows, 'Mod slots', Array.isArray(p.slots) ? String(p.slots.length) : null);
        return rows;
      case 'ItemPropertiesPreset':
        push(rows, 'Ergonomics', num(p.ergonomics));
        push(rows, 'Recoil vertical', num(p.recoilVertical));
        push(rows, 'Recoil horizontal', num(p.recoilHorizontal));
        push(rows, 'MOA', num(p.moa, 2));
        push(rows, 'Default preset', p['default'] ? 'yes' : 'no');
        return rows;
      case 'ItemPropertiesGrenade':
        push(rows, 'Type', p.type);
        push(rows, 'Fuse', p.fuse == null ? null : num(p.fuse, 1) + ' s');
        push(rows, 'Fragments', num(p.fragments));
        push(rows, 'Blast radius', (p.minExplosionDistance == null && p.maxExplosionDistance == null)
          ? null : num(p.minExplosionDistance, 1) + ' - ' + num(p.maxExplosionDistance, 1) + ' m');
        push(rows, 'Contusion radius', p.contusionRadius == null ? null : num(p.contusionRadius, 1) + ' m');
        return rows;
      case 'ItemPropertiesMedKit':
      case 'ItemPropertiesMedicalItem':
      case 'ItemPropertiesPainkiller':
      case 'ItemPropertiesStim':
      case 'ItemPropertiesSurgicalKit':
        push(rows, 'Hitpoints', num(p.hitpoints));
        push(rows, 'Uses', num(p.uses));
        push(rows, 'Use time', p.useTime == null ? null : num(p.useTime, 1) + ' s');
        push(rows, 'Max heal per use', num(p.maxHealPerUse));
        push(rows, 'Cures', Array.isArray(p.cures) && p.cures.length ? p.cures.join(', ') : null);
        push(rows, 'Painkiller duration', p.painkillerDuration == null ? null : num(p.painkillerDuration) + ' s');
        push(rows, 'Effects', Array.isArray(p.stimEffects) && p.stimEffects.length ? String(p.stimEffects.length) : null);
        return rows;
      case 'ItemPropertiesContainer':
      case 'ItemPropertiesBackpack':
      case 'ItemPropertiesChestRig':
        push(rows, 'Capacity', p.capacity == null ? null : num(p.capacity) + ' slots');
        if (Array.isArray(p.grids) && p.grids.length) {
          push(rows, 'Grids', p.grids.length + ' (' + p.grids
            .map((g) => (g && g.width) + 'x' + (g && g.height)).join(', ') + ')');
        }
        push(rows, 'Movement', p.speedPenalty ? pctOf(p.speedPenalty) : null);
        push(rows, 'Turn', p.turnPenalty ? pctOf(p.turnPenalty) : null);
        push(rows, 'Ergonomics', p.ergoPenalty ? pctOf(p.ergoPenalty) : null);
        return rows;
      default:
        break;
    }
    // Generic scalar fallback: every number/string/boolean the record carries.
    // Arrays and objects are summarised by length rather than dumped, because a
    // 200-entry allowedItems list is noise in a stat table.
    Object.keys(p).forEach((k) => {
      if (k === 'propertiesType') return;
      const v = p[k];
      if (v == null) return;
      if (typeof v === 'boolean') { push(rows, humanizeKey(k), v ? 'yes' : 'no'); return; }
      if (typeof v === 'number') { push(rows, humanizeKey(k), num(v, 2)); return; }
      if (typeof v === 'string') { push(rows, humanizeKey(k), v); return; }
      if (Array.isArray(v) && v.length) push(rows, humanizeKey(k), v.length + ' entries');
    });
    return rows;
  }

  // ==========================================================================
  // Everything below touches the DOM and only ever runs inside render().
  // ==========================================================================
  // ONE resize listener for the module, ever. render() runs again every time
  // the user navigates back to Items, and a window listener added per render
  // would pin that render's whole closure - the entries array, every row node,
  // the detail pane - in memory for the life of the window, and repaint a list
  // that is no longer on screen. Rebinding just swaps which paint the single
  // listener calls; unbindResize (from the view's destroy) drops it entirely.
  let activeResize = null;
  let resizeBound = false;

  function bindResize(fn) {
    activeResize = fn;
    if (resizeBound || typeof window === 'undefined' || !window.addEventListener) return;
    resizeBound = true;
    window.addEventListener('resize', () => {
      if (typeof activeResize === 'function') activeResize();
    });
  }

  function unbindResize(fn) {
    if (activeResize === fn) activeResize = null;
  }

  // `param` is the deep-link item id from '#/items/<id>' - how the quest,
  // trader and map views hand an item over. Returns a handle so the shell can
  // focus a DIFFERENT item without tearing the whole browser down and losing
  // the search box, the filters and the scroll position.
  function render(mount, ctx, param) {
    const el = ctx.el;
    const clear = ctx.clear;
    const items = ctx.items || {};

    // id is stamped onto the parsed record once, here: every sort and filter
    // downstream works on a flat array, and copying 5,312 objects to add one
    // key would cost more than it buys.
    const entries = Object.keys(items).map((id) => {
      const it = items[id];
      it.id = id;
      return it;
    });

    const state = {
      query: '',
      hb: '',
      types: [],
      sort: 'name',
      selected: null,
      view: entries.slice().sort(compareBy('name')),
    };

    // ---- layout ----
    const wrap = el('div', 'items-wrap');
    const left = el('div', 'items-left');
    const right = el('div', 'items-right');
    wrap.appendChild(left);
    wrap.appendChild(right);
    mount.appendChild(wrap);

    const controls = el('div', 'items-controls');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'items-search';
    search.placeholder = 'Search name or short name...';
    search.spellcheck = false;
    controls.appendChild(search);

    const selRow = el('div', 'items-selects');
    const catSel = document.createElement('select');
    catSel.className = 'items-cat';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All categories';
    catSel.appendChild(allOpt);
    flattenCategoryTree(ctx.categories && ctx.categories.handbookCategories).forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      // three spaces per level: a native <select> cannot nest, so indentation
      // is the only way the tree shape survives into the dropdown
      o.textContent = new Array(c.depth + 1).join('\u00a0\u00a0\u00a0') + c.name;
      catSel.appendChild(o);
    });
    selRow.appendChild(catSel);

    const sortSel = document.createElement('select');
    sortSel.className = 'items-sort';
    SORTS.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label;
      sortSel.appendChild(o);
    });
    selRow.appendChild(sortSel);
    controls.appendChild(selRow);

    const chipBox = el('div', 'items-chips');
    // The long tail of types is noise in a chip row; the useful ones are the
    // big buckets plus noFlea, which is the single most decision-changing tag
    // on an item and would otherwise fall off the end.
    const typeList = distinctTypes(entries).slice(0, 14).map((t) => t.type);
    if (typeList.indexOf('noFlea') < 0) typeList.push('noFlea');
    typeList.forEach((t) => {
      const chip = el('button', 'chip', t);
      chip.type = 'button';
      chip.dataset.type = t;
      chip.addEventListener('click', () => {
        const i = state.types.indexOf(t);
        if (i >= 0) state.types.splice(i, 1); else state.types.push(t);
        chip.classList.toggle('on', state.types.indexOf(t) >= 0);
        recompute();
      });
      chipBox.appendChild(chip);
    });
    controls.appendChild(chipBox);

    const countEl = el('div', 'items-count', '');
    controls.appendChild(countEl);
    left.appendChild(controls);

    // ---- virtualised list ----
    const scroller = el('div', 'items-scroller');
    const inner = el('div', 'items-inner');
    scroller.appendChild(inner);
    left.appendChild(scroller);

    let lastWindow = { start: -1, end: -1 };

    function rowNode(it) {
      const row = el('div', 'item-row' + (state.selected === it.id ? ' selected' : ''));
      row.dataset.id = it.id;
      row.style.height = ROW_H + 'px';

      const icon = document.createElement('img');
      icon.className = 'item-icon';
      icon.loading = 'lazy';
      icon.alt = '';
      const src = ctx.imgUrl('item', it.id);
      if (src) icon.src = src;
      icon.addEventListener('error', () => { icon.style.visibility = 'hidden'; });
      row.appendChild(icon);

      const names = el('div', 'item-names');
      names.appendChild(el('div', 'item-name', it.n || it.id));
      names.appendChild(el('div', 'item-short', it.s || ''));
      row.appendChild(names);

      // Two unlabelled numbers in a row would be ambiguous - and on a
      // flea-banned preset the pair reads as "banned / 256,237" until you know
      // the second line is a trader, so both carry a tooltip.
      const money = el('div', 'item-money');
      let flea;
      if (it.flea && Number.isFinite(Number(it.flea.avg))) {
        flea = el('div', 'item-flea', ctx.formatRub(it.flea.avg));
        flea.title = 'flea market average';
      } else {
        flea = el('div', 'item-flea banned', 'banned');
        flea.title = 'banned from the flea market';
      }
      money.appendChild(flea);
      const bs = bestSell(it);
      const sell = el('div', 'item-sell', bs ? ctx.formatRub(bs.rub) : '');
      if (bs) sell.title = 'best trader sell: ' + traderName(bs.t);
      money.appendChild(sell);
      row.appendChild(money);

      row.addEventListener('click', () => select(it.id));
      return row;
    }

    function paint(force) {
      const w = windowRange(scroller.scrollTop, ROW_H, scroller.clientHeight, state.view.length, OVERSCAN);
      if (!force && w.start === lastWindow.start && w.end === lastWindow.end) return;
      lastWindow = w;
      clear(inner);
      inner.style.paddingTop = w.padTop + 'px';
      inner.style.paddingBottom = w.padBottom + 'px';
      for (let i = w.start; i < w.end; i++) inner.appendChild(rowNode(state.view[i]));
    }

    let painting = false;
    scroller.addEventListener('scroll', () => {
      if (painting) return;
      painting = true;
      window.requestAnimationFrame(() => { painting = false; paint(false); });
    });

    function recompute() {
      const filtered = filterItems(entries, { hb: state.hb, types: state.types });
      const q = state.query.trim();
      // A query owns the order: relevance beats whatever the sort box says,
      // because a name search that returns the right item in position 40 is a
      // search that did not work.
      state.view = q ? searchItems(filtered, q) : sortItems(filtered, state.sort);
      countEl.textContent = state.view.length + ' of ' + entries.length + ' items'
        + (q ? ' (ranked by match)' : '');
      sortSel.disabled = !!q;
      scroller.scrollTop = 0;
      lastWindow = { start: -1, end: -1 };
      paint(true);
    }

    let searchTimer = null;
    search.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      // 5,312 items is fast enough to filter per keystroke, but not fast enough
      // to also rebuild the DOM per keystroke while someone is typing.
      searchTimer = setTimeout(() => { state.query = search.value; recompute(); }, 90);
    });
    catSel.addEventListener('change', () => { state.hb = catSel.value; recompute(); });
    sortSel.addEventListener('change', () => { state.sort = sortSel.value; recompute(); });
    const onResize = () => paint(true);
    bindResize(onResize);

    // ---- detail pane ----
    // Both of these are big (3.4 MB of properties, 800 KB of descriptions) and
    // neither is needed to browse, so they are pulled on the FIRST detail view
    // and cached by the shell's loader from then on.
    // Both cached for the life of THIS render, and both re-tried on the next
    // detail view if the read came back empty - see makeRetryingLoader.
    let barterIndex = null;
    const ensureProps = makeRetryingLoader(
      (n) => ctx.loadJson(n), 'wiki/item-props.json', ctx.forgetJson);
    const ensureDesc = makeRetryingLoader(
      (n) => ctx.loadJson(n), 'wiki/items-desc.json', ctx.forgetJson);

    function ensureBarters() {
      if (barterIndex) return barterIndex;
      const out = {};
      const uses = {};
      (ctx.barters || []).forEach((b) => {
        if (!b) return;
        const o = b.out && b.out.item;
        if (o) (out[o] = out[o] || []).push(b);
        (Array.isArray(b.req) ? b.req : []).forEach((r) => {
          if (r && r.item) (uses[r.item] = uses[r.item] || []).push(b);
        });
      });
      barterIndex = { out, uses };
      return barterIndex;
    }

    function traderName(id) {
      const t = ctx.traderById && ctx.traderById[id];
      return (t && t.name) || 'Unknown trader';
    }

    function itemName(id) {
      const it = items[id];
      return (it && it.n) || id;
    }

    function section(title) {
      const s = el('section', 'detail-section');
      s.appendChild(el('h3', null, title));
      return s;
    }

    function table(rows) {
      const t = el('table', 'stat-table');
      const body = document.createElement('tbody');
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        tr.appendChild(el('th', null, r.k));
        tr.appendChild(el('td', null, r.v));
        body.appendChild(tr);
      });
      t.appendChild(body);
      return t;
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
      if (count && count > 1) d.appendChild(el('span', 'mini-count', 'x' + count));
      d.addEventListener('click', () => { if (items[id]) select(id); });
      return d;
    }

    function select(id) {
      state.selected = id;
      // repaint the visible window so the selected row highlights
      paint(true);
      renderDetail(id);
    }

    function renderDetail(id) {
      const it = items[id];
      clear(right);
      if (!it) {
        right.appendChild(el('div', 'detail-empty', 'Pick an item.'));
        return;
      }

      const head = el('div', 'detail-head');
      const big = document.createElement('img');
      big.className = 'detail-img';
      big.alt = '';
      const big512 = ctx.imgUrl('item512', id);
      if (big512) big.src = big512;
      // 512px art is fetched on demand and may simply not exist; the small
      // icon is always there, so fall back to it rather than to a broken image.
      big.addEventListener('error', () => {
        const small = ctx.imgUrl('item', id);
        if (small && big.src !== small) big.src = small;
        else big.style.visibility = 'hidden';
      });
      head.appendChild(big);

      const headText = el('div', 'detail-headtext');
      headText.appendChild(el('h2', null, it.n || id));
      headText.appendChild(el('div', 'detail-short', it.s || ''));
      const facts = el('div', 'detail-facts');
      facts.appendChild(el('span', null, (it.w || 1) + 'x' + (it.h || 1) + ' slots'));
      facts.appendChild(el('span', null, ctx.formatWeight(it.wt)));
      if (Number(it.stack) > 1) facts.appendChild(el('span', null, 'stacks to ' + it.stack));
      if (Number.isFinite(Number(it.base))) facts.appendChild(el('span', null, 'base ' + ctx.formatRub(it.base)));
      headText.appendChild(facts);
      if (it.wiki) {
        const btn = el('button', 'wiki-btn', 'Open wiki page');
        btn.type = 'button';
        btn.addEventListener('click', () => {
          if (ctx.api && ctx.api.openExternal) ctx.api.openExternal(it.wiki);
        });
        headText.appendChild(btn);
      }
      head.appendChild(headText);
      right.appendChild(head);

      const descEl = el('p', 'detail-desc', '');
      right.appendChild(descEl);
      ensureDesc().then((all) => {
        if (state.selected !== id) return; // the user has moved on
        const d = all && all[id];
        descEl.textContent = d ? String(d) : '';
      });

      // ---- flea ----
      const flea = section('Flea market');
      if (it.flea) {
        const f = it.flea;
        const rows = [];
        push(rows, 'Average', ctx.formatRub(f.avg));
        push(rows, 'Lowest listed', Number.isFinite(Number(f.low)) ? ctx.formatRub(f.low) : null);
        push(rows, '24h range', (Number.isFinite(Number(f.l24)) && Number.isFinite(Number(f.h24)))
          ? ctx.formatRub(f.l24) + ' - ' + ctx.formatRub(f.h24) : null);
        push(rows, '48h change', Number.isFinite(Number(f.ch48)) ? ctx.formatPct(f.ch48) : null);
        push(rows, 'Per slot', perSlotText(it, ctx.formatRub));
        push(rows, 'Requires level', Number.isFinite(Number(f.minLvl)) ? String(f.minLvl) : null);
        push(rows, 'Last scan', ctx.ago(f.scanned));
        flea.appendChild(table(rows));
      } else {
        flea.appendChild(el('p', 'muted', 'Banned from the flea market.'));
      }
      right.appendChild(flea);

      // ---- buy from ----
      const buys = Array.isArray(it.buy) ? it.buy : [];
      if (buys.length) {
        const s = section('Buy from');
        const t = el('table', 'trade-table');
        const body = document.createElement('tbody');
        buys.slice().sort((a, b) => (Number(a.rub) || 0) - (Number(b.rub) || 0)).forEach((b) => {
          const tr = document.createElement('tr');
          tr.appendChild(el('td', null, traderName(b.t) + ' LL' + (b.lvl || 1)));
          const price = el('td', null, ctx.formatCurrency(b.price, b.cur)
            + (String(b.cur || 'RUB').toUpperCase() === 'RUB' ? '' : ' (' + ctx.formatRub(b.rub) + ')'));
          tr.appendChild(price);
          const notes = [];
          // a task-locked offer is not an offer until the task is done, so it
          // must never read as an available price
          if (b.task) notes.push('task locked');
          if (Number(b.limit) > 0) notes.push('limit ' + b.limit);
          tr.appendChild(el('td', 'muted', notes.join(' - ')));
          body.appendChild(tr);
        });
        t.appendChild(body);
        s.appendChild(t);
        right.appendChild(s);
      }

      // ---- sell to ----
      const sells = (Array.isArray(it.sell) ? it.sell : []).slice()
        .sort((a, b) => (Number(b.rub) || 0) - (Number(a.rub) || 0)).slice(0, 3);
      if (sells.length) {
        const s = section('Sell to (best 3)');
        const t = el('table', 'trade-table');
        const body = document.createElement('tbody');
        sells.forEach((x) => {
          const tr = document.createElement('tr');
          tr.appendChild(el('td', null, traderName(x.t)));
          tr.appendChild(el('td', null, ctx.formatRub(x.rub)));
          body.appendChild(tr);
        });
        t.appendChild(body);
        s.appendChild(t);
        right.appendChild(s);
      }

      // ---- barters ----
      const bi = ensureBarters();
      const forIt = bi.out[id] || [];
      if (forIt.length) {
        const s = section('Barter for it');
        forIt.slice(0, 10).forEach((b) => {
          const line = el('div', 'barter-line');
          line.appendChild(el('div', 'barter-head',
            traderName(b.trader) + ' LL' + (b.minTraderLevel || 1)
            + (b.taskUnlock ? ' - task locked' : '')));
          const reqs = el('div', 'barter-reqs');
          (b.req || []).forEach((r) => reqs.appendChild(miniItem(r.item, r.count)));
          line.appendChild(reqs);
          s.appendChild(line);
        });
        right.appendChild(s);
      }
      const usedIn = bi.uses[id] || [];
      if (usedIn.length) {
        const s = section('Used in barters (' + usedIn.length + ')');
        const list = el('div', 'barter-uses');
        usedIn.slice(0, 12).forEach((b) => list.appendChild(miniItem(b.out && b.out.item, b.out && b.out.count)));
        s.appendChild(list);
        right.appendChild(s);
      }

      // ---- stats ----
      const statsSection = section('Stats');
      const statsBody = el('div', 'stats-body', 'loading...');
      statsSection.appendChild(statsBody);
      right.appendChild(statsSection);
      ensureProps().then((all) => {
        if (state.selected !== id) return;
        const rows = propRows(all && all[id]);
        clear(statsBody);
        if (!rows.length) {
          statsBody.appendChild(el('p', 'muted', 'No extra stats for this item.'));
          return;
        }
        statsBody.appendChild(table(rows));
      });
    }

    // Bring a deep-linked row into view. The list is virtualised, so "scroll to
    // it" means arithmetic on its index, not an element that exists yet.
    function focus(id) {
      if (!id || !items[id]) return false;
      let idx = -1;
      for (let i = 0; i < state.view.length; i++) {
        if (state.view[i].id === id) { idx = i; break; }
      }
      if (idx < 0) {
        // it is filtered out - clear the filters rather than silently doing
        // nothing, because the caller asked for THIS item
        state.query = '';
        state.hb = '';
        state.types = [];
        search.value = '';
        catSel.value = '';
        Array.prototype.forEach.call(chipBox.children, (c) => c.classList.remove('on'));
        recompute();
        for (let i = 0; i < state.view.length; i++) {
          if (state.view[i].id === id) { idx = i; break; }
        }
      }
      if (idx >= 0) {
        // a third of a viewport of context above the row beats pinning it to
        // the very top edge
        scroller.scrollTop = Math.max(0, (idx * ROW_H) - Math.floor(scroller.clientHeight / 3));
        lastWindow = { start: -1, end: -1 };
      }
      select(id);
      return true;
    }

    // ---- first paint ----
    sortSel.value = state.sort;
    right.appendChild(el('div', 'detail-empty', 'Pick an item.'));
    recompute();
    if (param) focus(param);

    // destroy is called by the shell when this view is unmounted, so the one
    // shared resize listener stops calling into a DOM that is no longer there.
    return { focus, destroy: () => unbindResize(onResize) };
  }

  return {
    ROW_H,
    OVERSCAN,
    SORTS,
    matchRank,
    compareSearch,
    searchItems,
    matchesFilters,
    filterItems,
    distinctTypes,
    fleaAvg,
    perSlotValue,
    perSlotText,
    makeRetryingLoader,
    bindResize,
    unbindResize,
    resizeBindings: () => ({ bound: resizeBound, active: activeResize }),
    bestSell,
    compareBy,
    sortItems,
    windowRange,
    flattenCategoryTree,
    humanizeKey,
    prettyCaliber,
    propRows,
    render,
  };
}));
