"use strict";
/* Fiiish Isaac Compendium - wiki-first browse (default) + opt-in save/completion tracker.
   Two top-level views:
     view="wiki"  -> Compendium: browse items/trinkets/cards/pills/pickups/characters/bosses/
                     challenges/transformations/unlocks. No save needed. This is the LANDING.
     view="stats" -> My Progress: in-game-style character select carousel with per-character
                     completion-marks page, a simplified completion grid, boss tracking, and the
                     save-.dat upload / profile machinery. Opt-in.
   Client mode persists to localStorage['isaac_tracker_v2']; server mode talks to /api/*. */

const state = { data:null, progress:{active:null,profiles:{}}, saveSlots:[], byName:{}, mode:"client",
  view:"wiki", wikiCat:null, statsTab:"select", curChar:null, achIndex:null, bossIndex:null };
const BASE = (window.ISAAC_BASE || "/");
const LS_KEY = "isaac_tracker_v2";
function loadLocal(){ try{ const p=JSON.parse(localStorage.getItem(LS_KEY)); if(p&&p.profiles) return p; }catch(e){} return {active:null,profiles:{}}; }
function persistLocal(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(state.progress)); }catch(e){} }
function nowStr(){ const d=new Date(); return d.toLocaleString(); }

const MARKS = [
  {key:"heart", label:"Mom's Heart", img:"moms-heart"},
  {key:"isaac", label:"Isaac", img:"isaac"},
  {key:"blue-baby", label:"???", img:"blue-baby"},
  {key:"satan", label:"Satan", img:"satan"},
  {key:"lamb", label:"The Lamb", img:"the-lamb"},
  {key:"boss-rush", label:"Boss Rush", img:null},
  {key:"hush", label:"Hush", img:"hush"},
  {key:"mega-satan", label:"Mega Satan", img:"mega-satan"},
  {key:"delirium", label:"Delirium", img:"delirium"},
  {key:"mother", label:"Mother", img:"mother"},
  {key:"beast", label:"The Beast", img:"the-beast"},
  {key:"ultra-greed", label:"Ultra Greed", img:"ultra-greed", greed:true},
  {key:"ultra-greedier", label:"Greedier", img:"ultra-greedier", greed:true},
];
/* Greed Mode has NO normal/hard split in-game: the wiki's Completion Marks page counts
   24 mark images = 11 marks x2 + ONE Greed mark + ONE Greedier mark. So the Greed and
   Greedier columns are two-state (none <-> done) while every other column is tri-state. */
const isGreedMark = key => !!(MARKS.find(m => m.key === key) || {}).greed;
const CYCLE = {none:"normal", normal:"hard", hard:"none"};
const CYCLE_GREED = {none:"normal", normal:"none", hard:"none"};
const cycleTable = key => (isGreedMark(key) ? CYCLE_GREED : CYCLE);
const markDisplayState = (key, st) => (isGreedMark(key) && st !== "none") ? "normal" : st;
const TOTAL_MARKS = () => state.data.characters.length * MARKS.length;
const markIcon = (key, st) => A("assets/marks/" + key + (markDisplayState(key, st) === "hard" ? "-hard" : "") + ".png");
const markData = key => (state.data.marks || []).find(m => m.key === key) || {};
function paintMark(btn, key, st){
  btn.style.backgroundImage = (st === "none") ? "none" : `url("${markIcon(key, st)}")`;
}
const markIsMax = (key, st) => isGreedMark(key) ? (st !== "none") : (st === "hard");

const $ = s => document.querySelector(s);
const el = (t,c,h)=>{const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e;};
const esc = s => (s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const A = p => BASE + String(p).replace(/^\/+/,"");

/* ---------- profile-aware state ---------- */
const AP = () => state.progress.profiles[state.progress.active] || {manual:{marks:{},bosses:{},items:{}},imported:{}};
const IMP = () => AP().imported || {};
function MAN(){ const p=AP(); p.manual=p.manual||{marks:{},bosses:{},items:{}}; p.manual.marks=p.manual.marks||{}; p.manual.bosses=p.manual.bosses||{}; p.manual.items=p.manual.items||{}; return p.manual; }
const DEFAULT_PROFILE_ID = "local";
const DEFAULT_PROFILE_NAME = "Local";
function ensureProfile(){
  const P = state.progress;
  if(P.active && P.profiles[P.active]) return P.profiles[P.active];
  const first = Object.keys(P.profiles)[0];
  if(first){ P.active = first; return P.profiles[first]; }
  if(state.mode !== "client") return null;
  P.profiles[DEFAULT_PROFILE_ID] = {name:DEFAULT_PROFILE_NAME, manual:{marks:{},bosses:{},items:{}}, imported:{}, synced_at:null};
  P.active = DEFAULT_PROFILE_ID;
  persistLocal();
  return P.profiles[DEFAULT_PROFILE_ID];
}
function MANW(){ ensureProfile(); return MAN(); }
function noProgressYet(){
  const P = state.progress, ids = Object.keys(P.profiles);
  if(!ids.length) return true;
  return ids.every(id=>{
    const p = P.profiles[id] || {};
    if(p.imported && p.imported.counts) return false;
    const m = p.manual || {};
    return !Object.keys(m.marks||{}).length && !Object.keys(m.bosses||{}).length && !Object.keys(m.items||{}).length;
  });
}

function impItem(slug){ return !!(IMP().items||{})[slug]; }
function impMark(ch,mk){ const im=(IMP().marks||{})[ch]; return (im&&im[mk])||"none"; }
function impBoss(slug){ return !!(IMP().bosses||{})[slug]; }
function itemOwned(slug){ const m=MAN().items; if(slug in m) return !!m[slug]; return impItem(slug); }
function toggleItem(slug){ const nv=!itemOwned(slug); const m=MANW().items; if(nv===impItem(slug)) delete m[slug]; else m[slug]=nv; saveManual(); }
function charUnlocked(slug){ if(slug==="isaac") return true; return !!(IMP().characters||{})[slug] || !!MAN().items["char:"+slug]; }
function markEff(ch,mk){ const mm=MAN().marks[ch]; if(mm && (mk in mm)) return mm[mk]; return impMark(ch,mk); }
function markEarned(ch,mk){ return markEff(ch,mk)!=="none"; }
function cycleMark(ch,mk){ const nxt=cycleTable(mk)[markEff(ch,mk)]; const man=MANW(); const m=(man.marks[ch]=man.marks[ch]||{});
  if(nxt===impMark(ch,mk)){ delete m[mk]; if(!Object.keys(m).length) delete man.marks[ch]; } else m[mk]=nxt;
  saveManual(); return nxt; }
function bossKilled(slug){ const m=MAN().bosses; if(slug in m) return !!m[slug]; return impBoss(slug); }
function toggleBoss(slug){ const nv=!bossKilled(slug); const m=MANW().bosses; if(nv===impBoss(slug)) delete m[slug]; else m[slug]=nv; saveManual(); }
function charEarned(ch){ return MARKS.reduce((n,m)=>n+(markEarned(ch,m.key)?1:0),0); }
function deadGodHard(){ let h=0; state.data.characters.forEach(c=>MARKS.forEach(m=>{if(markIsMax(m.key,markEff(c.slug,m.key)))h++;})); return h; }

/* ---------- load + persistence ---------- */
async function boot(){
  try{
    state.data = await fetch(BASE+"data/isaac.json").then(r=>r.json());
    state.data.characters.forEach(c=>state.byName[c.name]=c);
    let serverState=null;
    if(!window.ISAAC_BASE){
      try{ const r=await fetch(BASE+"api/state",{cache:"no-store"}); if(r.ok) serverState=await r.json(); }catch(e){}
    }
    if(serverState){
      state.mode="server"; state.progress=serverState.progress; state.saveSlots=serverState.save_slots||[];
    }else{
      state.mode="client";
      const [ai,bi]=await Promise.all([
        fetch(BASE+"data/ach_index.json").then(r=>r.json()),
        fetch(BASE+"data/boss_index.json").then(r=>r.json()).catch(()=>({})),
      ]);
      state.achIndex=ai; state.bossIndex=bi; state.progress=loadLocal();
    }
    wireNav(); wireProfileBar(); render();
  }catch(e){ $("#app").innerHTML=`<div class="pad">Failed to load: ${esc(e.message)}</div>`; }
}
async function refreshState(){
  if(state.mode!=="server") return;
  const st=await fetch(BASE+"api/state").then(r=>r.json());
  state.progress=st.progress; state.saveSlots=st.save_slots||[];
}
function hasActiveSave(){ const p=state.progress.profiles[state.progress.active]; return p && p.imported && p.imported.counts; }
let saveTimer=null;
function saveManual(){
  const s=$("#savestate"); if(s){ s.textContent="saving..."; s.className="saving"; }
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{
    try{
      if(state.mode==="server"){ await fetch(BASE+"api/manual",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({id:state.progress.active, manual:MAN()})}); }
      else{ persistLocal(); }
      if(s){ s.textContent="saved"; s.className=""; } renderProfileBar();
    }catch(e){ if(s){ s.textContent="save failed"; s.className="err"; } }
  },300);
}

