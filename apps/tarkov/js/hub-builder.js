// Island Tarkov hub - the Weapon Builder.
//
// Tarkov's own "Edit build" screen, flattened to 2D: the gun in the middle,
// one box per slot around it with a wire back to the part of the gun it
// belongs to, a picker that only offers parts the game itself would accept in
// that slot (item-props.json `slots[].filters.allowedItems`, straight from the
// game data), and an info strip under the diagram that says where the
// selected part is actually sold - trader + loyalty level, flea, or barter.
//
// Loaded like every other hub view: as a plain <script> in the page and via
// require() from scripts/smoke-builder.mjs. EVERY DOM touch lives behind
// render(); the section above it is pure and is what the smoke exercises.
//
// Data it leans on:
//   ctx.items       items.json (names, size, weight, prices, flea)
//   ctx.itemProps   item-props.json (slot tree, ergo/recoil, presets list)
//   ctx.builderData builder.json (factory preset part lists + conflict pairs;
//                   may be null - the builder still works, presets are off)
//   ctx.builderArt  builder-art.json (where each preset render puts each part:
//                   crop boxes + poses in px8x). May be null or missing an
//                   entry for any part - the stage then draws the closest
//                   preset's own picture, which still always shows the gun.
//   PilotKit.buildOfferIndex  the cheapest source per item, reused verbatim
//                   from the kit optimizer so the two tabs can never disagree
//                   about a price.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubBuilder = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The web bundle has PilotKit / PilotHubKit as globals (kit.js and hub-kit.js
  // load before this file); the node smoke sets the same globals before
  // requiring this module. Resolved lazily so load order never matters.
  function kit() { return (typeof globalThis !== 'undefined' && globalThis.PilotKit) || null; }
  function hubKit() { return (typeof globalThis !== 'undefined' && globalThis.PilotHubKit) || null; }
  function hubItems() { return (typeof globalThis !== 'undefined' && globalThis.PilotHubItems) || null; }

  const STORE_KEY = 'island.tarkov.builds.v1';
  const LAST_KEY = 'island.tarkov.builder.last.v1';
  const MAX_SAVED = 60;
  const ID_RE = /^[0-9a-f]{24}$/;
  // Colt M4A1 5.56x45 assault rifle - what the screen opens on when there is
  // no link and no remembered build. Guarded by isGun() at the call site, so a
  // data drop that loses it falls back to the weapon picker instead of erroring.
  const DEFAULT_GUN = '5447a9cd4bdc2dbd208b4567';
  // The game draws every weapon muzzle-LEFT, and so do tarkov.dev's preset
  // renders - which is what this stage paints. So the DEFAULT is no mirror at
  // all: out of the box the weapon already points the way the game points it.
  // FLIP exists for anyone who wants the other hand; it mirrors the finished
  // canvas horizontally and mirrors every marker/card x with it. Nothing in
  // these renders is text, so a mirrored picture is honest apart from one thing
  // worth knowing: you are then looking at the weapon's other side reversed.
  // (Round 2 shipped this inverted - default true - which put every weapon
  // muzzle-RIGHT on a fresh profile. The stored boolean now means what its
  // name says: true = mirrored = NOT the game's orientation.)
  const MIRROR_KEY = 'island.tarkov.builder.mirror';
  // DISCOVERED 2026-09-11, round 4. builder-art.json's poses ARE in the -512
  // render's own space - that half has always agreed with itself, which is why
  // the composite lands a suppressor on the muzzle. What did NOT agree is the
  // ANCHORS table below: it was written muzzle-RIGHT ("x 0 = stock end, 1 =
  // muzzle end") while the renders are drawn muzzle-LEFT, and it is the
  // FALLBACK for every slot the art could not locate - which on a stock M4A1 is
  // most of them. So the flip belongs on the fallback, not on the poses.
  // Round 2 hid all of this by mirroring the whole canvas AND every marker
  // together: they agreed with each other, at the cost of facing the weapon the
  // wrong way on a fresh profile.
  const POSE_FLIP = false;
  const ANCHOR_FLIP = true;

  // ==========================================================================
  // PURE: slot names, anchors, rails
  // ==========================================================================

  // The game's slot ids are mod_reciever / mod_charge / camora_000. These are
  // the words a player reads on the modding screen.
  const SLOT_LABELS = {
    scope: 'Scope', muzzle: 'Muzzle', mount: 'Mount', foregrip: 'Foregrip',
    tactical: 'Tactical', stock: 'Stock', sight_front: 'Front sight',
    sight_rear: 'Rear sight', magazine: 'Magazine', pistol_grip: 'Pistol grip',
    reciever: 'Receiver', barrel: 'Barrel', handguard: 'Handguard', gas_block: 'Gas block',
    charge: 'Charging handle', bipod: 'Bipod', launcher: 'Launcher', nvg: 'NVG',
    trigger: 'Trigger', hammer: 'Hammer', catch: 'Catch', flashlight: 'Flashlight',
    equipment: 'Equipment', camora: 'Chamber',
  };

  // mod_mount_003 -> mount, camora_002 -> camora, mod_stock_akms -> stock
  function slotKey(nameId) {
    const s = String(nameId || '').toLowerCase().replace(/^mod_/, '').replace(/_\d+$/, '');
    const prefixes = ['pistol', 'stock', 'mount', 'tactical', 'charge', 'camora', 'equipment', 'scope',
      'muzzle', 'sight_front', 'sight_rear', 'magazine', 'foregrip', 'handguard', 'barrel', 'reciever', 'gas_block', 'launcher', 'bipod', 'nvg'];
    for (let i = 0; i < prefixes.length; i++) {
      if (s.indexOf(prefixes[i]) === 0) return prefixes[i] === 'pistol' ? 'pistol_grip' : prefixes[i];
    }
    return s;
  }

  function slotLabel(nameId, fallbackName) {
    const raw = String(nameId || '');
    const key = slotKey(raw);
    const base = SLOT_LABELS[key];
    const m = raw.match(/_(\d+)$/);
    const n = m ? Number(m[1]) + 1 : null;
    if (base) return n != null ? base + ' ' + n : base;
    if (fallbackName) return String(fallbackName);
    return raw.replace(/^mod_/, '').replace(/_/g, ' ');
  }

  // Where on the gun picture a slot's wire lands, as a fraction of the drawn
  // image: x 0 = stock end, 1 = muzzle end; y 0 = top. One generic rifle
  // silhouette - tarkov.dev renders every gun muzzle-right, so this holds for
  // pistols and shotguns too, just less exactly.
  const ANCHORS = {
    muzzle: [0.97, 0.45], barrel: [0.80, 0.45], gas_block: [0.72, 0.40], handguard: [0.65, 0.50],
    sight_front: [0.78, 0.30], scope: [0.50, 0.25], mount: [0.55, 0.28], nvg: [0.45, 0.20],
    reciever: [0.50, 0.42], sight_rear: [0.40, 0.30], charge: [0.33, 0.38], stock: [0.08, 0.45],
    magazine: [0.47, 0.75], pistol_grip: [0.33, 0.72], foregrip: [0.62, 0.68], tactical: [0.68, 0.62],
    bipod: [0.70, 0.70], launcher: [0.60, 0.72], trigger: [0.36, 0.60], hammer: [0.36, 0.60],
    catch: [0.36, 0.60], flashlight: [0.68, 0.62], camora: [0.45, 0.50], equipment: [0.50, 0.50],
  };
  const DEFAULT_ANCHOR = [0.50, 0.50];

  const RAIL_OF = {
    scope: 'top', mount: 'top', sight_front: 'top', sight_rear: 'top', nvg: 'top', reciever: 'top',
    gas_block: 'top', camora: 'top',
    magazine: 'bottom', pistol_grip: 'bottom', foregrip: 'bottom', tactical: 'bottom', bipod: 'bottom',
    launcher: 'bottom', trigger: 'bottom', hammer: 'bottom', catch: 'bottom', flashlight: 'bottom',
    stock: 'left', charge: 'left',
    muzzle: 'right', barrel: 'right', handguard: 'right', equipment: 'right',
  };

  function anchorFor(nameId) { return ANCHORS[slotKey(nameId)] || DEFAULT_ANCHOR; }
  function railFor(nameId) { return RAIL_OF[slotKey(nameId)] || 'right'; }

  // ==========================================================================
  // PURE: data expansion
  // ==========================================================================

  // builder.json is written compact (an id table + index pairs); this is the
  // one place that knows about that. null in -> empty out, never a throw: the
  // builder must still open when the file is missing.
  function expandBuilderData(doc) {
    const out = { presets: new Map(), presetsByGun: new Map(), conflicts: new Map(), ok: false };
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.ids)) return out;
    const ids = doc.ids;
    const id = (i) => (typeof ids[i] === 'string' ? ids[i] : null);
    Object.keys(doc.presets || {}).forEach((pid) => {
      const p = doc.presets[pid];
      const base = p && id(p.base);
      if (!base) return;
      const parts = [];
      (Array.isArray(p.parts) ? p.parts : []).forEach((pair) => {
        const it = Array.isArray(pair) ? id(pair[0]) : null;
        if (it) parts.push([it, Math.max(1, Number(pair[1]) || 1)]);
      });
      out.presets.set(pid, { base, parts });
      if (!out.presetsByGun.has(base)) out.presetsByGun.set(base, []);
      out.presetsByGun.get(base).push(pid);
    });
    (Array.isArray(doc.pairs) ? doc.pairs : []).forEach((pair) => {
      if (!Array.isArray(pair)) return;
      const a = id(pair[0]), b = id(pair[1]);
      if (!a || !b) return;
      if (!out.conflicts.has(a)) out.conflicts.set(a, new Set());
      if (!out.conflicts.has(b)) out.conflicts.set(b, new Set());
      out.conflicts.get(a).add(b);
      out.conflicts.get(b).add(a);
    });
    out.ok = true;
    return out;
  }

  function isGun(props, id) {
    const p = props && typeof id === 'string' && props[id];
    return !!(p && p.propertiesType === 'ItemPropertiesWeapon' && Array.isArray(p.slots) && p.slots.length);
  }

  function listGuns(items, props) {
    const out = [];
    Object.keys(props || {}).forEach((id) => {
      if (!isGun(props, id)) return;
      if (!items || !items[id]) return;
      out.push(id);
    });
    out.sort((a, b) => String(items[a].n || '').localeCompare(String(items[b].n || '')));
    return out;
  }

  // ==========================================================================
  // PURE: the slot tree
  // ==========================================================================

  // Chambered rounds are ammo, not attachments; the builder is about the gun.
  function hiddenSlot(nameId) { return slotKey(nameId) === 'camora'; }

  // Depth-first list of every slot that exists RIGHT NOW: the gun's own slots,
  // then, for each fitted part, that part's slots - a foregrip slot only exists
  // while a handguard that has one is mounted, exactly as in-game. Paths are
  // parent nameIds joined with '/', so mod_mount under two different scopes
  // never collides.
  function slotTree(props, gunId, fitted) {
    const out = [];
    const map = fitted || new Map();
    function walk(holderId, prefix, depth) {
      if (depth > 8) return;
      const p = props && props[holderId];
      const slots = (p && Array.isArray(p.slots)) ? p.slots : [];
      slots.forEach((s) => {
        if (!s || !s.nameId || hiddenSlot(s.nameId)) return;
        const path = prefix ? prefix + '/' + s.nameId : s.nameId;
        const allowed = (s.filters && Array.isArray(s.filters.allowedItems)) ? s.filters.allowedItems : [];
        const item = map.get(path) || null;
        out.push({
          path, parentPath: prefix || null, nameId: s.nameId, name: s.name || '',
          required: !!s.required, allowed, item, depth, holder: holderId,
        });
        if (item) walk(item, path, depth + 1);
      });
    }
    if (gunId) walk(gunId, '', 0);
    return out;
  }

  function nodeAt(tree, path) {
    for (let i = 0; i < tree.length; i++) if (tree[i].path === path) return tree[i];
    return null;
  }

  // Drop anything the tree no longer supports: a key whose slot vanished (its
  // holder was removed or swapped) or whose item the new holder's slot does not
  // accept. Loops because a drop can orphan grandchildren.
  function revalidate(props, gunId, fitted) {
    let map = new Map(fitted || []);
    for (let guard = 0; guard < 32; guard++) {
      const tree = slotTree(props, gunId, map);
      const valid = new Set();
      tree.forEach((n) => { if (n.item && n.allowed.indexOf(n.item) >= 0) valid.add(n.path); });
      let changed = false;
      const next = new Map();
      map.forEach((v, k) => { if (valid.has(k)) next.set(k, v); else changed = true; });
      map = next;
      if (!changed) break;
    }
    return map;
  }

  // Set or clear one slot and return the NEW map (the old one is untouched, so
  // undo is a matter of keeping the previous reference).
  function fit(props, gunId, fitted, path, itemId) {
    const map = new Map(fitted || []);
    if (itemId) map.set(path, itemId); else map.delete(path);
    return revalidate(props, gunId, map);
  }

  // Everything fitted that the candidate refuses to sit next to (both
  // directions are in the map already). The gun itself counts as fitted.
  function conflictsOf(conflicts, gunId, fitted, candidate) {
    const set = conflicts && conflicts.get(candidate);
    if (!set || !set.size) return [];
    const out = [];
    if (gunId && set.has(gunId)) out.push(gunId);
    (fitted || new Map()).forEach((v) => { if (set.has(v) && out.indexOf(v) < 0) out.push(v); });
    return out;
  }

  // The picker's list for one slot: every allowed item the site knows, with the
  // fitted parts it would clash with (empty = fits cleanly).
  function compatible(node, items, conflicts, gunId, fitted) {
    const out = [];
    if (!node) return out;
    // the slot's current occupant (and anything hanging off it) never
    // conflicts with a replacement - they leave together
    const others = new Map();
    (fitted || new Map()).forEach((v, k) => {
      if (k === node.path || k.indexOf(node.path + '/') === 0) return;
      others.set(k, v);
    });
    node.allowed.forEach((id) => {
      if (!items || !items[id]) return;
      out.push({ id, conflicts: conflictsOf(conflicts, gunId, others, id) });
    });
    return out;
  }

  // How many of the still-unplaced parts this candidate could carry in its
  // own slots. A scope slot accepts both the scope and the spacer the scope
  // is meant to sit on; the spacer scores 1, the scope 0, so the spacer goes
  // in first and the scope lands on it - the order the game itself uses.
  function carryScore(props, id, left, except) {
    const p = props && props[id];
    if (!p || !Array.isArray(p.slots)) return 0;
    let score = 0;
    p.slots.forEach((s) => {
      const allowed = (s && s.filters && Array.isArray(s.filters.allowedItems)) ? s.filters.allowedItems : [];
      for (let i = 0; i < allowed.length; i++) {
        if (allowed[i] !== except && (left.get(allowed[i]) || 0) > 0) { score++; break; }
      }
    });
    return score;
  }

  // Greedy placement of a flat parts list (factory preset, share link, saved
  // build). Walk the current tree; in each empty slot put the unplaced part it
  // accepts that can carry the most other unplaced parts (ties: list order);
  // re-walk after every placement (a fitted part opens new slots); stop when
  // nothing moves.
  function placeParts(props, gunId, parts) {
    const left = new Map();
    (parts || []).forEach((p) => {
      const id = Array.isArray(p) ? p[0] : p;
      const n = Array.isArray(p) ? Math.max(1, Number(p[1]) || 1) : 1;
      if (typeof id === 'string' && id) left.set(id, (left.get(id) || 0) + n);
    });
    const fitted = new Map();
    for (let guard = 0; guard < 200; guard++) {
      let moved = false;
      const tree = slotTree(props, gunId, fitted);
      for (let i = 0; i < tree.length && !moved; i++) {
        const n = tree[i];
        if (n.item) continue;
        let best = null, bestScore = -1;
        for (let j = 0; j < n.allowed.length; j++) {
          const id = n.allowed[j];
          if ((left.get(id) || 0) <= 0) continue;
          const sc = carryScore(props, id, left, id);
          if (sc > bestScore) { best = id; bestScore = sc; }
        }
        if (!best) continue;
        fitted.set(n.path, best);
        const c = left.get(best);
        if (c === 1) left.delete(best); else left.set(best, c - 1);
        moved = true;
      }
      if (!moved) break;
    }
    const unplaced = [];
    left.forEach((n, id) => unplaced.push([id, n]));
    return { fitted, unplaced };
  }

  // ==========================================================================
  // PURE: stats, preset matching
  // ==========================================================================

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function firstNum(a, b) { return a != null ? num(a, null) : (b != null ? num(b, null) : null); }

  function buildStats(items, props, gunId, fitted, offers) {
    const g = (props && props[gunId]) || {};
    const gi = (items && items[gunId]) || {};
    let ergo = num(g.ergonomics, 0);
    let recoilMod = 0;
    let weight = num(gi.wt, 0);
    let cost = 0;
    const unpriced = [];
    let parts = 0;
    const get = (id) => (offers && typeof offers.get === 'function') ? offers.get(id) : null;
    const gunOffer = get(gunId);
    if (gunOffer) cost += num(gunOffer.rub, 0); else if (gunId) unpriced.push(gunId);
    (fitted || new Map()).forEach((id) => {
      const p = (props && props[id]) || {};
      const it = (items && items[id]) || {};
      ergo += num(p.ergonomics, 0);
      recoilMod += num(p.recoilModifier, 0);
      weight += num(it.wt, 0);
      const o = get(id);
      if (o) cost += num(o.rub, 0); else unpriced.push(id);
      parts++;
    });
    const rv = num(g.recoilVertical, 0), rh = num(g.recoilHorizontal, 0);
    // the gun's own default* fields are null for every weapon in the data;
    // the factory default preset (a real item) carries the reference numbers
    const dp = (g.defaultPreset && props && props[g.defaultPreset]) || {};
    const dIt = (g.defaultPreset && items && items[g.defaultPreset]) || {};
    return {
      ergo: Math.round(ergo),
      recoilV: Math.round(rv * (1 + recoilMod)),
      recoilH: Math.round(rh * (1 + recoilMod)),
      recoilMod,
      weight: Math.round(weight * 100) / 100,
      cost, unpriced, parts,
      caliber: g.caliber || '', fireRate: g.fireRate || null,
      defaultErgo: firstNum(dp.ergonomics, g.defaultErgonomics),
      defaultRecoilV: firstNum(dp.recoilVertical, g.defaultRecoilVertical),
      defaultRecoilH: firstNum(dp.recoilHorizontal, g.defaultRecoilHorizontal),
      defaultWeight: firstNum(dIt.wt, g.defaultWeight),
    };
  }

  function unplacedCount(unplaced) {
    let n = 0;
    (unplaced || []).forEach((u) => { n += Math.max(1, num(u[1], 1)); });
    return n;
  }
  function multisetKey(ids) {
    const c = {};
    (ids || []).forEach((id) => { c[id] = (c[id] || 0) + 1; });
    return Object.keys(c).sort().map((k) => k + 'x' + c[k]).join('|');
  }

  // The preset whose part list is EXACTLY what is fitted - that is the picture
  // to show. Anything else shows the bare gun (there is no per-part art).
  function matchPreset(data, gunId, fitted) {
    if (!data || !data.presetsByGun) return null;
    const list = data.presetsByGun.get(gunId) || [];
    const want = multisetKey([...(fitted || new Map()).values()]);
    for (let i = 0; i < list.length; i++) {
      const p = data.presets.get(list[i]);
      const have = [];
      (p.parts || []).forEach((pair) => { for (let k = 0; k < pair[1]; k++) have.push(pair[0]); });
      if (multisetKey(have) === want) return list[i];
    }
    return null;
  }

  // ==========================================================================
  // PURE: the composite picture
  // ==========================================================================
  //
  // tarkov.dev has art for GUNS and for factory PRESETS, never for "this gun
  // with your parts on it". The old code only showed a preset when the fitted
  // multiset matched one exactly, and fell back to the base item otherwise -
  // and the base item of an M4A1 is the bare 1x1 lower receiver, so one
  // swapped part made the whole gun disappear. So instead: always start from
  // the CLOSEST preset (the gun is then always in the picture), and, when
  // builder-art.json is present, erase the preset parts the build does not
  // have and paint the ones it does.

  function pathParent(path) { const s = String(path || ''); const i = s.lastIndexOf('/'); return i < 0 ? null : s.slice(0, i); }
  function pathName(path) { const s = String(path || ''); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); }

  // tarkov.dev renders every item at 8x its inventory grid: a w x h item is
  // (w*63+1)*8 by (h*63+1)*8 px. builder-art.json records every pose in those
  // "px8x" units, and the -512.webp is that same image scaled down uniformly,
  // so this is the only unit conversion the picture needs.
  function imageSize8x(items, id) {
    const it = (items && items[id]) || {};
    const w = Math.max(1, num(it.w, 1)), h = Math.max(1, num(it.h, 1));
    return { w: (w * 63 + 1) * 8, h: (h * 63 + 1) * 8 };
  }

  // ...except for ~1% of items (MPX-SD barrel, SA58 receiver, SR-2M handguard)
  // whose tarkov.dev render is WIDER than their inventory grid. The recorded
  // crop / preset bbox is a hard lower bound on the real image, so widen to it
  // rather than squashing the overlay into a box the art never fit in.
  function artSize8x(art, items, id) {
    const s = imageSize8x(items, id);
    const c = art && art.items && art.items[id] && art.items[id].crop;
    if (Array.isArray(c) && c.length === 4) return { w: Math.max(s.w, num(c[2], 0)), h: Math.max(s.h, num(c[3], 0)) };
    return s;
  }
  function frameSize8x(art, items, pid) {
    const s = imageSize8x(items, pid);
    const A = art && art.presets && art.presets[pid];
    const b = A && A.bbox;
    if (Array.isArray(b) && b.length === 4) return { w: Math.max(s.w, num(b[2], 0)), h: Math.max(s.h, num(b[3], 0)) };
    return s;
  }

  function multisetOverlap(a, b) {
    const c = {};
    (a || []).forEach((id) => { c[id] = (c[id] || 0) + 1; });
    let n = 0;
    (b || []).forEach((id) => { if (c[id] > 0) { c[id]--; n++; } });
    return n;
  }

  // builder.json is the authority on what a preset holds; builder-art.json's
  // own parts list is the fallback so the picture still works if only the art
  // file is around.
  function presetPartList(data, art, pid, gunId) {
    const out = [];
    const d = (data && data.presets && typeof data.presets.get === 'function') ? data.presets.get(pid) : null;
    if (d) {
      (d.parts || []).forEach((pair) => { for (let i = 0; i < pair[1]; i++) out.push(pair[0]); });
      return out;
    }
    const a = art && art.presets && art.presets[pid];
    if (a && Array.isArray(a.parts)) a.parts.forEach((p) => { if (p && typeof p.id === 'string' && p.id !== gunId) out.push(p.id); });
    return out;
  }

  function presetIdsFor(data, props, art, gunId) {
    const seen = {};
    const out = [];
    const push = (pid) => { if (pid && !seen[pid]) { seen[pid] = 1; out.push(pid); } };
    const byGun = (data && data.presetsByGun && typeof data.presetsByGun.get === 'function') ? (data.presetsByGun.get(gunId) || []) : [];
    byGun.forEach(push);
    const p = (props && props[gunId]) || {};
    (Array.isArray(p.presets) ? p.presets : []).forEach((pid) => {
      const inData = data && data.presets && typeof data.presets.has === 'function' && data.presets.has(pid);
      const inArt = art && art.presets && art.presets[pid];
      if (inData || inArt) push(pid);
    });
    return out;
  }

  // The preset the picture is BUILT ON: the one that shares the most parts
  // with what is fitted. Ties go to the factory default, then to the preset
  // with the most parts. Nothing fitted = the player hit Strip, and the bare
  // base item is then the honest picture (that is what the game shows too).
  function referencePreset(data, props, gunId, fitted, art) {
    const map = (fitted instanceof Map) ? fitted : new Map();
    const want = [];
    map.forEach((v) => want.push(v));
    if (!want.length) return null;
    const ids = presetIdsFor(data, props, art, gunId);
    if (!ids.length) return null;
    const def = ((props && props[gunId]) || {}).defaultPreset || null;
    let best = null, bestScore = -1, bestLen = -1;
    ids.forEach((pid) => {
      const parts = presetPartList(data, art, pid, gunId);
      const score = multisetOverlap(parts, want);
      if (score > bestScore) { best = pid; bestScore = score; bestLen = parts.length; return; }
      if (score < bestScore) return;
      if (pid === def) { best = pid; bestLen = parts.length; return; }
      if (best === def) return;
      if (parts.length > bestLen) { best = pid; bestLen = parts.length; }
    });
    return best;
  }

  // Which edge of the gun a slot hangs off. Every tarkov.dev render points the
  // muzzle LEFT, so x grows towards the stock.
  const ART_GROUP = {
    muzzle: 'fwd', barrel: 'fwd', handguard: 'fwd', gas_block: 'fwd',
    stock: 'rear', charge: 'rear',
    scope: 'top', mount: 'top', sight_front: 'top', sight_rear: 'top', nvg: 'top', reciever: 'top',
    magazine: 'bot', pistol_grip: 'bot', foregrip: 'bot', bipod: 'bot', launcher: 'bot',
    trigger: 'bot', hammer: 'bot', catch: 'bot',
    tactical: 'side', flashlight: 'side', equipment: 'side',
  };
  const ART_TOP_X = { sight_rear: 0.85 };
  const ART_BOT_X = { magazine: 0.45, pistol_grip: 0.75, foregrip: 0.35 };
  function artGroup(nameId) { return ART_GROUP[slotKey(nameId)] || 'side'; }

  function poseRect(art, entry) {
    if (!entry) return null;
    const it = art && art.items && art.items[entry.id];
    const crop = (it && Array.isArray(it.crop) && it.crop.length === 4) ? it.crop : null;
    if (!crop) return null;
    const s = num(entry.s, 1);
    const x = num(entry.x, 0), y = num(entry.y, 0);
    return { x0: x + crop[0] * s, y0: y + crop[1] * s, x1: x + crop[2] * s, y1: y + crop[3] * s };
  }
  function rectW(r) { return Math.max(0, r.x1 - r.x0); }
  function rectH(r) { return Math.max(0, r.y1 - r.y0); }

  // The whole picture as data: which preset frame to draw, which of its parts
  // to rub out, and where to paint the ones the build added. `art` and `data`
  // are both optional - with neither, the plan still names the reference
  // preset and how many slots differ, which is all the fallback picture needs.
  function compositePlan(art, props, items, gunId, fitted, data) {
    const out = { presetId: null, changed: 0, erase: [], draw: [], notes: [], missing: 0, tiny: 0, kept: 0, frame: null, extent: null };
    const map = (fitted instanceof Map) ? fitted : new Map();
    const pid = referencePreset(data, props, gunId, map, art);
    out.presetId = pid;
    if (!pid) return out;
    out.frame = frameSize8x(art, items, pid);
    out.extent = { x0: 0, y0: 0, x1: out.frame.w, y1: out.frame.h };

    const parts = presetPartList(data, art, pid, gunId);
    const placed = placeParts(props, gunId, parts).fitted;

    const seen = {};
    const paths = [];
    placed.forEach((v, k) => { if (!seen[k]) { seen[k] = 1; paths.push(k); } });
    map.forEach((v, k) => { if (!seen[k]) { seen[k] = 1; paths.push(k); } });
    const diffs = [];
    paths.forEach((p) => {
      const oldId = placed.get(p) || null;
      const newId = map.get(p) || null;
      if (oldId === newId) return;
      diffs.push({ path: p, oldId, newId });
    });
    out.changed = diffs.length;

    const A = art && art.presets && art.presets[pid];
    if (!A || !art.items || !diffs.length) return out;

    // match each preset part to the slot it sits in; duplicates of the same id
    // are handed out in tree order, which is the order placeParts filled them
    const pool = {};
    (Array.isArray(A.parts) ? A.parts : []).forEach((e) => {
      if (!e || typeof e.id !== 'string') return;
      if (!pool[e.id]) pool[e.id] = [];
      pool[e.id].push(e);
    });
    const used = {};
    function takeEntry(id) {
      const list = pool[id];
      if (!list) return null;
      const i = used[id] || 0;
      if (i >= list.length) return null;
      used[id] = i + 1;
      return list[i];
    }
    const gunRect = poseRect(art, takeEntry(gunId));
    const rectByPath = {};
    const entryByPath = {};
    slotTree(props, gunId, placed).forEach((n) => {
      if (!n.item) return;
      const e = takeEntry(n.item);
      if (!e) return;
      entryByPath[n.path] = e;
      const r = poseRect(art, e);
      if (r) rectByPath[n.path] = r;
    });

    const kP = num(A.k, null);
    const cP = (A.c == null) ? null : num(A.c, null);
    const bb = (Array.isArray(A.bbox) && A.bbox.length === 4)
      ? { x0: num(A.bbox[0], 0), y0: num(A.bbox[1], 0), x1: num(A.bbox[2], 0), y1: num(A.bbox[3], 0) } : null;
    const muzzle = (Array.isArray(A.muzzle) && A.muzzle.length === 2) ? [num(A.muzzle[0], 0), num(A.muzzle[1], 0)] : null;
    let missing = 0;
    let tiny = 0;
    let kept = 0;

    // parents before children, so a scope lands on the mount that carries it
    const orderOf = {};
    slotTree(props, gunId, map).forEach((n, i) => { orderOf[n.path] = i; });
    const adds = diffs.filter((d) => d.newId).slice()
      .sort((a, b) => (orderOf[a.path] == null ? 1e9 : orderOf[a.path]) - (orderOf[b.path] == null ? 1e9 : orderOf[b.path]));

    // a preset part we could not locate in the render cannot be rubbed out, so
    // anything replacing it has to be drawn OVER it instead
    function unerasableAt(p) { return !!(placed.get(p) && !rectByPath[p]); }
    const estOld = 0.08 * (out.frame && out.frame.w > 0 ? out.frame.w : 2528);
    // paths whose change the picture cannot show; nothing under them may be
    // rubbed out either (see the erase pass below)
    const undrawn = {};
    const drawnAt = {};

    adds.forEach((d) => {
      const ai = art.items[d.newId];
      const crop = (ai && Array.isArray(ai.crop) && ai.crop.length === 4) ? ai.crop : null;
      const it = items[d.newId] || {};
      // tarkov.dev renders most 1x1 attachments (flash hiders, gas blocks,
      // charging handles, rails, lights) as three-quarter TILTED hero icons,
      // never side-on - k === null on a 1x1 item is the sync saying "there is
      // no flat picture of this". Pasting the tilted icon onto a side-on gun
      // looks worse than leaving the preset's own part showing.
      if ((!ai || ai.k == null) && Math.max(1, num(it.w, 1)) === 1 && Math.max(1, num(it.h, 1)) === 1) { tiny++; undrawn[d.path] = 1; return; }
      if (!crop) { missing++; undrawn[d.path] = 1; return; }
      const key = slotKey(pathName(d.path));
      const grp = artGroup(pathName(d.path));

      // scale: the two renders share a projection only when their component
      // matches, so k is only comparable inside one component
      const kI = (ai.k == null) ? null : num(ai.k, null);
      const cI = (ai.c == null) ? null : num(ai.c, null);
      let s = null, how = '';
      if (kI != null && kP && cI != null && cP != null && cI === cP) { s = kI / kP; how = 'k'; }
      else if (cP === 0 && kP && art.kDefault && num(art.kDefault[key], null) != null) { s = num(art.kDefault[key], 1) / kP; how = 'kDefault'; }
      if (!(s > 0) || !isFinite(s)) {
        const cw = Math.max(1, crop[2] - crop[0]);
        const ref = bb ? rectW(bb) : (gunRect ? rectW(gunRect) : artSize8x(art, items, d.newId).w);
        s = (0.30 * Math.max(1, ref)) / cw;
        how = 'size';
      }
      s = Math.max(0.02, Math.min(8, s));

      let anchor = null, mode = '';
      if (d.oldId && rectByPath[d.path]) { anchor = rectByPath[d.path]; mode = 'same'; }
      if (!anchor) {
        const hp = pathParent(d.path);
        const hr = hp ? rectByPath[hp] : gunRect;
        if (hr) { anchor = hr; mode = 'holder'; }
      }
      if (!anchor && bb) { anchor = bb; mode = 'bbox'; }
      if (!anchor) { missing++; undrawn[d.path] = 1; return; }

      const cw = (crop[2] - crop[0]) * s;
      const ch = (crop[3] - crop[1]) * s;

      // COVER: the muzzle end is where unerasable parts pile up. An M4A1's
      // factory flash hider never matches (tilted 1x1 icon), so a suppressor
      // hung exactly on the muzzle point would leave the old hider poking out
      // between it and the handguard. Push the new part back over it. Fires
      // when this slot - or any muzzle slot it hangs off - held a preset part
      // we could not erase; not when the slot was simply empty.
      let cover = false;
      if (grp === 'fwd') {
        if (unerasableAt(d.path)) cover = true;
        else {
          let anc = pathParent(d.path);
          while (anc && !cover) {
            if (slotKey(pathName(anc)) === 'muzzle' && unerasableAt(anc)) cover = true;
            anc = pathParent(anc);
          }
        }
      }
      // a gas block sits behind the muzzle, not on it
      const shiftX = cover ? estOld : ((key === 'gas_block' && mode !== 'same') ? 0.20 * rectW(anchor) : 0);
      let left = 0, top = 0;
      const cxA = (anchor.x0 + anchor.x1) / 2, cyA = (anchor.y0 + anchor.y1) / 2;
      if (mode === 'same') {
        if (grp === 'fwd') { left = anchor.x1 - cw; top = cyA - ch / 2; }
        else if (grp === 'rear') { left = anchor.x0; top = cyA - ch / 2; }
        else if (grp === 'top') { left = cxA - cw / 2; top = anchor.y1 - ch; }
        else if (grp === 'bot') { left = cxA - cw / 2; top = anchor.y0; }
        else { left = cxA - cw / 2; top = cyA - ch / 2; }
      } else if (grp === 'fwd') {
        if (mode === 'bbox' && muzzle) { left = muzzle[0] - cw; top = muzzle[1] - ch / 2; }
        else { left = anchor.x0 - cw; top = cyA - ch / 2; }
      } else if (grp === 'rear') {
        left = anchor.x1; top = cyA - ch / 2;
      } else if (grp === 'top') {
        const f = num(ART_TOP_X[key], 0.5);
        left = anchor.x0 + f * rectW(anchor) - cw / 2;
        top = anchor.y0 - ch;
      } else if (grp === 'bot') {
        const f = num(ART_BOT_X[key], 0.5);
        left = anchor.x0 + f * rectW(anchor) - cw / 2;
        top = anchor.y1;
      } else {
        left = anchor.x0 + 0.30 * rectW(anchor) - cw / 2;
        top = anchor.y0 + 0.55 * rectH(anchor) - ch / 2;
      }
      left += shiftX;

      const sz = artSize8x(art, items, d.newId);
      out.draw.push({
        id: d.newId, path: d.path, group: grp, mode, scaleFrom: how, s, cover,
        x: left - crop[0] * s, y: top - crop[1] * s, w: sz.w * s, h: sz.h * s,
        left, top, right: left + cw, bottom: top + ch,
      });
      drawnAt[d.path] = 1;
    });

    // ERASE LAST, and only where a replacement actually landed. Rubbing out a
    // preset part we cannot redraw leaves a HOLE in the gun (a RIS II handguard
    // swap opened a gap between the front sight and the receiver; a Beta C-Mag
    // made the magazine vanish). Leaving the factory part showing is the same
    // honest degradation the tilted-1x1 rule already makes - the caption still
    // says how many slots differ. Descendants of an undrawn part are skipped
    // too: they belong to the picture of the part still on screen.
    diffs.forEach((d) => {
      if (!d.oldId) return;
      // A pure REMOVAL is never rubbed out. The part is in the frame preset, so
      // it is still on screen whether or not we located it - the part HAS a
      // picture, it is the removal the picture cannot show. Its own word.
      if (!d.newId) { kept++; return; }
      const e = entryByPath[d.path];
      if (!e) return;
      if (!drawnAt[d.path]) return;
      let anc = pathParent(d.path), blocked = false;
      while (anc && !blocked) { if (undrawn[anc]) blocked = true; anc = pathParent(anc); }
      if (blocked) return;
      const es = num(e.s, 1);
      const sz = artSize8x(art, items, d.oldId);
      out.erase.push({ id: d.oldId, path: d.path, x: num(e.x, 0), y: num(e.y, 0), w: sz.w * es, h: sz.h * es });
    });

    // A suppressor hung off an M4A1's muzzle sticks out past the LEFT edge of
    // the preset render (the frame has ~120 px of margin, the can needs ~350).
    // Publish the union so the stage can zoom out to fit instead of clipping
    // it - bounded, so one badly scaled overlay cannot shrink the gun to a dot.
    if (out.frame) {
      const padX = 0.25 * out.frame.w, padY = 0.25 * out.frame.h;
      const ext = { x0: 0, y0: 0, x1: out.frame.w, y1: out.frame.h };
      out.draw.forEach((e) => {
        ext.x0 = Math.min(ext.x0, e.x); ext.y0 = Math.min(ext.y0, e.y);
        ext.x1 = Math.max(ext.x1, e.x + e.w); ext.y1 = Math.max(ext.y1, e.y + e.h);
      });
      // breathing room on the sides something hangs off, so a suppressor is
      // not flush against the canvas edge; untouched sides keep the frame's
      // own margin, so an unmodified gun is drawn exactly as large as before
      const air = 0.03 * out.frame.w, airY = 0.03 * out.frame.h;
      if (ext.x0 < 0) ext.x0 -= air;
      if (ext.y0 < 0) ext.y0 -= airY;
      if (ext.x1 > out.frame.w) ext.x1 += air;
      if (ext.y1 > out.frame.h) ext.y1 += airY;
      ext.x0 = Math.max(ext.x0, -padX); ext.y0 = Math.max(ext.y0, -padY);
      ext.x1 = Math.min(ext.x1, out.frame.w + padX); ext.y1 = Math.min(ext.y1, out.frame.h + padY);
      out.extent = ext;
    }
    out.missing = missing;
    out.tiny = tiny;
    out.kept = kept;
    if (missing) out.notes.push(missing + ' part' + (missing === 1 ? ' has' : 's have') + ' no picture');
    if (tiny) out.notes.push(tiny + ' small part' + (tiny === 1 ? '' : 's') + ' not pictured');
    if (kept) out.notes.push(kept + ' removed part' + (kept === 1 ? '' : 's') + ' still shown');
    return out;
  }

  // ==========================================================================
  // PURE: prerequisites ("find a part")
  // ==========================================================================
  //
  // The slot tree already enforces the game's rule - a foregrip slot only
  // exists once a handguard that HAS one is fitted - so a player who does not
  // already know the chain simply cannot find the part. This is the index that
  // answers "what do I need first".

  const REACH_CACHE = new Map();

  function chainScore(chain, defaults, offers, items) {
    const pre = chain.slice(0, -1);
    let inDef = 0, price = 0;
    pre.forEach((st) => {
      if (defaults && typeof defaults.has === 'function' && defaults.has(st.itemId)) inDef++;
      const o = (offers && typeof offers.get === 'function') ? offers.get(st.itemId) : null;
      price += o ? num(o.rub, 0) : 1e9;
    });
    const name = pre.map((st) => ((items && items[st.itemId] && items[st.itemId].n) || st.itemId)).join('|');
    return { inDef, price, name };
  }
  // < 0 when a is the better chain
  function betterChain(a, b, defaults, offers, items) {
    const sa = chainScore(a, defaults, offers, items), sb = chainScore(b, defaults, offers, items);
    if (sa.inDef !== sb.inDef) return sb.inDef - sa.inDef;
    if (sa.price !== sb.price) return sa.price - sb.price;
    if (sa.name === sb.name) return 0;
    return sa.name < sb.name ? -1 : 1;
  }

  // partId -> the shortest chain of slots/holders that ends in it, breadth
  // first from the gun through EVERY allowed item. opts (all optional):
  //   defaultParts  Set of the gun's factory-default part ids (tie-break)
  //   offers        the price index (tie-break)
  const MAX_CHAINS = 3;

  // partId -> up to MAX_CHAINS chains that reach it, best first. Alternates
  // matter because the ONE best chain may route through a holder the current
  // build conflicts with (an RVG that fits the handguard already on the gun was
  // reported as "needs 2 first - conflicts with M4A1" because its stored chain
  // went through a different handguard).
  function reachableChains(props, items, gunId, opts) {
    const o = opts || null;
    const hit = REACH_CACHE.get(gunId);
    if (hit && hit.opts === o) return hit.map;
    const defaults = (o && o.defaultParts) || null;
    const offers = (o && o.offers) || null;
    const result = new Map();
    const visited = new Set([gunId]);
    let frontier = [{ holderId: gunId, prefix: '', chain: [] }];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const found = new Map();
      frontier.forEach((f) => {
        const p = (props && props[f.holderId]) || {};
        const slots = Array.isArray(p.slots) ? p.slots : [];
        slots.forEach((s) => {
          if (!s || !s.nameId || hiddenSlot(s.nameId)) return;
          const allowed = (s.filters && Array.isArray(s.filters.allowedItems)) ? s.filters.allowedItems : [];
          const path = f.prefix ? f.prefix + '/' + s.nameId : s.nameId;
          allowed.forEach((id) => {
            if (!items || !items[id] || result.has(id)) return;
            const chain = f.chain.concat([{ path, holderId: f.holderId, slotNameId: s.nameId, itemId: id }]);
            let list = found.get(id);
            if (!list) { found.set(id, [chain]); return; }
            let at = list.length;
            for (let i = 0; i < list.length; i++) { if (betterChain(chain, list[i], defaults, offers, items) < 0) { at = i; break; } }
            if (at >= MAX_CHAINS) return;
            list.splice(at, 0, chain);
            if (list.length > MAX_CHAINS) list.length = MAX_CHAINS;
          });
        });
      });
      const next = [];
      found.forEach((list, id) => {
        result.set(id, list);
        if (visited.has(id)) return;
        visited.add(id);
        const p = props && props[id];
        const chain = list[0];
        if (p && Array.isArray(p.slots) && p.slots.length) next.push({ holderId: id, prefix: chain[chain.length - 1].path, chain });
      });
      frontier = next;
    }
    REACH_CACHE.set(gunId, { opts: o, map: result });
    return result;
  }

  // the one best chain per part - the shape every caller but the finder wants
  function reachable(props, items, gunId, opts) {
    const all = reachableChains(props, items, gunId, opts);
    const out = new Map();
    all.forEach((list, id) => { if (list && list.length) out.set(id, list[0]); });
    return out;
  }

  // What the fitted build ALREADY offers: every empty-or-occupied slot that
  // exists right now and accepts this part. Zero prerequisites by definition,
  // and it is what the slot picker itself would show - so the finder must
  // never claim a part needs prerequisites when one of these exists.
  function directSlots(props, items, gunId, fitted) {
    const out = new Map();
    slotTree(props, gunId, fitted).forEach((n) => {
      n.allowed.forEach((id) => {
        if (!items || !items[id]) return;
        let list = out.get(id);
        if (!list) { list = []; out.set(id, list); }
        if (list.length < MAX_CHAINS) list.push([{ path: n.path, holderId: n.holder, slotNameId: n.nameId, itemId: id }]);
      });
    });
    return out;
  }

  // how many steps of a chain planFit would actually have to change
  function chainNeed(fitted, chain) {
    const map = fitted || new Map();
    let n = 0;
    for (let i = 0; i + 1 < (chain || []).length; i++) if (map.get(chain[i].path) !== chain[i].itemId) n++;
    return n;
  }

  // Fit a whole chain at once: every holder it needs, then the part itself.
  // A slot that already holds the right item is left alone; one holding
  // something else is replaced and reported.
  function planFit(props, gunId, fitted, chain, conflicts) {
    let map = new Map(fitted || []);
    const steps = Array.isArray(chain) ? chain : [];
    const replaced = [];
    const blocked = [];
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (!st || !st.path || !st.itemId) continue;
      const cur = map.get(st.path) || null;
      if (cur === st.itemId) continue;
      const others = new Map();
      map.forEach((v, k) => { if (k !== st.path && k.indexOf(st.path + '/') !== 0) others.set(k, v); });
      conflictsOf(conflicts, gunId, others, st.itemId).forEach((x) => { if (blocked.indexOf(x) < 0) blocked.push(x); });
      if (cur) replaced.push({ path: st.path, from: cur, to: st.itemId });
      map.set(st.path, st.itemId);
      map = revalidate(props, gunId, map);
    }
    return { fitted: map, replaced, conflicts: blocked, ok: blocked.length === 0 };
  }

  // ==========================================================================
  // PURE: share codec
  // ==========================================================================

  function b64urlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = (typeof btoa === 'function') ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(s)) return null;
    while (s.length % 4) s += '=';
    let bin;
    try {
      bin = (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    } catch (e) { return null; }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder === 'function') return Array.from(new TextEncoder().encode(str));
    const bin = unescape(encodeURIComponent(str));
    const out = [];
    for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i) & 255);
    return out;
  }
  function utf8String(bytes) {
    try {
      if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return decodeURIComponent(escape(bin));
    } catch (e) { return null; }
  }

  function hexToBytes(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  function bytesToHex(bytes, from, to) {
    let s = '';
    for (let i = from; i < to; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  // 'v1.' + base64url([1][12 B gun][12 B part]*). Every gun and mod id is
  // 24 hex chars; a full 16-part rifle is ~260 chars of URL. 'v2.' is the JSON
  // fallback for an id that is not hex (none today; the codec must not fail
  // on one tomorrow).
  function encodeShare(gunId, partIds) {
    const all = [gunId].concat(partIds || []);
    if (all.every((id) => ID_RE.test(String(id)))) {
      const bytes = [1];
      all.forEach((id) => { hexToBytes(String(id)).forEach((b) => bytes.push(b)); });
      return 'v1.' + b64urlEncode(bytes);
    }
    const json = JSON.stringify({ w: gunId, p: partIds || [] });
    const bytes = utf8Bytes(json);
    return 'v2.' + b64urlEncode(bytes);
  }

  function decodeShare(code) {
    const s = String(code || '');
    if (s.indexOf('v1.') === 0) {
      const bytes = b64urlDecode(s.slice(3));
      if (!bytes || bytes.length < 13 || bytes[0] !== 1 || (bytes.length - 1) % 12 !== 0) return null;
      const ids = [];
      for (let i = 1; i < bytes.length; i += 12) ids.push(bytesToHex(bytes, i, i + 12));
      return { w: ids[0], p: ids.slice(1) };
    }
    if (s.indexOf('v2.') === 0) {
      const bytes = b64urlDecode(s.slice(3));
      if (!bytes) return null;
      const json = utf8String(bytes);
      if (json == null) return null;
      try {
        const o = JSON.parse(json);
        if (!o || typeof o.w !== 'string' || !Array.isArray(o.p)) return null;
        return { w: o.w, p: o.p.filter((x) => typeof x === 'string') };
      } catch (e) { return null; }
    }
    return null;
  }
  // ==========================================================================
  // PURE: slot classes (the three header checkboxes)
  // ==========================================================================
  //
  // Escape from Tarkov's modding screen gates the slot cards with three
  // checkboxes: "Vital parts", "Functional mods", "Gear mods". The game does
  // not publish the mapping, so this table is ours - derived from what each
  // family of slot DOES, and documented here because it is the one place a
  // reader can check it:
  //
  //   vital      the gun does not work without it, or it is part of the gun's
  //              own body: receiver, barrel, gas block, bolt/charging handle,
  //              stock, pistol grip, magazine, handguard, trigger group,
  //              chamber. PLUS: any slot the data marks required, whatever it
  //              is called - a required slot is by definition vital.
  //   functional a mod that changes how the gun shoots or is aimed: muzzle
  //              devices, iron sights, scopes, mounts, foregrips, bipods,
  //              underbarrel launchers.
  //   gear       everything worn on the gun for utility rather than ballistics:
  //              tacticals, flashlights, lasers, NVG, generic equipment.
  //
  // Anything unmapped falls to 'gear' so a new slot id can never vanish from
  // the screen entirely - it just lands in the loosest bucket.
  const SLOT_CLASS = {
    reciever: 'vital', barrel: 'vital', gas_block: 'vital', charge: 'vital',
    stock: 'vital', pistol_grip: 'vital', magazine: 'vital', handguard: 'vital',
    trigger: 'vital', hammer: 'vital', catch: 'vital', camora: 'vital',
    muzzle: 'functional', sight_front: 'functional', sight_rear: 'functional',
    scope: 'functional', mount: 'functional', foregrip: 'functional',
    bipod: 'functional', launcher: 'functional',
    tactical: 'gear', flashlight: 'gear', nvg: 'gear', equipment: 'gear',
  };
  const SLOT_CLASSES = ['vital', 'functional', 'gear'];
  function slotClass(nameId, required) {
    if (required) return 'vital';
    return SLOT_CLASS[slotKey(nameId)] || 'gear';
  }

  // The uppercase word the game prints next to the marker ON the gun. Short
  // enough to sit on the model without covering it - "PIST. GRIP", "UBGL".
  const MARKER_LABELS = {
    reciever: 'RECEIVER', barrel: 'BARREL', gas_block: 'GAS BLOCK', charge: 'BOLT',
    stock: 'STOCK', pistol_grip: 'PIST. GRIP', magazine: 'MAGAZINE',
    handguard: 'HANDGUARD', launcher: 'UBGL', mount: 'MOUNT', muzzle: 'MUZZLE',
    scope: 'SCOPE', sight_front: 'FRONT SIGHT', sight_rear: 'REAR SIGHT',
    foregrip: 'FOREGRIP', bipod: 'BIPOD', trigger: 'TRIGGER', hammer: 'HAMMER',
    catch: 'CATCH', camora: 'CHAMBER',
  };
  function markerLabel(nameId) { return MARKER_LABELS[slotKey(nameId)] || null; }

  // ==========================================================================
  // PURE: where every fitted part actually sits in the picture
  // ==========================================================================
  //
  // compositePlan() already knows where a CHANGED part lands, because it has
  // to paint it. The markers need the same answer for every part - including
  // the ones the frame preset drew itself and the plan therefore leaves alone.
  // This walks the same pool, in the same order, so the two can never
  // disagree, and returns rects in FRAME px8x coordinates (the plan's own
  // space); the stage maps them to css with the same transform it paints with.
  function markerRects(art, props, items, gunId, fitted, data, plan) {
    const out = { byPath: {}, gun: null, frame: null, extent: null };
    const map = (fitted instanceof Map) ? fitted : new Map();
    const p = plan || compositePlan(art, props, items, gunId, map, data);
    out.frame = p.frame;
    out.extent = p.extent;
    const pid = p.presetId;
    const A = pid && art && art.presets && art.presets[pid];
    if (!A || !art.items) return out;
    const parts = presetPartList(data, art, pid, gunId);
    const placed = placeParts(props, gunId, parts).fitted;
    const pool = {};
    (Array.isArray(A.parts) ? A.parts : []).forEach((e) => {
      if (!e || typeof e.id !== 'string') return;
      if (!pool[e.id]) pool[e.id] = [];
      pool[e.id].push(e);
    });
    const used = {};
    function takeEntry(id) {
      const list = pool[id];
      if (!list) return null;
      const i = used[id] || 0;
      if (i >= list.length) return null;
      used[id] = i + 1;
      return list[i];
    }
    out.gun = poseRect(art, takeEntry(gunId));
    slotTree(props, gunId, placed).forEach((n) => {
      if (!n.item) return;
      const e = takeEntry(n.item);
      if (!e) return;
      const r = poseRect(art, e);
      // only keep it if the BUILD still has that same item there; a slot the
      // build changed is answered by the plan's draw entry below
      if (r && map.get(n.path) === n.item) out.byPath[n.path] = r;
    });
    (p.draw || []).forEach((d) => {
      if (!d || !d.path) return;
      out.byPath[d.path] = { x0: d.left, y0: d.top, x1: d.right, y1: d.bottom };
    });
    return out;
  }

  // rect -> a point on the gun, as a 0..1 fraction of the drawn picture
  // (the EXTENT, which is what the canvas is sized to).
  function markerFraction(rect, extent) {
    if (!rect || !extent) return null;
    const w = extent.x1 - extent.x0, h = extent.y1 - extent.y0;
    if (!(w > 0) || !(h > 0)) return null;
    const fx = ((rect.x0 + rect.x1) / 2 - extent.x0) / w;
    const fy = ((rect.y0 + rect.y1) / 2 - extent.y0) / h;
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
    return [Math.max(0, Math.min(1, fx)), Math.max(0, Math.min(1, fy))];
  }

  // ==========================================================================
  // PURE: the 12-row stat block
  // ==========================================================================
  //
  // Exactly the rows the game prints, in the game's order. Every value comes
  // out of item-props.json / items.json or it is null - a null renders "-"
  // with a "not in the data" title. Nothing here is estimated.
  //
  //   DURABILITY        gun.maxDurability                     -> "100/100 (100)"
  //   WEIGHT            sum of items[].wt                      (buildStats)
  //   ERGONOMICS        gun.ergonomics + sum mod.ergonomics    (buildStats)
  //   ACCURACY          reference preset's own `moa`. Only PRESETS carry moa
  //                     in this data; a hand-built gun has no derivable MOA,
  //                     so the row says which preset the figure belongs to.
  //   SIGHTING RANGE    max(gun.sightingRange, fitted sight.sightingRange)
  //   VERTICAL RECOIL   buildStats
  //   HORIZONTAL RECOIL buildStats
  //   MUZZLE VELOCITY   defaultAmmo.initialSpeed. No barrel/suppressor
  //                     velocity modifier exists in this data - the row says so.
  //   TYPES OF FIRE     gun.fireModes
  //   CALIBER           gun.caliber, "Caliber556x45NATO" -> "556x45NATO"
  //   FIRE RATE         gun.fireRate
  //   EFFECTIVE DIST.   gun.effectiveDistance
  const NOT_IN_DATA = 'This weapon has no value for it in the game data the app ships.';

  function fireModeWords(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const W = { single: 'Single fire', fullauto: 'Full auto', burst: 'Burst', doubleaction: 'Double action', semiauto: 'Semi auto' };
    return list.map((m) => W[String(m).toLowerCase()] || String(m)).join(', ');
  }

  function weaponStatRows(items, props, gunId, fitted, extra) {
    const g = (props && props[gunId]) || {};
    const map = (fitted instanceof Map) ? fitted : new Map();
    const st = (extra && extra.stats) || null;
    const rows = [];
    const row = (key, label, value, opts) => {
      const o = opts || {};
      rows.push({
        key, label,
        value: (value == null || value === '') ? null : String(value),
        meter: (o.meter == null) ? null : o.meter,
        meterKind: o.meterKind || null,
        raw: (o.raw == null) ? null : o.raw,
        note: o.note || null,
      });
    };

    const dur = num(g.maxDurability, null);
    row('durability', 'Durability', dur == null ? null : dur + '/' + dur + ' (' + dur + ')');

    row('weight', 'Weight', st ? st.weight.toFixed(3) : null, { raw: st ? st.weight : null });

    const ergo = st ? st.ergo : firstNum(g.ergonomics, null);
    row('ergonomics', 'Ergonomics', ergo == null ? null : String(ergo), {
      meter: ergo == null ? null : Math.max(0, Math.min(1, ergo / 100)), meterKind: 'blue', raw: ergo,
    });

    const moa = (extra && extra.moa != null) ? num(extra.moa, null) : null;
    row('accuracy', 'Accuracy', moa == null ? null : moa.toFixed(2) + ' MOA', {
      note: moa == null ? null : (extra.moaFrom ? 'Only factory presets carry an MOA figure in this data; this is ' + extra.moaFrom + '.' : null),
    });

    let sight = num(g.sightingRange, null);
    map.forEach((id) => {
      const v = num((props && props[id] || {}).sightingRange, null);
      if (v != null && (sight == null || v > sight)) sight = v;
    });
    row('sighting', 'Sighting range', sight == null ? null : String(sight));

    row('recoilV', 'Vertical recoil', st ? String(st.recoilV) : null, { raw: st ? st.recoilV : null });
    row('recoilH', 'Horizontal recoil', st ? String(st.recoilH) : null, { raw: st ? st.recoilH : null });

    const ammo = g.defaultAmmo && props && props[g.defaultAmmo];
    const vel = ammo ? num(ammo.initialSpeed, null) : null;
    row('velocity', 'Muzzle velocity', vel == null ? null : vel + ' m/s', {
      // the reference draws this in the same blue as ergonomics, scaled against
      // a round 1000 m/s ceiling - the red near-empty bar was ours, not theirs
      meter: vel == null ? null : Math.max(0, Math.min(1, vel / 1000)), meterKind: 'blue',
      note: vel == null ? null : 'Muzzle velocity of the default ammunition. No barrel or suppressor velocity modifier exists in this data.',
    });

    row('fire', 'Types of fire', fireModeWords(g.fireModes));
    row('caliber', 'Caliber', g.caliber ? String(g.caliber).replace(/^Caliber/, '') : null);
    const fr = num(g.fireRate, null);
    row('rate', 'Fire rate', fr == null ? null : fr + ' rpm');
    const ed = num(g.effectiveDistance, null);
    row('distance', 'Effective distance', ed == null ? null : ed + ' meters');
    return rows;
  }
  // The cards are small - the game's are ~64px at 1080p and the weapon is the
  // subject of the screen, not them.
  const BOX_W = 60, BOX_H = 60, GAP = 10, STEP_X = BOX_W + GAP, STEP_Y = BOX_H + GAP;
  // the stats readout floats over the lower-left corner, like the game's. The
  // layout treats this rect as OCCUPIED: no card is placed in it, and the
  // weapon is kept entirely above it.
  const STATS_W = 300, STATS_H = 190;
  // The stage floor. The BUILD COMPLETE strip is pinned to the bottom edge and
  // BACK sits just above it on the right; both are reserved rects the placer
  // treats as occupied, because a card tucked under either one is CLIPPED, and
  // clipping is never an acceptable outcome - the weapon gives up span first.
  const BANNER_H = 34;
  const BACK_W = 140, BACK_H = 34;
  const FOOT_H = BANNER_H + BACK_H;
  // At this stage width the 12-row readout always stays ON the stage, bottom
  // left under the muzzle, the way the game draws it. The fold-to-dock path is
  // only for stages too narrow to seat it.
  const STATS_ON_STAGE_W = 1500;
  // how much of the stage width the weapon should span when the height allows.
  // The game's weapon is the hero; ours must be too.
  const GUN_SPAN = 0.85;

  // Minimal-displacement 1-D label placement (pool adjacent violators).
  // Given each card's IDEAL x, return positions at least `step` apart that move
  // every card as little as possible - so a crowded cluster spreads BOTH ways
  // around its own centre of mass instead of every collision shoving the whole
  // row to the right (which is what bunched the entire cloud over the receiver
  // and left the front half of the gun bare).
  function spreadRow(ideals, step) {
    const n = ideals.length;
    if (!n) return [];
    const t = [];
    for (let i = 0; i < n; i++) t.push(ideals[i] - i * step);
    const blocks = [];
    for (let i = 0; i < n; i++) {
      let b = { sum: t[i], cnt: 1, val: t[i] };
      while (blocks.length && blocks[blocks.length - 1].val > b.val) {
        const p = blocks.pop();
        b.sum += p.sum; b.cnt += p.cnt; b.val = b.sum / b.cnt;
      }
      blocks.push(b);
    }
    const flat = [];
    blocks.forEach((b) => { for (let k = 0; k < b.cnt; k++) flat.push(b.val); });
    return flat.map((v, i) => v + i * step);
  }

  // Slide a finished row into [lo, hi], keeping its shape; if it is wider than
  // the window, clamp from the left and let the tail ride the right edge.
  function fitRow(xs, lo, hi, w) {
    if (!xs.length) return xs;
    const span = xs[xs.length - 1] + w - xs[0];
    let shift = 0;
    if (xs[0] < lo) shift = lo - xs[0];
    else if (xs[xs.length - 1] + w > hi) shift = Math.max(lo - xs[0], hi - (xs[xs.length - 1] + w));
    const out = xs.map((x) => x + shift);
    if (span > hi - lo) {
      for (let i = 0; i < out.length; i++) out[i] = Math.max(lo, Math.min(out[i], hi - w));
      for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + STEP_X);
    }
    return out;
  }

  // ==========================================================================
  // PURE: floating-card layout
  // ==========================================================================
  //
  // The game does NOT rail its slot cards down the four edges of the screen.
  // It floats them in the air above and below a big, centred weapon, each one
  // hovering over its own mount point, fanned sideways only as far as it takes
  // to stop two cards touching - so the cloud is balanced left to right and the
  // front half of the gun has cards over it just like the rear half.
  //
  //   1. every slot is asked for the x/y of its real mount point - from
  //      builder-art.json via opts.at(path) when the art located the part, else
  //      from the generic ANCHORS silhouette. opts.at() is already mirrored if
  //      the stage is showing the weapon muzzle-left, so the cloud follows;
  //   2. mount points above the gun's waterline go in the top cloud, the rest
  //      in the bottom cloud;
  //   3. a cloud that does not fit one row is split into interleaved rows, so
  //      EVERY row spans the whole weapon rather than the first row taking the
  //      front and the second the back;
  //   4. each row is placed by minimal displacement from its ideal positions
  //      (spreadRow), then slid inside the usable window - which excludes the
  //      bottom-left rect the stats readout owns;
  //   5. the weapon is then sized to GUN_SPAN of the stage, shrunk only as far
  //      as it takes to fit opts.maxHeight without scrolling, and the slack (if
  //      any) is spent lifting it toward the vertical centre.
  //
  // Nothing overlaps anything: scripts/smoke-builder.mjs asserts card-vs-card
  // and card-vs-weapon separation at four widths on the widest and the
  // most-slotted weapon in the game data.
  function layoutBoxes(tree, width, opts) {
    const o = opts || {};
    const W = Math.max(320, Math.floor(width || 960));
    const aspect = (num(o.aspect, 0) > 0.2) ? num(o.aspect, 2.6) : 2.6;
    let statsH = (o.statsH == null) ? STATS_H : num(o.statsH, 0);
    if (W < 760) statsH = 0;       // no room for a 300px panel beside anything

    const at = (typeof o.at === 'function') ? o.at : null;
    const ptOf = {};
    const clouds = { top: [], bottom: [] };
    tree.forEach((n) => {
      const p = (at && at(n.path, n.nameId)) || null;
      const pt = (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? p : anchorFor(n.nameId);
      ptOf[n.path] = pt;
      const k = slotKey(n.nameId);
      let side;
      if (k === 'magazine' || k === 'pistol_grip' || k === 'foregrip' || k === 'launcher'
        || k === 'bipod' || k === 'trigger' || k === 'hammer' || k === 'catch') side = 'bottom';
      else if (k === 'scope' || k === 'mount' || k === 'sight_front' || k === 'sight_rear'
        || k === 'nvg' || k === 'reciever' || k === 'gas_block' || k === 'charge') side = 'top';
      else side = anchorFor(n.nameId)[1] < 0.46 ? 'top' : 'bottom';
      clouds[side].push(n);
    });

    // how many rows each cloud needs, at the widest the gun will ever be
    const rowsFor = (list, lo, hi) => {
      const per = Math.max(1, Math.floor((hi - lo + GAP) / STEP_X));
      const needed = Math.max(1, Math.ceil(list.length / per));
      // a wide window fits 15 cards in one row - and then every leader line
      // leaves from the same y and they all cross. Stagger on purpose.
      const deep = W >= 1300 && num(o.maxHeight, 0) >= 640;
      const wanted = list.length >= 10 ? (deep ? 3 : 2) : (list.length >= 5 ? 2 : 1);
      return Math.max(needed, wanted);
    };
    let topRows = clouds.top.length ? rowsFor(clouds.top, 0, W) : 0;
    let topH = topRows * STEP_Y;
    const maxH = num(o.maxHeight, 0);

    // Sizing, given a readout height. The weapon must clear the readout
    // OUTRIGHT - it never sits on it - so the readout's full height is part of
    // the space reserved below the weapon.
    function size(sh) {
      const sw = sh ? STATS_W : 0;
      const rows = clouds.bottom.length ? rowsFor(clouds.bottom, sw ? sw + 2 * GAP : 0, W) : 0;
      const bH = rows * STEP_Y;
      // + GAP on the cloud so the last row of cards is not flush against the
      // banner, which read as clipped even though nothing overlapped
      const below = Math.max(bH ? bH + GAP : 0, sh ? sh + 2 * GAP : 0) + FOOT_H;
      let gw = Math.max(80, W * GUN_SPAN);
      let gh = Math.max(40, gw / aspect);
      let f = 1, pad = 0;
      if (maxH > 0) {
        const room = maxH - topH - below;
        if (room > 0 && room < gh) {
          // shrink the WEAPON, never the cards - they have a legibility floor
          f = Math.max(0.5, room / gh);
          gw *= f; gh *= f;
        } else if (room > gh) {
          // slack: spend it lifting the weapon toward the vertical centre
          pad = Math.min(room - gh, Math.max(0, (below - topH) / 2));
        }
      }
      return { sh, sw, rows, bH, below, gw, gh, f, pad };
    }

    // A short window cannot seat a big weapon AND a 190px readout AND two rows
    // of cards AND the banner - 1280x800 leaves this view ~500px. Rather than
    // shrink the weapon to a smear (the thing the whole screen is about) or
    // scroll, the readout folds to its chevron and its 12 rows move into the
    // dock right under the stage, where they are still one glance away. The
    // chevron re-opens it in place for anyone who wants it there.
    let plan = size(statsH);
    let statsInDock = false;
    // Round 4 folded the readout into the dock at 1920 even though the corner
    // under the muzzle was empty. A wide stage keeps it; only a narrow one folds.
    if (statsH && plan.f < 0.75 && W < STATS_ON_STAGE_W) {
      const bare = size(0);
      if (bare.f > plan.f) { plan = bare; statsInDock = true; statsH = 0; }
    }
    // Stagger rows cost height, and height is what the weapon is made of. If
    // the extra row has shrunk the weapon below ~72% of the stage, give the row
    // back - a slightly flatter cloud beats a small gun, and the 2-row stagger
    // still clears the crossing-leader problem the third row was added for.
    // The stagger is what stops fifteen leader lines leaving from one y and
    // crossing, so it outranks span: a row is only given back when the weapon
    // would otherwise fall under ~55% of the stage. (Round 5 calibration -
    // clipping is never acceptable, a span under 0.72 is.)
    const minRows = clouds.top.length > (Math.max(1, Math.floor((W + GAP) / STEP_X))) ? 2 : 1;
    while (topRows > minRows && plan.gw < 0.55 * W) {
      const tryRows = topRows - 1;
      const keepH = topH;
      topRows = tryRows;
      topH = topRows * STEP_Y;
      const next = size(statsH);
      if (next.gw <= plan.gw) { topRows = tryRows + 1; topH = keepH; break; }
      plan = next;
    }
    const statsW = plan.sw;
    const botRows = plan.rows;
    const below = plan.below;
    const gunW = Math.round(plan.gw);
    const gunH = Math.round(plan.gh);
    const gunX = Math.round((W - gunW) / 2);

    // The PICTURE box (draw) is the whole drawn extent - the frame plus the
    // transparent air a suppressor or a stock hangs into. The WEAPON box (img)
    // is the union of the parts actually rendered in it, handed in as 0..1
    // fractions by the caller. Cards hug the WEAPON, not the padding: gating
    // them on the picture box is what left them floating 300-600 px away with
    // their leader lines crossing.
    const bb = (Array.isArray(o.bbox) && o.bbox.length === 4) ? o.bbox : [0, 0, 1, 1];
    const bx0 = Math.max(0, Math.min(1, num(bb[0], 0))), by0 = Math.max(0, Math.min(1, num(bb[1], 0)));
    const bx1 = Math.max(bx0 + 0.02, Math.min(1, num(bb[2], 1))), by1 = Math.max(by0 + 0.02, Math.min(1, num(bb[3], 1)));
    // the top cloud has to fit above the WEAPON's top edge, not the picture's
    const gunY = Math.max(0, Math.round(topH - by0 * gunH + plan.pad));
    const draw = { x: gunX, y: gunY, w: gunW, h: gunH };
    const img = {
      x: Math.round(gunX + bx0 * gunW), y: Math.round(gunY + by0 * gunH),
      w: Math.round((bx1 - bx0) * gunW), h: Math.round((by1 - by0) * gunH),
    };

    // ---- place the two clouds -------------------------------------------
    const boxes = [];
    function place(list, rows, side, lo, hi) {
      if (!list.length) return;
      const sorted = list.slice().sort((a, b) => ptOf[a.path][0] - ptOf[b.path][0] || a.path.localeCompare(b.path));
      // interleave: card 0 -> row 0, card 1 -> row 1, ... so every row spans
      // the whole weapon instead of one row owning the front and one the back
      const byRow = [];
      for (let r = 0; r < rows; r++) byRow.push([]);
      sorted.forEach((n, i) => byRow[i % rows].push(n));
      byRow.forEach((row, r) => {
        if (!row.length) return;
        // the ideal x is under the marker, which lives on the PICTURE
        const ideals = row.map((n) => draw.x + ptOf[n.path][0] * draw.w - BOX_W / 2);
        const xs = fitRow(spreadRow(ideals, STEP_X), lo, hi, BOX_W);
        // row 0 is the one nearest the weapon, measured off the WEAPON's edge
        const y = side === 'top' ? img.y - (r + 1) * STEP_Y : img.y + img.h + GAP + r * STEP_Y;
        row.forEach((n, i) => boxes.push({
          path: n.path, x: Math.round(xs[i]), y: Math.round(y), w: BOX_W, h: BOX_H, rail: side, shelf: r,
        }));
      });
    }
    place(clouds.top, topRows, 'top', 0, W);
    place(clouds.bottom, botRows, 'bottom', statsW ? statsW + 2 * GAP : 0, W);

    // the floor is added AFTER the cloud, so the last row can never end up
    // behind the banner - which is exactly how round 4 clipped it
    const contentBottom = Math.max(draw.y + draw.h, img.y + img.h + GAP + botRows * STEP_Y);
    const height = Math.max(contentBottom + FOOT_H, img.y + img.h + below);
    const footTop = height - FOOT_H;
    return {
      boxes, width: W, img, draw,
      height,
      banner: { x: 0, y: height - BANNER_H, w: W, h: BANNER_H },
      back: { x: W - BACK_W - 12, y: footTop, w: BACK_W, h: BACK_H },
      stats: statsH ? { x: 0, y: Math.min(img.y + img.h + GAP, footTop - statsH - GAP), w: statsW, h: statsH } : null,
      statsInDock, reserve: statsW,
    };
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }
  // ==========================================================================
  // PURE: saved builds store shape
  // ==========================================================================
  function readStore(key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }
  function normalizeStore(doc) {
    const list = (doc && Array.isArray(doc.builds)) ? doc.builds : [];
    return {
      v: 1,
      builds: trimBuilds(list.filter((b) => b && typeof b.id === 'string' && typeof b.w === 'string' && Array.isArray(b.p))
        .map((b) => ({ id: b.id, name: String(b.name || '').slice(0, 48), w: b.w, p: b.p.filter((x) => typeof x === 'string'), savedAt: num(b.savedAt, 0) }))),
    };
  }
  // keep the newest MAX_SAVED by savedAt (stable for ties), list order preserved
  function trimBuilds(builds) {
    if (builds.length <= MAX_SAVED) return builds;
    const ranked = builds.map((b, i) => ({ b, i })).sort((x, y) => (x.b.savedAt - y.b.savedAt) || (x.i - y.i));
    const drop = new Set(ranked.slice(0, builds.length - MAX_SAVED).map((r) => r.b));
    return builds.filter((b) => !drop.has(b));
  }
  function newId() {
    return 'b' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  // ==========================================================================
  // HOST: render()  -  the WEAPON MODDING screen
  // ==========================================================================
  //
  // Laid out the way Escape from Tarkov lays it out, region for region:
  //
  //   header      modding glyph + "WEAPON MODDING" + the gun's full name, then
  //               the three class checkboxes (Vital parts / Functional mods /
  //               Gear mods) that show and hide slot cards.
  //   sidebar     the workbench WEAPON PRESETS button stack - NEW, OPEN,
  //               SAVE AS, SELECT WEAPON, FIND PARTS, SHARE, DELETE.
  //   stage       full-bleed dark studio: the composite weapon picture centred,
  //               markers ON the gun at each part's real position, thin lines
  //               out to cards floating in the air above and below it.
  //   stats       the 12-row readout, bottom-left, over the stage.
  //   picker      a floating card grid anchored to the slot you clicked, plus
  //               a docked COMPATIBLE ITEMS list on the right edge.
  //   banner      BUILD COMPLETE / missing vital parts, above the bottom edge.
  //   BACK        bottom-right, plain text, no chrome.
  //
  // The canvas composite engine (compositePlan / paintStage) is UNCHANGED from
  // the previous build - this is a re-skin around it, not a replacement.

  // url -> { img, state } for the session. The stage repaints on every resize
  // and every part change; without this the same 15 overlays would be
  // re-fetched each time.
  const IMG_CACHE = new Map();

  // the live screen, for the 3D lane's stageApi() hand-off
  let LIVE = null;

  function render(mount, ctx, param) {
    const el = ctx.el;
    const clear = ctx.clear;
    const items = ctx.items || {};
    const props = ctx.itemProps || {};
    const data = expandBuilderData(ctx.builderData);
    const guns = listGuns(items, props);

    const state = {
      gun: null, fitted: new Map(), selected: null, picker: null,
      query: '', sort: 'ergo', gunQuery: '',
      buildId: null, buildName: '', note: '', drawer: false, flat: false,
      find: false, findQuery: '', reach: null, reachGun: null, reachOpts: null,
      show: { vital: true, functional: true, gear: true },
      mirror: readMirror(),
      three: false, threeBusy: false, threeOk: false, threeSupported: false, threeGun: null,
      preview: null,   // candidate id being hovered in the picker -> stat deltas
      picking: false,  // the gun picker / open-build overlay is up
      overlay: null,   // 'gun' | 'open' | null
    };
    let ro = null;
    let offersCache = null;
    const changeCbs = [];
    let raf3d = 0;
    // The 3D host is created ONCE and survives every stage re-render. It used
    // to be rebuilt by renderStage(), which meant the first part swap after
    // turning 3D on wiped the live canvas out of the DOM while host.hidden
    // stayed false and the toggle stayed lit - an orphaned Stage still holding
    // a WebGL context until the toggle was pressed again.
    let stage3dEl = null;
    let threeBound = false;
    let backEl = null;

    function readMirror() {
      // nothing stored -> muzzle-left, which is the renders' own orientation
      return readStore(MIRROR_KEY) === true;
    }

    // ---- helpers ------------------------------------------------------------
    const nameOf = (id) => (items[id] && items[id].n) || id;
    const shortOf = (id) => (items[id] && (items[id].s || items[id].n)) || id;
    const traderName = (id) => (ctx.traderById && ctx.traderById[id] && ctx.traderById[id].name) || 'Trader';
    const questName = (id) => (ctx.questById && ctx.questById[id] && ctx.questById[id].name) || null;

    function icon(id, cls) {
      const img = document.createElement('img');
      img.className = cls || 'mini-icon';
      img.alt = '';
      img.loading = 'lazy';
      const src = ctx.imgUrl('item', id);
      if (src) img.src = src;
      return img;
    }
    function btn(cls, text, onClick, title) {
      const b = el('button', cls, text);
      b.type = 'button';
      if (title) b.title = title;
      if (onClick) b.addEventListener('click', onClick);
      return b;
    }
    // "6k" / "128k" / "1.2m" - the game's own terse money, for the card tags
    function shortRub(v) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return '';
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'm';
      if (n >= 1000) return Math.round(n / 1000) + 'k';
      return String(Math.round(n));
    }

    // One offer index per profile. hub-kit builds the same thing on Generate;
    // sharing the pricer is what keeps the two tabs from disagreeing.
    function effectiveProfile() {
      const hk = hubKit();
      const profile = ctx.profile || {};
      const has = hk && hk.hasAnyTraderLevel ? hk.hasAnyTraderLevel(profile)
        : Object.keys(profile.traderLevels || {}).some((k) => Number(profile.traderLevels[k]) > 0);
      if (has) {
        const lvl = num(profile.playerLevel, null);
        return { traderLevels: profile.traderLevels || {}, playerLevel: lvl, fleaAllowed: lvl != null && lvl >= 15, synthetic: false };
      }
      const all = {};
      (ctx.traders || []).forEach((t) => { if (t && t.id) all[t.id] = 4; });
      return { traderLevels: all, playerLevel: 99, fleaAllowed: true, synthetic: true };
    }
    function offers() {
      const K = kit();
      const prof = effectiveProfile();
      const key = JSON.stringify(prof) + '|' + Object.keys(ctx.questState || {}).length;
      if (offersCache && offersCache.key === key) return offersCache;
      let map = new Map();
      if (K && K.buildOfferIndex) {
        try {
          map = K.buildOfferIndex({
            items, barters: ctx.barters || [], questState: ctx.questState || {},
            traderLevels: prof.traderLevels, playerLevel: prof.playerLevel, fleaAllowed: prof.fleaAllowed,
          });
        } catch (e) { map = new Map(); }
      }
      offersCache = { key, map, synthetic: prof.synthetic };
      return offersCache;
    }
    function chipFor(offer) {
      const hk = hubKit();
      if (hk && hk.sourceChip) return hk.sourceChip(offer, traderName(offer && offer.trader));
      return offer ? { text: offer.source, cls: 'src-' + offer.source } : { text: 'no offer', cls: 'src-none' };
    }
    function offerText(offer) {
      if (!offer) return 'no known source';
      return chipFor(offer).text + ' - ' + ctx.formatRub(offer.rub);
    }
    function sourceTag(offer) {
      const chip = chipFor(offer);
      return el('span', 'tag ' + chip.cls, chip.text);
    }

    function store() { return normalizeStore(readStore(STORE_KEY)); }
    function saveStore(doc) { return writeStore(STORE_KEY, doc); }

    function currentParts() { return [...state.fitted.values()]; }
    function currentCode() { return state.gun ? encodeShare(state.gun, currentParts()) : ''; }

    // slots the class filters currently allow on screen
    function visibleTree(tree) {
      return tree.filter((n) => state.show[slotClass(n.nameId, n.required)] !== false);
    }
    function missingVital(tree) {
      return tree.filter((n) => n.required && !n.item);
    }

    // ---- DOM skeleton -------------------------------------------------------
    clear(mount);
    const wrap = el('div', 'wb-wrap');
    const side = el('aside', 'wb-side');
    const main = el('div', 'wb-main');
    const head = el('div', 'wb-head');
    const stage = el('div', 'wb-stage');
    const dock = el('div', 'wb-dock');
    const compat = el('aside', 'wb-compat');
    const statusEl = el('div', 'wb-status');
    const strip = el('div', 'wb-strip');
    const pills = el('div', 'wb-pills');
    const sheet = el('div', 'wb-sheet');
    pills.addEventListener('click', () => { if (state.flat && state.gun) openSheet('stats'); });
    const pop = el('div', 'wb-pop');
    const drawer = el('div', 'wb-drawer');
    const tip = el('div', 'wb-tip');
    tip.hidden = true;
    pop.hidden = true;
    compat.hidden = true;
    drawer.hidden = true;
    sheet.hidden = true;
    main.appendChild(head);
    main.appendChild(statusEl);
    main.appendChild(stage);
    main.appendChild(strip);
    main.appendChild(pills);
    main.appendChild(dock);
    main.appendChild(sheet);
    wrap.appendChild(side);
    wrap.appendChild(main);
    wrap.appendChild(compat);
    wrap.appendChild(pop);
    wrap.appendChild(drawer);
    wrap.appendChild(tip);
    mount.appendChild(wrap);

    // ---- sidebar: the workbench button stack ---------------------------------
    function renderSide() {
      clear(side);
      const nameIn = document.createElement('input');
      nameIn.className = 'wb-name';
      nameIn.type = 'text';
      nameIn.placeholder = 'enter build name';
      nameIn.maxLength = 48;
      nameIn.value = state.buildName;
      nameIn.disabled = !state.gun;
      nameIn.addEventListener('input', () => { state.buildName = nameIn.value; });
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBuild(false); });
      side.appendChild(nameIn);

      const stack = el('nav', 'wb-side-stack');
      const item = (glyph, label, onClick, opts) => {
        const o = opts || {};
        const b = btn('wb-side-btn' + (o.danger ? ' danger' : '') + (o.on ? ' on' : ''), null, onClick, o.title || '');
        b.appendChild(el('span', 'wb-side-glyph', glyph));
        b.appendChild(el('span', 'wb-side-label', label));
        if (o.disabled) b.disabled = true;
        stack.appendChild(b);
        return b;
      };
      item('+', 'New build', () => {
        if (!state.gun) { openGunPicker(); return; }
        state.fitted = new Map(); state.selected = null; state.picker = null;
        state.find = false; state.buildId = null; state.buildName = ''; state.note = '';
        renderAll();
      }, { title: 'Strip the weapon back to bare and start a fresh build' });
      item('\u25A4', 'Open...', () => {
        state.drawer = !state.drawer;
        state.overlay = null;
        renderSide(); renderDrawer();
      }, { on: state.drawer, title: 'Saved builds and factory presets' });
      item('\u25BC', 'Save as...', () => saveBuild(true), { disabled: !state.gun, title: 'Save this as a new build' });
      item('\u2732', 'Select weapon', () => { state.picker = null; state.selected = null; openGunPicker(); },
        { title: 'Choose the base weapon' });
      item('\u2315', 'Find parts', () => {
        if (!state.gun) return;
        state.find = !state.find;
        state.picker = null;
        state.wantFindFocus = state.find;
        renderSide(); renderDock(); closePop();
      }, { on: state.find, disabled: !state.gun, title: 'Search every part this weapon can take - including the ones that need another part fitted first' });
      item('\u21AA', 'Share', shareBuild, { disabled: !state.gun, title: 'Copy a link to this exact build' });
      item('\u2716', 'Delete build', deleteBuild, { danger: true, disabled: !state.buildId, title: 'Delete the saved build this came from' });
      side.appendChild(stack);

      const io = el('div', 'wb-side-io');
      io.appendChild(btn('wb-io-btn', '\u{1F4BE}', () => saveBuild(false), state.buildId ? 'Save' : 'Save build'));
      io.appendChild(btn('wb-io-btn', '\u21C4', () => {
        state.drawer = true; state.overlay = null; renderSide(); renderDrawer();
      }, 'Compare against a saved build'));
      side.appendChild(io);
      side.appendChild(el('div', 'wb-side-count', store().builds.length + ' saved'));
    }

    // ---- header: title, gun name, class filters ------------------------------
    function renderHead() {
      clear(head);
      if (state.flat) {
        // Phone: the weapon's name, and every other control behind one menu.
        // The title, three class checkboxes, FLIP and 3D were four rows of
        // chrome above a picture that had none left to give.
        head.className = 'wb-head phone';
        const bar = el('div', 'wb-phone-head');
        bar.appendChild(btn('wb-gunname', state.gun ? nameOf(state.gun) : 'Select weapon', openGunPicker, 'Change weapon'));
        bar.appendChild(btn('wb-menu-btn', '⋯', () => openSheet('menu'), 'More'));
        head.appendChild(bar);
        return;
      }
      head.className = 'wb-head';
      const title = el('div', 'wb-title');
      const glyph = el('span', 'wb-title-glyph', '\u2699');
      glyph.setAttribute('aria-hidden', 'true');
      title.appendChild(glyph);
      title.appendChild(el('h2', 'wb-title-text', 'Weapon modding'));
      head.appendChild(title);
      head.appendChild(el('div', 'wb-sub', state.gun ? nameOf(state.gun) : 'Choose a base weapon to begin'));
      if (!state.gun) return;

      const filters = el('div', 'wb-filters');
      [['vital', 'Vital parts'], ['functional', 'Functional mods'], ['gear', 'Gear mods']].forEach((f) => {
        const lab = el('label', 'wb-filter' + (state.show[f[0]] ? ' on' : ''));
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!state.show[f[0]];
        cb.addEventListener('change', () => {
          state.show[f[0]] = cb.checked;
          closePop();
          renderHead();
          renderStage();
        });
        lab.appendChild(cb);
        lab.appendChild(el('span', 'wb-filter-box', ''));
        lab.appendChild(el('span', 'wb-filter-text', f[1]));
        filters.appendChild(lab);
      });
      const tools = el('div', 'wb-headtools');
      tools.appendChild(btn('wb-toggle' + (state.mirror ? ' on' : ''), 'Flip', () => {
        state.mirror = !state.mirror;
        writeStore(MIRROR_KEY, state.mirror);
        renderHead();
        renderStage();
      }, state.mirror
        ? 'Mirrored - the weapon is facing the opposite way to the game. Press to put it back.'
        : 'Muzzle-left, the way the game shows it. Press to mirror.'));
      // the 3D stage is opt-in and only exists for the weapons T2 has modelled
      if (state.threeSupported) {
        tools.appendChild(btn('wb-toggle' + (state.three ? ' on' : ''), state.threeBusy ? '3D...' : '3D',
          state.threeBusy ? null : toggleThree,
          'Draw this build as a real 3D model you can orbit. Loads ~770 kB the first time you press it.'));
      }
      filters.appendChild(tools);
      head.appendChild(filters);
    }

    // ---- the 3D stage (lane T2's module, loaded on demand) -------------------
    //
    // Nothing here is fetched until the toggle is pressed: hub-builder-3d.js and
    // the ~770 kB three bundle are injected as <script> tags, and both live under
    // /apps/ which make-sw.mjs excludes from the precache. ready() alone only
    // reads 3d/manifest.json, which is how we know whether to show the toggle.
    function injectScript(src) {
      return new Promise((res, rej) => {
        if (typeof document === 'undefined') { rej(new Error('no document')); return; }
        const found = [...document.getElementsByTagName('script')].find((x) => x.src && x.src.indexOf(src) >= 0);
        if (found) { if (found.dataset.ok === '1') res(); else found.addEventListener('load', () => res()); return; }
        const t = document.createElement('script');
        t.src = src;
        t.addEventListener('load', () => { t.dataset.ok = '1'; res(); });
        t.addEventListener('error', () => rej(new Error('could not load ' + src)));
        document.head.appendChild(t);
      });
    }
    function threeBase() {
      try {
        const all = document.getElementsByTagName('script');
        for (let i = all.length - 1; i >= 0; i--) {
          const src = all[i].src || '';
          const at = src.indexOf('js/hub-builder.js');
          if (at > 0) return src.slice(0, at);
        }
      } catch (e) { /* no document */ }
      return '';
    }
    let probeOnce = null;
    function probeThree() {
      if (!state.gun) return;
      if (!probeOnce) {
        // the module itself is small and loads nothing; it is three-bundle.js
        // that the toggle defers. Without it here there is no supports() to ask.
        probeOnce = globalThis.PilotHubBuilder3D
          ? Promise.resolve()
          : injectScript(threeBase() + 'js/hub-builder-3d.js');
      }
      probeOnce.then(() => {
        const P = globalThis.PilotHubBuilder3D;
        if (!P || !P.ready) return null;
        return P.ready();
      }, () => null).then(() => {
        const P = globalThis.PilotHubBuilder3D;
        if (!P || !P.supports) return;
        const ok = !!(state.gun && P.supports(state.gun));
        if (ok !== state.threeSupported) { state.threeSupported = ok; renderHead(); }
      }, () => { /* no module or no manifest - the toggle simply never appears */ });
    }
    function toggleThree() {
      if (state.three) {
        state.three = false;
        state.threeOk = false;
        state.threeGun = null;
        try { globalThis.PilotHubBuilder3D.destroy(); } catch (e) { /* never mounted */ }
        if (raf3d) { cancelAnimationFrame(raf3d); raf3d = 0; }
        renderHead();
        renderStage();
        return;
      }
      state.threeBusy = true;
      renderHead();
      const base = threeBase();
      injectScript(base + 'js/vendor/three-bundle.js')
        .then(() => (globalThis.PilotHubBuilder3D ? null : injectScript(base + 'js/hub-builder-3d.js')))
        .then(() => {
          state.three = true;
          state.threeBusy = false;
          renderHead();
          renderStage();
          return mountThree();
        })
        .catch(() => {
          state.threeBusy = false;
          state.three = false;
          state.note = 'The 3D stage could not load. The 2D picture is still here.';
          renderHead();
          renderDock();
        });
    }
    // The weapon changed under a live 3D stage. Drop it, then remount if the
    // new weapon is modelled and turn the toggle off if it is not.
    function rebindThreeGun() {
      const P = globalThis.PilotHubBuilder3D;
      state.threeGun = state.gun;
      state.threeOk = false;
      if (raf3d) { cancelAnimationFrame(raf3d); raf3d = 0; }
      try { if (P && P.destroy) P.destroy(); } catch (e) { /* never mounted */ }
      if (P && P.supports && state.gun && P.supports(state.gun)) { mountThree(); return; }
      state.three = false;
      state.threeSupported = false;
      if (stage3dEl) stage3dEl.hidden = true;
      renderHead();
    }

    function mountThree() {
      const host = stage3dEl;
      const P = globalThis.PilotHubBuilder3D;
      if (!host || !P) return null;
      host.hidden = false;
      return P.mount(host, {
        gunId: state.gun,
        tree: slotTree(props, state.gun, state.fitted),
        items,
        art: ctx.builderArt || null,
        onSelectSlot: (path) => { if (path) openPicker(path); },
      }).then(() => {
        state.threeOk = true;
        state.threeGun = state.gun;
        // Every part swap, preset load, strip and share-link apply funnels
        // through renderAll(), which fires these. Without it the 3D weapon
        // silently kept the build it was mounted with.
        if (!threeBound) {
          threeBound = true;
          stageApiObject().onChange((api) => {
            if (!state.three || !state.threeOk) return;
            const P2 = globalThis.PilotHubBuilder3D;
            if (!P2 || !P2.update) return;
            try {
              const r = P2.update(api.tree());
              if (r && typeof r.then === 'function') r.then(drawWires, drawWires);
              else drawWires();
            } catch (e) { drawWires(); }
          });
        }
        // the sockets move as the user orbits, so the leader lines have to be
        // redrawn with the camera - ride rAF while it is settling, then stop
        const pump = () => { drawWires(); raf3d = requestAnimationFrame(pump); };
        if (raf3d) cancelAnimationFrame(raf3d);
        raf3d = requestAnimationFrame(pump);
        host.addEventListener('pointerup', () => {
          setTimeout(() => { if (raf3d) { cancelAnimationFrame(raf3d); raf3d = 0; } drawWires(); }, 900);
        });
        // markerAt() answers from socketScreenPositions() the moment threeOk is
        // true, so one more pass puts every card and line on the real 3D sockets
        renderStage();
        drawWires();
      }, () => {
        state.threeOk = false;
        state.three = false;
        state.note = 'The 3D stage could not start. The 2D picture is still here.';
        renderHead();
        renderStage();
      });
    }

    // ---- stage ---------------------------------------------------------------
    let layout = null;
    let gunImg = null;          // a <canvas>, not an <img> - see renderStage
    let wires = null;
    let statsEl = null;
    let stageNat = { w: 0, h: 0 };  // natural size of the frame picture, px
    let stagePlan = null;
    let stageMarks = null;
    let stageBase = null;       // the loaded frame image
    let stageFrameOk = false;   // false once we fall back off the preset art
    let stageGen = 0;           // guards against a slow load repainting a dead stage
    let statsCollapsed = false;

    function extentSize(plan, frameId) {
      const e = plan && plan.extent;
      if (e && e.x1 > e.x0 && e.y1 > e.y0) return { w: e.x1 - e.x0, h: e.y1 - e.y0 };
      return imageSize8x(items, frameId);
    }

    function cachedImg(url) {
      const rec = url && IMG_CACHE.get(url);
      return (rec && rec.state === 'ok') ? rec.img : null;
    }
    function loadImg(url, cb) {
      if (!url || typeof Image !== 'function') { cb(null); return; }
      let rec = IMG_CACHE.get(url);
      if (rec && rec.state === 'ok') { cb(rec.img); return; }
      if (rec && rec.state === 'err') { cb(null); return; }
      if (!rec) {
        rec = { img: new Image(), state: 'load', cbs: [] };
        IMG_CACHE.set(url, rec);
        // no crossOrigin: a tainted canvas still DISPLAYS, and nothing here
        // ever reads a pixel back
        rec.img.addEventListener('load', () => { rec.state = 'ok'; const l = rec.cbs; rec.cbs = []; l.forEach((f) => f(rec.img)); });
        rec.img.addEventListener('error', () => { rec.state = 'err'; const l = rec.cbs; rec.cbs = []; l.forEach((f) => f(null)); });
        rec.img.src = url;
      }
      rec.cbs.push(cb);
    }
    // first url that actually loads wins
    function loadFirst(urls, i, cb) {
      if (i >= urls.length) { cb(null, -1); return; }
      loadImg(urls[i], (img) => { if (img) cb(img, i); else loadFirst(urls, i + 1, cb); });
    }

    function renderStage() {
      // detach before the wipe, re-attach after: the live WebGL canvas inside
      // must not be destroyed by a 2D re-render
      if (stage3dEl && stage3dEl.parentNode === stage) stage.removeChild(stage3dEl);
      if (backEl && backEl.parentNode === stage) stage.removeChild(backEl);
      clear(stage);
      layout = null;
      wires = null;
      gunImg = null;
      statsEl = null;
      stageBase = null;
      stagePlan = null;
      stageMarks = null;
      stageFrameOk = false;
      stageNat = { w: 0, h: 0 };
      const gen = ++stageGen;
      hideTip();
      if (!state.gun) {
        stage.className = 'wb-stage empty';
        stage.style.height = '';
        const empty = el('div', 'wb-empty');
        empty.appendChild(el('h2', null, 'Weapon modding'));
        empty.appendChild(el('p', 'muted', 'Pick a base weapon, then fill its slots the way the game lets you. Every part you fit shows where to buy it.'));
        empty.appendChild(btn('wb-cta', 'Select weapon', openGunPicker));
        stage.appendChild(empty);
        return;
      }
      const fullTree = slotTree(props, state.gun, state.fitted);
      const tree = visibleTree(fullTree);
      const W = stage.clientWidth || 960;
      const wasFlat = state.flat;
      // PHONE (<= 700px of stage). Josia, 2026-09-11, looking at his iPhone:
      // "The text is in the way. There's too much going on in the screen. Make
      // it very simple." Below this width the screen is the WEAPON and nothing
      // else: no banner over it, no caption, no markers, no leader lines, no
      // explanatory copy. Status is one line above it, the slots are one strip
      // of icons below it, and everything else is one tap away in a sheet.
      state.flat = W < 700;
      // the header, the strip and the pills all differ between the two modes,
      // so a width change has to rebuild them, not just the picture
      if (wasFlat !== state.flat && wasFlat !== undefined) {
        setTimeout(() => { renderHead(); renderPhoneFurniture(); renderDock(); }, 0);
      }
      // .three is what actually hides the 2D picture - a stray renderStage()
      // pass used to re-create .wb-gun visible under a live WebGL canvas, so
      // both weapons drew at once (the photo on top, because the canvas is
      // z-index auto inside a z-index 2 host).
      stage.className = 'wb-stage' + (state.flat ? ' flat' : '') + (state.three ? ' three' : '');

      // The picture is a COMPOSITE: the closest factory preset as the bottom
      // layer (so the gun is always there), plus per-part overlays when
      // builder-art.json is loaded. With no art file the preset frame alone
      // still beats the old behaviour, which fell back to the bare receiver.
      const plan = compositePlan(ctx.builderArt || null, props, items, state.gun, state.fitted, data);
      stagePlan = plan;
      stageMarks = markerRects(ctx.builderArt || null, props, items, state.gun, state.fitted, data, plan);
      const frameId = plan.presetId || state.gun;
      // the LAYOUT box is the extent (frame + anything hanging off it), not the
      // frame - otherwise a suppressor gets clipped at the canvas edge
      stageNat = extentSize(plan, frameId);

      gunImg = document.createElement('canvas');
      gunImg.className = 'wb-gun';
      gunImg.setAttribute('role', 'img');
      gunImg.setAttribute('aria-label', nameOf(state.gun));
      // a canvas has no naturalWidth/Height; mirror the frame's so anything
      // that used to read them off the old <img> still gets the right numbers
      gunImg.naturalWidth = stageNat.w;
      gunImg.naturalHeight = stageNat.h;

      // The provenance note used to print over the stage. It is a maintenance
      // detail, not something to read every time - it lives on the picture's
      // tooltip now and nowhere else.
      const notes = plan.notes.length ? ' - ' + plan.notes.join('; ') : '';
      gunImg.title = ((plan.presetId && plan.changed)
        ? 'Picture: ' + shortOf(plan.presetId) + ' + ' + plan.changed + ' changed' + notes
        : shortOf(state.gun) + notes);

      // the 3D lane's mount point. Empty and hidden on purpose: js/hub-builder-3d.js
      // takes this div, draws the weapon in it, and drives the SAME cards and
      // lines through stageApi() - see the return block at the bottom of render().
      if (!stage3dEl) stage3dEl = el('div', 'wb-stage-3d');
      stage3dEl.hidden = !(state.three && state.threeOk);
      stage.appendChild(stage3dEl);
      probeThree();
      // the build changed weapon while 3D was up: the mounted Stage is for the
      // old gun, so tear it down and either remount or drop the toggle
      if (state.three && state.threeGun && state.threeGun !== state.gun) rebindThreeGun();

      if (state.flat) {
        // the subject fills the frame and NOTHING is drawn over it
        stage.style.height = '';
        const avail = Math.max(120, W - 8);
        const sc = Math.min(avail / stageNat.w, 300 / stageNat.h);
        gunImg.style.width = Math.max(40, Math.round(stageNat.w * sc)) + 'px';
        gunImg.style.height = Math.max(20, Math.round(stageNat.h * sc)) + 'px';
        stage.appendChild(gunImg);
        startStageArt(gen, frameId);
        renderPhoneFurniture();
        return;
      }

      const aspect = stageNat.h > 0 ? stageNat.w / stageNat.h : 2.6;
      // what is left of the window under the header - the screen should not
      // need scrolling to see the bottom row of cards
      let room = 0;
      try {
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
        if (vh) room = Math.max(360, vh - stage.getBoundingClientRect().top - 28);
      } catch (e) { room = 0; }
      layout = layoutBoxes(tree, W, {
        aspect, at: (p, nameId) => markerAt(p) || fallbackAt(nameId), bbox: silhouette(), maxHeight: room,
        // the readout owns the bottom-left rect; the packer keeps cards out of
        // it and the weapon above it
        statsH: statsCollapsed ? 0 : STATS_H,
      });
      stage.style.height = layout.height + 'px';
      if (state.three) gunImg.hidden = true;
      const D = layout.draw || layout.img;
      gunImg.style.left = D.x + 'px';
      gunImg.style.top = D.y + 'px';
      gunImg.style.width = D.w + 'px';
      gunImg.style.height = D.h + 'px';
      stage.appendChild(gunImg);

      wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      wires.setAttribute('class', 'wb-wires');
      wires.setAttribute('width', String(layout.width));
      wires.setAttribute('height', String(layout.height));
      wires.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
      stage.appendChild(wires);

      const byPath = {};
      layout.boxes.forEach((b) => { byPath[b.path] = b; });
      tree.forEach((n) => { if (byPath[n.path]) stage.appendChild(card(n, byPath[n.path])); });
      const bn = banner(fullTree);
      if (layout.banner) {
        bn.style.top = layout.banner.y + 'px';
        bn.style.bottom = 'auto';
        bn.style.height = layout.banner.h + 'px';
      }
      stage.appendChild(bn);
      if (backEl && layout.back) {
        backEl.style.left = layout.back.x + 'px';
        backEl.style.top = layout.back.y + 'px';
        backEl.style.width = layout.back.w + 'px';
        backEl.style.height = layout.back.h + 'px';
        backEl.style.right = 'auto';
        backEl.style.bottom = 'auto';
        stage.appendChild(backEl);
      }
      renderStats();
      drawWires();
      startStageArt(gen, frameId);
    }

    // the phone strip/pills/status live OUTSIDE the stage, so a stage-only
    // repaint (a filter, a flip) has to refresh them too
    function renderPhoneFurniture() {
      if (!state.flat) { statusEl.hidden = true; strip.hidden = true; pills.hidden = true; return; }
      renderStatus();
      renderStrip();
      renderPills();
    }

    // Union of every part the picture actually renders, as 0..1 of the drawn
    // extent. The extent carries up to 25% padding for anything hanging off the
    // frame, so gating the cards on it left them floating in empty air - and it
    // is why a fallback marker could land at 1718,533 with no weapon under it.
    function silhouette() {
      const E = stageMarks && stageMarks.extent;
      if (!E || !(E.x1 > E.x0) || !(E.y1 > E.y0)) return [0, 0, 1, 1];
      const rects = [];
      if (stageMarks.gun) rects.push(stageMarks.gun);
      Object.keys(stageMarks.byPath).forEach((k) => rects.push(stageMarks.byPath[k]));
      if (!rects.length) return [0.04, 0.30, 0.96, 0.70];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      rects.forEach((r) => {
        x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0);
        x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
      });
      const w = E.x1 - E.x0, h = E.y1 - E.y0;
      const f = [(x0 - E.x0) / w, (y0 - E.y0) / h, (x1 - E.x0) / w, (y1 - E.y0) / h]
        .map((v) => Math.max(0, Math.min(1, v)));
      if (!(f[2] > f[0]) || !(f[3] > f[1])) return [0, 0, 1, 1];
      return (POSE_FLIP !== !!state.mirror) ? [1 - f[2], f[1], 1 - f[0], f[3]] : f;
    }

    // 0..1 point on the drawn picture for a slot - the part's REAL position
    // when builder-art.json located it, else the generic silhouette anchor
    // mapped INTO the silhouette (never out in the padding)
    function markerAt(path) {
      // while the 3D stage is up the markers come from the real 3D sockets,
      // projected to the host box - the 2D art poses do not describe that camera
      if (state.three && state.threeOk) {
        const host = stage3dEl;
        const P = globalThis.PilotHubBuilder3D;
        if (host && P && P.socketScreenPositions) {
          const p = P.socketScreenPositions()[path];
          const w = host.clientWidth || 1, h = host.clientHeight || 1;
          if (p && p.visible) return [Math.max(0, Math.min(1, p.x / w)), Math.max(0, Math.min(1, p.y / h))];
        }
        return null;
      }
      if (!stageMarks) return null;
      const f = markerFraction(stageMarks.byPath[path], stageMarks.extent);
      if (!f) return null;
      // pose space -> bitmap space, then the user's own FLIP on top
      const x = (POSE_FLIP !== !!state.mirror) ? 1 - f[0] : f[0];
      return [x, f[1]];
    }

    // the generic silhouette anchor, squeezed into where the weapon really is.
    // Pistols have no stock and a body a third of a rifle's length, so the
    // rifle anchor table put "STOCK" out in space to the left of a Glock.
    // Anything on the weapon's spine - muzzle device, barrel, gas block,
    // handguard, sights, receiver, bolt, stock - lives on the BORE LINE, in the
    // top 55% of the silhouette. The magazine, grip, foregrip and launcher hang
    // below it. Mapping every anchor across the FULL silhouette put the USGI A2
    // flash hider's dot in open air below the barrel, because the magazine
    // drags the union's bottom edge down past the whole lower half of the box.
    const SPINE = {
      muzzle: 1, barrel: 1, gas_block: 1, handguard: 1, sight_front: 1, sight_rear: 1,
      scope: 1, mount: 1, nvg: 1, reciever: 1, charge: 1, stock: 1, camora: 1,
    };
    function fallbackAt(nameId) {
      const a = anchorFor(nameId);
      const b = silhouette();
      // ANCHORS reads stock-to-muzzle left-to-right; the picture is the other
      // way round, and FLIP turns it back again
      let ax = Math.max(0, Math.min(1, a[0]));
      if (ANCHOR_FLIP !== !!state.mirror) ax = 1 - ax;
      const x = b[0] + ax * (b[2] - b[0]);
      const bh = b[3] - b[1];
      const ay = Math.max(0, Math.min(1, a[1]));
      const y = SPINE[slotKey(nameId)]
        ? b[1] + ay * 0.55 * bh
        : b[1] + (0.45 + ay * 0.55) * bh;
      return [x, y];
    }

    // frame first (so there is never a blank box), overlays when they land
    function startStageArt(gen, frameId) {
      const chain = [ctx.imgUrl('item512', frameId)];
      if (frameId !== state.gun) chain.push(ctx.imgUrl('item512', state.gun));
      chain.push(ctx.imgUrl('item', state.gun));
      loadFirst(chain.filter(Boolean), 0, (img, which) => {
        if (gen !== stageGen || !img) return;
        stageBase = img;
        stageFrameOk = which === 0;
        // On the frame we keep the px8x geometry (the -512 render is that same
        // image scaled down uniformly, and every pose in builder-art.json is in
        // those units). Only a FALLBACK picture - preset art 404'd, so there are
        // no overlays anyway - is measured off the loaded bitmap.
        if (!stageFrameOk && img.naturalWidth && img.naturalHeight) stageNat = { w: img.naturalWidth, h: img.naturalHeight };
        if (gunImg) { gunImg.naturalWidth = stageNat.w; gunImg.naturalHeight = stageNat.h; }
        paintStage();
        drawWires();
        if (!stageFrameOk || !stagePlan) return;
        const urls = [];
        stagePlan.erase.concat(stagePlan.draw).forEach((e) => {
          const u = ctx.imgUrl('item512', e.id);
          if (u && urls.indexOf(u) < 0) urls.push(u);
        });
        if (!urls.length) return;
        let left = urls.length;
        urls.forEach((u) => loadImg(u, () => {
          left--;
          if (left === 0 && gen === stageGen) paintStage();
        }));
      });
    }

    function paintStage() {
      if (!gunImg || typeof gunImg.getContext !== 'function') return;
      const cssW = gunImg.clientWidth || parseFloat(gunImg.style.width) || 0;
      const cssH = gunImg.clientHeight || parseFloat(gunImg.style.height) || 0;
      if (!(cssW > 0) || !(cssH > 0)) return;
      const dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1));
      gunImg.width = Math.max(1, Math.round(cssW * dpr));
      gunImg.height = Math.max(1, Math.round(cssH * dpr));
      const g = gunImg.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cssW, cssH);
      // The BASE bitmap is already muzzle-left, the way the game draws it, so
      // only the user's FLIP touches it. The overlays below are in pose space
      // and get the extra POSE_FLIP - see the note by MIRROR_KEY.
      const flipBase = !!state.mirror;
      const flipPose = (POSE_FLIP !== !!state.mirror);
      const applyFlip = (on) => {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (on) { g.translate(cssW, 0); g.scale(-1, 1); }
      };
      applyFlip(flipBase);
      if (!stageBase) return;
      const nw = stageNat.w || stageBase.naturalWidth || 1;
      const nh = stageNat.h || stageBase.naturalHeight || 1;
      const plan = stagePlan;
      const composite = stageFrameOk && plan && plan.frame && plan.frame.w > 0;
      // S maps px8x -> css; (ox, oy) is where px8x (0, 0) lands. The layout box
      // is the EXTENT, so the frame sits inset by whatever hangs off it.
      const S = Math.min(cssW / nw, cssH / nh);
      const ext = (composite && plan.extent) ? plan.extent : { x0: 0, y0: 0, x1: nw, y1: nh };
      const ox = (cssW - nw * S) / 2 - ext.x0 * S;
      const oy = (cssH - nh * S) / 2 - ext.y0 * S;
      const fw = composite ? plan.frame.w : nw;
      const fh = composite ? plan.frame.h : nh;
      g.drawImage(stageBase, ox, oy, fw * S, fh * S);
      if (!composite) return;
      applyFlip(flipPose);
      if (plan.erase.length) {
        g.save();
        g.globalCompositeOperation = 'destination-out';
        plan.erase.forEach((e) => {
          const im = cachedImg(ctx.imgUrl('item512', e.id));
          if (im) g.drawImage(im, ox + e.x * S, oy + e.y * S, e.w * S, e.h * S);
        });
        g.restore();
      }
      plan.draw.forEach((e) => {
        const im = cachedImg(ctx.imgUrl('item512', e.id));
        if (im) g.drawImage(im, ox + e.x * S, oy + e.y * S, e.w * S, e.h * S);
      });
    }

    // ---- the slot card -------------------------------------------------------
    function card(n, pos) {
      const cls = ['wb-card', n.item ? 'filled' : 'empty', 'cls-' + slotClass(n.nameId, n.required)];
      if (n.required && !n.item) cls.push('required');
      if (n.item && conflictsOf(data.conflicts, state.gun, withoutPath(n.path), n.item).length) cls.push('conflict');
      if (state.selected === n.path) cls.push('selected');
      if (n.depth > 0) cls.push('child');
      const b = btn(cls.join(' '), null, () => openPicker(n.path));
      b.dataset.path = n.path;
      if (pos) {
        b.style.left = pos.x + 'px';
        b.style.top = pos.y + 'px';
      }
      // the mount-type glyph, outside the card's top-left corner, like the game
      const g = el('span', 'wb-card-glyph', slotGlyph(n.nameId));
      g.setAttribute('aria-hidden', 'true');
      b.appendChild(g);
      b.appendChild(el('span', 'wb-card-name', n.item ? shortOf(n.item) : 'NONE'));
      if (n.item) {
        b.appendChild(icon(n.item, 'wb-card-icon'));
        const kids = (props[n.item] && props[n.item].slots || []).filter((s) => s && !hiddenSlot(s.nameId)).length;
        const badge = el('span', 'wb-card-badge' + (kids ? ' sub' : ''), kids ? String(kids) : '');
        badge.title = kids ? kids + ' sub-slot' + (kids === 1 ? '' : 's') : slotLabel(n.nameId, n.name);
        b.appendChild(badge);
      } else {
        b.appendChild(el('span', 'wb-card-badge empty', ''));
      }
      // the custom hover card never appears on touch, so mirror it into title:
      // on a phone the "required" copy was unreachable entirely
      b.title = tipText(n).join(' - ');
      b.addEventListener('mouseenter', () => { showTip(b, n); hoverSlot(n.path, true); });
      b.addEventListener('mouseleave', () => { hideTip(); hoverSlot(n.path, false); });
      b.addEventListener('focus', () => showTip(b, n));
      b.addEventListener('blur', hideTip);
      return b;
    }

    // the tiny pictograph over a card's corner: which kind of mount it is
    function slotGlyph(nameId) {
      const k = slotKey(nameId);
      if (k === 'scope' || k === 'sight_front' || k === 'sight_rear' || k === 'nvg') return '\u25CE';
      if (k === 'mount') return '\u2261';
      if (k === 'muzzle') return '\u25B7';
      if (k === 'magazine') return '\u25AE';
      if (k === 'tactical' || k === 'flashlight') return '\u2600';
      if (k === 'stock' || k === 'pistol_grip' || k === 'foregrip') return '\u2510';
      if (k === 'launcher') return '\u25B2';
      return '\u25AB';
    }

    function hoverSlot(path, on) {
      if (!wires) return;
      const list = wires.querySelectorAll('[data-path="' + cssEsc(path) + '"]');
      for (let i = 0; i < list.length; i++) list[i].classList.toggle('hot', !!on);
    }
    function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

    function withoutPath(path) {
      const m = new Map();
      state.fitted.forEach((v, k) => { if (k !== path && k.indexOf(path + '/') !== 0) m.set(k, v); });
      return m;
    }

    // one source of truth for the hover card and the title attribute
    function tipText(n) {
      if (n.item) return [nameOf(n.item), offerText(offers().map.get(n.item))];
      const out = [slotLabel(n.nameId, n.name), n.allowed.length + ' compatible part' + (n.allowed.length === 1 ? '' : 's')];
      if (n.required) out.push('required - the gun cannot fire without it');
      return out;
    }

    function showTip(node, n) {
      clear(tip);
      const lines = tipText(n);
      tip.appendChild(el('div', 'wb-tip-name', lines[0]));
      if (lines[1]) tip.appendChild(el('div', 'wb-tip-src', lines[1]));
      if (lines[2]) tip.appendChild(el('div', 'wb-tip-req', lines[2]));
      tip.hidden = false;
      const r = node.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      tip.style.left = Math.max(4, Math.min(w.width - 236, r.left - w.left + (wrap.scrollLeft || 0))) + 'px';
      tip.style.top = (r.bottom - w.top + 6 + (wrap.scrollTop || 0)) + 'px';
    }
    function hideTip() { tip.hidden = true; }

    // The picture is drawn contain-style inside its box, so the marker has to
    // land on the DRAWN pixels, not the box - a wide pistol image sits in a
    // letterbox and the fractions are of the art, not of the frame.
    function drawnImageRect() {
      const L = layout.draw || layout.img;
      const nw = stageNat.w, nh = stageNat.h;
      if (!nw || !nh) return L;
      const s = Math.min(L.w / nw, L.h / nh);
      const w = nw * s, h = nh * s;
      return { x: L.x + (L.w - w) / 2, y: L.y + (L.h - h) / 2, w, h };
    }

    // ---- markers + leader lines ---------------------------------------------
    //
    // Vital slots get a square marker with an uppercase label and a GREEN line.
    // Everything else gets a plain white dot and a white hairline. The selected
    // slot's marker turns into a blue ring and its line goes blue. A required
    // slot with nothing in it goes red, which is EFT's own "this weapon is not
    // operational" colour language (SPEC.md section 3 flags the exact in-screen
    // rendering as UNCONFIRMED, so this stays restrained: a red marker, a red
    // dashed card border, no shouting).
    function drawWires() {
      if (!wires || !layout || state.flat) return;
      clear(wires);
      const NS = 'http://www.w3.org/2000/svg';
      // while 3D is up the fractions markerAt() returns are of the 3D HOST box,
      // not the 2D canvas, so the reference rect has to follow
      let img = drawnImageRect();
      if (state.three && state.threeOk) {
        const host = stage3dEl;
        if (host) {
          const hr = host.getBoundingClientRect(), sr = stage.getBoundingClientRect();
          img = { x: hr.left - sr.left, y: hr.top - sr.top, w: hr.width, h: hr.height };
        }
      }
      // every rect a label must miss: the cards, and the labels already drawn.
      // An M4A1 carries two handguard slots a few px apart, so without this the
      // second word prints straight through the first.
      const placed = layout.boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
      const tree = visibleTree(slotTree(props, state.gun, state.fitted));
      const byPath = {};
      layout.boxes.forEach((b) => { byPath[b.path] = b; });
      const mk = (tag) => document.createElementNS(NS, tag);
      // Two slots can carry the same word (an M4A1 has a handguard on the gun
      // AND one on the barrel) and their markers land within a few px of each
      // other, so the labels print on top of one another. Only the first one
      // gets the word; the rest get a plain dot, which is what the game shows
      // for a secondary attachment point anyway.
      const usedLabels = {};

      tree.forEach((n) => {
        const b = byPath[n.path];
        if (!b) return;
        const cls0 = slotClass(n.nameId, n.required);
        const missing = n.required && !n.item;
        let cls = 'wb-lead cls-' + cls0;
        if (state.selected === n.path) cls += ' selected';
        if (missing) cls += ' missing';

        const fromPose = markerAt(n.path);
        const a = fromPose || fallbackAt(n.nameId);
        const src = fromPose ? 'pose' : 'anchor';
        const ax = img.x + a[0] * img.w;
        const ay = img.y + a[1] * img.h;
        // the line leaves the card from the edge facing the gun
        const sx = b.x + b.w / 2;
        const sy = b.rail === 'top' ? b.y + b.h : b.y;

        const line = mk('line');
        line.setAttribute('class', cls);
        line.setAttribute('data-path', n.path);
        line.setAttribute('x1', String(sx));
        line.setAttribute('y1', String(sy));
        line.setAttribute('x2', String(ax));
        line.setAttribute('y2', String(ay));
        wires.appendChild(line);

        let label = markerLabel(n.nameId);
        if (label && usedLabels[label]) label = null;
        // ~5.8px per char at 10px Rajdhani caps, offset 9px right of the marker
        let labelDy = 4;
        if (label) {
          const box = { x: ax + 9, y: ay - 8, w: label.length * 5.8 + 4, h: 13 };
          let free = false;
          for (let k = 0; k < 4 && !free; k++) {
            const dy = [0, -13, 13, -26][k];
            box.y = ay - 8 + dy;
            free = !placed.some((p) => overlaps(box, p));
            if (free) labelDy = 4 + dy;
          }
          if (!free) label = null;
          else placed.push({ x: box.x, y: box.y, w: box.w, h: box.h });
        }
        if (label) usedLabels[label] = 1;
        if (cls0 === 'vital' && label) {
          const sq = mk('rect');
          sq.setAttribute('class', 'wb-mark square ' + cls.replace('wb-lead ', ''));
          sq.setAttribute('data-path', n.path);
          sq.setAttribute('data-src', src);
          sq.setAttribute('x', String(ax - 5));
          sq.setAttribute('y', String(ay - 5));
          sq.setAttribute('width', '10');
          sq.setAttribute('height', '10');
          wires.appendChild(sq);
          const t = mk('text');
          t.setAttribute('class', 'wb-mark-label');
          t.setAttribute('data-path', n.path);
          t.setAttribute('x', String(ax + 10));
          t.setAttribute('y', String(ay + labelDy));
          t.textContent = label;
          wires.appendChild(t);
        } else {
          const dot = mk('circle');
          dot.setAttribute('class', 'wb-mark dot ' + cls.replace('wb-lead ', ''));
          dot.setAttribute('data-path', n.path);
          dot.setAttribute('data-src', src);
          dot.setAttribute('cx', String(ax));
          dot.setAttribute('cy', String(ay));
          dot.setAttribute('r', state.selected === n.path ? '6' : '4');
          wires.appendChild(dot);
        }
      });
    }

    // ---- status --------------------------------------------------------------
    // Status is a LINE, never a block, and never over the weapon: a dot and
    // three words on a good build, the missing part names on a bad one. The old
    // green slab painted straight across the middle of the gun on a phone.
    function statusText(fullTree) {
      const miss = missingVital(fullTree);
      return miss.length
        ? { ok: false, text: 'Missing: ' + miss.map((n) => slotLabel(n.nameId, n.name)).join(', ') }
        : { ok: true, text: 'Ready to fire' };
    }
    function banner(fullTree) {
      const st = statusText(fullTree);
      const b = el('div', 'wb-banner' + (st.ok ? ' good' : ' bad'));
      b.appendChild(el('span', 'wb-dot', ''));
      b.appendChild(el('span', 'wb-banner-text', st.text));
      return b;
    }
    // the phone puts the same line ABOVE the picture instead
    function renderStatus() {
      clear(statusEl);
      statusEl.hidden = !(state.flat && state.gun);
      if (statusEl.hidden) return;
      const st = statusText(slotTree(props, state.gun, state.fitted));
      statusEl.className = 'wb-status ' + (st.ok ? 'good' : 'bad');
      statusEl.appendChild(el('span', 'wb-dot', ''));
      statusEl.appendChild(el('span', 'wb-status-text', st.text));
    }

    // ---- the 12-row stat readout --------------------------------------------
    function statRows() {
      const st = buildStats(items, props, state.gun, state.fitted, offers().map);
      const pid = referencePreset(data, props, state.gun, state.fitted, ctx.builderArt || null);
      const pp = (pid && props[pid]) || {};
      const moa = num(pp.moa, null);
      return {
        st,
        rows: weaponStatRows(items, props, state.gun, state.fitted, {
          stats: st, moa, moaFrom: pid ? shortOf(pid) + "'s figure" : null,
        }),
      };
    }

    // rows for a hypothetical build, used for the hover deltas
    function previewRows(path, id) {
      const f = fit(props, state.gun, state.fitted, path, id);
      const st = buildStats(items, props, state.gun, f, offers().map);
      const pid = referencePreset(data, props, state.gun, f, ctx.builderArt || null);
      const pp = (pid && props[pid]) || {};
      return weaponStatRows(items, props, state.gun, f, { stats: st, moa: num(pp.moa, null), moaFrom: null });
    }

    // which direction is GOOD for each row
    const HIGHER_IS_BETTER = { ergonomics: true, sighting: true, velocity: true, distance: true, durability: true };
    const LOWER_IS_BETTER = { weight: true, recoilV: true, recoilH: true, accuracy: true };

    function renderStats() {
      const base = statRows();
      const prev = state.preview ? previewRows(state.preview.path, state.preview.id) : null;
      const panel = el('div', 'wb-statpanel' + (statsCollapsed ? ' collapsed' : ''));
      const rows = el('div', 'wb-statrows');
      base.rows.forEach((r, i) => {
        const line = el('div', 'wb-statrow' + (r.value == null ? ' nodata' : ''));
        const g = el('span', 'wb-stat-glyph', STAT_GLYPH[r.key] || '\u25AA');
        g.setAttribute('aria-hidden', 'true');
        line.appendChild(g);
        line.appendChild(el('span', 'wb-stat-label', r.label));
        if (r.meter != null) {
          const bar = el('span', 'wb-stat-meter ' + (r.meterKind || 'blue'));
          const fill = el('span', 'wb-stat-fill');
          fill.style.width = Math.round(r.meter * 100) + '%';
          bar.appendChild(fill);
          line.appendChild(bar);
        }
        const v = el('span', 'wb-stat-value', r.value == null ? '-' : r.value);
        line.appendChild(v);
        if (r.value == null) line.title = 'Not in the data. ' + NOT_IN_DATA;
        else if (r.note) line.title = r.note;
        // hover delta against the candidate part the picker is showing
        if (prev && prev[i] && r.raw != null && prev[i].raw != null) {
          const d = Math.round((prev[i].raw - r.raw) * 1000) / 1000;
          if (d) {
            const good = HIGHER_IS_BETTER[r.key] ? d > 0 : (LOWER_IS_BETTER[r.key] ? d < 0 : d > 0);
            line.appendChild(el('span', 'wb-stat-delta ' + (good ? 'good' : 'bad'), (d > 0 ? '+' : '') + d));
          }
        }
        rows.appendChild(line);
      });
      // Cost is not one of the game's 12 - Tarkov never prices a build on this
      // screen. It matters here, because the whole point of this app is "what
      // does it cost me", so it rides as a 13th row under a rule.
      const costLine = el('div', 'wb-statrow wb-statrow-cost');
      const cg = el('span', 'wb-stat-glyph', '\u20BD');
      cg.setAttribute('aria-hidden', 'true');
      costLine.appendChild(cg);
      costLine.appendChild(el('span', 'wb-stat-label', 'Cost'));
      costLine.appendChild(el('span', 'wb-stat-value', ctx.formatRub(base.st.cost)));
      const notes = [];
      if (offers().synthetic) notes.push('Priced at max loyalty with the flea on. Set your levels on the Traders tab for your real cost.');
      if (base.st.unpriced.length) notes.push(base.st.unpriced.length + ' part(s) have no known source and are not in this total.');
      if (notes.length) costLine.title = notes.join(' ');
      rows.appendChild(costLine);
      panel.appendChild(rows);

      const chev = btn('wb-stat-chev', statsCollapsed ? '\u25B6' : '\u25C0', () => {
        statsCollapsed = !statsCollapsed;
        // the readout owns a rect in the layout, so collapsing it frees that
        // space for the weapon and the cards - relayout, do not just restyle
        renderStage();
      }, statsCollapsed ? 'Show the stat readout' : 'Hide the stat readout');
      panel.appendChild(chev);

      // exactly where layoutBoxes reserved it, so "no card goes here" and "the
      // panel is here" can never drift apart
      const R = layout && layout.stats;
      if (R && !state.flat) {
        panel.style.left = (R.x + 10) + 'px';
        panel.style.top = R.y + 'px';
        panel.style.bottom = 'auto';
        panel.style.width = (R.w - 20) + 'px';
      }
      if (layout && layout.statsInDock && !state.flat) panel.classList.add('collapsed', 'docked');
      if (statsEl && statsEl.parentNode) statsEl.parentNode.replaceChild(panel, statsEl);
      else stage.appendChild(panel);
      statsEl = panel;
    }
    const STAT_GLYPH = {
      durability: '\u2692', weight: '\u2696', ergonomics: '\u270B', accuracy: '\u25CE',
      sighting: '\u25C9', recoilV: '\u2195', recoilH: '\u2194', velocity: '\u27A4',
      fire: '\u25A4', caliber: '\u25AC', rate: '\u22EF', distance: '\u2197',
    };

    // The same 12 rows, laid out wide, for when the stage was too short to seat
    // the floating readout (see layoutBoxes' statsInDock).
    function dockStats() {
      const base = statRows();
      const wrapEl = el('div', 'wb-dockstats');
      base.rows.forEach((r) => {
        const cell = el('div', 'wb-dockstat' + (r.value == null ? ' nodata' : ''));
        cell.appendChild(el('span', 'wb-stat-label', r.label));
        cell.appendChild(el('span', 'wb-stat-value', r.value == null ? '-' : r.value));
        if (r.value == null) cell.title = 'Not in the data. ' + NOT_IN_DATA;
        else if (r.note) cell.title = r.note;
        wrapEl.appendChild(cell);
      });
      const cost = el('div', 'wb-dockstat');
      cost.appendChild(el('span', 'wb-stat-label', 'Cost'));
      cost.appendChild(el('span', 'wb-stat-value', ctx.formatRub(base.st.cost)));
      wrapEl.appendChild(cost);
      return wrapEl;
    }

    // ========================================================================
    // PHONE: status line, icon strip, four pills, one sheet
    // ========================================================================
    // Josia, on his iPhone, 2026-09-11: "The text is in the way. There's too
    // much going on in the screen. Make it very simple." Everything below is
    // that rule: the weapon owns the screen, status is one line, explanatory
    // copy does not exist, and every secondary control is one tap away.

    // One horizontal row of 64px icons under the weapon. No names inline - they
    // are noise at this size, and a tap says more. An empty slot is a "+" tile;
    // a required empty one wears a red ring.
    function renderStrip() {
      clear(strip);
      strip.hidden = !(state.flat && state.gun);
      if (strip.hidden) return;
      visibleTree(slotTree(props, state.gun, state.fitted)).forEach((n) => {
        const cls = ['wb-tile', n.item ? 'filled' : 'empty'];
        if (n.required && !n.item) cls.push('required');
        if (state.selected === n.path) cls.push('selected');
        const b = btn(cls.join(' '), null, () => { state.selected = n.path; renderStrip(); openSheet('picker', n.path); });
        b.dataset.path = n.path;
        if (n.item) b.appendChild(icon(n.item, 'wb-tile-icon'));
        else b.appendChild(el('span', 'wb-tile-plus', '+'));
        // the name is a tap away, and reaches a screen reader, but never inline
        b.title = n.item ? nameOf(n.item) : slotLabel(n.nameId, n.name);
        b.setAttribute('aria-label', b.title);
        strip.appendChild(b);
      });
    }

    // Four numbers, not thirteen. The full readout is one tap away.
    function renderPills() {
      clear(pills);
      pills.hidden = !(state.flat && state.gun);
      if (pills.hidden) return;
      const st = buildStats(items, props, state.gun, state.fitted, offers().map);
      const add = (k, v) => {
        const p = el('div', 'wb-pill');
        p.appendChild(el('span', 'wb-pill-k', k));
        p.appendChild(el('span', 'wb-pill-v', String(v)));
        pills.appendChild(p);
      };
      add('Ergo', st.ergo);
      add('Recoil', st.recoilV);
      add('Weight', ctx.formatWeight(st.weight));
      add('Cost', ctx.formatRub(st.cost));
      pills.title = 'All 12 stats';
      pills.setAttribute('role', 'button');
      pills.setAttribute('tabindex', '0');
    }

    // One bottom sheet, three contents. Nothing it shows is ever inline.
    //
    // The header row carries the title, the sheet's own actions and Close. The
    // part search is OPTIONAL: it is a magnifier in that row, and the one-line
    // field only appears when you ask for it, so the list starts immediately
    // under the title. (Round 6 put a full-width field above the list; the
    // shared .wb-search carries `flex: 1 1 200px` for the desktop's horizontal
    // head row, and in this COLUMN that basis became a 200px HEIGHT that then
    // grew to fill the sheet - a ~400px hole between the title and the parts.)
    function openSheet(kind, arg) {
      clear(sheet);
      sheet.hidden = false;
      const bar = el('div', 'wb-sheet-bar');
      const title = el('span', 'wb-sheet-title', '');
      const acts = el('div', 'wb-sheet-acts');
      bar.appendChild(title);
      bar.appendChild(acts);
      sheet.appendChild(bar);
      const body = el('div', 'wb-sheet-body');
      sheet.appendChild(body);
      if (kind === 'picker') fillPicker(body, acts, title, arg);
      else if (kind === 'stats') { title.textContent = 'Stats'; fillStats(body); }
      else { title.textContent = 'Menu'; fillMenu(body, acts); }
      acts.appendChild(btn('wb-sheet-x', '✕', closeSheet, 'Close'));
    }
    function closeSheet() { sheet.hidden = true; clear(sheet); }

    // the optional one-line search: an icon in the header, a 36px field below it
    function sheetSearch(acts, body, onQuery) {
      const field = document.createElement('input');
      field.type = 'search';
      field.className = 'wb-search wb-search-one';
      field.placeholder = 'Find a part';
      field.hidden = true;
      const tgl = btn('wb-sheet-icon', '⌕', () => {
        field.hidden = !field.hidden;
        tgl.classList.toggle('on', !field.hidden);
        if (field.hidden) { field.value = ''; onQuery(''); return; }
        setTimeout(() => { try { field.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ } }, 0);
      }, 'Find a part');
      acts.appendChild(tgl);
      field.addEventListener('input', () => onQuery(field.value.trim().toLowerCase()));
      body.appendChild(field);
      return { field, toggle: tgl };
    }

    function fillPicker(box, acts, title, path) {
      const tree = slotTree(props, state.gun, state.fitted);
      const n = nodeAt(tree, path);
      if (!n) return;
      title.textContent = slotLabel(n.nameId, n.name);
      if (n.item) acts.appendChild(btn('chip', 'Remove', () => { closeSheet(); fitPart(path, null); }));
      const list = el('div', 'wb-sheet-list');
      let q = '';
      sheetSearch(acts, box, (v) => { q = v; paint(); });
      box.appendChild(list);
      function paint() {
        clear(list);
        candidateRows(n, q).forEach((r) => {
          const blocked = r.conflicts.length > 0;
          const row = btn('wb-pick-row' + (blocked ? ' wb-pick-conflict' : '') + (n.item === r.id ? ' current' : ''),
            null, blocked ? null : () => { closeSheet(); fitPart(path, r.id); });
          if (blocked) { row.disabled = true; row.title = 'Conflicts with ' + r.conflicts.map(shortOf).join(', '); }
          row.appendChild(icon(r.id, 'wb-pick-icon'));
          const mid = el('div', 'wb-pick-mid');
          mid.appendChild(el('div', 'wb-pick-name', r.it.n));
          row.appendChild(mid);
          const right = el('div', 'wb-pick-right');
          if (r.ergo) right.appendChild(el('span', 'wb-pick-stat ' + (r.ergo > 0 ? 'good' : 'bad'), (r.ergo > 0 ? '+' : '') + r.ergo));
          if (r.recoil) right.appendChild(el('span', 'wb-pick-stat ' + (r.recoil < 0 ? 'good' : 'bad'), Math.round(r.recoil * 100) + '%'));
          right.appendChild(el('span', 'wb-pick-price', r.o ? ctx.formatRub(r.o.rub) : ''));
          row.appendChild(right);
          list.appendChild(row);
        });
      }
      paint();
    }

    function fillStats(box) {
      const base = statRows();
      base.rows.forEach((r) => {
        const line = el('div', 'wb-sheet-stat' + (r.value == null ? ' nodata' : ''));
        line.appendChild(el('span', 'wb-stat-label', r.label));
        line.appendChild(el('span', 'wb-stat-value', r.value == null ? '-' : r.value));
        if (r.value == null) line.title = 'Not in the data. ' + NOT_IN_DATA;
        else if (r.note) line.title = r.note;
        box.appendChild(line);
      });
      const cost = el('div', 'wb-sheet-stat');
      cost.appendChild(el('span', 'wb-stat-label', 'Cost'));
      cost.appendChild(el('span', 'wb-stat-value', ctx.formatRub(base.st.cost)));
      box.appendChild(cost);
    }

    // Every control the desktop sidebar and header carry, in one list, plus the
    // whole-weapon part search - which is the phone's "Find a part".
    function fillMenu(box, acts) {
      const found = el('div', 'wb-sheet-list');
      const search = sheetSearch(acts, box, (q) => {
        clear(found);
        if (q.length < 2) return;
        const off = offers().map;
        const direct = directSlots(props, items, state.gun, state.fitted);
        const rows = [];
        reachIndex().forEach((chains, id) => {
          const it = items[id];
          if (!it || matchRank(it.n, it.s, q) < 0) return;
          rows.push({ id, it, o: off.get(id) });
        });
        rows.slice(0, 30).forEach((r) => {
          const chain = candidatesFor(r.id, direct)[0];
          if (!chain) return;
          const row = btn('wb-pick-row', null, () => { closeSheet(); applyChain(chain); });
          row.appendChild(icon(r.id, 'wb-pick-icon'));
          const mid = el('div', 'wb-pick-mid');
          mid.appendChild(el('div', 'wb-pick-name', r.it.n));
          row.appendChild(mid);
          row.appendChild(el('span', 'wb-pick-price', r.o ? ctx.formatRub(r.o.rub) : ''));
          found.appendChild(row);
        });
      });
      box.appendChild(found);

      const rows = el('div', 'wb-menu-list');
      const item = (label, fn, opts) => {
        const o = opts || {};
        const b = btn('wb-menu-row' + (o.on ? ' on' : '') + (o.danger ? ' danger' : ''), label, fn);
        if (o.disabled) b.disabled = true;
        rows.appendChild(b);
      };
      // the same field the magnifier opens, reachable as a named row
      item('Find a part', () => { if (search.field.hidden) search.toggle.click(); });
      item('Select weapon', () => { closeSheet(); openGunPicker(); });
      item('New build', () => {
        closeSheet();
        state.fitted = new Map(); state.selected = null;
        state.buildId = null; state.buildName = ''; state.note = '';
        renderAll();
      });
      item('Open', () => { closeSheet(); state.drawer = true; renderDrawer(); });
      item('Save', () => { closeSheet(); saveBuild(false); });
      item('Share', () => { closeSheet(); shareBuild(); });
      item('Delete build', () => { closeSheet(); deleteBuild(); }, { danger: true, disabled: !state.buildId });
      SLOT_CLASSES.forEach((k) => {
        const label = k === 'vital' ? 'Vital parts' : (k === 'functional' ? 'Functional mods' : 'Gear mods');
        item(label, () => { state.show[k] = !state.show[k]; renderStrip(); openSheet('menu'); }, { on: state.show[k] });
      });
      item('Flip', () => {
        state.mirror = !state.mirror;
        writeStore(MIRROR_KEY, state.mirror);
        renderStage();
        openSheet('menu');
      }, { on: state.mirror });
      if (state.threeSupported) item('3D', () => { closeSheet(); toggleThree(); }, { on: state.three });
      box.appendChild(rows);
    }

    // ---- the part picker -----------------------------------------------------
    function openPicker(path) {
      if (state.flat) { state.selected = path; renderStrip(); openSheet('picker', path); return; }
      state.selected = path;
      state.picker = path;
      state.find = false;
      state.wantFocus = true;
      state.query = '';
      state.preview = null;
      renderSide();
      renderStage();
      renderCompat();
      renderDock();
      openPop(path);
    }

    function closePicker() {
      state.picker = null;
      state.preview = null;
      closePop();
      compat.hidden = true;
      clear(compat);
      renderStage();
      renderDock();
    }

    function closePop() { pop.hidden = true; clear(pop); }

    // candidate rows for a slot, sorted the way the picker's sort says
    function candidateRows(n, q) {
      const off = offers().map;
      const rows = compatible(n, items, data.conflicts, state.gun, state.fitted)
        .map((c) => {
          const it = items[c.id];
          const p = props[c.id] || {};
          const o = off.get(c.id);
          return {
            id: c.id, it, p, o, conflicts: c.conflicts, rank: matchRank(it.n, it.s, q),
            ergo: num(p.ergonomics, 0), recoil: num(p.recoilModifier, 0),
            price: o ? num(o.rub, Infinity) : Infinity,
          };
        })
        .filter((r) => r.rank >= 0);
      rows.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (state.sort === 'ergo') return b.ergo - a.ergo || a.recoil - b.recoil;
        if (state.sort === 'recoil') return a.recoil - b.recoil || b.ergo - a.ergo;
        if (state.sort === 'price') return a.price - b.price || b.ergo - a.ergo;
        return String(a.it.n).localeCompare(String(b.it.n));
      });
      return rows;
    }

    function fitPart(path, id) {
      state.fitted = fit(props, state.gun, state.fitted, path, id);
      state.picker = null;
      state.preview = null;
      state.selected = path;
      closePop();
      compat.hidden = true;
      clear(compat);
      renderAll();
    }

    // (a) the compact floating card grid, anchored beside the slot you clicked
    function openPop(path) {
      if (state.flat) { closePop(); return; }
      const tree = slotTree(props, state.gun, state.fitted);
      const n = nodeAt(tree, path);
      if (!n) { closePop(); return; }
      clear(pop);
      pop.hidden = false;
      const top = el('div', 'wb-pop-head');
      top.appendChild(el('span', 'wb-pop-title', slotLabel(n.nameId, n.name)));
      if (n.item) top.appendChild(btn('wb-pop-x', 'Remove', () => fitPart(path, null), 'Empty this slot'));
      top.appendChild(btn('wb-pop-x', '\u2715', closePicker, 'Close'));
      pop.appendChild(top);

      const grid = el('div', 'wb-pop-grid');
      const rows = candidateRows(n, '');
      if (!rows.length) grid.appendChild(el('div', 'detail-empty', 'Nothing fits this slot.'));
      rows.slice(0, 12).forEach((r) => {
        const blocked = r.conflicts.length > 0;
        const c = btn('wb-pop-card' + (blocked ? ' blocked' : '') + (n.item === r.id ? ' current' : ''),
          null, blocked ? null : () => fitPart(path, r.id));
        if (blocked) { c.disabled = true; c.title = 'Conflicts with ' + r.conflicts.map(shortOf).join(', '); }
        else c.title = r.it.n + (r.o ? ' - ' + offerText(r.o) : ' - no known source');
        const head2 = el('div', 'wb-pop-cardhead');
        head2.appendChild(el('span', 'wb-pop-name', shortOf(r.id)));
        head2.appendChild(el('span', 'wb-pop-price' + (r.o ? '' : ' none'), r.o ? shortRub(r.o.rub) : '-'));
        c.appendChild(head2);
        c.appendChild(icon(r.id, 'wb-pop-icon'));
        const chips = el('div', 'wb-pop-chips');
        if (r.ergo) chips.appendChild(el('span', 'wb-chip ' + (r.ergo > 0 ? 'good' : 'bad'), (r.ergo > 0 ? '+' : '') + r.ergo));
        if (r.recoil) chips.appendChild(el('span', 'wb-chip ' + (r.recoil < 0 ? 'good' : 'bad'), (r.recoil > 0 ? '+' : '') + Math.round(r.recoil * 100) + '%'));
        c.appendChild(chips);
        c.addEventListener('mouseenter', () => { state.preview = { path, id: r.id }; renderStats(); });
        c.addEventListener('mouseleave', () => { state.preview = null; renderStats(); });
        grid.appendChild(c);
      });
      pop.appendChild(grid);
      if (rows.length > 12) pop.appendChild(el('div', 'wb-pop-more', rows.length - 12 + ' more in the list on the right'));

      // anchor it to the card, kept inside the wrap
      const cardEl = stage.querySelector('.wb-card[data-path="' + cssEsc(path) + '"]');
      const w = wrap.getBoundingClientRect();
      if (cardEl) {
        const r = cardEl.getBoundingClientRect();
        const pw = 300, ph = 280;
        let left = r.left - w.left + (wrap.scrollLeft || 0);
        let top2 = r.bottom - w.top + (wrap.scrollTop || 0) + 6;
        // the docked list overlays the right edge while the picker is open, so
        // the popup has to stay clear of it
        const rightEdge = w.width - (compat.hidden ? 12 : 342);
        left = Math.max(6, Math.min(left, rightEdge - pw));
        if (top2 + ph > (wrap.scrollTop || 0) + w.height) top2 = Math.max(6, r.top - w.top + (wrap.scrollTop || 0) - ph - 6);
        pop.style.left = left + 'px';
        pop.style.top = top2 + 'px';
      } else {
        pop.style.left = '24px';
        pop.style.top = '80px';
      }
    }

    // (b) the docked COMPATIBLE ITEMS list on the right edge. The game splits
    // it Stash / Buy; there is no stash in this app, so the group is BUY and
    // it reuses the same Where-to-buy pricing the rest of the hub uses.
    function renderCompat() {
      clear(compat);
      // BACK sits bottom-right and the docked list overlays that corner, so the
      // wrap carries the state and the stylesheet moves BACK out from under it
      wrap.classList.toggle('picking', !!(state.picker && !state.flat));
      if (!state.picker || state.flat) { compat.hidden = true; return; }
      const tree = slotTree(props, state.gun, state.fitted);
      const n = nodeAt(tree, state.picker);
      if (!n) { compat.hidden = true; return; }
      compat.hidden = false;
      const top = el('div', 'wb-compat-head');
      top.appendChild(el('h3', null, 'Compatible items'));
      top.appendChild(el('span', 'wb-compat-slot', slotLabel(n.nameId, n.name) + ' on ' + shortOf(n.holder)));
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'wb-search';
      search.placeholder = 'Search compatible parts';
      search.value = state.query;
      top.appendChild(search);
      const sort = document.createElement('select');
      sort.className = 'wb-sort';
      [['ergo', 'Best ergo'], ['recoil', 'Best recoil'], ['price', 'Cheapest'], ['name', 'Name']].forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o[0];
        opt.textContent = o[1];
        if (state.sort === o[0]) opt.selected = true;
        sort.appendChild(opt);
      });
      top.appendChild(sort);
      const acts = el('div', 'wb-compat-acts');
      if (n.item) acts.appendChild(btn('chip', 'Remove', () => fitPart(state.picker, null)));
      acts.appendChild(btn('chip', 'Find parts', () => {
        state.find = true; state.wantFindFocus = true; closePicker(); renderSide(); renderDock();
      }, 'Search every part this weapon can take, including ones needing another part first'));
      acts.appendChild(btn('chip', 'Close', closePicker));
      top.appendChild(acts);
      compat.appendChild(top);

      compat.appendChild(el('div', 'wb-compat-group', 'Buy'));
      const list = el('div', 'wb-compat-list');
      compat.appendChild(list);

      function paint() {
        clear(list);
        const rows = candidateRows(n, state.query.trim().toLowerCase());
        if (!rows.length) { list.appendChild(el('div', 'detail-empty', state.query ? 'No compatible part matches.' : 'Nothing fits this slot.')); return; }
        rows.forEach((r) => {
          const blocked = r.conflicts.length > 0;
          const row = btn('wb-pick-row' + (blocked ? ' wb-pick-conflict' : '') + (n.item === r.id ? ' current' : ''),
            null, blocked ? null : () => fitPart(state.picker, r.id));
          if (blocked) row.disabled = true;
          row.appendChild(icon(r.id, 'wb-pick-icon'));
          const mid = el('div', 'wb-pick-mid');
          mid.appendChild(el('div', 'wb-pick-name', r.it.n));
          const sub = [];
          if (blocked) sub.push('conflicts with ' + r.conflicts.map(shortOf).join(', '));
          else if (n.item === r.id) sub.push('fitted');
          const childSlots = (r.p.slots || []).filter((s) => s && !hiddenSlot(s.nameId)).length;
          if (childSlots) sub.push('+' + childSlots + ' slot' + (childSlots === 1 ? '' : 's'));
          mid.appendChild(el('div', 'muted wb-pick-sub', sub.join(' - ')));
          row.appendChild(mid);
          const right = el('div', 'wb-pick-right');
          if (r.ergo) right.appendChild(el('span', 'wb-pick-stat ' + (r.ergo > 0 ? 'good' : 'bad'), (r.ergo > 0 ? '+' : '') + r.ergo + ' ergo'));
          if (r.recoil) right.appendChild(el('span', 'wb-pick-stat ' + (r.recoil < 0 ? 'good' : 'bad'), (r.recoil > 0 ? '+' : '') + Math.round(r.recoil * 100) + '% recoil'));
          right.appendChild(el('span', 'wb-pick-price', r.o ? ctx.formatRub(r.o.rub) : ''));
          right.appendChild(sourceTag(r.o));
          row.appendChild(right);
          if (!blocked) {
            row.addEventListener('mouseenter', () => { state.preview = { path: state.picker, id: r.id }; renderStats(); });
            row.addEventListener('mouseleave', () => { state.preview = null; renderStats(); });
          }
          list.appendChild(row);
        });
      }
      search.addEventListener('input', () => { state.query = search.value; paint(); if (!state.flat) openPop(state.picker); });
      sort.addEventListener('change', () => { state.sort = sort.value; paint(); openPop(state.picker); });
      paint();
      if (state.wantFocus) {
        state.wantFocus = false;
        setTimeout(() => { try { search.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ } }, 0);
      }
    }

    // ---- dock: find / info / gun picker --------------------------------------
    function renderDock() {
      clear(dock);
      dock.hidden = !!(state.flat && state.gun);
      if (dock.hidden) return;
      if (!state.gun) { renderGunPicker(); return; }
      if (state.note) dock.appendChild(el('p', 'wb-note warn', state.note));
      if (layout && layout.statsInDock && !state.flat) dock.appendChild(dockStats());
      if (state.find) { dock.appendChild(findPanel()); return; }
      // on a phone the picker has nowhere to float, so it becomes a sheet in
      // the dock - same rows, same behaviour
      if (state.picker && state.flat) { renderSheet(); return; }
      renderInfo();
    }

    function renderSheet() {
      const tree = slotTree(props, state.gun, state.fitted);
      const n = nodeAt(tree, state.picker);
      if (!n) { state.picker = null; renderInfo(); return; }
      const panel = el('div', 'wb-picker wb-sheet');
      const top = el('div', 'wb-picker-head');
      top.appendChild(el('h3', null, slotLabel(n.nameId, n.name)));
      top.appendChild(el('span', 'muted wb-crumb', 'on ' + shortOf(n.holder)));
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'wb-search';
      search.placeholder = 'Search compatible parts';
      search.value = state.query;
      top.appendChild(search);
      if (n.item) top.appendChild(btn('chip', 'Remove', () => fitPart(state.picker, null)));
      top.appendChild(btn('chip', 'Close', closePicker));
      panel.appendChild(top);
      const list = el('div', 'wb-pick-list');
      panel.appendChild(list);
      function paint() {
        clear(list);
        const rows = candidateRows(n, state.query.trim().toLowerCase());
        if (!rows.length) { list.appendChild(el('div', 'detail-empty', 'Nothing fits this slot.')); return; }
        rows.forEach((r) => {
          const blocked = r.conflicts.length > 0;
          const row = btn('wb-pick-row' + (blocked ? ' wb-pick-conflict' : '') + (n.item === r.id ? ' current' : ''),
            null, blocked ? null : () => fitPart(state.picker, r.id));
          if (blocked) row.disabled = true;
          row.appendChild(icon(r.id, 'wb-pick-icon'));
          const mid = el('div', 'wb-pick-mid');
          mid.appendChild(el('div', 'wb-pick-name', r.it.n));
          const sub = [];
          if (blocked) sub.push('conflicts with ' + r.conflicts.map(shortOf).join(', '));
          else if (n.item === r.id) sub.push('fitted');
          mid.appendChild(el('div', 'muted wb-pick-sub', sub.join(' - ')));
          row.appendChild(mid);
          const right = el('div', 'wb-pick-right');
          if (r.ergo) right.appendChild(el('span', 'wb-pick-stat ' + (r.ergo > 0 ? 'good' : 'bad'), (r.ergo > 0 ? '+' : '') + r.ergo + ' ergo'));
          if (r.recoil) right.appendChild(el('span', 'wb-pick-stat ' + (r.recoil < 0 ? 'good' : 'bad'), (r.recoil > 0 ? '+' : '') + Math.round(r.recoil * 100) + '% recoil'));
          right.appendChild(el('span', 'wb-pick-price', r.o ? ctx.formatRub(r.o.rub) : ''));
          right.appendChild(sourceTag(r.o));
          row.appendChild(right);
          list.appendChild(row);
        });
      }
      search.addEventListener('input', () => { state.query = search.value; paint(); });
      paint();
      dock.appendChild(panel);
      if (state.wantFocus) {
        state.wantFocus = false;
        setTimeout(() => { try { panel.scrollIntoView({ block: 'start' }); } catch (e) { /* older webview */ } }, 0);
      }
    }

    // ---- find a part: the prerequisite-aware search ---------------------------
    //
    // A slot only EXISTS once its holder is fitted, so a player who does not
    // already know that the SOCOM suppressor rides on a SOCOM adapter cannot
    // find it anywhere in the UI. This lists every part the gun can take at
    // any depth and fits the chain that gets there.
    function reachIndex() {
      if (!state.gun) return new Map();
      if (!state.reach || state.reachGun !== state.gun) {
        const defParts = new Set();
        const gp = props[state.gun] || {};
        if (gp.defaultPreset && data.presets.has(gp.defaultPreset)) {
          (data.presets.get(gp.defaultPreset).parts || []).forEach((pair) => defParts.add(pair[0]));
        }
        // one stable opts object per gun, so the reachableChains cache hits
        state.reachOpts = { defaultParts: defParts, offers: offers().map };
        state.reach = reachableChains(props, items, state.gun, state.reachOpts);
        state.reachGun = state.gun;
      }
      return state.reach;
    }

    function chainCrumbs(chain) {
      const out = [slotLabel(chain[0].slotNameId, '')];
      chain.forEach((s) => out.push(shortOf(s.itemId)));
      return out.join(' -> ');
    }
    function chainFull(chain) {
      return chain.map((s) => slotLabel(s.slotNameId, '') + ': ' + nameOf(s.itemId)).join('  ->  ');
    }

    // Every way to get this part onto THIS build, best first: the slots the
    // current tree already offers (zero prerequisites - exactly what the slot
    // picker would show), then the shortest chains from the bare gun. The
    // finder takes the first route the build does not conflict with.
    function candidatesFor(id, direct) {
      const seen = {};
      const out = [];
      const push = (c) => {
        if (!c || !c.length) return;
        const k = c.map((st) => st.path + '=' + st.itemId).join('|');
        if (seen[k]) return;
        seen[k] = 1;
        out.push(c);
      };
      (direct.get(id) || []).forEach(push);
      (reachIndex().get(id) || []).forEach(push);
      return out;
    }

    function applyChain(chain) {
      const plan = planFit(props, state.gun, state.fitted, chain, data.conflicts);
      state.fitted = plan.fitted;
      const last = chain[chain.length - 1];
      state.selected = last ? last.path : null;
      state.picker = null;
      state.find = false;
      state.findQuery = '';
      state.note = plan.replaced.length
        ? 'Fitted ' + shortOf(last.itemId) + '. Replaced ' + plan.replaced.map((r) => shortOf(r.from) + ' with ' + shortOf(r.to)).join(', ') + '.'
        : '';
      renderAll();
    }

    function findPanel() {
      const panel = el('div', 'wb-picker wb-find');
      const top = el('div', 'wb-picker-head');
      if (!state.flat) top.appendChild(el('h3', null, 'Find a part'));
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'wb-search';
      search.placeholder = 'Find a part';
      search.value = state.findQuery;
      top.appendChild(search);
      if (state.find) top.appendChild(btn('chip', 'Close', () => { state.find = false; renderSide(); renderDock(); }));
      panel.appendChild(top);
      const list = el('div', 'wb-pick-list');
      panel.appendChild(list);

      function paint() {
        clear(list);
        const index = reachIndex();
        const q = state.findQuery.trim().toLowerCase();
        // no explanatory paragraph, anywhere, on any viewport - an empty list
        // under a search box already says what to do
        if (q.length < 2) { void index; return; }
        const off = offers().map;
        const direct = directSlots(props, items, state.gun, state.fitted);
        const rows = [];
        index.forEach((chains, id) => {
          const it = items[id];
          if (!it) return;
          const rank = matchRank(it.n, it.s, q);
          if (rank < 0) return;
          rows.push({ id, it, rank, p: props[id] || {}, o: off.get(id),
            need: direct.has(id) ? 0 : chainNeed(state.fitted, chains[0]) });
        });
        rows.sort((a, b) => a.rank - b.rank || a.need - b.need || String(a.it.n).localeCompare(String(b.it.n)));
        if (!rows.length) { list.appendChild(el('div', 'detail-empty', 'No part this weapon can take matches.')); return; }
        const shown = rows.slice(0, 40);
        shown.forEach((r) => {
          // try every route and take the first this build allows; a row is only
          // blocked when ALL of them conflict
          const cands = candidatesFor(r.id, direct);
          let chain = null, plan = null;
          for (let i = 0; i < cands.length; i++) {
            const t = planFit(props, state.gun, state.fitted, cands[i], data.conflicts);
            if (!plan) { plan = t; chain = cands[i]; }
            if (t.ok) { plan = t; chain = cands[i]; break; }
          }
          if (!chain || !plan) return;
          const blocked = !plan.ok;
          // "needs N first" has to match what fitting will actually CHANGE -
          // the receiver and barrel in the RC2 chain are already on the gun
          const need = chainNeed(state.fitted, chain);
          const last = chain[chain.length - 1];
          const already = state.fitted.get(last.path) === r.id;
          const row = btn('wb-pick-row' + (blocked ? ' wb-pick-conflict' : '') + (already ? ' current' : ''), null,
            blocked ? null : () => applyChain(chain));
          if (blocked) row.disabled = true;
          row.title = chainFull(chain);
          row.appendChild(icon(r.id, 'wb-pick-icon'));
          const mid = el('div', 'wb-pick-mid');
          const nameRow = el('div', 'wb-pick-name', r.it.n);
          if (need > 0) nameRow.appendChild(el('span', 'wb-need', 'needs ' + need + ' first'));
          mid.appendChild(nameRow);
          // the chain stays visible even when blocked - a conflict message that
          // REPLACED it hid the one thing the row exists to explain
          mid.appendChild(el('div', 'muted wb-pick-sub wb-chain', chainCrumbs(chain)));
          if (blocked) mid.appendChild(el('div', 'wb-blocked', 'conflicts with ' + plan.conflicts.map(shortOf).join(', ')));
          row.appendChild(mid);
          const right = el('div', 'wb-pick-right');
          const ergo = num(r.p.ergonomics, 0), recoil = num(r.p.recoilModifier, 0);
          if (ergo) right.appendChild(el('span', 'wb-pick-stat ' + (ergo > 0 ? 'good' : 'bad'), (ergo > 0 ? '+' : '') + ergo + ' ergo'));
          if (recoil) right.appendChild(el('span', 'wb-pick-stat ' + (recoil < 0 ? 'good' : 'bad'), (recoil > 0 ? '+' : '') + Math.round(recoil * 100) + '% recoil'));
          right.appendChild(el('span', 'wb-pick-price', r.o ? ctx.formatRub(r.o.rub) : ''));
          right.appendChild(sourceTag(r.o));
          if (!blocked) {
            right.appendChild(el('span', 'wb-fit', already ? 'Fitted' : (need > 0 ? 'Fit + ' + need + ' prerequisite' + (need === 1 ? '' : 's') : 'Fit')));
          }
          row.appendChild(right);
          list.appendChild(row);
        });
        if (rows.length > shown.length) list.appendChild(el('div', 'muted wb-note', rows.length - shown.length + ' more match - keep typing to narrow it down.'));
      }
      search.addEventListener('input', () => { state.findQuery = search.value; paint(); });
      paint();
      if (state.wantFindFocus) {
        state.wantFindFocus = false;
        // on a 390px phone the dock sits below a very tall flat slot list, so
        // the panel opens off screen unless we go to it
        setTimeout(() => {
          // Only on a phone, where the dock genuinely sits below a tall stage.
          // On a desktop this scrolled the whole top row of cards out of view
          // the moment Find a part was opened.
          if (state.flat) { try { panel.scrollIntoView({ block: 'start' }); } catch (e) { /* older webview */ } }
          try { search.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ }
        }, 0);
      }
      return panel;
    }

    function openGunPicker() {
      state.wantFocus = true;
      state.gun = null;
      state.find = false;
      state.findQuery = '';
      state.reach = null;
      state.reachGun = null;
      state.fitted = new Map();
      state.buildId = null;
      state.buildName = '';
      state.note = '';
      state.drawer = false;
      closePop();
      compat.hidden = true;
      clear(compat);
      renderAll();
    }

    // "D-60", "D 60" and "60 round" all mean the same magazine to a player, and
    // none of them matched: the shared ranker is a literal substring test, so a
    // hyphen the item name spells differently threw the whole query away.
    function loose(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
    function looseHit(name, short, q) {
      const hay = loose(name) + ' ' + loose(short);
      const terms = loose(q).split(' ').filter(Boolean);
      if (!terms.length) return false;
      return terms.every((t) => hay.indexOf(t) >= 0);
    }
    function matchRank(name, short, q) {
      const hi = hubItems();
      if (hi && hi.matchRank) {
        const r = hi.matchRank(name, short, q);
        if (r >= 0) return r;
        // fall through to the loose pass rather than reporting "no match"
        return looseHit(name, short, q) ? 9 : -1;
      }
      if (!q) return 0;
      return looseHit(name, short, q) ? 1 : -1;
    }

    function renderGunPicker() {
      const panel = el('div', 'wb-picker');
      const top = el('div', 'wb-picker-head');
      top.appendChild(el('h3', null, 'Select weapon'));
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'wb-search';
      search.placeholder = 'Search ' + guns.length + ' weapons';
      search.value = state.gunQuery;
      top.appendChild(search);
      panel.appendChild(top);
      const list = el('div', 'wb-pick-list');
      panel.appendChild(list);
      function paint() {
        clear(list);
        const q = state.gunQuery.trim().toLowerCase();
        const cats = (ctx.categories && ctx.categories.itemCategories) || {};
        let shown = 0;
        guns.forEach((id) => {
          const it = items[id];
          if (matchRank(it.n, it.s, q) < 0) return;
          shown++;
          const p = props[id] || {};
          const cat = (cats[it.cat] && cats[it.cat].name) || '';
          const slotCount = (p.slots || []).filter((s) => s && !hiddenSlot(s.nameId)).length;
          const row = btn('wb-pick-row', null, () => chooseGun(id));
          row.appendChild(icon(id, 'wb-pick-icon'));
          const mid = el('div', 'wb-pick-mid');
          mid.appendChild(el('div', 'wb-pick-name', it.n));
          mid.appendChild(el('div', 'muted wb-pick-sub', [cat, p.caliber ? String(p.caliber).replace('Caliber', '') : '', slotCount + ' slots'].filter(Boolean).join(' - ')));
          row.appendChild(mid);
          const right = el('div', 'wb-pick-right');
          // defaultErgonomics/defaultRecoilVertical are null for every weapon in the
          // data (see buildStats above) - use the factory default preset's own
          // numbers first, falling back to the gun's own ergonomics/recoilVertical.
          const dp = (p.defaultPreset && props[p.defaultPreset]) || {};
          const pickErgo = firstNum(dp.ergonomics, p.ergonomics);
          const pickRecoilV = firstNum(dp.recoilVertical, p.recoilVertical);
          right.appendChild(el('span', 'wb-pick-stat', 'ergo ' + (pickErgo != null ? pickErgo : 0)));
          right.appendChild(el('span', 'wb-pick-stat', 'recoil ' + (pickRecoilV != null ? pickRecoilV : 0)));
          right.appendChild(sourceTag(offers().map.get(id)));
          row.appendChild(right);
          list.appendChild(row);
        });
        if (!shown) list.appendChild(el('div', 'detail-empty', 'No weapon matches.'));
      }
      search.addEventListener('input', () => { state.gunQuery = search.value; paint(); });
      paint();
      if (state.wantFocus) {
        state.wantFocus = false;
        setTimeout(() => { try { search.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ } }, 0);
      }
      if (state.note) dock.appendChild(el('p', 'wb-note warn', state.note));
      dock.appendChild(panel);
      if (!data.ok) dock.appendChild(el('p', 'muted wb-note', 'Preset data (builder.json) is missing - you can still build from scratch; factory presets and conflict checks are off.'));
    }

    function chooseGun(id) {
      state.gun = id;
      state.fitted = new Map();
      state.selected = null;
      state.picker = null;
      state.find = false;
      state.findQuery = '';
      state.buildId = null;
      state.buildName = '';
      state.note = '';
      // start from the factory default, like the game's own "default" build
      const p = props[id] || {};
      if (p.defaultPreset && data.presets.has(p.defaultPreset)) {
        const r = placeParts(props, id, data.presets.get(p.defaultPreset).parts);
        state.fitted = r.fitted;
        if (r.unplaced.length) state.note = unplacedCount(r.unplaced) + ' default part(s) could not be placed.';
      }
      renderAll();
    }

    function loadPreset(pid) {
      const p = data.presets.get(pid);
      if (!p) return;
      const r = placeParts(props, state.gun, p.parts);
      state.fitted = r.fitted;
      state.selected = null;
      state.picker = null;
      state.note = r.unplaced.length ? unplacedCount(r.unplaced) + ' preset part(s) could not be placed and were skipped: ' + r.unplaced.map((u) => nameOf(u[0])).join(', ') : '';
      renderAll();
    }

    // The "where do I buy this" strip. For the selected part, or the gun.
    function renderInfo() {
      const tree = slotTree(props, state.gun, state.fitted);
      const n = state.selected ? nodeAt(tree, state.selected) : null;
      const id = n ? (n.item || null) : state.gun;
      const panel = el('div', 'wb-info');
      if (!id) {
        const e = el('div', 'wb-info-empty');
        e.appendChild(el('div', 'detail-empty', slotLabel(n.nameId, n.name) + ' is empty - pick a part to see where to buy it.'));
        e.appendChild(btn('chip on', 'Pick a part', () => openPicker(state.selected)));
        panel.appendChild(e);
        dock.appendChild(panel);
        return;
      }
      const it = items[id] || {};
      const p = props[id] || {};
      const off = offers().map.get(id);
      const isTheGun = id === state.gun && !n;

      const headRow = el('div', 'wb-info-head');
      headRow.appendChild(icon(id, 'wb-info-icon'));
      const text = el('div', 'wb-info-text');
      text.appendChild(el('h3', null, it.n || id));
      const facts = el('div', 'detail-facts');
      facts.appendChild(el('span', null, n ? slotLabel(n.nameId, n.name) : 'Base weapon'));
      facts.appendChild(el('span', null, (it.w || 1) + 'x' + (it.h || 1)));
      facts.appendChild(el('span', null, ctx.formatWeight(it.wt)));
      if (!isTheGun && num(p.ergonomics, 0)) facts.appendChild(el('span', num(p.ergonomics, 0) > 0 ? 'good' : 'bad', (p.ergonomics > 0 ? '+' : '') + p.ergonomics + ' ergo'));
      if (num(p.recoilModifier, 0)) facts.appendChild(el('span', p.recoilModifier < 0 ? 'good' : 'bad', (p.recoilModifier > 0 ? '+' : '') + Math.round(p.recoilModifier * 100) + '% recoil'));
      if (num(p.accuracyModifier, 0)) facts.appendChild(el('span', null, (p.accuracyModifier > 0 ? '+' : '') + Math.round(p.accuracyModifier * 100) + '% accuracy'));
      if (isTheGun && p.caliber) facts.appendChild(el('span', null, String(p.caliber).replace('Caliber', '')));
      if (isTheGun && p.fireRate) facts.appendChild(el('span', null, p.fireRate + ' rpm'));
      text.appendChild(facts);
      const btns = el('div', 'wb-info-btns');
      if (it.wiki) btns.appendChild(btn('wiki-btn', 'Wiki', () => { if (ctx.api && ctx.api.openExternal) ctx.api.openExternal(it.wiki); }));
      btns.appendChild(btn('wiki-btn', 'Open in Items', () => ctx.go('items', id)));
      if (n) btns.appendChild(btn('wiki-btn', 'Change part', () => openPicker(n.path)));
      text.appendChild(btns);
      headRow.appendChild(text);
      panel.appendChild(headRow);

      // ---- where to buy ----
      const buy = el('div', 'wb-buy');
      buy.appendChild(el('h4', null, 'Where to buy'));
      const t = el('table', 'trade-table wb-buy-table');
      const body = document.createElement('tbody');
      const prof = effectiveProfile();
      const lvlOf = (tid) => num((prof.traderLevels || {})[tid], null);
      let any = false;
      (Array.isArray(it.buy) ? it.buy.slice() : []).sort((a, b) => num(a.rub, 0) - num(b.rub, 0)).forEach((b) => {
        any = true;
        const tr = document.createElement('tr');
        const have = lvlOf(b.t);
        const need = num(b.lvl, 1);
        const levelLocked = !prof.synthetic && have != null && have < need;
        const taskLocked = !!b.task && !(ctx.questState && ctx.questState[b.task] === 'complete');
        const best = off && off.source === 'trader' && off.trader === b.t && num(off.lvl, 1) === need;
        tr.className = (best ? 'best ' : '') + ((levelLocked || (taskLocked && !prof.synthetic)) ? 'locked' : '');
        tr.appendChild(el('td', null, traderName(b.t) + ' LL' + need));
        const isRub = String(b.cur || 'RUB').toUpperCase() === 'RUB';
        tr.appendChild(el('td', null, ctx.formatCurrency(b.price, b.cur) + (isRub ? '' : ' (' + ctx.formatRub(b.rub) + ')')));
        const notes = [];
        if (b.task) notes.push('after ' + (questName(b.task) || 'a task'));
        if (levelLocked) notes.push('you are LL' + have);
        if (num(b.limit, 0) > 0) notes.push('limit ' + b.limit);
        if (best) notes.push('cheapest');
        tr.appendChild(el('td', 'muted', notes.join(' - ')));
        body.appendChild(tr);
      });
      if (it.flea && num(it.flea.avg, null) != null) {
        any = true;
        const tr = document.createElement('tr');
        const min = num(it.flea.minLvl, null);
        const locked = !prof.synthetic && min != null && prof.playerLevel != null && prof.playerLevel < min;
        tr.className = (off && off.source === 'flea' ? 'best ' : '') + (locked ? 'locked' : '');
        tr.appendChild(el('td', null, 'Flea market'));
        const fleaAvg = num(it.flea.avg, null);
        const fleaLow = num(it.flea.low, null);
        // "low" is only meaningful (and only shown) when it is actually below
        // the headline avg - a stale/illiquid scan can put lastLow above avg24h.
        tr.appendChild(el('td', null, ctx.formatRub(fleaAvg) + (fleaLow != null && fleaLow < fleaAvg ? ' (low ' + ctx.formatRub(fleaLow) + ')' : '')));
        const notes = [];
        if (min != null) notes.push('level ' + min + '+');
        if (it.flea.scanned) notes.push('scanned ' + ctx.ago(it.flea.scanned));
        if (off && off.source === 'flea') notes.push('cheapest');
        tr.appendChild(el('td', 'muted', notes.join(' - ')));
        body.appendChild(tr);
      } else if (Array.isArray(it.types) && it.types.indexOf('noFlea') >= 0) {
        const tr = document.createElement('tr');
        tr.appendChild(el('td', null, 'Flea market'));
        tr.appendChild(el('td', 'muted', 'banned'));
        tr.appendChild(el('td', null, ''));
        body.appendChild(tr);
      }
      (Array.isArray(ctx.barters) ? ctx.barters : []).filter((b) => b && b.out && b.out.item === id).slice(0, 6).forEach((b) => {
        any = true;
        const tr = document.createElement('tr');
        const best = off && off.source === 'barter' && off.trader === b.trader;
        tr.className = best ? 'best' : '';
        tr.appendChild(el('td', null, traderName(b.trader) + ' LL' + (b.minTraderLevel || 1) + ' barter'));
        const reqs = el('td', 'wb-barter-reqs');
        (b.req || []).forEach((r) => {
          const m = el('span', 'wb-mini');
          m.appendChild(icon(r.item, 'mini-icon tiny'));
          m.appendChild(el('span', null, (r.count > 1 ? r.count + 'x ' : '') + shortOf(r.item)));
          m.title = nameOf(r.item);
          reqs.appendChild(m);
        });
        tr.appendChild(reqs);
        const notes = [];
        if (b.taskUnlock) notes.push('after ' + (questName(b.taskUnlock) || 'a task'));
        if (best) notes.push('cheapest');
        tr.appendChild(el('td', 'muted', notes.join(' - ')));
        body.appendChild(tr);
      });
      t.appendChild(body);
      if (any) buy.appendChild(t);
      else buy.appendChild(el('p', 'muted', 'No trader, flea or barter source is known for this item - found in raid or crafted only.'));
      if (prof.synthetic) buy.appendChild(el('p', 'muted wb-note', 'Prices assume max loyalty and flea access. Set your levels on the Traders tab to see what you can actually buy.'));
      panel.appendChild(buy);
      dock.appendChild(panel);
    }

    // ---- drawer: saved builds + factory presets -------------------------------
    function renderDrawer() {
      clear(drawer);
      drawer.hidden = !state.drawer;
      if (!state.drawer) return;
      drawer.appendChild(btn('wb-drawer-x', '\u2715', () => { state.drawer = false; renderSide(); renderDrawer(); }, 'Close'));
      if (state.gun) {
        const presets = data.presetsByGun.get(state.gun) || [];
        if (presets.length) {
          drawer.appendChild(el('h3', null, 'Factory presets'));
          const grid = el('div', 'wb-preset-grid');
          presets.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b))).forEach((pid) => {
            const full = nameOf(pid);
            const short = full.replace(nameOf(state.gun), '').trim() || full;
            const b = btn('wb-preset-btn', null, () => { state.drawer = false; loadPreset(pid); });
            b.appendChild(icon(pid, 'wb-pick-icon'));
            b.appendChild(el('span', 'wb-preset-name', short));
            b.title = full;
            grid.appendChild(b);
          });
          drawer.appendChild(grid);
        }
      }
      const doc = store();
      drawer.appendChild(el('h3', null, 'My builds'));
      if (!doc.builds.length) {
        drawer.appendChild(el('p', 'muted', 'Nothing saved yet. Builds live in this browser only; use Share to send one to another device.'));
        return;
      }
      const off = offers().map;
      doc.builds.slice().sort((a, b) => b.savedAt - a.savedAt).forEach((b) => {
        const row = el('div', 'wb-build-row' + (b.id === state.buildId ? ' current' : ''));
        row.appendChild(icon(b.w, 'wb-pick-icon'));
        const mid = el('div', 'wb-pick-mid');
        mid.appendChild(el('div', 'wb-pick-name', b.name || nameOf(b.w)));
        const known = isGun(props, b.w);
        if (known) {
          const r = placeParts(props, b.w, b.p);
          const st = buildStats(items, props, b.w, r.fitted, off);
          mid.appendChild(el('div', 'muted wb-pick-sub', shortOf(b.w) + ' - ergo ' + st.ergo + ' - recoil ' + st.recoilV + ' - ' + ctx.formatRub(st.cost) + (b.savedAt ? ' - ' + ctx.ago(b.savedAt) : '')));
        } else {
          mid.appendChild(el('div', 'muted wb-pick-sub', 'weapon no longer in the database'));
        }
        row.appendChild(mid);
        const right = el('div', 'wb-pick-right');
        if (known) right.appendChild(btn('chip on', 'Load', () => { state.drawer = false; ctx.go('builder', 'saved/' + b.id); }));
        right.appendChild(btn('chip', 'Duplicate', () => {
          const d2 = store();
          d2.builds.push({ id: newId(), name: ((b.name || nameOf(b.w)) + ' copy').slice(0, 48), w: b.w, p: b.p.slice(), savedAt: Date.now() });
          d2.builds = trimBuilds(d2.builds);
          saveStore(d2);
          renderSide();
          renderDrawer();
        }));
        right.appendChild(btn('chip', 'Delete', () => {
          if (typeof confirm === 'function' && !confirm('Delete "' + (b.name || nameOf(b.w)) + '"?')) return;
          const d2 = store();
          d2.builds = d2.builds.filter((x) => x.id !== b.id);
          saveStore(d2);
          if (state.buildId === b.id) state.buildId = null;
          renderSide();
          renderDrawer();
        }));
        row.appendChild(right);
        drawer.appendChild(row);
      });
    }

    function saveBuild(asNew) {
      if (!state.gun) return;
      const doc = store();
      const name = (state.buildName.trim() || nameOf(state.gun)).slice(0, 48);
      const rec = { id: (!asNew && state.buildId) ? state.buildId : newId(), name, w: state.gun, p: currentParts(), savedAt: Date.now() };
      const i = doc.builds.findIndex((b) => b.id === rec.id);
      if (i >= 0) doc.builds[i] = rec; else doc.builds.push(rec);
      doc.builds = trimBuilds(doc.builds);
      const ok = saveStore(doc);
      state.buildId = rec.id;
      state.buildName = name;
      state.note = ok ? 'Saved "' + name + '".' : 'Could not save - this browser is blocking storage (private mode?). Use Share instead.';
      if (ok) writeStore(LAST_KEY, 'saved/' + rec.id);
      renderSide();
      renderDrawer();
      if (!state.picker) renderDock();
      syncHash();
    }

    function deleteBuild() {
      if (!state.buildId) return;
      const doc = store();
      const b = doc.builds.find((x) => x.id === state.buildId);
      if (!b) { state.buildId = null; renderSide(); return; }
      if (typeof confirm === 'function' && !confirm('Delete "' + (b.name || nameOf(b.w)) + '"?')) return;
      doc.builds = doc.builds.filter((x) => x.id !== state.buildId);
      saveStore(doc);
      state.buildId = null;
      state.note = 'Deleted "' + (b.name || nameOf(b.w)) + '". The build is still on screen - save it again to keep it.';
      renderSide();
      renderDrawer();
      renderDock();
      syncHash();
    }

    function shareBuild() {
      if (!state.gun) return;
      const code = currentCode();
      const hash = ctx.hashFor('builder', code);
      const url = (typeof location !== 'undefined') ? location.href.split('#')[0] + hash : hash;
      try { if (location.hash !== hash) history.replaceState(null, '', hash); } catch (e) { /* file:// etc */ }
      const done = () => { state.note = 'Share link copied. Anyone who opens it sees this exact build.'; if (!state.picker) renderDock(); };
      const fallback = () => {
        state.note = '';
        if (!state.picker) renderDock();
        const box = el('div', 'wb-share');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.readOnly = true;
        inp.value = url;
        box.appendChild(el('span', 'muted', 'Copy this link:'));
        box.appendChild(inp);
        dock.insertBefore(box, dock.firstChild);
        inp.focus();
        inp.select();
      };
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, fallback);
      } else fallback();
    }

    // ---- BACK: bottom-right, plain text, like the game -----------------------
    backEl = btn('wb-back', 'Back', () => {
      if (state.picker) { closePicker(); return; }
      if (state.drawer) { state.drawer = false; renderSide(); renderDrawer(); return; }
      if (state.find) { state.find = false; renderSide(); renderDock(); return; }
      if (typeof history !== 'undefined' && history.length > 1) { history.back(); return; }
      ctx.go('items', '');
    }, 'Back to the previous tab');
    // on a phone it is the static last row of the page; on a desktop
    // renderStage() adopts it into the stage at the rect the layout reserved
    wrap.appendChild(backEl);

    // the param that reproduces the current build: 'saved/<id>' while the
    // build still matches its saved record, else the share code
    function currentParam() {
      if (!state.gun) return '';
      if (state.buildId) {
        const b = store().builds.find((x) => x.id === state.buildId);
        if (b && b.w === state.gun && multisetKey(b.p) === multisetKey(currentParts())) return 'saved/' + state.buildId;
      }
      return currentCode();
    }
    // hub.js does not compare params on a same-route hash change, and
    // replaceState never fires hashchange, so this cannot re-enter applyParam
    function syncHash() {
      if (!state.gun || typeof location === 'undefined' || typeof history === 'undefined' || !ctx.hashFor) return;
      const hash = ctx.hashFor('builder', currentParam());
      try { if (location.hash !== hash) history.replaceState(null, '', hash); } catch (e) { /* file:// etc */ }
    }

    function updateFlat() {
      const w = stage.clientWidth || 0;
      if (w) state.flat = w < 700;
      return state.flat;
    }

    function renderAll() {
      updateFlat();
      renderSide();
      renderHead();
      renderStatus();
      renderStage();
      renderStrip();
      renderPills();
      renderCompat();
      renderDock();
      renderDrawer();
      if (state.gun) writeStore(LAST_KEY, currentParam());
      syncHash();
      changeCbs.forEach((f) => { try { f(stageApiObject()); } catch (e) { /* a listener must never break the screen */ } });
    }

    // ---- route param -> state ------------------------------------------------
    function applyParam(param) {
      const s = String(param || '');
      state.picker = null;
      state.selected = null;
      state.find = false;
      state.findQuery = '';
      state.note = '';
      closePop();
      let target = s;
      if (!target) { const last = readStore(LAST_KEY); target = typeof last === 'string' ? last : ''; }
      // A modding screen with no weapon on it is a dead screen, and the first
      // thing a new visitor sees. With no link and nothing remembered, open on
      // the Colt M4A1's factory build - the game's own default rifle - rather
      // than an empty stage behind a search box.
      if (!target && isGun(props, DEFAULT_GUN)) { chooseGun(DEFAULT_GUN); return; }
      if (target.indexOf('saved/') === 0) {
        const b = store().builds.find((x) => x.id === target.slice(6));
        if (b) {
          state.gun = isGun(props, b.w) ? b.w : null;
          const r = state.gun ? placeParts(props, b.w, b.p) : { fitted: new Map(), unplaced: [] };
          state.fitted = r.fitted;
          state.buildId = b.id;
          state.buildName = b.name;
          if (!state.gun) state.note = 'This saved build points at a weapon the database no longer has.';
          else if (r.unplaced.length) state.note = unplacedCount(r.unplaced) + ' saved part(s) no longer fit and were dropped.';
          renderAll();
          return;
        }
        state.gun = null;
        if (s) state.note = 'That saved build is not in this browser.';
        renderAll();
        return;
      }
      if (target.indexOf('gun/') === 0) {
        const id = target.slice(4);
        if (isGun(props, id)) { chooseGun(id); return; }
        state.gun = null; state.note = 'Unknown weapon.'; renderAll(); return;
      }
      if (target.indexOf('preset/') === 0) {
        const pid = target.slice(7);
        const p = data.presets.get(pid);
        if (p && isGun(props, p.base)) {
          state.gun = p.base;
          state.buildId = null;
          state.buildName = '';
          loadPreset(pid);
          return;
        }
        state.gun = null; state.note = 'Unknown preset.'; renderAll(); return;
      }
      const dec = decodeShare(target);
      if (dec) {
        if (isGun(props, dec.w)) {
          state.gun = dec.w;
          const r = placeParts(props, dec.w, dec.p);
          state.fitted = r.fitted;
          state.buildId = null;
          state.buildName = '';
          if (r.unplaced.length) state.note = unplacedCount(r.unplaced) + ' shared part(s) could not be placed on this weapon.';
        } else {
          state.gun = null;
          state.note = 'That share link points at a weapon the database does not have.';
        }
        renderAll();
        return;
      }
      state.gun = null;
      if (s) state.note = 'That link is not a build this version understands.';
      renderAll();
    }

    // ---- the 3D lane's hand-off ---------------------------------------------
    //
    // js/hub-builder-3d.js renders the weapon into .wb-stage-3d and then drives
    // THESE cards and lines over it. It gets the build, the slot tree, the art
    // file, a change subscription and the marker positions the 2D stage is
    // currently using (0..1 over the picture) - everything it needs to place
    // its own anchors and keep them in sync, without reaching into this closure.
    function stageApiObject() {
      return {
        gunId: state.gun,
        tree: () => slotTree(props, state.gun, state.fitted),
        art: ctx.builderArt || null,
        onChange: (cb) => { if (typeof cb === 'function') changeCbs.push(cb); },
        markerPositions: () => {
          const out = {};
          if (!state.gun) return out;
          slotTree(props, state.gun, state.fitted).forEach((n) => {
            out[n.path] = markerAt(n.path) || fallbackAt(n.nameId);
          });
          return out;
        },
        stageEl: () => stage3dEl,
        // the weapon's drawn silhouette as 0..1 of the picture - a verifier needs
        // it to assert that every marker really does land on the gun
        silhouette: () => silhouette(),
        selected: () => state.selected,
        select: (path) => openPicker(path),
      };
    }

    if (typeof ResizeObserver === 'function') {
      let lastW = stage.clientWidth;
      ro = new ResizeObserver(() => {
        const w = stage.clientWidth;
        if (w && w !== lastW) {
          lastW = w;
          if (state.gun) { renderStage(); if (state.picker) openPop(state.picker); }
        }
      });
      ro.observe(stage);
    }

    applyParam(param);

    const handle = {
      focus(p) { applyParam(p); },
      refresh() { offersCache = null; state.reach = null; state.reachGun = null; renderAll(); },
      destroy() { if (ro) ro.disconnect(); if (LIVE === handle) LIVE = null; },
      stageApi: stageApiObject,
    };
    LIVE = handle;
    return handle;
  }

  // the 3D lane calls this on the module, not on a view handle it does not have
  function stageApi() { return LIVE ? LIVE.stageApi() : null; }

  return {
    render,
    stageApi,
    // pure surface, for the smoke
    SLOT_LABELS, ANCHORS, RAIL_OF, SLOT_CLASS, SLOT_CLASSES, MARKER_LABELS,
    slotKey, slotLabel, anchorFor, railFor, hiddenSlot, slotClass, markerLabel,
    expandBuilderData, isGun, listGuns,
    slotTree, nodeAt, revalidate, fit, conflictsOf, compatible, placeParts,
    buildStats, matchPreset, multisetKey,
    // the composite picture + the prerequisite index
    ART_GROUP, artGroup, imageSize8x, artSize8x, frameSize8x, multisetOverlap, presetPartList, presetIdsFor,
    poseRect, pathParent, pathName,
    referencePreset, compositePlan, markerRects, markerFraction,
    weaponStatRows, fireModeWords,
    reachable, reachableChains, directSlots, chainNeed, planFit,
    encodeShare, decodeShare,
    layoutBoxes, overlaps, BOX_W, BOX_H, STATS_W, STATS_H, BANNER_H,
    normalizeStore, trimBuilds, unplacedCount,
  };
}));
