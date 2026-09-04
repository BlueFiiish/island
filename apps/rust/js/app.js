'use strict';

// ---------------- state ----------------
const S = {
  items: [], raid: null, recycle: null,
  view: 'items', q: '', cat: 'All',
  recycMode: 'monument',
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $('#app');
const norm = s => (s || '').toLowerCase();
const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- favorites (pinned items) ----
function favs() { try { return JSON.parse(localStorage.getItem('rc_favs') || '[]'); } catch (e) { return []; } }
function favSave(a) { try { localStorage.setItem('rc_favs', JSON.stringify(a)); } catch (e) {} }
function favHas(slug) { return favs().includes(slug); }
function favToggle(slug) { const a = favs(); const i = a.indexOf(slug); if (i >= 0) a.splice(i, 1); else a.unshift(slug); favSave(a); }

// ---------------- data load ----------------
async function loadJSON(p) { const r = await fetch(p); if (!r.ok) throw new Error(p); return r.json(); }

// Wait for a lazily-loaded dataset, with a hard retry cap so a failed fetch can't spin forever.
const RETRY = {};
function waitFor(key, view, label) {
  if (S[key]) { RETRY[key] = 0; return view(); }
  RETRY[key] = (RETRY[key] || 0) + 1;
  if (RETRY[key] > 40) { // ~10s
    RETRY[key] = 0;
    app.innerHTML = `<div class="empty">Couldn't load ${label}. Check your connection.<br><button class="btn" style="max-width:220px;margin:16px auto 0" onclick="location.reload()">Reload</button></div>`;
    loadJSON('/island/apps/rust/data/' + key + '.json').then(d => { S[key] = d; if (S.view === key) view(); }).catch(() => {});
    return;
  }
  app.innerHTML = `<div class="loading"><div class="spinner"></div>Loading ${label}…</div>`;
  setTimeout(() => { if (S.view === key) view(); }, 250);
}

async function boot() {
  bindTabs();
  showLoading();
  try {
    S.items = await loadJSON('/island/apps/rust/data/items.json');
  } catch (e) { app.innerHTML = `<div class="empty">Couldn't load item data.<br>${esc(e.message)}</div>`; return; }
  // lazy-load the tool datasets in the background
  Promise.all([
    loadJSON('/island/apps/rust/data/raid.json').then(d => S.raid = d).catch(() => {}),
    loadJSON('/island/apps/rust/data/recycle.json').then(d => S.recycle = d).catch(() => {}),
    loadJSON('/island/apps/rust/data/tech.json').then(d => S.tech = d).catch(() => {}),
    loadJSON('/island/apps/rust/data/recipes.json').then(d => S.recipes = d).catch(() => {}),
    loadJSON('/island/apps/rust/data/wiki.json').then(d => { S.wiki = d; S._wikiByPath = Object.fromEntries(d.pages.map(p => [p.path, p])); }).catch(() => {}),
  ]);
  const start = (location.hash || '#items').slice(1);
  go(VIEWS.includes(start) ? start : 'items');
}

function showLoading() { app.innerHTML = `<div class="loading"><div class="spinner"></div>Loading Rust data…</div>`; }

// ---------------- router ----------------
function bindTabs() {
  $$('.tab').forEach(t => t.addEventListener('click', () => { if (t.dataset.view === 'wiki') S.wikiPage = null; go(t.dataset.view); }));
  const sb = $('#shareBtn'); if (sb) sb.addEventListener('click', openShare);
}
const APP_URL = 'https://bluefiiish.github.io/island/rust/';
function openShare() {
  openSheet(`
    <div class="grabber"></div>
    <div class="share-sheet">
      <h2>&#127807; Share Rust Companion</h2>
      <p>Send this to your Rust friends — no login, no download, works on any phone. Each person gets their own saved data.</p>
      <img class="share-qr" src="/island/apps/rust/icons/qr.png" alt="Scan to open Rust Companion" onerror="this.style.display='none'"/>
      <div class="share-url" id="shareUrl">bluefiiish.github.io/island/rust</div>
      <button class="btn" id="shareCopy">Copy link</button>
      ${navigator.share ? `<button class="btn ghost" id="shareNative">Share&hellip;</button>` : ''}
      <div class="install-steps">
        <h3>Install it like an app</h3>
        <p><b>iPhone:</b> open the link in <b>Safari</b> &rarr; tap the Share icon &rarr; <b>Add to Home Screen</b>.</p>
        <p><b>Android:</b> open in <b>Chrome</b> &rarr; menu (&#8942;) &rarr; <b>Install app</b> / Add to Home Screen.</p>
      </div>
    </div>`);
  $('#shareCopy').addEventListener('click', function () {
    navigator.clipboard?.writeText(APP_URL); this.textContent = 'Link copied!'; this.classList.add('copied');
  });
  const sn = $('#shareNative'); if (sn) sn.addEventListener('click', () => navigator.share({ title: 'Rust Companion', text: 'Rust item DB, raid & craft calculators, tech trees, genetics scanner — free, no login.', url: APP_URL }).catch(() => {}));
}
const VIEWS = ['items', 'tech', 'raid', 'recycle', 'farm', 'wiki'];
function go(view) {
  if (!VIEWS.includes(view)) view = 'items';
  closeSheet();
  document.body.classList.remove('tt-fs-lock'); // leaving/entering any view cleanly exits tech-tree fullscreen
  if (typeof scanStop === 'function') scanStop();
  S.view = view;
  // If a sub-view entry (item sheet / wiki article) is on top of the stack,
  // don't push on top of it — replace it (or consume it) so back lands right.
  const hst = history.state || {};
  const sub = (hst.rcSheet ? 1 : 0) + (hst.rcWikiDepth || 0);
  if (location.hash.slice(1) !== view) {
    if (sub) location.replace('#' + view); else location.hash = view;
  } else if (sub) {
    history.go(-sub);
  }
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  window.scrollTo(0, 0);
  ({ items: viewItems, tech: viewTech, raid: viewRaid, recycle: viewRecycle, farm: viewFarm, wiki: viewWiki }[view] || viewItems)();
}
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (VIEWS.includes(v) && v !== S.view) go(v);
});
// Sub-view history: the item sheet and wiki articles push history entries so the
// phone back button/back-swipe closes the topmost sub-view instead of leaving the
// view/app. Plain hash navigation (state without our markers) falls through to the
// hashchange handler above.
window.addEventListener('popstate', e => {
  sheetDismissing = false;
  const st = e.state || {};
  if (!sheet.hidden && !st.rcSheet) closeSheet();
  if ((location.hash.slice(1) || 'items') === 'wiki') {
    const page = st.rcWiki || null;
    if (page !== S.wikiPage) {
      S.wikiPage = page;
      // if wiki.json hasn't lazy-loaded yet, route through viewWiki's waitFor guard
      if (S.view === 'wiki') { if (page && S._wikiByPath) { renderWikiPage(page); window.scrollTo(0, 0); } else viewWiki(); }
    }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { dismissSheet(); ttToggleFullscreen(false); } });

// ================= ITEMS =================
const CATS = ['All', 'Weapon', 'Ammunition', 'Tool', 'Construction', 'Component', 'Electrical', 'Resources', 'Attire', 'Medical', 'Food', 'Traps', 'Items', 'Fun', 'Misc'];

function viewItems() {
  app.innerHTML = `
    <div class="searchwrap">
      <div class="search">
        <span>&#128269;</span>
        <input id="q" type="search" inputmode="search" placeholder="Search 1,000+ items…" autocomplete="off" value="${esc(S.q)}" />
        <span class="clr" id="clr" ${S.q ? '' : 'hidden'}>&times;</span>
      </div>
    </div>
    <div class="chips" id="chips">${CATS.map(c => `<button class="chip ${c === S.cat ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}</div>
    <div class="fav-strip" id="favStrip"></div>
    <div class="count" id="count"></div>
    <div class="grid" id="grid"></div>
    <div class="credit">Item data &amp; icons via <a href="https://rusthelp.com">rusthelp.com</a> · Built for BlueFiiish · Offline-ready</div>`;
  const qi = $('#q');
  qi.addEventListener('input', () => { S.q = qi.value; $('#clr').hidden = !S.q; renderGrid(); });
  $('#clr').addEventListener('click', () => { S.q = ''; qi.value = ''; $('#clr').hidden = true; qi.focus(); renderGrid(); });
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    S.cat = b.dataset.c;
    $$('.chip').forEach(c => c.classList.toggle('on', c === b));
    renderGrid();
  });
  renderFavStrip();
  renderGrid();
}

function scoreItem(it, q) {
  const n = norm(it.name), sn = norm(it.shortname);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (sn.startsWith(q)) return 2;
  if (n.includes(q)) return 3;
  if (sn.includes(q)) return 4;
  if (norm(it.description).includes(q)) return 5;
  return 99;
}
function filtered() {
  const q = norm(S.q).trim();
  let list = S.items;
  if (S.cat !== 'All') list = list.filter(i => i.category === S.cat);
  if (!q) return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  return list.map(i => [scoreItem(i, q), i]).filter(x => x[0] < 99)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(x => x[1]);
}
function renderGrid() {
  const list = filtered();
  $('#count').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  const grid = $('#grid');
  if (!list.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1">No items match “${esc(S.q)}”.</div>`; return; }
  grid.innerHTML = list.slice(0, 400).map((it, i) => `
    <div class="icard" data-slug="${esc(it.slug)}">
      <img loading="lazy" src="/island/apps/rust/${esc(it.image)}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="nm">${esc(it.name)}</div>
      <div class="cat">${esc(it.category)}</div>
    </div>`).join('') + (list.length > 400 ? `<div class="count" style="grid-column:1/-1">Showing first 400 — keep typing to narrow.</div>` : '');
  grid.onclick = e => { const c = e.target.closest('.icard'); if (c) openItem(c.dataset.slug); };
}