/* ================= NAV / VIEW ORCHESTRATION ================= */
function wireNav(){
  document.querySelectorAll("#modeSwitch button").forEach(b=>{
    b.onclick=()=>{ state.view=b.dataset.view; state.curChar=null; window.scrollTo(0,0); render(); };
  });
}
function renderModeSwitch(){
  document.querySelectorAll("#modeSwitch button").forEach(b=>b.classList.toggle("on",b.dataset.view===state.view));
}
function render(){
  document.body.dataset.view = state.view;
  renderModeSwitch();
  const pb=$("#profilebar");
  if(state.view==="stats"){ pb.classList.remove("hidden"); renderProfileBar(); }
  else { pb.classList.add("hidden"); }
  /* Leaving the Live tab must drop the SSE stream AND its pending retry timer -
     otherwise a backgrounded tab keeps reconnecting forever. Re-entering opens a
     fresh connection in renderLiveMap(), which is also how "retry" works. */
  if(state.view!=="livemap" && window.LiveMap) LiveMap.disconnect();
  renderSubnav();
  if(state.view==="wiki") renderWiki();
  else if(state.view==="livemap") renderLiveMap();
  else renderStats();
}

const WIKI_TILES = [
  {cat:"collectible",   label:"Items",           list:"collectibles",    emoji:"♥"},
  {cat:"trinket",       label:"Trinkets",        list:"trinkets",        emoji:"🪝"},
  {cat:"card",          label:"Cards & Runes",   list:"cards",           emoji:"🃏"},
  {cat:"pill",          label:"Pills",           list:"pills",           emoji:"💊"},
  {cat:"pickup",        label:"Pickups",         list:"pickups",         emoji:"💰"},
  {cat:"character",     label:"Characters",      list:"characters",      emoji:"👶"},
  {cat:"bosses",        label:"Bosses",          list:"bosses",          emoji:"💀"},
  {cat:"challenge",     label:"Challenges",      list:"challenges",      emoji:"🏆"},
  {cat:"transformation",label:"Transformations", list:"transformations", emoji:"✨"},
  {cat:"unlocks",       label:"Unlocks",         list:null,              emoji:"🔓"},
];
const WIKI_LABEL = cat => (WIKI_TILES.find(t=>t.cat===cat)||{}).label || "";
function renderSubnav(){
  const nav=$("#subnav"); nav.innerHTML=""; nav.className="subnav";
  if(state.view==="livemap"){ nav.classList.add("hidden"); return; }
  if(state.view==="wiki"){
    if(state.wikiCat){
      const back=el("button","subchip back","‹ Compendium"); back.onclick=()=>{state.wikiCat=null; window.scrollTo(0,0); render();};
      nav.appendChild(back);
      nav.appendChild(el("span","subtitle", WIKI_LABEL(state.wikiCat)));
    } else { nav.classList.add("hidden"); }
  } else {
    [["select","Character Select"],["simple","Completion Grid"],["bosses","Bosses"]].forEach(([v,l])=>{
      const c=el("button","subchip"+(state.statsTab===v?" on":""),l);
      c.onclick=()=>{state.statsTab=v; state.curChar=null; window.scrollTo(0,0); render();};
      nav.appendChild(c);
    });
  }
}

/* ================= WIKI (compendium, browse-first) ================= */
function renderWiki(){
  if(!state.wikiCat) return renderWikiHome();
  if(state.wikiCat==="bosses") return renderBosses();
  if(state.wikiCat==="unlocks") return renderUnlocks();
  browseState.type=state.wikiCat; browseState.q=""; browseState.quality=""; browseState.pool=""; browseState.group=""; browseState.owned="";
  renderItems();
}
function renderWikiHome(){
  const app=$("#app"); app.innerHTML="";
  const hero=el("div","wikihero");
  hero.innerHTML=`<div class="wh-logo">👶</div>
    <h1>The Binding of Isaac</h1>
    <p class="wh-sub">Repentance+ Compendium &mdash; every item, trinket, card, pill, pickup, character, boss, challenge and transformation, with the full effect and unlock for each. Browse freely; no save required.</p>
    <button class="wh-track">✦ Track my save &amp; completion</button>`;
  hero.querySelector(".wh-track").onclick=()=>{ state.view="stats"; state.curChar=null; window.scrollTo(0,0); render(); };
  app.appendChild(hero);
  const grid=el("div","tilegrid");
  WIKI_TILES.forEach(t=>{
    const list=t.list?state.data[t.list]:null;
    const count=list?list.length:unlockCount();
    let icon="";
    if(list&&list.length){ const pick=list[Math.min(3,list.length-1)]; if(pick&&pick.image) icon=`<img src="${A(pick.image)}" alt="">`; }
    const tile=el("button","tile");
    tile.innerHTML=`<div class="tileimg">${icon||`<span class="tileemoji">${t.emoji}</span>`}</div>
      <div class="tilename">${esc(t.label)}</div><div class="tilecount">${count}</div>`;
    tile.onclick=()=>{ state.wikiCat=t.cat; if(t.cat!=="bosses"&&t.cat!=="unlocks") browseState.type=t.cat; window.scrollTo(0,0); render(); };
    grid.appendChild(tile);
  });
  app.appendChild(grid);
}
function unlockCount(){ let n=0; ["collectibles","trinkets","cards"].forEach(g=>state.data[g].forEach(e=>{ if(e.unlock_character) n++; })); return n; }

/* ================= LIVE (Isaac Pilot live floor map) =================
   The map itself is drawn by livemap.js - the SAME renderer the standalone
   live-map page uses - so there is exactly one copy of the room shape/type and
   floor tables. This view only owns the compact header and the setup card.

   The server is a LOCAL process on the gaming PC (default :8851), so this is a
   cross-origin talk from the island site. Chromium and Firefox treat
   http://localhost as potentially trustworthy and allow it from an https page;
   Safari does not, and a phone cannot reach the PC's localhost at all - hence
   the direct Tailscale link in the setup card. */
