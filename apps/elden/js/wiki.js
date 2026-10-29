/* wiki.js - the Wiki tab and the standard entity sheet.
 *
 * OWNED BY: P3 L5 (shell + Start + Wiki).
 *
 * Two things live here:
 *   1. ER.entityCardHtml(rec, opts) and ER.openEntity(id) - the shared renderers
 *      EVERY lane uses. app.js ships fallbacks for both; this file replaces them
 *      at load, before any tab can be shown.
 *   2. The Wiki tab itself: eleven segments, DLC-aware filters, and the sheet.
 *
 * THE SHEET ORDER IS THE PRODUCT (NEW-GAME-TEMPLATE section 8). What it is /
 * Why it matters / When to use it come FIRST, above the numbers, because a
 * stat block answers "what does this do" and those three answer "should I care,
 * and when" - the question a source wiki never answers.
 *
 * NOTHING IS INVENTED. A row is rendered only when the dataset carries the
 * value. A missing field is an absent row, never a zero and never a guess.
 * Every interpolated value goes through esc().
 */
(function () {
  'use strict';

  var ER = window.ER;
  if (!ER) return;
  var esc = ER.esc;
  var $ = ER.$;

  /* ------------------------------------------------------------- utilities */

  function iconHtml(rec, group, cls) {
    var fb = ER.groupIcon(group);
    var c = 'er-ic-wrap' + (cls ? ' ' + cls : '') + (rec && rec.icon ? '' : ' noimg');
    return (
      '<span class="' + c + '">' +
      (rec && rec.icon ? '<img class="er-ic" src="' + esc(ER.asset(rec.icon)) + '" alt="" loading="lazy" decoding="async" />' : '') +
      '<span class="er-ic-fb" aria-hidden="true">' + fb + '</span></span>'
    );
  }

  function srcBadge(rec) {
    return rec && rec.src === 'sote' ? '<span class="src-badge">SotE</span>' : '';
  }

  function sec(title, html) {
    if (!html) return '';
    return '<section class="e-sec"><h3 class="e-h">' + esc(title) + '</h3>' + html + '</section>';
  }

  /* A plain label/value table. Rows whose value is null/undefined/'' are
     dropped, so an incomplete record renders a shorter block, never a wrong one. */
  function statTable(rows, cls) {
    var live = (rows || []).filter(function (r) {
      return r && r[1] !== null && r[1] !== undefined && r[1] !== '';
    });
    if (!live.length) return '';
    return (
      '<div class="stat-table' + (cls ? ' ' + cls : '') + '">' +
      live
        .map(function (r) {
          return (
            '<div class="st-row' + (r[2] ? ' ' + r[2] : '') + '">' +
            '<span class="st-k">' + esc(r[0]) + '</span>' +
            '<span class="st-v">' + (r[3] ? r[1] : esc(r[1])) + '</span></div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  /* A grid of small numbers - damage types, resistances, requirements. */
  function numGrid(obj, keys, opts) {
    if (!obj) return '';
    var o = opts || {};
    var cells = (keys || Object.keys(obj))
      .filter(function (k) {
        var v = obj[k];
        return o.keepZero ? v !== null && v !== undefined : !!v;
      })
      .map(function (k) {
        var v = obj[k];
        var cls = '';
        if (o.mark && o.mark[k] === false) cls = ' bad';
        else if (o.mark && o.mark[k] === true) cls = ' good';
        return (
          '<div class="ng-cell' + cls + '"><span class="ng-k">' + esc(ER.fmt.stat(k)) + '</span>' +
          '<span class="ng-v">' + esc(ER.fmt.num(v)) + '</span></div>'
        );
      });
    if (!cells.length) return '';
    return '<div class="numgrid">' + cells.join('') + '</div>';
  }

  /* Bars for values that are meaningful against each other (negation, resist). */
  function barGrid(obj, keys, max) {
    if (!obj) return '';
    var ks = (keys || Object.keys(obj)).filter(function (k) {
      return obj[k] !== null && obj[k] !== undefined;
    });
    if (!ks.length) return '';
    var top = max;
    if (!top) {
      top = 1;
      ks.forEach(function (k) {
        if (Number(obj[k]) > top) top = Number(obj[k]);
      });
    }
    return (
      '<div class="bargrid">' +
      ks
        .map(function (k) {
          var v = Number(obj[k]) || 0;
          var pct = Math.max(0, Math.min(100, (v / top) * 100));
          return (
            '<div class="bar-row"><span class="bar-k">' + esc(ER.fmt.stat(k)) + '</span>' +
            '<span class="bar-track"><span class="bar-fill" style="width:' + pct.toFixed(1) + '%"></span></span>' +
            '<span class="bar-v">' + esc(ER.fmt.num(v)) + '</span></div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  /* Cross-links. Ids that do not resolve are dropped silently rather than
     rendered as dead chips - the data lanes' fuzzy-miss report is where an
     unresolved reference is supposed to surface, not the UI. */
  function linkChips(ids, fallbackText) {
    var live = (ids || [])
      .map(function (id) {
        return { id: id, rec: ER.byId(id) };
      })
      .filter(function (x) {
        return x.rec && ER.srcOn(x.rec.src);
      });
    if (!live.length) return fallbackText ? '<p class="e-p faint">' + esc(fallbackText) + '</p>' : '';
    return (
      '<div class="chiprow">' +
      live
        .map(function (x) {
          return (
            '<button class="echip" type="button" data-entity="' + esc(x.id) + '">' +
            iconHtml(x.rec, ER.groupOf(x.id), 's24') +
            '<span class="echip-n">' + esc(x.rec.name) + '</span>' + srcBadge(x.rec) + '</button>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function wordChips(words, cls) {
    var live = (words || []).filter(Boolean);
    if (!live.length) return '';
    return (
      '<div class="chiprow">' +
      live
        .map(function (w) {
          return '<span class="wchip' + (cls ? ' ' + cls : '') + '">' + esc(w) + '</span>';
        })
        .join('') +
      '</div>'
    );
  }

  function prose(text, cls) {
    if (!text) return '';
    return String(text)
      .split(/\n{2,}/)
      .map(function (p) {
        return '<p class="' + (cls || 'e-p') + '">' + esc(p.trim()) + '</p>';
      })
      .join('');
  }

  /* The planner is optional at every call site. When it is absent the "fits my
     stats" affordances simply do not render - they are never faked. */
  function plannerStats() {
    try {
      if (ER.planner && typeof ER.planner.stats === 'function') return ER.planner.stats();
    } catch (e) {}
    return null;
  }
  function canWield(rec) {
    try {
      if (ER.planner && typeof ER.planner.canWield === 'function') return !!ER.planner.canWield(rec, plannerStats());
    } catch (e) {}
    var st = plannerStats();
    if (!st || !rec || !rec.reqs) return null;
    var ok = true;
    Object.keys(rec.reqs).forEach(function (k) {
      if ((Number(st[k]) || 0) < (Number(rec.reqs[k]) || 0)) ok = false;
    });
    return ok;
  }

  function pinFor(rec) {
    if (!rec) return null;
    if (rec.pin) return rec.pin;
    if (rec.locationRef && rec.locationRef.pin) return rec.locationRef.pin;
    return null;
  }

  function mapAction(rec) {
    var pin = pinFor(rec);
    if (!pin) return null;
    var p = ER.byId(pin);
    var world = (p && p.world) || (rec && rec.world) || 'lands';
    return {
      label: 'Show on map',
      onClick: function () {
        ER.sheet.close();
        ER.navigate('map', [world, 'pin', pin]);
        try {
          if (ER.mapApi && typeof ER.mapApi.focusPin === 'function') ER.mapApi.focusPin(pin);
        } catch (e) {}
      }
    };
  }

  /* ---------------------------------------------------------- entity cards */

  ER.entityCardHtml = function (rec, opts) {
    if (!rec) return '';
    var o = opts || {};
    var group = o.group || ER.groupOf(rec.id) || '';
    var badges = (o.badges || []).slice();
    if (rec.src === 'sote') badges.unshift('SotE');
    var sub = o.sub || '';
    if (o.layout === 'grid') {
      return (
        '<button class="ecard grid" type="button" data-entity="' + esc(rec.id) + '">' +
        iconHtml(rec, group, 's44') +
        '<span class="ec-body"><span class="ec-n">' + esc(rec.name || '') + '</span>' +
        (sub ? '<span class="ec-s">' + esc(sub) + '</span>' : '') + '</span>' +
        (badges.length
          ? '<span class="ec-badges">' +
            badges
              .map(function (b) {
                return '<span class="' + (b === 'SotE' ? 'src-badge' : 'wchip tiny') + '">' + esc(b) + '</span>';
              })
              .join('') +
            '</span>'
          : '') +
        '</button>'
      );
    }
    return (
      '<button class="ecard row" type="button" data-entity="' + esc(rec.id) + '">' +
      iconHtml(rec, group, 's32') +
      '<span class="ec-body"><span class="ec-n">' + esc(rec.name || '') + '</span>' +
      (sub ? '<span class="ec-s">' + esc(sub) + '</span>' : '') + '</span>' +
      (badges.length
        ? '<span class="ec-badges">' +
          badges
            .map(function (b) {
              return '<span class="' + (b === 'SotE' ? 'src-badge' : 'wchip tiny') + '">' + esc(b) + '</span>';
            })
            .join('') +
          '</span>'
        : '') +
      '<span class="ec-go" aria-hidden="true">&rsaquo;</span>' +
      '</button>'
    );
  };

  /* --------------------------------------------------- per-dataset blocks */

  var STAT5 = ['str', 'dex', 'int', 'fai', 'arc'];
  var DMG5 = ['phys', 'mag', 'fire', 'ligt', 'holy'];
  var NEG8 = ['phys', 'strike', 'slash', 'pierce', 'mag', 'fire', 'ligt', 'holy'];
  var RES4 = ['immunity', 'robustness', 'focus', 'vitality'];
  var STATUS6 = ['bleed', 'frost', 'poison', 'rot', 'sleep', 'madness'];

  function scalingRow(scaling) {
    if (!scaling) return '';
    var cells = STAT5.filter(function (k) {
      return scaling[k] && scaling[k].letter;
    }).map(function (k) {
      var s = scaling[k];
      return (
        '<div class="sc-cell"><span class="sc-k">' + esc(ER.fmt.stat(k)) + '</span>' +
        '<span class="sc-l l' + esc(String(s.letter).replace(/[^A-Za-z]/g, '')) + '">' + esc(s.letter) + '</span></div>'
      );
    });
    if (!cells.length) return '<p class="e-p faint">This weapon does not scale with any attribute.</p>';
    return '<div class="scalerow">' + cells.join('') + '</div>';
  }

  function reqBlock(reqs) {
    if (!reqs) return '';
    var st = plannerStats();
    var mark = null;
    if (st) {
      mark = {};
      STAT5.forEach(function (k) {
        if (reqs[k]) mark[k] = (Number(st[k]) || 0) >= Number(reqs[k]);
      });
    }
    var grid = numGrid(reqs, STAT5, { mark: mark });
    if (!grid) return '<p class="e-p faint">No attribute requirements.</p>';
    return grid + (st ? '<p class="e-note">' + (canWield({ reqs: reqs }) ? 'You meet these at your planned stats.' : 'You do not meet these at your planned stats yet.') + '</p>' : '');
  }

  function weaponBlock(rec) {
    var out = '';
    out += sec('Requirements', reqBlock(rec.reqs));
    out += sec('Scaling at +0', scalingRow(rec.scaling));
    var ar = rec.baseAr || {};
    var total = DMG5.reduce(function (a, k) {
      return a + (Number(ar[k]) || 0);
    }, 0);
    out += sec(
      'Attack power at +0',
      numGrid(ar, DMG5) +
        (total ? '<div class="total-row"><span>Total</span><b>' + esc(ER.fmt.num(total)) + '</b></div>' : '')
    );
    if (rec.guard && (rec.guard.boost || rec.guard.phys)) {
      out += sec('Guarding', numGrid(rec.guard, ['phys', 'mag', 'fire', 'ligt', 'holy', 'boost'], { keepZero: true }));
    }
    var st = rec.status || {};
    var anyStatus = STATUS6.some(function (k) {
      return Number(st[k]) > 0;
    });
    if (anyStatus) out += sec('Status build-up', numGrid(st, STATUS6));
    out += sec(
      'The rest of the numbers',
      statTable([
        ['Weapon type', rec['class']],
        ['Weight', rec.weight],
        ['Critical', rec.critical],
        ['Attack type', rec.attackType],
        ['FP cost', rec.fpCost],
        ['Upgrades with', rec.upgrade === 'somber' ? 'Somber Smithing Stones (to +10)' : rec.upgrade === 'smithing' ? 'Smithing Stones (to +25)' : null],
        ['Ashes of War', rec.infusable === true ? 'Can be changed and infused' : rec.infusable === false ? 'Locked to its own skill' : null]
      ])
    );
    if (rec.skill) {
      var ash = ER.byId(rec.skill);
      out += sec('Weapon skill', ash ? linkChips([rec.skill]) : '<p class="e-p">' + esc(rec.skillName || 'Unique skill') + '</p>');
    } else if (rec.skillName) {
      out += sec('Weapon skill', '<p class="e-p">' + esc(rec.skillName) + '</p>');
    }
    if ((rec.tags || []).length) out += sec('Tags', wordChips(rec.tags, 'tiny'));
    return out;
  }

  function armorBlock(rec) {
    var out = '';
    out += sec(
      'Worn',
      statTable([
        ['Slot', rec.slot ? rec.slot.charAt(0).toUpperCase() + rec.slot.slice(1) : null],
        ['Weight', rec.weight],
        ['Poise', rec.poise]
      ])
    );
    out += sec('Damage negation', barGrid(rec.negation, NEG8));
    out += sec('Resistance', barGrid(rec.resist, RES4));
    if (rec.set) {
      var set = ER.byId(rec.set);
      if (set) out += sec('Part of a set', linkChips([rec.set]));
    } else {
      out += sec('Part of a set', '<p class="e-p faint">A loose piece - it belongs to no set.</p>');
    }
    return out;
  }

  function armorSetBlock(rec) {
    var t = rec.totals || {};
    var out = '';
    out += sec('Full set totals', statTable([['Weight', t.weight], ['Poise', t.poise]]));
    out += sec('Damage negation (all four pieces)', barGrid(t.negation, NEG8));
    out += sec('Resistance (all four pieces)', barGrid(t.resist, RES4));
    out += sec('Pieces', linkChips(rec.pieces));
    return out;
  }

  function talismanBlock(rec) {
    var out = '';
    if (rec.effect) out += sec('What it does', '<p class="e-p">' + esc(rec.effect) + '</p>');
    out += sec(
      'Numbers',
      statTable([
        ['Weight', rec.weight],
        ['Stacks with itself', rec.stacks === true ? 'Yes' : rec.stacks === false ? 'No - only the strongest counts' : null]
      ])
    );
    return out;
  }

  function spellBlock(rec) {
    var out = '';
    out += sec('Requirements', reqBlock(rec.reqs));
    out += sec(
      'Casting',
      statTable([
        ['Kind', rec.type ? rec.type.charAt(0).toUpperCase() + rec.type.slice(1) : null],
        ['School', rec.school],
        ['FP cost', rec.fp],
        ['Memory slots', rec.slots],
        ['Stamina', rec.stamina],
        ['Can be charged', rec.chargeable === true ? 'Yes' : rec.chargeable === false ? 'No' : null]
      ])
    );
    return out;
  }

  function ashBlock(rec) {
    var out = '';
    if (rec.skillDesc) out += sec('The skill', '<p class="e-p">' + esc(rec.skillDesc) + '</p>');
    out += sec('Numbers', statTable([['Default affinity', rec.affinity], ['FP cost', rec.fp]]));
    if ((rec.weaponClasses || []).length) out += sec('Goes on', wordChips(rec.weaponClasses, 'tiny'));
    return out;
  }

  function spiritBlock(rec) {
    var c = rec.cost || {};
    var out = '';
    out += sec(
      'Summoning',
      statTable([
        ['Cost', c.value ? ER.fmt.num(c.value) + ' ' + (c.kind === 'hp' ? 'HP' : 'FP') : null],
        ['Summons', rec.summons],
        ['Upgrades with', rec.upgrade === 'ghost-glovewort' ? 'Ghost Gloveworts' : rec.upgrade === 'glovewort' ? 'Gloveworts' : null]
      ])
    );
    return out;
  }

  var ITEM_KIND = {
    consumable: 'Consumable', crafting: 'Crafting material', key: 'Key item',
    bellBearing: 'Bell Bearing', cookbook: 'Cookbook', crystalTear: 'Crystal Tear',
    greatRune: 'Great Rune', tool: 'Tool', whetblade: 'Whetblade', gesture: 'Gesture',
    upgrade: 'Upgrade material', other: 'Item'
  };

  function itemBlock(rec) {
    var out = '';
    if (rec.effect) out += sec('What it does', '<p class="e-p">' + esc(rec.effect) + '</p>');
    out += sec(
      'Kind',
      statTable([
        ['Category', ITEM_KIND[rec.kind] || rec.kind],
        ['Craftable', rec.craftable === true ? 'Yes' : rec.craftable === false ? 'No' : null]
      ])
    );
    if ((rec.recipe || []).length) {
      out += sec(
        'Recipe',
        '<div class="reclist">' +
          rec.recipe
            .map(function (ing) {
              var r = ER.byId(ing.id);
              return (
                '<div class="rec-row"' + (r ? ' data-entity="' + esc(ing.id) + '"' : '') + '>' +
                (r ? iconHtml(r, ER.groupOf(ing.id), 's24') : '') +
                '<span class="rec-n">' + esc(r ? r.name : ing.id) + '</span>' +
                '<span class="rec-q">x' + esc(ER.fmt.num(ing.qty)) + '</span></div>'
              );
            })
            .join('') +
          '</div>'
      );
    }
    return out;
  }

  var BOSS_KIND = {
    main: 'Main path boss', remembrance: 'Remembrance boss', field: 'Field boss',
    dungeon: 'Dungeon boss', evergaol: 'Evergaol'
  };

  function bossBlock(rec) {
    var region = rec.region ? ER.byId(rec.region) : null;
    var out = '';
    out += sec(
      'The fight',
      statTable([
        ['Kind', BOSS_KIND[rec.kind] || rec.kind],
        ['Region', region ? region.name : rec.region],
        ['Optional', rec.optional === true ? 'Yes - you can walk past it' : rec.optional === false ? 'No - it stands on the main path' : null],
        ['Runes', rec.runes ? ER.fmt.num(rec.runes) : null],
        ['Comfortable at about', rec.recommendedLevel ? 'level ' + ER.fmt.num(rec.recommendedLevel) : null]
      ])
    );
    if ((rec.weak || []).length) out += sec('Hurts it most', wordChips(rec.weak, 'good'));
    if ((rec.immune || []).length) out += sec('Does nothing to it', wordChips(rec.immune, 'bad'));
    if (rec.strategy) out += sec('How to beat it', prose(rec.strategy));
    if ((rec.drops || []).length) out += sec('Drops', linkChips(rec.drops));
    if (region) out += sec('Region', linkChips([rec.region]));
    return out;
  }

  var WORLD_NAME = { lands: 'The Lands Between', underground: 'The Underground', shadow: 'Land of Shadow' };

  function graceBlock(rec) {
    var region = rec.region ? ER.byId(rec.region) : null;
    return sec(
      'Where it is',
      statTable([
        ['World', WORLD_NAME[rec.world] || rec.world],
        ['Region', region ? region.name : rec.region]
      ])
    ) + (region ? sec('Region', linkChips([rec.region])) : '');
  }

  function regionBlock(rec) {
    var lvl = rec.recommendedLevel || {};
    var out = '';
    out += sec(
      'The place',
      statTable([
        ['World', WORLD_NAME[rec.world] || rec.world],
        ['Comfortable at', lvl.min || lvl.max ? 'level ' + ER.fmt.num(lvl.min) + ' to ' + ER.fmt.num(lvl.max) : null]
      ])
    );
    if ((rec.bosses || []).length) out += sec('Bosses here', linkChips(rec.bosses));
    if ((rec.graces || []).length) out += sec('Sites of Grace here', linkChips(rec.graces));
    return out;
  }

  function npcBlock(rec) {
    var out = '';
    out += sec('Who they are', statTable([['Role', rec.role]]));
    if ((rec.locations || []).length) out += sec('Where you meet them', wordChips(rec.locations));
    if (rec.questId && ER.byId(rec.questId)) out += sec('Their questline', linkChips([rec.questId]));
    return out;
  }

  function trackerFor() {
    try {
      if (ER.tracker && typeof ER.tracker.isDone === 'function') return ER.tracker;
    } catch (e) {}
    return null;
  }

  function questBlock(rec) {
    var tr = trackerFor();
    var npc = rec.npc ? ER.byId(rec.npc) : null;
    var out = '';
    out += sec(
      'The questline',
      statTable([
        ['Given by', npc ? npc.name : rec.npc],
        ['Can be lost', rec.missable === true ? 'Yes - the steps below have to be done in order' : rec.missable === false ? 'No - it waits for you' : null],
        ['Steps', (rec.steps || []).length || null]
      ])
    );
    if ((rec.steps || []).length) {
      out += sec(
        'Steps',
        '<ol class="qsteps">' +
          rec.steps
            .map(function (s, i) {
              var done = tr ? !!tr.isDone(s.id) : false;
              var locks = (s.lockouts || [])
                .map(function (l) {
                  var ref = l.ref ? ER.byId(l.ref) : null;
                  return (
                    '<span class="lockout"><span class="lock-ic" aria-hidden="true">&#9888;</span>' +
                    esc(l.note || (ref ? 'Doing ' + ref.name + ' first ends this step.' : 'This step can be locked out.')) +
                    '</span>'
                  );
                })
                .join('');
              return (
                '<li class="qstep' + (done ? ' done' : '') + '">' +
                (tr
                  ? '<button class="qtick" type="button" role="checkbox" aria-checked="' + (done ? 'true' : 'false') +
                    '" data-tracker-toggle="' + esc(s.id) + '" aria-label="Mark step ' + (i + 1) + '"></button>'
                  : '<span class="qnum">' + (i + 1) + '</span>') +
                '<span class="qbody"><span class="qtext">' + esc(s.text) + '</span>' +
                (s.location ? '<span class="qloc">' + esc(s.location) + '</span>' : '') +
                locks +
                (s.pin ? '<button class="qmap" type="button" data-pin="' + esc(s.pin) + '">Show on map</button>' : '') +
                '</span></li>'
              );
            })
            .join('') +
          '</ol>'
      );
    }
    if ((rec.rewards || []).length) out += sec('Rewards', linkChips(rec.rewards));
    return out;
  }

  var CLASS_STATS = ['vig', 'mind', 'end', 'str', 'dex', 'int', 'fai', 'arc'];

  function classBlock(rec) {
    var out = '';
    out += sec('Starting attributes', numGrid(rec.stats, CLASS_STATS, { keepZero: true }));
    out += sec(
      'At a glance',
      statTable([
        ['Starting level', rec.level],
        ['Best suited to', rec.goodFor],
        ['Starting HP', rec.derived && rec.derived.hp],
        ['Starting FP', rec.derived && rec.derived.fp],
        ['Stamina', rec.derived && rec.derived.stamina],
        ['Equip load', rec.derived && rec.derived.equipLoad]
      ])
    );
    var gear = linkChips(rec.gear);
    if (gear) out += sec('Starting gear', gear);
    else if ((rec.gearNames || []).length) out += sec('Starting gear', wordChips(rec.gearNames, 'tiny'));
    return out;
  }

  function guideBlock(rec) {
    var out = '';
    if (rec.fantasy) out += sec('The idea', '<p class="lede">' + esc(rec.fantasy) + '</p>');
    var cls = rec.classId ? ER.byId(rec.classId) : null;
    if (cls) out += sec('Starts from', linkChips([rec.classId]));
    if (rec.whyItWorks) out += sec('Why it works', prose(rec.whyItWorks));
    return out;
  }

  function mechanicBlock(rec) {
    var m = ER.data.mechanics || {};
    if (rec.mechKind === 'attribute') {
      var caps = rec.softCaps || [];
      return (
        sec(
          'Where it stops paying off',
          caps.length
            ? '<div class="caps">' +
              caps
                .map(function (c) {
                  return (
                    '<div class="cap-row"><span class="cap-l">' + esc(c.label) + '</span>' +
                    '<span class="cap-v">level ' + esc(ER.fmt.num(c.level)) + '</span></div>'
                  );
                })
                .join('') +
              '</div>' +
              '<p class="e-note">Past a soft cap each point still helps, just less. The last one is where it stops ' +
              'being worth the runes compared with anything else you could raise.</p>'
            : '<p class="e-p faint">No soft-cap table for this attribute in this data pull.</p>'
        )
      );
    }
    if (rec.mechKind === 'status') {
      var s = rec.status || {};
      return (
        sec('Resisted by', s.resistStat ? '<p class="e-p">' + esc(s.resistStat) + '</p>' : '') +
        sec('Reduced by', wordChips(s.mitigatedBy)) +
        sec('Cured by', wordChips(s.curedBy))
      );
    }
    if (rec.table === 'runeCost') {
      var rows = (m.runeCost || []).filter(function (r) {
        return r.level % 10 === 0 || r.level === 1;
      });
      return sec(
        'Every tenth level',
        '<div class="dtable"><div class="dt-head"><span>Level</span><span>Next level</span><span>Runes spent</span></div>' +
          rows
            .map(function (r) {
              return (
                '<div class="dt-row"><span>' + esc(ER.fmt.num(r.level)) + '</span>' +
                '<span>' + esc(ER.fmt.num(r.toNext)) + '</span>' +
                '<span>' + esc(ER.fmt.num(r.total)) + '</span></div>'
              );
            })
            .join('') +
          '</div>'
      );
    }
    if (rec.table === 'scadutree') {
      return sec(
        'Blessing levels',
        '<div class="dtable"><div class="dt-head"><span>Level</span><span>Fragments</span><span>Damage dealt</span><span>Damage taken</span></div>' +
          (m.scadutree || [])
            .map(function (r) {
              return (
                '<div class="dt-row' + (r.softCap ? ' hi' : '') + '"><span>' + esc(ER.fmt.num(r.level)) + '</span>' +
                '<span>' + esc(ER.fmt.num(r.totalFragments)) + '</span>' +
                '<span>' + esc((Number(r.damageDealt) * 100).toFixed(0)) + '%</span>' +
                '<span>' + esc((Number(r.damageReceived) * 100).toFixed(0)) + '%</span></div>'
              );
            })
            .join('') +
          '</div>' +
          '<p class="e-note">In the expansion this matters far more than your level. Fragments are scattered across ' +
          'the Land of Shadow and cost nothing but the walk.</p>'
      );
    }
    return '';
  }

  var BLOCKS = {
    weapons: weaponBlock, armor: armorBlock, armorSets: armorSetBlock,
    talismans: talismanBlock, spells: spellBlock, ashes: ashBlock,
    spirits: spiritBlock, items: itemBlock, bosses: bossBlock,
    graces: graceBlock, regions: regionBlock, npcs: npcBlock,
    quests: questBlock, classes: classBlock, guides: guideBlock,
    mechanics: mechanicBlock
  };

  /* ------------------------------------------------------- the entity sheet */

  /* Most entities get a framed icon slot. Bosses and NPCs get a banner instead:
     they are the two groups a player looks up mid-fight or mid-questline, and
     the thing they need first is not a stat table - it is "which fight is this,
     where, and what is it worth". So the banner carries the portrait, the kind,
     the region and the one number that matters, laid out like the boss card the
     game itself shows on a fog gate. Every value is optional; a boss with no
     portrait and no rune value still renders a correct, quieter banner. */
  function entityHeadHtml(rec, group) {
    if (group !== 'bosses' && group !== 'npcs') {
      return '<div class="ehead">' + iconHtml(rec, group, 's64') + '</div>';
    }
    var region = rec.region ? ER.byId(rec.region) : null;
    var meta = [];
    if (group === 'bosses') {
      if (BOSS_KIND[rec.kind]) meta.push(BOSS_KIND[rec.kind]);
      if (region) meta.push(region.name);
      else if (rec.locationRef && ER.byId(rec.locationRef.region)) meta.push(ER.byId(rec.locationRef.region).name);
    } else {
      if (rec.role) meta.push(rec.role);
      if ((rec.locations || []).length) meta.push(rec.locations[0]);
    }
    var big = '';
    if (group === 'bosses' && rec.runes) {
      big =
        '<div class="bh-runes"><span class="bh-rn">' + esc(ER.fmt.num(rec.runes)) + '</span>' +
        '<span class="bh-rl">runes</span></div>';
    } else if (group === 'npcs' && rec.questId && ER.byId(rec.questId)) {
      big = '<div class="bh-runes"><span class="bh-rn">' + esc(ER.fmt.num((ER.byId(rec.questId).steps || []).length)) +
        '</span><span class="bh-rl">quest steps</span></div>';
    }
    return (
      '<div class="bhead' + (group === 'bosses' ? ' boss' : ' npc') + '">' +
      '<span class="bh-frame">' + iconHtml(rec, group, 's64') + '</span>' +
      '<span class="bh-body">' +
      (meta.length ? '<span class="bh-meta">' + meta.map(esc).join(' &middot; ') + '</span>' : '') +
      (rec.optional === false ? '<span class="bh-flag">Stands on the main path</span>' : '') +
      (rec.optional === true ? '<span class="bh-flag opt">You can walk past this one</span>' : '') +
      '</span>' + big +
      '</div>'
    );
  }

  ER.openEntity = function (id) {
    var rec = ER.byId(id);
    if (!rec) {
      ER.toast('That entry is not in this data pull');
      return;
    }
    var group = ER.groupOf(id);
    var beginner = '';
    if (rec.whatItIs) beginner += sec('What it is', prose(rec.whatItIs, 'lede'));
    if (rec.whyItMatters) beginner += sec('Why it matters', prose(rec.whyItMatters));
    if (rec.whenToUse) beginner += sec('When to use it', prose(rec.whenToUse));

    var block = '';
    try {
      block = (BLOCKS[group] || function () {
        return '';
      })(rec);
    } catch (e) {
      block = '';
    }

    var flavour = '';
    if (rec.desc) flavour += '<div class="ingame">' + prose(rec.desc, 'ig-p') + '</div>';
    if (rec.lore) flavour += '<div class="ingame lore">' + prose(rec.lore, 'ig-p') + '</div>';
    if (flavour) flavour = sec('In game it reads', flavour);

    var where = '';
    if (rec.location) where += prose(rec.location);
    if (where) where = sec('Where to find it', where);

    var actions = [];
    var ma = mapAction(rec);
    if (ma) actions.push(ma);
    if (group === 'guides') {
      actions.push({
        label: 'Open the full build',
        onClick: function () {
          ER.sheet.close();
          ER.navigate('builds', [rec.slug]);
        }
      });
    }
    if (group === 'classes' && ER.planner) {
      actions.push({
        label: 'Load into the planner',
        onClick: function () {
          ER.sheet.close();
          ER.navigate('builds', ['planner']);
        }
      });
    }

    var subBits = [ER.groupLabel(group)];
    if (rec['class']) subBits.push(rec['class']);
    if (rec.slot) subBits.push(rec.slot.charAt(0).toUpperCase() + rec.slot.slice(1));
    if (rec.type) subBits.push(rec.type.charAt(0).toUpperCase() + rec.type.slice(1));
    if (rec.kind && BOSS_KIND[rec.kind]) subBits.push(BOSS_KIND[rec.kind]);

    ER.sheet.open({
      key: 'ent:' + id,
      title: rec.name || String(id),
      icon: null,
      /* sub is the ONE place a sheet takes markup rather than text, so the
         SotE badge can sit inline. Every part is escaped before it is joined. */
      sub: subBits.filter(Boolean).map(esc).join(' &middot; ') +
        (rec.src === 'sote' ? ' <span class="src-badge">SotE</span>' : ''),
      html:
        entityHeadHtml(rec, group) +
        (beginner || '<p class="e-p faint">The plain-English notes for this entry are not in this data pull yet.</p>') +
        block +
        flavour +
        where,
      actions: actions
    });
  };

  /* ------------------------------------------------------------ the WIKI tab */

  var VIEWS = {
    weapons: {
      label: 'Weapons', layout: 'grid', facetLabel: 'Type',
      facet: function (r) {
        return r['class'] || null;
      },
      sub: function (r) {
        var ar = r.baseAr || {};
        var t = ['phys', 'mag', 'fire', 'ligt', 'holy'].reduce(function (a, k) {
          return a + (Number(ar[k]) || 0);
        }, 0);
        return t ? t + ' AR at +0' : r['class'] || '';
      }
    },
    armorSets: { label: 'Sets', layout: 'list', facet: null, sub: function (r) {
      return (r.pieces || []).length + ' pieces';
    } },
    armor: {
      label: 'Pieces', layout: 'grid', facetLabel: 'Slot',
      facet: function (r) {
        return r.slot ? r.slot.charAt(0).toUpperCase() + r.slot.slice(1) : null;
      },
      sub: function (r) {
        return r.weight !== undefined ? r.weight + ' wt' : '';
      }
    },
    talismans: { label: 'Talismans', layout: 'grid', facet: null, sub: function (r) {
      return r.weight !== undefined ? r.weight + ' wt' : '';
    } },
    spells: {
      label: 'Spells', layout: 'grid', facetLabel: 'Kind',
      facet: function (r) {
        return r.type ? r.type.charAt(0).toUpperCase() + r.type.slice(1) : null;
      },
      sub: function (r) {
        return (r.fp ? r.fp + ' FP' : '') + (r.slots ? ' - ' + r.slots + ' slot' + (r.slots > 1 ? 's' : '') : '');
      }
    },
    ashes: {
      label: 'Ashes of War', layout: 'grid', facetLabel: 'Affinity',
      facet: function (r) {
        return r.affinity || null;
      },
      sub: function (r) {
        return r.affinity || '';
      }
    },
    spirits: { label: 'Spirit Ashes', layout: 'grid', facet: null, sub: function (r) {
      var c = r.cost || {};
      return c.value ? c.value + ' ' + (c.kind === 'hp' ? 'HP' : 'FP') : '';
    } },
    items: {
      label: 'Items', layout: 'grid', facetLabel: 'Category',
      facet: function (r) {
        return ITEM_KIND[r.kind] || r.kind || null;
      },
      sub: function (r) {
        return ITEM_KIND[r.kind] || '';
      }
    },
    bosses: {
      label: 'Bosses', layout: 'list', facetLabel: 'Kind',
      facet: function (r) {
        return BOSS_KIND[r.kind] || r.kind || null;
      },
      sub: function (r) {
        var reg = r.region ? ER.byId(r.region) : null;
        return [reg ? reg.name : '', r.runes ? ER.fmt.num(r.runes) + ' runes' : ''].filter(Boolean).join(' - ');
      }
    },
    npcs: { label: 'NPCs', layout: 'list', facet: null, sub: function (r) {
      return r.role || '';
    } },
    quests: { label: 'Questlines', layout: 'list', facet: null, sub: function (r) {
      var n = ER.byId(r.npc);
      return [n ? n.name : '', (r.steps || []).length + ' steps'].filter(Boolean).join(' - ');
    } },
    regions: {
      label: 'Regions', layout: 'list', facetLabel: 'World',
      facet: function (r) {
        return WORLD_NAME[r.world] || r.world || null;
      },
      sub: function (r) {
        var l = r.recommendedLevel || {};
        return l.min ? 'level ' + l.min + ' to ' + l.max : WORLD_NAME[r.world] || '';
      }
    },
    graces: {
      label: 'Sites of Grace', layout: 'list', facetLabel: 'World',
      facet: function (r) {
        return WORLD_NAME[r.world] || r.world || null;
      },
      sub: function (r) {
        var reg = r.region ? ER.byId(r.region) : null;
        return reg ? reg.name : WORLD_NAME[r.world] || '';
      }
    },
    mechanics: {
      label: 'Mechanics', layout: 'list', facetLabel: 'Kind',
      facet: function (r) {
        return r.mechKind === 'attribute' ? 'Attributes' : r.mechKind === 'status' ? 'Status effects' : 'Tables';
      },
      sub: function (r) {
        return r.mechKind === 'attribute' ? 'Attribute' : r.mechKind === 'status' ? 'Status effect' : 'Reference table';
      }
    },
    classes: { label: 'Classes', layout: 'grid', facet: null, sub: function (r) {
      return 'Level ' + r.level;
    } }
  };

  var SEGMENTS = [
    { id: 'weapons', label: 'Weapons', views: ['weapons'] },
    { id: 'armor', label: 'Armour', views: ['armorSets', 'armor'] },
    { id: 'talismans', label: 'Talismans', views: ['talismans'] },
    { id: 'spells', label: 'Spells', views: ['spells'] },
    { id: 'ashes', label: 'Ashes of War', views: ['ashes'] },
    { id: 'spirits', label: 'Spirit Ashes', views: ['spirits'] },
    { id: 'items', label: 'Items', views: ['items'] },
    { id: 'bosses', label: 'Bosses', views: ['bosses'] },
    { id: 'npcs', label: 'NPCs & Quests', views: ['npcs', 'quests'] },
    { id: 'graces', label: 'Graces & Regions', views: ['regions', 'graces'] },
    { id: 'mechanics', label: 'Mechanics', views: ['mechanics', 'classes'] }
  ];

  var S = { seg: 'weapons', view: null, facet: 'all', q: '', fits: false, limit: 90, pane: null };

  /* A segment can hold two datasets (Armour = sets + pieces; NPCs & Quests;
     Graces & Regions; Mechanics + Classes). The hash route is
     #wiki/<group>/<slug> where <group> is a DATASET name, so every dataset has
     to resolve back to the segment that shows it - otherwise a perfectly valid
     deep link to a class or a questline lands nowhere. */
  var VIEW_SEG = Object.create(null);
  SEGMENTS.forEach(function (s) {
    s.views.forEach(function (v) {
      VIEW_SEG[v] = s.id;
    });
  });

  function segOf(id) {
    for (var i = 0; i < SEGMENTS.length; i++) if (SEGMENTS[i].id === id) return SEGMENTS[i];
    return null;
  }
  /* Accepts either a segment id or a dataset name and answers with both. */
  function resolveTarget(id) {
    if (!id) return null;
    var seg = segOf(id);
    if (seg) return { seg: seg.id, view: seg.views[0] };
    if (VIEW_SEG[id]) return { seg: VIEW_SEG[id], view: id };
    return null;
  }
  function recordsOf(view) {
    var arr = view === 'mechanics' ? ER.mechanics || [] : ER.data[view];
    return Array.isArray(arr) ? arr : [];
  }

  function filtered() {
    var view = S.view;
    var def = VIEWS[view] || {};
    var ql = S.q.trim().toLowerCase();
    var rows = recordsOf(view).filter(function (r) {
      if (!r || !ER.srcOn(r.src)) return false;
      if (S.facet !== 'all' && def.facet && def.facet(r) !== S.facet) return false;
      if (ql && String(r.name || '').toLowerCase().indexOf(ql) === -1) return false;
      if (S.fits && r.reqs) {
        var ok = canWield(r);
        if (ok === false) return false;
      }
      return true;
    });
    rows.sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return rows;
  }

  function facetValues() {
    var def = VIEWS[S.view] || {};
    if (!def.facet) return [];
    var seen = Object.create(null);
    var out = [];
    recordsOf(S.view).forEach(function (r) {
      if (!r || !ER.srcOn(r.src)) return;
      var f = def.facet(r);
      if (!f || seen[f]) return;
      seen[f] = 1;
      out.push(f);
    });
    return out.sort();
  }

  function renderList() {
    var host = S.pane && S.pane.querySelector('[data-wiki-list]');
    if (!host) return;
    var def = VIEWS[S.view] || {};
    var rows = filtered();
    var shown = rows.slice(0, S.limit);
    var count = S.pane.querySelector('[data-wiki-count]');
    if (count) {
      count.textContent = rows.length + (rows.length === 1 ? ' entry' : ' entries') +
        (rows.length > shown.length ? ' - showing ' + shown.length : '');
    }
    if (!rows.length) {
      host.className = 'wlist empty';
      host.innerHTML =
        '<div class="empty-panel"><p>Nothing here matches.</p>' +
        (!ER.modes.sote
          ? '<p class="faint">Shadow of the Erdtree is switched off, so its entries are hidden everywhere.</p>'
          : '') +
        '</div>';
      return;
    }
    host.className = 'wlist ' + (def.layout === 'grid' ? 'grid' : 'rows');
    host.innerHTML =
      shown
        .map(function (r) {
          return ER.entityCardHtml(r, { layout: def.layout, group: S.view, sub: def.sub ? def.sub(r) : '' });
        })
        .join('') +
      (rows.length > shown.length
        ? '<button class="btn more" type="button" data-wiki-more>Show ' + Math.min(90, rows.length - shown.length) + ' more</button>'
        : '');
  }

  function renderControls() {
    var host = S.pane && S.pane.querySelector('[data-wiki-controls]');
    if (!host) return;
    var seg = segOf(S.seg);
    var def = VIEWS[S.view] || {};
    var views = seg && seg.views.length > 1
      ? '<div class="viewswitch">' +
        seg.views
          .map(function (v) {
            return (
              '<button class="vsw' + (v === S.view ? ' on' : '') + '" type="button" data-wiki-view="' + esc(v) + '">' +
              esc((VIEWS[v] || {}).label || v) + '</button>'
            );
          })
          .join('') +
        '</div>'
      : '';
    var facets = facetValues();
    var chips = facets.length
      ? '<div class="chipscroll" role="group" aria-label="' + esc(def.facetLabel || 'Filter') + '">' +
        '<button class="fchip' + (S.facet === 'all' ? ' on' : '') + '" type="button" data-wiki-facet="all">All</button>' +
        facets
          .map(function (f) {
            return '<button class="fchip' + (S.facet === f ? ' on' : '') + '" type="button" data-wiki-facet="' + esc(f) + '">' + esc(f) + '</button>';
          })
          .join('') +
        '</div>'
      : '';
    var fits = ER.planner && plannerStats()
      ? '<label class="togline"><input type="checkbox" data-wiki-fits' + (S.fits ? ' checked' : '') +
        ' /> <span>Only what I can use at my planned stats</span></label>'
      : '';
    host.innerHTML =
      views + chips +
      '<div class="wfilter">' +
      '<input class="wsearch" type="search" placeholder="Filter this list" aria-label="Filter this list" data-wiki-q value="' + esc(S.q) + '" />' +
      '<span class="wcount" data-wiki-count></span>' +
      '</div>' + fits;
  }

  function renderSegments() {
    var host = S.pane && S.pane.querySelector('[data-wiki-segs]');
    if (!host) return;
    host.innerHTML = SEGMENTS.map(function (s) {
      return (
        '<button class="seg' + (s.id === S.seg ? ' on' : '') + '" type="button" data-wiki-seg="' + esc(s.id) + '">' +
        esc(s.label) + '</button>'
      );
    }).join('');
  }

  function renderAll() {
    renderSegments();
    renderControls();
    renderList();
  }

  function setSegment(id, keepFilters) {
    var t = resolveTarget(id) || { seg: SEGMENTS[0].id, view: SEGMENTS[0].views[0] };
    S.seg = t.seg;
    S.view = t.view;
    if (!keepFilters) {
      S.facet = 'all';
      S.q = '';
    }
    S.limit = 90;
    ER.prefs.set('wikiSeg', S.seg);
  }

  ER.registerTab('wiki', {
    label: 'Wiki',
    icon: '&#128220;',
    order: 20,
    mount: function (el) {
      S.pane = el;
      el.innerHTML =
        '<header class="tabhead">' +
        '<h1 class="tabtitle">Everything in the game</h1>' +
        '<p class="tabsub">Every weapon, spell, boss, grace and questline - each one written out in plain English before the numbers.</p>' +
        '</header>' +
        '<div class="segscroll" data-wiki-segs></div>' +
        '<div class="wcontrols" data-wiki-controls></div>' +
        '<div class="wlist" data-wiki-list></div>';
      var saved = ER.prefs.get('wikiSeg', 'weapons');
      setSegment(resolveTarget(saved) ? saved : 'weapons', false);
      renderAll();
    },
    /* #wiki | #wiki/<group> | #wiki/<group>/<slug>. <group> may be a segment id
       or a dataset name; an unknown one leaves the tab where it was rather than
       resetting it, and an unknown slug is looked for across every dataset
       before giving up, so a link written against a neighbouring group still
       opens the right thing. */
    show: function (params) {
      var segId = params && params[0];
      if (segId && resolveTarget(segId)) {
        setSegment(segId, false);
        renderAll();
      }
      var slug = params && params[1];
      if (!slug) return;
      var found = null;
      var order = [];
      if (S.view) order.push(S.view);
      var seg = segOf(S.seg);
      (seg ? seg.views : []).forEach(function (v) {
        if (order.indexOf(v) === -1) order.push(v);
      });
      Object.keys(VIEW_SEG).forEach(function (v) {
        if (order.indexOf(v) === -1) order.push(v);
      });
      order.forEach(function (v) {
        if (found) return;
        var hit = ER.bySlug(v, slug);
        if (hit) found = hit;
      });
      /* Last resort: the hash may carry an id rather than a slug. */
      if (!found && ER.byId(slug)) found = ER.byId(slug);
      if (found) ER.openEntity(found.id);
      else ER.toast('That page is not in this data pull');
    },
    hide: function () {},
    search: function (q) {
      /* The shell already searches every entity by name; the tab contributes
         the one thing it alone knows - jumping straight to a section. */
      var ql = String(q || '').toLowerCase();
      return SEGMENTS.filter(function (s) {
        return s.label.toLowerCase().indexOf(ql) !== -1;
      }).map(function (s) {
        return {
          title: s.label,
          sub: 'Wiki section',
          icon: '&#128220;',
          go: function () {
            ER.navigate('wiki', [s.id]);
          }
        };
      });
    }
  });

  ER.onModeChange(function () {
    if (S.pane) renderAll();
  });

  /* -------------------------------------------------------- tab delegation */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var seg = t.closest('[data-wiki-seg]');
    if (seg) {
      setSegment(seg.getAttribute('data-wiki-seg'), false);
      renderAll();
      return;
    }
    var view = t.closest('[data-wiki-view]');
    if (view) {
      S.view = view.getAttribute('data-wiki-view');
      S.facet = 'all';
      S.limit = 90;
      renderControls();
      renderList();
      return;
    }
    var fc = t.closest('[data-wiki-facet]');
    if (fc) {
      S.facet = fc.getAttribute('data-wiki-facet');
      S.limit = 90;
      renderControls();
      renderList();
      return;
    }
    if (t.closest('[data-wiki-more]')) {
      S.limit += 90;
      renderList();
      return;
    }
    var pin = t.closest('[data-pin]');
    if (pin) {
      var pid = pin.getAttribute('data-pin');
      var p = ER.byId(pid);
      ER.sheet.close();
      ER.navigate('map', [(p && p.world) || 'lands', 'pin', pid]);
      try {
        if (ER.mapApi && typeof ER.mapApi.focusPin === 'function') ER.mapApi.focusPin(pid);
      } catch (err) {}
      return;
    }
    var tick = t.closest('[data-tracker-toggle]');
    if (tick) {
      var tr = trackerFor();
      if (!tr) return;
      var id = tick.getAttribute('data-tracker-toggle');
      try {
        tr.toggle(id);
      } catch (err) {}
      var now = !!tr.isDone(id);
      tick.setAttribute('aria-checked', now ? 'true' : 'false');
      var li = tick.closest('.qstep');
      if (li) li.classList.toggle('done', now);
    }
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-wiki-q')) {
      S.q = t.value || '';
      S.limit = 90;
      renderList();
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-wiki-fits')) {
      S.fits = !!t.checked;
      S.limit = 90;
      renderList();
    }
  });
})();