function renderFavStrip() {
  const el = $('#favStrip'); if (!el) return;
  const list = favs().map(s => S.items.find(i => i.slug === s)).filter(Boolean);
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="fav-label">&#11088; Pinned</div><div class="fav-row">${list.map(it => `<button class="fav-card" data-slug="${esc(it.slug)}"><img loading="lazy" src="/island/apps/rust/${esc(it.image)}" alt="" onerror="this.style.visibility='hidden'"/><span>${esc(it.name)}</span></button>`).join('')}</div>`;
  el.querySelectorAll('.fav-card').forEach(c => c.addEventListener('click', () => openItem(c.dataset.slug)));
}

// ---- craft cost ----
function itemBySlug(slug) { if (!S._bySlug) S._bySlug = Object.fromEntries(S.items.map(i => [i.slug, i])); return S._bySlug[slug]; }
function ingChip(slug, name, amt) {
  const it = itemBySlug(slug);
  const img = it ? `<img src="/island/apps/rust/${esc(it.image)}" alt="" onerror="this.style.display='none'"/>` : '';
  return `<span class="ci"${it ? ` data-slug="${esc(slug)}"` : ''}>${img}<b>${amt.toLocaleString()}</b> ${esc(name || (it ? it.name : slug))}</span>`;
}
function craftRaw(slug, qty, acc, seen) {
  const r = S.recipes && S.recipes[slug];
  if (!r || seen.has(slug)) { acc[slug] = (acc[slug] || 0) + qty; return; }
  const ns = new Set(seen); ns.add(slug);
  const batch = qty / (r.makes || 1);
  r.ings.forEach(i => craftRaw(i.slug, i.amount * batch, acc, ns));
}
function buildCraftHtml(slug) {
  const r = S.recipes && S.recipes[slug]; if (!r) return '';
  const wb = r.wb > 0 ? `Workbench ${r.wb}` : 'No workbench';
  const direct = r.ings.map(i => ingChip(i.slug, i.name, i.amount)).join('');
  const acc = {}; craftRaw(slug, 1, acc, new Set());
  const rawKeys = Object.keys(acc).sort((a, b) => acc[b] - acc[a]);
  const raw = rawKeys.map(s => { const it = itemBySlug(s); return ingChip(s, it ? it.name : s, Math.ceil(acc[s])); }).join('');
  const same = r.ings.length === rawKeys.length && r.ings.every(i => rawKeys.includes(i.slug));
  return `<div class="panel craft">
    <h3>&#128296; Craft cost <span class="wb-tag">${wb}${r.makes > 1 ? ` · makes ${r.makes}` : ''}</span></h3>
    <div class="ci-row">${direct}</div>
    ${!same ? `<div class="craft-raw-label">Full raw materials to craft one</div><div class="ci-row">${raw}</div>` : ''}
  </div>`;
}