const LIVEMAP_BASE = () => window.ISAAC_LIVEMAP_BASE || "http://localhost:8851";
const LIVEMAP_LAN = "http://100.65.157.51:8851/";

function renderLiveMap(){
  const app=$("#app"); app.innerHTML="";
  if(!window.LiveMap){
    app.appendChild(el("div","pad","The live map renderer (livemap.js) did not load."));
    return;
  }

  const wrap=el("div","lmv");

  /* ---- compact header: seed / floor / curses / link state ---- */
  const head=el("div","lmv-head");
  const seedEl=el("div","lmv-seed","---- ----");
  const floorEl=el("div","lmv-floor","—");
  const cursesEl=el("div","lmv-curses");
  const statusEl=el("span","lmv-status","connecting…");
  const dotEl=el("span","lmv-dot");
  const spoil=el("label","lmv-toggle",'<input type="checkbox"> spoilers');
  const cb=spoil.querySelector("input");
  cb.checked=LiveMap.getSpoilers();
  cb.onchange=()=>LiveMap.setSpoilers(cb.checked);
  head.appendChild(seedEl); head.appendChild(floorEl); head.appendChild(cursesEl);
  head.appendChild(el("span","lmv-spacer")); head.appendChild(statusEl);
  head.appendChild(dotEl); head.appendChild(spoil);

  /* ---- renderer mount: livemap.js creates .lm-map / .lm-empty / .lm-badges ---- */
  const stage=el("div","lmv-stage");
  const legend=el("div","lmv-legend");
  LiveMap.renderLegend(legend);

  /* ---- setup card, shown only when the server is unreachable ---- */
  const setup=el("div","lmv-setup hidden");
  setup.innerHTML=`<h2>Live map is not running</h2>
    <p class="dim">The Live tab mirrors your current run in real time &mdash; the floor
    layout, which rooms you have cleared, the room types, curses and seed &mdash; read
    from the game's own log by a small server on your gaming PC. Nothing is uploaded;
    this page talks straight to that PC.</p>
    <ol>
      <li>On the gaming PC, run <code>start-livemap.ps1</code> (in
        <code>projects/binding-of-isaac/livemap/</code>).</li>
      <li>Enable <b>Isaac Pilot Live Map</b> in Isaac's Mods menu, then restart the game.</li>
      <li>Start or continue a run and walk through one door.</li>
    </ol>
    <p class="dim">On a phone or another device, open the map directly:
      <a href="${LIVEMAP_LAN}" rel="noopener">${LIVEMAP_LAN}</a>
      (needs Tailscale). <b>Safari</b> cannot reach a local server from this
      secure page at all &mdash; use that direct link, or Chrome/Firefox.</p>
    <button class="lmv-retry">Retry connection</button>`;
  setup.querySelector(".lmv-retry").onclick=()=>renderLiveMap();

  wrap.appendChild(head); wrap.appendChild(stage);
  wrap.appendChild(legend); wrap.appendChild(setup);
  app.appendChild(wrap);

  // Paint the renderer's own "waiting for the game" state while we connect, so
  // the tab never flashes the setup card on a server that IS up.
  LiveMap.render({}, stage);

  let gotState=false;
  const showLive=live=>{
    stage.classList.toggle("hidden",!live);
    legend.classList.toggle("hidden",!live);
    head.classList.toggle("hidden",!live);
    setup.classList.toggle("hidden",live);
  };

  LiveMap.connect(LIVEMAP_BASE(), {
    onState(s){
      gotState=true;
      showLive(true);
      seedEl.textContent=s.seed||"---- ----";
      floorEl.textContent=s.stage?LiveMap.floorName(s.stage,s.stageType):"—";
      cursesEl.innerHTML="";
      LiveMap.curseNames(s.curses).forEach(n=>cursesEl.appendChild(el("span","lmv-curse",esc(n))));
      dotEl.classList.toggle("on",!!s.connected);
      const info=LiveMap.render(s,stage)||{rooms:0};
      statusEl.textContent=s.connected
        ? (info.rooms?info.rooms+" rooms":"waiting for a floor")
        : "no mod data yet";
    },
    onStatus(st){
      if(st==="live"){ statusEl.classList.remove("bad"); return; }
      if(st==="connecting"){ statusEl.textContent="connecting…"; return; }
      // error: a blip after we already had data must NOT wipe the map - only a
      // connection that never produced state gets the setup card.
      dotEl.classList.remove("on");
      statusEl.classList.add("bad");
      statusEl.textContent="reconnecting…";
      if(!gotState) showLive(false);
    }
  });
}

/* ================= STATS (opt-in tracker) ================= */
function renderStats(){
  if(state.statsTab==="simple") return renderCompletion();
  if(state.statsTab==="bosses") return renderBosses();
  return renderCharacters();
}
function openCharacter(slug){ state.curChar=slug; renderCharDetail(slug); window.scrollTo(0,0); }

