"use strict";
/* Isaac Pilot -- live map RENDERER + TRANSPORT, as a drop-in global.

   window.LiveMap is deliberately page-agnostic: it owns the 13x13 floor grid,
   the room shape / room type / floor-name tables, the off-grid badges, the
   legend, the spoiler preference and the /state + /events transport. It owns
   NO page chrome (header, seed button, items strip) -- that stays with whoever
   mounts it.

   Two consumers today:
     web/index.html                 the standalone page served by server.py
     tracker/app.js  (Live tab)     mounted inside the Isaac compendium, which
                                    talks to the server CROSS-ORIGIN

   Because consumer #2 is a foreign page with its own stylesheet, every style
   the renderer needs is injected from here under an `lm-` prefix. Nothing in
   this file may depend on a stylesheet the host page provides.

   API
     LiveMap.render(state, container)   draw a /state snapshot into container
     LiveMap.renderLegend(container)    fill container with the room-type key
     LiveMap.connect(base, handlers)    {onState, onStatus} -- auto-reconnects
     LiveMap.disconnect()               stop the stream + any pending retry
     LiveMap.floorName(stage, type)     "Basement I"
     LiveMap.curseNames(mask)           ["Curse of the Darkness", ...]
     LiveMap.getSpoilers() / setSpoilers(bool)
*/