const RARITY_COLOR = { None: '#7d766a', Common: '#9aa0a6', Uncommon: '#6ab04c', Rare: '#4a90c2', 'Very Rare': '#b06ac9' };
function openItem(slug) {
  const it = S.items.find(i => i.slug === slug); if (!it) return;
  const rc = RARITY_COLOR[it.rarity] || '#7d766a';
  let techInfo = null;
  if (S.tech) for (const t of S.tech.trees) { const n = t.nodes.find(x => x.id === it.image_id); if (n) { techInfo = { level: t.level, label: t.label || ('WB' + t.level), total: techUnlockCost(t, it.image_id), cost: n.cost }; break; } }
  const wikiPath = S.wiki ? S.wiki.aliases[it.name.toLowerCase()] : null;
  openSheet(`
    <div class="grabber"></div>
    <div class="detail-head">
      <img src="/island/apps/rust/${esc(it.image)}" alt="" onerror="this.style.visibility='hidden'" />
      <div style="flex:1"><h2>${esc(it.name)}</h2>
        <span class="badge" style="background:${rc}22;color:${rc};border:1px solid ${rc}55">${esc(it.rarity || 'None')}</span>
      </div>
      <button class="pin-btn ${favHas(it.slug) ? 'on' : ''}" id="pinBtn" aria-label="Pin item">${favHas(it.slug) ? '&#9733;' : '&#9734;'}</button>
    </div>
    <p class="detail-desc">${esc(it.description) || '<span style="color:var(--txt3)">No in-game description.</span>'}</p>
    <div class="kv">
      <span class="tag"><b>Category:</b> ${esc(it.category)}</span>
      <span class="tag copybtn" id="copySn"><b>Shortname:</b> ${esc(it.shortname)} &#128203;</span>
      ${it.stackable && it.stackable > 1 ? `<span class="tag"><b>Stack:</b> ${it.stackable}</span>` : ''}
    </div>
    <div class="detail-links">
      ${wikiPath ? `<div class="dl" data-wikigo="${esc(wikiPath)}">Full guide &amp; stats in Wiki <span class="arw">&#128214;</span></div>` : ''}
      ${techInfo ? `<div class="dl" data-tech="${techInfo.level}" data-techname="${esc(it.name)}">In Tech Tree — <b style="color:var(--amber)">${esc(techInfo.label)}</b> · ${techInfo.total.toLocaleString()} scrap to unlock <span class="arw">&#127993;</span></div>` : ''}
      <a class="dl" href="https://rusthelp.com/items/${esc(it.slug)}" target="_blank" rel="noopener">View full stats on RustHelp <span class="arw">&#8599;</span></a>
      ${it.category === 'Component' ? `<div class="dl" data-goto="recycle">Recycle yield <span class="arw">&#9851;</span></div>` : ''}
    </div>
    ${buildCraftHtml(it.slug)}`);
  $('#copySn').addEventListener('click', function () {
    navigator.clipboard?.writeText(it.shortname); this.classList.add('copied'); this.innerHTML = `<b>Copied!</b> ${esc(it.shortname)}`;
  });
  $('#pinBtn').addEventListener('click', function () {
    favToggle(it.slug); const on = favHas(it.slug);
    this.classList.toggle('on', on); this.innerHTML = on ? '&#9733;' : '&#9734;';
    if (S.view === 'items') renderFavStrip();
  });
  const gt = $('[data-goto]'); if (gt) gt.addEventListener('click', () => { closeSheet(); go('recycle'); });
  const wg = $('[data-wikigo]'); if (wg) wg.addEventListener('click', () => { closeSheet(); S.wikiPage = null; go('wiki'); openWiki(wg.dataset.wikigo); });
  const tt = $('[data-tech]'); if (tt) tt.addEventListener('click', () => {
    const lv = +tt.dataset.tech, nm = tt.dataset.techname;
    closeSheet(); S.techLevel = lv; go('tech');
    setTimeout(() => { const q = $('#ttq'); if (q) { q.value = nm; techSearch(nm); } }, 60);
  });
  sheetBody.querySelectorAll('.ci[data-slug]').forEach(c => c.addEventListener('click', () => openItem(c.dataset.slug)));
}

// ================= TECH TREE =================
const TT = { F: 0.45, TILE: 46, PAD: 30, ZMIN: 0.3, ZMAX: 2.5 }; // scale of real in-game coords, node size, padding, zoom clamp
const PINCH = { pts: new Map(), startDist: 0 }; // active pointer tracking for pinch-zoom on #ttWrap
function techKey(level) { return 'rc_tech_wb' + level; }
// Total scrap to research an item AND every prerequisite it needs (inclusive) — matches the research counter.
function techUnlockCost(tree, id) {
  const byId = tree._byId || (tree._byId = Object.fromEntries(tree.nodes.map(n => [n.id, n])));
  const seen = new Set(); let s = 0; const st = [id];
  while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); const n = byId[x]; if (!n) continue; s += n.cost; (n.inputs || []).forEach(p => st.push(p)); }
  return s;
}
function techSet(level) { try { return new Set(JSON.parse(localStorage.getItem(techKey(level)) || '[]')); } catch (e) { return new Set(); } }
function techSave(level, set) { try { localStorage.setItem(techKey(level), JSON.stringify([...set])); } catch (e) {} }

function viewTech() {
  const T = S.tech;
  if (!T) return waitFor('tech', viewTech, 'tech tree');
  ttFsReset(); // rebuilding the view - any prior fullscreen frame is about to be destroyed
  const level = S.techLevel || 1;
  const tree = T.trees.find(t => t.level === level) || T.trees[0];
  const mode = S.techMode || 'research';
  app.innerHTML = `
    <div class="view-title">Tech Tree</div>
    <div class="view-sub">The real in-game Workbench research trees. Tap a node to research it &amp; everything it needs — your progress saves for the wipe.</div>
    <div class="seg" id="wbSeg">
      ${T.trees.map(t => `<button data-lv="${t.level}" class="${t.level === level ? 'on' : ''}">${esc(t.label || ('WB' + t.level))} <span style="opacity:.6">(${t.count})</span></button>`).join('')}
    </div>
    <div class="tt-bar">
      <div class="tt-stat" id="ttStat"></div>
      <div class="tt-modes">
        <button class="tt-mode ${mode === 'research' ? 'on' : ''}" data-mode="research">Research</button>
        <button class="tt-mode ${mode === 'inspect' ? 'on' : ''}" data-mode="inspect">Inspect</button>
        <button class="tt-mode reset" id="ttReset">Reset</button>
      </div>
    </div>
    <div class="search" style="margin-bottom:10px"><span>&#128269;</span><input id="ttq" placeholder="Find an item in this tree (e.g. AK)…" autocomplete="off"/></div>
    <div class="tt-frame" id="ttFrame">
      <div class="tt-titleblock">
        <span class="tt-tb-name">${esc(tree.name || tree.label || ('Workbench ' + level))}</span>
        <span class="tt-tb-meta">SCHEMATIC &middot; ${tree.count} NODES</span>
      </div>
      <div class="tt-stage">
        <div class="tt-canvas-wrap" id="ttWrap"><div class="tt-sizer" id="ttSizer"><div class="tt-canvas" id="ttCanvas"></div></div></div>
        <div class="tt-controls" id="ttControls">
          <button class="tt-ctrl" id="ttZoomIn" aria-label="Zoom in">+</button>
          <span class="tt-zoom-lbl" id="ttZoomLbl">100%</span>
          <button class="tt-ctrl" id="ttZoomOut" aria-label="Zoom out">&minus;</button>
          <button class="tt-ctrl" id="ttZoomReset" aria-label="Reset zoom">1:1</button>
          <button class="tt-ctrl" id="ttFull" aria-label="Enter fullscreen">&#9974;</button>
        </div>
      </div>
    </div>
    <div class="tt-legend">
      <span><i class="dot done"></i> Researched</span>
      <span><i class="dot avail"></i> Available</span>
      <span><i class="dot locked"></i> Locked (needs a prereq)</span>
    </div>
    <div class="credit">Exact node layout, costs &amp; prerequisites from rusthelp.com. Research cost by rarity: 15 / 30 / 60 / 120 scrap.</div>`;
  renderTree(tree, level);
  $('#wbSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.techLevel = +b.dataset.lv; viewTech(); } });
  $$('.tt-mode[data-mode]').forEach(b => b.addEventListener('click', () => { S.techMode = b.dataset.mode; $$('.tt-mode[data-mode]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#ttReset').addEventListener('click', () => {
    if (confirm(`Reset all ${tree.label || ('WB' + level)} research progress?`)) { techSave(level, new Set()); renderTree(tree, level); }
  });
  const q = $('#ttq');
  q.addEventListener('input', () => techSearch(q.value));
  bindTtControls();
}

function renderTree(tree, level) {
  const byId = {}; tree.nodes.forEach(n => byId[n.id] = n);
  tree._byId = byId;
  const { F, TILE, PAD } = TT;
  const W = (tree.maxX - tree.minX) * F + PAD * 2 + TILE;
  const H = (tree.maxY - tree.minY) * F + PAD * 2 + TILE;
  const px = n => (n.x - tree.minX) * F + PAD;
  const py = n => (n.y - tree.minY) * F + PAD;
  const c = TILE / 2;
  // edges
  let edges = '';
  tree.nodes.forEach(n => (n.inputs || []).forEach(pid => {
    const p = byId[pid]; if (!p) return;
    edges += `<line class="tt-edge" data-child="${esc(n.id)}" data-parent="${esc(pid)}" x1="${px(p) + c}" y1="${py(p) + c}" x2="${px(n) + c}" y2="${py(n) + c}"/>`;
  }));
  // nodes
  const nodes = tree.nodes.map(n =>
    `<button class="tt-node" data-id="${esc(n.id)}" style="left:${px(n)}px;top:${py(n)}px;width:${TILE}px;height:${TILE}px" title="${esc(n.name)} — ${n.cost} scrap">
      <img loading="lazy" src="/island/apps/rust/img/items/${esc(n.id)}.webp" alt="${esc(n.name)}" onerror="this.style.visibility='hidden'"/>
      <span class="tt-cost">${n.cost}</span>
    </button>`).join('');
  const canvas = $('#ttCanvas');
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  canvas.innerHTML = `<svg class="tt-edges" width="${W}" height="${H}">${edges}</svg>${nodes}`;
  // interactions
  canvas.querySelectorAll('.tt-node').forEach(el => {
    el.addEventListener('click', () => {
      if ((S.techMode || 'research') === 'inspect') { const n = byId[el.dataset.id]; if (n && n.slug) openItem(n.slug); return; }
      toggleNode(tree, level, el.dataset.id); updateTree(tree, level);
    });
  });
  applyZoom(S.ttZoom || 1); // logical W/H just changed - resize the sizer + reapply the transform
  updateTree(tree, level);
}

// ---- zoom (pinch + buttons), applied via CSS transform so nodes never re-render ----
function ttZoomClamp(z) { return Math.max(TT.ZMIN, Math.min(TT.ZMAX, z)); }
function applyZoom(z) {
  z = ttZoomClamp(z);
  S.ttZoom = z;
  const canvas = $('#ttCanvas'), sizer = $('#ttSizer');
  if (!canvas || !sizer) return;
  const W = parseFloat(canvas.style.width) || 0, H = parseFloat(canvas.style.height) || 0;
  sizer.style.width = (W * z) + 'px';
  sizer.style.height = (H * z) + 'px';
  canvas.style.transform = `scale(${z})`;
  const lbl = $('#ttZoomLbl'); if (lbl) lbl.textContent = Math.round(z * 100) + '%';
}
// zoom to newZ while keeping the viewport point (clientX,clientY) visually stable
function ttZoomAt(newZ, clientX, clientY) {
  const wrap = $('#ttWrap'); if (!wrap) return;
  const oldZ = S.ttZoom || 1;
  newZ = ttZoomClamp(newZ);
  if (newZ === oldZ) return;
  const rect = wrap.getBoundingClientRect();
  const localX = (clientX - rect.left) + wrap.scrollLeft;
  const localY = (clientY - rect.top) + wrap.scrollTop;
  const ratio = newZ / oldZ;
  applyZoom(newZ);
  wrap.scrollLeft = localX * ratio - (clientX - rect.left);
  wrap.scrollTop = localY * ratio - (clientY - rect.top);
}
function ttZoomWrapCenter() {
  const wrap = $('#ttWrap'); const rect = wrap.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
function ttZoomStep(delta) { const a = ttZoomWrapCenter(); ttZoomAt((S.ttZoom || 1) + delta, a.x, a.y); }
function ttZoomTo(z) { const a = ttZoomWrapCenter(); ttZoomAt(z, a.x, a.y); }

// ---- fullscreen (CSS-class toggle, not the Fullscreen API - iOS Safari has no element fullscreen) ----
function ttFsReset() { document.body.classList.remove('tt-fs-lock'); }
function ttToggleFullscreen(force) {
  const frame = $('#ttFrame'); if (!frame) return;
  const on = typeof force === 'boolean' ? force : !frame.classList.contains('tt-fullscreen');
  frame.classList.toggle('tt-fullscreen', on);
  document.body.classList.toggle('tt-fs-lock', on);
  const btn = $('#ttFull');
  if (btn) { btn.innerHTML = on ? '&times;' : '&#9974;'; btn.classList.toggle('on', on); btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen'); }
}

// ---- pinch-zoom (two-pointer tracking on #ttWrap) ----
function ttPointerDown(e) {
  PINCH.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (PINCH.pts.size === 2) {
    const [a, b] = [...PINCH.pts.values()];
    PINCH.startDist = Math.hypot(a.x - b.x, a.y - b.y);
    const wrap = $('#ttWrap'); if (wrap) wrap.style.touchAction = 'none'; // stop native scroll while pinching
  }
}
function ttPointerMove(e) {
  if (!PINCH.pts.has(e.pointerId)) return;
  PINCH.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (PINCH.pts.size === 2 && PINCH.startDist > 0) {
    e.preventDefault();
    const [a, b] = [...PINCH.pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    // re-anchor each move so the CURRENT pinch midpoint stays visually stable
    ttZoomAt((S.ttZoom || 1) * (dist / PINCH.startDist), midX, midY);
    PINCH.startDist = dist;
  }
}
function ttPointerEnd(e) {
  PINCH.pts.delete(e.pointerId);
  if (PINCH.pts.size < 2) {
    PINCH.startDist = 0;
    const wrap = $('#ttWrap'); if (wrap) wrap.style.touchAction = 'pan-x pan-y';
  }
}
function bindTtControls() {
  const wrap = $('#ttWrap'); if (!wrap) return;
  PINCH.pts.clear(); PINCH.startDist = 0;
  $('#ttZoomIn').addEventListener('click', () => ttZoomStep(0.25));
  $('#ttZoomOut').addEventListener('click', () => ttZoomStep(-0.25));
  $('#ttZoomReset').addEventListener('click', () => ttZoomTo(1));
  $('#ttFull').addEventListener('click', () => ttToggleFullscreen());
  wrap.addEventListener('pointerdown', ttPointerDown);
  wrap.addEventListener('pointermove', ttPointerMove);
  wrap.addEventListener('pointerup', ttPointerEnd);
  wrap.addEventListener('pointercancel', ttPointerEnd);
  // NOT pointerleave: on a pinch-to-zoom-out the fingers spread past the frame
  // edge, which fired pointerleave and killed the gesture mid-pinch (the pointer
  // was dropped from PINCH.pts, so every later pointermove for it bailed out and
  // the zoom froze until both fingers were lifted). pointerup/pointercancel are
  // enough - the browser always delivers one of them for a real touch.
  wrap.addEventListener('lostpointercapture', ttPointerEnd);
}

function toggleNode(tree, level, id) {
  const set = techSet(level), byId = tree._byId;
  if (set.has(id)) { // remove it + all descendants
    const stack = [id];
    while (stack.length) { const x = stack.pop(); if (set.has(x)) { set.delete(x); ((byId[x] && byId[x].outputs) || []).forEach(o => stack.push(o)); } }
  } else { // add it + all prerequisite ancestors
    const stack = [id];
    while (stack.length) { const x = stack.pop(); if (!set.has(x)) { set.add(x); ((byId[x] && byId[x].inputs) || []).forEach(i => stack.push(i)); } }
  }
  techSave(level, set);
}

function updateTree(tree, level) {
  const set = techSet(level), byId = tree._byId;
  const canvas = $('#ttCanvas'); if (!canvas) return;
  let spent = 0;
  canvas.querySelectorAll('.tt-node').forEach(el => {
    const n = byId[el.dataset.id]; if (!n) return;
    const done = set.has(n.id);
    const avail = done || (n.inputs || []).every(i => set.has(i));
    el.classList.toggle('done', done);
    el.classList.toggle('avail', !done && avail);
    el.classList.toggle('locked', !done && !avail);
    if (done) spent += n.cost;
  });
  canvas.querySelectorAll('.tt-edge').forEach(l => {
    l.classList.toggle('on', set.has(l.dataset.child) && set.has(l.dataset.parent));
  });
  const total = tree.nodes.reduce((a, n) => a + n.cost, 0);
  const cnt = tree.nodes.filter(n => set.has(n.id)).length;
  const st = $('#ttStat');
  if (st) st.innerHTML = `<b>${cnt}</b>/${tree.count} researched · <b class="scrap">${spent.toLocaleString()}</b> scrap spent <span style="color:var(--txt3)">/ ${total.toLocaleString()} full tree</span>`;
}

function techSearch(q) {
  q = norm(q).trim();
  const canvas = $('#ttCanvas'), wrap = $('#ttWrap'); if (!canvas) return;
  const z = S.ttZoom || 1;
  let first = null;
  canvas.querySelectorAll('.tt-node').forEach(el => {
    const nm = norm(el.querySelector('img').alt);
    const hit = q && nm.includes(q);
    el.classList.toggle('hit', hit);
    el.classList.toggle('dim', q && !hit);
    if (hit && !first) first = el;
  });
  // el.offsetLeft/Top are logical (pre-transform) coords - scale by zoom to land in the
  // sizer's visual space, which is what wrap.scrollTo actually scrolls against.
  if (first) wrap.scrollTo({ left: first.offsetLeft * z - wrap.clientWidth / 2 + (TT.TILE / 2) * z, top: first.offsetTop * z - wrap.clientHeight / 2 + (TT.TILE / 2) * z, behavior: 'smooth' });
}

// ================= RAID =================
function viewRaid() {
  const R = S.raid;
  if (!R) return waitFor('raid', viewRaid, 'raid data');
  const spb = R.sulfurPerBoom, lab = R.labels;
  const groups = [...new Set(R.targets.map(t => t.group))];
  app.innerHTML = `
    <div class="view-title">Raid Calculator</div>
    <div class="view-sub">How much boom &amp; raw sulfur to break anything. Cheapest option highlighted.</div>
    <div class="note"><b>Since Common Ground (Jul 2026):</b> on <b>Softcore</b> servers, building blocks &amp; doors are only breakable in the <b>6PM–9PM local raid window</b> (protection needs an active TC that's ≥1h old). Vanilla &amp; Hardcore raid 24/7. Deployables and fresh/unprotected TCs are always vulnerable. Raid <b>costs</b> below are unchanged by this patch.</div>
    <div id="raidPlan"></div>
    <div class="searchwrap"><div class="search"><span>&#128269;</span><input id="rq" placeholder="Filter targets (e.g. sheet door)…" autocomplete="off"/></div></div>
    <div id="raidList"></div>
    <div class="panel">
      <h3>&#128665; Bradley APC</h3>
      <p>${esc(R.bradley.note)} — <b>${R.bradley.hp} HP</b></p>
      <div class="scrollx"><table class="t"><thead><tr><th>Method</th><th>Count</th><th>Why</th></tr></thead><tbody>
      ${R.bradley.methods.map(m => `<tr><td><b>${esc(m.method)}</b></td><td>${esc(m.count)}</td><td style="color:var(--txt2)">${esc(m.why)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
    <div class="panel">
      <h3>&#129513; Sulfur per explosive</h3>
      <div class="rt-methods">${Object.keys(spb).map(k => `<span class="rt-m"><b>${lab[k]}</b> <span class="s">${spb[k].toLocaleString()} sulf</span></span>`).join('')}</div>
    </div>
    <div class="credit">Raid numbers from the Fiiiish Island vault, cross-checked vs rusthelp.</div>`;
  const render = (q = '') => {
    q = norm(q).trim();
    const list = R.targets.filter(t => !q || norm(t.name).includes(q) || norm(t.group).includes(q));
    $('#raidList').innerHTML = groups.map(g => {
      const ts = list.filter(t => t.group === g); if (!ts.length) return '';
      return `<h3 style="margin:14px 2px 8px;color:var(--txt2);font-size:13px;text-transform:uppercase;letter-spacing:.5px">${esc(g)}</h3>` +
        ts.map(t => raidCard(t, spb, lab)).join('');
    }).join('') || `<div class="empty">No targets match.</div>`;
  };
  $('#rq').addEventListener('input', e => render(e.target.value));
  render();
  renderRaidPlan();
  $('#raidList').addEventListener('click', e => {
    const b = e.target.closest('.rt-add'); if (!b) return;
    raidCartAdd(b.dataset.add); renderRaidPlan();
    const p = $('#raidPlan'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}
function raidCard(t, spb, lab) {
  const methods = Object.keys(t.costs).map(k => ({ k, n: t.costs[k], sulf: t.costs[k] * (spb[k] || 0) }))
    .filter(m => m.sulf > 0);
  const min = methods.length ? Math.min(...methods.map(m => m.sulf)) : 0;
  const chips = Object.keys(t.costs).map(k => {
    const n = t.costs[k], sulf = n * (spb[k] || 0);
    const best = sulf === min && sulf > 0;
    return `<span class="rt-m ${best ? 'best' : ''}"><b>${n}× ${lab[k]}</b>${sulf ? ` <span class="s">${sulf.toLocaleString()} sulf</span>` : ''}</span>`;
  }).join('');
  return `<div class="rt-card">
    <div class="rt-head"><span class="nm">${esc(t.name)}</span><span class="rt-right"><span class="hp">${t.hp} HP</span><button class="rt-add" data-add="${esc(t.name)}" aria-label="Add to raid plan">+ Plan</button></span></div>
    <div class="rt-methods">${chips}</div>
    <div class="rt-note">${esc(t.note || '')}</div>
  </div>`;
}

// ---- raid multi-target planner ----
function raidCart() { try { return JSON.parse(localStorage.getItem('rc_raidcart') || '{}'); } catch (e) { return {}; } }
function raidCartSave(c) { try { localStorage.setItem('rc_raidcart', JSON.stringify(c)); } catch (e) {} }
function raidCartAdd(name, d = 1) { const c = raidCart(); c[name] = Math.max(0, (c[name] || 0) + d); if (!c[name]) delete c[name]; raidCartSave(c); }
function raidCheapest(t, spb) {
  let best = null;
  for (const k in t.costs) { const s = t.costs[k] * (spb[k] || 0); if (s > 0 && (!best || s < best.sulfur)) best = { key: k, count: t.costs[k], sulfur: s }; }
  return best;
}
function renderRaidPlan() {
  const R = S.raid, el = $('#raidPlan'); if (!el || !R) return;
  const cart = raidCart(), names = Object.keys(cart);
  if (!names.length) { el.innerHTML = `<div class="plan-empty">&#128203; Tap <b>+ Plan</b> on any target below to build a raid list — get the total boom &amp; sulfur to farm.</div>`; return; }
  const spb = R.sulfurPerBoom, lab = R.labels;
  let totSulfur = 0; const expl = {}; const rows = [];
  names.forEach(nm => {
    const t = R.targets.find(x => x.name === nm); if (!t) return;
    const q = cart[nm], c = raidCheapest(t, spb); if (!c) return;
    totSulfur += c.sulfur * q; expl[c.key] = (expl[c.key] || 0) + c.count * q;
    rows.push({ nm, q, c });
  });
  const shop = Object.keys(expl).sort((a, b) => expl[b] * spb[b] - expl[a] * spb[a]).map(k => `<span class="rt-m best"><b>${expl[k]}× ${lab[k]}</b></span>`).join(' ');
  const charcoal = Math.round(totSulfur * 1.5);
  el.innerHTML = `<div class="panel plan">
    <h3>&#128736;&#65039; Raid Plan <button class="plan-clear" id="planClear">clear</button></h3>
    ${rows.map(r => `<div class="plan-row">
      <span class="pn">${esc(r.nm)}</span>
      <span class="pq"><button data-dec="${esc(r.nm)}">&minus;</button><b>${r.q}</b><button data-inc="${esc(r.nm)}">+</button></span>
      <span class="ps">${(r.c.sulfur * r.q).toLocaleString()} <span style="color:var(--txt3)">sulf</span><br><span style="color:var(--txt3);font-size:11px">${r.q * r.c.count}× ${lab[r.c.key]}</span></span>
    </div>`).join('')}
    <div class="plan-tot">
      <div class="ptl">Total boom</div><div class="ptr">${shop}</div>
      <div class="ptl">Raw sulfur to farm</div><div class="ptr"><b class="scrap" style="font-size:16px">${totSulfur.toLocaleString()}</b></div>
      <div class="ptl">Charcoal (approx)</div><div class="ptr">~${charcoal.toLocaleString()}</div>
    </div>
  </div>`;
  el.querySelector('#planClear').addEventListener('click', () => { raidCartSave({}); renderRaidPlan(); });
  el.querySelectorAll('[data-inc]').forEach(b => b.addEventListener('click', () => { raidCartAdd(b.dataset.inc, 1); renderRaidPlan(); }));
  el.querySelectorAll('[data-dec]').forEach(b => b.addEventListener('click', () => { raidCartAdd(b.dataset.dec, -1); renderRaidPlan(); }));
}

// ================= RECYCLE =================
function viewRecycle() {
  const R = S.recycle;
  if (!R) return waitFor('recycle', viewRecycle, 'recycle data');
  const col = S.recycMode;
  const rowsC = R.components.map(c => `<tr><td><b>${esc(c.name)}</b>${c.keep ? `<div style="color:var(--amber);font-size:11px">${esc(c.keep)}</div>` : ''}</td><td>${esc(c[col])}</td></tr>`).join('');
  const rowsM = R.materials.map(c => `<tr><td><b>${esc(c.name)}</b>${c.keep ? `<div style="color:var(--amber);font-size:11px">${esc(c.keep)}</div>` : ''}</td><td>${esc(c[col])}</td></tr>`).join('');
  app.innerHTML = `
    <div class="view-title">Recycle Yields</div>
    <div class="view-sub">What every component breaks down into.</div>
    <div class="seg">
      <button data-m="monument" class="${col === 'monument' ? 'on' : ''}">Monument (+20%)</button>
      <button data-m="safezone" class="${col === 'safezone' ? 'on' : ''}">Safe-zone (−20%)</button>
    </div>
    <div class="note">${esc(R.note)}</div>
    <div class="panel"><h3>&#9881; Components</h3><div class="scrollx"><table class="t"><thead><tr><th>Component</th><th>Yields</th></tr></thead><tbody>${rowsC}</tbody></table></div></div>
    <div class="panel"><h3>&#129522; Materials &amp; junk</h3><div class="scrollx"><table class="t"><thead><tr><th>Item</th><th>Yields</th></tr></thead><tbody>${rowsM}</tbody></table></div></div>
    <div class="credit">Yields from the Fiiiish Island vault (pinned vs rusthelp, 2026).</div>`;
  $$('.seg button').forEach(b => b.addEventListener('click', () => { S.recycMode = b.dataset.m; viewRecycle(); }));
}

// ================= FARM (genetics god-clone helper) =================
function viewFarm() {
  app.innerHTML = `
    <div class="view-title">&#127793; Plant Genetics — God Clone Helper</div>
    <div class="view-sub">Scan your seeds from the game, or type them, then predict the crossbreed and lock in a god seed.</div>

    <div class="panel scan-panel">
      <h3>&#128248; Scan genes from the game <span class="scan-pc">PC browser</span></h3>
      <p id="scanIntro">Click <b>Start scan</b>, share your <b>Rust window</b>, then hover each seed/plant in-game so its genes show on screen — they get read automatically. (Best at 1920&times;1080, UI scale 1.)</p>
      <div id="scanUnsupported" hidden><div class="note">Screen-scan needs a <b>desktop browser</b> with the Rust window visible. On your phone, type genes below instead.</div></div>
      <div class="scan-controls">
        <button class="btn" id="scanStart">Start scan</button>
        <button class="btn ghost" id="scanStop" hidden>Stop scan</button>
      </div>
      <div id="scanStatus" class="scan-status"></div>
      <video id="scanVid" playsinline muted hidden></video>
      <div id="genePool"></div>
    </div>

    <div class="panel">
      <h3>The 6 gene types</h3>
      <div class="gene-legend">
        <span class="gpill g-good">G · Growth (faster)</span>
        <span class="gpill g-good">Y · Yield (more crop / +clones)</span>
        <span class="gpill g-good">H · Hardiness</span>
        <span class="gpill g-bad">W · Water (bad — drains tank)</span>
        <span class="gpill g-bad">X · Empty (bad — wasted slot)</span>
      </div>
      <p>Every plant has <b>6 gene slots</b>. Target a <b>god seed</b> like <b>GGGGYY</b>, <b>GGGYYY</b> or <b>YYYYGG</b>. Green genes vote with weight <b>0.6</b>; red (W/X) dominate at <b>1.0</b> — so you need <b>2+ greens stacked</b> on a slot to overpower one red.</p>
    </div>

    <div class="panel">
      <h3>Crossbreed predictor</h3>
      <p>Enter the genes of the plants you'll place in a <b>Large Planter (3×3)</b>. Each box = 6 letters (G/Y/H/W/X). Leave cells blank to ignore. The center is what you're breeding <b>into</b>.</p>
      <div class="gene-grid" id="geneGrid">
        ${Array.from({ length: 9 }, (_, i) => `<div class="gene-cell ${i === 4 ? 'center' : ''}"><input maxlength="6" placeholder="${i === 4 ? 'CENTER' : '——————'}" data-i="${i}" /></div>`).join('')}
      </div>
      <button class="btn" id="calcGene">Predict crossbreed result</button>
      <div id="geneResult" style="margin-top:14px"></div>
    </div>

    <div class="panel">
      <h3>&#129516; Cloning &amp; the loop</h3>
      <p>Clones taken at the <b>Sapling stage</b> are genetically identical to the parent — that's how you mass-produce a god seed. Every <b>2 Y genes = +1 extra clone</b>. Berries/hemp give 3 base clones, food crops 2.</p>
      <p><b>The loop:</b> plant ~20 random seeds → keep any 5/6-green → use the predictor to place them → clone the winner → never touch random seeds again.</p>
    </div>
    <div class="credit">Genetics model from the Fiiiish Island vault (plant-genetics.md).</div>`;

  $('#calcGene').addEventListener('click', predictGenes);
  $$('#geneGrid input').forEach(inp => inp.addEventListener('input', () => {
    inp.value = inp.value.toUpperCase().replace(/[^GYHWX]/g, '');
  }));
  // scanner
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
    $('#scanUnsupported').hidden = false; $('#scanStart').disabled = true; $('#scanIntro').hidden = true;
  }
  $('#scanStart').addEventListener('click', scanStart);
  $('#scanStop').addEventListener('click', scanStop);
  renderGenePool();
}

// ---- genetics screen-scan (Screen Capture API + Tesseract.js OCR) ----
const GENE = { stream: null, worker: null, timer: null, busy: false };
S.genePool = S.genePool || [];
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Could not load the OCR engine (needs internet the first time).'));
    document.head.appendChild(s);
  });
}
async function scanStart() {
  const status = $('#scanStatus');
  try {
    status.textContent = 'Loading OCR engine…';
    await loadTesseract();
    status.textContent = 'Select your Rust window to share…';
    GENE.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 4 }, audio: false });
    GENE.stream.getVideoTracks()[0].addEventListener('ended', scanStop);
    const vid = $('#scanVid'); vid.srcObject = GENE.stream; await vid.play();
    if (!GENE.worker) { GENE.worker = await Tesseract.createWorker('eng'); }
    $('#scanStart').hidden = true; $('#scanStop').hidden = false;
    status.innerHTML = '<b style="color:var(--green)">Scanning…</b> hover your seeds in-game. Detected genes appear below.';
    GENE.timer = setInterval(scanTick, 1400);
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">${esc(e.message || 'Scan cancelled.')}</span>`;
    scanStop();
  }
}
function scanStop() {
  if (GENE.timer) { clearInterval(GENE.timer); GENE.timer = null; }
  if (GENE.stream) { GENE.stream.getTracks().forEach(t => t.stop()); GENE.stream = null; }
  const st = $('#scanStart'), sp = $('#scanStop'); if (st) st.hidden = false; if (sp) sp.hidden = true;
}
async function scanTick() {
  if (GENE.busy || !GENE.stream) return; GENE.busy = true;
  try {
    const vid = $('#scanVid'); if (!vid || !vid.videoWidth) { GENE.busy = false; return; }
    const cv = document.createElement('canvas'); cv.width = vid.videoWidth; cv.height = vid.videoHeight;
    const cx = cv.getContext('2d'); cx.drawImage(vid, 0, 0);
    // grayscale + threshold to help OCR on the gene text
    const img = cx.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = (d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11) > 140 ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
    cx.putImageData(img, 0, 0);
    const { data: { text } } = await GENE.worker.recognize(cv);
    // gene tokens = 6 letters from GYHWX, standalone (word-boundary) so real words aren't matched
    const found = (text.toUpperCase().match(/\b[GYHWX]{6}\b/g) || []);
    let added = 0;
    found.forEach(g => { if (!S.genePool.includes(g)) { S.genePool.push(g); added++; } });
    if (added) renderGenePool();
  } catch (e) { /* keep scanning */ }
  GENE.busy = false;
}
function geneQuality(g) { return [...g].filter(c => 'GYH'.includes(c)).length; }
function renderGenePool() {
  const el = $('#genePool'); if (!el) return;
  const pool = S.genePool;
  if (!pool.length) { el.innerHTML = ''; return; }
  const sorted = [...pool].sort((a, b) => geneQuality(b) - geneQuality(a));
  el.innerHTML = `
    <div class="pool-head"><b>${pool.length}</b> plant${pool.length > 1 ? 's' : ''} scanned <button class="pool-clear" id="poolClear">clear</button></div>
    <div class="pool-chips">${sorted.map(g => `<span class="pool-chip q${Math.min(geneQuality(g), 6)}">${[...g].map(c => `<i class="${'GYH'.includes(c) ? 'gg' : 'gb'}">${c}</i>`).join('')}<button data-del="${g}">&times;</button></span>`).join('')}</div>
    <button class="btn" id="poolUse">Load best into the predictor &amp; analyze</button>
    <div id="geneReco"></div>`;
  el.querySelector('#poolClear').addEventListener('click', () => { S.genePool = []; renderGenePool(); });
  el.querySelector('#poolUse').addEventListener('click', usePoolInPredictor);
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { S.genePool = S.genePool.filter(x => x !== b.dataset.del); renderGenePool(); }));
}
function usePoolInPredictor() {
  const sorted = [...S.genePool].sort((a, b) => geneQuality(b) - geneQuality(a)).slice(0, 9);
  const inputs = $$('#geneGrid input');
  inputs.forEach((inp, i) => inp.value = sorted[i] || '');
  predictGenes();
  // recommendation
  const reco = $('#geneReco'); const best = sorted[0] || '';
  const pooledSlots = [];
  for (let s = 0; s < 6; s++) pooledSlots.push(new Set(S.genePool.map(g => g[s]).filter(c => 'GY'.includes(c))));
  const godReachable = pooledSlots.every(set => set.size > 0);
  reco.innerHTML = `<div class="note" style="margin-top:12px">
    Best scanned plant: <b>${best ? [...best].map(c => `<span class="${'GYH'.includes(c) ? 'gtxt' : 'btxt'}">${c}</span>`).join('') : '—'}</b> (${best ? geneQuality(best) : 0}/6 green).
    ${godReachable ? '&#9989; A <b>pure-G/Y god seed is reachable</b> from this pool — every slot has a green option across your plants. Grid loaded above; keep crossbreeding toward it.' : '&#9888;&#65039; Not yet a full god seed — some slots have <b>no G/Y</b> in any scanned plant. Scan more seeds (aim for 5/6-green keepers) to fill the gaps.'}
  </div>`;
  $('#geneReco').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function predictGenes() {
  const plants = $$('#geneGrid input').map(i => i.value.trim().toUpperCase()).filter(v => v.length === 6);
  const res = $('#geneResult');
  if (plants.length < 2) { res.innerHTML = `<div class="note">Enter at least 2 full 6-letter plants to predict a result.</div>`; return; }
  const W = { G: 0.6, Y: 0.6, H: 0.6, W: 1.0, X: 1.0 };
  const out = [];
  for (let slot = 0; slot < 6; slot++) {
    const votes = {};
    plants.forEach(p => { const g = p[slot]; votes[g] = (votes[g] || 0) + W[g]; });
    let win = null, best = -1, tie = false;
    for (const g in votes) { if (votes[g] > best) { best = votes[g]; win = g; tie = false; } else if (votes[g] === best) tie = true; }
    out.push({ g: win, tie, good: 'GYH'.includes(win) });
  }
  const yCount = out.filter(o => o.g === 'Y').length;
  const clones = 3 + Math.floor(yCount / 2);
  // A "god seed" is all-green with NO Hardiness/Water/Empty — pure G/Y (matches GGGGYY, GGGYYY, YYYYGG).
  const allGood = out.every(o => o.good);
  const isGod = out.every(o => o.g === 'G' || o.g === 'Y');
  res.innerHTML = `
    <div style="text-align:center;color:var(--txt2);font-size:12px;margin-bottom:4px">Predicted center genes (most-likely per slot)</div>
    <div class="result-genes">${out.map(o => `<div class="gslot ${o.good ? 'win' : 'lose'}${o.tie ? ' tie' : ''}">${o.g}</div>`).join('')}</div>
    <div class="note" style="text-align:center">
      ${isGod ? '&#127942; <b>God seed!</b> Pure G/Y — clone it now.' : allGood ? '&#9989; All-green result — strong seed. Clone it.' : '&#9888;&#65039; Reds present — reposition plants so 2+ greens stack on each red slot.'}
      <div style="margin-top:6px;color:var(--txt2)">Yield genes: <b>${yCount}</b> → <b>${clones} clones</b> per cloning (berries/hemp base 3). Each slot is a <b>weighted random</b> draw — greens just tilt the odds; grey = a coin-flip tie.</div>
    </div>`;
}

// ================= WIKI (offline vault knowledge base) =================
const WIKI_FOLDERS = [
  { k: 'getting-started', n: 'Getting Started', i: '&#129517;' }, { k: 'monuments', n: 'Monuments', i: '&#127981;' },
  { k: 'pvp', n: 'PvP & Weapons', i: '&#128299;' }, { k: 'raiding', n: 'Raiding', i: '&#128163;' },
  { k: 'building', n: 'Building', i: '&#129521;' }, { k: 'crafting', n: 'Crafting', i: '&#128296;' },
  { k: 'economy', n: 'Economy & Scrap', i: '&#9851;' }, { k: 'electricity', n: 'Electricity', i: '&#9889;' },
  { k: 'farming', n: 'Farming & Food', i: '&#127793;' }, { k: 'events', n: 'Events & PvE', i: '&#128641;' },
  { k: 'vehicles', n: 'Vehicles', i: '&#128663;' }, { k: 'keycards', n: 'Keycards', i: '&#128273;' },
  { k: 'guides', n: 'Strategy Guides', i: '&#128218;' }, { k: 'meta', n: 'Meta', i: '&#128202;' },
  { k: 'reference', n: 'Reference', i: '&#128209;' }, { k: 'updates', n: 'Patch Updates', i: '&#127381;' },
  { k: 'root', n: 'Overview', i: '&#128196;' },
];
function viewWiki() {
  const W = S.wiki; if (!W) return waitFor('wiki', viewWiki, 'wiki');
  if (S.wikiPage) return renderWikiPage(S.wikiPage);
  app.innerHTML = `
    <div class="view-title">Rust Wiki <span class="wiki-count">${W.pages.length} pages &middot; offline</span></div>
    <div class="view-sub">Your full Rust knowledge base &mdash; monuments, weapons, raiding, building, everything. Works with no internet.</div>
    <div class="searchwrap"><div class="search"><span>&#128269;</span><input id="wq" type="search" placeholder="Search the whole wiki&hellip;" autocomplete="off"/></div></div>
    <div id="wikiBody"></div>`;
  $('#wq').addEventListener('input', e => renderWikiIndex(e.target.value));
  if (S.wikiSearch) { const q = S.wikiSearch; S.wikiSearch = ''; $('#wq').value = q; renderWikiIndex(q); }
  else renderWikiIndex('');
}
function wikiRow(p) { return `<button class="wiki-row" data-wiki="${esc(p.path)}">${esc(p.title)}<span class="wr-f">${esc(p.folder)}</span></button>`; }
function renderWikiIndex(q) {
  q = norm(q).trim(); const W = S.wiki, el = $('#wikiBody'); if (!el) return;
  if (q) {
    const hits = W.pages.map(p => {
      const t = norm(p.title); let s = 99;
      if (t === q) s = 0; else if (t.startsWith(q)) s = 1; else if (t.includes(q)) s = 2; else if (norm(p.body).includes(q)) s = 4;
      return [s, p];
    }).filter(x => x[0] < 99).sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title)).slice(0, 80).map(x => x[1]);
    el.innerHTML = hits.length ? `<div class="count">${hits.length} result${hits.length > 1 ? 's' : ''}</div><div class="wiki-list">${hits.map(wikiRow).join('')}</div>` : `<div class="empty">No wiki pages match &ldquo;${esc(q)}&rdquo;.</div>`;
  } else {
    el.innerHTML = WIKI_FOLDERS.map(f => {
      const ps = W.pages.filter(p => p.folder === f.k); if (!ps.length) return '';
      return `<div class="wiki-folder"><h3>${f.i} ${f.n} <span>${ps.length}</span></h3><div class="wiki-list">${ps.map(wikiRow).join('')}</div></div>`;
    }).join('');
  }
  el.querySelectorAll('[data-wiki]').forEach(a => a.addEventListener('click', () => openWiki(a.dataset.wiki)));
}
function openWiki(path) {
  if (S.wikiPage !== path) { // guard against double-push on re-open of the same page
    const st = history.state || {};
    history.pushState({ rcWiki: path, rcWikiDepth: (st.rcWikiDepth || 0) + 1 }, '');
  }
  S.wikiPage = path; window.scrollTo(0, 0); renderWikiPage(path);
}
// Back to the wiki index, consuming any article history entries we pushed.
function wikiHome() {
  const st = history.state;
  if (st && st.rcWiki) history.go(-(st.rcWikiDepth || 1));
  else { S.wikiPage = null; viewWiki(); }
}
function renderWikiPage(path) {
  const p = S._wikiByPath[path]; if (!p) { S.wikiPage = null; return viewWiki(); }
  app.innerHTML = `
    <button class="wiki-back" id="wikiBack">&lsaquo; All wiki</button>
    <article class="wiki-article">${mdToHtml(p.body)}</article>
    <div class="credit">From your Fiiiish Island vault &middot; projects/rust/${esc(path)}.md</div>`;
  $('#wikiBack').addEventListener('click', wikiHome);
  app.querySelectorAll('[data-wl]').forEach(a => a.addEventListener('click', () => {
    const t = S.wiki.aliases[a.dataset.wl.toLowerCase()];
    if (t) openWiki(t);
    else { S.wikiSearch = a.dataset.wl; wikiHome(); } // dead link -> fall back to wiki search
  }));
}