/* ---- in-game-style character select: carousel + live completion-marks page ---- */
let carouselFocus = 0;
function renderCharacters(){
  if(state.curChar){ return renderCharDetail(state.curChar); }
  const app=$("#app"); app.innerHTML="";
  if(state.mode==="client" && noProgressYet()){
    const cta=el("div","savecta");
    cta.innerHTML=`<div class="savecta-txt"><b>Fill this in automatically</b>
      <span class="dim">Upload your <code>rep+persistentgamedataN.dat</code> and every mark, item, character and boss fills in from your real save &mdash; read in-browser, never uploaded. Or just tap the marks below to track by hand.</span></div>
      <button class="savecta-btn">⤒ Upload save</button>`;
    cta.querySelector(".savecta-btn").onclick=()=>$("#importFile").click();
    app.appendChild(cta);
  }
  const stage=el("div","charstage"); stage.id="charstage"; app.appendChild(stage);
  const nav=el("div","carrow");
  const prev=el("button","arrow","‹"); prev.setAttribute("aria-label","Previous character");
  const next=el("button","arrow","›"); next.setAttribute("aria-label","Next character");
  const wrap=el("div","carwrap"); const strip=el("div","charselect"); strip.id="charselect"; wrap.appendChild(strip);
  nav.appendChild(prev); nav.appendChild(wrap); nav.appendChild(next); app.appendChild(nav);
  state.data.characters.forEach((c,i)=>{
    const unlocked=charUnlocked(c.slug); const earned=charEarned(c.slug);
    const card=el("div","selcard"+(unlocked?"":" locked")); card.dataset.slug=c.slug; card.dataset.i=i;
    card.innerHTML=(unlocked?"":`<div class="lockbadge">🔒</div>`)+
      `<img src="${A(c.image)}" alt=""><div class="sn">${esc(c.name)}</div>`+
      `<div class="pips">${MARKS.map(m=>`<i class="${markEarned(c.slug,m.key)?"on":""}"></i>`).join("")}</div>`;
    card.onclick=()=>{ if(card.classList.contains("focused")) focusCard(i); else focusCard(i); };
    strip.appendChild(card);
  });
  strip.addEventListener("wheel",(e)=>{ if(Math.abs(e.deltaY)>Math.abs(e.deltaX)){ strip.scrollLeft+=e.deltaY; e.preventDefault(); } },{passive:false});
  let raf=null;
  const update=()=>{ raf=null; const mid=strip.scrollLeft+strip.clientWidth/2; let best=0,bd=1e9;
    [...strip.children].forEach((card,i)=>{ const cc=card.offsetLeft+card.offsetWidth/2; const dd=Math.abs(cc-mid);
      if(dd<bd){bd=dd;best=i;} });
    [...strip.children].forEach((card,i)=>card.classList.toggle("focused",i===best));
    if(best!==carouselFocus){ carouselFocus=best; renderStage(best); }
  };
  strip.addEventListener("scroll",()=>{ if(!raf) raf=requestAnimationFrame(update); });
  function focusCard(i){ const card=strip.children[i]; if(card) card.scrollIntoView({inline:"center",block:"nearest",behavior:"smooth"}); }
  prev.onclick=()=>focusCard(Math.max(0,carouselFocus-1));
  next.onclick=()=>focusCard(Math.min(state.data.characters.length-1,carouselFocus+1));
  carouselFocus=Math.min(carouselFocus,state.data.characters.length-1);
  requestAnimationFrame(()=>{ const card=strip.children[carouselFocus]; if(card) card.scrollIntoView({inline:"center",block:"nearest"}); renderStage(carouselFocus); update(); });
}
function renderStage(i){
  const c=state.data.characters[i]; if(!c) return; const stage=$("#charstage"); if(!stage) return;
  const unlocked=charUnlocked(c.slug); const earned=charEarned(c.slug);
  stage.innerHTML="";
  const top=el("div","stage-top");
  top.innerHTML=`<div class="stage-hero"><img src="${A(c.image)}" alt=""></div>
    <div class="stage-info">
      <h2>${esc(c.name)}${unlocked?"":' <span class="lock">🔒</span>'}</h2>
      <div class="stage-tags">${c.tainted?'<span class="tag tainted">Tainted</span>':'<span class="tag">Normal</span>'}
        ${unlocked?'<span class="tag ok">Unlocked</span>':'<span class="tag lockt">Locked</span>'}
        <span class="tag count">${earned}/${MARKS.length} marks</span></div>
      ${c.health?`<div class="stat-line"><b>Health</b> ${esc(c.health)}</div>`:""}
      ${c.starting_items?`<div class="stat-line"><b>Starts with</b> ${esc(c.starting_items)}</div>`:""}
      ${c.gimmick?`<div class="stat-line dim">${esc(c.gimmick)}</div>`:""}
      ${(!unlocked&&c.unlock)?`<div class="stat-line unlockline"><b>Unlock</b> ${esc(c.unlock)}</div>`:""}
      <button class="openbtn">Open ${esc(c.name.split(" ")[0])}'s page →</button>
    </div>`;
  top.querySelector(".openbtn").onclick=()=>openCharacter(c.slug);
  stage.appendChild(top);
  const binder=el("div","binder");
  const mh=el("div","marks-head"); mh.innerHTML=`<span>Completion Marks</span><span class="dim mh-hint">tap: empty → normal → hard &middot; Greed / Greedier are done-or-not</span>`;
  binder.appendChild(mh);
  binder.appendChild(buildMarksGrid(c.slug, ()=>{ renderStagePips(i); }));
  stage.appendChild(binder);
  const hint=el("div","charhint","‹ ›  Swipe, scroll, or use the arrows to flip through all "+state.data.characters.length+" characters");
  stage.appendChild(hint);
}
function renderStagePips(i){
  const strip=$("#charselect"); if(!strip) return; const card=strip.children[i]; if(!card) return;
  const c=state.data.characters[i]; const pips=card.querySelector(".pips");
  if(pips) pips.innerHTML=MARKS.map(m=>`<i class="${markEarned(c.slug,m.key)?"on":""}"></i>`).join("");
}
/* The completion-marks page: one parchment cell per mark, the real stamp art dim when
   unearned / solid when normal / red-outlined when Hard, exactly like the in-game screen. */
function buildMarksGrid(slug, onChange){
  const grid=el("div","cmarks");
  MARKS.forEach(m=>{
    const cell=el("button","mkcell"); cell.dataset.k=m.key;
    const md=markData(m.key);
    cell.title=esc((md.description||md.name||m.label)+(m.greed?" — Greed Mode has no Hard variant: done-or-not.":""));
    cell.innerHTML=`<span class="stamp"><img alt="" src="${markIcon(m.key,"normal")}"></span><span class="mkl">${esc(m.label)}</span>`;
    paintMkCell(cell,m.key,markEff(slug,m.key));
    cell.onclick=()=>{ const nx=cycleMark(slug,m.key); paintMkCell(cell,m.key,nx); if(onChange)onChange(); renderProfileBar(); };
    grid.appendChild(cell);
  });
  return grid;
}
function paintMkCell(cell,key,st){
  const img=cell.querySelector(".stamp img");
  img.src=markIcon(key, st==="none"?"normal":st);
  cell.classList.toggle("empty", st==="none");
  cell.classList.toggle("normal", markDisplayState(key,st)==="normal");
  cell.classList.toggle("hard", markDisplayState(key,st)==="hard");
  cell.classList.toggle("greed", isGreedMark(key));
}
/* keyboard arrows flip the carousel when it is the active screen */
document.addEventListener("keydown",e=>{
  if(state.view!=="stats"||state.statsTab!=="select"||state.curChar) return;
  if(!$("#modal").classList.contains("hidden")) return;
  const strip=$("#charselect"); if(!strip) return;
  if(e.key==="ArrowRight"){ const i=Math.min(state.data.characters.length-1,carouselFocus+1); const c=strip.children[i]; if(c)c.scrollIntoView({inline:"center",block:"nearest",behavior:"smooth"}); }
  else if(e.key==="ArrowLeft"){ const i=Math.max(0,carouselFocus-1); const c=strip.children[i]; if(c)c.scrollIntoView({inline:"center",block:"nearest",behavior:"smooth"}); }
});
function renderCharDetail(slug){
  const c=state.data.characters.find(x=>x.slug===slug); if(!c) return renderCharacters();
  const app=$("#app"); app.innerHTML="";
  const back=el("button","cd-back","← Character select"); back.onclick=()=>{state.curChar=null; renderCharacters();};
  app.appendChild(back);
  const unlocked=charUnlocked(slug);
  const head=el("div","cd-head");
  head.innerHTML=`<img src="${A(c.image)}" alt=""><div><h2>${esc(c.name)}</h2>`+
    `<div class="csub">${c.tainted?"Tainted &middot; ":""}${unlocked?'<span class="badge" style="color:var(--good)">Unlocked</span>':'<span class="badge">Locked</span>'} &middot; ${charEarned(slug)}/${MARKS.length} marks</div>`+
    `<div class="dim" style="font-size:13px;margin-top:4px;max-width:520px">${esc(c.gimmick||"")}</div></div>`;
  app.appendChild(head);
  if(!unlocked && c.unlock){ app.appendChild(el("div","pad","<b>Unlock:</b> "+esc(c.unlock))); }
  const binder=el("div","binder"); binder.style.margin="10px 16px 14px";
  const sh=el("div","section-h"); sh.textContent="Completion marks";
  binder.appendChild(sh);
  binder.appendChild(buildMarksGrid(slug));
  app.appendChild(binder);
  const items=[]; ["collectibles","trinkets","cards"].forEach(g=>state.data[g].forEach(e=>{ if(e.unlock_character===c.name) items.push(e); }));
  const sh2=el("div","section-h"); sh2.style.padding="0 16px"; sh2.textContent=`Items unlocked through ${c.name} (${items.filter(e=>itemOwned(e.slug)).length}/${items.length} owned)`;
  app.appendChild(sh2);
  if(!items.length){ app.appendChild(el("div","pad dim","No items unlock specifically through this character.")); }
  const box=el("div","uc-items"); box.style.padding="8px 16px 24px";
  items.forEach(e=>{
    const it=el("div","uitem"+(itemOwned(e.slug)?" collected":""));
    it.innerHTML=`<img loading="lazy" src="${A(e.image)}" alt=""><div style="flex:1;min-width:0"><div class="uin">${esc(e.name)}</div><div class="uic">${esc(e.unlock||"")}</div></div><button class="ubtn">✓</button>`;
    it.querySelector(".uin").onclick=()=>openDetail(e,e.kind==="trinket"?"trinket":"collectible");
    it.querySelector("img").onclick=()=>openDetail(e,"collectible");
    it.querySelector(".ubtn").onclick=()=>{ toggleItem(e.slug); it.classList.toggle("collected"); sh2.textContent=`Items unlocked through ${c.name} (${items.filter(x=>itemOwned(x.slug)).length}/${items.length} owned)`; };
    box.appendChild(it);
  });
  app.appendChild(box);
}

