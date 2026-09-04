/* tracker.js - the Tracker tab and the save-file import (lane P3 L8).
 *
 * WHAT THIS TAB IS FOR. Elden Ring has no in-game checklist. A returning
 * player cannot answer "which of these graces have I already lit" without
 * standing in front of one. So this tab keeps the answer: bosses by region,
 * graces by region, questlines step by step, and the collectibles that are
 * easy to miss - each with a real denominator taken from the data, never a
 * typed number.
 *
 * THE TWO LAYERS (the Isaac tracker's shape, projects/binding-of-isaac/
 * tracker/app.js). Every profile carries `imported` (what the save file said)
 * and `manual` (what you ticked yourself). Reading takes manual first and
 * falls back to imported, so a hand tick always wins. Writing is where the
 * subtlety is: if your tick lands on the SAME value the save already has, the
 * override is DELETED rather than stored. That is what keeps a re-import from
 * being fought by a hundred stale overrides - after a re-import the profile
 * only remembers the places where you and the file actually disagree.
 *
 * THE MISSABLES ALARM. Elden Ring's questlines end silently. Kill Godrick
 * before Nepheli's step and the line is simply gone, with no message. So
 * before a boss that is a lockout reference of an UNFINISHED quest step can be
 * ticked, a confirm sheet names every questline that ends with it. This is the
 * one place the tracker interrupts you, and it is the reason the tab exists.
 *
 * OWNERSHIP (island RULES R7): this lane owns js/tracker.js, js/saveparse.js,
 * js/saveparse.worker.js, css/tracker.css and tools/test-saveparse.mjs. Every
 * shared surface is reached through window.ER; nothing here edits app.js, and
 * nothing here writes any localStorage key but elden_tracker_v1.
 *
 * Note on click plumbing: js/wiki.js listens at the document for
 * [data-tracker-toggle], so this pane uses [data-ert-toggle] instead. Two
 * handlers on one attribute would toggle twice and look like nothing
 * happened. Entity links reuse [data-entity] and map links reuse [data-pin] -
 * those ARE the shared conventions and are handled once, elsewhere.
 */