(function (root) {

const W = 13;                       // level grid is 13x13

// ---------------------------------------------------------------- enums
// Verified against wofsauge.github.io/IsaacDocs/rep/enums/
const SHAPE = {
  R1x1:1, IH:2, IV:3, R1x2:4, IIV:5, R2x1:6, IIH:7, R2x2:8,
  LTL:9, LTR:10, LBL:11, LBR:12
};

const TYPE = {
  NULL:0, DEFAULT:1, SHOP:2, ERROR:3, TREASURE:4, BOSS:5, MINIBOSS:6,
  SECRET:7, SUPERSECRET:8, ARCADE:9, CURSE:10, CHALLENGE:11, LIBRARY:12,
  SACRIFICE:13, DEVIL:14, ANGEL:15, DUNGEON:16, BOSSRUSH:17, ISAACS:18,
  BARREN:19, CHEST:20, DICE:21, BLACK_MARKET:22, GREED_EXIT:23,
  PLANETARIUM:24, TELEPORTER:25, TELEPORTER_EXIT:26, SECRET_EXIT:27,
  BLUE:28, ULTRASECRET:29, DEATHMATCH:30
};

// fill, stroke, glyph, label, dashed
const STYLE = {
  [TYPE.NULL]:         ["#39415a", "#4b5570", "",   "Unknown"],
  [TYPE.DEFAULT]:      ["#39415a", "#4b5570", "",   "Room"],
  [TYPE.SHOP]:         ["#2f5137", "#4f8a5f", "🪙", "Shop"],
  [TYPE.ERROR]:        ["#4a4a4a", "#777",    "⚠",  "Error"],
  [TYPE.TREASURE]:     ["#5c4a1c", "#d1a63a", "⭐", "Treasure"],
  [TYPE.BOSS]:         ["#5c2323", "#e05a5a", "💀", "Boss"],
  [TYPE.MINIBOSS]:     ["#553355", "#a06aa0", "👹", "Miniboss"],
  [TYPE.SECRET]:       ["#1e4448", "#3fd0dc", "❓", "Secret", true],
  [TYPE.SUPERSECRET]:  ["#40204a", "#c86fe0", "❓", "Super Secret", true],
  [TYPE.ARCADE]:       ["#4a3a1e", "#c99a3a", "🎰", "Arcade"],
  [TYPE.CURSE]:        ["#3d1f2b", "#b3566f", "🩸", "Curse"],
  [TYPE.CHALLENGE]:    ["#4a3020", "#c07a45", "⚔", "Challenge"],
  [TYPE.LIBRARY]:      ["#33405c", "#6f8ad0", "📖", "Library"],
  [TYPE.SACRIFICE]:    ["#4a2020", "#c04a4a", "🗡", "Sacrifice"],
  [TYPE.DEVIL]:        ["#4a1f1f", "#d04a4a", "😈", "Devil"],
  [TYPE.ANGEL]:        ["#4a4630", "#ded08a", "😇", "Angel"],
  [TYPE.DUNGEON]:      ["#2e2e38", "#6a6a80", "🕳", "Crawlspace"],
  [TYPE.BOSSRUSH]:     ["#5c2323", "#e05a5a", "💥", "Boss Rush"],
  [TYPE.ISAACS]:       ["#33445c", "#6d90c0", "🛏", "Bedroom"],
  [TYPE.BARREN]:       ["#3f3527", "#94805a", "🛏", "Barren"],
  [TYPE.CHEST]:        ["#4a3d1c", "#d0b24a", "🎁", "Chest"],
  [TYPE.DICE]:         ["#33405c", "#7d95d0", "🎲", "Dice"],
  [TYPE.BLACK_MARKET]: ["#241f2e", "#6a5a80", "🖤", "Black Market"],
  [TYPE.GREED_EXIT]:   ["#39415a", "#4b5570", "🚪", "Exit"],
  [TYPE.PLANETARIUM]:  ["#1f2e52", "#5f8ae0", "🪐", "Planetarium"],
  [TYPE.TELEPORTER]:   ["#2a3d4a", "#5a90b0", "🌀", "Teleporter"],
  [TYPE.TELEPORTER_EXIT]:["#2a3d4a","#5a90b0","🌀", "Teleporter"],
  [TYPE.SECRET_EXIT]:  ["#2f4a3a", "#5ab080", "🚪", "Secret Exit"],
  [TYPE.BLUE]:         ["#26405c", "#5aa0d0", "👻", "Blue Womb"],
  [TYPE.ULTRASECRET]:  ["#4a1c22", "#e04a5a", "❓", "Ultra Secret", true],
  [TYPE.DEATHMATCH]:   ["#39415a", "#4b5570", "",   "Deathmatch"]
};

const HIDDEN_UNTIL_VISITED = new Set([TYPE.SECRET, TYPE.SUPERSECRET, TYPE.ULTRASECRET]);
// Off-grid rooms live outside the 13x13 board; they render as side badges.
const LEGEND_TYPES = [TYPE.BOSS, TYPE.TREASURE, TYPE.SHOP, TYPE.SECRET,
  TYPE.SUPERSECRET, TYPE.ULTRASECRET, TYPE.CURSE, TYPE.PLANETARIUM,
  TYPE.ARCADE, TYPE.LIBRARY, TYPE.SACRIFICE, TYPE.CHALLENGE, TYPE.DICE];

// ---------------------------------------------------------------- floors
const CURSES = [
  [1,"Darkness"], [2,"Labyrinth"], [4,"Lost"], [8,"Unknown"],
  [16,"Cursed"], [32,"Maze"], [64,"Blind"], [128,"Giant"]
];

// stage -> {stageType -> name}. Verified against LevelStage / StageType enums.
const FLOORS = {
  1:{0:"Basement",1:"Cellar",2:"Burning Basement",4:"Downpour",5:"Dross"},
  2:{0:"Basement",1:"Cellar",2:"Burning Basement",4:"Downpour",5:"Dross"},
  3:{0:"Caves",1:"Catacombs",2:"Flooded Caves",4:"Mines",5:"Ashpit"},
  4:{0:"Caves",1:"Catacombs",2:"Flooded Caves",4:"Mines",5:"Ashpit"},
  5:{0:"Depths",1:"Necropolis",2:"Dank Depths",4:"Mausoleum",5:"Gehenna"},
  6:{0:"Depths",1:"Necropolis",2:"Dank Depths",4:"Mausoleum",5:"Gehenna"},
  7:{0:"Womb",1:"Utero",2:"Scarred Womb",4:"Corpse",5:"Corpse"},
  8:{0:"Womb",1:"Utero",2:"Scarred Womb",4:"Corpse",5:"Corpse"},
  9:{0:"Blue Womb"},
  10:{0:"Sheol",1:"Cathedral"},
  11:{0:"Dark Room",1:"Chest"},
  12:{0:"The Void"},
  13:{0:"Home"}
};
// Stages that come in I/II pairs.
const NUMBERED = {1:"I",2:"II",3:"I",4:"II",5:"I",6:"II",7:"I",8:"II"};

function floorName(stage, stageType){
  const set = FLOORS[stage];
  if (!set) return "—";
  const base = set[stageType] !== undefined ? set[stageType] : (set[0] || "—");
  const num = NUMBERED[stage];
  return num ? base + " " + num : base;
}

function curseNames(mask){
  const out = [];
  CURSES.forEach(function(c){
    if (mask & c[0]) out.push("Curse of the " + c[1]);
  });
  return out;
}

// ---------------------------------------------------- shape -> occupancy
// GridIndex is the top-left slot of the room's bounding box. SafeGridIndex is
// the top-left cell the room actually OCCUPIES -- which differs for LTL, whose
// top-left corner is missing, so its SafeGridIndex is the top-RIGHT cell.
function cellsFor(r){
  const gi = r.gi, sgi = (r.sgi === undefined ? r.gi : r.sgi);
  switch (r.sh){
    case SHAPE.R1x1: case SHAPE.IH: case SHAPE.IV:
      return [gi];
    case SHAPE.R1x2: case SHAPE.IIV:              // one wide, two tall
      return [gi, gi+W];
    case SHAPE.R2x1: case SHAPE.IIH:              // two wide, one tall
      return [gi, gi+1];
    case SHAPE.R2x2:
      return [gi, gi+1, gi+W, gi+W+1];
    case SHAPE.LTL: {                             // missing TOP-LEFT
      const tl = sgi - 1;                         // sgi is the top-right cell
      return [tl+1, tl+W, tl+W+1];
    }
    case SHAPE.LTR: {                             // missing TOP-RIGHT
      const tl = sgi;
      return [tl, tl+W, tl+W+1];
    }
    case SHAPE.LBL: {                             // missing BOTTOM-LEFT
      const tl = sgi;
      return [tl, tl+1, tl+W+1];
    }
    case SHAPE.LBR: {                             // missing BOTTOM-RIGHT
      const tl = sgi;
      return [tl, tl+1, tl+W];
    }
    default:
      return [gi];
  }
}

// Which corner of the 2x2 bounding box an L-shape omits.
const L_MISSING = {
  [SHAPE.LTL]:"tl", [SHAPE.LTR]:"tr", [SHAPE.LBL]:"bl", [SHAPE.LBR]:"br"
};

// ---------------------------------------------------------- path helpers
// Rounded polygon: works for rectangles and for the reflex corner of an L.
function roundedPath(pts, r){
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++){
    const prev = pts[(i-1+n)%n], cur = pts[i], next = pts[(i+1)%n];
    const d1 = Math.hypot(cur[0]-prev[0], cur[1]-prev[1]);
    const d2 = Math.hypot(next[0]-cur[0], next[1]-cur[1]);
    const rr = Math.min(r, d1/2, d2/2);
    const a = [cur[0] + (prev[0]-cur[0])*rr/d1, cur[1] + (prev[1]-cur[1])*rr/d1];
    const b = [cur[0] + (next[0]-cur[0])*rr/d2, cur[1] + (next[1]-cur[1])*rr/d2];
    out.push((i === 0 ? "M" : "L") + a[0].toFixed(2) + " " + a[1].toFixed(2));
    out.push("Q" + cur[0].toFixed(2) + " " + cur[1].toFixed(2) + " " +
                   b[0].toFixed(2) + " " + b[1].toFixed(2));
  }
  return out.join(" ") + " Z";
}

function styleFor(t){ return STYLE[t] || STYLE[TYPE.DEFAULT]; }

// ------------------------------------------------------------------ css
// Every renderer-owned style lives here so the map can be dropped into a page
// that has never heard of it. All selectors carry the `lm-` prefix; nothing is
// document-level, so injecting this into a foreign <head> is inert elsewhere.
const CSS = [
  ".lm-map{width:100%;height:100%;max-height:100%;display:block}",
  ".lm-roomshape{stroke-width:2.5;transition:opacity .15s}",
  ".lm-roomshape.lm-unvisited{opacity:.55}",
  ".lm-glyph{font-size:19px;text-anchor:middle;dominant-baseline:central;",
  "  pointer-events:none;user-select:none}",
  ".lm-cur-ring{fill:none;stroke:#fff;stroke-width:3.5;opacity:.9;",
  "  animation:lm-pulse 1.4s ease-in-out infinite}",
  "@keyframes lm-pulse{0%,100%{opacity:.35;stroke-width:3}50%{opacity:1;stroke-width:5}}",
  ".lm-badges{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;padding:6px 0 0}",
  ".lm-badge{display:flex;align-items:center;gap:5px;",
  "  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);",
  "  border-radius:8px;padding:4px 9px;font-size:12px;opacity:.9}",
  ".lm-badge b{font-weight:600}",
  ".lm-legend{display:flex;gap:5px 14px;flex-wrap:wrap;justify-content:center;",
  "  padding:9px 12px;font-size:11.5px;opacity:.9}",
  ".lm-legend i{font-style:normal;margin-right:4px}",
  ".lm-empty{margin:auto;text-align:center;max-width:420px;padding:24px;opacity:.85}",
  ".lm-empty h2{font-size:19px;margin:0 0 10px;font-weight:600}",
  ".lm-empty p{margin:0}",
  ".lm-spin{width:26px;height:26px;margin:0 auto 14px;border-radius:50%;",
  "  border:3px solid rgba(255,255,255,.16);border-top-color:currentColor;",
  "  animation:lm-sp 1s linear infinite}",
  "@keyframes lm-sp{to{transform:rotate(360deg)}}"
].join("\n");

let cssInjected = false;
function injectCss(){
  if (cssInjected) return;
  try {
    const head = document.head || document.documentElement;
    if (head.querySelector("style[data-livemap-css]")) { cssInjected = true; return; }
    const s = document.createElement("style");
    s.setAttribute("data-livemap-css", "1");
    s.textContent = CSS;
    head.appendChild(s);
    cssInjected = true;
  } catch (e) { /* styles are cosmetic; never let this break the render */ }
}

// --------------------------------------------------------------- spoilers
const SPOILER_KEY = "isaacpilot.spoilers";
let spoilers = true;
try { spoilers = localStorage.getItem(SPOILER_KEY) !== "0"; } catch (e) {}

function getSpoilers(){ return spoilers; }
function setSpoilers(on){
  spoilers = !!on;
  try { localStorage.setItem(SPOILER_KEY, spoilers ? "1" : "0"); } catch (e) {}
  if (lastContainer && lastState) render(lastState, lastContainer);
}

// ----------------------------------------------------------------- render
const CELL = 46, GAP = 5, RAD = 7;
const NS = "http://www.w3.org/2000/svg";

let lastState = null;
let lastContainer = null;

/** Show / hide without relying on the host page's [hidden] rule. SVGElement
    does NOT implement the `hidden` IDL attribute, so `svg.hidden = false` sets
    a silent JS expando and leaves the attribute in place -- go through both. */
function setShown(node, on){
  if (!node) return;
  if (on) { node.removeAttribute("hidden"); node.style.display = ""; }
  else { node.setAttribute("hidden", ""); node.style.display = "none"; }
}

/** Find a renderer slot inside the container, creating it if the host page
    did not supply one. The standalone page supplies its own (so it keeps its
    ids and page CSS); a foreign mount gets bare defaults. */
function slot(container, cls, make){
  let n = container.querySelector("." + cls);
  if (!n) { n = make(); n.classList.add(cls); container.appendChild(n); }
  return n;
}

function defaultEmpty(){
  const d = document.createElement("div");
  d.innerHTML = '<div class="lm-spin"></div><h2>Waiting for the game…</h2>' +
    "<p>No floor data yet. The map appears the moment you start or re-enter a run.</p>";
  return d;
}

function render(state, container){
  injectCss();
  if (container) lastContainer = container;
  const host = lastContainer;
  if (!host) return;
  lastState = state || {};
  const s = lastState;

  const map = slot(host, "lm-map", function(){
    return document.createElementNS(NS, "svg");
  });
  const empty = slot(host, "lm-empty", defaultEmpty);
  const badges = slot(host, "lm-badges", function(){
    return document.createElement("div");
  });

  const all = Array.isArray(s.rooms) ? s.rooms : [];
  const onGrid = [], offGrid = [];
  all.forEach(function(r){
    if (typeof r.gi !== "number") return;
    // Off-grid rooms (Devil/Angel/Error and friends) use negative indices.
    if (r.gi < 0) offGrid.push(r); else onGrid.push(r);
  });

  const visible = onGrid.filter(function(r){
    if (!spoilers && HIDDEN_UNTIL_VISITED.has(r.t) && !r.v) return false;
    return true;
  });

  if (!all.length){
    setShown(map, false);
    setShown(empty, true);
    badges.innerHTML = "";
  } else {
    setShown(empty, false);
    setShown(map, true);
    drawMap(map, visible, s.cur);
    drawBadges(badges, offGrid);
  }
  return { rooms: visible.length, offGrid: offGrid.length };
}

function drawMap(map, rooms, cur){
  // Build cell lists once, then fit the viewBox to the used bounding box.
  const built = rooms.map(function(r){
    return { r: r, cells: cellsFor(r).filter(function(c){ return c >= 0 && c < W*W; }) };
  }).filter(function(b){ return b.cells.length; });

  if (!built.length){ map.innerHTML = ""; return; }

  let minC = 99, maxC = -1, minR = 99, maxR = -1;
  built.forEach(function(b){
    b.cells.forEach(function(c){
      const col = c % W, row = Math.floor(c / W);
      if (col < minC) minC = col; if (col > maxC) maxC = col;
      if (row < minR) minR = row; if (row > maxR) maxR = row;
    });
  });

  const cols = maxC - minC + 1, rowsN = maxR - minR + 1;
  const pad = 6;
  const vbW = cols * CELL + pad*2, vbH = rowsN * CELL + pad*2;
  map.setAttribute("viewBox", "0 0 " + vbW + " " + vbH);
  map.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const frag = document.createDocumentFragment();

  built.forEach(function(b){
    const r = b.r;
    const st = styleFor(r.t);
    const cellsSet = b.cells;

    // room-local bounding box in grid cells
    let bMinC = 99, bMinR = 99, bMaxC = -1, bMaxR = -1;
    cellsSet.forEach(function(c){
      const col = c % W, row = Math.floor(c / W);
      if (col < bMinC) bMinC = col; if (col > bMaxC) bMaxC = col;
      if (row < bMinR) bMinR = row; if (row > bMaxR) bMaxR = row;
    });

    const x0 = pad + (bMinC - minC) * CELL + GAP/2;
    const y0 = pad + (bMinR - minR) * CELL + GAP/2;
    const w  = (bMaxC - bMinC + 1) * CELL - GAP;
    const h  = (bMaxR - bMinR + 1) * CELL - GAP;

    let pts;
    const missing = L_MISSING[r.sh];
    if (missing && cellsSet.length === 3){
      const hw = w/2, hh = h/2;
      if (missing === "tl")
        pts = [[x0+hw,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h],[x0,y0+hh],[x0+hw,y0+hh]];
      else if (missing === "tr")
        pts = [[x0,y0],[x0+hw,y0],[x0+hw,y0+hh],[x0+w,y0+hh],[x0+w,y0+h],[x0,y0+h]];
      else if (missing === "bl")
        pts = [[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0+hw,y0+h],[x0+hw,y0+hh],[x0,y0+hh]];
      else // br
        pts = [[x0,y0],[x0+w,y0],[x0+w,y0+hh],[x0+hw,y0+hh],[x0+hw,y0+h],[x0,y0+h]];
    } else {
      pts = [[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h]];
    }

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", roundedPath(pts, RAD));
    path.setAttribute("fill", st[0]);
    path.setAttribute("stroke", st[1]);
    path.setAttribute("class", "lm-roomshape" + (r.v ? "" : " lm-unvisited"));
    if (st[4]) path.setAttribute("stroke-dasharray", "6 4");
    path.setAttribute("data-type", r.t);
    path.setAttribute("data-shape", r.sh);
    path.setAttribute("data-gi", r.gi);
    frag.appendChild(path);

    // glyph, centred on the room's true centroid (matters for L-shapes)
    if (st[2]){
      let sx = 0, sy = 0;
      cellsSet.forEach(function(c){
        sx += pad + (c % W - minC) * CELL + CELL/2;
        sy += pad + (Math.floor(c / W) - minR) * CELL + CELL/2;
      });
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", (sx / cellsSet.length).toFixed(1));
      t.setAttribute("y", (sy / cellsSet.length).toFixed(1));
      t.setAttribute("class", "lm-glyph");
      t.textContent = st[2];
      frag.appendChild(t);
    }

    // current-room pulsing outline
    const sgi = (r.sgi === undefined ? r.gi : r.sgi);
    if (cur !== undefined && cur >= 0 && (sgi === cur || cellsSet.indexOf(cur) >= 0)){
      const ring = document.createElementNS(NS, "path");
      ring.setAttribute("d", roundedPath(pts, RAD));
      ring.setAttribute("class", "lm-cur-ring");
      frag.appendChild(ring);
    }
  });

  map.innerHTML = "";
  map.appendChild(frag);
}

function drawBadges(badges, offGrid){
  badges.innerHTML = "";
  offGrid.forEach(function(r){
    if (!spoilers && HIDDEN_UNTIL_VISITED.has(r.t) && !r.v) return;
    const st = styleFor(r.t);
    const d = document.createElement("div");
    d.className = "lm-badge";
    d.style.borderColor = st[1];
    d.innerHTML = "<span>" + (st[2] || "•") + "</span>";
    const b = document.createElement("b");
    b.textContent = st[3];
    d.appendChild(b);
    if (r.v) d.appendChild(document.createTextNode(" ✓"));
    badges.appendChild(d);
  });
}

function renderLegend(container){
  injectCss();
  if (!container) return;
  container.classList.add("lm-legend");
  container.innerHTML = "";
  LEGEND_TYPES.forEach(function(t){
    const st = styleFor(t);
    const s = document.createElement("span");
    s.innerHTML = "<i>" + (st[2] || "▪") + "</i>";
    s.appendChild(document.createTextNode(st[3]));
    s.style.color = st[1];
    container.appendChild(s);
  });
}

// -------------------------------------------------------------- transport
// One connection at a time. A generation counter retires the callbacks of a
// superseded connection, so a slow fetch from a torn-down Live tab can never
// paint over a newer one.
let GEN = 0;
let conn = null;

/** "" -> same origin. Trailing slashes trimmed so base + "/state" is right. */
function normalizeBase(base){
  let b = (base === undefined || base === null) ? "" : String(base).trim();
  while (b.length && b.charAt(b.length - 1) === "/") b = b.slice(0, -1);
  return b;
}

function fire(c, name, arg, arg2){
  if (!c || c.gen !== GEN) return;
  const fn = c.h[name];
  if (typeof fn === "function") { try { fn(arg, arg2); } catch (e) {} }
}

function scheduleRetry(c){
  if (!c || c.gen !== GEN || c.closed) return;
  const wait = c.retry;
  c.retry = Math.min(c.retry * 2, 15000);   // backoff, capped
  c.timer = setTimeout(function(){
    if (c.gen !== GEN || c.closed) return;
    openStream(c);
    primeState(c);
  }, wait);
}

function openStream(c){
  try { if (c.es) c.es.close(); } catch (e) {}
  c.es = null;
  let es;
  try {
    es = new EventSource(c.base + "/events");
  } catch (e) {
    fire(c, "onStatus", "error", e);
    scheduleRetry(c);
    return;
  }
  c.es = es;
  es.onopen = function(){
    if (c.gen !== GEN || c.closed) { try { es.close(); } catch (e) {} return; }
    c.retry = 1000;
    fire(c, "onStatus", "live");
  };
  es.onmessage = function(ev){
    if (c.gen !== GEN || c.closed) return;
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }  // ignore bad frame
    fire(c, "onStatus", "live");
    fire(c, "onState", data);
  };
  es.onerror = function(){
    if (c.gen !== GEN || c.closed) return;
    try { es.close(); } catch (e) {}
    c.es = null;
    fire(c, "onStatus", "error");
    scheduleRetry(c);
  };
}

