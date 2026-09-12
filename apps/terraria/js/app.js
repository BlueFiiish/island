/* Terraria Companion — vanilla JS PWA
   Data: data/items.json (recipe graph), classes.json, bosses.json

   T2 (2026-08-31): the app is TERRARIA. Vanilla is the base game and always on;
   Calamity is an optional mod behind a picker. See the MOD ENGINE block below. */
'use strict';

const S = {
  db: {},            // name -> node                     (ALWAYS the full dataset)
  names: [],         // sorted item names                (ALWAYS the full dataset)
  lower: [],         // lowercased names (parallel to names)
  vNames: [],        // names VISIBLE in the current mode (what lists/search use)
  vLower: [],        // lowercased, parallel to vNames
  classes: {},
  bosses: [],
  meta: {},
  view: 'craft',
  root: null,        // current crafting-tree root item name
  crumbs: [],        // breadcrumb trail of roots
  expandAll: false,
  rawMode: false,
  graphMode: false,   // craft tab: false = list tree, true = node graph
  gfs: false,         // graph is in the CSS "fullscreen" state (never persisted)
  itemFilter: 'all',
  srcFilter: 'all',   // Items tab, Calamity mode only: all | vanilla | calamity
  itemLimit: 60,
  sets: {},           // armor-sets.json: setId -> { id, name, src, pieces, setBonus, perHelmet, desc, img }
  armorFlat: false,   // Armor filter: false = grouped set cards, true = flat piece list
};