// compact markdown renderer for the vault pages
function mdEsc(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function mdInline(s) {
  s = mdEsc(s);
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  // name/disp were already entity-escaped by mdEsc above (so attribute-safe); re-escaping
  // would double-encode & ' " and make dataset.wl read back as literal "&#39;" garbage.
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, name, disp) => `<a class="wl" data-wl="${name.trim()}">${(disp || name).trim()}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  return s;
}
function mdToHtml(md) {
  const lines = md.split(/\r?\n/); let html = ''; let i = 0;
  const list = (items, ord) => items.length ? `<${ord ? 'ol' : 'ul'}>${items.map(x => `<li>${mdInline(x)}</li>`).join('')}</${ord ? 'ol' : 'ul'}>` : '';
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { const lv = Math.min(h[1].length + 1, 6); html += `<h${lv}>${mdInline(h[2])}</h${lv}>`; i++; continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { html += '<hr/>'; i++; continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].includes('-') && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map(c => c.trim()); i += 2; const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim())); i++; }
      html += `<div class="scrollx"><table class="t"><thead><tr>${header.map(c => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    if (line.startsWith('>')) {
      const buf = []; let title = null;
      const first = line.replace(/^>\s?/, ''); const cm = first.match(/^\[!(\w+)\]\s*(.*)$/);
      if (cm) { title = cm[2] || cm[1]; } else if (first.trim()) buf.push(first);
      i++;
      while (i < lines.length && lines[i].startsWith('>')) { const t = lines[i].replace(/^>\s?/, ''); if (t.trim()) buf.push(t); i++; }
      html += `<blockquote>${title ? `<div class="callout-title">${mdInline(title)}</div>` : ''}${buf.map(x => `<p>${mdInline(x)}</p>`).join('')}</blockquote>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; } html += list(items, false); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; } html += list(items, true); continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*[-*]\s|\s*\d+\.\s|\||(-{3,}$))/.test(lines[i])) { para.push(lines[i]); i++; }
    html += `<p>${mdInline(para.join(' '))}</p>`;
  }
  return html;
}

// ---------------- detail sheet ----------------
const sheet = $('#sheet'), sheetBody = $('#sheetBody');
function openSheet(html) {
  // push one history entry per open (not per re-render) so phone back closes the sheet
  if (sheet.hidden) history.pushState(Object.assign({}, history.state, { rcSheet: true }), '');
  sheetBody.innerHTML = html; sheetBody.scrollTop = 0; sheet.hidden = false; sheetLock(true);
}
function closeSheet() { sheet.hidden = true; sheetLock(false); }
// Lock BOTH documentElement and body: the app also runs mounted inside the
// fiiiish-app shell, whose page is a tall scroller of its own, and iOS hands the
// swipe to whichever of the two is the viewport scroller if only one is pinned.
// (tt-fs-lock is a separate class-based lock, so the two never clobber another.)
function sheetLock(on) {
  const v = on ? 'hidden' : '';
  document.documentElement.style.overflow = v;
  document.body.style.overflow = v;
}
// user-initiated close (backdrop / grabber / Escape): consume the pushed entry via back()
// history.back() is async — the one-shot flag (cleared in popstate) stops a second
// Escape/backdrop before popstate lands from popping a REAL history entry.
let sheetDismissing = false;
function dismissSheet() {
  if (sheet.hidden || sheetDismissing) return;
  if (history.state && history.state.rcSheet) { sheetDismissing = true; history.back(); } else closeSheet();
}
sheet.addEventListener('click', e => { if (e.target.dataset.close !== undefined || e.target.classList.contains('grabber')) dismissSheet(); });

// ---------------- PWA ----------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => Promise.resolve().catch(() => {}));
}

boot();
