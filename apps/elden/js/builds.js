/* builds.js - the Builds tab: twelve gilded archetype guides + the Planner seat.
 *
 * OWNED BY: P3 L6 (Builds UI). Sibling sheet: css/builds.css.
 * Companion tooling in the same lane: tools/build_guides.mjs (compiles
 * projects/elden-ring/guides/*.md into data/guides.json) and
 * tools/validate/guides.mjs (the gate over the compiled result).
 *
 * WHAT THIS FILE IS ALLOWED TO TOUCH
 *   Nothing outside itself. Every shared surface is reached through window.ER,
 *   which js/app.js implements: ER.data, ER.byId, ER.srcOn, ER.registerTab,
 *   ER.navigate, ER.openEntity, ER.entityCardHtml, ER.sheet, ER.toast, ER.esc.
 *   The planner is reached through ER.planner and the map through ER.mapApi -
 *   BOTH are optional at every call site, because a lane that has not landed
 *   must degrade to an honest placeholder, never to a thrown error that takes
 *   the whole tab down with it.
 *
 * TWO DATA SHAPES, ON PURPOSE
 *   tools/build_guides.mjs emits `pvp`, `why` and route-step `get`.
 *   tools/fixture/data/guides.json (written before that contract firmed) spells
 *   the same three `pvpNote`, `whyItWorks` and `items`, and omits tagline,
 *   difficulty, firstHour and the variant twist entirely. Every read here goes
 *   through a small accessor that accepts either spelling and tolerates the
 *   absence, so this tab renders the fixture during development and the real
 *   build afterwards with no edit. A missing field is rendered as a shorter
 *   page, never as "undefined".
 *
 * THE DLC RULE (PLAN.md section 6)
 *   A guide whose CORE needs Shadow of the Erdtree carries src:"sote" and is
 *   hidden while the toggle is off. Inside a guide, individual route steps
 *   carry dlc:true and live under their own sub-heading which is hidden the
 *   same way. Untagged always means base; nothing is hidden by default.
 *
 * ASCII only. Classic script, ES2019, no modules.
 */