/* ---------- profile bar (stats view only) ---------- */
function wireProfileBar(){
  $("#profileSelect").onchange = async (e)=>{
    state.progress.active=e.target.value;
    if(state.mode==="server"){ await fetch(BASE+"api/active",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:e.target.value})}); }
    else persistLocal();
    render();
  };
  $("#syncBtn").onclick = async ()=>{
    if(state.mode!=="server"){ $("#importFile").click(); return; }
    const btn=$("#syncBtn"); btn.textContent="⟳ ...";
    const r=await fetch(BASE+"api/sync",{method:"POST"}).then(r=>r.json());
    if(r.progress) state.progress=r.progress;
    btn.textContent="⟳ Sync"; render();
  };
  $("#importFile").onchange = async (e)=>{
    const f=e.target.files[0]; if(!f) return;
    if(state.mode==="server"){
      const buf=await f.arrayBuffer();
      const r=await fetch(BASE+"api/import?profile="+encodeURIComponent(state.progress.active||""),{method:"POST",body:buf}).then(r=>r.json());
      if(r.ok){ await refreshState(); render(); } else alert("Import failed: "+(r.error||"unknown"));
    }else{ await importClient(f); }
    e.target.value="";
  };
  $("#profMenuBtn").onclick = profileMenu;
}
async function importClient(file){
  let imp;
  try{ imp = SaveParse.computeImported(SaveParse.parse(await file.arrayBuffer()), state.data, state.achIndex, state.bossIndex); }
  catch(e){ alert("Couldn't read that save:\n"+e.message); return; }
  const nm = (file.name||"My save").replace(/\.dat$/i,"").replace(/^rep\+persistentgamedata/i,"Save ") || "My save";
  let pid=state.progress.active;
  const cur = pid ? state.progress.profiles[pid] : null;
  if(cur){
    cur.imported = imp; cur.synced_at = nowStr();
    if(pid===DEFAULT_PROFILE_ID && cur.name===DEFAULT_PROFILE_NAME) cur.name = nm;
  }else{
    pid = "p"+Date.now();
    state.progress.profiles[pid] = {name:nm, manual:{marks:{},bosses:{},items:{}}, imported:imp, synced_at:nowStr()};
    state.progress.active = pid;
  }
  persistLocal(); state.curChar=null; state.view="stats"; render();
}
async function profileMenu(){
  const cur=AP();
  const act=prompt(`Profile "${cur.name||"(none)"}"\nType one of:  rename <name>  |  new <name>  |  delete`,"");
  if(!act) return;
  const [op,...rest]=act.trim().split(/\s+/); const name=rest.join(" ");
  if(state.mode==="server"){
    let body;
    if(op==="rename") body={op:"rename",id:state.progress.active,name};
    else if(op==="new") body={op:"create",name:name||"New profile"};
    else if(op==="delete") body={op:"delete",id:state.progress.active};
    else return;
    const r=await fetch(BASE+"api/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());
    if(r.progress){ state.progress=r.progress; render(); }
  }else{
    const P=state.progress;
    if(op==="rename" && P.profiles[P.active]){ P.profiles[P.active].name=(name||P.profiles[P.active].name).slice(0,40); }
    else if(op==="new"){ const pid="p"+Date.now(); P.profiles[pid]={name:(name||"New profile").slice(0,40),manual:{marks:{},bosses:{},items:{}},imported:{},synced_at:null}; P.active=pid; }
    else if(op==="delete" && P.profiles[P.active]){ delete P.profiles[P.active]; P.active=Object.keys(P.profiles)[0]||null; }
    else return;
    persistLocal(); state.curChar=null; render();
  }
}
function renderProfileBar(){
  const sel=$("#profileSelect"); if(!sel) return; sel.innerHTML="";
  const ids=Object.keys(state.progress.profiles);
  if(!ids.length){ const o=el("option"); o.textContent=(state.mode==="client"?"— no save loaded —":"— no profiles —"); sel.appendChild(o); }
  Object.entries(state.progress.profiles).forEach(([pid,p])=>{
    const o=el("option"); o.value=pid; o.textContent=p.name+(p.save_slot?` (slot ${p.save_slot})`:"");
    if(pid===state.progress.active) o.selected=true; sel.appendChild(o);
  });
  $("#syncBtn").style.display = state.mode==="server" ? "" : "none";
  const c=IMP().counts||{};
  const dg=deadGodHard(); const dgpct=Math.round(dg/TOTAL_MARKS()*100);
  const owned=state.data.collectibles.filter(e=>itemOwned(e.slug)).length;
  const chars=state.data.characters.filter(e=>charUnlocked(e.slug)).length;
  let synced;
  if(AP().parse_error) synced = "! save parse failed: "+AP().parse_error;
  else if(AP().synced_at) synced = (state.mode==="server"?"● ":"")+`synced ${state.mode==="server"?(AP().synced_at.split(" ")[1]||""):AP().synced_at}`;
  else synced = state.mode==="client" ? "no save loaded" : (AP().save_slot?"not synced":"manual profile");
  $("#pbStats").innerHTML =
    `<span class="synced ${(AP().synced_at&&!AP().parse_error)?"":"stale"}" title="${esc(synced)}">${esc(synced)}</span>`+
    stat(dgpct+"%","Dead God","dg")+
    stat(`${c.achievements_earned??"–"}/${c.achievements_total??"–"}`,"achievements")+
    stat(`${owned}`,"items owned")+
    stat(`${chars}/34`,"characters");
}
function stat(b,s,cls){ return `<div class="pbstat ${cls||""}"><b>${b}</b><span>${s}</span></div>`; }

/* ================= ITEMS (browse) ================= */
const browseState = {type:"collectible", q:"", quality:"", pool:"", owned:"", group:""};
const TYPE_LABEL = {
  collectible:    {chip:"Items",           one:"item",           plural:"items"},
  trinket:        {chip:"Trinkets",        one:"trinket",        plural:"trinkets"},
  card:           {chip:"Cards",           one:"card",           plural:"cards"},
  pill:           {chip:"Pills",           one:"pill",           plural:"pills"},
  pickup:         {chip:"Pickups",         one:"pickup",         plural:"pickups"},
  character:      {chip:"Characters",      one:"character",      plural:"characters"},
  boss:           {chip:"Bosses",          one:"boss",           plural:"bosses"},
  challenge:      {chip:"Challenges",      one:"challenge",      plural:"challenges"},
  transformation: {chip:"Transformations", one:"transformation", plural:"transformations"},
};
const COLLECTABLE_TYPES = ["collectible","trinket","card","pill"];
function allEntities(t){ const d=state.data; return {collectible:d.collectibles,trinket:d.trinkets,card:d.cards,pill:d.pills,
  character:d.characters,boss:d.bosses,challenge:d.challenges,transformation:d.transformations,pickup:d.pickups}[t]||[]; }
const DETAIL_TYPE = {trinket:"trinket",character:"character",boss:"boss",challenge:"challenge",
  transformation:"transformation",pickup:"pickup",pill:"pill"};
function renderItems(){
  const app=$("#app"); app.innerHTML=""; const bs=browseState;
  const controls=el("div","controls");
  const chips=el("div","chips");
  Object.entries(TYPE_LABEL).map(([t,l])=>[t,l.chip])
    .forEach(([t,lab])=>{ const c=el("button","chip"+(bs.type===t?" on":""),lab); c.onclick=()=>{bs.type=t;bs.quality="";bs.pool="";bs.group="";bs.owned="";state.wikiCat=t;window.scrollTo(0,0);render();}; chips.appendChild(c);});
  controls.appendChild(chips);
  const search=el("input"); search.type="search"; search.placeholder="Search "+TYPE_LABEL[bs.type].plural+"..."; search.value=bs.q;
  search.oninput=()=>{bs.q=search.value.toLowerCase();paintItems();}; controls.appendChild(search);
  if(bs.type==="collectible"||bs.type==="trinket"){
    const qsel=el("select"); qsel.innerHTML=`<option value="">All quality</option>`+[4,3,2,1,0].map(q=>`<option value="${q}" ${bs.quality===String(q)?"selected":""}>Quality ${q}</option>`).join("");
    qsel.onchange=()=>{bs.quality=qsel.value;paintItems();}; controls.appendChild(qsel);
    if(state.view==="stats"){
      const osel=el("select"); osel.innerHTML=`<option value="">Owned + not</option><option value="1" ${bs.owned==="1"?"selected":""}>Owned only</option><option value="0" ${bs.owned==="0"?"selected":""}>Missing only</option>`;
      osel.onchange=()=>{bs.owned=osel.value;paintItems();}; controls.appendChild(osel);
    }
  }
  if(bs.type==="pickup"||bs.type==="challenge"||bs.type==="transformation"){
    const field=bs.type==="pickup"?"category":"dlc";
    const vals=[...new Set(allEntities(bs.type).map(e=>e[field]).filter(Boolean))];
    const gsel=el("select");
    gsel.innerHTML=`<option value="">All ${bs.type==="pickup"?"categories":"DLC"}</option>`+
      vals.map(v=>`<option value="${esc(v)}" ${bs.group===v?"selected":""}>${esc(v)}</option>`).join("");
    gsel.onchange=()=>{bs.group=gsel.value;paintItems();}; controls.appendChild(gsel);
  }
  const cnt=el("span","count"); cnt.id="itemcount"; controls.appendChild(cnt);
  app.appendChild(controls);
  const grid=el("div","grid"); grid.id="itemgrid"; app.appendChild(grid); paintItems();
}
function itemsFiltered(){ const bs=browseState; return allEntities(bs.type).filter(e=>{
  if(bs.q && !e.name.toLowerCase().includes(bs.q)) return false;
  if(bs.quality!=="" && String(e.quality)!==bs.quality) return false;
  if(bs.owned==="1" && !itemOwned(e.slug)) return false;
  if(bs.owned==="0" && itemOwned(e.slug)) return false;
  if(bs.group){ const f=bs.type==="pickup"?"category":"dlc"; if(e[f]!==bs.group) return false; }
  return true; }); }
function paintItems(){
  const grid=$("#itemgrid"); if(!grid)return; grid.innerHTML=""; const bs=browseState; const list=itemsFiltered();
  $("#itemcount").textContent=list.length+" "+TYPE_LABEL[bs.type][list.length===1?"one":"plural"];
  const collectable=COLLECTABLE_TYPES.includes(bs.type);
  const showTick=collectable && state.view==="stats";
  const frag=document.createDocumentFragment();
  list.forEach(e=>{
    const owned=collectable && itemOwned(e.slug);
    const card=el("div","card"+(owned&&state.view==="stats"?" collected":""));
    let q=e.quality!=null?`<div class="qd">`+"<i></i>".repeat(e.quality||0)+`</div>`:"";
    const label=e.number!=null?`#${e.number} ${e.name}`:e.name;
    card.innerHTML=q+`<div class="thumb"><img loading="lazy" src="${A(e.image)}" alt=""></div><div class="nm">${esc(label)}</div>`+(showTick?`<button class="chk">✓</button>`:"");
    const type=DETAIL_TYPE[bs.type]||"collectible";
    card.querySelector(".thumb").onclick=()=>openDetail(e,type);
    card.querySelector(".nm").onclick=()=>openDetail(e,type);
    if(showTick) card.querySelector(".chk").onclick=(ev)=>{ev.stopPropagation();toggleItem(e.slug);card.classList.toggle("collected");};
    frag.appendChild(card);
  });
  grid.appendChild(frag);
}

/* ---------- detail modal ---------- */
function openDetail(e,type){
  const card=$("#modal-card");
  const qcol=getComputedStyle(document.documentElement).getPropertyValue("--q"+(e.quality??0));
  let head=`<button class="closebtn">✕</button><div class="modal-head"><img src="${A(e.image)}" alt=""><div><h2>${esc(e.name)}</h2>`;
  const b=[];
  if(e.quality!=null) b.push(`<span class="badge q" style="background:${qcol}">Quality ${e.quality}</span>`);
  if(e.dlc) b.push(`<span class="badge">${esc(e.dlc)}</span>`);
  if(type==="trinket") b.push(`<span class="badge">Trinket</span>`);
  if(e.chapter) b.push(`<span class="badge">${esc(e.chapter)}</span>`);
  if(e.where) b.push(`<span class="badge">${esc(e.where)}</span>`);
  if(type==="challenge"){
    b.push(`<span class="badge">Challenge #${e.number}</span>`);
    b.push(`<span class="badge">${esc(e.character)}</span>`);
    b.push(`<span class="badge">Goal: ${esc(e.goal)}</span>`);
    if(e.blindfolded) b.push(`<span class="badge" style="color:#f4c045">Blindfolded</span>`);
  }
  if(type==="transformation"){ b.push(`<span class="badge">Transformation</span>`); }
  if(type==="pickup"){ b.push(`<span class="badge">${esc(e.category)}</span>`);
    if(e.entity_id) b.push(`<span class="badge">${esc(e.entity_id)}</span>`); }
  if(type==="pill"&&e.polarity) b.push(`<span class="badge" style="color:${e.polarity==="Good"?"#5ac57a":e.polarity==="Bad"?"#e06666":"#c9c9d6"}">${esc(e.polarity)}</span>`);
  if(state.view==="stats" && e.kind && ["collectible","trinket","card","pill"].includes(e.kind)) b.push(itemOwned(e.slug)?`<span class="badge" style="color:#5ac57a">Owned</span>`:`<span class="badge">Not owned</span>`);
  head+=b.join("")+`</div></div>`;
  let body="";
  if(e.desc_lines&&e.desc_lines.length) body+=`<ul class="efflist">`+e.desc_lines.map(l=>`<li>${esc(l)}</li>`).join("")+`</ul>`;
  if(type==="character") body+=kv("Health",e.health)+kv("Starting items",e.starting_items)+kv("Gimmick",e.gimmick)+kv("Unlock",e.unlock);
  if(type==="boss") body+=(e.description?`<p>${esc(e.description)}</p>`:"")+kv("Floors",e.floors)+kv("Base HP",e.hp)+kv("Ending",e.ending)+kv("Completion mark",e.mark);
  if(type==="challenge"){
    body+=(e.description?`<p>${esc(e.description)}</p>`:"");
    if((e.items||[]).length) body+=`<div class="section-h">Starting items</div>`+e.items.map(x=>`<span class="badge">${esc(x)}</span>`).join("");
    if((e.trinkets||[]).length) body+=`<div class="section-h">Starting trinket</div>`+e.trinkets.map(x=>`<span class="badge">${esc(x)}</span>`).join("");
    if((e.pickups||[]).length) body+=`<div class="section-h">Starting pickups</div>`+e.pickups.map(x=>`<span class="badge">${esc(x)}</span>`).join("");
    if((e.curses||[]).length) body+=`<div class="section-h">Forced curses</div>`+e.curses.map(x=>`<span class="badge">${esc(x)}</span>`).join("");
    body+=kv("Unlocked by",e.unlocked_by)+kv("Reward on first completion",e.reward)
        +kv("Rooms",`Treasure Rooms: ${e.has_treasure_rooms?"yes":"no"} &middot; Shops: ${e.has_shops?"yes":"no"}`);
  }
  if(type==="transformation"){
    body+=(e.description?`<p>${esc(e.description)}</p>`:"")+kv("Trigger",e.trigger);
    if((e.components||[]).length) body+=`<div class="section-h">Counts toward it (${e.components.length})</div>`+
      e.components.map(x=>`<span class="badge">${esc(x)}</span>`).join("");
    if((state.data.transformation_rules||[]).length)
      body+=`<div class="section-h">How transformations work</div><ul class="efflist">`+
        state.data.transformation_rules.map(r=>`<li>${esc(r)}</li>`).join("")+`</ul>`;
  }
  if(type==="pickup"){
    body+=(e.description?`<p>${esc(e.description)}</p>`:"")+kv("Worth",e.value)+
      kv("Random spawn chance",e.spawn_chance);
    if(e.sprite_note) body+=`<p class="dim" style="font-size:12px">${esc(e.sprite_note)}</p>`;
  }
  if(type==="pill"){
    if(e.wiki_effect) body+=`<div class="section-h">Effect</div><p>${esc(e.wiki_effect)}</p>`;
    if(e.horse_effect) body+=`<div class="section-h">Horse pill</div>`+
      `<div class="horsepill"><img src="${A(e.horse_image)}" alt=""><p>${esc(e.horse_effect)}</p></div>`;
    if(e.pill_class!=null && e.pill_class!==""){
      const pc=((state.data.meta||{}).pill_classes)||{};
      const lab=pc[String(e.pill_class)];
      body+=`<div class="section-h">Pill class</div><p>${esc(lab?`${e.pill_class} — ${lab}`:String(e.pill_class))}</p>`;
      const legend=(state.data.meta||{}).pill_class_legend;
      if(legend) body+=`<p class="dim" style="font-size:12px">${esc(legend)}</p>`;
    }
    if(e.color_note) body+=`<p class="dim" style="font-size:12px">${esc(e.color_note)}</p>`;
  }
  if((e.pools||[]).length) body+=`<div class="section-h">Item pools</div>`+e.pools.map(p=>`<span class="badge">${esc(p)}</span>`).join("");
  if(e.unlock&&type!=="character") body+=`<div class="section-h">Unlock</div><p>${esc(e.unlock)}${e.unlock_character?` <span class="badge">${esc(e.unlock_character)}</span>`:""}</p>`;
  if((e.transformations||[]).length) body+=`<div class="section-h">Counts toward</div>`+e.transformations.map(t=>`<span class="badge">${esc(t)}</span>`).join("");
  if((e.synergies||[]).length) body+=`<div class="section-h">Synergies</div>`+e.synergies.map(s=>{const m=s.match(/^([^:]{1,60}):\s*(.*)$/);return m?`<div class="syn"><b>${esc(m[1])}</b>: ${esc(m[2])}</div>`:`<div class="syn">${esc(s)}</div>`;}).join("");
  if(e.wiki) body+=`<div class="section-h">Reference</div><a class="wikilink" href="${esc(e.wiki)}" target="_blank" rel="noopener">Open wiki page ↗</a>`;
  card.innerHTML=head+body;
  card.querySelector(".closebtn").onclick=closeModal;
  $("#modal").classList.remove("hidden");
}
function kv(k,v){ return v?`<div class="section-h">${esc(k)}</div><p>${esc(v)}</p>`:""; }
function closeModal(){ $("#modal").classList.add("hidden"); }
$("#modal").addEventListener("click",e=>{ if(e.target.id==="modal") closeModal(); });
document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeModal(); });