(function () {
  'use strict';

  var ER = (window.ER = window.ER || {});
  var KEY = 'elden_tracker_v1';
  var BST_URL = '/island/apps/elden/data/eventflag_bst.json'; /* rewritten by the assembler */
  var WORKER_URL = '/island/apps/elden/js/saveparse.worker.js'; /* ditto */

  function esc(s) {
    return ER.esc ? ER.esc(s) : String(s === null || s === undefined ? '' : s);
  }
  function num(n) {
    return ER.fmt && ER.fmt.num ? ER.fmt.num(n) : String(n);
  }
  function srcOn(src) {
    return ER.srcOn ? ER.srcOn(src) : true;
  }
  function arr(k) {
    var a = ER.data && ER.data[k];
    return Array.isArray(a) ? a : [];
  }
  function toast(m) {
    try {
      if (typeof ER.toast === 'function') ER.toast(m);
    } catch (e) {}
  }

  /* ======================================================================
   * 1. STORE - one localStorage key, three layers deep, nothing else
   * ====================================================================== */

  var BLOB = null;
  var saveTimer = null;
  var CHANGE_CBS = [];

  function blankProfile(id, name) {
    return {
      id: id,
      name: String(name || 'Tarnished').slice(0, 40),
      manual: {},
      imported: {},
      importedAt: null,
      importedFrom: null,
      ngPlus: 0
    };
  }

  function newId() {
    return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }

  /* Anything unrecognised in storage is repaired into the current shape rather
     than thrown away - a half-written blob from an interrupted save should cost
     you the last tick, not the whole file. */
  function normalise(raw) {
    var out = { v: 1, active: null, profiles: {} };
    if (!raw || typeof raw !== 'object') return out;
    var profs = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
    Object.keys(profs).forEach(function (id) {
      var p = profs[id];
      if (!p || typeof p !== 'object') return;
      var np = blankProfile(id, p.name);
      if (p.manual && typeof p.manual === 'object') {
        Object.keys(p.manual).forEach(function (k) {
          np.manual[k] = p.manual[k] ? 1 : 0;
        });
      }
      if (p.imported && typeof p.imported === 'object') {
        Object.keys(p.imported).forEach(function (k) {
          if (p.imported[k]) np.imported[k] = 1;
        });
      }
      np.importedAt = typeof p.importedAt === 'string' ? p.importedAt : null;
      np.importedFrom = p.importedFrom && typeof p.importedFrom === 'object' ? p.importedFrom : null;
      np.ngPlus = typeof p.ngPlus === 'number' && isFinite(p.ngPlus) ? Math.max(0, Math.min(99, Math.round(p.ngPlus))) : 0;
      out.profiles[id] = np;
    });
    var ids = Object.keys(out.profiles);
    out.active = raw.active && out.profiles[raw.active] ? raw.active : ids[0] || null;
    return out;
  }

  function load() {
    var raw = null;
    try {
      var s = localStorage.getItem(KEY);
      if (s != null) raw = JSON.parse(s);
    } catch (e) {
      raw = null;
    }
    BLOB = normalise(raw);
    if (!BLOB.active) {
      var id = newId();
      BLOB.profiles[id] = blankProfile(id, 'Tarnished');
      BLOB.active = id;
    }
    return BLOB;
  }

  function blob() {
    return BLOB || load();
  }

  function active() {
    var b = blob();
    var p = b.profiles[b.active];
    if (p) return p;
    var first = Object.keys(b.profiles)[0];
    if (first) {
      b.active = first;
      return b.profiles[first];
    }
    var id = newId();
    b.profiles[id] = blankProfile(id, 'Tarnished');
    b.active = id;
    return b.profiles[id];
  }

  /* The pill's state is held in a variable, not just in the DOM: a tick
     re-renders the header, and without this the "saving..." flash would be
     wiped by its own re-render a millisecond after it appeared. paintPill()
     is called again after every header render. */
  var PILL = null;

  function paintPill() {
    var el = document.getElementById('ertSave');
    if (!el) return;
    if (!PILL) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = 'ert-savepill ' + PILL;
    el.textContent = PILL === 'saving' ? 'saving...' : PILL === 'saved' ? 'saved' : 'not saved';
  }

  function pill(state) {
    PILL = state || null;
    paintPill();
    clearTimeout(pill._t);
    if (state === 'saved') {
      pill._t = setTimeout(function () {
        if (PILL === 'saved') {
          PILL = null;
          paintPill();
        }
      }, 1600);
    }
  }

  /* 300 ms debounce: ticking down a region is a burst of a dozen writes and
     only the last one has to reach disk. */
  function saveSoon() {
    pill('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(blob()));
        pill('saved');
      } catch (e) {
        pill('failed');
        toast('Could not save - this browser is out of storage or in private mode.');
      }
    }, 300);
  }

  function emit(id) {
    CHANGE_CBS.forEach(function (cb) {
      try {
        cb(id);
      } catch (e) {}
    });
  }

  /* ------------------------------------------------------------ read/write */

  function isDone(id) {
    if (!id) return false;
    var p = active();
    if (Object.prototype.hasOwnProperty.call(p.manual, id)) return !!p.manual[id];
    return !!p.imported[id];
  }

  /* The heart of the two-layer model - see the file header. */
  function setDone(id, val) {
    if (!id) return;
    var p = active();
    var want = !!val;
    if (!!p.imported[id] === want) delete p.manual[id];
    else p.manual[id] = want ? 1 : 0;
    saveSoon();
    emit(id);
  }

  function toggleId(id) {
    setDone(id, !isDone(id));
  }

  /* ======================================================================
   * 2. CATALOGUE - what there is to tick, and the real denominators
   * ====================================================================== */

  var CAT = null; /* rebuilt on mode change */

  function regionIndex() {
    var byId = {};
    arr('regions').forEach(function (r) {
      if (r && r.id) byId[r.id] = r;
    });
    return byId;
  }

  var WORLD_NAME = { lands: 'The Lands Between', underground: 'Underground', shadow: 'Land of Shadow' };

  function groupByRegion(records, regions) {
    var buckets = {};
    var order = [];
    records.forEach(function (rec) {
      var rid = rec.region || (rec.locationRef && rec.locationRef.region) || '';
      var reg = regions[rid];
      var key = reg ? reg.id : '_elsewhere';
      if (!buckets[key]) {
        buckets[key] = {
          id: key,
          title: reg ? reg.name : 'Elsewhere',
          sub: reg
            ? (WORLD_NAME[reg.world] || '') +
              (reg.recommendedLevel && reg.recommendedLevel.min
                ? ' - level ' + reg.recommendedLevel.min + '-' + reg.recommendedLevel.max
                : '')
            : 'No region recorded for these yet',
          order: reg && typeof reg.order === 'number' ? reg.order : 9999,
          rows: []
        };
        order.push(buckets[key]);
      }
      buckets[key].rows.push(rec);
    });
    return order.sort(function (a, b) {
      return a.order - b.order || (a.title < b.title ? -1 : 1);
    });
  }

  var BOSS_KIND = {
    main: 'Main path',
    remembrance: 'Remembrance',
    field: 'Field boss',
    dungeon: 'Dungeon boss',
    evergaol: 'Evergaol'
  };

  function bossRow(b) {
    var badges = [];
    if (BOSS_KIND[b.kind]) badges.push(BOSS_KIND[b.kind]);
    if (b.optional) badges.push('Optional');
    if (b.runes) badges.push(num(b.runes) + ' runes');
    return { id: b.id, name: b.name, rec: b, badges: badges, pin: b.locationRef && b.locationRef.pin };
  }

  function buildCatalogue() {
    var regions = regionIndex();
    var segs = {};

    /* --- bosses ------------------------------------------------------- */
    var bosses = arr('bosses').filter(function (b) {
      return b && b.id && srcOn(b.src);
    });
    segs.bosses = {
      id: 'bosses',
      label: 'Bosses',
      icon: '&#9760;&#65038;',
      noun: 'boss',
      blurb: 'Every named encounter, in the order the regions come. Ticking one here warns you if a questline dies with it.',
      sections: groupByRegion(bosses, regions).map(function (s) {
        s.rows = s.rows.map(bossRow);
        return s;
      })
    };

    /* --- graces ------------------------------------------------------- */
    var graces = arr('graces').filter(function (g) {
      return g && g.id && srcOn(g.src);
    });
    segs.graces = {
      id: 'graces',
      label: 'Graces',
      icon: '&#9737;',
      noun: 'site of grace',
      blurb: 'The lit-grace list is the fastest way to find the corner of a region you never walked into.',
      sections: groupByRegion(graces, regions).map(function (s) {
        s.rows = s.rows.map(function (g) {
          return {
            id: g.id,
            name: g.name,
            rec: g,
            badges: [WORLD_NAME[g.world] || ''].filter(Boolean),
            pin: g.pin || (g.locationRef && g.locationRef.pin)
          };
        });
        return s;
      })
    };

    /* --- quests ------------------------------------------------------- */
    var quests = arr('quests').filter(function (q) {
      return q && q.id && srcOn(q.src) && (q.steps || []).length;
    });
    segs.quests = {
      id: 'quests',
      label: 'Quests',
      icon: '&#9998;&#65038;',
      noun: 'quest step',
      blurb: 'Steps in order. A step with a lock badge is one you have to finish BEFORE the boss named on the badge.',
      sections: quests.map(function (q) {
        var npc = q.npc ? ER.byId(q.npc) : null;
        return {
          id: q.id,
          title: q.name,
          sub: (npc ? npc.name : '') + (q.missable ? ' - can be lost' : ''),
          quest: q,
          missable: !!q.missable,
          order: 0,
          rows: (q.steps || []).map(function (s, i) {
            return {
              id: s.id,
              name: s.text,
              step: s,
              n: i + 1,
              rec: null,
              pin: s.pin,
              badges: (s.lockouts || [])
                .map(function (l) {
                  var ref = l && l.ref ? ER.byId(l.ref) : null;
                  return l ? 'Before ' + (ref ? ref.name : l.ref) : '';
                })
                .filter(Boolean)
            };
          })
        };
      })
    };

    /* --- collectibles -------------------------------------------------- */
    var items = arr('items').filter(function (i) {
      return i && i.id && srcOn(i.src);
    });
    function ofKind(k) {
      return items.filter(function (i) {
        return i.kind === k;
      });
    }
    function plainRows(recs) {
      return recs.map(function (r) {
        return { id: r.id, name: r.name, rec: r, badges: [], pin: r.locationRef && r.locationRef.pin };
      });
    }
    var collectSections = [];
    var talismans = arr('talismans').filter(function (t) {
      return t && t.id && srcOn(t.src);
    });
    if (talismans.length) {
      collectSections.push({
        id: 'c-talismans',
        title: 'Talismans',
        sub: 'Four slots, a hundred and fifty answers',
        order: 1,
        rows: plainRows(talismans)
      });
    }
    var tears = ofKind('crystalTear');
    if (tears.length) {
      collectSections.push({
        id: 'c-tears',
        title: 'Crystal Tears',
        sub: 'The two halves of your Wondrous Physick',
        order: 2,
        rows: plainRows(tears)
      });
    }
    var runes = ofKind('greatRune');
    if (runes.length) {
      collectSections.push({
        id: 'c-greatrunes',
        title: 'Great Runes',
        sub: 'One per shardbearer, and each has to be restored before it does anything',
        order: 3,
        rows: plainRows(runes)
      });
    }
    /* Remembrances are an item kind in the built data; while the world lane is
       still pulling, fall back to the remembrance BOSSES so the section is
       never an empty box with a 0/0 in it. */
    var rem = ofKind('remembrance');
    var remFromBosses = false;
    if (!rem.length) {
      rem = bosses.filter(function (b) {
        return b.kind === 'remembrance';
      });
      remFromBosses = rem.length > 0;
    }
    if (rem.length) {
      collectSections.push({
        id: 'c-remembrances',
        title: 'Remembrances',
        sub: remFromBosses
          ? 'Tracked by the boss that drops it - ticking one here ticks it in Bosses too'
          : 'Spend at Roundtable Hold, or duplicate first at a Walking Mausoleum',
        order: 4,
        rows: plainRows(rem)
      });
    }
    segs.collect = {
      id: 'collect',
      label: 'Collectibles',
      icon: '&#10022;',
      noun: 'collectible',
      blurb: 'The things that are gone for the run if you walk past them.',
      sections: collectSections
    };

    Object.keys(segs).forEach(function (k) {
      var ids = [];
      segs[k].sections.forEach(function (s) {
        s.rows.forEach(function (r) {
          ids.push(r.id);
        });
      });
      segs[k].ids = ids;
    });
    return segs;
  }

  function cat() {
    if (!CAT) CAT = buildCatalogue();
    return CAT;
  }

  function countDone(ids) {
    var n = 0;
    for (var i = 0; i < ids.length; i++) if (isDone(ids[i])) n++;
    return n;
  }

  function pct(done, total) {
    if (!total) return 0;
    return Math.round((done / total) * 100);
  }

  /* ======================================================================
   * 3. MISSABLES ALARM
   * ====================================================================== */

  /* Every unfinished quest step that names this boss as the thing that ends
     it. Finished steps are excluded on purpose: if you already did Nepheli's
     step, Godrick is no longer a threat to it and nagging you would train you
     to tap through the warning that matters. */
  function lockoutsFor(bossId) {
    var out = [];
    arr('quests').forEach(function (q) {
      if (!q || !srcOn(q.src)) return;
      (q.steps || []).forEach(function (s, i) {
        if (!s || isDone(s.id)) return;
        (s.lockouts || []).forEach(function (l) {
          if (l && l.type === 'boss' && l.ref === bossId) {
            out.push({ quest: q, step: s, n: i + 1, note: l.note || '' });
          }
        });
      });
    });
    return out;
  }

  function confirmLockout(bossId, locks, onYes) {
    var boss = ER.byId(bossId);
    var rows = locks
      .map(function (l) {
        return (
          '<li class="ert-lockrow"><span class="ert-lockq">' +
          esc(l.quest.name) +
          '</span><span class="ert-lockstep">Step ' +
          l.n +
          ' - ' +
          esc(l.step.text) +
          '</span>' +
          (l.note ? '<span class="ert-locknote">' + esc(l.note) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    ER.sheet.open({
      key: 'ert:lock:' + bossId,
      title: 'This ends ' + (locks.length === 1 ? 'a questline' : locks.length + ' questlines'),
      sub: boss ? esc(boss.name) : '',
      icon: '&#9888;&#65038;',
      html:
        '<p class="lede">Marking this boss beaten means the steps below never happened. In game they close ' +
        'without a word, so this is the only warning you get.</p>' +
        '<ul class="ert-locklist">' +
        rows +
        '</ul>' +
        '<p class="ert-fine">Tick the steps first if you did them in the right order - then this warning stops appearing.</p>',
      actions: [
        {
          label: 'I killed it anyway',
          onClick: function () {
            ER.sheet.close();
            onYes();
          }
        },
        {
          label: 'Not yet',
          onClick: function () {
            ER.sheet.close();
          }
        }
      ]
    });
  }

  /* The one entry point every tick in this pane goes through. */
  function requestToggle(id) {
    if (isDone(id)) {
      setDone(id, false);
      return;
    }
    var isBoss = ER.groupOf && ER.groupOf(id) === 'bosses';
    var locks = isBoss ? lockoutsFor(id) : [];
    if (locks.length) {
      confirmLockout(id, locks, function () {
        setDone(id, true);
      });
      return;
    }
    setDone(id, true);
  }

  /* ======================================================================
   * 4. RENDER
   * ====================================================================== */

  var S = {
    pane: null,
    seg: 'bosses',
    q: '',
    filter: 'all', /* all | todo | done */
    open: {} /* sectionId -> true */
  };

  var SEG_ORDER = ['bosses', 'graces', 'quests', 'collect'];

  function segDef(id) {
    return cat()[id] || cat().bosses;
  }

  function matches(row, ql) {
    if (!ql) return true;
    return String(row.name || '').toLowerCase().indexOf(ql) !== -1;
  }

  function visibleRows(section, ql) {
    return section.rows.filter(function (r) {
      if (!matches(r, ql)) return false;
      if (S.filter === 'todo') return !isDone(r.id);
      if (S.filter === 'done') return isDone(r.id);
      return true;
    });
  }

  function barHtml(done, total, cls) {
    var p = pct(done, total);
    return (
      '<span class="ert-bar' + (cls ? ' ' + cls : '') + '" role="img" aria-label="' + p + ' percent">' +
      '<span class="ert-bar-fill" style="width:' + p + '%"></span></span>'
    );
  }

  function rowHtml(row) {
    var done = isDone(row.id);
    var src = row.rec && row.rec.src === 'sote' ? '<span class="src-badge">SotE</span>' : '';
    var badges = (row.badges || [])
      .map(function (b) {
        return '<span class="ert-badge">' + esc(b) + '</span>';
      })
      .join('');
    var label = row.n ? '<span class="ert-stepn">' + row.n + '</span>' : '';
    var name = row.rec
      ? '<button class="ert-name" type="button" data-entity="' + esc(row.id) + '">' + esc(row.name) + '</button>'
      : '<span class="ert-name plain">' + esc(row.name) + '</span>';
    var pin = row.pin
      ? '<button class="ert-pin" type="button" data-pin="' + esc(row.pin) + '" aria-label="Show on the map" title="Show on the map">&#128205;</button>'
      : '';
    return (
      '<li class="ert-row' + (done ? ' done' : '') + '" data-row="' + esc(row.id) + '">' +
      '<button class="ert-tick" type="button" role="checkbox" aria-checked="' + (done ? 'true' : 'false') +
      '" data-ert-toggle="' + esc(row.id) + '" aria-label="' + esc(row.name) + '"></button>' +
      label +
      '<span class="ert-rowbody">' +
      name +
      (badges || src ? '<span class="ert-badges">' + src + badges + '</span>' : '') +
      '</span>' +
      pin +
      '</li>'
    );
  }

  function sectionHtml(section, ql) {
    var rows = visibleRows(section, ql);
    var ids = section.rows.map(function (r) {
      return r.id;
    });
    var done = countDone(ids);
    var open = !!S.open[section.id];
    if (ql) open = true; /* a search shows what it found, always */
    var complete = ids.length && done === ids.length;
    if (!rows.length && (ql || S.filter !== 'all')) return '';
    return (
      '<section class="ert-sec' + (complete ? ' complete' : '') + (open ? ' open' : '') +
      '" data-sec="' + esc(section.id) + '">' +
      '<button class="ert-sechead" type="button" data-ert-sec="' + esc(section.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="ert-caret" aria-hidden="true"></span>' +
      '<span class="ert-secheads"><span class="ert-sectitle">' + esc(section.title) + '</span>' +
      (section.sub ? '<span class="ert-secsub">' + esc(section.sub) + '</span>' : '') +
      '</span>' +
      '<span class="ert-secnum">' + done + '<span class="ert-secslash">/</span>' + ids.length + '</span>' +
      barHtml(done, ids.length, 'mini') +
      '</button>' +
      (open ? '<ul class="ert-rows">' + rows.map(rowHtml).join('') + '</ul>' : '') +
      '</section>'
    );
  }

  function totals() {
    var done = 0;
    var total = 0;
    SEG_ORDER.forEach(function (k) {
      var s = cat()[k];
      if (!s) return;
      done += countDone(s.ids);
      total += s.ids.length;
    });
    return { done: done, total: total };
  }

  function headHtml() {
    var p = active();
    var t = totals();
    var stamp = p.importedAt
      ? 'Save read ' + (ER.fmt && ER.fmt.date ? ER.fmt.date(p.importedAt) : p.importedAt) +
        (p.importedFrom && p.importedFrom.name ? ' from ' + esc(p.importedFrom.name) : '')
      : 'Nothing imported yet - tick by hand, or read your save file';
    return (
      '<header class="tabhead ert-head">' +
      '<h1 class="tabtitle">Where you are</h1>' +
      '<p class="tabsub">Everything you can miss, in one list - ticked by hand, or read out of your save file.</p>' +
      '</header>' +
      '<section class="ert-panel">' +
      '<div class="ert-profbar">' +
      '<button class="ert-prof" type="button" data-ert-profiles>' +
      '<span class="ert-prof-ic" aria-hidden="true">&#9737;</span>' +
      '<span class="ert-prof-body"><span class="ert-prof-n">' + esc(p.name) + '</span>' +
      '<span class="ert-prof-s">' + stamp + '</span></span>' +
      '<span class="ert-prof-go" aria-hidden="true">&#9662;</span>' +
      '</button>' +
      '<span id="ertSave" class="ert-savepill" role="status" hidden></span>' +
      '</div>' +
      '<div class="ert-overall">' +
      '<div class="ert-overall-top"><span class="ert-overall-k">Overall</span>' +
      '<span class="ert-overall-v">' + pct(t.done, t.total) + '%</span></div>' +
      barHtml(t.done, t.total) +
      '<div class="ert-overall-foot">' +
      '<span class="ert-overall-sub">' + num(t.done) + ' of ' + num(t.total) + ' tracked things</span>' +
      '<span class="ert-ngwrap">' +
      '<button class="btn ert-ng" type="button" data-ert-ng="-1" aria-label="Lower journey count">&minus;</button>' +
      '<span class="ert-ngv" title="New Game+ journey">' + (p.ngPlus ? 'NG+' + p.ngPlus : 'Journey 1') + '</span>' +
      '<button class="btn ert-ng" type="button" data-ert-ng="1" aria-label="Raise journey count">+</button>' +
      '</span>' +
      '</div>' +
      '</div>' +
      '<div class="ert-actions">' +
      '<button class="btn primary ert-import-btn" type="button" data-ert-import>Import save file</button>' +
      '</div>' +
      '</section>'
    );
  }

  function segbarHtml() {
    return (
      '<div class="segscroll ert-segs">' +
      SEG_ORDER.map(function (k) {
        var s = cat()[k];
        if (!s) return '';
        var d = countDone(s.ids);
        return (
          '<button class="ert-seg' + (S.seg === k ? ' on' : '') + '" type="button" data-ert-seg="' + k + '"' +
          (S.seg === k ? ' aria-current="true"' : '') + '>' +
          '<span class="ert-seg-ic" aria-hidden="true">' + s.icon + '</span>' +
          '<span class="ert-seg-l">' + esc(s.label) + '</span>' +
          '<span class="ert-seg-n">' + pct(d, s.ids.length) + '%</span>' +
          '</button>'
        );
      }).join('') +
      '</div>'
    );
  }

  function controlsHtml() {
    var s = segDef(S.seg);
    return (
      '<div class="ert-controls">' +
      '<p class="ert-blurb">' + esc(s.blurb) + '</p>' +
      '<div class="ert-controlrow">' +
      '<input class="ert-filter" type="search" id="ertFilter" data-ert-q autocomplete="off" spellcheck="false" ' +
      'placeholder="Filter this list" aria-label="Filter this list" value="' + esc(S.q) + '" />' +
      '<div class="ert-chips">' +
      [['all', 'All'], ['todo', 'To do'], ['done', 'Done']]
        .map(function (f) {
          return (
            '<button class="ert-chip' + (S.filter === f[0] ? ' on' : '') + '" type="button" data-ert-filter="' + f[0] + '">' +
            f[1] + '</button>'
          );
        })
        .join('') +
      '</div>' +
      '<button class="ert-chip wide" type="button" data-ert-expand>' + (anyOpen() ? 'Collapse all' : 'Expand all') + '</button>' +
      '</div>' +
      '</div>'
    );
  }

  function anyOpen() {
    var s = segDef(S.seg);
    return s.sections.some(function (sec) {
      return !!S.open[sec.id];
    });
  }

  function listHtml() {
    var s = segDef(S.seg);
    var ql = S.q.trim().toLowerCase();
    if (!s.sections.length) {
      return (
        '<div class="panel empty-panel"><p>No ' + esc(s.noun) + 's are in the data yet. ' +
        'This list fills itself from the same files the rest of the app reads - nothing here is typed by hand.</p></div>'
      );
    }
    var html = s.sections
      .map(function (sec) {
        return sectionHtml(sec, ql);
      })
      .join('');
    if (!html) {
      return '<div class="panel empty-panel"><p>Nothing here matches that filter.</p></div>';
    }
    return html;
  }

  function renderList() {
    if (!S.pane) return;
    var host = S.pane.querySelector('[data-ert-list]');
    if (host) host.innerHTML = listHtml();
    var ctrl = S.pane.querySelector('[data-ert-controls]');
    if (ctrl) {
      /* Keep the focused filter field alive across a re-render: replacing it
         while the user is typing would drop the caret on every keystroke. */
      var live = document.activeElement;
      if (!live || live.id !== 'ertFilter') ctrl.innerHTML = controlsHtml();
      else {
        var exp = ctrl.querySelector('[data-ert-expand]');
        if (exp) exp.textContent = anyOpen() ? 'Collapse all' : 'Expand all';
      }
    }
  }

  function renderAll() {
    if (!S.pane) return;
    var head = S.pane.querySelector('[data-ert-head]');
    if (head) head.innerHTML = headHtml() + segbarHtml();
    paintPill();
    renderList();
  }

  /* One tick must not cost a full re-render. With "Expand all" pressed on the
     grace list that would be ~400 rows of innerHTML per tap, which on a phone
     is exactly the stutter that makes a checklist feel broken. So a plain tick
     patches the four things that actually changed - the row, its section's
     count and bar, the segment percentages and the overall figure - and only
     falls back to a full render when a row may have to appear or disappear
     (the To-do / Done filters) or when something bigger moved. */
  function updateCounters() {
    if (!S.pane) return;
    var t = totals();
    var v = S.pane.querySelector('.ert-overall-v');
    if (v) v.textContent = pct(t.done, t.total) + '%';
    var sub = S.pane.querySelector('.ert-overall-sub');
    if (sub) sub.textContent = num(t.done) + ' of ' + num(t.total) + ' tracked things';
    var fill = S.pane.querySelector('.ert-overall .ert-bar-fill');
    if (fill) fill.style.width = pct(t.done, t.total) + '%';

    SEG_ORDER.forEach(function (k) {
      var s2 = cat()[k];
      var btn = S.pane.querySelector('[data-ert-seg="' + k + '"] .ert-seg-n');
      if (s2 && btn) btn.textContent = pct(countDone(s2.ids), s2.ids.length) + '%';
    });

    segDef(S.seg).sections.forEach(function (sec) {
      var el = S.pane.querySelector('[data-sec="' + sec.id + '"]');
      if (!el) return;
      var ids = sec.rows.map(function (r) {
        return r.id;
      });
      var done = countDone(ids);
      var n = el.querySelector('.ert-secnum');
      if (n) n.innerHTML = done + '<span class="ert-secslash">/</span>' + ids.length;
      var bar = el.querySelector('.ert-bar-fill');
      if (bar) bar.style.width = pct(done, ids.length) + '%';
      el.classList.toggle('complete', !!ids.length && done === ids.length);
    });
  }

  function patchRow(id) {
    if (!S.pane || !id) return;
    var done = isDone(id);
    var rows = S.pane.querySelectorAll('[data-row="' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
    Array.prototype.forEach.call(rows, function (li) {
      li.classList.toggle('done', done);
      var t = li.querySelector('[data-ert-toggle]');
      if (t) t.setAttribute('aria-checked', done ? 'true' : 'false');
    });
  }

  function onChanged(id) {
    if (!S.pane || S.pane.hidden) return;
    if (id && S.filter === 'all' && !S.q) {
      patchRow(id);
      updateCounters();
      return;
    }
    renderAll();
  }

  /* ======================================================================
   * 5. PROFILES
   * ====================================================================== */

  function profileSheet() {
    var b = blob();
    var ids = Object.keys(b.profiles);
    var rows = ids
      .map(function (id) {
        var p = b.profiles[id];
        return (
          '<button class="ert-profrow' + (id === b.active ? ' on' : '') + '" type="button" data-ert-pick="' + esc(id) + '">' +
          '<span class="ert-profrow-n">' + esc(p.name) + '</span>' +
          '<span class="ert-profrow-s">' +
          (p.importedFrom && p.importedFrom.level ? 'Level ' + num(p.importedFrom.level) + ' - ' : '') +
          (p.ngPlus ? 'NG+' + p.ngPlus + ' - ' : '') +
          num(Object.keys(p.imported).length + Object.keys(p.manual).length) + ' marks' +
          '</span>' +
          (id === b.active ? '<span class="ert-profrow-on" aria-hidden="true">&#10003;</span>' : '') +
          '</button>'
        );
      })
      .join('');
    ER.sheet.open({
      key: 'ert:profiles',
      title: 'Characters',
      sub: 'One tracker per Tarnished',
      icon: '&#9737;',
      html:
        '<p class="lede">Every character you play gets its own set of ticks. Switching here switches the whole tab, ' +
        'the map pins and the quest ticks in the wiki with it.</p>' +
        '<div class="ert-proflist">' + rows + '</div>' +
        '<div class="ert-profacts">' +
        '<button class="btn" type="button" data-ert-prof-new>New character</button>' +
        '<button class="btn" type="button" data-ert-prof-rename>Rename</button>' +
        '<button class="btn danger" type="button" data-ert-prof-del>Delete this one</button>' +
        '</div>' +
        '<p class="ert-fine">Everything lives in this browser only. The island app\'s export page picks it up as one ' +
        'block, so moving to another phone is a copy and a paste.</p>'
    });
  }

  function renameProfile() {
    var p = active();
    var n = null;
    try {
      n = window.prompt('Name this character', p.name);
    } catch (e) {
      n = null;
    }
    if (n === null) return;
    n = String(n).trim().slice(0, 40);
    if (!n) return;
    p.name = n;
    saveSoon();
    emit();
    profileSheet();
  }

  function newProfile(name, importedMap, meta) {
    var b = blob();
    var id = newId();
    var p = blankProfile(id, name || 'Tarnished');
    if (importedMap) {
      p.imported = importedMap;
      p.importedAt = new Date().toISOString();
      p.importedFrom = meta || null;
      if (meta && typeof meta.ngPlus === 'number') p.ngPlus = meta.ngPlus;
    }
    b.profiles[id] = p;
    b.active = id;
    saveSoon();
    emit();
    return p;
  }

  function deleteProfile() {
    var b = blob();
    var ids = Object.keys(b.profiles);
    if (ids.length < 2) {
      toast('This is the only character - rename it instead.');
      return;
    }
    var p = active();
    var ok = false;
    try {
      ok = window.confirm('Delete "' + p.name + '" and every tick on it? This cannot be undone.');
    } catch (e) {
      ok = false;
    }
    if (!ok) return;
    delete b.profiles[p.id];
    b.active = Object.keys(b.profiles)[0] || null;
    active();
    saveSoon();
    emit();
    profileSheet();
  }

  /* ======================================================================
   * 6. SAVE IMPORT
   * ====================================================================== */

  var IMP = { stage: 'intro', pct: 0, note: '', slots: null, error: null, worker: null, format: 'sl2' };

  /* flagId -> [entity id], across bosses and graces. One flag can legitimately
     mark more than one record (a boss that is also a grace trigger), so this is
     a list, not a single value. */
  function flagMap() {
    var m = {};
    function add(list) {
      list.forEach(function (r) {
        if (!r || typeof r.flagId !== 'number') return;
        (m[r.flagId] || (m[r.flagId] = [])).push(r.id);
      });
    }
    add(arr('bosses'));
    add(arr('graces'));
    return m;
  }

  function importBody() {
    return document.getElementById('ertImportBody');
  }

  function paintImport() {
    var host = importBody();
    if (!host) return;
    host.innerHTML = importHtml();
  }

  function importHtml() {
    if (IMP.stage === 'busy') {
      return (
        '<div class="ert-prog">' +
        '<div class="ert-prog-track"><div class="ert-prog-fill" style="width:' + IMP.pct + '%"></div></div>' +
        '<p class="ert-prog-note">' + esc(IMP.note || 'Reading') + ' - ' + IMP.pct + '%</p>' +
        '<p class="ert-fine">A save is about 29 MB. It is read in slices so your phone never holds the whole thing at once.</p>' +
        '</div>'
      );
    }
    if (IMP.stage === 'error') {
      return (
        '<div class="ert-err">' +
        '<p class="ert-err-h">' + esc(IMP.error.message) + '</p>' +
        (IMP.error.detail ? '<p class="ert-fine">' + esc(IMP.error.detail) + '</p>' : '') +
        '</div>' +
        fileRowHtml('Try another file')
      );
    }
    if (IMP.stage === 'result') {
      var live = IMP.slots.filter(function (s) {
        return !s.empty;
      });
      if (!live.length) {
        return '<div class="ert-err"><p class="ert-err-h">That save has no characters in it.</p></div>' + fileRowHtml('Try another file');
      }
      return (
        '<p class="lede">Found ' + live.length + ' character' + (live.length === 1 ? '' : 's') +
        ' in this ' + (IMP.format === 'co2' ? 'Seamless Co-op ' : '') + 'save. Pick the one you are playing.</p>' +
        '<div class="ert-slots">' +
        live.map(slotRowHtml).join('') +
        '</div>' +
        '<p class="ert-fine">Importing replaces what the file knows and keeps every tick you made by hand. ' +
        'A hand tick that now agrees with the save is simply forgotten - it is not needed any more.</p>'
      );
    }
    /* intro */
    return (
      '<p class="lede">Your save never leaves this device. The file is opened inside your browser, the app copies out ' +
      'which bosses are dead and which graces are lit, and closes it again. Nothing is uploaded, and there is no code ' +
      'here that can write to it.</p>' +
      '<div class="ert-where">' +
      '<h3 class="ert-where-h">Where the file is</h3>' +
      '<p class="ert-where-p">Paste <code>%APPDATA%\\EldenRing</code> into the address bar of a File Explorer window. ' +
      'Inside is one folder named with a long number - your Steam id - and inside that is <code>ER0000.sl2</code>. ' +
      'Seamless Co-op keeps its own <code>ER0000.co2</code> in the same place.</p>' +
      '<h3 class="ert-where-h">Quit the game first</h3>' +
      '<p class="ert-where-p">Elden Ring rewrites the save while it runs. Reading it mid-write gives a half-finished ' +
      'picture, so close the game before you pick the file.</p>' +
      '<h3 class="ert-where-h">Xbox and Game Pass</h3>' +
      '<p class="ert-where-p">The Microsoft Store version does not keep an <code>.sl2</code> at all - its progress ' +
      'sits in a sealed container with no readable file - so there is nothing to import. Ticking by hand works the same.</p>' +
      '</div>' +
      fileRowHtml('Choose your save file')
    );
  }

  function fileRowHtml(label) {
    return (
      '<div class="ert-filerow">' +
      '<input id="ertFile" class="ert-fileinput" type="file" accept=".sl2,.co2" data-ert-file />' +
      '<label class="btn primary ert-filebtn" for="ertFile">' + esc(label) + '</label>' +
      '</div>'
    );
  }

  function slotRowHtml(s) {
    var stats = s.stats
      ? ['vig', 'mind', 'end', 'str', 'dex', 'int', 'fai', 'arc']
          .map(function (k) {
            return '<span class="ert-slotstat"><b>' + s.stats[k] + '</b>' + k + '</span>';
          })
          .join('')
      : '';
    var marks = s.flags ? s.flags.length : 0;
    if (s.unreadable) {
      return (
        '<div class="ert-slot bad">' +
        '<div class="ert-slot-n">' + esc(s.name || 'Slot ' + (s.index + 1)) + '</div>' +
        '<p class="ert-fine">' + esc((s.warnings && s.warnings[0]) || 'This character could not be read.') + '</p>' +
        '</div>'
      );
    }
    return (
      '<div class="ert-slot">' +
      '<div class="ert-slot-head">' +
      '<span class="ert-slot-n">' + esc(s.name || 'Slot ' + (s.index + 1)) + '</span>' +
      '<span class="ert-slot-lv">Level ' + num(s.level) + '</span>' +
      '</div>' +
      (stats ? '<div class="ert-slotstats">' + stats + '</div>' : '') +
      '<div class="ert-slot-sub">' +
      (marks
        ? num(marks) + ' of the things this app tracks are already done'
        : 'Nothing this app tracks is done on this character yet') +
      (s.runes ? ' - holding ' + num(s.runes) + ' runes' : '') + '</div>' +
      (s.warnings && s.warnings.length
        ? '<p class="ert-fine warn">' + esc(s.warnings.join('; ')) + '</p>'
        : '') +
      '<div class="ert-slot-acts">' +
      '<button class="btn primary" type="button" data-ert-use="' + s.index + '" data-ert-mode="here">Into ' + esc(active().name) + '</button>' +
      '<button class="btn" type="button" data-ert-use="' + s.index + '" data-ert-mode="new">As a new character</button>' +
      '</div>' +
      '</div>'
    );
  }

  function openImport() {
    IMP.stage = 'intro';
    IMP.error = null;
    IMP.slots = null;
    ER.sheet.open({
      key: 'ert:import',
      title: 'Import your save',
      sub: 'Read-only, and it never leaves this device',
      icon: '&#8659;',
      html: '<div class="ert-import" id="ertImportBody">' + importHtml() + '</div>'
    });
  }

  function importFailed(code, message, detail) {
    IMP.stage = 'error';
    IMP.error = { code: code, message: message, detail: detail || null };
    paintImport();
  }

  function startParse(file) {
    if (!file) return;
    IMP.stage = 'busy';
    IMP.pct = 0;
    IMP.note = 'Opening the file';
    paintImport();

    if (IMP.worker) {
      try {
        IMP.worker.terminate();
      } catch (e) {}
      IMP.worker = null;
    }

    var w;
    try {
      w = new Worker(WORKER_URL);
    } catch (e) {
      importFailed(
        'WORKER_UNAVAILABLE',
        'This browser would not start the background reader.',
        'A save is too big to read on the main thread without freezing the page, so the import needs a Web Worker. Private-mode or an unusually locked-down browser can block one.'
      );
      return;
    }
    IMP.worker = w;

    w.onerror = function (ev) {
      importFailed('WORKER_FAILED', 'The background reader stopped.', (ev && ev.message) || null);
      try {
        w.terminate();
      } catch (e) {}
      IMP.worker = null;
    };

    w.onmessage = function (ev) {
      var m = ev && ev.data;
      if (!m) return;
      if (m.type === 'progress') {
        IMP.pct = m.pct;
        IMP.note = m.note;
        if (IMP.stage === 'busy') paintImport();
        return;
      }
      if (m.type === 'error') {
        importFailed(m.code, m.message, m.detail);
        try {
          w.terminate();
        } catch (e) {}
        IMP.worker = null;
        return;
      }
      if (m.type === 'done') {
        IMP.stage = 'result';
        IMP.slots = m.slots || [];
        IMP.format = m.format || 'sl2';
        paintImport();
        try {
          w.terminate();
        } catch (e) {}
        IMP.worker = null;
      }
    };

    var wantFlags = [];
    var fm = flagMap();
    Object.keys(fm).forEach(function (k) {
      wantFlags.push(Number(k));
    });

    /* bstUrl rather than the table itself: the main thread never has to parse
       225 KB of JSON, and the worker's fetch hits the same cached response the
       service worker already holds. */
    w.postMessage({
      type: 'parse',
      file: file,
      bstUrl: new URL(BST_URL, location.href).href,
      wantFlags: wantFlags
    });
  }

  function applyImport(slotIndex, mode) {
    var slot = (IMP.slots || []).filter(function (s) {
      return s.index === slotIndex;
    })[0];
    if (!slot) return;
    var fm = flagMap();
    var map = {};
    (slot.flags || []).forEach(function (f) {
      (fm[f] || []).forEach(function (id) {
        map[id] = 1;
      });
    });
    var meta = {
      slot: slot.index + 1,
      name: slot.name,
      level: slot.level,
      stats: slot.stats,
      runes: slot.runes,
      ngPlus: typeof slot.ngPlus === 'number' ? slot.ngPlus : null
    };
    if (mode === 'new') {
      newProfile(slot.name || 'Tarnished', map, meta);
    } else {
      var p = active();
      p.imported = map;
      p.importedAt = new Date().toISOString();
      p.importedFrom = meta;
      /* Overrides that now agree with the file are noise - drop them so a
         later re-import is not fighting a hundred stale ticks. */
      Object.keys(p.manual).forEach(function (id) {
        if (!!p.manual[id] === !!map[id]) delete p.manual[id];
      });
      saveSoon();
      emit();
    }
    ER.sheet.close();
    var n = Object.keys(map).length;
    toast('Imported ' + slot.name + ' - ' + n + ' thing' + (n === 1 ? '' : 's') + ' marked done.');
  }

  /* ======================================================================
   * 7. EVENTS
   * ====================================================================== */

  var qTimer = null;

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var tick = t.closest('[data-ert-toggle]');
    if (tick) {
      requestToggle(tick.getAttribute('data-ert-toggle'));
      return;
    }
    var sec = t.closest('[data-ert-sec]');
    if (sec) {
      var sid = sec.getAttribute('data-ert-sec');
      S.open[sid] = !S.open[sid];
      renderList();
      return;
    }
    var seg = t.closest('[data-ert-seg]');
    if (seg) {
      setSeg(seg.getAttribute('data-ert-seg'), true);
      return;
    }
    var flt = t.closest('[data-ert-filter]');
    if (flt) {
      S.filter = flt.getAttribute('data-ert-filter');
      renderAll();
      return;
    }
    if (t.closest('[data-ert-expand]')) {
      var open = !anyOpen();
      segDef(S.seg).sections.forEach(function (s2) {
        S.open[s2.id] = open;
      });
      renderList();
      return;
    }
    var ng = t.closest('[data-ert-ng]');
    if (ng) {
      var p2 = active();
      p2.ngPlus = Math.max(0, Math.min(99, p2.ngPlus + Number(ng.getAttribute('data-ert-ng'))));
      saveSoon();
      renderAll();
      return;
    }
    if (t.closest('[data-ert-import]')) {
      openImport();
      return;
    }
    if (t.closest('[data-ert-profiles]')) {
      profileSheet();
      return;
    }
    var pick = t.closest('[data-ert-pick]');
    if (pick) {
      blob().active = pick.getAttribute('data-ert-pick');
      saveSoon();
      emit();
      profileSheet();
      return;
    }
    if (t.closest('[data-ert-prof-new]')) {
      newProfile('Tarnished ' + (Object.keys(blob().profiles).length + 1), null, null);
      profileSheet();
      return;
    }
    if (t.closest('[data-ert-prof-rename]')) {
      renameProfile();
      return;
    }
    if (t.closest('[data-ert-prof-del]')) {
      deleteProfile();
      return;
    }
    var use = t.closest('[data-ert-use]');
    if (use) {
      applyImport(Number(use.getAttribute('data-ert-use')), use.getAttribute('data-ert-mode'));
      return;
    }
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-ert-q')) {
      S.q = t.value || '';
      clearTimeout(qTimer);
      qTimer = setTimeout(renderList, 120);
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-ert-file')) {
      var f = t.files && t.files[0];
      if (f) startParse(f);
      /* Let the same file be picked twice in a row after a refusal. */
      try {
        t.value = '';
      } catch (err) {}
    }
  });

  function setSeg(id, write) {
    if (!cat()[id]) return;
    S.seg = id;
    /* Open the first section that still has something left in it - landing on
       an all-collapsed wall of regions is the fastest way to make a tracker
       feel like homework. */
    var s = segDef(id);
    var already = s.sections.some(function (x) {
      return S.open[x.id];
    });
    if (!already) {
      var first =
        s.sections.filter(function (x) {
          return (
            x.rows.length &&
            x.rows.some(function (r) {
              return !isDone(r.id);
            })
          );
        })[0] || s.sections[0];
      if (first) S.open[first.id] = true;
    }
    try {
      if (ER.prefs) ER.prefs.set('trackerSeg', id);
    } catch (e) {}
    renderAll();
    if (write) {
      try {
        if (location.hash.indexOf('#tracker') === 0) history.replaceState(null, '', '#tracker/' + id);
      } catch (e) {}
    }
  }

  /* ======================================================================
   * 8. PUBLIC API + TAB
   * ====================================================================== */

  /* The public API other lanes call. NOTE the deliberate asymmetry: toggle()
     does NOT raise the missables alarm. The map and the wiki call it and then
     read isDone() on the next line, so it has to settle synchronously; an
     async confirm would hand them a stale answer. The alarm belongs to the
     surface that can afford to wait for it - the tracker's own tick. */
  ER.tracker = {
    isDone: function (id) {
      try {
        return isDone(id);
      } catch (e) {
        return false;
      }
    },
    toggle: function (id) {
      try {
        toggleId(id);
      } catch (e) {}
    },
    setDone: function (id, v) {
      try {
        setDone(id, v);
      } catch (e) {}
    },
    profile: function () {
      var p = active();
      return {
        id: p.id,
        name: p.name,
        ngPlus: p.ngPlus,
        importedAt: p.importedAt,
        importedFrom: p.importedFrom,
        marks: Object.keys(p.imported).length + Object.keys(p.manual).length
      };
    },
    onChange: function (cb) {
      if (typeof cb === 'function') CHANGE_CBS.push(cb);
    },
    /* Used by the map and by anything that wants the headline number. */
    progress: function () {
      var t = totals();
      return { done: t.done, total: t.total, pct: pct(t.done, t.total) };
    }
  };

  CHANGE_CBS.push(onChanged);

  if (typeof ER.onModeChange === 'function') {
    ER.onModeChange(function () {
      CAT = null;
      if (S.pane) renderAll();
    });
  }

  ER.registerTab('tracker', {
    label: 'Tracker',
    icon: '&#128203;',
    order: 40,
    mount: function (el) {
      S.pane = el;
      load();
      CAT = null;
      el.innerHTML = '<div class="er-tracker">' + '<div data-ert-head></div>' + '<div data-ert-controls></div>' + '<div data-ert-list></div>' + '</div>';
      var saved = ER.prefs ? ER.prefs.get('trackerSeg', 'bosses') : 'bosses';
      S.seg = cat()[saved] ? saved : 'bosses';
      setSeg(S.seg, false);
    },
    show: function (params) {
      var want = params && params[0];
      if (want === 'import') {
        renderAll();
        openImport();
        return;
      }
      if (want && cat()[want] && want !== S.seg) setSeg(want, false);
      else renderAll();
    },
    /* Deliberately does NOT kill a running import. A parse takes a second or
       two; terminating it because someone glanced at the map would leave the
       sheet stuck on a progress bar that never moves when they came back. The
       worker terminates itself on done, on error, and when a new file is
       picked. */
    hide: function () {},
    /* Tab-local search: the shell already finds every boss, grace and talisman
       by name, so what this adds is the things only the tracker knows -
       individual quest STEPS, and the import action itself. */
    search: function (q) {
      var ql = String(q || '').toLowerCase();
      if (ql.length < 2) return [];
      var out = [];
      arr('quests').forEach(function (qu) {
        if (!qu || !srcOn(qu.src)) return;
        (qu.steps || []).forEach(function (s, i) {
          if (out.length >= 6) return;
          if (String(s.text || '').toLowerCase().indexOf(ql) === -1) return;
          out.push({
            title: qu.name + ' - step ' + (i + 1),
            sub: String(s.text || '').slice(0, 60),
            icon: '&#9998;&#65038;',
            go: function () {
              ER.navigate('tracker', ['quests']);
              S.q = qu.name;
              S.open[qu.id] = true;
              renderAll();
            }
          });
        });
      });
      if ('import save file'.indexOf(ql) !== -1 || 'sl2'.indexOf(ql) === 0) {
        out.push({
          title: 'Import your save file',
          sub: 'Fill the tracker in from ER0000.sl2',
          icon: '&#8659;',
          go: function () {
            ER.navigate('tracker', ['import']);
          }
        });
      }
      return out;
    }
  });
})();
