// Pilot Hub - the map reference.
//
// Loaded two ways, exactly like the other hub views: as a plain <script> in the
// hub window and via require() from test/hub.test.mjs. EVERY DOM touch lives
// behind render().
//
// The one genuinely dangerous thing this view does is put a synced SVG into the
// document. data/svg/ is mirrored from the tarkov-dev repo, which the overlay
// has trusted since day one (app.js parses the same files) - but "trusted
// today" is not a security model, and an SVG is a document that can carry
// script. So the text goes through sanitizeSvg() first, and it is never handed
// to innerHTML: it is parsed with DOMParser and imported as nodes. sanitizeSvg
// is pure and tested, because a regex that ALMOST strips a <script> is worse
// than no regex at all.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotHubMaps = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ==========================================================================
  // PURE: svg sanitising
  // ==========================================================================
  // Defence in depth, in this order:
  //   1. <script> elements, paired and self-closing
  //   2. <foreignObject>, which can carry arbitrary HTML including <script>
  //   3. <style> that carries @import, expression() or an off-origin url()
  //   4. <animate>/<set>/<animateMotion> that retarget an href attribute -
  //      SMIL can rewrite an <a href> to javascript: AFTER this function has
  //      already looked at the markup, which is how a "clean" file becomes a
  //      live one on the timeline
  //   5. on* event handler attributes, in all three quoting styles
  //   6. javascript: URLs in href / xlink:href, DECODE-TOLERANTLY
  //   7. <use>/<image> pointing at an external document
  // The renderer's CSP already refuses inline script ("script-src 'self'"), so
  // this is the second lock, not the only one.
  //
  // Event-handler attributes are matched as a WHOLE attribute name, and the
  // name needs at least three letters after "on". The old `on[a-z]+` also ate a
  // perfectly ordinary attribute called `one` or `once` - quietly corrupting
  // valid markup while looking like it was doing security work. Every real
  // handler in HTML and SVG clears the bar: the shortest are `oncut`, `onend`
  // and `onzoom`; nothing legitimate in SVG is named on + one or two letters.
  const EVENT_ATTR = 'on[a-z]{3,}';

  // "javascript:" written so a naive substring check misses it. Entity forms
  // (&#106;, &#x6a;, &NewLine;), stray whitespace and control characters are
  // all legal inside an href and are all collapsed away by the browser before
  // it decides the scheme - so they are collapsed away here too, and the
  // DECODED copy is what the scheme test runs against.
  function decodeForScheme(v) {
    let s = String(v == null ? '' : v);
    // numeric character references, decimal and hex, terminated or not
    s = s.replace(/&#x([0-9a-f]+);?/gi, (_m, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
    s = s.replace(/&#([0-9]+);?/g, (_m, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
    s = s.replace(/&(newline|tab|colon|amp|lt|gt|quot|apos);?/gi, (_m, name) => {
      const k = String(name).toLowerCase();
      if (k === 'newline') return '\n';
      if (k === 'tab') return '\t';
      if (k === 'colon') return ':';
      if (k === 'amp') return '&';
      return '';
    });
    // every whitespace and control character a browser ignores inside a scheme
    return s.replace(/[\u0000-\u0020\u007f\u00a0\u2028\u2029]+/g, '');
  }

  // Any scheme that can EXECUTE. data: is deliberately absent here: a data URI
  // in an <image href> is an ordinary inline picture, and it is refused for
  // <use>/<image> targets by isExternalRef's own rule instead.
  const BAD_SCHEME_RE = /^(javascript|vbscript|livescript|mocha):/i;

  function isDangerousUrl(v) {
    return BAD_SCHEME_RE.test(decodeForScheme(v).toLowerCase());
  }

  // A reference is LOCAL when it points inside this same document ('#id'), is a
  // relative path with no scheme, or is a self-contained data: URI. Anything
  // with another scheme, or a protocol-relative '//host/x', is a live fetch to
  // somebody else's server from inside our window.
  function isExternalRef(v) {
    const s = decodeForScheme(v);
    if (!s) return false;
    if (s.charAt(0) === '#') return false;
    if (s.slice(0, 2) === '//') return true;
    if (/^data:/i.test(s)) return false;
    return /^[a-z][a-z0-9+.-]*:/i.test(s);
  }

  // Strip one attribute (in any of the three quoting styles) from a tag whose
  // full text is `tag`, whenever `test` says its value is unacceptable.
  function stripAttr(tag, nameRe, test) {
    const re = new RegExp('\\s(' + nameRe + ')\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'gi');
    return tag.replace(re, (m, _n, dq, sq, uq) => {
      const val = dq != null ? dq : (sq != null ? sq : (uq != null ? uq : ''));
      return test(val) ? '' : m;
    });
  }

  const HREF_ATTR = '(?:xlink:)?href';

  function sanitizeSvg(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '');
    s = s.replace(/<\s*script\b[^>]*\/\s*>/gi, '');
    s = s.replace(/<\s*foreignObject\b[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, '');
    s = s.replace(/<\s*foreignObject\b[^>]*\/\s*>/gi, '');
    // <style>. NOT dropped whole - every one of the ten shipped basemaps carries
    // exactly one <style id="style_common"> holding the fill classes (.trees,
    // .water, .building, ...) that every <path> in the file references, so
    // deleting it renders all ten maps as flat black silhouettes. What actually
    // needs killing is the part of a stylesheet that FETCHES or EXECUTES:
    // @import, url() at another origin, IE's expression()/behavior:. A block
    // that contains one of those is dropped whole; a block of plain fill rules
    // is kept. (The window's CSP - style-src 'self' 'unsafe-inline' - already
    // refuses a remote @import; this is the second lock, as everywhere else
    // in this function.)
    const DANGEROUS_CSS = /(@import|expression\s*\(|behavior\s*:|-moz-binding)/i;
    s = s.replace(/<\s*style\b[^>]*>([\s\S]*?)<\s*\/\s*style\s*>/gi, (m, css) => {
      if (DANGEROUS_CSS.test(css)) return '';
      // url(...) is allowed only when it does not leave this document
      let bad = false;
      String(css).replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_u, _q, target) => {
        if (isExternalRef(target)) bad = true;
        return '';
      });
      return bad ? '' : m;
    });
    s = s.replace(/<\s*style\b[^>]*\/\s*>/gi, '');

    // SMIL that retargets an href. Both the paired and the self-closing form,
    // and only when attributeName names an href - a <animate attributeName="x">
    // moving a rectangle is harmless and stays.
    const ANIM = '(?:animate|set|animateMotion|animateTransform)';
    s = s.replace(new RegExp('<\\s*' + ANIM + '\\b[^>]*>[\\s\\S]*?<\\s*/\\s*' + ANIM + '\\s*>', 'gi'),
      (m) => (/attributeName\s*=\s*(["']?)\s*(?:xlink:)?href\s*\1/i.test(m) ? '' : m));
    s = s.replace(new RegExp('<\\s*' + ANIM + '\\b[^>]*\\/?\\s*>', 'gi'),
      (m) => (/attributeName\s*=\s*(["']?)\s*(?:xlink:)?href\s*\1/i.test(m) ? '' : m));

    // <use> and <image> pointing at another document. These are the two
    // elements that FETCH, and a <use href="https://evil/x#y"> pulls somebody
    // else's markup into our tree. The whole element goes, both forms, rather
    // than just its href - an element left behind with its target removed is a
    // thing that looks like it works and does not.
    const EXT_REF_RE = /\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const hrefOf = (m) => {
      const g = EXT_REF_RE.exec(m);
      if (!g) return '';
      return g[1] != null ? g[1] : (g[2] != null ? g[2] : (g[3] || ''));
    };
    const REF_EL = '(?:use|image)';
    s = s.replace(new RegExp('<\\s*' + REF_EL + '\\b[^>]*>[\\s\\S]*?<\\s*/\\s*' + REF_EL + '\\s*>', 'gi'),
      (m) => (isExternalRef(hrefOf(m)) ? '' : m));
    s = s.replace(new RegExp('<\\s*' + REF_EL + '\\b[^>]*\\/?\\s*>', 'gi'),
      (m) => (isExternalRef(hrefOf(m)) ? '' : m));

    // Per-tag attribute work. Doing it tag by tag is what makes "strip the href
    // on THIS element" possible at all - a document-wide regex cannot tell a
    // <use> from an <a>.
    s = s.replace(/<[^>]*>/g, (tag) => {
      if (tag.slice(0, 2) === '</' || tag.slice(0, 4) === '<!--' || tag.charAt(1) === '?') return tag;
      let out = tag;
      // 5. event handlers, whole-name matched
      out = stripAttr(out, EVENT_ATTR, () => true);
      // 6. dangerous schemes anywhere an href can appear
      out = stripAttr(out, HREF_ATTR, isDangerousUrl);
      // 7. external documents pulled in by <use> / <image>
      if (/^<\s*(use|image)\b/i.test(out)) {
        out = stripAttr(out, HREF_ATTR, isExternalRef);
      }
      return out;
    });
    return s;
  }

  // ==========================================================================
  // PURE: shaping
  // ==========================================================================
  // Extracts by faction. 'shared' is its own bucket rather than being duplicated
  // into pmc and scav: on the ground it means "either side can take it", which
  // is a different fact from "there is a PMC exit here".
  const FACTION_ORDER = ['pmc', 'scav', 'shared'];
  const FACTION_LABEL = { pmc: 'PMC', scav: 'Scav', shared: 'Shared' };

  function groupExtracts(extracts) {
    const byFaction = {};
    (Array.isArray(extracts) ? extracts : []).forEach((e) => {
      if (!e) return;
      const f = String(e.faction || 'shared').toLowerCase();
      (byFaction[f] = byFaction[f] || []).push(e);
    });
    const known = FACTION_ORDER.filter((f) => byFaction[f]);
    const extra = Object.keys(byFaction).filter((f) => FACTION_ORDER.indexOf(f) < 0).sort();
    return known.concat(extra).map((f) => ({
      faction: f,
      label: FACTION_LABEL[f] || f,
      // name order, and a switch-gated exit is marked, never silently listed
      // next to one you can just walk through
      extracts: byFaction[f].slice().sort((a, b) => {
        const an = String(a.name || '');
        const bn = String(b.name || '');
        return an < bn ? -1 : (an > bn ? 1 : 0);
      }),
    }));
  }

  // '0.35' -> '35%'. A null chance is unknown, and renders as nothing rather
  // than as 0% - "this boss never spawns" is a very different claim.
  function spawnLabel(chance) {
    // Number(null) is 0, so null has to be caught BEFORE the coercion or an
    // unknown spawn chance renders as the confident claim "0%".
    if (chance == null || chance === '') return '';
    const n = Number(chance);
    if (!Number.isFinite(n)) return '';
    return Math.round(n * 100) + '%';
  }

  // The one-line facts a map card shows. Pulled out so the card and the detail
  // header cannot disagree.
  function mapFacts(map) {
    const out = [];
    if (!map) return out;
    if (map.players) out.push(map.players + ' players');
    if (Number(map.raidDuration) > 0) out.push(map.raidDuration + ' min');
    const min = Number(map.minPlayerLevel) || 0;
    const max = Number(map.maxPlayerLevel) || 0;
    // 0-100 is "no gate at all" and is noise on every card; only a real
    // restriction (Ground Zero, the tutorial) earns a line.
    if (min > 0 || (max > 0 && max < 100)) {
      out.push('level ' + (min || 1) + '-' + (max || 100));
    }
    if (Array.isArray(map.bosses) && map.bosses.length) out.push(map.bosses.length + ' bosses');
    return out;
  }

  // data/svg/<file>. mapsinfo carries the bare filename, and this is the only
  // place that turns it into a read-data name - so a map with no basemap is
  // null here rather than a read that will fail later.
  function svgPathFor(map) {
    const f = map && map.svg;
    if (!f || typeof f !== 'string') return null;
    if (!/^[A-Za-z0-9_-]+\.svg$/.test(f)) return null; // never a path, only a name
    return 'svg/' + f;
  }

  // ==========================================================================
  // Everything below touches the DOM and only ever runs inside render().
  // ==========================================================================
  function render(mount, ctx, param) {
    const el = ctx.el;
    const clear = ctx.clear;
    const items = ctx.items || {};
    const maps = (ctx.mapsinfo || []).slice();

    const state = { selected: param || null };

    const wrap = el('div', 'split-wrap maps-wrap');
    const left = el('div', 'split-left');
    const right = el('div', 'split-right');
    wrap.appendChild(left);
    wrap.appendChild(right);
    // The interactive map fills this same wrap when it is open (the two panes
    // stay in the DOM behind it, so closing it costs nothing to rebuild). It is
    // created empty and stays empty on any host without Leaflet.
    const imapMount = el('div', 'imap-mount hidden');
    wrap.appendChild(imapMount);
    mount.appendChild(wrap);

    // ---- interactive map (web only; see hub-maps-interactive.js) ----
    // FEATURE-DETECTED, never forked: the Electron hub window loads neither
    // Leaflet nor the interactive module, so `Interactive()` is null there and
    // every line below is a no-op. The island page loads both and gets the map.
    let imap = null;
    function Interactive() {
      const IM = (typeof globalThis !== 'undefined') ? globalThis.PilotHubMapsInteractive : null;
      return (IM && typeof IM.available === 'function' && IM.available()) ? IM : null;
    }

    function closeInteractive() {
      if (imap) {
        try { imap.destroy(); } catch (e) {
          console.error('hub: closing the interactive map failed: ' + (e && e.message ? e.message : e));
        }
        imap = null;
      }
      imapMount.classList.add('hidden');
      wrap.classList.remove('imap-open');
    }

    function openInteractive(m) {
      const IM = Interactive();
      if (!IM || !m) return;
      closeInteractive();
      wrap.classList.add('imap-open');
      imapMount.classList.remove('hidden');
      imap = IM.open({
        ctx,
        mount: imapMount,
        mapId: m.normalizedName || m.id,
        mapName: m.name || m.normalizedName || m.id,
        onClose: closeInteractive,
      });
    }

    // ---- Pilot live link: follow the map the desktop app is on ----
    // WEB ONLY and feature-detected, exactly like the interactive view above:
    // globalThis.PilotLive is installed by hub-pilot-connect.js, which the
    // Electron hub window does not load, so all of this is inert there.
    //
    // The switch lives HERE rather than in the map view because this is the
    // only scope that owns both the selection and openInteractive() - a view
    // cannot re-open itself on a different map.
    let liveUnsub = null;
    function Live() {
      const lv = (typeof globalThis !== 'undefined') ? globalThis.PilotLive : null;
      return (lv && typeof lv.subscribe === 'function') ? lv : null;
    }

    (function wireLive() {
      const lv = Live();
      if (!lv) return;
      liveUnsub = lv.subscribe((ev) => {
        if (!ev || ev.type !== 'map') return;
        if (lv.pref('followMap') === false) return;
        const id = ev.payload && ev.payload.map;
        const m = id ? mapById(id) : null;
        if (!m || state.selected === m.id) return;
        // Re-open the interactive view on the new map only if it was already
        // open: a raid change must never yank someone out of the dossier they
        // were reading into a full map view they did not ask for.
        const wasOpen = !!imap;
        select(m.id);
        if (wasOpen) openInteractive(m);
      });
    }());

    function mapById(id) {
      for (let i = 0; i < maps.length; i++) {
        if (maps[i] && (maps[i].id === id || maps[i].normalizedName === id)) return maps[i];
      }
      return null;
    }

    function itemName(id) {
      const it = items[id];
      return (it && it.n) || id;
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

    // ---- cards ----
    function paintCards() {
      clear(left);
      const grid = el('div', 'map-cards');
      maps.forEach((m) => {
        const card = el('div', 'map-card' + (state.selected === m.id ? ' selected' : ''));
        card.appendChild(el('div', 'map-name', m.name || m.normalizedName || m.id));
        const facts = el('div', 'map-facts');
        mapFacts(m).forEach((f) => facts.appendChild(el('span', null, f)));
        card.appendChild(facts);
        card.addEventListener('click', () => select(m.id, { user: true }));
        grid.appendChild(card);
      });
      left.appendChild(grid);
    }

    function select(id, opts) {
      // Browsing maps by hand while the Pilot link is following the raid is a
      // conflict with exactly one sane resolution: the human wins, and the
      // follow PAUSES rather than snapping the view back a second later. The
      // interactive map's chrome carries the "resume follow" affordance.
      if (opts && opts.user) {
        const lv = Live();
        if (lv && lv.connected() && lv.pref('followMap') !== false) lv.setPref('followMap', false);
      }
      // picking another map while the interactive view is open would leave a
      // leaflet map for the OLD map sitting over the new detail pane
      closeInteractive();
      state.selected = id;
      paintCards();
      renderDetail(id);
    }

    // ==========================================================================
    // DETAIL - the tabbed dossier
    // ==========================================================================
    // The pane used to be one long stack: header, keys, bosses, extracts,
    // transits, basemap. On Customs that is 27 extracts between you and the
    // map, and on a phone it is a scroll with no landmarks. So the pane is now
    // a header that never scrolls (map name + sub-tabs) over ONE tab body:
    // Overview is a briefing (stat tiles, threat board, exit split, transits,
    // basemap preview, keys) and every long list lives one click away.
    //
    // Two rules hold the whole thing together:
    //   * a tab EXISTS only when its data does. mapsinfo gives Customs no
    //     access keys and Terminal no extracts, so those maps simply have no
    //     Keys / Extracts tab - never a tab of placeholders.
    //   * a tab body is built the first time it is shown. Terminal carries 28
    //     bosses and Customs' basemap is a 190 kB SVG; neither is parsed unless
    //     somebody actually asks for it.
    //
    // Each render takes a token. A late basemap load belonging to a previous
    // map - or to a previous visit to the SAME map - checks it before painting,
    // so a slow SVG can never land in a pane that has already been rebuilt.
    let renderToken = 0;

    // 0.35 -> 35, clamped. Kept separate from spawnLabel() because a BAR needs
    // a number and null has to stay distinguishable from zero: "we do not know"
    // and "never spawns" are different claims and must not draw the same.
    function pctOf(chance) {
      if (chance == null || chance === '') return null;
      const n = Number(chance);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.min(100, Math.round(n * 100)));
    }

    // One boss row, shared by the overview threat board and the Bosses tab, so
    // the two can never disagree about a spawn chance.
    function threatRow(b) {
      const row = el('div', 'mdx-threat');
      // portrait:false means there is genuinely no file on disk (the sync
      // asserts that), so the <img> is not even built - an always-broken image
      // is worse than a name on its own. The empty slot keeps the rows aligned.
      const src = (b && b.portrait) ? ctx.imgUrl('boss', b.slug) : '';
      if (src) {
        const img = document.createElement('img');
        img.className = 'mdx-face';
        img.alt = '';
        img.loading = 'lazy';
        img.src = src;
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        row.appendChild(img);
      } else {
        row.appendChild(el('div', 'mdx-face mdx-face-none'));
      }
      row.appendChild(el('div', 'mdx-threat-name', (b && (b.name || b.mob)) || '?'));
      const p = pctOf(b && b.spawnChance);
      if (p == null) {
        row.appendChild(el('div', 'mdx-threat-unknown', 'spawn chance unknown'));
      } else {
        const bar = el('div', 'mdx-bar');
        const fill = el('div', 'mdx-bar-fill');
        fill.style.width = p + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('div', 'mdx-pct', p + '%'));
      }
      return row;
    }

    // A titled card on the overview, with an optional right-aligned link that
    // jumps to the tab holding the full list.
    function block(parent, title, moreLabel, onMore) {
      const b = el('div', 'mdx-block');
      const h = el('div', 'mdx-block-head');
      h.appendChild(el('div', 'mdx-block-title', title));
      if (moreLabel && onMore) {
        const btn = el('button', 'mdx-more', moreLabel);
        btn.type = 'button';
        btn.addEventListener('click', onMore);
        h.appendChild(btn);
      }
      b.appendChild(h);
      const body = el('div', 'mdx-block-body');
      b.appendChild(body);
      parent.appendChild(b);
      return body;
    }

    function extractLine(e) {
      const line = el('div', 'mdx-ex');
      line.appendChild(el('span', 'mdx-ex-name', (e && (e.name || e.id)) || '?'));
      if (e && e.switch) {
        const tag = el('span', 'tag tag-switch', 'switch');
        tag.title = 'needs a switch or lever thrown first';
        line.appendChild(tag);
      }
      return line;
    }

    function renderDetail(id) {
      const m = mapById(id);
      clear(right);
      right.classList.remove('mdx-host');
      const token = ++renderToken;
      if (!m) {
        right.appendChild(el('div', 'detail-empty', id ? 'No such map.' : 'Pick a map.'));
        return;
      }
      right.classList.add('mdx-host');

      const bosses = Array.isArray(m.bosses) ? m.bosses : [];
      const extracts = Array.isArray(m.extracts) ? m.extracts : [];
      const keys = Array.isArray(m.accessKeys) ? m.accessKeys : [];
      const transits = Array.isArray(m.transits) ? m.transits : [];
      const groups = groupExtracts(extracts);
      const svgName = svgPathFor(m);
      const switches = extracts.filter((e) => e && e.switch).length;
      // Loudest threat first. mapsinfo's own order is the raid-config order,
      // which means Cultist Priest can outrank Reshala on Customs.
      const byChance = bosses.slice().sort((a, b) => {
        const pa = pctOf(a && a.spawnChance);
        const pb = pctOf(b && b.spawnChance);
        return (pb == null ? -1 : pb) - (pa == null ? -1 : pa);
      });

      const pane = el('div', 'mdx');
      right.appendChild(pane);

      // ---- header: name, the one-line facts, wiki, sub-tabs ----
      const head = el('div', 'mdx-head');
      const top = el('div', 'mdx-head-top');
      const title = el('div', 'mdx-title');
      title.appendChild(el('div', 'mdx-kicker', 'Map dossier'));
      title.appendChild(el('h2', null, m.name || m.id));
      top.appendChild(title);
      const meta = el('div', 'mdx-meta');
      // mapFacts is shared with the cards on the left; the boss count is the
      // one entry that would duplicate a stat tile AND a tab badge, so it is
      // dropped here rather than said three times.
      mapFacts(m).filter((f) => !/ bosses$/.test(f))
        .forEach((f) => meta.appendChild(el('span', null, f)));
      if (m.wiki) {
        const btn = el('button', 'wiki-btn', 'Wiki');
        btn.type = 'button';
        btn.title = 'Open the wiki page for this map';
        btn.addEventListener('click', () => {
          if (ctx.api && ctx.api.openExternal) ctx.api.openExternal(m.wiki);
        });
        meta.appendChild(btn);
      }
      top.appendChild(meta);
      head.appendChild(top);
      const tabStrip = el('div', 'mdx-tabs');
      tabStrip.setAttribute('role', 'tablist');
      head.appendChild(tabStrip);
      pane.appendChild(head);

      const body = el('div', 'mdx-body');
      pane.appendChild(body);

      // ---- the tab machinery ----
      const tabs = [];
      function addTab(key, label, count, build) {
        tabs.push({ key, label, count, build, built: false, btn: null, panel: null });
      }
      function show(key) {
        tabs.forEach((t) => {
          const on = t.key === key;
          t.btn.classList.toggle('on', on);
          t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
          t.panel.classList.toggle('on', on);
          if (on && !t.built) {
            t.built = true;
            t.build(t.panel);
          }
        });
        // the body is its own scroller; a tab switch starts at the top of the
        // new tab rather than halfway down where the last one was left
        body.scrollTop = 0;
      }

      // ---- OVERVIEW ----
      addTab('overview', 'Overview', null, (panel) => {
        // stat tiles - only for facts this map actually has
        const tileDefs = [];
        if (Number(m.raidDuration) > 0) tileDefs.push([String(m.raidDuration), 'min raid', '']);
        if (m.players) tileDefs.push([String(m.players), 'players', '']);
        if (bosses.length) tileDefs.push([String(bosses.length), bosses.length === 1 ? 'boss' : 'bosses', 'warn']);
        if (extracts.length) tileDefs.push([String(extracts.length), 'extracts', 'accent']);
        if (transits.length) tileDefs.push([String(transits.length), transits.length === 1 ? 'transit route' : 'transit routes', '']);
        if (keys.length) tileDefs.push([String(keys.length), keys.length === 1 ? 'access key' : 'access keys', '']);
        if (tileDefs.length) {
          const tiles = el('div', 'mdx-tiles');
          tileDefs.forEach((t) => {
            const d = el('div', 'mdx-tile' + (t[2] ? ' mdx-' + t[2] : ''));
            d.appendChild(el('div', 'mdx-tile-v', t[0]));
            d.appendChild(el('div', 'mdx-tile-k', t[1]));
            tiles.appendChild(d);
          });
          panel.appendChild(tiles);
        }

        if (m.description) panel.appendChild(el('p', 'mdx-blurb', m.description));

        const two = el('div', 'mdx-two');
        const colL = el('div', 'mdx-col');
        const colR = el('div', 'mdx-col');

        // threat board - the top few, with the rest one click away
        if (bosses.length) {
          // Four rows is what the overview can hold and still keep the whole
          // briefing above the fold on a 900px window; the rest are one click
          // away in the Bosses tab (Lighthouse has ten, Terminal twenty-eight).
          const shown = byChance.slice(0, 4);
          const more = bosses.length > shown.length;
          const tb = block(colL, 'Threat board',
            more ? ('All ' + bosses.length + ' →') : null,
            more ? () => show('bosses') : null);
          shown.forEach((b) => tb.appendChild(threatRow(b)));
        }

        // exit split - one stacked bar, then the counts
        if (extracts.length) {
          const xb = block(colL, 'Ways out', 'All extracts →', () => show('extracts'));
          const bar = el('div', 'mdx-split');
          groups.forEach((g) => {
            const seg = el('i', 'mdx-seg mdx-f-' + g.faction);
            seg.style.width = (g.extracts.length / extracts.length * 100) + '%';
            seg.title = g.label + ': ' + g.extracts.length;
            bar.appendChild(seg);
          });
          xb.appendChild(bar);
          const legend = el('div', 'mdx-legend');
          groups.forEach((g) => {
            const r = el('div', 'mdx-leg');
            r.appendChild(el('span', 'mdx-sw mdx-f-' + g.faction));
            r.appendChild(el('span', 'mdx-leg-label', g.label + ' exits'));
            r.appendChild(el('span', 'mdx-leg-count', String(g.extracts.length)));
            legend.appendChild(r);
          });
          if (switches) {
            const r = el('div', 'mdx-leg');
            r.appendChild(el('span', 'tag tag-switch', 'switch'));
            r.appendChild(el('span', 'mdx-leg-note', 'need a lever thrown first'));
            r.appendChild(el('span', 'mdx-leg-count', String(switches)));
            legend.appendChild(r);
          }
          xb.appendChild(legend);
        }

        // access keys - real items only; a map with none has no block AND no tab
        if (keys.length) {
          const kb = block(colL, 'Access keys', null, null);
          const row = el('div', 'mdx-keys');
          keys.forEach((k) => row.appendChild(miniItem(k, 1)));
          kb.appendChild(row);
        }

        if (transits.length) {
          const tr = block(colR, 'Transit routes', null, null);
          const wrapT = el('div', 'mdx-transits');
          transits.forEach((t) => {
            const dest = mapById(t && t.map);
            const chip = el(dest ? 'button' : 'div', 'mdx-transit');
            if (dest) {
              chip.type = 'button';
              chip.addEventListener('click', () => ctx.go('maps', dest.id));
            }
            chip.title = (t && t.description) || '';
            chip.appendChild(el('span', 'mdx-arrow', '→'));
            chip.appendChild(el('span', 'mdx-dest',
              dest ? (dest.name || dest.id) : ((t && (t.description || t.id)) || '?')));
            wrapT.appendChild(chip);
          });
          tr.appendChild(wrapT);
        }

        // basemap preview. Its own load, so the overview costs one parse and
        // the full-size Basemap tab costs one more only if it is opened.
        if (svgName) {
          const mb = block(colR, 'Basemap', 'Full map →', () => show('basemap'));
          mb.parentNode.classList.add('mdx-grow');
          const mini = el('div', 'mdx-mini', 'loading basemap...');
          mb.appendChild(mini);
          ctx.loadText(svgName).then((text) => {
            if (token !== renderToken) return; // the pane was rebuilt under us
            clear(mini);
            const node = text ? parseSvg(text) : null;
            if (!node) {
              mini.appendChild(el('p', 'muted', text
                ? 'The basemap could not be parsed.'
                : 'The basemap file is missing - run npm run sync.'));
              return;
            }
            mini.appendChild(node);
          });
          mini.addEventListener('click', () => show('basemap'));
        }

        if (colL.childNodes.length) two.appendChild(colL);
        if (colR.childNodes.length) two.appendChild(colR);
        if (two.childNodes.length) panel.appendChild(two);

        // Ground Zero Tutorial and the Lab variants carry no markers at all.
        // Say so, rather than showing a header over blank space.
        if (!tileDefs.length && !m.description && !two.childNodes.length) {
          panel.appendChild(el('div', 'detail-empty', 'No map data has been synced for this location yet.'));
        }
      });

      // ---- BOSSES ----
      if (bosses.length) {
        addTab('bosses', 'Bosses', bosses.length, (panel) => {
          const list = el('div', 'mdx-threats');
          byChance.forEach((b) => list.appendChild(threatRow(b)));
          panel.appendChild(list);
        });
      }

      // ---- EXTRACTS ----
      if (extracts.length) {
        addTab('extracts', 'Extracts', extracts.length, (panel) => {
          const cols = el('div', 'mdx-excols');
          groups.forEach((g) => {
            const col = el('div', 'mdx-excol mdx-f-' + g.faction);
            const h = el('div', 'mdx-exhead');
            h.appendChild(el('span', 'mdx-sw mdx-f-' + g.faction));
            h.appendChild(el('div', 'mdx-exhead-title', g.label));
            h.appendChild(el('div', 'mdx-exhead-count', String(g.extracts.length)));
            col.appendChild(h);
            g.extracts.forEach((e) => col.appendChild(extractLine(e)));
            cols.appendChild(col);
          });
          panel.appendChild(cols);
        });
      }

      // ---- KEYS ----
      // Only three maps in mapsinfo carry access keys at all. The other
      // fourteen get no tab: an empty "Keys" tab reads as missing data.
      if (keys.length) {
        addTab('keys', 'Keys', keys.length, (panel) => {
          const row = el('div', 'mdx-keys mdx-keys-wide');
          keys.forEach((k) => row.appendChild(miniItem(k, 1)));
          panel.appendChild(row);
        });
      }

      // ---- BASEMAP ----
      // Unchanged in substance from the old stacked section: the same
      // "Open interactive map" button, revealed only once the map is CONFIRMED
      // to have an interactive projection, and the same clickable basemap.
      if (svgName) {
        addTab('basemap', 'Basemap', null, (panel) => {
          const openBtn = el('button', 'imap-open-btn hidden', 'Open interactive map');
          openBtn.type = 'button';
          openBtn.title = 'Pan and zoom, toggle extracts, quests, loot, spawns and bosses, and switch floors';
          panel.appendChild(openBtn);
          const holder = el('div', 'svg-holder', 'loading basemap...');
          panel.appendChild(holder);

          ctx.loadText(svgName).then((text) => {
            if (token !== renderToken) return; // the user moved on
            clear(holder);
            if (!text) {
              holder.appendChild(el('p', 'muted', 'The basemap file is missing - run npm run sync.'));
              return;
            }
            const node = parseSvg(text);
            if (!node) {
              holder.appendChild(el('p', 'muted', 'The basemap could not be parsed.'));
              return;
            }
            holder.appendChild(node);
          });

          // FEATURE-DETECTED: null in the Electron hub window, which loads
          // neither Leaflet nor the interactive module, so no button grows.
          const IM = Interactive();
          if (IM) {
            IM.supports(ctx, m.normalizedName || m.id).then((ok) => {
              if (!ok || token !== renderToken) return;
              openBtn.classList.remove('hidden');
              openBtn.addEventListener('click', () => openInteractive(m));
              // the basemap picture itself is the obvious thing to click
              holder.classList.add('imap-clickable');
              holder.title = 'Open the interactive map';
              holder.addEventListener('click', () => openInteractive(m));
            });
          }
        });
      }

      // ---- paint the strip, open the overview ----
      tabs.forEach((t) => {
        const btn = el('button', 'mdx-tab');
        btn.type = 'button';
        btn.setAttribute('role', 'tab');
        btn.appendChild(document.createTextNode(t.label));
        if (t.count != null) btn.appendChild(el('span', 'mdx-tab-n', String(t.count)));
        btn.addEventListener('click', () => show(t.key));
        t.btn = btn;
        tabStrip.appendChild(btn);

        const panel = el('div', 'mdx-panel');
        panel.setAttribute('role', 'tabpanel');
        t.panel = panel;
        body.appendChild(panel);
      });
      // A single tab is a label, not a choice - hide the strip on the maps
      // that carry nothing but an overview.
      if (tabs.length < 2) tabStrip.classList.add('hidden');
      show('overview');
    }

    // Sanitise, parse, import. Never innerHTML - the parsed document is a
    // separate document, so its nodes are adopted explicitly, which also means
    // a parsererror is something we can SEE rather than something that renders
    // as red text inside the page.
    function parseSvg(text) {
      let doc;
      try {
        doc = new DOMParser().parseFromString(sanitizeSvg(text), 'image/svg+xml');
      } catch (e) {
        console.error('hub: basemap parse failed: ' + e.message);
        return null;
      }
      if (!doc || !doc.documentElement) return null;
      if (doc.getElementsByTagName('parsererror').length) return null;
      if (String(doc.documentElement.nodeName).toLowerCase() !== 'svg') return null;
      const node = document.importNode(doc.documentElement, true);
      // The source files carry absolute pixel dimensions; the pane is a
      // resizable window, so the intrinsic size is dropped and the viewBox
      // (which every one of these has) does the scaling.
      node.removeAttribute('width');
      node.removeAttribute('height');
      node.setAttribute('class', 'basemap-svg');
      return node;
    }

    // The default map to show when the Maps tab is opened with no explicit
    // selection. Josia's ask: the tab must land on a rendered map, no click
    // required. A default is only useful if it actually PAINTS a basemap, so a
    // map with no SVG (The Lab / Labyrinth / Icebreaker / the Ground Zero
    // variants) is never chosen as the default. Preference order: Customs (the
    // canonical starter map everyone knows), then the first map that has an SVG
    // basemap, then - only if nothing has one - the first map at all so the
    // detail panel (facts / bosses / extracts) still renders.
    function hasBasemap(m) { return !!svgPathFor(m); }
    function defaultMapId() {
      // An explicit, valid param always wins (a deep link to a specific map).
      if (state.selected && mapById(state.selected)) return state.selected;
      const wantCustoms = maps.find((m) => m && hasBasemap(m)
        && (m.normalizedName === 'customs' || m.id === 'customs'
          || String(m.name || '').toLowerCase() === 'customs'));
      if (wantCustoms) return wantCustoms.id;
      const firstWithSvg = maps.find(hasBasemap);
      if (firstWithSvg) return firstWithSvg.id;
      return maps.length ? maps[0].id : null;
    }

    // ---- first paint ----
    // Land on a rendered map immediately - never the bare "Pick a map." panel.
    state.selected = defaultMapId();
    // If the Pilot link is live and following the raid, land on the map the
    // player is actually in rather than a generic default.
    (function landOnLiveMap() {
      const lv = Live();
      if (!lv || !lv.connected() || lv.pref('followMap') === false) return;
      const id = lv.state().map;
      const m = id ? mapById(id) : null;
      if (m) state.selected = m.id;
    }());
    paintCards();
    renderDetail(state.selected);

    return {
      focus: (id) => { if (id) select(id); },
      refresh: () => {
        closeInteractive();
        paintCards();
        if (state.selected) renderDetail(state.selected);
      },
      // hub.js calls this when the route changes. Without it the leaflet map,
      // its ResizeObserver and the live-link subscription would outlive the
      // pane they were drawn into.
      destroy: () => {
        if (liveUnsub) { try { liveUnsub(); } catch (e) { /* already gone */ } liveUnsub = null; }
        closeInteractive();
      },
    };
  }

  return {
    FACTION_ORDER,
    FACTION_LABEL,
    sanitizeSvg,
    groupExtracts,
    spawnLabel,
    mapFacts,
    svgPathFor,
    render,
  };
}));