const $ = sel => document.querySelector(sel);
const app = () => $('#app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Sprite fallback chain, LOCAL FIRST (v2, 2026-08-28):
//   ./sprites/<file>  ->  the wiki it came from  ->  the other wiki  ->  "?" placeholder
// Every sprite is bundled in the repo now, so the installed PWA has images with
// no network at all; the wiki hops only ever cover a file that failed to bundle.
window.sprErr = function(img){
  const step = img.dataset.step || '0';
  if(step === '0' && img.dataset.remote){
    img.dataset.step = '1';
    img.src = img.dataset.remote;
    return;
  }
  if(step !== '2' && img.src.indexOf('calamitymod.wiki.gg') !== -1){
    img.dataset.step = '2';
    img.src = img.src.replace('calamitymod.wiki.gg', 'terraria.wiki.gg');
    return;
  }
  if(step !== '2' && img.src.indexOf('terraria.wiki.gg') !== -1){
    img.dataset.step = '2';
    img.src = img.src.replace('terraria.wiki.gg', 'calamitymod.wiki.gg');
    return;
  }
  img.style.visibility='hidden';
  const w=img.closest('.spr-wrap'); if(w) w.classList.add('miss');
};

function get(name){ return S.db[name]; }

// ---- pins (crafting goals) -------------------------------------------------
// One localStorage key, "cc_pins" = JSON array of item names. Every access is
// try/catch-wrapped: private mode / blocked storage must never break the app,
// and a pinned name that is not in the dataset is dropped silently.
const PIN_KEY = 'cc_pins';
function loadPins(){
  try{
    const raw = localStorage.getItem(PIN_KEY);
    if(!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(n=>typeof n==='string') : [];
  }catch(e){ return []; }
}
function savePins(arr){
  try{ localStorage.setItem(PIN_KEY, JSON.stringify(arr.slice(0,60))); }catch(e){}
}
function isPinned(name){ return loadPins().indexOf(name) !== -1; }
function togglePin(name){
  const arr = loadPins();
  const i = arr.indexOf(name);
  if(i>=0) arr.splice(i,1); else arr.push(name);
  savePins(arr);
  return i<0;
}
function pinBtnHtml(name){
  const on = isPinned(name);
  return `<button class="act-btn pin${on?' on':''}" data-pin="${esc(name)}" title="${on?'Unpin':'Pin as a crafting goal'}">${on?'&#9733; Pinned':'&#9734; Pin'}</button>`;
}
// The chip row above the Craft-tab search box. Rendered into #pinRow, which
// renderCraft() always emits, so this can refresh without a full re-render.
function renderPinRow(){
  const host = $('#pinRow');
  if(!host) return;
  // A pin on mod content is KEPT in storage but hidden while that mod is off -
  // turning Calamity back on must not silently cost the user their goals.
  const pins = loadPins().filter(n => nodeOn(get(n)));
  if(!pins.length){ host.innerHTML=''; return; }
  host.innerHTML = `<span class="pin-lbl">&#9733; Pinned</span>` + pins.map(n=>
    `<span class="pin-chip${rarClsNode(get(n))}" data-focus="${esc(n)}">${spr(n,'s24')}<span class="pn">${esc(n)}</span>${calBadgeFor(n)}<button class="pin-x" data-unpin="${esc(n)}" title="Unpin" aria-label="Unpin ${esc(n)}">&times;</button></span>`
  ).join('');
}

// =====================  MOD ENGINE  ========================================
// The app is TERRARIA. Vanilla is the base game and is always on; every other
// mod is a toggle that MERGES its content into the same database. Every record
// in data/ is tagged `src: "vanilla" | "calamity"` - items, recipes, drops,
// shimmer rows, armor sets and bosses - and one predicate (srcOn) decides
// whether a record is visible in the current mode. Nothing is deleted or
// re-derived; a mode flip is a pure filter + re-render.
//
// STATE: module-level `MODES`, persisted under ONE localStorage key.
//
// MIGRATION RULE (documented because it is not obvious from the code):
//   This app used to BE the Calamity Companion, mounted at /calamity. Anyone
//   carrying prior app storage (cc_pins) deliberately chose a Calamity app, so
//   on their first boot after the pivot Calamity is turned ON for them and the
//   decision is written to tr_mods immediately (so it is a one-time inference,
//   never re-run). A device with NO prior app storage is a new user and boots
//   VANILLA. A corrupt / unparsable / wrong-shaped tr_mods is treated exactly
//   like a missing one: it never throws, it is overwritten with a clean value,
//   and the same migration decides the default. Same standard as loadPins().
const MODS_KEY = 'tr_mods';
const LEGACY_APP_KEYS = [PIN_KEY];        // storage that proves a pre-pivot user

// Toggleable content mods. `soon: true` renders the row disabled in the picker.
// Vanilla is listed first and is not a toggle - it is the base game.
const MOD_DEFS = [
  {id:'vanilla',  em:'&#127807;', name:'Vanilla Terraria', desc:'Always on &mdash; the base game', always:true},
  {id:'calamity', em:'&#127769;', name:'Calamity',         desc:'', badge:true},
  {id:'infernum', em:'&#128293;', name:'Infernum',         desc:'Boss-fight overhaul &mdash; changes boss pages', soon:true},
  {id:'thorium',  em:'&#9874;',   name:'Thorium',          desc:'Next mod &mdash; patrons vote', soon:true},
];
const TOGGLEABLE = MOD_DEFS.filter(m=>!m.always && !m.soon).map(m=>m.id);   // ['calamity']

const MODES = { calamity: false };

/** True when this device carries storage from before the Terraria pivot. */
function hadLegacyStorage(){
  try{
    for(const k of LEGACY_APP_KEYS){ if(localStorage.getItem(k) != null) return true; }
  }catch(e){}
  return false;
}
/** Read tr_mods. Returns null for missing OR unusable, so both take one path. */
function readMods(){
  try{
    const raw = localStorage.getItem(MODS_KEY);
    if(raw == null) return null;
    const v = JSON.parse(raw);
    if(!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    let sane = false;
    for(const id of TOGGLEABLE){
      if(typeof v[id] === 'boolean'){ out[id] = v[id]; sane = true; }
      else out[id] = false;
    }
    return sane ? out : null;      // an object with no known boolean is junk
  }catch(e){ return null; }
}
function saveMods(){
  try{
    const out = {};
    TOGGLEABLE.forEach(id => { out[id] = !!MODES[id]; });
    localStorage.setItem(MODS_KEY, JSON.stringify(out));
  }catch(e){}
}
/** Boot the mode state. Never throws; always leaves MODES in a valid shape. */
function initMods(){
  const stored = readMods();
  if(stored){
    TOGGLEABLE.forEach(id => { MODES[id] = !!stored[id]; });
  }else{
    // missing OR corrupt -> the one-time migration decides, then it is written
    MODES.calamity = hadLegacyStorage();
    saveMods();
  }
}

/** The one content predicate. An untagged record counts as vanilla (never hidden). */
function srcOn(src){ return src !== 'calamity' || MODES.calamity; }
function isCalSrc(x){ return !!x && x.src === 'calamity'; }
function nodeOn(node){ return !!node && srcOn(node.src); }
function modeName(){ return MODES.calamity ? 'calamity' : 'vanilla'; }

// Per-record filters. In Calamity mode every one of these is the identity, so
// the merged view is byte-for-byte what the app rendered before the pivot.
function visRecipes(node){
  const r = (node && node.recipes) || [];
  return MODES.calamity ? r : r.filter(x => srcOn(x.src));
}
function visDrops(node){
  const d = (node && node.drops) || [];
  return MODES.calamity ? d : d.filter(x => srcOn(x.src));
}
function visShimmer(node){
  const s = (node && node.shimmer) || [];
  return MODES.calamity ? s : s.filter(x => srcOn(x.src));
}
/**
 * "Used in", mode-filtered. Two conditions in vanilla mode, not one: the target
 * item must itself be vanilla AND a VISIBLE recipe of it must actually consume
 * this item - otherwise a Calamity-added recipe would leave a link pointing at
 * an item whose (filtered) recipe list never mentions the ingredient.
 */
function visUsedIn(node){
  const u = (node && node.usedIn) || [];
  if(MODES.calamity) return u;
  const me = node.name;
  return u.filter(n => {
    const t = get(n);
    if(!nodeOn(t)) return false;
    return visRecipes(t).some(r => (r.ings||[]).some(g => g[0] === me));
  });
}

// The CAL badge. Only ever rendered in Calamity mode - vanilla mode shows no
// mod content at all, so a badge there would be meaningless (and the recipe
// GROUP placeholders, "Any Wood" etc., appear inside genuine vanilla recipes,
// so badging them by src would be actively wrong whichever way they are tagged).
function calBadge(x, cls){
  return (MODES.calamity && isCalSrc(x))
    ? `<span class="cal-badge${cls?' '+cls:''}">CAL</span>` : '';
}
function calBadgeFor(name){ return calBadge(get(name)); }

/** Names visible in the current mode. Rebuilt once per mode flip, not per render. */
function rebuildVisible(){
  if(MODES.calamity){
    S.vNames = S.names; S.vLower = S.lower;
    return;
  }
  S.vNames = []; S.vLower = [];
  for(let i=0;i<S.names.length;i++){
    if(srcOn(S.db[S.names[i]].src)){ S.vNames.push(S.names[i]); S.vLower.push(S.lower[i]); }
  }
}
function visibleSets(){
  return Object.entries(S.sets).filter(([,set]) => srcOn(set.src));
}
function visibleBosses(){
  return S.bosses.filter(b => srcOn(b.src));
}

/**
 * Apply the current mode to the document + caches, then re-render.
 * `data-mode` is stamped on <html>, <body> AND the mount node, because this app
 * runs BOTH standalone and mounted inside the fiiiish-app shell. The shell's
 * PostCSS pass collapses `body[data-mode=...]` onto its own mount selector
 * (.fi-app[data-app="<slug>"][data-mode=...]), so the attribute has to be on the
 * mount too or the theme swap silently no-ops there. `closest('[data-app]')` is
 * generic - it never names a slug or a route path.
 */
function applyMode(rerender){
  const m = modeName();
  try{
    document.documentElement.setAttribute('data-mode', m);
    document.body.setAttribute('data-mode', m);
    const host = app() && app().closest('[data-app]');
    if(host) host.setAttribute('data-mode', m);
  }catch(e){}
  rebuildVisible();
  STAGE_LABELS = null;
  renderModeBar();
  renderStamp();
  warmSpritesForMode();
  if(rerender !== false){
    S.itemLimit = 60;
    S.srcFilter = 'all';
    // The Rogue chip only exists in Calamity mode, so a user who left the Items
    // tab filtered to Rogue and then turned the mod off would get a filtered
    // list with no chip lit to explain it.
    if(!MODES.calamity && CAL_ONLY_CLASSES.indexOf(S.itemFilter) !== -1) S.itemFilter = 'all';
    // A crafting-tree root that the new mode hides would leave the Craft tab on
    // an item that is not in the database any more as far as the UI is concerned.
    if(S.root && !nodeOn(get(S.root))){ S.root = null; S.crumbs = []; }
    S.crumbs = S.crumbs.filter(c => nodeOn(get(c)));
    if(curClass && !visibleClasses().includes(curClass)) curClass = 'melee';
    closeSheet();
    render();
  }
}
function setMod(id, on){
  if(TOGGLEABLE.indexOf(id) === -1) return;
  if(!!MODES[id] === !!on) return;
  MODES[id] = !!on;
  saveMods();
  // Scroll position: a mode flip changes what is in the list under the user's
  // thumb, so pin the page to the top rather than restoring a now-meaningless
  // offset. The tab itself is kept.
  window.scrollTo(0,0);
  applyMode(true);
}

// ---- the mode chip row + the picker sheet ----------------------------------
function renderModeBar(){
  const host = $('#modebar');
  if(!host) return;
  const cal = MODES.calamity;
  host.innerHTML =
    `<span class="modechip ${cal?'cal':'van'}"><span class="dot"></span>${cal?'Calamity':'Vanilla'}</span>`
    + (cal ? `<span class="cal-badge title">+ CALAMITY</span>` : '')
    + `<button class="mods-btn" data-modpicker aria-haspopup="dialog">Mods &rsaquo;</button>`;
}
/** Counts are DERIVED from the loaded dataset - never hardcoded. */
function modCounts(id){
  if(id === 'vanilla'){
    return {items: S.names.filter(n=>!isCalSrc(S.db[n])).length,
            sets: Object.values(S.sets).filter(s=>!isCalSrc(s)).length,
            bosses: S.bosses.filter(b=>!isCalSrc(b)).length};
  }
  return {items: S.names.filter(n=>S.db[n].src===id).length,
          sets: Object.values(S.sets).filter(s=>s.src===id).length,
          bosses: S.bosses.filter(b=>b.src===id).length};
}
function modDesc(m){
  if(m.desc) return m.desc;
  const c = modCounts(m.id);
  return `+${c.items.toLocaleString()} items, ${c.sets} sets, ${c.bosses} bosses`;
}
function modPickerSheet(){
  const rows = MOD_DEFS.map(m=>{
    const on = m.always ? true : !!MODES[m.id];
    const ctrl = m.soon
      ? `<span class="mod-soon">SOON</span>`
      : `<span class="mod-tog${on?' on':''}${m.always?' base':''}" role="switch" aria-checked="${on}"${
           m.always?'':` data-modtoggle="${esc(m.id)}"`}></span>`;
    return `<div class="mod-row${m.soon?' dis':''}"${m.soon||m.always?'':` data-modtoggle="${esc(m.id)}"`}>
      <span class="mod-ic">${m.em}</span>
      <span class="mod-body"><span class="mod-nm">${esc(m.name)}${m.badge?' <span class="cal-badge">CAL</span>':''}</span>
      <span class="mod-desc">${modDesc(m)}</span></span>
      ${ctrl}
    </div>`;
  }).join('');
  openSheet(`
    <div class="sheet-grab"></div>
    <div class="wk-crumb"><button class="wk-back" data-sheetback>&times; Close</button><span class="wk-path">/ Mods</span></div>
    <h3 class="wk-title">Mods</h3>
    <div class="wk-sub">Pick what you're playing with &mdash; the whole app follows</div>
    <div class="mod-sheet">
      <div class="mod-head">Active mods</div>
      ${rows}
    </div>
    <div class="mod-note">Your pick is remembered on this device. On Vanilla nothing modded is mixed in &mdash;
      items, recipes, drops, armour sets, bosses and class guides are base-game only. Turn Calamity on and everything
      merges into one database, exactly like in-game, with a <span class="cal-badge">CAL</span> badge on every modded entry.</div>
  `, {t:'mods', i:'mods', n:'Mods'});
}

// ---- recipe ranking --------------------------------------------------------
// tools/rank-recipes.mjs stable-sorts every item's recipes[] so a REAL crafting
// recipe is first, and stamps a `rank` on the rows that are not real recipes:
// conversion stations (rank 10, e.g. Chlorophyte Extractinator), circular
// de-crafts (rank 20, e.g. Bone <- 4x Bone Block Wall) and self-referential
// rows (rank 30). Nothing is deleted - the item sheet still lists every recipe -
// but the crafting tree must never WALK one, or it invents steps like
// "Hellstone from Ember Wall" for a material you actually mine. An item whose
// rows are ALL junk has no primary recipe and reads as a terminal material.
//
// MODE-AWARE (T2): the walk only ever sees recipes the current mode allows, so
// in Vanilla mode a Calamity-added recipe for a base-game item is not merely
// hidden on the sheet - the crafting tree does not walk it either, and the item
// correctly reads as "not crafted" if Calamity is the only thing that crafts it.
const RANK_JUNK = 10;                     // keep in sync with tools/rank-recipes.mjs
function primaryRecipe(node){
  const rs = visRecipes(node);
  if(!rs.length) return null;
  const r = rs[0];
  if(!r || !r.ings || !r.ings.length) return null;
  return (r.rank || 0) >= RANK_JUNK ? null : r;
}
function junkRecipes(node){
  return visRecipes(node).filter(r => (r.rank || 0) >= RANK_JUNK);
}

// ---- source classification -------------------------------------------------
function sourceOf(node){
  if(!node) return {kind:'base', label:'material'};
  if(primaryRecipe(node)) return {kind:'craft', label:'Crafted'};
  const drops = visDrops(node);
  if(drops.length){
    const npc = drops[0].npc || 'enemy';
    return {kind:'drop', label:'Drop: '+npc};
  }
  return {kind:'base', label:'Mined / found / bought'};
}
function srcChip(node){
  const s = sourceOf(node);
  if(s.kind==='craft') return '';                       // craftable => caret shows it
  if(s.kind==='drop') return `<span class="chip drop meta-tag">${esc(s.label)}</span>`;
  return `<span class="chip base meta-tag">base</span>`;
}
/**
 * An item's damage classes, MODE-FILTERED.
 *
 * node.classes comes from the Calamity class-setup guides, so 68 base-game
 * items (Terraspark Boots, Ankh Shield, ...) carry a "rogue" tag - a damage
 * class that does not exist in vanilla Terraria. Rendering it unfiltered made
 * the Classes tab hide Rogue while every item row still advertised it.
 * Filtered through the same CAL_ONLY_CLASSES the Classes tab uses, so the two
 * can never disagree again.
 */
function visClasses(node){
  const cs = (node && node.classes) || [];
  return MODES.calamity ? cs : cs.filter(c => CAL_ONLY_CLASSES.indexOf(c) === -1);
}
function classChips(node){
  return visClasses(node).map(c=>`<span class="chip cls ${c}">${c==='mage'?'Mage':c[0].toUpperCase()+c.slice(1)}</span>`).join('');
}

// ---- rarity (Terraria/Calamity item-tier glow) -----------------------------
// The wiki dataset carries each item's in-game rarity in its stats table as
// ["Rarity", <value>] — a vanilla colour name (White..Purple), a Calamity
// custom "Tier 12".."Tier 18", or a special (Rainbow / Draedon's Arsenal /
// Varies). We normalise that to a slug and paint a rarity-coloured glowing
// border on the item card / row / detail sheet, exactly like the item tooltip
// colours in-game. Colours verified against calamitymod.wiki.gg/wiki/Rarity.
const RAR_KNOWN = {gray:1,white:1,blue:1,green:1,orange:1,lightred:1,pink:1,lightpurple:1,lime:1,yellow:1,cyan:1,red:1,purple:1,fieryred:1,rainbow:1,varies:1,draedonsarsenal:1,tier12:1,tier13:1,tier14:1,tier15:1,tier16:1,tier17:1,tier18:1};
function rarityKey(node){
  if(!node || !node.stats) return null;
  for(let i=0;i<node.stats.length;i++){
    const kv = node.stats[i];
    if(kv && kv[0] && String(kv[0]).toLowerCase()==='rarity'){
      let v = String(kv[1]==null?'':kv[1]).toLowerCase();
      v = v.replace(/\(expert\)/g,'').replace(/['’`]/g,'').replace(/\s+/g,'');
      return v || null;
    }
  }
  return null;
}
function rarCls(node){ const k=rarityKey(node); return (k && RAR_KNOWN[k]) ? ` rar rar-${k}` : ''; }        // glowing-card treatment
function rarClsNode(node){ const k=rarityKey(node); return (k && RAR_KNOWN[k]) ? ` rarn rar-${k}` : ''; }   // lighter tree-row treatment

// Human-readable rarity tier name for the in-game-style tooltip. This is just a
// prettified form of the item's REAL rarity value (never invented) — vanilla
// colour tiers get their colour name, Calamity post-Moon-Lord tiers keep their
// "Tier NN" designation. Keys mirror RAR_KNOWN so a label exists iff a glow does.
const RAR_LABEL = {gray:'Gray Tier',white:'White Tier',blue:'Blue Tier',green:'Green Tier',orange:'Orange Tier',lightred:'Light Red Tier',pink:'Pink Tier',lightpurple:'Light Purple Tier',lime:'Lime Tier',yellow:'Yellow Tier',cyan:'Cyan Tier',red:'Red Tier',purple:'Purple Tier',fieryred:'Fiery Red (Expert)',rainbow:'Rainbow (Expert)',draedonsarsenal:"Draedon's Arsenal",tier12:'Rarity Tier 12',tier13:'Rarity Tier 13',tier14:'Rarity Tier 14',tier15:'Rarity Tier 15',tier16:'Rarity Tier 16',tier17:'Rarity Tier 17',tier18:'Rarity Tier 18',varies:'Varies'};
function rarityLabel(node){ const k=rarityKey(node); return (k && RAR_LABEL[k]) ? RAR_LABEL[k] : null; }

// ---- sprite ----------------------------------------------------------------
const WIKI_FILEPATH = 'https://calamitymod.wiki.gg/wiki/Special:FilePath/';
function guessRemote(name){
  // MediaWiki filenames cannot contain ':' - drop it, do NOT %3A-encode (404s).
  return WIKI_FILEPATH + encodeURIComponent(name.replace(/:/g,'').replace(/ /g,'_')) + '.png';
}
function sprFrom(local, remote, cls='s32'){
  const src = local || remote || '';
  const attrs = (local && remote) ? ` data-remote="${esc(remote)}"` : '';
  return `<span class="spr-wrap"><img class="spr ${cls}" src="${esc(src)}"${attrs} loading="lazy" alt="" onerror="sprErr(this)"></span>`;
}
function spr(name, cls='s32'){
  const n = get(name);
  if(n) return sprFrom(n.img, n.imgRemote, cls);
  return sprFrom(null, guessRemote(name), cls);
}

// ---- routing / tabs --------------------------------------------------------
function setView(v){
  S.view = v;
  document.querySelectorAll('#tabbar .tab').forEach(t=>t.classList.toggle('on', t.dataset.view===v));
  window.scrollTo(0,0);
  render();
}
function render(){
  exitGraphFs();
  const v = S.view;
  if(v==='craft') return renderCraft();
  if(v==='classes') return renderClasses();
  if(v==='bosses') return renderBosses();
  if(v==='items') return renderItems();
  if(v==='guide') return renderGuide();
}

// =====================  CRAFT (the centerpiece)  ============================
function focusItem(name, pushCrumb=true){
  if(!get(name)) return;
  if(pushCrumb && S.root && S.root!==name) S.crumbs.push(S.root);
  S.root = name;
  S.rawMode = false;
  setView('craft');
}
function crumbTo(name){
  const i = S.crumbs.indexOf(name);
  if(i>=0) S.crumbs = S.crumbs.slice(0,i);
  S.root = name;
  renderCraft();
}

function renderCraft(){
  const a = app();
  exitGraphFs();
  const pinRow = `<div class="pin-row" id="pinRow"></div>`;
  const searchBar = `
    <div class="search-wrap">
      <span class="search-ic">&#128269;</span>
      <input id="craftSearch" class="search" placeholder="${esc(searchPlaceholder())}" autocomplete="off" autocorrect="off" spellcheck="false" />
      <button class="search-clear" id="craftClear" hidden>&times;</button>
      <div class="suggest" id="craftSuggest" hidden></div>
    </div>`;

  if(!S.root){
    a.innerHTML = `<div class="view">
      ${pinRow}
      ${searchBar}
      <div class="hint">
        <div class="big">&#129683;</div>
        <div class="empty-title">Crafting Tree</div>
        <div>Search an item to see its <b>full crafting tree</b>.</div>
        <div class="faint" style="margin-top:6px">Tap a row to expand ingredients · tap an icon to open details · tap &#8635; to jump into that ingredient's tree.</div>
        <div class="quick" id="quickPicks"></div>
      </div>
    </div>`;
    // Two pick lists so the empty Craft tab never opens on content the current
    // mode hides. The vanilla list leads because vanilla is the base game.
    const picks = ['Zenith','Terra Blade','Meowmere','Mythril Bar','Hallowed Bar','Molten Pickaxe',"Night's Edge",'Ankh Shield']
      .concat(MODES.calamity ? ['Ark of the Cosmos','Life Alloy','Auric Bar','Cosmilite Bar','Elemental Lance','The Community','Nanoblack Reaper','Ascendant Spirit Essence','Miracle Matter'] : []);
    $('#quickPicks').innerHTML = picks.filter(p=>nodeOn(get(p))).slice(0,10)
      .map(p=>`<button class="tbtn" data-focus="${esc(p)}">${esc(p)}${calBadgeFor(p)}</button>`).join('');
    renderPinRow();
    wireSearch(); wireDelegation();
    return;
  }

  const node = get(S.root);
  const s = sourceOf(node);
  const crumbHtml = S.crumbs.length ? `<div class="crumbs">${S.crumbs.map(c=>`<a data-crumb="${esc(c)}">${esc(c)}</a><span class="sep">&rsaquo;</span>`).join('')}<span>${esc(S.root)}</span></div>` : '';

  const craftable = !!primaryRecipe(node);
  const viewSeg = (craftable && !S.rawMode) ? `<span class="seg" role="group" aria-label="Tree view">
      <button class="segb${S.graphMode?'':' on'}" data-gview="list">List</button>
      <button class="segb${S.graphMode?' on':''}" data-gview="graph">Graph</button>
    </span>` : '';

  a.innerHTML = `<div class="view">
    ${pinRow}
    ${searchBar}
    ${crumbHtml}
    <div class="tree-head${rarCls(node)}">
      ${spr(S.root,'s56')}
      <div class="ti">
        <h3>${esc(S.root)}${calBadgeFor(S.root)}</h3>
        <div class="sub">${classChips(node)} ${esc(s.label)}${visRecipes(node).length>1?` · ${visRecipes(node).length} recipes`:''}</div>
      </div>
      <button class="share-btn" data-sheet="${esc(S.root)}" title="Details">&#8505;</button>
    </div>
    ${node.desc?`<p class="desc tree-desc">${esc(node.desc)}</p>`:''}
    <div class="tree-tools">
      ${(!S.graphMode||S.rawMode)?`<button class="tbtn ${S.expandAll?'on':''}" id="toggleAll">${S.expandAll?'Collapse all':'Expand all'}</button>`:''}
      <button class="tbtn ${S.rawMode?'on':''}" id="toggleRaw">${S.rawMode?'Show tree':'Raw materials'}</button>
      ${viewSeg}
    </div>
    <div id="treeHost"></div>
  </div>`;

  const host = $('#treeHost');
  const rootRec = primaryRecipe(node);
  if(!rootRec){
    host.innerHTML = renderNonCraftable(node);
  } else if(S.rawMode){
    host.innerHTML = renderRaw(S.root);
  } else if(S.graphMode){
    host.innerHTML = renderGraph(S.root);
    wireGraph();
  } else {
    const tree = document.createElement('div');
    tree.className = 'tree';
    tree.appendChild(buildNode(S.root, rootRec.amount||1, null, 0, new Set(), true));
    host.appendChild(tree);
    if(S.expandAll) openAll(tree);
  }
  renderPinRow();
  wireSearch(); wireDelegation();
}

function renderNonCraftable(node){
  const s = sourceOf(node);
  const drops = visDrops(node), shim = visShimmer(node);
  let h = `<div class="card"><div class="row g8">${spr(node.name,'s40')}<div><b>Not crafted.</b><div class="muted" style="font-size:13px">${esc(s.label)}</div></div></div>`;
  if(drops.length){
    h += `<div class="sec-h" style="margin-top:12px">Drops from</div>`;
    h += drops.slice(0,12).map(d=>`<div class="row g8" style="padding:4px 0"><span class="chip drop">${esc(d.npc||'?')}</span>${calBadge(d)}<span class="faint" style="font-size:12px">${esc(d.chance||'')}${d.amount&&d.amount!=='1'?' · '+esc(d.amount):''}</span></div>`).join('');
  }
  if(shim.length){
    h += `<div class="sec-h" style="margin-top:12px">Shimmer transmutation</div>`;
    h += shim.map(r=>`<div class="muted" style="font-size:13px">&#8646; ${r.ings.map(i=>esc(i[0])).join(', ')}</div>`).join('');
  }
  // Conversion / de-craft rows exist in the data but are never walked as a
  // crafting step (see primaryRecipe). Show them so nothing is hidden.
  const conv = junkRecipes(node);
  if(conv.length){
    h += `<div class="sec-h" style="margin-top:12px">Conversions (not a crafting step)</div>`;
    h += conv.map(r=>`<div class="muted" style="font-size:13px">&#8646; ${r.ings.map(i=>esc(i[1]+'x '+i[0])).join(' + ')} <span class="faint">@ ${esc(r.station||'By Hand')}</span></div>`).join('');
  }
  h += `</div>`;
  const used = visUsedIn(node);
  if(used.length){
    h += usedInBlock(used);
  }
  return h;
}

function usedInBlock(used){
  const list = used.slice(0,40);
  return `<div class="card"><div class="sec-h" style="margin-top:0">Used to craft (${used.length})</div>
    <div class="usedin">${list.map(u=>`<span class="u" data-focus="${esc(u)}">${spr(u,'s24')}<span>${esc(u)}</span>${calBadgeFor(u)}</span>`).join('')}</div></div>`;
}

// build one tree node (lazy children)
function buildNode(name, qty, station, depth, ancestors, isRoot){
  const node = get(name);
  const rec0 = primaryRecipe(node);
  const craftable = !!rec0 && !ancestors.has(name);
  const div = document.createElement('div');
  div.className = 'node' + (craftable?' craftable':'') + rarClsNode(node);
  div.dataset.name = name;

  const qtyHtml = isRoot ? '' : `<span class="qty">${qty}&times;</span>`;
  const caret = craftable ? '<span class="caret">&#9654;</span>' : '<span class="caret leaf">&bull;</span>';
  const stBadge = (craftable && rec0.station) ? `<span class="station-badge">@ ${esc(rec0.station)}</span>` : '';
  const tag = craftable ? '' : srcChip(node);

  div.innerHTML = `<div class="rowline">
      ${caret}
      <button class="spr-btn" data-sheet="${esc(name)}" style="background:none;border:0;padding:0">${spr(name,'s32')}</button>
      ${qtyHtml}
      <span class="nm"><span class="tap" data-focus2="${esc(name)}">${esc(name)}</span> ${stBadge}</span>
      ${tag}
      ${craftable && !isRoot ? '<button class="refocus" data-focus="'+esc(name)+'" title="Focus this tree" style="background:none;border:0;color:var(--accent);padding:4px">&#8635;</button>' : ''}
    </div>
    <div class="kids"></div>`;

  if(craftable){
    const kids = div.querySelector('.kids');
    kids.dataset.built = '0';
    div._build = () => {
      if(kids.dataset.built==='1') return;
      kids.dataset.built='1';
      const rec = rec0;
      const nextAnc = new Set(ancestors); nextAnc.add(name);
      rec.ings.forEach(([inm,iq])=>{
        kids.appendChild(buildNode(inm, iq, rec.station, depth+1, nextAnc, false));
      });
    };
    if(isRoot){ div.classList.add('open'); div._build(); }
  }
  return div;
}

function openAll(scope){
  scope.querySelectorAll('.node.craftable').forEach(n=>{
    if(n._build) n._build();
    n.classList.add('open');
  });
  // building may have added new craftable nodes; loop a few passes
  for(let p=0;p<8;p++){
    let added=false;
    scope.querySelectorAll('.node.craftable:not(.open)').forEach(n=>{
      if(n._build) n._build();
      n.classList.add('open'); added=true;
    });
    if(!added) break;
  }
}

// =====================  GRAPH VIEW (tech-tree layout)  ======================
// The same recipe walk the list tree does (primary recipe only, ancestor-set
// cycle guard), laid out as columns by depth: root at the LEFT, its ingredients
// to the right, leaves furthest right. One absolutely-positioned HTML tile per
// node over a single inline SVG of the edge curves.
//
// Sizes are LOGICAL pixels - the whole content layer is transform:scale(z)'d,
// so nothing here ever has to know about the zoom level.
const G = {
  W: 152,     // node tile width
  H: 48,      // node tile height
  COLW: 196,  // horizontal pitch between depth columns (tile + edge gutter)
  ROWH: 60,   // vertical pitch between leaf rows
  PAD: 16,    // canvas padding
  MAX: 200,   // node budget: over this, repeated subtrees collapse (see below)
};

// Dry run: how many nodes a FULL expansion would produce. Cheap (the worst
// item in the dataset is ~385 nodes) and it decides whether we de-duplicate.
function countGraphNodes(name, anc){
  const rec = primaryRecipe(get(name));
  if(!rec || anc.has(name)) return 1;
  const na = new Set(anc); na.add(name);
  let t = 1;
  rec.ings.forEach(([inm])=>{ t += countGraphNodes(inm, na); });
  return t;
}

// Layout. Leaves take the next free row; a parent centres on its children -
// the classic tidy-tree assignment, which keeps deep chains reading straight.
function buildGraphModel(root){
  const dedupe = countGraphNodes(root, new Set()) > G.MAX;
  const seen = new Set();
  const nodes = [];
  const edges = [];
  let rows = 0;
  let maxDepth = 0;

  function walk(name, qty, depth, anc, parent){
    const recipe = primaryRecipe(get(name));
    const expandable = !!recipe && !anc.has(name);
    const dup = expandable && dedupe && seen.has(name);
    const idx = nodes.length;
    const rec = { name, qty, depth, dup, craft: expandable, station:'', row:0 };
    nodes.push(rec);
    if(parent >= 0) edges.push([parent, idx]);
    if(depth > maxDepth) maxDepth = depth;

    if(expandable && !dup){
      seen.add(name);
      rec.station = recipe.station || '';
      const na = new Set(anc); na.add(name);
      const kids = recipe.ings.map(([inm,iq])=> walk(inm, iq, depth+1, na, idx));
      rec.row = (nodes[kids[0]].row + nodes[kids[kids.length-1]].row) / 2;
    } else {
      rec.row = rows;
      rows += 1;
    }
    return idx;
  }
  walk(root, (primaryRecipe(get(root))||{}).amount || 1, 0, new Set(), -1);

  const W = G.PAD*2 + maxDepth*G.COLW + G.W;
  const H = G.PAD*2 + Math.max(0, rows-1)*G.ROWH + G.H;
  return { nodes, edges, W, H, dedupe, count: nodes.length };
}

const gx = d => G.PAD + d*G.COLW;
const gy = r => G.PAD + r*G.ROWH;

function renderGraph(root){
  const m = buildGraphModel(root);

  const paths = m.edges.map(([p,c])=>{
    const a = nodesXY(m.nodes[p]), b = nodesXY(m.nodes[c]);
    const x1 = a.x + G.W, y1 = a.y + G.H/2;
    const x2 = b.x,       y2 = b.y + G.H/2;
    const mid = (x1 + x2) / 2;
    return `<path d="M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" />`;
  }).join('');

  const tiles = m.nodes.map((nd,i)=>{
    const node = get(nd.name);
    const x = gx(nd.depth), y = gy(nd.row);
    const qty = i===0 ? '' : `<span class="gq">${nd.qty}&times;</span>`;
    const sub = nd.dup
      ? '<span class="gst dupt">&#8635; shown above</span>'
      : (nd.station ? `<span class="gst">@ ${esc(nd.station)}</span>` : (nd.craft?'':`<span class="gst base">${esc(sourceOf(node).kind==='drop'?'drop':'base')}</span>`));
    return `<div class="gnode${nd.craft?' gcraft':''}${nd.dup?' gdup':''}${i===0?' groot':''}${rarClsNode(node)}" style="left:${x}px;top:${y}px" data-sheet="${esc(nd.name)}" title="${esc(nd.name)}">
      ${qty}${spr(nd.name,'s24')}<span class="gtxt"><span class="gn">${esc(nd.name)}</span>${sub}</span></div>`;
  }).join('');

  const note = m.dedupe
    ? `<div class="ghint">${m.count} nodes &middot; repeated sub-trees collapsed to keep the map readable &mdash; tap one to open it.</div>`
    : `<div class="ghint">${m.count} nodes &middot; pinch to zoom, drag to pan, tap a node for details.</div>`;

  return `<div class="tree-frame" id="treeFrame">
    <div class="gscroll">
      <div class="gsizer" style="width:${m.W}px;height:${m.H}px">
        <div class="gcontent" data-w="${m.W}" data-h="${m.H}" style="width:${m.W}px;height:${m.H}px">
          <svg class="gsvg" width="${m.W}" height="${m.H}" viewBox="0 0 ${m.W} ${m.H}" aria-hidden="true">${paths}</svg>
          ${tiles}
        </div>
      </div>
    </div>
    <div class="gzoom">
      <button class="gzb" data-gz="in" aria-label="Zoom in">+</button>
      <button class="gzb" data-gz="out" aria-label="Zoom out">&minus;</button>
      <button class="gzb" data-gz="reset" aria-label="Reset zoom">&#8634;</button>
      <button class="gzb gfs" data-gz="fs" aria-label="Fullscreen">&#9974;</button>
    </div>
    <button class="gclose" data-gz="exit" aria-label="Exit fullscreen">&times;</button>
  </div>
  ${note}`;
}
function nodesXY(nd){ return { x: gx(nd.depth), y: gy(nd.row) }; }

// Zoom + pan + CSS "fullscreen". Wired per render on the freshly built frame,
// so there is nothing to tear down when the craft view re-renders.
const ZMIN = 0.3, ZMAX = 2.5;
function wireGraph(){
  const frame = $('#treeFrame');
  if(!frame) return;
  const scroll = frame.querySelector('.gscroll');
  const sizer = frame.querySelector('.gsizer');
  const content = frame.querySelector('.gcontent');
  const W = +content.dataset.w, H = +content.dataset.h;
  let z = 1;

  const clampZ = v => Math.min(ZMAX, Math.max(ZMIN, v));
  function apply(){
    content.style.transform = 'scale(' + z + ')';
    sizer.style.width = (W*z) + 'px';
    sizer.style.height = (H*z) + 'px';
  }
  // Zoom keeping the point (ax,ay) - in scroll-container-local px - visually put.
  function zoomTo(nz, ax, ay){
    const cx = (scroll.scrollLeft + ax) / z;
    const cy = (scroll.scrollTop + ay) / z;
    z = clampZ(nz);
    apply();
    scroll.scrollLeft = cx*z - ax;
    scroll.scrollTop  = cy*z - ay;
  }
  function zoomBy(f){
    const r = scroll.getBoundingClientRect();
    zoomTo(z*f, r.width/2, r.height/2);
  }
  // The root sits at the vertical CENTRE of a tall canvas, so scroll 0,0 would
  // open the map on some random mid-tree branch. Park the root on screen.
  function centerRoot(){
    const rt = content.querySelector('.gnode.groot');
    if(!rt) return;
    const ry = (parseFloat(rt.style.top) || 0) + G.H/2;
    scroll.scrollLeft = 0;
    scroll.scrollTop = Math.max(0, ry*z - scroll.clientHeight/2);
  }

  frame.querySelector('.gzoom').addEventListener('click', e=>{
    const b = e.target.closest('[data-gz]'); if(!b) return;
    const k = b.dataset.gz;
    if(k==='in') zoomBy(1.25);
    else if(k==='out') zoomBy(1/1.25);
    else if(k==='reset'){ z=1; apply(); centerRoot(); }
    else if(k==='fs') setFs(!S.gfs);
  });
  frame.querySelector('.gclose').addEventListener('click', ()=> setFs(false));

  function setFs(on){
    const l = scroll.scrollLeft, t = scroll.scrollTop;
    S.gfs = !!on;
    frame.classList.toggle('fs', S.gfs);
    // iOS Safari has no Element.requestFullscreen, so this is a CSS state, not
    // the Fullscreen API. Lock the page behind it so only the graph scrolls.
    pageLock('gfs', S.gfs);
    // The frame is z-index 150 while fullscreen; lift the item sheet above it
    // so tapping a node still opens details.
    const sh = $('#sheet'); if(sh) sh.style.zIndex = S.gfs ? '400' : '';
    requestAnimationFrame(()=>{ scroll.scrollLeft = l; scroll.scrollTop = t; });
  }

  // ---- pinch zoom (two active pointers on the scroll container) ----
  const pts = new Map();
  let pinch = null;
  const dist = (a,b)=> Math.hypot(a.x-b.x, a.y-b.y);
  function startPinch(){
    const v = [...pts.values()];
    const r = scroll.getBoundingClientRect();
    pinch = {
      d: dist(v[0],v[1]) || 1,
      z: z,
      ax: (v[0].x+v[1].x)/2 - r.left,
      ay: (v[0].y+v[1].y)/2 - r.top,
    };
  }
  scroll.addEventListener('pointerdown', e=>{
    if(e.pointerType === 'mouse') return;
    pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(pts.size === 2) startPinch();
  });
  scroll.addEventListener('pointermove', e=>{
    if(!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(pts.size === 2 && pinch){
      const v = [...pts.values()];
      e.preventDefault();
      zoomTo(pinch.z * (dist(v[0],v[1]) / pinch.d), pinch.ax, pinch.ay);
    }
  }, {passive:false});
  const drop = e=>{ pts.delete(e.pointerId); if(pts.size < 2) pinch = null; };
  // pointerup / pointercancel only - NOT pointerleave: a finger drifting past
  // the frame edge mid-pinch would otherwise abort the gesture.
  scroll.addEventListener('pointerup', drop);
  scroll.addEventListener('pointercancel', drop);

  apply();
  centerRoot();
}

// Any craft re-render (or tab change) leaves the CSS-fullscreen state, so the
// page can never be left with body overflow locked by a frame that is gone.
function exitGraphFs(){
  if(!S.gfs) return;
  S.gfs = false;
  pageLock('gfs', false);
  const sh = $('#sheet'); if(sh) sh.style.zIndex = '';
}

// ---- raw materials aggregation ----
function computeRaw(name, mult, acc, stack){
  const rec = primaryRecipe(get(name));
  if(!rec || stack.has(name)){ acc[name] = (acc[name]||0) + mult; return; }
  const per = rec.amount || 1;
  const crafts = Math.ceil(mult/per);
  const ns = new Set(stack); ns.add(name);
  rec.ings.forEach(([inm,iq])=> computeRaw(inm, crafts*iq, acc, ns));
}
function renderRaw(name){
  const acc = {};
  computeRaw(name, (primaryRecipe(get(name))||{}).amount||1, acc, new Set());
  const rows = Object.entries(acc).sort((a,b)=>b[1]-a[1]);
  return `<div class="card raw-list">
    <div class="sec-h" style="margin-top:0">Total base materials for 1&times; ${esc(name)}</div>
    ${rows.map(([nm,q])=>{
      const nd=get(nm); const s=sourceOf(nd);
      return `<div class="row g8"><span class="qty">${q}&times;</span><button class="spr-btn" data-sheet="${esc(nm)}" style="background:none;border:0;padding:0">${spr(nm,'s24')}</button><span class="nm" style="flex:1"><span class="tap" data-focus2="${esc(nm)}">${esc(nm)}</span></span><span class="chip ${s.kind==='drop'?'drop':'base'}" style="font-size:10px">${s.kind==='drop'?'drop':'base'}</span></div>`;
    }).join('')}
    <div class="faint" style="font-size:11px;margin-top:10px">Assumes the primary recipe at each step; drops/mined items are the leaves.</div>
  </div>`;
}

// =====================  CLASSES  ===========================================
const CLASS_META = {melee:{em:'&#9876;',label:'Melee'},ranged:{em:'&#127993;',label:'Ranged'},mage:{em:'&#128302;',label:'Mage'},summoner:{em:'&#128123;',label:'Summoner'},rogue:{em:'&#127895;',label:'Rogue'}};
// Rogue is a damage class ADDED by Calamity - base-game Terraria has four. It
// is the one class-level fact the dataset cannot express (classes.json tags no
// src), so it is named here rather than guessed from the item mix: the Calamity
// rogue guide recommends 279 base-game items, so "has vanilla items" would have
// wrongly kept it.
const CAL_ONLY_CLASSES = ['rogue'];
// Vanilla progression ends at Moon Lord; every stage after it in the Calamity
// class guides (Pre-Providence onward) is Calamity-only content. Derived from
// the ordered stage list rather than a hardcoded stage-id set, so only ONE id
// is named - and if that id ever disappears the fallback keeps every stage that
// actually has visible items.
const LAST_VANILLA_STAGE = 'pre-moonlord';
let curClass = 'melee';
function visibleClasses(){
  return Object.keys(CLASS_META).filter(c =>
    S.classes[c] && (MODES.calamity || CAL_ONLY_CLASSES.indexOf(c) === -1));
}
const STAGE_GROUPS = [['armor','Armor'],['weapons','Weapons'],['accessories','Accessories'],['ammo','Ammo'],['buffs','Buffs / Potions']];
/** One stage's item lists, mode-filtered by each item's own src tag. */
function visStage(st){
  const out = {id: st.id, label: st.label, note: st.note, total: 0};
  STAGE_GROUPS.forEach(([k])=>{
    const arr = (st[k]||[]).filter(it => MODES.calamity || !isCalSrc(get(it.name)));
    out[k] = arr; out.total += arr.length;
  });
  return out;
}
function visibleStages(cls){
  const all = (cls && cls.stages) || [];
  let list = all;
  if(!MODES.calamity){
    const cut = all.findIndex(s => s.id === LAST_VANILLA_STAGE);
    if(cut >= 0) list = all.slice(0, cut + 1);
  }
  return list.map(visStage).filter(s => s.total > 0);
}
function renderClasses(){
  const a = app();
  const shown = visibleClasses();
  if(shown.indexOf(curClass) === -1) curClass = shown[0] || 'melee';
  const stages = visibleStages(S.classes[curClass]);
  const note = MODES.calamity
    ? 'Recommended gear by progression stage, from the Calamity class-setup guides. Tap any item for details &amp; its crafting tree.'
    : 'Recommended gear by progression stage, base game only &mdash; the class-setup guides filtered to vanilla Terraria items, up to Moon Lord. Turn Calamity on for the modded stages. Tap any item for details &amp; its crafting tree.';
  a.innerHTML = `<div class="view">
    <h2 class="vh">&#9876; Class Guides</h2>
    <div class="class-picker">
      ${shown.map(c=>`<button class="class-btn ${c===curClass?'on':''}" data-class="${c}"><span class="em">${CLASS_META[c].em}</span>${CLASS_META[c].label}${MODES.calamity && CAL_ONLY_CLASSES.indexOf(c)!==-1?' <span class="cal-badge">CAL</span>':''}</button>`).join('')}
    </div>
    <div class="muted" style="font-size:12.5px;margin:-4px 2px 12px">${note}</div>
    <div id="stages">${stages.length ? stages.map((st,i)=>stageBlock(st,i===0)).join('')
      : '<div class="faint center" style="margin-top:14px">No base-game recommendations for this class.</div>'}</div>
  </div>`;
  wireDelegation();
}
function stageBlock(st, open){
  const note = st.note ? `<div class="stage-note"><span class="sn-ic">&#128205;</span><span>${esc(st.note)}</span></div>` : '';
  const body = STAGE_GROUPS.map(([k,label])=>{
    const arr = st[k]||[];
    if(!arr.length) return '';
    return `<div class="grp-h">${label} <span class="grp-n">${arr.length}</span></div><div class="item-grid">${arr.map(it=>`<button class="item-cell${rarCls(get(it.name))}" data-sheet="${esc(it.name)}" title="${esc(it.name)}">${spr(it.name,'s32')}<span class="nm">${esc(it.name)}</span>${calBadgeFor(it.name)}</button>`).join('')}</div>`;
  }).join('');
  return `<details class="stage" ${open?'open':''}>
    <summary><span class="stg-name">${esc(st.label)}</span><span class="stg-cnt">${st.total} items</span></summary>
    <div class="stage-body">${note}${body||'<div class="faint">No data for this stage.</div>'}</div>
  </details>`;
}

// =====================  BOSSES  ============================================
/** A boss's drop rows, mode-filtered: a vanilla boss keeps its Calamity-added
 *  drops ONLY while Calamity is on (King Slime drops Aureus Cell in Calamity). */
function bossDrops(b){
  const d = (b && b.drops) || [];
  return MODES.calamity ? d : d.filter(x => srcOn(x.src));
}
function renderBosses(){
  const a = app();
  const list = visibleBosses();
  const note = MODES.calamity
    ? 'In Calamity + Infernum order. Tap a boss for its drops. Infernum reworks its AI &amp; some drops &mdash; see the vault boss pages for fight strategy.'
    : 'Base-game Terraria progression order. Tap a boss for its drops. Turn Calamity on to interleave its bosses and modded drops.';
  a.innerHTML = `<div class="view">
    <h2 class="vh">&#128128; Boss Progression</h2>
    <div class="muted" style="font-size:12.5px;margin:-4px 2px 12px">${note}</div>
    <div class="mode-count">${list.length} boss${list.length===1?'':'es'}${MODES.calamity?'':' &mdash; vanilla only, 0 modded entries'}</div>
    <div class="boss-list">
      ${list.map((b,i)=>{const dr=bossDrops(b);return `<button class="boss-row" data-boss="${esc(b.name)}">
        <span class="idx">${i+1}</span>
        ${sprFrom(b.img,b.imgRemote,'s40')}
        <span class="bn"><span class="t">${esc(b.name)}${calBadge(b)}</span><span class="d">${dr.length} drops</span></span>
        <span class="cnt">&rsaquo;</span>
      </button>`;}).join('')}
    </div>
  </div>`;
  wireDelegation();
}
function bossSheet(name){
  const b = S.bosses.find(x=>x.name===name);
  if(!b) return;
  const drops = bossDrops(b);
  const pos = visibleBosses().indexOf(b);
  const body = `
    <div class="sheet-grab"></div>
    ${sheetCrumb('Bosses', {t:'boss', i:name, n:name})}
    <div class="row g8">${sprFrom(b.img,b.imgRemote,'s56')}<div><h3>${esc(b.name)}${calBadge(b)}</h3><div class="muted" style="font-size:12px">Boss #${(pos>=0?pos:b.order)+1} · ${drops.length} drops</div></div></div>
    ${b.desc?`<p class="desc">${esc(b.desc)}</p>`:''}
    <div class="sec-h">Drops</div>
    ${drops.length? `<div class="item-grid">${drops.map(d=>`<div class="item-cell${rarCls(get(d.item))}" data-sheet="${esc(d.item)}">${spr(d.item,'s32')}<span class="nm">${esc(d.item)}</span>${calBadge(d)}<span class="faint" style="font-size:11px">${esc(d.chance||'')}</span></div>`).join('')}</div>` : '<div class="faint">Drop data not catalogued for this boss.</div>'}
    <div class="faint" style="font-size:11px;margin-top:12px">Fight strategy &amp; Infernum reworks live in the Fiiiish Island vault boss pages.</div>
  `;
  openSheet(body, {t:'boss', i:name, n:name});
}

// =====================  ITEMS BROWSE  ======================================
/** Search-box placeholder. The number is DERIVED from the loaded dataset. */
function searchPlaceholder(){
  const n = S.vNames.length.toLocaleString();
  return MODES.calamity
    ? `Search ${n} items (vanilla + Calamity)…`
    : `Search ${n} vanilla items…`;
}
/** The Items-tab "what am I looking at" line. Calamity mode gets a src filter. */
function srcFilterRow(){
  if(!MODES.calamity){
    return `<div class="mode-count">Showing <b>vanilla only</b> &mdash; 0 modded entries mixed in</div>`;
  }
  const opts = [['all','All'],['vanilla','Vanilla'],['calamity','Calamity only']];
  return `<div class="src-filters">${opts.map(([k,l])=>
    `<button class="sfbtn${S.srcFilter===k?' on':''}${k==='calamity'?' cal':''}" data-srcfilter="${k}">${l}</button>`).join('')}</div>`;
}
function renderItems(){
  const a = app();
  a.innerHTML = `<div class="view">
    <div class="search-wrap">
      <span class="search-ic">&#128269;</span>
      <input id="itemSearch" class="search" placeholder="${esc(searchPlaceholder())}" autocomplete="off" spellcheck="false" />
      <button class="search-clear" id="itemClear" hidden>&times;</button>
    </div>
    <div class="filters">
      ${[['all','All'],['craft','Craftable'],['drop','Dropped'],['armor','Armor'],['weapons','Weapons'],['melee','Melee'],['ranged','Ranged'],['mage','Mage'],['summoner','Summoner']]
        .concat(MODES.calamity?[['rogue','Rogue']]:[])
        .map(([k,l])=>`<button class="fbtn ${S.itemFilter===k?'on':''}" data-filter="${k}">${l}</button>`).join('')}
    </div>
    ${srcFilterRow()}
    <div id="itemList"></div>
  </div>`;
  renderItemList('');
  const inp = $('#itemSearch');
  inp.addEventListener('input', ()=>{ S.itemLimit=60; renderItemList(inp.value.trim()); $('#itemClear').hidden=!inp.value; });
  $('#itemClear').addEventListener('click', ()=>{ inp.value=''; $('#itemClear').hidden=true; renderItemList(''); });
  wireDelegation();
}
function matchFilter(node){
  // The src filter is a SECOND axis on top of the type filter, and only exists
  // in Calamity mode (in Vanilla mode there is nothing to split).
  if(MODES.calamity && S.srcFilter !== 'all'){
    const isCal = isCalSrc(node);
    if(S.srcFilter === 'calamity' && !isCal) return false;
    if(S.srcFilter === 'vanilla' && isCal) return false;
  }
  const f = S.itemFilter;
  if(f==='all') return true;
  if(f==='craft') return !!primaryRecipe(node);
  if(f==='drop') return visDrops(node).length > 0;
  if(f==='armor') return !!(node.types && node.types.includes('armor'));
  if(f==='weapons') return !!(node.types && node.types.includes('weapons'));
  return node.classes && node.classes.includes(f);
}
function renderItemList(q){
  const ql = q.toLowerCase();
  const host = $('#itemList');
  const hasSets = S.itemFilter==='armor' && visibleSets().length>0;

  if(hasSets && !S.armorFlat){
    renderArmorSets(q, host);
    return;
  }

  let matches = S.vNames.filter((n,i)=>{
    const node = S.db[n];
    if(!matchFilter(node)) return false;
    return !ql || S.vLower[i].includes(ql);
  });
  const total = matches.length;
  const shown = matches.slice(0, S.itemLimit);
  const toggle = hasSets ? `<div class="set-toolbar"><button class="fbtn set-toggle" data-armorview="sets">&larr; Armor sets</button></div>` : '';
  host.innerHTML = `${toggle}<div class="item-grid">${shown.map(n=>{
    const node=S.db[n];
    return `<div class="item-cell${node.historical?' is-removed':''}${rarCls(node)}" data-sheet="${esc(n)}">${spr(n,'s32')}<span class="nm">${esc(n)}</span>${calBadge(node)}<span class="tags">${primaryRecipe(node)?'<span class="chip craft" style="font-size:10px">craft</span>':''}${visDrops(node).length?'<span class="chip drop" style="font-size:10px">drop</span>':''}${node.historical?'<span class="chip removed" style="font-size:10px">removed</span>':''}</span></div>`;
  }).join('')}</div>
  ${total>S.itemLimit?`<button class="load-more" id="loadMore">Show more (${total-S.itemLimit} more)</button>`:`<div class="faint center" style="margin-top:10px;font-size:12px">${total} item${total===1?'':'s'}</div>`}`;
  const lm = $('#loadMore');
  if(lm) lm.addEventListener('click', ()=>{ S.itemLimit+=80; renderItemList(q); });
}

// =====================  ARMOR SETS (wiki-style grouped browse)  ============
// data/armor-sets.json: { meta, sets: { <setId>: { id,name,src,pieces,setBonus,perHelmet,desc,img } } }
// Guarded end to end: with no file (404) or an empty {sets:{}}, S.sets stays
// {} and the Armor chip quietly falls back to the ordinary flat item list
// (matchFilter's 'armor' case still works off node.types once that lands).
// The set's own wiki page ("Aerospec armor") is itself an item node, so the
// dataset keeps it in pieces (sorted last). It is NOT a wearable piece - its
// Defense is the set total ("20/18/16/15/17"), it has no tooltip and no recipe -
// so it must not appear as a row, be counted, or be summed into the cost.
// Two exceptions, both real:
//   1. A few Calamity sets have a CHESTPIECE literally named after the set
//      (Silva/Statigel/Hydrothermic armor). Those are craftable and carry a real
//      per-piece tooltip, so a self-named node WITH a recipe is a genuine piece.
//   2. ~38 vanilla sets exist in the dataset only as their aggregate page node.
//      Dropping it there would leave an empty sheet, so keep it as the fallback.
function realPieces(set){
  const ps = (set && set.pieces) || [];
  const real = ps.filter(p=>{
    if(p !== set.name) return true;
    const nd = get(p);
    return !!(nd && nd.recipes && nd.recipes.length);
  });
  return real.length ? real : ps;
}
function setCardIcon(set, cls='s32'){
  const first = realPieces(set).find(p=>get(p));
  return first ? spr(first, cls) : `<span class="spr-wrap miss ${cls}"></span>`;
}
function setOrderHint(set){
  const v = (set && (set.order ?? set.tier ?? set.stage));
  return typeof v === 'number' ? v : null;
}
function renderArmorSets(q, host){
  const ql = q.toLowerCase();
  let entries = visibleSets().filter(([id,set])=>{
    if(!ql) return true;
    if(set.name && set.name.toLowerCase().includes(ql)) return true;
    return (set.pieces||[]).some(p=>p.toLowerCase().includes(ql));
  });
  entries.sort((a,b)=>{
    const oa = setOrderHint(a[1]), ob = setOrderHint(b[1]);
    if(oa!=null && ob!=null) return oa-ob;
    return (a[1].name||a[0]).localeCompare(b[1].name||b[0]);
  });
  const toolbar = `<div class="set-toolbar">
    <button class="fbtn set-toggle" data-armorview="pieces">Pieces</button>
    <span class="faint" style="font-size:11.5px">${entries.length} set${entries.length===1?'':'s'}${MODES.calamity?'':' &mdash; vanilla only'}</span>
  </div>`;
  const cards = entries.map(([id,set])=>{
    // A set whose only listed "piece" is its own page node has no piece pages
    // in this dataset - claiming "1 piece" there would be a wrong number.
    const wearable = realPieces(set).filter(p=>p!==set.name && get(p));
    const tag = wearable.length ? `${wearable.length} piece${wearable.length===1?'':'s'}` : 'set page';
    return `<button class="item-cell set-card" data-setsheet="${esc(id)}">${setCardIcon(set,'s32')}<span class="nm">${esc(set.name||id)}</span>${calBadge(set)}<span class="tags"><span class="chip craft" style="font-size:10px">${tag}</span></span></button>`;
  }).join('');
  host.innerHTML = `${toolbar}<div class="item-grid set-grid">${cards}</div>${!entries.length?`<div class="faint center" style="margin-top:10px;font-size:12px">No matching sets</div>`:''}`;
}
function defenseOf(node){
  if(!node || !node.stats) return null;
  for(let i=0;i<node.stats.length;i++){
    if(String(node.stats[i][0]).toLowerCase()==='defense') return node.stats[i][1];
  }
  return null;
}
function computeSetCost(pieces){
  const acc = {}; const stations = [];
  pieces.forEach(p=>{
    const nd = get(p);
    const rec = primaryRecipe(nd);
    if(!rec) return;
    if(rec.station && stations.indexOf(rec.station)===-1) stations.push(rec.station);
    (rec.ings||[]).forEach(([inm,iq])=>{ acc[inm] = (acc[inm]||0) + (Number(iq)||0); });
  });
  return { rows: Object.entries(acc).sort((a,b)=>b[1]-a[1]), stations };
}
function setWikiUrl(set, id){
  const host = (set && set.wikiHost) || 'https://calamitymod.wiki.gg';
  const page = (set && (set.wiki || set.name)) || id;
  return host + '/wiki/' + encodeURIComponent(String(page).replace(/ /g,'_'));
}
// Which wiki a link points at, read off the URL itself. Before T2 this was two
// separate `src === 'terraria'` / `node.wikiHost ? ...` guesses; the src tag is
// 'vanilla' (never 'terraria'), so the set-page label read "Calamity Wiki" on
// all 91 vanilla sets while linking at terraria.wiki.gg.
function wikiHostLabel(url){
  return String(url||'').indexOf('terraria.wiki.gg') !== -1 ? 'Terraria' : 'Calamity';
}
/** The human name of a record's own source mod, for the sheet subline. */
function srcLabel(x){ return isCalSrc(x) ? 'Calamity' : 'Terraria (vanilla)'; }
// ---- helmet variants -------------------------------------------------------
// Terraria/Calamity armor sets routinely ship several MUTUALLY EXCLUSIVE
// helmets (God Slayer 3, Auric Tesla 5, Aerospec 5). Adding them together is
// nonsense - the wiki prints ONE set total per helmet ("120 / 105 / 100").
// Variants are read from the wiki's own perHelmet map when it names 2+ pieces
// of this set, otherwise from the derived Helmet slot label.
// The UNION of the two signals, not either alone: Statigel has five helmet
// pages but perHelmet names only three, and trusting perHelmet on its own
// folded the other two into the base and summed them as if worn together -
// the same defect this whole function exists to prevent.
function helmetVariants(set, pieces){
  const ph = Object.keys((set && set.perHelmet) || {});
  const isHelm = p => ph.indexOf(p)!==-1 || slotLabel(p)==='Helmet';
  const helms = pieces.filter(isHelm);          // keeps the set's own order
  return helms.length >= 2 ? helms : [];
}
/**
 * {mode:'single', total} | {mode:'variants', base, rows:[[helmet,total],...]} | null
 * null = at least one piece has no plain-integer Defense, so NO total is printed
 * (a partial sum would be a wrong number - RULES R2).
 */
function setDefense(set, pieces){
  const defs = {};
  for(const p of pieces){
    const d = statInt(get(p), 'Defense');
    if(d == null) return null;
    defs[p] = d;
  }
  if(!pieces.length) return null;
  const helms = helmetVariants(set, pieces);
  if(helms.length < 2){
    let t = 0; pieces.forEach(p=>{ t += defs[p]; });
    return {mode:'single', total:t};
  }
  let base = 0;
  pieces.forEach(p=>{ if(helms.indexOf(p)===-1) base += defs[p]; });
  return {mode:'variants', base, rows: helms.map(h=>[h, base + defs[h]])};
}
/** Set sell price in copper, or null. Exclusive helmets => no single price. */
function setSell(set, pieces){
  if(!pieces.length) return null;
  const cs = {};
  for(const p of pieces){
    const c = parseCoins(statVal(get(p), 'Sell'));
    if(c == null) return null;
    cs[p] = c;
  }
  if(helmetVariants(set, pieces).length >= 2) return null;
  let t = 0; pieces.forEach(p=>{ t += cs[p]; });
  return t;
}

/** English list: [a] -> "a", [a,b] -> "a and b", [a,b,c] -> "a, b and c". */
function joinList(parts){
  if(parts.length<=1) return parts[0]||'';
  return parts.slice(0,-1).join(', ') + ' and ' + parts[parts.length-1];
}
function pieceChip(p){
  return `<span class="wk-chip" data-sheet="${esc(p)}" style="display:inline-flex">${spr(p,'s24')}<span>${esc(p)}</span></span>`;
}

// The wiki-layout armor-set page. Two shapes:
//   NORMAL     - the set has real wearable piece pages.
//   AGGREGATE  - the set exists in this dataset ONLY as its own summary page
//                (35 vanilla sets). It then has no pieces to list, so it gets
//                no piece cards, no "consists of" chips and no "(N pieces)"
//                claim - a self-referential card/chip is never rendered.
function armorSetSheet(setId){
  const set = S.sets && S.sets[setId];
  if(!set) return;
  const setName = set.name || setId;
  const listed = realPieces(set).filter(p=>get(p));
  // The set's own page node is not a wearable row. Three Calamity sets
  // (Silva / Statigel / Hydrothermic) file a REAL body piece under the set's
  // own name - it keeps counting toward the totals, but it is surfaced as a
  // labelled note instead of a card that appears to point back at this page.
  const selfPiece = listed.indexOf(setName) !== -1 ? setName : null;
  const selfIsReal = !!(selfPiece && primaryRecipe(get(setName)));
  const cards = listed.filter(p=>p!==setName);              // what gets rendered
  const counted = selfIsReal ? cards.concat([setName]) : cards;   // what gets summed
  const aggregate = cards.length === 0;
  const aggNode = get(setName);

  // --- derived full-set numbers (omitted whenever any input fails to parse)
  const def = aggregate ? null : setDefense(set, counted);
  const sellTotal = aggregate ? null : setSell(set, counted);
  const helms = aggregate ? [] : helmetVariants(set, counted);
  const helmTotal = {};
  if(def && def.mode==='variants') def.rows.forEach(([h,t])=>{ helmTotal[h]=t; });

  // rarity is only asserted when every rendered piece agrees on it
  const rsrc = aggregate ? (aggNode?[aggNode]:[]) : cards.map(get);
  const rks = rsrc.map(rarSlug);
  const rk = (rks.length && rks.every(k=>k && k===rks[0])) ? rks[0] : null;
  const rarv = rk ? ' rar-'+rk : '';
  const rarLab = rk ? (RAR_LABEL[rk]||'').replace(/^rarity\s+/i,'') : null;

  const cls = [], stg = [];
  (aggregate ? (aggNode?[aggNode]:[]) : counted.map(get)).forEach(nd=>{
    // visClasses, not nd.classes: the set subline is the same Rogue leak as the
    // item rows (a vanilla set whose pieces carry a Calamity-only class tag).
    visClasses(nd).forEach(c=>{ if(cls.indexOf(c)===-1) cls.push(c); });
    ((nd&&nd.stages)||[]).forEach(c=>{ if(stg.indexOf(c)===-1) stg.push(c); });
  });

  const subBits = [];
  if(rarLab) subBits.push(`Rarity: <span class="wk-rar">${esc(rarLab)}</span>`);
  subBits.push(aggregate ? 'Armor set' : `Armor set &mdash; ${cards.length} piece${cards.length===1?'':'s'}`);
  const stgL = stg.map(stageLabel).filter(Boolean);
  if(stgL.length) subBits.push(esc(stgL.slice(0,2).join(' / ')));
  if(cls.length) subBits.push(esc(cls.map(c=>c[0].toUpperCase()+c.slice(1)).join(' / ')));
  if(set.src) subBits.push(esc(srcLabel(set)));

  // --- infobox
  const art = (aggregate ? [setName] : cards).map(p=>spr(p,'s48')).join('') || setCardIcon(set,'s48');
  const bonusTxt = dvText(set.setBonus);
  const bonusFirst = bonusTxt ? bonusTxt.split('\n')[0] : '';
  const rows = [];
  rows.push(`<tr><td>Type</td><td>Armor &mdash; Set${aggregate?'':` (${cards.length} piece${cards.length===1?'':'s'})`}</td></tr>`);
  if(def && def.mode==='single'){
    rows.push(`<tr><td>Defense</td><td><b>${def.total}</b> (total)</td></tr>`);
  } else if(def && def.mode==='variants'){
    rows.push(`<tr><td>Defense</td><td><b>${def.rows.map(r=>r[1]).join(' / ')}</b> <span class="wk-more">one total per helmet variant</span></td></tr>`);
  } else {
    // aggregate-only sets carry the wiki's own defense string; it is printed
    // verbatim (after the template guard) and never re-summed.
    const raw = dv(defenseOf(aggNode));
    if(raw) rows.push(`<tr><td>Defense</td><td>${esc(raw)} <span class="wk-more">as listed on the wiki</span></td></tr>`);
  }
  // The FULL bonus, not just its first line. 79 of the 122 sets that have a set
  // bonus are multi-line, and printing only line 1 silently dropped real
  // mechanics - Molten armor read "+25 defense" with its melee bonuses and its
  // On Fire!/Burning immunities cut off. The cell is already white-space:
  // pre-line (.wk-bonus-row), so the remaining lines render as written; the
  // first line keeps the .wk-bn emphasis it always had.
  if(bonusTxt){
    const bl = bonusTxt.split('\n');
    rows.push(`<tr class="wk-bonus-row"><td>Set bonus</td><td><span class="wk-bn">${esc(bl[0])}</span>${
      bl.length>1 ? '\n' + esc(bl.slice(1).join('\n')) : ''}</td></tr>`);
  }
  if(sellTotal!=null){
    rows.push(`<tr><td>Sell</td><td class="wk-coin">${esc(formatCoins(sellTotal))} (set)</td></tr>`);
  } else if(aggregate){
    const s = dv(statVal(aggNode,'Sell'));
    if(s) rows.push(`<tr><td>Sell</td><td class="wk-coin">${esc(s)}</td></tr>`);
  }
  const box = infobox('Statistics — full set', art, '', `<table class="wk-stats">${rows.join('')}</table>`, rk?' rar':'');

  // --- lead paragraph + "consists of"
  const descTxt = dvText(set.desc);
  const descHtml = descTxt
    ? `<p class="wk-lead"><b>${esc(setName)}</b>${esc(descTxt.replace(new RegExp('^'+setName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),''))}</p>`
    : '';
  let consists = '';
  if(!aggregate){
    const nonHelm = cards.filter(p=>helms.indexOf(p)===-1);
    consists = (helms.length>=2)
      ? `<p class="wk-lead">It consists of ${joinList(nonHelm.map(pieceChip))}, plus one of ${helms.length} helmet variants: ${joinList(helms.map(pieceChip))}.</p>`
      : `<p class="wk-lead">It consists of ${joinList(cards.map(pieceChip))}.</p>`;
  }

  // --- full-set grants: derived only. Helmet lines are NOT merged into the
  // list when the helmets are exclusive - they are pointed at instead.
  const grants = [];
  if(def && def.mode==='single') grants.push(`<li><b>+${def.total}</b> defense (total)</li>`);
  if(def && def.mode==='variants') grants.push(`<li><b>+${def.rows.map(r=>r[1]).join(' / +')}</b> defense (one total per helmet variant)</li>`);
  (aggregate ? [] : counted).forEach(p=>{
    if(helms.indexOf(p)!==-1) return;
    splitTip(get(p).tip).lines.forEach(l=>
      grants.push(`<li>${esc(l)} <span class="wk-more" style="display:inline">&mdash; ${esc(p)}</span></li>`));
  });
  if(helms.length>=2) grants.push(`<li>Helmet bonuses differ per variant &mdash; see <b>Set pieces</b> below.</li>`);
  const grantsHtml = grants.length ? `<ul class="wk-grants">${grants.join('')}</ul>` : '';

  // --- piece cards
  const pieceCards = cards.map(p=>{
    const nd = get(p);
    const d = dv(defenseOf(nd));
    const sell = dv(statVal(nd,'Sell'));
    const slot = slotLabel(p);
    const tip = splitTip(nd.tip).lines.join('\n');
    const mini = [];
    if(d)    mini.push(`Defense <b>${esc(d)}</b>`);
    if(sell) mini.push(`Sell <b>${esc(sell)}</b>`);
    if(helmTotal[p]!=null) mini.push(`Set total <b>${helmTotal[p]}</b>`);
    return `<div class="wk-piece" data-sheet="${esc(p)}">
      <div class="wk-ic">${spr(p,'s32')}</div>
      <div class="wk-pbody">
        <span class="wk-nm">${esc(p)}</span>${slot?`<span class="wk-slot">${esc(slot)}</span>`:''}
        ${tip?`<div class="wk-ptip">${esc(tip)}</div>`:''}
        ${mini.length?`<div class="wk-mini">${mini.join(' &middot; ')}</div>`:''}
      </div>
      <span class="wk-chev">&rsaquo;</span>
    </div>`;
  }).join('');
  const selfNote = selfIsReal
    ? `<div class="wk-note"><span>&#8505;</span><span>The wiki files one more piece of this set under the set's own name. It is counted in the totals above &mdash; <button class="wk-inline-link" data-sheet="${esc(setName)}">open its item page &rsaquo;</button></span></div>`
    : '';
  const aggNote = aggregate
    ? `<div class="wk-note"><span>&#8505;</span><span>This set is catalogued on the wiki as a <b>single set page</b>; individual piece pages are not in this dataset, so no per-piece stats are shown.</span></div>`
    : '';

  const bonusHtml = bonusTxt
    ? `<div class="wk-h2">Set bonus</div><div class="wk-bonus">${bonusFirst?`<div class="wk-bn">&#9889; ${esc(bonusFirst)}</div>`:''}${esc(bonusTxt.split('\n').slice(1).join('\n'))}</div>`
    : '';
  const perHelmetHtml = (set.perHelmet && Object.keys(set.perHelmet).length)
    ? `<div class="wk-h2">Per-helmet bonus</div>${Object.entries(set.perHelmet).map(([h,txt])=>
        `<div class="wk-piece"${get(h)?` data-sheet="${esc(h)}"`:''}><div class="wk-ic">${get(h)?spr(h,'s32'):''}</div>
          <div class="wk-pbody"><span class="wk-nm">${esc(h)}</span><div class="wk-ptip">${esc(dvText(txt))}</div></div>
          ${get(h)?'<span class="wk-chev">&rsaquo;</span>':''}</div>`).join('')}`
    : '';

  // --- how to obtain: one wiki-style recipe card per piece (the set's own page
  // node too when it is a real craftable piece / the only node there is)
  const recipeFor = aggregate ? (aggNode ? [setName] : []) : counted;
  const pieceRecipes = recipeFor.map(p=>{
    const r = primaryRecipe(get(p));
    return r ? recipeCard(r, p) : '';
  }).join('');
  const anyRecipe = recipeFor.some(p=>primaryRecipe(get(p)));
  const obtainHead = `<div class="wk-h2">How to obtain</div>` + (anyRecipe
    ? `<div class="wk-note"><span>&#128296;</span><span><b>Craftable</b>${aggregate?'.':' &mdash; one recipe per piece.'}</span></div>`
    : `<div class="wk-note"><span>&#8505;</span><span>No crafting recipe in this dataset for this set &mdash; see the wiki page below.</span></div>`);

  const cost = computeSetCost(recipeFor);
  const costHtml = cost.rows.length ? `<div class="wk-h2">Total crafting cost</div>
    <div class="wk-recipe">${cost.stations.length?`<div class="wk-station">Crafted at &nbsp;<b>${cost.stations.map(esc).join('</b> <i>or</i> <b>')}</b></div>`:''}
    ${cost.rows.map(([nm,qv])=>`<div class="wk-row" data-sheet="${esc(nm)}">${spr(nm,'s24')}<span class="wk-ing">${esc(nm)}</span><span class="wk-amt">&times;${qv}</span></div>`).join('')}</div>` : '';

  openSheet(`
    <div class="sheet-grab"></div>
    ${sheetCrumb('Armor', {t:'set', i:setId, n:setName})}
    <div class="${rarv.trim()}">
      <h3 class="wk-title${rk?' rar-on':''}">${esc(setName)}${calBadge(set,'title')}</h3>
      <div class="wk-sub">${subBits.join(' &nbsp;&middot;&nbsp; ')}</div>
      ${box}
    </div>
    ${descHtml}
    ${consists}
    ${grantsHtml?`<div class="wk-h2">Full set grants</div>${grantsHtml}`:''}
    ${aggregate ? aggNote : `<div class="wk-h2">Set pieces</div>${pieceCards}${selfNote}`}
    ${bonusHtml}
    ${perHelmetHtml}
    ${obtainHead}
    ${pieceRecipes}
    ${costHtml}
    <a class="big-btn alt" href="${esc(setWikiUrl(set,setId))}" target="_blank" rel="noopener">Open on ${wikiHostLabel(setWikiUrl(set,setId))} Wiki &#8599;</a>
  `, {t:'set', i:setId, n:setName});
}

// =====================  ITEM SHEET  ========================================
// Page scroll lock, shared by the item sheet and the graph's CSS fullscreen.
// Reason-counted, so closing the sheet while the graph is still fullscreen
// (or exiting fullscreen with the sheet still open) cannot unlock the page for
// the overlay that is still up. Both documentElement AND body are locked: the
// app also runs mounted inside the fiiiish-app shell, whose page is a tall
// scroller of its own, and iOS will happily hand the swipe to whichever of the
// two is the viewport scroller if only one is pinned.
const PAGE_LOCKS = new Set();
function pageLock(reason, on){
  if(on) PAGE_LOCKS.add(reason); else PAGE_LOCKS.delete(reason);
  const v = PAGE_LOCKS.size ? 'hidden' : '';
  document.documentElement.style.overflow = v;
  document.body.style.overflow = v;
}
// ---- sheet back-stack ------------------------------------------------------
// The wiki-style sheets are deeply tap-through (every ingredient, used-in chip,
// set piece and "consists of" link opens another sheet in place). Without a
// trail there is no way back except closing and re-finding the item, so every
// sheet records a {t,i,n} entry and renders a "<- <previous>" crumb button.
// Re-opening the sheet that is already on top does NOT push a duplicate.
const SHEET_STACK = [];
function openSheet(html, entry){
  if(entry){
    const top = SHEET_STACK[SHEET_STACK.length-1];
    if(!top || top.t!==entry.t || top.i!==entry.i) SHEET_STACK.push(entry);
  }
  $('#sheetBody').innerHTML = html; $('#sheetBody').scrollTop = 0; $('#sheet').hidden=false; pageLock('sheet', true);
}
function closeSheet(){ SHEET_STACK.length = 0; $('#sheet').hidden=true; pageLock('sheet', false); }
function reopenSheet(entry){
  if(!entry) return closeSheet();
  if(entry.t==='set') return armorSetSheet(entry.i);
  if(entry.t==='boss') return bossSheet(entry.i);
  if(entry.t==='mods') return modPickerSheet();
  return itemSheet(entry.i);
}
function sheetBack(){
  SHEET_STACK.pop();                       // drop the sheet on screen
  const prev = SHEET_STACK[SHEET_STACK.length-1];
  if(!prev) return closeSheet();
  reopenSheet(prev);                       // openSheet dedups: stack unchanged
}
// The crumb row. Rendered BEFORE openSheet() pushes `entry`, so the sheet being
// navigated away from is still on top of the stack - unless this is a re-open
// of the sheet already on top (the back path), in which case step one further.
// `label` is the section this sheet belongs to (Items / Armor / Bosses).
function sheetCrumb(label, entry){
  const top = SHEET_STACK[SHEET_STACK.length-1];
  const same = top && entry && top.t===entry.t && top.i===entry.i;
  const prev = same ? SHEET_STACK[SHEET_STACK.length-2] : top;
  const back = prev ? `&larr; ${esc(truncate(prev.n||prev.i,26))}` : '&times; Close';
  return `<div class="wk-crumb"><button class="wk-back" data-sheetback>${back}</button>${label?`<span class="wk-path">/ ${esc(label)}</span>`:''}</div>`;
}
// =====================  WIKI-LAYOUT BUILDING BLOCKS  ========================
// Everything below renders the approved wiki mockup. Hard rule throughout:
// nothing is invented. A value is shown only when the dataset carries it; a
// derived value (defense total, set sell price, body slot) is shown only when
// EVERY input it depends on parsed cleanly, otherwise the row is omitted.

// ---- wiki template junk (generic guard, applied to every rendered value) ----
// Some values in the dataset are raw, unresolved MediaWiki template text - e.g.
// Beetle armor's Defense is literally
//   "link=|Beetle Scale Mail|20x16px : 61 / link=|Beetle Shell|20x16px : 73 (set)"
// Raw template markup must never reach the DOM ANYWHERE, so every wiki-sourced
// string is passed through one of these two guards before it is rendered.
//   dv()     - for TABLE VALUES: unwraps the one template form that carries
//              real information ("link=|<name>|<w>x<h>px : <n>" -> "<name>: <n>")
//              and returns null if any template syntax survives, so the caller
//              omits the row rather than printing junk.
//   dvText() - for PROSE (tooltips, descriptions, set bonuses, drop rows):
//              same unwrap, then strips any residual template tokens so a whole
//              paragraph is never lost to one bad substring.
const TPL_JUNK = /(link\s*=|\{\{|\}\}|\[\[|\]\]|\d+\s*x\s*\d+\s*px)/i;
// Two template shapes appear in the dataset:
//   1. "link=|Beetle Scale Mail|20x16px : 61"   (a value with a real number)
//   2. "(16x12px|link=Desktop version history|Desktop version)"  (an icon
//      annotation on a tooltip line - pure noise)
// Shape 1 is unwrapped to keep its information; shape 2 is deleted whole; then
// a generic scrub removes any other template token that survives.
const TPL_LINK = /link\s*=\s*\|([^|]+)\|\s*\d+\s*x\s*\d+\s*px\s*:/gi;
const TPL_PAREN = /\(\s*[^()]*?(?:link\s*=|\d+\s*x\s*\d+\s*px)[^()]*?\)/gi;
function stripTpl(v){
  let s = String(v);
  s = s.replace(TPL_LINK, '$1:');
  s = s.replace(TPL_PAREN, '');
  if(TPL_JUNK.test(s)){
    s = s.replace(/\d+\s*x\s*\d+\s*px/gi, '')
         .replace(/link\s*=\s*\|?/gi, '')
         .replace(/\{\{|\}\}|\[\[|\]\]/g, '')
         .replace(/\(\s*\|*\s*\)/g, '')
         .replace(/\|+/g, ' ');
  }
  return s.replace(/\s{2,}/g,' ').replace(/\s+([,.;:)])/g,'$1').trim();
}
function dv(v){
  if(v==null) return null;
  const s = stripTpl(v);
  if(!s) return null;
  return TPL_JUNK.test(s) ? null : s;   // still templated -> omit the row
}
function dvText(v){
  if(v==null) return '';
  const s = stripTpl(v);
  return TPL_JUNK.test(s) ? '' : s;     // never let markup reach the DOM
}

function statVal(node, key){
  if(!node || !node.stats) return null;
  const k = String(key).toLowerCase();
  for(let i=0;i<node.stats.length;i++){
    if(String(node.stats[i][0]).toLowerCase()===k) return node.stats[i][1];
  }
  return null;
}
/** A stat as an integer, or null when it is not a bare number ("20", not "20/18/16"). */
function statInt(node, key){
  const v = statVal(node, key);
  return (v!=null && /^\d+$/.test(String(v).trim())) ? parseInt(v,10) : null;
}

// ---- coin values -----------------------------------------------------------
// Sell/Buy arrive as wiki coin strings ("40 gold", "2 gold 50 silver",
// "No value"). Parsed to copper so a SET's total can be summed and reprinted in
// the same notation; anything that does not parse returns null and the caller
// drops the row rather than printing a wrong price.
const COIN_UNITS = [['platinum',1000000],['gold',10000],['silver',100],['copper',1]];
function parseCoins(str){
  if(str==null) return null;
  const s = String(str).toLowerCase();
  let total = 0, hit = false;
  for(const [unit,mult] of COIN_UNITS){
    const m = s.match(new RegExp('(\\d+)\\s*' + unit));
    if(m){ total += parseInt(m[1],10) * mult; hit = true; }
  }
  return hit ? total : null;
}
function formatCoins(copper){
  if(copper==null) return null;
  if(copper<=0) return 'No value';
  const out = [];
  let rest = copper;
  for(const [unit,mult] of COIN_UNITS){
    const n = Math.floor(rest/mult);
    if(n>0){ out.push(n + ' ' + unit); rest -= n*mult; }
  }
  return out.join(' ');
}

// ---- tooltip / flavour split ----------------------------------------------
// node.tip is the in-game tooltip, ' · '-joined. Terraria flavour text is the
// trailing QUOTED run (it can span several joined segments, as on the Wulfrum
// Blunderbuss). Only split when the run both starts and ends on a quote, so a
// mechanical line that merely opens with an apostrophe is never eaten.
function splitTip(tip){
  // sanitised PER SEGMENT, so one templated line never costs the whole tooltip
  const parts = String(tip||'').split(' · ').map(dvText).filter(x=>x.trim());
  if(!parts.length) return {lines:[], flavor:[]};
  const startsQ = /^["'‘“]/;
  const endsQ   = /["'’”]$/;
  let at = -1;
  for(let i=0;i<parts.length;i++){ if(startsQ.test(parts[i].trim())){ at = i; break; } }
  if(at >= 0 && endsQ.test(parts[parts.length-1].trim())) {
    return {lines: parts.slice(0,at), flavor: parts.slice(at)};
  }
  return {lines: parts, flavor: []};
}
function tipBlock(node){
  if(!node || !node.tip) return '';
  const {lines, flavor} = splitTip(node.tip);
  const html = lines.map(l=>`<div>${esc(l)}</div>`).join('')
    + flavor.map(l=>`<div class="wk-flav">${esc(l)}</div>`).join('');
  return html ? `<div class="wk-tip">${html}</div>` : '';
}

// ---- body slot -------------------------------------------------------------
// The dataset has NO slot field on armor pieces, so the slot is read off the
// piece's name. Omission beats a guess (RULES R2): a name whose final word is
// not in one of these three lists gets NO label rather than a wrong one.
const SLOT_WORDS = {
  Helmet: ['helmet','helm','mask','hood','headgear','visage','hat','facemask','greathelm','shellmet','cap','cowl','circlet','turban','headcrab','goggles','visor','crown','horns','hairclip','headpiece','bandana','tiara','mane','antlers'],
  Shirt:  ['breastplate','chestplate','cuirass','mail','plate','coat','vest','robes','robe','dress','shirt','jacket','cloak','gi','toga','shellplate','bodyarmor','chestguard','bodysuit','tunic','top','harness'],
  Pants:  ['greaves','leggings','cuisses','boots','pants','overalls','schynbaulds','subligar','shelleggings','striders','trousers','legguards','waders','skirt','tights','sabatons','chausses'],
};
function slotLabel(name){
  const n = String(name||'').trim();
  // "<X> Body Armor" is a body piece (Auric Tesla Body Armor). Matched on the
  // TWO-word ending only - a bare "... armor" is a SET name, never a slot.
  if(/\bbody\s+armou?r$/i.test(n)) return 'Shirt';
  const last = n.split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g,'');
  if(!last) return '';
  for(const slot in SLOT_WORDS){ if(SLOT_WORDS[slot].indexOf(last)!==-1) return slot; }
  return '';
}

// ---- progression stage labels ---------------------------------------------
// classes.json ships the human label for every stage id ("pre-evil1" ->
// "Pre-Evil Boss"), so the map is BUILT from the data, never hardcoded.
let STAGE_LABELS = null;
function stageLabel(id){
  if(!STAGE_LABELS){
    STAGE_LABELS = {};
    for(const k in (S.classes||{})){
      for(const st of ((S.classes[k]||{}).stages || [])){ if(st && st.id) STAGE_LABELS[st.id] = st.label || st.id; }
    }
  }
  return STAGE_LABELS[id] || null;
}

// ---- the rarity subline under the H1 --------------------------------------
// RAR_LABEL values already read "Rarity Tier 14" / "Blue Tier", so the subline
// prefix must not repeat the word ("Rarity: Rarity Tier 14").
function rarityShort(node){
  const rl = rarityLabel(node);
  return rl ? rl.replace(/^rarity\s+/i,'') : null;
}
function raritySubline(node, extra){
  const bits = [];
  const rl = rarityShort(node);
  if(rl) bits.push(`Rarity: <span class="wk-rar">${esc(rl)}</span>`);
  const ty = dv(statVal(node,'Type'));       if(ty) bits.push(esc(ty));
  const dt = dv(statVal(node,'Damage type')); if(dt) bits.push(esc(dt));
  const stg = (node && node.stages || []).map(stageLabel).filter(Boolean);
  if(stg.length) bits.push(esc(stg.slice(0,2).join(' / ')));
  (extra||[]).forEach(x=>{ if(x) bits.push(esc(x)); });
  return bits.length ? `<div class="wk-sub">${bits.join(' &nbsp;&middot;&nbsp; ')}</div>` : '';
}

// ---- the "Statistics" infobox ---------------------------------------------
// `skip` drops rows already surfaced elsewhere (Rarity lives in the subline, as
// in the mockup). `rows` appends derived rows (set defense total, set bonus).
// Returns '' when nothing survives, so an item with no usable stats renders no
// empty table (and, via infobox(), no empty "Statistics" box at all).
function statsTable(node, skip, rows){
  const out = [];
  (node && node.stats || []).forEach(([k,v])=>{
    if(skip && skip.indexOf(String(k).toLowerCase())!==-1) return;
    const val = dv(v);
    if(val==null) return;                 // unresolved wiki template - omit the row
    const coin = /^(sell|buy)$/i.test(String(k));
    out.push(`<tr><td>${esc(k)}</td><td${coin?' class="wk-coin"':''}>${esc(val)}</td></tr>`);
  });
  (rows||[]).forEach(r=>out.push(r));
  return out.length ? `<table class="wk-stats">${out.join('')}</table>` : '';
}
// With no tooltip AND no stat rows there is nothing to put in a "Statistics"
// box (45 items, e.g. the "Any Iron Bar" recipe-group placeholders), so the
// sprite is shown on its own instead of an empty headed panel.
function infobox(head, artHtml, tipHtml, tableHtml, rarClass){
  if(!tipHtml && !tableHtml){
    return `<div class="wk-infobox wk-artonly${rarClass||''}"><div class="wk-art">${artHtml}</div></div>`;
  }
  return `<div class="wk-infobox${rarClass||''}">
    <div class="wk-ihead">${esc(head)}</div>
    <div class="wk-art">${artHtml}</div>
    ${tipHtml}${tableHtml}
  </div>`;
}

// ---- wiki-style recipe card ------------------------------------------------
function recipeCard(rec, resultName){
  if(!rec || !rec.ings || !rec.ings.length) return '';
  const junk = (rec.rank||0) >= RANK_JUNK;
  const ings = rec.ings.map(([inm,iq])=>
    `<div class="wk-row" data-sheet="${esc(inm)}">${spr(inm,'s24')}<span class="wk-ing">${esc(inm)}</span><span class="wk-amt">&times;${esc(iq)}</span></div>`
  ).join('');
  // A Calamity-ADDED recipe on a base-game item (Night's Edge's 10x Purified
  // Gel row, Hellfire Treads' Essence of Havoc row) was visually identical to
  // the item's real vanilla recipes - the drop rows and used-in chips badged,
  // the recipe cards did not. The badge goes in the station header so it reads
  // as "this recipe comes from the mod", not "this ingredient does".
  return `<div class="wk-recipe${junk?' is-conv':''}${isCalSrc(rec)?' is-cal':''}">
    <div class="wk-station">Crafted at &nbsp;<b>${esc(rec.station||'By Hand')}</b>${calBadge(rec)}${junk?' <i>&middot; conversion, not a crafting step</i>':''}</div>
    ${ings}
    <div class="wk-result" data-sheet="${esc(resultName)}">${spr(resultName,'s24')}<b>${esc(resultName)}</b><span class="wk-tag">RESULT &times;${esc(rec.amount||1)}</span></div>
  </div>`;
}
// Primary recipe first (primaryRecipe's ranking - recipes[0] is not always the
// real one), then every remaining row in order, conversions included and
// labelled. Nothing is hidden.
function allRecipeCards(node, name){
  const recs = visRecipes(node);
  if(!recs.length) return '';
  const first = primaryRecipe(node);
  const rest = recs.filter(r=>r!==first);
  return (first ? recipeCard(first, name) : '') + rest.map(r=>recipeCard(r, name)).join('');
}

// ---- drop table ------------------------------------------------------------
// The table is wrapped in its OWN horizontal scroller and every cell is allowed
// to wrap: some drop rows are very wide ("50-60 (+75-90 when defeated during
// the night)") and used to be clipped unreachably by .wk-recipe's overflow:hidden
// at 390px.
function dropTable(node){
  const drops = visDrops(node);
  if(!drops.length) return '';
  const rows = drops.slice(0,24).map(d=>
    `<tr><td class="wk-src">${esc(dvText(d.npc)||'?')}${calBadge(d)}</td><td class="wk-num">${esc(dvText(d.chance)||'—')}</td><td class="wk-num">${esc(dvText(d.amount)||'—')}</td></tr>`
  ).join('');
  const more = drops.length>24 ? `<div class="wk-more">+ ${drops.length-24} more source${drops.length-24===1?'':'s'} on the wiki.</div>` : '';
  return `<div class="wk-recipe"><div class="wk-station">Dropped by</div>
    <div class="wk-tablewrap"><table class="wk-drops"><thead><tr><th>Source</th><th>Chance</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>${more}`;
}

// ---- the one-line "how is this obtained" summary ---------------------------
// Derived strictly from what the dataset holds. An item with neither a recipe
// nor drop rows says exactly that - it never guesses a source.
function obtainNote(node){
  const real = visRecipes(node).filter(r=>(r.rank||0)<RANK_JUNK).length;
  const conv = junkRecipes(node).length;
  const drops = visDrops(node), shim = visShimmer(node);
  // How many rows the OTHER mode would have added, so a vanilla-mode item that
  // Calamity also crafts/drops says so instead of looking like a dead end.
  const hidden = MODES.calamity ? 0
    : ((node.recipes||[]).length - visRecipes(node).length)
    + ((node.drops||[]).length - drops.length);
  const bits = [];
  if(real) bits.push(`<b>Craftable</b> &mdash; ${real} recipe${real===1?'':'s'}.`);
  if(drops.length) bits.push(`<b>Dropped</b> by ${drops.length} source${drops.length===1?'':'s'}.`);
  if(shim.length) bits.push(`Obtainable by <b>shimmer transmutation</b>.`);
  if(!real && conv) bits.push(`Not crafted &mdash; ${conv} conversion row${conv===1?'':'s'} only (not a crafting step).`);
  if(!bits.length) bits.push(`<b>Not crafted.</b> This dataset carries no base-game recipe or drop rows for it &mdash; see the wiki page below.`);
  if(hidden) bits.push(`<span class="wk-hidden-note">Calamity adds ${hidden} more source row${hidden===1?'':'s'} &mdash; turn the mod on to see them.</span>`);
  const ic = real ? '&#128296;' : (drops.length ? '&#128128;' : '&#8505;');
  return `<div class="wk-note"><span>${ic}</span><span>${bits.join(' ')}</span></div>`;
}

// ---- used-in chips ---------------------------------------------------------
function usedInChips(node){
  const used = visUsedIn(node);
  if(!used.length) return '';
  const list = used.slice(0,40);
  const more = used.length>list.length ? `<div class="wk-more">+ ${used.length-list.length} more.</div>` : '';
  return `<div class="wk-h2">Used in (${used.length})</div>
    <div class="wk-chips">${list.map(u=>`<span class="wk-chip" data-sheet="${esc(u)}">${spr(u,'s24')}<span>${esc(u)}</span>${calBadgeFor(u)}</span>`).join('')}</div>${more}`;
}

// ---- the "Calamity changes" block -----------------------------------------
// 53 base-game items are REBALANCED or re-documented by Calamity. The vanilla
// record stays canonical in the infobox in BOTH modes - the numbers in the
// Statistics table are never silently swapped - and the mod's version is shown
// beside it as an explicit, labelled delta. Rendered ONLY in Calamity mode.
//
// The delta is DERIVED by comparing the two stat lists key-by-key: a row is
// printed only when Calamity actually states a different value (changed), or a
// value vanilla does not carry at all (added). Everything is passed through the
// same dv()/dvText() template guards as the rest of the sheet.
function calamityChangesBlock(node){
  if(!MODES.calamity) return '';
  const cc = node && node.calamityChanges;
  if(!cc) return '';
  const rows = [];
  (cc.stats || []).forEach(([k,v])=>{
    const nv = dv(v);
    if(nv == null) return;
    const ov = dv(statVal(node, k));
    if(ov != null && ov === nv) return;                    // identical - not a change
    rows.push(`<tr><td>${esc(k)}</td><td class="wk-old">${ov==null?'&mdash;':esc(ov)}</td>`
            + `<td class="wk-arrow">&rarr;</td><td class="wk-new">${esc(nv)}</td></tr>`);
  });
  const tipTxt = dvText(cc.tip);
  const ownTip = dvText(node.tip);
  const tipHtml = (tipTxt && tipTxt !== ownTip)
    ? `<div class="cc-h">Tooltip in Calamity</div><div class="wk-tip">${
        splitTip(cc.tip).lines.map(l=>`<div>${esc(l)}</div>`).join('')
      }${splitTip(cc.tip).flavor.map(l=>`<div class="wk-flav">${esc(l)}</div>`).join('')}</div>` : '';
  const descTxt = dvText(cc.desc);
  const ownDesc = dvText(node.desc);
  const descHtml = (descTxt && descTxt !== ownDesc)
    ? `<div class="cc-h">Described by Calamity</div><p class="cc-desc">${esc(descTxt)}</p>` : '';
  const url = cc.wiki ? (cc.wikiHost || 'https://calamitymod.wiki.gg') + '/wiki/'
    + encodeURIComponent(String(cc.wiki).replace(/ /g,'_')) : '';
  const link = url ? `<a class="cc-link" href="${esc(url)}" target="_blank" rel="noopener">Calamity's page for this item &#8599;</a>` : '';
  if(!rows.length && !tipHtml && !descHtml && !link) return '';
  return `<div class="wk-h2">Calamity changes <span class="cal-badge">CAL</span></div>
    <div class="cc-block">
      <div class="cc-lead">Calamity reworks this base-game item. The <b>Statistics</b> box above stays the
        vanilla record; below is how the mod documents it.</div>
      ${rows.length?`<table class="cc-table"><thead><tr><th>Stat</th><th>Vanilla</th><th></th><th>Calamity</th></tr></thead><tbody>${rows.join('')}</tbody></table>`:''}
      ${tipHtml}${descHtml}${link}
    </div>`;
}

/** The rarity slug on its own (supplies --rc/--rg) with no .rar decoration. */
function rarSlug(node){ const k = rarityKey(node); return (k && RAR_KNOWN[k]) ? k : null; }

// The wiki-layout item page. Section order is the approved mockup:
//   crumb -> H1 + rarity subline -> actions -> Statistics infobox ->
//   How to obtain -> What it does -> Demo -> Used in -> wiki link.
function itemSheet(name){
  const node = get(name);
  if(!node){ return; }
  const rk = rarSlug(node);
  const rarv = rk ? ' rar-'+rk : '';

  // Shimmer is a transmutation, never a crafting step - it gets its own card
  // so it can never be misread as a recipe.
  const shimmer = visShimmer(node).map(r=>
    `<div class="wk-recipe${isCalSrc(r)?' is-cal':''}"><div class="wk-station">Shimmer &#8646; &nbsp;<b>${esc(r.station||'Shimmer')}</b>${calBadge(r)}</div>
      ${(r.ings||[]).map(([inm,iq])=>`<div class="wk-row" data-sheet="${esc(inm)}">${spr(inm,'s24')}<span class="wk-ing">${esc(inm)}</span><span class="wk-amt">&times;${esc(iq)}</span></div>`).join('')}
      <div class="wk-result" data-sheet="${esc(name)}">${spr(name,'s24')}<b>${esc(name)}</b><span class="wk-tag">RESULT &times;${esc(r.amount||1)}</span></div></div>`
  ).join('');

  const descTxt = dvText(node.desc);
  const descHtml = descTxt
    ? `<div class="wk-h2">What it does</div><p class="wk-lead">${esc(descTxt)}</p>${
        node.descFrom ? `<div class="wk-more">Described on the wiki's <b>${esc(node.descFrom)}</b> page.</div>` : ''}`
    : '';

  openSheet(`
    <div class="sheet-grab"></div>
    ${sheetCrumb('Items', {t:'item', i:name, n:name})}
    <div class="${rarv.trim()}">
      <h3 class="wk-title${rk?' rar-on':''}">${esc(name)}${calBadge(node,'title')}</h3>
      ${raritySubline(node, [MODES.calamity ? srcLabel(node) : null,
                             node.historical ? 'Removed content' : null])}
      <div class="tt-actions">
        ${primaryRecipe(node)?`<button class="act-btn tree" data-focus="${esc(name)}">&#129683; Crafting tree</button>`:''}
        ${pinBtnHtml(name)}
      </div>
      ${setLinkBlock(node)}
      ${histNote(node)}
      ${infobox('Statistics', spr(name,'s96'), tipBlock(node),
                statsTable(node, ['rarity']), rk ? ' rar' : '')}
    </div>
    <div class="wk-h2">How to obtain</div>
    ${obtainNote(node)}
    ${allRecipeCards(node, name)}
    ${dropTable(node)}
    ${shimmer}
    ${descHtml}
    ${calamityChangesBlock(node)}
    ${demoBlock(node,name)}
    ${usedInChips(node)}
    <a class="big-btn alt" href="${esc(wikiUrl(node,name))}" target="_blank" rel="noopener">Open on ${wikiHostLabel(wikiUrl(node,name))} Wiki &#8599;</a>
  `, {t:'item', i:name, n:name});
}

function wikiUrl(node, name){
  const host = (node && node.wikiHost) || 'https://calamitymod.wiki.gg';
  const page = (node && node.wiki) || name;
  return host + '/wiki/' + encodeURIComponent(page.replace(/ /g,'_'));
}

// The Calamity wiki keeps pages for content the mod has REMOVED, flagged with
// a {{historical content}} banner. 204 of those were shipping here as ordinary
// live items - craftable, searchable, and recommended in the class guides.
// They stay in the app (the recipes they appear in are still worth reading)
// but they are labelled, and the class guides drop them entirely.
function histNote(node){
  return node && node.historical
    ? `<div class="removed-note">&#9888; <b>Removed from the game.</b> The wiki keeps this page for history; the item is not obtainable in the current Calamity build.</div>`
    : '';
}

// Armor piece -> its set. Guarded: no-ops until items carry node.set and
// data/armor-sets.json has landed (S.sets stays {} until then).
function truncate(s,n){ s=String(s==null?'':s); return s.length>n ? s.slice(0,n-1)+'…' : s; }
function setLinkBlock(node){
  if(!node || !node.set) return '';
  const set = S.sets && S.sets[node.set];
  if(!set) return '';
  const teaser = set.setBonus ? `<span class="sl-b">${esc(truncate(set.setBonus,90))}</span>` : '';
  return `<button class="set-link" data-setsheet="${esc(node.set)}">
    <span class="sl-ic">&#128737;</span>
    <span class="sl-body"><span class="sl-t">Part of ${esc(set.name||node.set)}</span>${teaser}</span>
    <span class="sl-go">&rsaquo;</span>
  </button>`;
}

// "In action" demo GIF, streamed from the wiki. Only ever rendered when a
// sheet actually opens (itemSheet is called on demand), so this is already
// lazy with zero preloading; onerror hides the whole wrapper (offline / the
// wiki lacks the file), never leaving a broken-image box behind.
// SIZE CAP (Josia bug report 2026-08-30): the image now sits inside
// .demo-frame, which is height-capped in CSS (<=240px, and never more than
// 40vh or the container width). The old rule was width:100%;height:auto, so a
// tall wiki GIF ate the whole screen and buried every section under it.
// Source URL: the DIRECT /images/<file> path, not /wiki/Special:FilePath/<file>.
// FilePath answers with two cross-origin redirects that are Content-Type
// text/html + nosniff, and Chrome's Opaque Response Blocking kills the load
// ("net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin") - so every demo GIF was
// silently hidden by the onerror handler. /images/ answers 200 image/gif in one
// hop. FilePath is kept as the second attempt in case a file is not flat there.
//
// HOST ORDER (T2): the file's OWN wiki first (node.demoWiki names where the
// dataset found the file), then that host's FilePath form, then the host implied
// by the item's own wikiHost - so a vanilla item resolves against
// terraria.wiki.gg and only falls back cross-wiki if its own host lacks the
// file. 9 items in the dataset genuinely host their demo on the other wiki, so
// demoWiki stays authoritative rather than being overridden by src.
const WIKI_HOSTS = {terraria:'https://terraria.wiki.gg', calamity:'https://calamitymod.wiki.gg'};
function demoUrls(node){
  const own = node.demoWiki==='terraria' ? 'terraria' : 'calamity';
  const byItem = String(node.wikiHost||'').indexOf('terraria.wiki.gg')!==-1 ? 'terraria'
               : (isCalSrc(node) ? 'calamity' : 'terraria');
  const file = encodeURIComponent(node.demoGif);
  const hosts = [own].concat(byItem !== own ? [byItem] : []);
  const urls = [];
  hosts.forEach(h => { urls.push(WIKI_HOSTS[h] + '/images/' + file); });
  hosts.forEach(h => { urls.push(WIKI_HOSTS[h] + '/wiki/Special:FilePath/' + file); });
  return urls;
}
window.demoErr = function(img){
  let chain = [];
  try{ chain = JSON.parse(img.dataset.alt || '[]'); }catch(e){ chain = []; }
  const next = chain.shift();
  if(next){ img.dataset.alt = JSON.stringify(chain); img.src = next; return; }
  const w = img.closest('.demo-wrap'); if(w) w.style.display='none';
};
function demoBlock(node, name){
  if(!node || !node.demoGif) return '';
  const urls = demoUrls(node);
  const primary = urls[0];
  return `<div class="demo-wrap">
    <div class="wk-h2">Demo</div>
    <div class="demo-frame">
      <img class="demo-gif" src="${esc(primary)}" data-alt="${esc(JSON.stringify(urls.slice(1)))}" alt="${esc(name)} in action" loading="lazy" decoding="async" onerror="demoErr(this)">
    </div>
    <div class="demo-cap">from the wiki &mdash; needs internet &middot; capped to this frame</div>
  </div>`;
}

// =====================  GUIDE  =============================================
function renderGuide(){
  const a = app();
  const nItems = S.vNames.length.toLocaleString();
  const nSets = visibleSets().length;
  const nBosses = visibleBosses().length;
  const nCal = S.names.filter(n=>isCalSrc(S.db[n])).length.toLocaleString();
  a.innerHTML = `<div class="view">
    <h2 class="vh">&#128214; How to use</h2>
    <div class="card mode-card">
      <div class="sec-h" style="margin-top:0">You are playing: ${MODES.calamity?'Terraria + Calamity':'Vanilla Terraria'}</div>
      <div class="muted" style="font-size:13px">
        ${MODES.calamity
          ? `Calamity is ON. Items, recipes, drops, armour sets, bosses and class guides are MERGED &mdash; ${nItems} items, ${nSets} armour sets, ${nBosses} bosses. Every modded entry carries a <span class="cal-badge">CAL</span> badge.`
          : `Base game only &mdash; ${nItems} items, ${nSets} armour sets, ${nBosses} bosses, and <b>0</b> modded entries mixed in. Calamity's ${nCal} extra items are loaded but hidden until you turn the mod on.`}
      </div>
      <button class="big-btn alt" data-modpicker style="margin-top:12px">Mods &rsaquo;</button>
    </div>
    <div class="card">
      <p style="margin:0 0 10px"><b>Craft tab</b> — search any item to see its full, game-accurate crafting tree.
      Tap a row to expand its ingredients, tap &#8505; / an icon for details, and tap <b>&#8635;</b> to jump into an ingredient's own tree.
      <b>Raw materials</b> flattens the whole tree into a base-material shopping list.
      Switch <b>List / Graph</b> to see the same tree as a node map &mdash; pinch to zoom, drag to pan,
      or hit &#9974; for fullscreen.</p>
      <p style="margin:0 0 10px"><b>Pins</b> &mdash; tap &#9734; on any item to pin it as a crafting goal.
      Pinned items show as chips at the top of the Craft tab; tap one to jump straight into its tree.</p>
      <p style="margin:0 0 10px"><b>Classes</b> — recommended armor / weapons / accessories / buffs for each of the ${visibleClasses().length} classes, stage by stage.</p>
      <p style="margin:0 0 10px"><b>Bosses</b> — progression order + each boss's drops.${MODES.calamity?' Infernum changes the fights (AI &amp; some drops); fight strategy lives in the vault.':''}</p>
      <p style="margin:0"><b>Items</b> — browse / filter all ${nItems} catalogued items.</p>
    </div>
    <div class="card">
      <div class="sec-h" style="margin-top:0">Key crafting stations (progression)</div>
      <div class="muted" style="font-size:13.5px;line-height:1.7">
        Work Bench &rarr; Furnace &rarr; Iron/Lead Anvil &rarr; Hellforge &rarr;
        Mythril/Orichalcum Anvil &rarr; Adamantite/Titanium Forge &rarr;
        <span style="color:var(--gold)">Ancient Manipulator</span> (post-Moon Lord) &rarr;
        <span style="color:var(--gold)">Draedon's Forge / Cosmic Anvil</span> (endgame).
      </div>
    </div>
    <div class="card">
      <div class="sec-h" style="margin-top:0">About the data</div>
      <div class="muted" style="font-size:12.5px">
        ${S.names.length.toLocaleString()} items in the database (${S.names.filter(n=>!isCalSrc(S.db[n])).length.toLocaleString()} vanilla, ${nCal} Calamity),
        with ${S.meta.descCount||0} descriptions and ${S.meta.recipeCount||''} recipes.
        Vanilla Terraria comes from <a class="link" href="https://terraria.wiki.gg" target="_blank" rel="noopener">terraria.wiki.gg</a>;
        the mod content from the official
        <a class="link" href="https://calamitymod.wiki.gg" target="_blank" rel="noopener">Calamity Mod Wiki</a>${S.meta.modVersion?` for Calamity <b>${esc(S.meta.modVersion)}</b>`:''},
        pulled <b>${esc(S.meta.pulledAt||S.meta.generatedAt||'')}</b>.
        All ${S.meta.spriteCount||''} sprites are bundled with the app, so it works fully offline.
        Shimmer transmutations are shown separately, not as crafting steps.
      </div>
    </div>
    ${attributionCard()}
  </div>`;
}

// CC BY-NC-SA requires attribution + share-alike, and carries a non-commercial
// clause. Shown in the Guide and in the page footer.
function attributionCard(){
  return `<div class="card attrib">
    <div class="sec-h" style="margin-top:0">Credits &amp; licence</div>
    <div class="muted" style="font-size:12px;line-height:1.65">
      Item text, stats and sprites come from the
      <a class="link" href="https://calamitymod.wiki.gg" target="_blank" rel="noopener">Calamity Mod Wiki</a>
      and the <a class="link" href="https://terraria.wiki.gg" target="_blank" rel="noopener">Terraria Wiki</a>,
      used under <a class="link" href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>
      (attribution + share-alike, non-commercial).
      Terraria is &copy; Re-Logic; the Calamity Mod is by the Calamity Mod team.
      This is a free, non-commercial fan project and is not affiliated with or endorsed by either.
    </div>
  </div>`;
}

// =====================  search  ============================================
function searchItems(q, limit=20){
  const ql = q.toLowerCase().trim();
  if(!ql) return [];
  const starts=[], contains=[];
  for(let i=0;i<S.vNames.length;i++){          // mode-filtered roster, not S.names
    const l=S.vLower[i];
    if(l===ql){ starts.unshift(S.vNames[i]); continue; }
    if(l.startsWith(ql)) starts.push(S.vNames[i]);
    else if(l.includes(ql)) contains.push(S.vNames[i]);
    if(starts.length>limit) break;
  }
  return starts.concat(contains).slice(0,limit);
}
function wireSearch(){
  const inp = $('#craftSearch'); if(!inp) return;
  const sug = $('#craftSuggest'); const clr=$('#craftClear');
  const run = ()=>{
    const q=inp.value.trim(); clr.hidden=!q;
    if(!q){ sug.hidden=true; return; }
    const res = searchItems(q);
    if(!res.length){ sug.hidden=true; return; }
    sug.innerHTML = res.map(n=>{ const nd=S.db[n]; const s=sourceOf(nd);
      return `<div class="sug-row${rarCls(nd)}" data-focus="${esc(n)}">${spr(n,'s24')}<span class="nm">${esc(n)}</span>${calBadge(nd)}<span class="tg">${primaryRecipe(nd)?'craftable':s.label}</span></div>`;
    }).join('');
    sug.hidden=false;
  };
  inp.addEventListener('input', run);
  inp.addEventListener('focus', run);
  clr.addEventListener('click', ()=>{ inp.value=''; clr.hidden=true; sug.hidden=true; inp.focus(); });
  inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const r=searchItems(inp.value); if(r[0]) focusItem(r[0]); } });
}

// =====================  event delegation  ==================================
let wired=false;
function wireDelegation(){
  if(wired) return; wired=true;
  document.body.addEventListener('click', e=>{
    const focusEl = e.target.closest('[data-focus]');
    const focus2 = e.target.closest('[data-focus2]');
    const sheetEl = e.target.closest('[data-sheet]');
    const bossEl = e.target.closest('[data-boss]');
    const crumbEl = e.target.closest('[data-crumb]');
    const classEl = e.target.closest('[data-class]');
    const filterEl = e.target.closest('[data-filter]');
    const rowline = e.target.closest('.rowline');
    const pinEl = e.target.closest('[data-pin]');
    const unpinEl = e.target.closest('[data-unpin]');
    const gviewEl = e.target.closest('[data-gview]');
    const setsheetEl = e.target.closest('[data-setsheet]');
    const armorviewEl = e.target.closest('[data-armorview]');
    const modPickEl = e.target.closest('[data-modpicker]');
    const modTogEl = e.target.closest('[data-modtoggle]');
    const srcFilterEl = e.target.closest('[data-srcfilter]');

    // the sheet's back crumb wins over everything: it sits inside the sheet and
    // must never be swallowed by a surrounding [data-sheet] / [data-focus] row.
    if(e.target.closest('[data-sheetback]')){ e.stopPropagation(); sheetBack(); return; }

    // pins first: the unpin "x" lives INSIDE a [data-focus] chip, so it has to
    // win before the focus handler sees the click.
    if(unpinEl){ e.stopPropagation(); const n=unpinEl.dataset.unpin; const a=loadPins(); const i=a.indexOf(n); if(i>=0){a.splice(i,1);savePins(a);} renderPinRow(); return; }
    if(pinEl){
      const n = pinEl.dataset.pin;
      togglePin(n);
      pinEl.classList.toggle('on', isPinned(n));
      pinEl.innerHTML = isPinned(n) ? '&#9733; Pinned' : '&#9734; Pin';
      pinEl.title = isPinned(n) ? 'Unpin' : 'Pin as a crafting goal';
      renderPinRow();
      return;
    }
    // The mod picker sits above everything else in the same way the back crumb
    // does: its rows carry [data-modtoggle] and must never be swallowed by a
    // surrounding handler.
    if(modTogEl){
      e.stopPropagation();
      const id = modTogEl.dataset.modtoggle;
      setMod(id, !MODES[id]);
      modPickerSheet();                 // re-render the sheet in place, still open
      return;
    }
    if(modPickEl){ e.stopPropagation(); modPickerSheet(); return; }
    if(srcFilterEl){ S.srcFilter = srcFilterEl.dataset.srcfilter; S.itemLimit=60; renderItems(); return; }
    if(gviewEl){ S.graphMode = gviewEl.dataset.gview==='graph'; renderCraft(); return; }
    if(armorviewEl){ S.armorFlat = armorviewEl.dataset.armorview==='pieces'; S.itemLimit=60; renderItemList($('#itemSearch')?$('#itemSearch').value.trim():''); return; }
    if(setsheetEl){ armorSetSheet(setsheetEl.dataset.setsheet); return; }

    if(crumbEl){ crumbTo(crumbEl.dataset.crumb); return; }
    if(classEl){ curClass=classEl.dataset.class; renderClasses(); return; }
    if(filterEl){ S.itemFilter=filterEl.dataset.filter; S.itemLimit=60; S.armorFlat=false; renderItems(); return; }
    if(bossEl){ bossSheet(bossEl.dataset.boss); return; }
    if(focusEl){ closeSheet(); focusItem(focusEl.dataset.focus); return; }
    if(sheetEl){ itemSheet(sheetEl.dataset.sheet); return; }
    if(focus2){ itemSheet(focus2.dataset.focus2); return; }

    // tree row expand/collapse (only when not hitting a button/link above)
    if(rowline){
      const node = rowline.parentElement;
      if(node.classList.contains('craftable')){
        if(node._build) node._build();
        node.classList.toggle('open');
      } else {
        const nm = node.dataset.name; if(nm) itemSheet(nm);
      }
    }
  });

  // tree tool buttons (re-render-scoped, so query fresh)
  document.body.addEventListener('click', e=>{
    if(e.target.id==='toggleAll'){ S.expandAll=!S.expandAll; renderCraft(); }
    if(e.target.id==='toggleRaw'){ S.rawMode=!S.rawMode; renderCraft(); }
  });
}

// sheet close
document.addEventListener('click', e=>{ if(e.target.closest('[data-close]')) closeSheet(); });

// =====================  boot  ==============================================
async function boot(){
  try{
    const [it, cl, bo, mt, as] = await Promise.all([
      fetch('/island/apps/terraria/data/items.json').then(r=>r.json()),
      fetch('/island/apps/terraria/data/classes.json').then(r=>r.json()),
      fetch('/island/apps/terraria/data/bosses.json').then(r=>r.json()),
      fetch('/island/apps/terraria/data/meta.json').then(r=>r.json()).catch(()=>({})),
      // armor-sets.json is being generated separately and may not exist yet
      // (or 404s offline before the SW has cached it) - never a hard failure.
      fetch('/island/apps/terraria/data/armor-sets.json').then(r=>r.json()).catch(()=>({sets:{}})),
    ]);
    S.db = it.items; S.meta = it.meta||mt;
    S.classes = cl.classes; S.bosses = bo.bosses;
    S.sets = (as && as.sets) || {};
    S.names = Object.keys(S.db).sort((a,b)=>a.localeCompare(b));
    S.lower = S.names.map(n=>n.toLowerCase());
  }catch(err){
    app().innerHTML = `<div class="hint"><div class="big">&#9888;</div>Couldn't load data.<div class="faint">${esc(err.message)}</div></div>`;
    return;
  }
  initMods();
  applyMode(false);          // stamps data-mode + builds S.vNames BEFORE first paint
  document.querySelectorAll('#tabbar .tab').forEach(t=>t.addEventListener('click', ()=>{ if(location.hash.slice(1)!==t.dataset.view){ try{ history.replaceState(history.state,'',location.pathname+location.search+'#'+t.dataset.view); }catch(_e){} } setView(t.dataset.view); }));
  const sb = $('#shareBtn'); if(sb) sb.addEventListener('click', share);
  wireDelegation();
  function _fiApplyHash(){ var h=''; try{ h=decodeURIComponent((location.hash||'').slice(1)); }catch(_e){ h=(location.hash||'').slice(1); } var _i=h.indexOf('/'); var _v=(_i>=0?h.slice(0,_i):h)||'craft'; var _a=_i>=0?h.slice(_i+1):''; if(['craft','classes','bosses','items','guide'].indexOf(_v)<0){ _v='craft'; } if(_v==='craft'&&_a&&get(_a)){ S.crumbs=[]; S.root=_a; S.rawMode=false; setView('craft'); } else { setView(_v); } }
  window.addEventListener('hashchange', _fiApplyHash);
  _fiApplyHash();
}

// Visible data-freshness stamp: which Calamity version this data describes and
// when it was pulled. Previously the dataset carried no version or pull date.
function renderStamp(){
  const m = S.meta || {};
  // In Vanilla mode the pill must not advertise a Calamity version the user has
  // switched off; it stamps the vanilla pull instead.
  const when = MODES.calamity
    ? (m.pulledAt || m.generatedAt || '')
    : (m.vanillaPulledAt || m.pulledAt || m.generatedAt || '');
  const ver = MODES.calamity
    ? (m.modVersion ? 'Calamity ' + m.modVersion : 'Calamity')
    : 'Terraria';
  const pill = $('#patchPill');
  if(pill){
    pill.innerHTML = `<b>${esc(ver)}</b>${when?`<span class="synced">synced ${esc(when)}</span>`:''}`;
    pill.title = when ? `Wiki data pulled ${when}` : '';
  }
  const foot = $('#footNote');
  if(foot){
    foot.innerHTML = `Data from <a class="link" href="https://calamitymod.wiki.gg" target="_blank" rel="noopener">calamitymod.wiki.gg</a>`
      + ` &amp; <a class="link" href="https://terraria.wiki.gg" target="_blank" rel="noopener">terraria.wiki.gg</a>`
      + ` under <a class="link" href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>`
      + `${when?` &middot; synced ${esc(when)}`:''} &middot; non-commercial fan project, not affiliated with Re-Logic.`;
  }
}
function share(){
  const url = location.href.split('#')[0];
  if(navigator.share){ navigator.share({title:'Terraria Companion', url}).catch(()=>{}); }
  else { navigator.clipboard && navigator.clipboard.writeText(url); alert('Link copied!'); }
}

// =====================  OFFLINE SPRITE WARM (mode-tiered)  ==================
// The dataset went from 3.5k to 9,008 sprite files with the vanilla pull, and
// the SW used to warm ALL of them on activate. On a phone that is 9k requests
// before the user has done anything - and 2,832 of them are Calamity files a
// vanilla player will never look at.
//
// So the APP decides the tiers and hands them to the SW, for two reasons:
//   1. only the app knows the current mode, and
//   2. items.json is 8.7 MB - parsing it a second time inside the worker to
//      re-derive src tags would double the boot cost on the exact device this
//      is meant to protect. The app has it parsed already.
// The SW warms VANILLA always and CALAMITY only while the mod is on; flipping
// Calamity on re-posts the message and warms the second tier then. Each tier
// carries its own completion flag, keyed to the dataset stamp, so a data
// refresh re-warms only the delta (unchanged behaviour, per tier).
let SPRITE_TIERS = null;
/**
 * The SW is posted BARE FILENAMES and resolves them against its own sprite dir,
 * so base() has to reduce every img path shape the app can ever see to one.
 *
 * There are two shapes, and the anchored `^\.?\/?sprites\/` this used to be only
 * matched the first:
 *   standalone   "/island/apps/terraria/sprites/Torch.png"       (what data/items.json ships)
 *   mounted      "/island/apps/terraria/sprites/Torch.png"
 * The shell assembler rewrites the bare "/island/apps/terraria/sprites/" prefix in the SHIPPED DATA
 * (registry assetPrefixes), so mounted paths are absolute and carry the island
 * asset base. Anchored, they passed through untouched, the SW prepended its own
 * base, and every warm request 404'd - the whole sweep failed, no completion
 * marker was written, and it silently re-ran on every load and mode flip.
 *
 * Strip everything up to and including the LAST "/island/apps/terraria/sprites/" (greedy .*), which
 * handles both shapes and any future mount prefix. A sprite FILENAME can never
 * contain a slash, so the result is always bare - and anything that somehow is
 * not is quarantined into `unresolved` rather than posted, so a new path shape
 * can degrade loudly (the gate asserts it stays empty) instead of resurrecting
 * the doomed sweep.
 */
const SPRITE_BASE_RE = /^.*\/?sprites\//;
function spriteBase(p){ return String(p||'').replace(SPRITE_BASE_RE, ''); }
function spriteTiers(){
  if(SPRITE_TIERS) return SPRITE_TIERS;
  const van = new Set(), cal = new Set(), bad = new Set();
  const add = (img, src) => {
    if(!img) return;
    const f = spriteBase(img);
    if(!f || f.indexOf('/') !== -1){ bad.add(String(img)); return; }
    (src==='calamity'?cal:van).add(f);
  };
  for(const n of S.names){ const nd = S.db[n]; add(nd.img, nd.src); }
  (S.bosses||[]).forEach(b=>{
    add(b.img, b.src);
    (b.drops||[]).forEach(d=>add(d.img, d.src));
  });
  // A file referenced by BOTH sides belongs to the vanilla tier (it is needed
  // with the mod off), so it is never downloaded twice or stranded in tier 2.
  van.forEach(f => cal.delete(f));
  SPRITE_TIERS = {
    vanilla: [...van],
    calamity: [...cal],
    unresolved: [...bad],          // never posted; must stay empty (gated)
    stamp: (S.meta.generatedAt||'') + ':' + S.names.length + ':' + (S.meta.spriteCount||0),
  };
  return SPRITE_TIERS;
}
// boot() (async fetch) and the SW registration race each other, so BOTH sides
// call warmSpritesForMode() and it no-ops until both halves are ready. Whichever
// finishes last is the one that actually posts.
let SW_TARGET = null;
function warmSpritesForMode(){
  if(!SW_TARGET || !S.names.length) return;
  try{
    const t = spriteTiers();
    SW_TARGET.postMessage({type:'warm-sprites', stamp:t.stamp,
                           vanilla:t.vanilla, calamity:t.calamity,
                           wantCalamity: !!MODES.calamity});
  }catch(e){}
}
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    Promise.resolve().then(()=>navigator.serviceWorker.ready).then(reg=>{
      // navigator.serviceWorker.controller is null on the very FIRST load,
      // before the worker has claimed this client - fall back to reg.active.
      SW_TARGET = navigator.serviceWorker.controller || reg.active;
      warmSpritesForMode();
    }).catch(()=>{});
  });
}
boot();