/** Seed the view immediately so a reload / tab re-entry is never blank. */
function primeState(c){
  if (typeof fetch !== "function") return;
  fetch(c.base + "/state", { cache: "no-store" })
    .then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(j){
      if (c.gen !== GEN || c.closed) return;
      fire(c, "onStatus", "live");
      fire(c, "onState", j);
    })
    .catch(function(err){
      if (c.gen !== GEN || c.closed) return;
      fire(c, "onStatus", "error", err);
    });
}

/**
 * Open a live connection.
 *   base      "" for same-origin, or an absolute http://host:port
 *   handlers  { onState(stateObj), onStatus("live"|"error", err) }
 * Returns a handle; call LiveMap.disconnect() to stop.
 */
function connect(base, handlers){
  disconnect();
  const c = {
    base: normalizeBase(base),
    h: handlers || {},
    gen: ++GEN,
    es: null,
    retry: 1000,
    timer: null,
    closed: false
  };
  conn = c;
  fire(c, "onStatus", "connecting");
  openStream(c);
  primeState(c);
  return c;
}

function disconnect(){
  GEN += 1;                       // retire every in-flight callback
  const c = conn;
  conn = null;
  if (!c) return;
  c.closed = true;
  if (c.timer) { clearTimeout(c.timer); c.timer = null; }
  try { if (c.es) c.es.close(); } catch (e) {}
  c.es = null;
}

// ------------------------------------------------------------------ export
root.LiveMap = {
  SHAPE: SHAPE,
  TYPE: TYPE,
  W: W,
  render: render,
  renderLegend: renderLegend,
  connect: connect,
  disconnect: disconnect,
  floorName: floorName,
  curseNames: curseNames,
  cellsFor: cellsFor,
  styleFor: styleFor,
  getSpoilers: getSpoilers,
  setSpoilers: setSpoilers,
  injectCss: injectCss
};

})(typeof window !== "undefined" ? window : this);