(function () {
  'use strict';

  var ER = (window.ER = window.ER || {});
  var esc = function (s) {
    return ER.esc ? ER.esc(s) : String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  var STATS = ['vig', 'mind', 'end', 'str', 'dex', 'int', 'fai', 'arc'];
  var SHORT = {
    vig: 'VIG', mind: 'MND', end: 'END', str: 'STR',
    dex: 'DEX', int: 'INT', fai: 'FTH', arc: 'ARC'
  };
  /* The five kit lists, in the order a player actually assembles them. */
  var KIT = [
    ['talismans', 'Talismans', '&#128142;'],
    ['tears', 'Crystal tears', '&#127864;'],
    ['spells', 'Spells', '&#10024;'],
    ['ashes', 'Ashes of War', '&#128293;'],
    ['spirits', 'Spirit Ashes', '&#128123;']
  ];

  var S = {
    pane: null,
    seg: 'guides',      /* 'guides' | 'planner' */
    slug: null,         /* open guide, or null for the card grid */
    plannerSlug: null,  /* guide handed to the planner, if any */
    plannerHost: null,
    plannerMounted: false
  };

  /* ------------------------------------------------------------ accessors */
  /* One place that knows both spellings, so no renderer below has to. */
  function guides() {
    var arr = ER.data && ER.data.guides;
    return Array.isArray(arr) ? arr : [];
  }
  function visibleGuides() {
    return guides().filter(function (g) {
      return g && (!ER.srcOn || ER.srcOn(g.src));
    });
  }
  function guideBySlug(slug) {
    var key = String(slug || '');
    var all = guides();
    for (var i = 0; i < all.length; i++) {
      var g = all[i];
      if (!g) continue;
      if (String(g.slug) === key || String(g.id) === key) return g;
    }
    return null;
  }
  function pvpOf(g) { return g.pvp || g.pvpNote || ''; }
  function whyOf(g) { return g.why || g.whyItWorks || ''; }
  function stepGear(s) {
    var a = s && (s.get || s.items);
    return Array.isArray(a) ? a : [];
  }
  function variantTwist(v) { return (v && (v.twist || v.text)) || ''; }
  /* A guide ships a names map so a row can be labelled before the dataset that
     owns that id has landed. Falling back to the id itself would print a hex
     blob at a player; falling back to nothing would print an empty row. */
  function nameOf(g, id) {
    if (!id) return '';
    var rec = ER.byId ? ER.byId(id) : null;
    if (rec && rec.name) return rec.name;
    if (g && g.names && g.names[id]) return g.names[id];
    return String(id);
  }

  /* ------------------------------------------------------------ fragments */
  function iconHtml(rec, fallbackGlyph, cls) {
    var fb = fallbackGlyph || '&#9670;';
    var has = rec && rec.icon;
    var c = 'er-ic-wrap' + (cls ? ' ' + cls : '') + (has ? '' : ' noimg');
    return (
      '<span class="' + c + '">' +
      (has ? '<img class="er-ic" src="' + esc(ER.asset(rec.icon)) + '" alt="" loading="lazy" decoding="async" />' : '') +
      '<span class="er-ic-fb" aria-hidden="true">' + fb + '</span></span>'
    );
  }

  function pipsHtml(n) {
    var d = Number(n);
    if (!isFinite(d) || d < 1) return '';
    d = Math.max(1, Math.min(5, Math.round(d)));
    var out = '';
    for (var i = 1; i <= 5; i++) out += '<span class="pip' + (i <= d ? ' on' : '') + '"></span>';
    return '<span class="pips" role="img" aria-label="Difficulty ' + d + ' of 5">' + out + '</span>';
  }

  function srcBadge(g) {
    return g && g.src === 'sote' ? '<span class="src-badge">SotE</span>' : '';
  }

  /* An entity row. When the dataset that owns the id has landed we hand the
     job to the shell's own card, so a gear row on this tab is byte-identical
     to the same item on the Wiki tab. When it has NOT landed we render a muted
     row carrying the authored name - honest about the gap, still readable. */
  function entityRow(g, id, glyph) {
    var rec = ER.byId ? ER.byId(id) : null;
    if (rec && ER.entityCardHtml) return ER.entityCardHtml(rec);
    return (
      '<span class="brow-miss">' +
      iconHtml(null, glyph || '&#9670;', 's32') +
      '<span class="bm-body"><span class="bm-n">' + esc(nameOf(g, id)) + '</span>' +
      '<span class="bm-s">not in this data pull yet</span></span></span>'
    );
  }

  function entityRows(g, ids, glyph) {
    var list = Array.isArray(ids) ? ids : [];
    if (!list.length) return '';
    return '<div class="brows">' + list.map(function (id) {
      return entityRow(g, id, glyph);
    }).join('') + '</div>';
  }

  function section(title, html, extraCls) {
    if (!html) return '';
    return (
      '<section class="e-sec' + (extraCls ? ' ' + extraCls : '') + '">' +
      '<h3 class="e-h">' + esc(title) + '</h3>' + html + '</section>'
    );
  }

  /* Authored prose arrives as plain text with blank-line paragraph breaks. */
  function proseHtml(text, cls) {
    var t = String(text || '').trim();
    if (!t) return '';
    return t.split(/\n\s*\n/).map(function (p) {
      return '<p class="' + (cls || 'e-p') + '">' + esc(p.replace(/\s*\n\s*/g, ' ')) + '</p>';
    }).join('');
  }

  /* -------------------------------------------------------------- the map */
  /* Which world a guide's route lives in. Derived from the first route pin the
     map lane actually shipped; only when there is none does it fall back to the
     src flag, because a base-game guide can still route through the DLC. */
  function worldFor(g) {
    var steps = Array.isArray(g.route) ? g.route : [];
    for (var i = 0; i < steps.length; i++) {
      var pinId = steps[i] && steps[i].pin;
      if (!pinId) continue;
      var p = ER.byId ? ER.byId(pinId) : null;
      if (p && p.world) return p.world;
    }
    return g.src === 'sote' ? 'shadow' : 'lands';
  }

  function hasMap() {
    var pins = ER.data && ER.data.mapPins;
    return Array.isArray(pins) && pins.length > 0;
  }

  /* ------------------------------------------------------------ the cards */
  /* The card icon is the guide's first LATE-game weapon: the thing the build
     becomes. Mid and early are the fallbacks, and any iconed entity after
     that, so a guide still gets a face while the gear datasets are landing. */
  function cardIcon(g) {
    var phases = [g.gear && g.gear.late, g.gear && g.gear.mid, g.gear && g.gear.early];
    var relaxed = null;
    for (var p = 0; p < phases.length; p++) {
      var list = Array.isArray(phases[p]) ? phases[p] : [];
      for (var i = 0; i < list.length; i++) {
        var rec = ER.byId ? ER.byId(list[i]) : null;
        if (!rec || !rec.icon) continue;
        if (ER.groupOf && ER.groupOf(rec.id) === 'weapons') return rec;
        if (!relaxed) relaxed = rec;
      }
    }
    return relaxed;
  }

  function primaryStats(g) {
    var pr = (g.stats && Array.isArray(g.stats.priority)) ? g.stats.priority : [];
    return pr.slice(0, 3).map(function (k) {
      return SHORT[k] || String(k || '').toUpperCase();
    });
  }

  function classNameOf(g) {
    if (g.className) return g.className;
    var rec = g.classId && ER.byId ? ER.byId(g.classId) : null;
    return (rec && rec.name) || '';
  }

  function cardHtml(g) {
    var ic = cardIcon(g);
    var stats = primaryStats(g);
    var cls = classNameOf(g);
    return (
      '<button class="gcard" type="button" data-guide="' + esc(g.slug || g.id) + '">' +
      '<span class="gc-rule" aria-hidden="true"></span>' +
      '<span class="gc-head">' +
      iconHtml(ic, '&#9876;', 's44') +
      '<span class="gc-heads">' +
      '<span class="gc-n">' + esc(g.name || g.slug || '') + '</span>' +
      (cls ? '<span class="gc-c">' + esc(cls) + '</span>' : '') +
      '</span>' +
      '<span class="gc-flags">' + srcBadge(g) + pipsHtml(g.difficulty) + '</span>' +
      '</span>' +
      (g.tagline ? '<span class="gc-t">' + esc(g.tagline) + '</span>' : '') +
      (stats.length
        ? '<span class="gc-stats">' + stats.map(function (s, i) {
            return '<span class="gc-stat' + (i === 0 ? ' lead' : '') + '">' + esc(s) + '</span>';
          }).join('') + '</span>'
        : '') +
      '<span class="gc-go" aria-hidden="true">Read the build &rsaquo;</span>' +
      '</button>'
    );
  }

  function listHtml() {
    var vis = visibleGuides();
    if (!vis.length) {
      var total = guides().length;
      var hidden = total - vis.length;
      return (
        '<div class="panel empty-panel">' +
        '<p>' + (total === 0
          ? 'No build guides are in this data pull yet. Twelve archetypes are being written - each one arrives with a full route, stat targets and at least two variants.'
          : 'Every guide in this pull needs Shadow of the Erdtree. Turn the expansion on to read them.') + '</p>' +
        (hidden > 0 && total > 0
          ? '<p class="faint">' + hidden + ' guide' + (hidden === 1 ? '' : 's') + ' hidden by the expansion toggle.</p>'
          : '') +
        '</div>'
      );
    }
    var hiddenCount = guides().length - vis.length;
    return (
      '<div class="gcards">' + vis.map(cardHtml).join('') + '</div>' +
      (hiddenCount > 0
        ? '<p class="bhidden faint">' + hiddenCount + ' expansion build' + (hiddenCount === 1 ? '' : 's') +
          ' hidden while Shadow of the Erdtree is off.</p>'
        : '')
    );
  }

  /* ------------------------------------------------------- the guide page */
  function targetsHtml(g) {
    var t = (g.stats && Array.isArray(g.stats.targets)) ? g.stats.targets : [];
    if (!t.length) return '';
    var cls = g.classId && ER.byId ? ER.byId(g.classId) : null;
    var runes = (ER.data && ER.data.mechanics && Array.isArray(ER.data.mechanics.runeCost))
      ? ER.data.mechanics.runeCost : null;
    var baseTotal = null;
    if (runes && cls && cls.level) {
      var b = runes[Number(cls.level) - 1];
      if (b && typeof b.total === 'number') baseTotal = b.total;
    }
    function runeCell(level) {
      if (baseTotal === null) return '';
      var row = runes[Number(level) - 1];
      if (!row || typeof row.total !== 'number') return '<span>-</span>';
      var spent = row.total - baseTotal;
      return '<span>' + esc(ER.fmt ? ER.fmt.num(spent) : String(spent)) + '</span>';
    }
    var head =
      '<div class="tt-head"><span>Lv</span>' +
      STATS.map(function (s) { return '<span>' + esc(SHORT[s]) + '</span>'; }).join('') +
      (baseTotal !== null ? '<span>Runes</span>' : '') + '</div>';
    var rows = t.map(function (row) {
      return (
        '<div class="tt-row"><span class="tt-l">' + esc(ER.fmt ? ER.fmt.num(row.level) : row.level) + '</span>' +
        STATS.map(function (s) {
          var v = row[s];
          var lead = (g.stats.priority || []).indexOf(s) === 0;
          return '<span' + (lead ? ' class="hi"' : '') + '>' +
            esc(typeof v === 'number' ? String(v) : '-') + '</span>';
        }).join('') +
        runeCell(row.level) + '</div>'
      );
    }).join('');
    return (
      '<div class="ttwrap"><div class="ttable' + (baseTotal !== null ? ' with-runes' : '') + '">' + head + rows + '</div></div>' +
      (baseTotal !== null
        ? '<p class="e-note">Runes are what the whole climb costs from the ' + esc(classNameOf(g) || 'starting class') +
          ' start - not per level.</p>'
        : '')
    );
  }

  function priorityHtml(g) {
    var pr = (g.stats && Array.isArray(g.stats.priority)) ? g.stats.priority : [];
    if (!pr.length) return '';
    return (
      '<ol class="prio">' + pr.map(function (s, i) {
        return (
          '<li class="prio-i"><span class="prio-n">' + (i + 1) + '</span>' +
          '<span class="prio-k">' + esc(SHORT[s] || String(s).toUpperCase()) + '</span>' +
          '<span class="prio-l">' + esc(ER.fmt ? ER.fmt.stat(s) : s) + '</span></li>'
        );
      }).join('') + '</ol>'
    );
  }

  function gearHtml(g) {
    var phases = [['early', 'Early'], ['mid', 'Mid'], ['late', 'Late']];
    var any = false;
    var body = phases.map(function (p) {
      var ids = (g.gear && Array.isArray(g.gear[p[0]])) ? g.gear[p[0]] : [];
      if (!ids.length) return '';
      any = true;
      return (
        '<div class="phase">' +
        '<h4 class="phase-h"><span class="phase-tag">' + esc(p[1]) + '</span></h4>' +
        entityRows(g, ids, '&#9876;') + '</div>'
      );
    }).join('');
    return any ? body : '';
  }

  function kitHtml(g) {
    return KIT.map(function (k) {
      var ids = Array.isArray(g[k[0]]) ? g[k[0]] : [];
      if (!ids.length) return '';
      return (
        '<div class="phase">' +
        '<h4 class="phase-h"><span class="phase-tag">' + esc(k[1]) + '</span></h4>' +
        entityRows(g, ids, k[2]) + '</div>'
      );
    }).join('');
  }

  function stepHtml(g, s, idx) {
    var n = typeof s.step === 'number' ? s.step : idx + 1;
    var region = s.regionName || '';
    if (!region && s.region) region = nameOf(g, s.region);
    var gear = stepGear(s);
    var canMap = !!(s.pin && hasMap());
    return (
      '<li class="rstep">' +
      '<span class="rs-n" aria-hidden="true">' + esc(String(n)) + '</span>' +
      '<div class="rs-body">' +
      (region ? '<span class="rs-region">' + esc(region) + '</span>' : '') +
      '<p class="rs-t">' + esc(s.text || '') + '</p>' +
      (gear.length ? entityRows(g, gear, '&#127746;') : '') +
      (s.boss ? '<div class="brows boss">' + entityRow(g, s.boss, '&#128128;') + '</div>' : '') +
      /* A text glyph, not the pushpin emoji: emoji render in their own colour,
         and a bright pink pin is the one thing on this page that is not gold. */
      (canMap
        ? '<button class="rs-map" type="button" data-step-map="' + esc(s.pin) + '" data-step-world="' + esc(worldFor(g)) + '">' +
          '<span class="rs-map-ic" aria-hidden="true">&#9678;</span> Show on map</button>'
        : '') +
      '</div></li>'
    );
  }

  /* Authors write act headings ("Early (target: level 40 by the end of
     Stormveil)") and the occasional paragraph between numbered steps. The
     compiler keeps them as routeNotes carrying the step number they follow, so
     they are put back exactly where they were written rather than collected in
     a lump at the top - the level target belongs ON the act it describes. */
  function notesAfter(notes, n, dlc) {
    return notes.filter(function (x) {
      return x && !!x.dlc === !!dlc && Number(x.after || 0) === n;
    });
  }

  function noteHtml(x) {
    if (x.heading) {
      return '<li class="ract"><span class="ract-l">' + esc(x.text) + '</span></li>';
    }
    return '<li class="rnote"><p>' + esc(x.text) + '</p></li>';
  }

  function routeList(g, steps, notes, dlc, cls) {
    if (!steps.length) return '';
    /* A note is anchored to the step it FOLLOWS. The DLC list starts partway
       through the numbering, and its opening paragraph is written under the
       sub-heading - so its anchor is the last BASE step, a number this list
       does not contain. Anything anchored before the first step of this list
       belongs at its top rather than nowhere. */
    var firstN = typeof steps[0].step === 'number' ? steps[0].step : 1;
    var mine = notes.filter(function (x) { return x && !!x.dlc === !!dlc; });
    var out = '<ol class="route' + (cls ? ' ' + cls : '') + '">';
    out += mine.filter(function (x) { return Number(x.after || 0) < firstN; }).map(noteHtml).join('');
    steps.forEach(function (s, i) {
      out += stepHtml(g, s, i);
      out += notesAfter(mine, typeof s.step === 'number' ? s.step : i + 1, dlc).map(noteHtml).join('');
    });
    return out + '</ol>';
  }

  function routeHtml(g) {
    var steps = Array.isArray(g.route) ? g.route : [];
    if (!steps.length) return '';
    var notes = Array.isArray(g.routeNotes) ? g.routeNotes : [];
    var base = steps.filter(function (s) { return !s.dlc; });
    var dlc = steps.filter(function (s) { return !!s.dlc; });
    var out = routeList(g, base, notes, false, '');
    if (dlc.length && ER.srcOn && ER.srcOn('sote')) {
      out +=
        '<div class="filigree"><span>Shadow of the Erdtree</span></div>' +
        routeList(g, dlc, notes, true, 'dlc');
    } else if (dlc.length) {
      out += '<p class="e-note">' + dlc.length + ' further step' + (dlc.length === 1 ? '' : 's') +
        ' run through Shadow of the Erdtree. Turn the expansion on to read them.</p>';
    }
    return out;
  }

  function swapsHtml(g, swaps) {
    var list = Array.isArray(swaps) ? swaps : [];
    if (!list.length) return '';
    return '<div class="swaps">' + list.map(function (sw) {
      var from = sw.fromId ? nameOf(g, sw.fromId) : (sw.from || '');
      var to = sw.toId ? nameOf(g, sw.toId) : (sw.to || '');
      return (
        '<div class="swap">' +
        (sw.fromId
          ? '<button class="swap-side" type="button" data-entity="' + esc(sw.fromId) + '">' + esc(from) + '</button>'
          : '<span class="swap-side flat">' + esc(from) + '</span>') +
        '<span class="swap-arrow" aria-hidden="true">&rarr;</span>' +
        (sw.toId
          ? '<button class="swap-side to" type="button" data-entity="' + esc(sw.toId) + '">' + esc(to) + '</button>'
          : '<span class="swap-side to flat">' + esc(to) + '</span>') +
        '</div>'
      );
    }).join('') + '</div>';
  }

  function variantsHtml(g) {
    var vs = Array.isArray(g.variants) ? g.variants : [];
    if (!vs.length) return '';
    return vs.map(function (v) {
      var deltas = Array.isArray(v.route) ? v.route : [];
      var visibleDeltas = deltas.filter(function (s) {
        return !s.dlc || (ER.srcOn && ER.srcOn('sote'));
      });
      return (
        '<article class="variant">' +
        '<h4 class="var-n">' + esc(v.name || 'Variant') + '</h4>' +
        (variantTwist(v) ? '<p class="var-twist">' + esc(variantTwist(v)) + '</p>' : '') +
        swapsHtml(g, v.swaps) +
        proseHtml(v.notes, 'var-note') +
        (visibleDeltas.length
          ? '<div class="var-route"><h5 class="var-rh">Route changes</h5>' +
            routeList(g, visibleDeltas, Array.isArray(v.routeNotes) ? v.routeNotes : [], false, 'small') +
            '</div>'
          : '') +
        '</article>'
      );
    }).join('');
  }

  function guideHtml(g) {
    var cls = classNameOf(g);
    var mapOk = hasMap() && Array.isArray(g.route) && g.route.length > 0;
    /* A guide with no src badge, no class and no difficulty (the shape the
       fixture ships) must not leave an empty row holding open a gap. */
    var meta =
      srcBadge(g) +
      (cls ? '<span class="wchip tiny">' + esc(cls) + '</span>' : '') +
      (g.difficulty ? '<span class="gh-diff"><span class="gh-dl">Difficulty</span>' + pipsHtml(g.difficulty) + '</span>' : '');
    return (
      '<button class="bback" type="button" data-bback>&larr; All builds</button>' +
      '<article class="guide">' +
      '<header class="gh">' +
      '<span class="gh-rule" aria-hidden="true"></span>' +
      '<div class="gh-top">' +
      iconHtml(cardIcon(g), '&#9876;', 's64') +
      '<div class="gh-heads">' +
      '<h1 class="gh-n">' + esc(g.name || g.slug || '') + '</h1>' +
      (g.tagline ? '<p class="gh-t">' + esc(g.tagline) + '</p>' : '') +
      '</div></div>' +
      (meta ? '<div class="gh-meta">' + meta + '</div>' : '') +
      (g.fantasy ? '<p class="gh-f">' + esc(g.fantasy) + '</p>' : '') +
      '</header>' +

      '<div class="gacts">' +
      '<button class="btn primary" type="button" data-guide-act="planner">Load into Planner</button>' +
      (mapOk ? '<button class="btn" type="button" data-guide-act="map">Show route on Map</button>' : '') +
      '</div>' +

      section('Where the points go', priorityHtml(g) + targetsHtml(g), 'sec-stats') +
      section('Gear by phase', gearHtml(g), 'sec-gear') +
      section('The rest of the kit', kitHtml(g), 'sec-kit') +
      section('The route', routeHtml(g), 'sec-route') +
      section('Variants', variantsHtml(g), 'sec-var') +
      section('In PvP', proseHtml(pvpOf(g)), 'sec-pvp') +
      section('Your first hour', proseHtml(g.firstHour), 'sec-first') +
      section('Why it works', proseHtml(whyOf(g)), 'sec-why') +
      '</article>'
    );
  }

  /* --------------------------------------------------------- the planner */
  function plannerHtml() {
    return '<div class="planner-host" data-planner-host></div>';
  }

  function mountPlanner() {
    var host = S.pane && S.pane.querySelector('[data-planner-host]');
    if (!host) return;
    S.plannerHost = host;
    if (ER.planner && typeof ER.planner.mount === 'function') {
      if (!S.plannerMounted) {
        S.plannerMounted = true;
        try {
          ER.planner.mount(host);
        } catch (e) {
          S.plannerMounted = false;
          host.innerHTML =
            '<div class="panel err-panel"><h2 class="err-h">The planner failed to start</h2>' +
            '<p class="err-p">' + esc((e && e.message) || 'unknown error') + '</p></div>';
          return;
        }
      }
      if (S.plannerSlug && typeof ER.planner.loadGuide === 'function') {
        try {
          ER.planner.loadGuide(S.plannerSlug);
        } catch (e2) {}
      }
      return;
    }
    /* No planner lane yet. Say so plainly and keep the guide the player asked
       to load named, so the tap was not silently swallowed. */
    var g = S.plannerSlug ? guideBySlug(S.plannerSlug) : null;
    host.innerHTML =
      '<div class="panel soon-panel">' +
      '<h2 class="soon-h">Planner</h2>' +
      '<p class="soon-p">The stat planner - sliders, soft-cap bars, equip load and true attack power at your own stats - is not in this build yet. ' +
      'The guides beside it are complete and carry their own level targets.</p>' +
      (g ? '<p class="soon-p">Waiting to load: <b>' + esc(g.name || g.slug) + '</b>.</p>' : '') +
      '</div>';
  }

  /* ----------------------------------------------------------- rendering */
  function stampHtml() {
    var meta = (ER.data && ER.data.meta) || {};
    var bits = [];
    if (meta.gameVersion) bits.push('Patch ' + meta.gameVersion);
    if (meta.dlcVersion) bits.push('DLC ' + meta.dlcVersion);
    if (meta.pulledAt) bits.push('checked ' + (ER.fmt ? ER.fmt.date(meta.pulledAt) : String(meta.pulledAt).slice(0, 10)));
    if (!bits.length) return '';
    return '<p class="bstamp">' + esc(bits.join(' - ')) + '</p>';
  }

  function segHtml() {
    var segs = [['guides', 'Guides'], ['planner', 'Planner']];
    return (
      '<div class="bsegs" role="tablist" aria-label="Builds sections">' +
      segs.map(function (s) {
        var on = S.seg === s[0];
        return (
          '<button class="bseg' + (on ? ' on' : '') + '" type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') +
          '" data-bseg="' + s[0] + '">' + esc(s[1]) + '</button>'
        );
      }).join('') + '</div>'
    );
  }

  function bodyEl() {
    return S.pane ? S.pane.querySelector('[data-builds-body]') : null;
  }

  function paintSegs() {
    if (!S.pane) return;
    var bar = S.pane.querySelector('.bsegs');
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll('[data-bseg]'), function (b) {
      var on = b.getAttribute('data-bseg') === S.seg;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function render() {
    var body = bodyEl();
    if (!body) return;
    paintSegs();
    if (S.seg === 'planner') {
      body.innerHTML = plannerHtml();
      mountPlanner();
      return;
    }
    /* A guide that the expansion toggle just hid must not stay on screen. */
    if (S.slug) {
      var g = guideBySlug(S.slug);
      if (!g) {
        S.slug = null;
      } else if (ER.srcOn && !ER.srcOn(g.src)) {
        S.slug = null;
        if (ER.toast) ER.toast('That build needs Shadow of the Erdtree');
      }
    }
    if (S.slug) {
      var open = guideBySlug(S.slug);
      body.innerHTML = guideHtml(open);
      body.scrollTop = 0;
    } else {
      body.innerHTML = listHtml();
    }
  }

  function goList() {
    S.slug = null;
    S.seg = 'guides';
    ER.navigate('builds', []);
  }

  function openGuide(slug) {
    var g = guideBySlug(slug);
    if (!g) {
      if (ER.toast) ER.toast('That build is not in this pull');
      return;
    }
    S.seg = 'guides';
    S.slug = g.slug || g.id;
    ER.navigate('builds', [S.slug]);
  }

  /* ------------------------------------------------------------- actions */
  function loadIntoPlanner() {
    var g = S.slug ? guideBySlug(S.slug) : null;
    if (!g) return;
    ER.navigate('builds', ['planner', g.slug || g.id]);
  }

  function showRouteOnMap() {
    var g = S.slug ? guideBySlug(S.slug) : null;
    if (!g) return;
    var slug = g.slug || g.id;
    ER.navigate('map', [worldFor(g), 'guide', slug]);
    try {
      if (ER.mapApi && typeof ER.mapApi.showRoute === 'function') ER.mapApi.showRoute(slug);
    } catch (e) {}
  }

  function focusStepPin(pinId, world) {
    ER.navigate('map', [world || 'lands', 'pin', pinId]);
    try {
      if (ER.mapApi && typeof ER.mapApi.focusPin === 'function') ER.mapApi.focusPin(pinId);
    } catch (e) {}
  }

  /* ------------------------------------------------------------ wiring */
  function bind(el) {
    el.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var seg = t.closest('[data-bseg]');
      if (seg) {
        var id = seg.getAttribute('data-bseg');
        if (id === 'planner') ER.navigate('builds', ['planner']);
        else if (S.slug) ER.navigate('builds', [S.slug]);
        else ER.navigate('builds', []);
        return;
      }
      if (t.closest('[data-bback]')) {
        goList();
        return;
      }
      var card = t.closest('[data-guide]');
      if (card) {
        openGuide(card.getAttribute('data-guide'));
        return;
      }
      var act = t.closest('[data-guide-act]');
      if (act) {
        if (act.getAttribute('data-guide-act') === 'planner') loadIntoPlanner();
        else showRouteOnMap();
        return;
      }
      var sm = t.closest('[data-step-map]');
      if (sm) {
        e.stopPropagation();
        focusStepPin(sm.getAttribute('data-step-map'), sm.getAttribute('data-step-world'));
      }
      /* [data-entity] is left to the shell's own delegate. */
    });
  }

  /* --------------------------------------------------------------- tab */
  ER.registerTab('builds', {
    label: 'Builds',
    icon: '&#9876;',
    order: 30,

    mount: function (el) {
      S.pane = el;
      S.plannerMounted = false;
      el.innerHTML =
        '<header class="tabhead">' +
        '<h1 class="tabtitle">Builds</h1>' +
        '<p class="tabsub">Twelve archetypes, each written out end to end - what to take, where to get it, and what to put the points in.</p>' +
        stampHtml() +
        '</header>' +
        segHtml() +
        '<div class="bbody" data-builds-body></div>';
      bind(el);
      render();
    },

    /* #builds | #builds/<guide-slug> | #builds/planner | #builds/planner/<guide> */
    show: function (params) {
      var p = params || [];
      if (p[0] === 'planner') {
        S.seg = 'planner';
        if (p[1]) S.plannerSlug = String(p[1]);
        render();
        if (ER.planner && typeof ER.planner.show === 'function') {
          try {
            ER.planner.show(p.slice(1));
          } catch (e) {}
        }
        return;
      }
      S.seg = 'guides';
      S.slug = p[0] ? String(p[0]) : null;
      render();
    },

    hide: function () {},

    /* The shell already searches every entity by name; the tab contributes the
       one thing only it knows - which archetype a phrase belongs to. */
    search: function (q) {
      var ql = String(q || '').toLowerCase().trim();
      if (!ql) return [];
      return visibleGuides().filter(function (g) {
        var hay = ((g.name || '') + ' ' + (g.tagline || '') + ' ' + (g.slug || '')).toLowerCase();
        return hay.indexOf(ql) !== -1;
      }).slice(0, 6).map(function (g) {
        return {
          title: g.name || g.slug,
          sub: g.tagline || 'Build guide',
          icon: '&#9876;',
          go: function () {
            openGuide(g.slug || g.id);
          }
        };
      });
    }
  });

  /* The expansion toggle changes which guides exist and which route steps are
     readable, so the whole tab repaints - including bouncing off a guide that
     has just been hidden. */
  if (typeof ER.onModeChange === 'function') {
    ER.onModeChange(function () {
      if (S.pane && S.seg === 'guides') render();
    });
  }
})();