/* ================= COMPLETION grid (simplified view) ================= */
function renderCompletion(){
  const app=$("#app"); app.innerHTML="";
  const hard=deadGodHard(); const total=TOTAL_MARKS(); const pct=Math.round(hard/total*100);
  let normal=0,left=0; state.data.characters.forEach(c=>MARKS.forEach(m=>{const s=markEff(c.slug,m.key);
    if(markIsMax(m.key,s))return; if(s==="normal")normal++; else if(s==="none")left++;}));
  const dg=el("div","dead-god");
  dg.innerHTML=`<div><div class="dg-pct">${pct}%</div><small>Dead God (Hard marks)</small></div>`+
    `<div style="flex:1;min-width:200px"><div class="dg-bar"><div style="width:${pct}%"></div></div><small>${hard} hard &middot; ${normal} normal (auto from save) &middot; ${left} left of ${total}</small></div>`+
    `<div class="legend"><span><b style="background:#d8cba9"></b>Normal</span><span><b style="background:#d8cba9;box-shadow:0 0 0 2px #f4c045 inset"></b>Hard = Dead God</span>`+
    `<span class="dim">Greed / Greedier are done-or-not (no Hard variant in game)</span></div>`;
  app.appendChild(dg);
  const wrap=el("div","tablewrap"); const tbl=el("table","marks");
  let thead=`<thead><tr><th class="charcell" style="left:0">Character</th>`+MARKS.map(m=>{
    const md=markData(m.key);
    const tip=esc((md.description||"")+(m.greed?" — Greed Mode has no Hard variant: this mark is done-or-not.":""));
    return `<th${m.greed?' style="opacity:.85"':''} title="${tip}">`+
      `<div class="markchip"><img src="${markIcon(m.key,"normal")}" alt=""></div><div>${esc(m.label)}${m.greed?'<span class="twostate" title="two-state">•</span>':""}</div></th>`;
  }).join("")+`<th class="rowpct">#</th></tr></thead>`;
  let rows="";
  state.data.characters.forEach(c=>{
    let done=0;
    const cells=MARKS.map(m=>{const s=markEff(c.slug,m.key); if(markIsMax(m.key,s))done++;
      const bg=s==="none"?"":`background-image:url('${markIcon(m.key,s)}')`;
      return `<td><button class="mk ${markDisplayState(m.key,s)} ${m.greed?'greedcol':''}" style="${bg}" data-c="${c.slug}" data-k="${m.key}"></button></td>`;}).join("");
    rows+=`<tr><td class="charcell"><img src="${A(c.image)}" alt=""><div><div class="cn">${esc(c.name)}</div><div class="cc">${c.tainted?'Tainted':'Normal'}</div></div></td>${cells}<td class="rowpct">${done}/${MARKS.length}</td></tr>`;
  });
  tbl.innerHTML=thead+"<tbody>"+rows+"</tbody>"; wrap.appendChild(tbl); app.appendChild(wrap);
  tbl.querySelectorAll(".mk").forEach(btn=>{
    btn.onclick=()=>{ const k=btn.dataset.k, ch=btn.dataset.c; const nx=cycleMark(ch,k);
      btn.className="mk "+markDisplayState(k,nx)+(isGreedMark(k)?" greedcol":"");
      paintMark(btn,k,nx);
      const hard=deadGodHard(),total=TOTAL_MARKS(),pct=Math.round(hard/total*100);
      $(".dg-pct").textContent=pct+"%"; $(".dg-bar>div").style.width=pct+"%";
      const done=MARKS.reduce((n,m)=>n+(markIsMax(m.key,markEff(ch,m.key))?1:0),0);
      btn.closest("tr").querySelector(".rowpct").textContent=`${done}/${MARKS.length}`;
      renderProfileBar();
    };
  });
}

