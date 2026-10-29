/* start.js - the Start tab: the first surface a newcomer sees.
 *
 * OWNED BY: P3 L5 (shell + Start + Wiki).
 *
 * Everything here answers one of four beginner questions, in order:
 *   "what do I do first"      -> the first-ten-minutes walkthrough (data/start.json)
 *   "who should I play"       -> the class shortlist (start.classPicks + classes)
 *   "what does that word mean"-> the glossary, searchable on its own
 *   "am I being told about the expansion I have not bought"
 *                             -> the Shadow of the Erdtree switch, off by default
 * and it closes with the two things a recommendation is worthless without:
 * WHEN the data was pulled and WHERE it came from.
 *
 * All copy in this file is original. The only text taken from the dataset is
 * the dataset's own (step text, class descriptions, glossary definitions,
 * attribution), and it is escaped on the way in.
 */
(function () {
  'use strict';

  var ER = window.ER;
  if (!ER) return;
  var esc = ER.esc;

  var S = { pane: null, gloss: '' };

  /* ------------------------------------------------------------------ hero */
  function hero() {
    return (
      '<section class="hero">' +
      '<span class="hero-sweep" aria-hidden="true"></span>' +
      '<span class="hero-grace" aria-hidden="true">&#9737;</span>' +
      '<h1 class="hero-title">Elden Ring</h1>' +
      '<p class="hero-sub">A companion for people who are lost - and for people who have been here before and ' +
      'want the number, not the essay.</p>' +
      '<div class="hero-cta">' +
      '<button class="btn primary" type="button" data-go="wiki">Look something up</button>' +
      '<button class="btn" type="button" data-go="builds">Get a build</button>' +
      '</div>' +
      '<p class="hero-stamp">' + esc(ER.stampText()) + '</p>' +
      '</section>' +
      '<div class="filigree" aria-hidden="true"><span>&#9670;</span></div>'
    );
  }

  /* --------------------------------------------------- your first 10 minutes */
  function firstSteps() {
    var steps = (ER.data.start && ER.data.start.steps) || [];
    if (!steps.length) return '';
    return (
      '<section class="panel">' +
      '<h2 class="ph">Your first ten minutes</h2>' +
      '<p class="psub">The game explains almost nothing on purpose. This is the part it leaves out.</p>' +
      '<ol class="steps">' +
      steps
        .map(function (s, i) {
          var link = s.link && /^#/.test(String(s.link))
            ? '<button class="steplink" type="button" data-hash="' + esc(s.link) + '">Take me there</button>'
            : '';
          return (
            '<li class="step"><span class="step-n" aria-hidden="true">' + (i + 1) + '</span>' +
            '<span class="step-b"><span class="step-t">' + esc(s.title) + '</span>' +
            '<span class="step-x">' + esc(s.text) + '</span>' + link + '</span></li>'
          );
        })
        .join('') +
      '</ol></section>'
    );
  }

  /* ------------------------------------------------------- pick your class */
  function classPicks() {
    var picks = (ER.data.start && ER.data.start.classPicks) || [];
    var rows = picks
      .map(function (p) {
        var c = ER.byId(p.classId);
        if (!c || !ER.srcOn(c.src)) return '';
        var st = c.stats || {};
        var top = ['vig', 'mind', 'end', 'str', 'dex', 'int', 'fai', 'arc']
          .slice()
          .sort(function (a, b) {
            return (st[b] || 0) - (st[a] || 0);
          })
          .slice(0, 3);
        return (
          '<button class="cpick" type="button" data-entity="' + esc(c.id) + '">' +
          '<span class="cpick-head"><span class="cpick-n">' + esc(c.name) + '</span>' +
          '<span class="cpick-l">Level ' + esc(ER.fmt.num(c.level)) + '</span></span>' +
          '<span class="cpick-why">' + esc(p.reason) + '</span>' +
          '<span class="cpick-stats">' +
          top
            .map(function (k) {
              return '<span class="cs"><b>' + esc(ER.fmt.num(st[k])) + '</b> ' + esc(ER.fmt.stat(k)) + '</span>';
            })
            .join('') +
          '</span></button>'
        );
      })
      .join('');
    if (!rows) return '';
    return (
      '<section class="panel">' +
      '<h2 class="ph">Pick a class you can grow out of</h2>' +
      '<p class="psub">A class is a head start, not a cage - every stat is levellable and every weapon is ' +
      'learnable. Pick the one whose first hour sounds fun.</p>' +
      '<div class="cpicks">' + rows + '</div>' +
      '<button class="btn ghost wide" type="button" data-go-seg="classes">See every starting class</button>' +
      '</section>'
    );
  }

  /* ---------------------------------------------------------------- glossary */
  function glossaryRows() {
    var g = ER.data.glossary || [];
    var q = S.gloss.trim().toLowerCase();
    var rows = g.filter(function (x) {
      if (!x || !x.term) return false;
      if (!q) return true;
      return (
        String(x.term).toLowerCase().indexOf(q) !== -1 ||
        String(x.def || '').toLowerCase().indexOf(q) !== -1
      );
    });
    if (!rows.length) return '<p class="e-p faint">No word here matches that.</p>';
    return (
      '<dl class="gloss">' +
      rows
        .map(function (x) {
          return (
            '<div class="gl-row"><dt class="gl-t">' + esc(x.term) + '</dt>' +
            '<dd class="gl-d">' + esc(x.def) + '</dd></div>'
          );
        })
        .join('') +
      '</dl>'
    );
  }
  function glossary() {
    if (!(ER.data.glossary || []).length) return '';
    return (
      '<section class="panel">' +
      '<h2 class="ph">Words you will hear</h2>' +
      '<p class="psub">Every term the game, this app and every other player use without ever defining.</p>' +
      '<input id="glossSearch" class="wsearch" type="search" placeholder="Find a word" aria-label="Find a word" data-gloss-q value="' + esc(S.gloss) + '" />' +
      '<div data-gloss-list>' + glossaryRows() + '</div>' +
      '</section>'
    );
  }

  /* --------------------------------------------------------------- dlc panel */
  function dlcPanel() {
    var on = !!ER.modes.sote;
    return (
      '<section class="panel dlc-panel">' +
      '<h2 class="ph">Shadow of the Erdtree</h2>' +
      '<p class="psub">The expansion is a separate purchase and a separate world. Leave it off and nothing from ' +
      'it appears anywhere in this app - no weapons, no bosses, no map pins, nothing to spoil.</p>' +
      '<label class="bigtog">' +
      '<span class="bigtog-b"><span class="bigtog-t">Include Shadow of the Erdtree</span>' +
      '<span class="bigtog-s">' + (on ? 'On - the expansion is mixed into every list.' : 'Off - base game only.') + '</span></span>' +
      '<span class="mod-tog' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') +
      '" data-modetoggle="sote" tabindex="0"></span>' +
      '</label>' +
      '</section>'
    );
  }

  /* ------------------------------------------------------- patch + freshness */
  function patchPanel() {
    var meta = ER.data.meta || {};
    var m = ER.data.mechanics || {};
    var rows = [
      ['Game version the numbers describe', meta.gameVersion ? 'Patch ' + meta.gameVersion : null],
      ['Expansion version', meta.dlcVersion || null],
      ['Expansion data included in the pull', meta.dlcIncluded ? 'Yes' : null],
      ['Latest patch notes seen on the source wiki', m.patchNotesLatestOnWiki || null],
      /* Provenance, not decoration: every attack-power number in this app is
         read out of one named file, and naming it is how a reader can tell
         whether the maths is current without taking our word for it. */
      ['Weapon maths read from', (meta.regulation && meta.regulation.file) || null],
      ['Data pulled', meta.pulledAt ? ER.fmt.date(meta.pulledAt) : null]
    ].filter(function (r) {
      return r[1];
    });
    /* meta.counts also carries pipeline bookkeeping (start, meta, map-manifest)
       that means nothing to a player. Only the datasets a person can actually
       browse are shown, in a fixed reading order, with their plural label
       written here rather than derived - "6 armor-sets" is not English. */
    var COUNT_LABELS = [
      ['weapons', 'weapons and shields'],
      ['armor', 'armour pieces'],
      ['talismans', 'talismans'],
      ['spells', 'spells'],
      ['ashes', 'Ashes of War'],
      ['spirits', 'Spirit Ashes'],
      ['items', 'items'],
      ['bosses', 'bosses'],
      ['graces', 'Sites of Grace'],
      ['regions', 'regions'],
      ['npcs', 'NPCs'],
      ['quests', 'questlines'],
      ['guides', 'build guides'],
      ['map-pins', 'map pins']
    ];
    var counts = meta.counts || {};
    var countRow = COUNT_LABELS.filter(function (p) {
      return typeof counts[p[0]] === 'number' && counts[p[0]] > 0;
    })
      .map(function (p) {
        return '<span class="cnt"><b>' + esc(ER.fmt.num(counts[p[0]])) + '</b> ' + esc(p[1]) + '</span>';
      })
      .join('');
    var gaps = (m.gaps || []).length
      ? '<details class="gaps"><summary>What this data does not have (' + (m.gaps || []).length + ')</summary><ul>' +
        m.gaps
          .map(function (g) {
            return '<li>' + esc(g) + '</li>';
          })
          .join('') +
        '</ul><p class="e-note">These are left empty on purpose. An invented number would be worse than a gap.</p></details>'
      : '';
    if (!rows.length && !countRow) return '';
    return (
      '<section class="panel">' +
      '<h2 class="ph">How current this is</h2>' +
      '<p class="psub">A recommendation with no date is a claim with no expiry.</p>' +
      '<div class="stat-table">' +
      rows
        .map(function (r) {
          return '<div class="st-row"><span class="st-k">' + esc(r[0]) + '</span><span class="st-v">' + esc(r[1]) + '</span></div>';
        })
        .join('') +
      '</div>' +
      (countRow ? '<div class="counts">' + countRow + '</div>' : '') +
      gaps +
      '</section>'
    );
  }

  /* ------------------------------------------------------------- attribution */
  function attribution() {
    var meta = ER.data.meta || {};
    var sources = (meta.sources || [])
      .map(function (s) {
        return (
          '<li><span class="srcname">' + esc(s.name) + '</span>' +
          '<span class="srclic">' + esc(s.licence) + '</span>' +
          (s.usedFor ? '<span class="srcuse">' + esc(s.usedFor) + '</span>' : '') + '</li>'
        );
      })
      .join('');
    if (!meta.attribution && !sources) return '';
    return (
      '<section class="panel attrib">' +
      '<h2 class="ph">Where this comes from</h2>' +
      (sources ? '<ul class="srclist">' + sources + '</ul>' : '') +
      (meta.attribution ? '<p class="attrib-p">' + esc(meta.attribution) + '</p>' : '') +
      '</section>'
    );
  }

  function render() {
    if (!S.pane) return;
    S.pane.innerHTML =
      hero() + firstSteps() + classPicks() + glossary() + dlcPanel() + patchPanel() + attribution();
  }

  ER.registerTab('start', {
    label: 'Start',
    icon: '&#127775;',
    order: 10,
    mount: function (el) {
      S.pane = el;
      render();
    },
    show: function () {},
    hide: function () {},
    search: function (q) {
      var ql = String(q || '').toLowerCase();
      var steps = (ER.data.start && ER.data.start.steps) || [];
      return steps
        .filter(function (s) {
          return String(s.title || '').toLowerCase().indexOf(ql) !== -1;
        })
        .map(function (s) {
          return {
            title: s.title,
            sub: 'First ten minutes',
            icon: '&#127775;',
            go: function () {
              ER.navigate('start', []);
            }
          };
        });
    }
  });

  ER.onModeChange(function () {
    if (S.pane) render();
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var go = t.closest('[data-go]');
    if (go) {
      ER.navigate(go.getAttribute('data-go'), []);
      return;
    }
    var seg = t.closest('[data-go-seg]');
    if (seg) {
      ER.navigate('wiki', [seg.getAttribute('data-go-seg')]);
      return;
    }
    var h = t.closest('[data-hash]');
    if (h) followHash(h.getAttribute('data-hash'));
  });

  /* data/start.json carries its own link strings, and the pipeline is allowed
     to write them in the long form (#tab/wiki/entity/<id>) as well as the app's
     own short form (#wiki/<group>/<slug>). Both are accepted, and a link this
     build cannot resolve lands on the Start tab instead of a blank pane - a
     step in the first-ten-minutes list must never be a dead end. */
  function followHash(raw) {
    var parts = String(raw || '')
      .replace(/^#\/?/, '')
      .split('/')
      .filter(Boolean);
    if (parts[0] === 'tab') parts.shift();
    var ei = parts.indexOf('entity');
    if (ei !== -1) {
      var id = parts[ei + 1];
      var rec = id ? ER.byId(id) : null;
      if (rec) {
        ER.openEntity(rec.id);
        return;
      }
      parts = parts.slice(0, ei);
    }
    ER.navigate(parts[0] || 'start', parts.slice(1));
  }

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-gloss-q')) return;
    S.gloss = t.value || '';
    var host = S.pane && S.pane.querySelector('[data-gloss-list]');
    if (host) host.innerHTML = glossaryRows();
  });
})();
