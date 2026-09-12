/* ==========================================================================
   /island/clips - client logic (classic end-of-body script).

   GALLERY-ONLY (2026-08-31): the Send/My-clips tabs (a resumable tus-lite
   uploader + GET /api/status against a private dropserver) were
   retired from the public site - big uploads never reliably finished, and
   sending clips in is moving to a Patreon patron perk instead. This script
   now only fetches and renders the static gallery.json from THIS origin.

   HARD RULE: every value that comes back from gallery.json is untrusted
   text. It is only ever written with textContent / createTextNode, never
   innerHTML - a friend can type anything into their clip name. No string
   from the wire is ever interpolated into markup here.
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.FI_CLIPS || {};
  var GALLERY_URL = String(CFG.galleryUrl || '');

  // ---- tiny DOM helpers ---------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // textContent: never innerHTML
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // ---- formatting ---------------------------------------------------------
  function fmtDur(s) {
    s = Math.round(Number(s) || 0);
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function agoLabel(ts) {
    if (!ts) return '';
    ts = Number(ts);
    if (ts > 1e12) ts = ts / 1000; // tolerate ms timestamps
    var d = Date.now() / 1000 - ts;
    if (d < 0) d = 0;
    var day = 86400;
    if (d < 3600) return 'just now';
    if (d < day) return Math.max(1, Math.round(d / 3600)) + 'h ago';
    var days = Math.round(d / day);
    if (days < 30) return days + 'd ago';
    var months = Math.round(days / 30);
    if (months < 12) return months + 'mo ago';
    return Math.round(months / 12) + 'y ago';
  }
  function platformInfo(p) {
    var s = String(p || '').toLowerCase();
    if (s.indexOf('you') >= 0 || s === 'yt') return { key: 'youtube', label: 'YouTube' };
    if (s.indexOf('tik') >= 0 || s === 'tt') return { key: 'tiktok', label: 'TikTok' };
    if (s.indexOf('insta') >= 0 || s === 'ig') return { key: 'instagram', label: 'Instagram' };
    return { key: 'other', label: p ? String(p) : 'Link' };
  }

  // ======================================================================
  //  GALLERY
  // ======================================================================
  var GALLERY = { all: [], platform: '', game: '' };

  function galleryDir() {
    var i = GALLERY_URL.lastIndexOf('/');
    return i >= 0 ? GALLERY_URL.slice(0, i) : '';
  }
  function thumbUrl(rel) {
    rel = String(rel || '');
    if (!rel) return '';
    if (/^https?:\/\//i.test(rel) || rel.charAt(0) === '/') return rel;
    return galleryDir() + '/' + rel;
  }

  function loadGallery() {
    var host = $('clips-gallery');
    var filters = $('clips-filters');
    if (!host) return;
    clear(host);
    host.appendChild(el('div', 'fi-clips-msg fi-clips-msg--info', 'Loading the gallery...'));
    if (!GALLERY_URL) { renderGallery([]); return; }
    fetch(GALLERY_URL, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var clips = data && Array.isArray(data.clips) ? data.clips : [];
        GALLERY.all = clips;
        buildFilters(clips);
        applyGallery();
        if (data && data.sample) {
          var note = $('clips-sample-note');
          if (note) note.hidden = false;
        }
      })
      .catch(function () { GALLERY.all = []; if (filters) clear(filters); renderGallery([]); });
  }

  function buildFilters(clips) {
    var host = $('clips-filters');
    if (!host) return;
    clear(host);
    var plats = {}, games = {};
    clips.forEach(function (c) {
      var pi = platformInfo(c.platform);
      plats[pi.key] = pi.label;
      if (c.game) games[c.game] = c.game_name || c.game;
    });
    host.appendChild(chipGroup('Platform', 'platform', plats));
    host.appendChild(chipGroup('Game', 'game', games));
  }
  function chipGroup(label, dim, map) {
    var g = el('div', 'fi-clips-filtergroup');
    g.appendChild(el('span', 'fi-clips-filtergroup__label', label));
    g.appendChild(chip('All', dim, ''));
    Object.keys(map).forEach(function (k) { g.appendChild(chip(map[k], dim, k)); });
    return g;
  }
  function chip(text, dim, value) {
    var b = el('button', 'fi-clips-chip', text);
    b.type = 'button';
    b.setAttribute('aria-pressed', (GALLERY[dim] || '') === value ? 'true' : 'false');
    b.addEventListener('click', function () {
      GALLERY[dim] = value;
      applyGallery();
      // refresh pressed states within this group
      var group = b.parentNode;
      if (group) {
        var all = group.querySelectorAll('.fi-clips-chip');
        for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-pressed', all[i] === b ? 'true' : 'false');
      }
    });
    return b;
  }
  function applyGallery() {
    var list = GALLERY.all.filter(function (c) {
      if (GALLERY.platform && platformInfo(c.platform).key !== GALLERY.platform) return false;
      if (GALLERY.game && String(c.game || '') !== GALLERY.game) return false;
      return true;
    });
    renderGallery(list);
  }

  function renderGallery(list) {
    var host = $('clips-gallery');
    if (!host) return;
    clear(host);
    if (!list.length) {
      host.appendChild(emptyState('Nothing posted yet',
        GALLERY.all.length ? 'No clips match that filter.' :
        'When a clip a friend sent goes live, it shows up here. Check back soon.'));
      return;
    }
    var grid = el('div', 'fi-clips-grid');
    list.forEach(function (c) { grid.appendChild(galleryCard(c)); });
    host.appendChild(grid);
  }

  function galleryCard(c) {
    var url = String(c.url || '');
    var a = el('a', 'fi-clips-card');
    if (/^https?:\/\//i.test(url)) {
      a.href = url;               // href attribute, not markup - inert as script
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      a.setAttribute('role', 'group');
    }

    var thumbWrap = el('div', 'fi-clips-thumb');
    var pi = platformInfo(c.platform);
    var badge = el('span', 'fi-clips-badge fi-clips-badge--' + pi.key, pi.label);
    var turl = thumbUrl(c.thumb);
    if (turl) {
      var img = el('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = turl;             // URL only; never rendered as markup
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(el('span', 'fi-clips-thumb__ph', '\u{1F3AC}'), img);
      });
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.appendChild(el('span', 'fi-clips-thumb__ph', '\u{1F3AC}'));
    }
    thumbWrap.appendChild(badge);
    if (c.duration_s) thumbWrap.appendChild(el('span', 'fi-clips-badge fi-clips-badge--dur', fmtDur(c.duration_s)));
    a.appendChild(thumbWrap);

    var body = el('div', 'fi-clips-card__body');
    body.appendChild(el('div', 'fi-clips-card__title', String(c.title || 'Untitled clip')));
    var meta = el('div', 'fi-clips-card__meta');
    if (c.game_name || c.game) meta.appendChild(el('span', 'fi-clips-card__game', String(c.game_name || c.game)));
    var when = agoLabel(c.posted_at);
    if (when) { if (meta.firstChild) meta.appendChild(el('span', 'fi-clips-card__dot', '·')); meta.appendChild(el('span', null, when)); }
    if (c.sender) { if (meta.firstChild) meta.appendChild(el('span', 'fi-clips-card__dot', '·')); meta.appendChild(el('span', null, 'clip by ' + String(c.sender))); }
    body.appendChild(meta);
    a.appendChild(body);
    return a;
  }

  function emptyState(title, body) {
    var box = el('div', 'fi-clips-empty');
    box.appendChild(el('div', 'fi-clips-empty__mark', '\u{1F3AC}'));
    box.appendChild(el('h3', null, title));
    box.appendChild(el('p', null, body));
    return box;
  }

  function boot() {
    loadGallery();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