/* ================= BOSSES ================= */
const bossState={q:"",cat:"",need:false};
function renderBosses(){
  const app=$("#app"); app.innerHTML="";
  const controls=el("div","controls"); const chips=el("div","chips");
  [["","All"],["floor","Floor bosses"],["major","Major / ending"]].forEach(([v,lab])=>{const c=el("button","chip"+(bossState.cat===v?" on":""),lab);c.onclick=()=>{bossState.cat=v;paintBosses();};chips.appendChild(c);});
  if(state.view==="stats"){
    const needc=el("button","chip"+(bossState.need?" on":""),"Only ones I still need"); needc.onclick=()=>{bossState.need=!bossState.need;renderBosses();}; chips.appendChild(needc);
    const hasManual=Object.keys(MAN().bosses).length>0;
    if(hasManual){ const reset=el("button","chip","↺ Reset to save"); reset.title="Clear your manual boss ticks and use the save file"; reset.onclick=()=>{ MAN().bosses={}; saveManual(); renderBosses(); }; chips.appendChild(reset); }
  }
  controls.appendChild(chips);
  const search=el("input"); search.type="search"; search.placeholder="Search bosses..."; search.value=bossState.q; search.oninput=()=>{bossState.q=search.value.toLowerCase();paintBosses();}; controls.appendChild(search);
  const cnt=el("span","count"); cnt.id="bosscount"; controls.appendChild(cnt); app.appendChild(controls);
  if(state.view==="stats"){
    const note=el("div","dim"); note.style.cssText="padding:0 16px 4px;font-size:12px"; note.textContent="Defeated bosses are auto-crossed from your save file (updates on Sync). Tap one to override.";
    app.appendChild(note);
  }
  const list=el("div","blist"); list.id="blist"; app.appendChild(list); paintBosses();
}
function paintBosses(){
  const list=$("#blist"); if(!list)return; list.innerHTML="";
  let bosses=state.data.bosses.filter(b=>{ if(bossState.cat&&b.category!==bossState.cat)return false; if(bossState.q&&!b.name.toLowerCase().includes(bossState.q))return false; if(bossState.need&&bossKilled(b.slug))return false; return true; });
  const cntEl=$("#bosscount");
  if(state.view==="stats"){ const defeated=state.data.bosses.filter(b=>bossKilled(b.slug)).length; cntEl.textContent=`${defeated}/${state.data.bosses.length} defeated`; }
  else { cntEl.textContent=`${bosses.length} of ${state.data.bosses.length} bosses`; }
  const showTick=state.view==="stats";
  const frag=document.createDocumentFragment();
  bosses.forEach(b=>{
    const killed=showTick && bossKilled(b.slug);
    const row=el("div","brow"+(killed?" killed":""));
    row.innerHTML=`<img loading="lazy" src="${A(b.image)}" alt=""><div style="flex:1;min-width:0"><div class="bn">${esc(b.name)}</div><div class="bmeta">${esc(b.chapter||b.where||"")}${b.floors?" &middot; "+esc(b.floors):""}${b.mark?" &middot; Mark: "+esc(b.mark):""}</div><div class="bd">${esc(b.description||"")}</div></div>`+(showTick?`<button class="kbtn">✓</button>`:"");
    row.querySelector(".bn").onclick=()=>openDetail(b,"boss");
    row.querySelector("img").onclick=()=>openDetail(b,"boss");
    if(showTick) row.querySelector(".kbtn").onclick=()=>{ toggleBoss(b.slug); row.classList.toggle("killed"); if(bossState.need&&bossKilled(b.slug))row.remove(); };
    frag.appendChild(row);
  });
  list.appendChild(frag);
}

/* ================= UNLOCKS ================= */
function renderUnlocks(){
  const app=$("#app"); app.innerHTML="";
  const groups={};
  ["collectibles","trinkets","cards"].forEach(g=>state.data[g].forEach(e=>{ if(e.unlock_character){(groups[e.unlock_character]=groups[e.unlock_character]||[]).push(e);} }));
  const totalItems=Object.values(groups).reduce((a,b)=>a+b.length,0);
  const intro=el("div","controls"); intro.innerHTML=`<span class="count" style="margin-left:0">${totalItems} items unlock via a specific character.${state.view==="stats"?" Owned items are auto-filled from your save.":""}</span>`;
  app.appendChild(intro);
  const showTick=state.view==="stats";
  const order=state.data.characters.map(c=>c.name).filter(n=>groups[n]); Object.keys(groups).forEach(n=>{ if(!order.includes(n))order.push(n); });
  order.forEach(name=>{
    const items=groups[name]; const ch=state.byName[name];
    const owned=items.filter(e=>itemOwned(e.slug)).length;
    const box=el("div","unlock-char"); const head=el("div","uc-head");
    head.innerHTML=(ch?`<img src="${A(ch.image)}" alt="">`:"")+`<span class="ucn">${esc(name)}</span>`+(showTick?`<span class="ucp">${owned}/${items.length} owned</span>`:`<span class="ucp">${items.length} items</span>`);
    const body=el("div","uc-items");
    items.forEach(e=>{
      const it=el("div","uitem"+(showTick&&itemOwned(e.slug)?" collected":""));
      it.innerHTML=`<img loading="lazy" src="${A(e.image)}" alt=""><div style="flex:1;min-width:0"><div class="uin">${esc(e.name)}</div><div class="uic">${esc(e.unlock||"")}</div></div>`+(showTick?`<button class="ubtn">✓</button>`:"");
      it.querySelector(".uin").onclick=()=>openDetail(e,e.kind==="trinket"?"trinket":"collectible");
      it.querySelector("img").onclick=()=>openDetail(e,"collectible");
      if(showTick) it.querySelector(".ubtn").onclick=()=>{ toggleItem(e.slug); it.classList.toggle("collected"); head.querySelector(".ucp").textContent=`${items.filter(x=>itemOwned(x.slug)).length}/${items.length} owned`; };
      body.appendChild(it);
    });
    head.onclick=(ev)=>{ if(ev.target.closest(".uitem"))return; body.classList.toggle("hidden"); };
    box.appendChild(head); box.appendChild(body); app.appendChild(box);
  });
}

boot();
