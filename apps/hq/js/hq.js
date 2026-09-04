// Fiiiish HQ - the UI half. Owns storage, the DOM and the poll loop.
//
// The wire lives in hq-api.js (pure); nothing here builds a URL or parses a
// response by hand. Two rules this file is built around:
//
//   1. NOTHING IS EVER innerHTML'd. Every string that comes off the network -
//      a filename, a stage message, a log line - is written with textContent
//      onto an element this file created. A recording is named by whatever OBS
//      wrote to disk, so it is untrusted text by definition.
//   2. EVERY FETCH DEGRADES. The three failure shapes are told apart and each
//      gets its own calm card: unreachable (the PC is asleep or this phone is
//      off Tailscale), 401 (the token died - Safari can evict site data after
//      about a week when the app is not on the home screen), and a server
//      error. None of them is allowed to render a broken page.
//
// MOCK MODE, for driving the whole route with no server:
//   localStorage.setItem('island.hq.mock', '1'); location.reload();
// hq-api.js then serves a mutable fixture world - assigning really moves a
// recording, the autopilot switch really sticks, a job really has a log tail.
(function () {
  'use strict';

  var API = window.HQ_API;
  var CFG = window.FI_HQ || {};
  if (!API) return;

  var TOKEN_KEY = 'island.hq.token';
  var BASE_KEY = 'island.hq.base';
  var MOCK_KEY = 'island.hq.mock';
  var TAB_KEY = 'island.hq.tab';

  var POLL_MS = 5000;

  // ---------------------------------------------------------------- storage
  // Every access is guarded: iOS private browsing throws on the getter itself,
  // not just on write.
  function get(k) {
    try {
      return window.localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function set(k, v) {
    try {
      window.localStorage.setItem(k, v);
    } catch (e) {
      /* private mode - forget rather than fail */
    }
  }
  function del(k) {
    try {
      window.localStorage.removeItem(k);
    } catch (e) {
      /* same */
    }
  }

  // ------------------------------------------------------------------- DOM
  function $(id) {
    return document.getElementById(id);
  }
  /** Make an element. Text is set with textContent, always. */
  function e(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }
  function sep() {
    return e('span', 'hq-slate__sep', '·');
  }
  /** ts (ms) -> local "HH:MM", for "last seen" labels. Null on a bad input. */
  function fmtClock(ts) {
    if (!ts) return null;
    var d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    var hh = d.getHours();
    var mm = d.getMinutes();
    return (hh < 10 ? '0' + hh : String(hh)) + ':' + (mm < 10 ? '0' + mm : String(mm));
  }

  // -------------------------------------------------------------- lazy media
  // M2: the inbox used to hand every card's peek video and thumb straight to
  // `src`, which fires the request the instant the card is built - 35 cards on
  // first paint means 35 thumb requests before Josia has scrolled past the
  // third one. Assignment is deferred to a single shared IntersectionObserver
  // instead; a card only requests media once it is within ~200px of view.
  var lazyObserver = null;
  function resetLazyObserver() {
    // Called at the top of every full panel rebuild: the old observed nodes
    // are about to be thrown away with the DOM they lived in, so drop the
    // observer rather than let it keep tracking detached elements forever.
    if (lazyObserver) {
      lazyObserver.disconnect();
      lazyObserver = null;
    }
  }
  function applyLazyMedia(el) {
    var src = el.getAttribute('data-hq-lazy-src');
    if (src) {
      el.src = src;
      el.removeAttribute('data-hq-lazy-src');
    }
    var poster = el.getAttribute('data-hq-lazy-poster');
    if (poster) {
      el.poster = poster;
      el.removeAttribute('data-hq-lazy-poster');
    }
  }
  function observeLazy(el) {
    if (typeof IntersectionObserver === 'undefined') {
      applyLazyMedia(el); // no IO support: degrade to eager rather than never load
      return;
    }
    if (!lazyObserver) {
      lazyObserver = new IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            lazyObserver.unobserve(entries[i].target);
            applyLazyMedia(entries[i].target);
          }
        },
        { rootMargin: '200px 0px' }
      );
    }
    lazyObserver.observe(el);
  }

  // ------------------------------------------------------------------ state
  var S = {
    tab: get(TAB_KEY) || 'inbox',
    client: null,
    conn: { state: 'off', attempt: 0, error: null },
    status: null,
    statusAt: null, // Date.now() of the last poll that actually answered - L6
    games: [],
    recs: [],
    jobs: [],
    openGame: null,
    openJob: null,
    sig: null,
    loading: false,
    timer: null,
    toastTimer: null,
    sheetInvoker: null, // L4: the element that opened the sheet, to refocus on close
  };
  if (['inbox', 'games', 'jobs'].indexOf(S.tab) < 0) S.tab = 'inbox';

  // ============================================================== unlock ===
  /**
   * Consume `#t=<token>&b=<base>` from the deep link, then strip it.
   *
   * The hash is stripped with replaceState so the token never survives into a
   * shared link, a screenshot of the URL bar, or the back stack.
   */
  function consumeHash() {
    var h = '';
    try {
      h = (window.location.hash || '').replace(/^#/, '');
    } catch (err) {
      h = '';
    }
    if (!h) return false;
    var token = null;
    var base = null;
    var parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var k = kv[0];
      var v = kv.length > 1 ? kv.slice(1).join('=') : '';
      try {
        v = decodeURIComponent(v);
      } catch (err2) {
        /* leave it raw */
      }
      if (k === 't' && v) token = v;
      if (k === 'b' && v) base = v;
    }
    if (!token && !base) return false;
    if (token) set(TOKEN_KEY, token);
    if (base) set(BASE_KEY, API.normBase(base));
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (err3) {
      /* a browser that refuses replaceState still gets the token stored */
    }
    return true;
  }

  function makeClient() {
    S.client = API.create({
      base: get(BASE_KEY) || CFG.defaultBase || API.DEFAULT_BASE,
      token: get(TOKEN_KEY) || '',
      mock: get(MOCK_KEY) === '1',
    });
  }

  function showUnlock(msg) {
    stopPolling();
    $('hq-app').hidden = true;
    $('hq-unlock').hidden = false;
    var base = $('hq-base');
    base.value = get(BASE_KEY) || CFG.defaultBase || API.DEFAULT_BASE;
    var st = $('hq-unlock-status');
    st.className = msg ? 'hq-status bad' : 'hq-status';
    st.textContent = msg || '';
  }

  function showApp() {
    $('hq-unlock').hidden = true;
    $('hq-app').hidden = false;
    setTab(S.tab, true);
    startPolling();
  }

  // =========================================================== connection ===
  var CONN_WORD = {
    off: 'not linked',
    connecting: 'connecting',
    connected: 'connected',
    reconnecting: 'no answer',
    error: 'blocked',
  };
  function renderConn() {
    var wrap = $('hq-conn');
    var word = $('hq-conn-word');
    var st = S.conn.state;
    wrap.className = 'hq-conn' + (st === 'connected' ? ' on' : st === 'error' ? ' bad' : st === 'reconnecting' ? ' bad' : ' wait');
    word.textContent = CONN_WORD[st] || st;

    var facts = $('hq-facts');
    clear(facts);
    // L6: a poll failure leaves S.status holding whatever the LAST successful
    // poll returned - true until proven otherwise is fine for a live link, but
    // once the link is down those PC facts are no longer current and must not
    // read as if they were. Dim the strip and say when they were last true.
    var stale = st !== 'connected';
    facts.classList.toggle('hq-strip__facts--stale', stale && !!S.status);
    if (!S.status) {
      facts.textContent = st === 'connected' ? 'reading the room' : 'waiting for the Command Center';
      return;
    }
    var bits = [];
    var obs = S.status.obs || {};
    bits.push(obs.recording ? 'REC' : obs.connected ? 'OBS idle' : 'OBS off');
    if (obs.current_profile) bits.push(String(obs.current_profile));
    var slot = S.status.slot || {};
    bits.push(slot.busy ? 'slot busy' : 'slot free');
    if (S.status.disk && S.status.disk.free_gb !== undefined) bits.push(API.fmtGb(S.status.disk.free_gb) + ' free');
    var text = bits.join('  ·  ');
    if (stale) {
      var when = fmtClock(S.statusAt);
      text += when ? ' (last seen ' + when + ')' : ' (last seen)';
    }
    facts.textContent = text;
  }

  function renderBadge() {
    var b = $('hq-badge-inbox');
    var n = 0;
    for (var i = 0; i < S.recs.length; i++) if (S.recs[i].state === 'unsorted') n++;
    if (!n && S.status && S.status.unsorted_count) n = S.status.unsorted_count;
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n);
  }

  // ================================================================ polling ==
  function stopPolling() {
    if (S.timer) {
      clearTimeout(S.timer);
      S.timer = null;
    }
  }
  function schedule(ms) {
    stopPolling();
    if (document.hidden) return; // resumed by the visibilitychange handler
    S.timer = setTimeout(tick, ms);
  }
  function startPolling() {
    stopPolling();
    S.conn = { state: 'connecting', attempt: 0, error: null };
    renderConn();
    tick();
  }

  /** One poll: status, then whatever the open tab needs. */
  function tick() {
    if (!S.client) return;
    S.client.status().then(function (res) {
      S.conn = API.reduceConn(S.conn, res);
      if (res.unauthorized) {
        renderConn();
        maybeRender();
        schedule(API.backoffMs(3));
        return;
      }
      if (res.ok) {
        S.status = res.data;
        S.statusAt = Date.now();
      }
      renderConn();
      renderBadge();
      if (!res.ok) {
        maybeRender();
        schedule(API.backoffMs(S.conn.attempt));
        return;
      }
      refreshTab().then(function () {
        maybeRender();
        schedule(POLL_MS);
      });
    });
  }

  /**
   * Fetch the data the current tab draws. Never rejects.
   *
   * The game list is fetched on EVERY tab, not just the ones that draw tiles.
   * It is the lookup table that turns a game_key into a name and says whether a
   * recipe is built, so the jobs list and the setup sheet both need it - and a
   * cold load straight onto Jobs (the tab is remembered across visits) used to
   * leave it empty: job cards showed the raw key and the setup sheet rendered no
   * autopilot switches at all. It is one small JSON on a poll that is already
   * making a request, so there is nothing to save by skipping it.
   */
  function refreshTab() {
    var jobs = [
      S.client.games().then(function (r) {
        if (r.ok && r.data && r.data.games) S.games = r.data.games;
      }),
    ];
    if (S.tab === 'inbox') {
      jobs.push(
        S.client.recordings({ state: 'unsorted' }).then(function (r) {
          if (r.ok && r.data && r.data.recordings) S.recs = r.data.recordings;
        })
      );
    } else if (S.tab === 'games') {
      if (S.openGame) {
        jobs.push(
          S.client.recordings({ game: S.openGame }).then(function (r) {
            if (r.ok && r.data && r.data.recordings) S.recs = r.data.recordings;
          })
        );
      }
    } else {
      jobs.push(
        S.client.jobs(30).then(function (r) {
          if (r.ok && r.data && r.data.jobs) S.jobs = r.data.jobs;
        })
      );
    }
    return Promise.all(jobs);
  }

  // ================================================================== tabs ==
  function setTab(tab, silent) {
    S.tab = tab;
    if (tab !== 'games') S.openGame = null;
    set(TAB_KEY, tab);
    var btns = document.querySelectorAll('[data-hq-tab]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-selected', btns[i].getAttribute('data-hq-tab') === tab ? 'true' : 'false');
    }
    // L5: the single #hq-panel swaps content per tab rather than keeping three
    // panels in the DOM, so it carries one role="tabpanel" whose aria-labelledby
    // is kept pointed at whichever tab is current.
    var panel = $('hq-panel');
    if (panel) panel.setAttribute('aria-labelledby', 'hq-tab-' + tab);
    renderPanel();
    if (!silent) {
      refreshTab().then(renderPanel);
    }
  }

  // =============================================================== panels ===
  /**
   * Re-render ONLY when something the panel draws has actually changed.
   *
   * The poll runs every 5s. Rebuilding the panel on every tick would tear down
   * and recreate every card - which means a peek video Josia is watching gets
   * destroyed mid-play four times a minute, a half-scrolled log jumps, and a
   * tap that lands during a rebuild hits a detached node and does nothing.
   * (Playwright caught the last one: "element was detached from the DOM".)
   *
   * The signature covers exactly what the panel reads. `status` is NOT in it -
   * its server_time changes every poll and it only feeds the strip, which is
   * updated separately with textContent and never rebuilds anything.
   */
  function panelSig() {
    try {
      return JSON.stringify({
        t: S.tab,
        c: S.conn.state,
        e: S.conn.error,
        g: S.openGame,
        r: S.recs,
        gm: S.games,
        j: S.jobs,
      });
    } catch (err) {
      return String(Math.random()); // unstringifiable = always redraw
    }
  }
  function maybeRender() {
    var sig = panelSig();
    if (sig === S.sig) return;
    S.sig = sig;
    renderPanel();
  }

  function renderPanel() {
    S.sig = panelSig();
    var p = $('hq-panel');
    clear(p);
    resetLazyObserver();

    // The three connection states each get the SAME padded frame as a tab's
    // content, so a calm failure card sits on the page exactly where the room
    // it replaced did - flush-to-the-edge cards read as a layout bug.
    var pad = e('div', 'hq-pad');
    if (S.conn.error === 'unauthorized') {
      p.appendChild(pad);
      pad.appendChild(
        note(
          'Re-unlock needed',
          ['The Command Center rejected this phone’s key.', 'Scan the QR on the Command Center home page to get a fresh one.'],
          true,
          { label: 'Enter a new key', onClick: function () { showUnlock(''); } }
        )
      );
      return;
    }
    if (S.conn.state === 'reconnecting' || (S.conn.state === 'error' && !S.status)) {
      p.appendChild(pad);
      pad.appendChild(
        note(
          'The PC is not answering',
          [
            'The Command Center is offline, or this phone is off Tailscale.',
            'Nothing is lost — HQ picks up where it left off as soon as it can reach the machine again.',
          ],
          false,
          { label: 'Try now', onClick: function () { startPolling(); } }
        )
      );
      return;
    }
    if (!S.status && S.conn.state === 'connecting') {
      p.appendChild(pad);
      pad.appendChild(note('Connecting', ['Looking for the Command Center on the tailnet…'], false, null));
      return;
    }

    if (S.tab === 'inbox') renderInbox(p);
    else if (S.tab === 'games') renderGames(p);
    else renderJobs(p);
  }

  function note(title, lines, bad, action) {
    var n = e('div', 'hq-note' + (bad ? ' hq-note--bad' : ''));
    n.appendChild(e('p', 'hq-note__title', title));
    for (var i = 0; i < lines.length; i++) n.appendChild(e('p', 'hq-note__body', lines[i]));
    if (action) {
      var b = e('button', 'hq-btn', action.label);
      b.type = 'button';
      b.style.marginTop = 'var(--s4)';
      b.addEventListener('click', action.onClick);
      n.appendChild(b);
    }
    return n;
  }

  // ---------------------------------------------------------------- inbox --
  function renderInbox(p) {
    var head = e('div', 'hq-pad');
    head.appendChild(e('h1', 'hq-h', 'Inbox'));
    var unsorted = S.recs.filter(function (r) {
      return r.state === 'unsorted';
    });
    head.appendChild(
      e(
        'p',
        'hq-sub',
        unsorted.length
          ? unsorted.length + (unsorted.length === 1 ? ' recording needs a game.' : ' recordings need a game.')
          : 'Nothing waiting. Everything on the machine is filed.'
      )
    );
    p.appendChild(head);

    if (!unsorted.length) {
      var wrap = e('div', 'hq-pad');
      wrap.appendChild(
        note('Inbox clear', ['New recordings land here about a minute after OBS stops.'], false, {
          label: 'Rescan the folders',
          onClick: doRescan,
        })
      );
      p.appendChild(wrap);
      return;
    }

    var list = e('div', 'hq-pad');
    for (var i = 0; i < unsorted.length; i++) list.appendChild(slate(unsorted[i], true));
    p.appendChild(list);
  }

  /** One recording. `inbox` decides whether it shows sorting or pipeline controls. */
  function slate(rec, inbox) {
    var card = e('article', 'hq-slate');
    card.setAttribute('data-rec', String(rec.id));
    card.style.setProperty('--hq-state', API.stateColorVar(rec.state));

    // --- slug line: the machine facts, in tape-log order -------------------
    var slug = e('div', 'hq-slate__slug');
    slug.appendChild(e('span', null, API.fmtWhen(rec.recorded_at, rec.filename)));
    slug.appendChild(sep());
    slug.appendChild(e('span', null, API.fmtDuration(rec.duration_s)));
    slug.appendChild(sep());
    slug.appendChild(e('span', null, API.fmtSize(rec.size_bytes)));
    if (rec.width && rec.height) {
      slug.appendChild(sep());
      slug.appendChild(e('span', null, rec.height + 'p'));
    }
    var st = e('span', 'hq-slate__state');
    var lamp = e('span', 'hq-lamp' + (rec.state === 'editing' ? ' hq-lamp--live' : ''));
    st.appendChild(lamp);
    st.appendChild(e('span', null, API.stateLabel(rec.state)));
    slug.appendChild(st);
    card.appendChild(slug);

    // --- peek well ---------------------------------------------------------
    card.appendChild(peekWell(rec));

    // --- body --------------------------------------------------------------
    var body = e('div', 'hq-slate__body');
    body.appendChild(e('p', 'hq-slate__file', rec.filename || 'unnamed file'));

    if (inbox) {
      body.appendChild(gameChip(rec));
      body.appendChild(actionsForInbox(rec));
    } else {
      body.appendChild(stateRail(rec));
      if (rec.reason) body.appendChild(e('p', 'hq-slate__why', rec.reason));
      body.appendChild(actionsForFolder(rec));
    }
    card.appendChild(body);
    return card;
  }

  function peekWell(rec) {
    var well = e('div', 'hq-peek');
    var peek = S.client.mediaUrl(rec.peek_url);
    var thumb = S.client.mediaUrl(rec.thumb_url);
    if (peek) {
      var v = document.createElement('video');
      v.className = 'hq-peek__video';
      // M2: src/poster are set by the shared IntersectionObserver once this
      // card is within ~200px of view, not here - see observeLazy().
      v.setAttribute('data-hq-lazy-src', peek);
      if (thumb) v.setAttribute('data-hq-lazy-poster', thumb);
      v.muted = true;
      v.loop = true;
      v.preload = 'none';
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.addEventListener('click', function () {
        if (v.paused) {
          var pr = v.play();
          if (pr && pr.catch) pr.catch(function () {});
        } else {
          v.pause();
        }
      });
      well.appendChild(v);
      well.appendChild(e('span', 'hq-peek__play', 'tap to peek'));
      observeLazy(v);
    } else if (thumb) {
      var img = document.createElement('img');
      img.className = 'hq-peek__video';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.setAttribute('data-hq-lazy-src', thumb);
      well.appendChild(img);
      observeLazy(img);
    } else {
      well.appendChild(e('div', 'hq-peek__none', 'no preview yet'));
    }
    well.appendChild(e('span', 'hq-peek__tc', API.fmtDuration(rec.duration_s)));
    return well;
  }

  function gameLabel(key) {
    for (var i = 0; i < S.games.length; i++) if (S.games[i].key === key) return S.games[i].label;
    return key ? String(key) : '';
  }

  function gameChip(rec) {
    var known = !!rec.detected_game;
    var chip = e('span', 'hq-chip' + (known ? '' : ' hq-chip--none'));
    chip.appendChild(e('span', null, known ? gameLabel(rec.detected_game) : 'no idea'));
    if (known) {
      var lit = API.confidenceDots(rec.confidence);
      var dots = e('span', 'hq-dots');
      dots.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < 3; i++) dots.appendChild(e('span', 'hq-dots__d' + (i < lit ? ' on' : '')));
      chip.appendChild(dots);
    }
    chip.appendChild(e('span', 'hq-chip__how', API.methodLabel(rec.method)));
    var row = e('div');
    row.appendChild(chip);
    return row;
  }

  function actionsForInbox(rec) {
    var row = e('div', 'hq-actions');
    var confirm = e('button', 'hq-btn hq-btn--primary', rec.detected_game ? 'Looks right' : 'No guess to confirm');
    confirm.type = 'button';
    confirm.disabled = !rec.detected_game;
    confirm.addEventListener('click', function () {
      doAssign(rec, rec.detected_game);
    });
    row.appendChild(confirm);

    var change = e('button', 'hq-btn', 'Change');
    change.type = 'button';
    change.addEventListener('click', function () {
      openGameSheet(rec);
    });
    row.appendChild(change);
    return row;
  }

  function actionsForFolder(rec) {
    var row = e('div', 'hq-actions');
    var g = null;
    for (var i = 0; i < S.games.length; i++) if (S.games[i].key === rec.game_key) g = S.games[i];

    if (API.canCancel(rec)) {
      var cancel = e('button', 'hq-btn hq-btn--danger', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        if (!rec.job_id) return;
        S.client.cancelJob(rec.job_id).then(function (r) {
          toast(r.ok ? 'Cancelling' : 'Could not cancel');
          tick();
        });
      });
      row.appendChild(cancel);
    } else {
      var start = e('button', 'hq-btn hq-btn--primary', 'Start the edit');
      start.type = 'button';
      var startable = API.canStart(rec, g);
      start.disabled = !startable;
      if (!startable && g && (!g.recipe || !g.recipe.built)) start.textContent = 'Recipe not built';
      start.addEventListener('click', function () {
        start.disabled = true;
        S.client.start(rec.id).then(function (r) {
          if (r.ok) {
            rec.state = 'queued';
            toast('Queued');
          } else {
            toast(r.status === 409 ? 'The edit slot is busy' : 'Could not start');
            start.disabled = false;
          }
          tick();
        });
      });
      row.appendChild(start);
    }

    var move = e('button', 'hq-btn', 'Move');
    move.type = 'button';
    move.addEventListener('click', function () {
      openGameSheet(rec);
    });
    row.appendChild(move);
    return row;
  }

  /** Sorted -> Queued -> Editing -> Review, with the off-rail states named. */
  function stateRail(rec) {
    var wrap = e('div');
    var at = API.railIndex(rec.state);
    var rail = e('div', 'hq-rail');
    for (var i = 0; i < API.PIPELINE.length; i++) {
      if (i) rail.appendChild(e('span', 'hq-rail__link'));
      var cls = 'hq-rail__step' + (at >= 0 && i < at ? ' done' : at === i ? ' at' : '');
      rail.appendChild(e('span', cls, API.stateLabel(API.PIPELINE[i])));
    }
    wrap.appendChild(rail);
    if (at < 0) {
      var off = e('p', 'hq-stage');
      var lamp = e('span', 'hq-lamp');
      lamp.style.display = 'inline-block';
      lamp.style.marginRight = '6px';
      off.appendChild(lamp);
      off.appendChild(document.createTextNode(API.stateLabel(rec.state)));
      wrap.appendChild(off);
    }
    return wrap;
  }

  // ---------------------------------------------------------------- games --
  function renderGames(p) {
    var head = e('div', 'hq-pad');
    head.appendChild(e('h1', 'hq-h', 'Games'));
    head.appendChild(e('p', 'hq-sub', 'One folder per game. Autopilot starts the edit by itself when a recording lands.'));
    p.appendChild(head);

    var strip = e('div', 'hq-pad');
    strip.style.paddingTop = '0';
    var tiles = e('div', 'hq-tiles');
    for (var i = 0; i < S.games.length; i++) tiles.appendChild(gameTile(S.games[i]));
    strip.appendChild(tiles);
    p.appendChild(strip);

    if (!S.openGame) {
      var hint = e('div', 'hq-pad');
      hint.style.paddingTop = '0';
      hint.appendChild(note('Pick a folder', ['Tap a game above to see what is in it and what is being edited.'], false, null));
      p.appendChild(hint);
      return;
    }

    var folder = e('div', 'hq-pad');
    folder.style.paddingTop = '0';
    folder.appendChild(e('h2', 'hq-h', gameLabel(S.openGame)));
    var inFolder = S.recs.filter(function (r) {
      return r.game_key === S.openGame;
    });
    if (!inFolder.length) {
      folder.appendChild(note('Empty folder', ['Nothing filed under this game yet.'], false, null));
    } else {
      for (var j = 0; j < inFolder.length; j++) folder.appendChild(slate(inFolder[j], false));
    }
    p.appendChild(folder);
  }

  function gameTile(g) {
    var isOpen = S.openGame === g.key;
    var tile = e('div', 'hq-tile' + (isOpen ? ' is-open' : ''));
    tile.setAttribute('role', 'group');
    var open = e('button', 'hq-tile__open');
    open.type = 'button';
    open.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    open.appendChild(e('span', 'hq-tile__name', g.label || g.key));
    open.appendChild(
      e('span', 'hq-tile__count', (g.count || 0) + ' filed' + (g.unsorted_count ? '  ·  ' + g.unsorted_count + ' unsorted' : ''))
    );
    open.addEventListener('click', function () {
      S.openGame = S.openGame === g.key ? null : g.key;
      renderPanel();
      refreshTab().then(renderPanel);
    });
    tile.appendChild(open);

    if (!g.recipe || !g.recipe.built) {
      tile.appendChild(e('span', 'hq-tile__tag', 'recipe not built'));
    }
    tile.appendChild(autopilotSwitch(g));
    return tile;
  }

  function autopilotSwitch(g) {
    var label = e('label', 'hq-switch');
    label.appendChild(e('span', null, 'Autopilot'));
    var wrap = e('span', 'hq-switch__wrap');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'hq-switch__box';
    box.checked = !!g.autopilot;
    box.disabled = !g.recipe || !g.recipe.built;
    box.setAttribute('data-hq-autopilot', g.key);
    box.addEventListener('change', function () {
      var want = box.checked;
      box.disabled = true;
      S.client.setAutopilot(g.key, want).then(function (r) {
        box.disabled = !g.recipe || !g.recipe.built;
        if (r.ok) {
          g.autopilot = want;
          toast(want ? 'Autopilot on for ' + (g.label || g.key) : 'Autopilot off for ' + (g.label || g.key));
        } else {
          box.checked = !want;
          toast('Could not change autopilot');
        }
      });
    });
    wrap.appendChild(box);
    wrap.appendChild(e('span', 'hq-switch__track'));
    label.appendChild(wrap);
    return label;
  }

  // ----------------------------------------------------------------- jobs --
  var JOB_STATE = {
    queued: 'queued',
    running: 'editing',
    done: 'review',
    stopped: 'stopped',
    error: 'error',
    cancelled: 'stopped',
  };
  function renderJobs(p) {
    var head = e('div', 'hq-pad');
    head.appendChild(e('h1', 'hq-h', 'Jobs'));
    head.appendChild(e('p', 'hq-sub', 'One edit runs at a time. Tap a job for its stage, log and delivered files.'));
    p.appendChild(head);

    var list = e('div', 'hq-pad');
    list.style.paddingTop = '0';
    if (!S.jobs.length) {
      list.appendChild(note('No jobs yet', ['Start an edit from a game folder and it shows up here.'], false, null));
      p.appendChild(list);
      return;
    }
    for (var i = 0; i < S.jobs.length; i++) list.appendChild(jobCard(S.jobs[i]));
    p.appendChild(list);
  }

  function jobCard(job) {
    var mapped = JOB_STATE[String(job.status || '').toLowerCase()] || 'error';
    var card = e('article', 'hq-slate');
    card.style.setProperty('--hq-state', API.stateColorVar(mapped));

    var slug = e('div', 'hq-slate__slug');
    slug.appendChild(e('span', null, 'job ' + job.id));
    slug.appendChild(sep());
    slug.appendChild(e('span', null, gameLabel(job.game_key) || job.recipe || 'unknown'));
    var st = e('span', 'hq-slate__state');
    st.appendChild(e('span', 'hq-lamp' + (job.status === 'running' ? ' hq-lamp--live' : '')));
    st.appendChild(e('span', null, String(job.status || '')));
    slug.appendChild(st);
    card.appendChild(slug);

    var body = e('div', 'hq-slate__body');
    body.appendChild(e('p', 'hq-slate__file', job.filename || ''));
    var bar = e('div', 'hq-bar');
    var fill = e('div', 'hq-bar__fill');
    fill.style.width = API.pct(job.pct) + '%';
    bar.appendChild(fill);
    body.appendChild(bar);
    body.appendChild(e('p', 'hq-stage', (job.stage ? job.stage + ' · ' : '') + API.pct(job.pct) + '%'));
    if (job.message) body.appendChild(e('p', 'hq-slate__why', job.message));

    var row = e('div', 'hq-actions');
    var open = e('button', 'hq-btn hq-btn--primary', 'Open');
    open.type = 'button';
    open.setAttribute('data-hq-job', String(job.id));
    open.addEventListener('click', function () {
      openJobSheet(job.id);
    });
    row.appendChild(open);
    body.appendChild(row);

    card.appendChild(body);
    return card;
  }

  // =============================================================== sheets ===
  function openSheet(title, build) {
    var sheet = $('hq-sheet');
    // L4: remember what had focus before the sheet opened, so it can be
    // restored on close. Only capture on an actual open, not a same-sheet
    // refresh (openJobSheet re-runs this while already open, and by then
    // document.activeElement is a button INSIDE the sheet about to be torn
    // down by the rebuild below - capturing that would refocus nothing).
    if (sheet.hidden) S.sheetInvoker = document.activeElement || null;
    $('hq-sheet-title').textContent = title;
    var body = $('hq-sheet-body');
    clear(body);
    build(body);
    sheet.hidden = false;
    var close = $('hq-sheet-close');
    if (close && close.focus) close.focus();
  }
  function closeSheet() {
    $('hq-sheet').hidden = true;
    S.openJob = null;
    var invoker = S.sheetInvoker;
    S.sheetInvoker = null;
    // Guard: the invoking card can have been rebuilt away (a poll landed, an
    // assign happened) while the sheet was open - focus it only if it is
    // still a real, attached, focusable element.
    if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) {
      invoker.focus();
    }
  }

  function openGameSheet(rec) {
    openSheet('Which game?', function (body) {
      body.appendChild(e('p', 'hq-sub', 'Moving it files the recording into that game’s folder on the machine.'));
      var pick = e('div', 'hq-pick');
      for (var i = 0; i < S.games.length; i++) {
        (function (g) {
          var row = e('button', 'hq-pick__row');
          row.type = 'button';
          row.setAttribute('data-hq-pick', g.key);
          row.appendChild(e('span', null, g.label || g.key));
          var meta = e('span', 'hq-pick__meta', (g.count || 0) + ' filed' + (g.recipe && g.recipe.built ? '  ·  auto-ready' : ''));
          row.appendChild(meta);
          row.addEventListener('click', function () {
            closeSheet();
            doAssign(rec, g.key);
          });
          pick.appendChild(row);
        })(S.games[i]);
      }
      body.appendChild(pick);

      var hide = e('button', 'hq-btn hq-btn--wide', 'Not footage — hide it');
      hide.type = 'button';
      hide.style.marginTop = 'var(--s4)';
      hide.addEventListener('click', function () {
        closeSheet();
        S.client.hide(rec.id).then(function (r) {
          toast(r.ok ? 'Hidden' : 'Could not hide it');
          tick();
        });
      });
      body.appendChild(hide);
    });
  }

  function openJobSheet(id) {
    S.openJob = id;
    openSheet('Job ' + id, function (body) {
      body.appendChild(e('p', 'hq-sub', 'Loading…'));
      S.client.job(id).then(function (r) {
        if (S.openJob !== id) return;
        clear(body);
        if (!r.ok) {
          body.appendChild(note('Could not read this job', [r.error || 'The Command Center did not answer.'], true, null));
          return;
        }
        var d = r.data || {};
        var job = d.job || {};
        var status = d.status || {};
        var mapped = JOB_STATE[String(job.status || '').toLowerCase()] || 'error';

        var kv = e('dl', 'hq-kv');
        addKv(kv, 'File', job.filename || '');
        addKv(kv, 'Game', gameLabel(job.game_key) || job.recipe || '');
        addKv(kv, 'Status', String(job.status || ''));
        addKv(kv, 'Stage', String(status.stage || job.stage || ''));
        if (status.step) addKv(kv, 'Step', String(status.step));
        if (status.stop_reason) addKv(kv, 'Stopped', String(status.stop_reason));
        body.appendChild(kv);

        var bar = e('div', 'hq-bar');
        bar.style.setProperty('--hq-state', API.stateColorVar(mapped));
        var fill = e('div', 'hq-bar__fill');
        fill.style.width = API.pct(status.pct !== undefined ? status.pct : job.pct) + '%';
        bar.appendChild(fill);
        body.appendChild(bar);
        if (status.message) body.appendChild(e('p', 'hq-slate__why', String(status.message)));
        if (status.stop_detail) body.appendChild(e('p', 'hq-slate__why', String(status.stop_detail)));

        var arts = d.artifacts && d.artifacts.length ? d.artifacts : status.artifacts || [];
        if (arts.length) {
          body.appendChild(e('p', 'hq-field__label hq-sec', 'Delivered'));
          var links = e('div', 'hq-links');
          for (var i = 0; i < arts.length; i++) {
            var a = arts[i] || {};
            var href = S.client.mediaUrl(a.url || '');
            if (href) {
              var link = document.createElement('a');
              link.href = href;
              link.target = '_blank';
              link.rel = 'noopener';
              link.textContent = a.label || a.path || href;
              links.appendChild(link);
            } else {
              links.appendChild(e('span', 'hq-stage', a.label || a.path || ''));
            }
          }
          body.appendChild(links);
        }

        body.appendChild(e('p', 'hq-field__label hq-sec', 'Log'));
        var log = e('pre', 'hq-log', (d.log_tail || []).join('\n') || 'nothing logged yet');
        body.appendChild(log);
        // Newest lines are at the bottom, so land the reader there.
        log.scrollTop = log.scrollHeight;

        var row = e('div', 'hq-actions');
        var refresh = e('button', 'hq-btn', 'Refresh');
        refresh.type = 'button';
        refresh.addEventListener('click', function () {
          openJobSheet(id);
        });
        row.appendChild(refresh);
        if (job.status === 'running' || job.status === 'queued') {
          var cancel = e('button', 'hq-btn hq-btn--danger', 'Cancel this job');
          cancel.type = 'button';
          cancel.addEventListener('click', function () {
            cancel.disabled = true;
            S.client.cancelJob(id).then(function (c) {
              toast(c.ok ? 'Cancelling' : 'Could not cancel');
              openJobSheet(id);
              tick();
            });
          });
          row.appendChild(cancel);
        }
        body.appendChild(row);
      });
    });
  }

  function addKv(dl, k, v) {
    dl.appendChild(e('dt', null, k));
    dl.appendChild(e('dd', null, v));
  }

  function openSettingsSheet() {
    openSheet('Setup', function (body) {
      // --- what the machine says --------------------------------------------
      var kv = e('dl', 'hq-kv');
      var s = S.status || {};
      var obs = s.obs || {};
      var slot = s.slot || {};
      addKv(kv, 'Link', CONN_WORD[S.conn.state] || S.conn.state);
      addKv(kv, 'OBS', obs.connected ? (obs.recording ? 'recording' : 'connected') : 'not connected');
      if (obs.current_profile) addKv(kv, 'Profile', String(obs.current_profile));
      addKv(kv, 'Edit slot', slot.busy ? String(slot.label || 'busy') : 'free');
      if (s.disk) addKv(kv, 'Disk free', API.fmtGb(s.disk.free_gb) + ' (min ' + API.fmtGb(s.disk.min_gb) + ')');
      if (s.queue_len !== undefined) addKv(kv, 'Queued', String(s.queue_len));
      if (s.version) addKv(kv, 'Server', String(s.version));
      body.appendChild(kv);

      // --- autopilot, every game in one place -------------------------------
      // Same builder as the game tiles, so a switch can never behave two ways.
      // The label text is replaced with the game's name (the tile already says
      // "Autopilot" in its own heading; here the game IS the row).
      body.appendChild(e('p', 'hq-field__label hq-sec', 'Autopilot'));
      for (var i = 0; i < S.games.length; i++) {
        var g = S.games[i];
        var sw = autopilotSwitch(g);
        sw.replaceChild(e('span', null, g.label || g.key), sw.firstChild);
        body.appendChild(sw);
      }

      // --- actions -----------------------------------------------------------
      body.appendChild(e('p', 'hq-field__label hq-sec', 'Machine'));
      var rescan = e('button', 'hq-btn hq-btn--wide', 'Rescan the folders');
      rescan.type = 'button';
      rescan.addEventListener('click', function () {
        rescan.disabled = true;
        doRescan().then(function () {
          rescan.disabled = false;
        });
      });
      body.appendChild(rescan);

      var open = document.createElement('a');
      open.className = 'hq-btn hq-btn--wide';
      open.style.display = 'block';
      open.style.textAlign = 'center';
      open.style.marginTop = 'var(--s2)';
      open.href = S.client.base;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open the Command Center';
      body.appendChild(open);

      // --- key + base --------------------------------------------------------
      body.appendChild(e('p', 'hq-field__label hq-sec', 'This phone'));
      var baseField = e('label', 'hq-field');
      baseField.appendChild(e('span', 'hq-field__label', 'Command Center address'));
      var baseIn = document.createElement('input');
      baseIn.className = 'hq-input';
      baseIn.id = 'hq-set-base';
      baseIn.type = 'url';
      baseIn.inputMode = 'url';
      baseIn.autocapitalize = 'off';
      baseIn.spellcheck = false;
      baseIn.value = get(BASE_KEY) || CFG.defaultBase || API.DEFAULT_BASE;
      baseField.appendChild(baseIn);
      body.appendChild(baseField);

      var saveBase = e('button', 'hq-btn hq-btn--wide', 'Save address');
      saveBase.type = 'button';
      saveBase.addEventListener('click', function () {
        set(BASE_KEY, API.normBase(baseIn.value));
        makeClient();
        closeSheet();
        toast('Address saved');
        startPolling();
      });
      body.appendChild(saveBase);

      var showKey = e('button', 'hq-btn hq-btn--wide', 'Show the key');
      showKey.type = 'button';
      showKey.style.marginTop = 'var(--s2)';
      var keyOut = e('p', 'hq-log');
      keyOut.hidden = true;
      showKey.addEventListener('click', function () {
        keyOut.hidden = !keyOut.hidden;
        keyOut.textContent = keyOut.hidden ? '' : get(TOKEN_KEY) || '(none stored)';
        showKey.textContent = keyOut.hidden ? 'Show the key' : 'Hide the key';
      });
      body.appendChild(showKey);
      body.appendChild(keyOut);

      var forget = e('button', 'hq-btn hq-btn--wide hq-btn--danger', 'Forget this key');
      forget.type = 'button';
      forget.style.marginTop = 'var(--s2)';
      forget.addEventListener('click', function () {
        del(TOKEN_KEY);
        closeSheet();
        showUnlock('Key forgotten. Scan the QR on the Command Center to link again.');
      });
      body.appendChild(forget);
    });
  }

  // ============================================================== actions ===
  function doAssign(rec, gameKey) {
    if (!gameKey) return;
    // Optimistic: the card leaves the inbox immediately, because the move on
    // the machine is a same-drive rename and effectively instant. A refusal
    // puts it back on the next poll.
    var was = rec.state;
    rec.state = 'sorted';
    rec.game_key = gameKey;
    renderPanel();
    renderBadge();
    S.client.assign(rec.id, gameKey).then(function (r) {
      if (!r.ok) {
        rec.state = was;
        toast(r.unauthorized ? 'Re-unlock needed' : 'Could not move it');
        renderPanel();
        return;
      }
      var moved = 'Moved to ' + gameLabel(gameKey);
      if (r.data && r.data.job_id) moved += ' · queued';
      toast(moved);
      tick();
    });
  }

  function doRescan() {
    return S.client.rescan().then(function (r) {
      if (r.ok) {
        var found = r.data && r.data.found;
        toast(found ? 'Found ' + found : 'Rescan done');
      } else {
        toast('Rescan failed');
      }
      tick();
    });
  }

  function toast(msg) {
    var t = $('hq-toast');
    t.textContent = msg;
    t.hidden = false;
    if (S.toastTimer) clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () {
      t.hidden = true;
    }, 2600);
  }

  // ================================================================= boot ===
  function boot() {
    consumeHash();
    makeClient();

    // console tabs
    var btns = document.querySelectorAll('[data-hq-tab]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          setTab(b.getAttribute('data-hq-tab'));
        });
      })(btns[i]);
    }

    $('hq-gear').addEventListener('click', openSettingsSheet);
    $('hq-sheet-close').addEventListener('click', closeSheet);
    $('hq-sheet-scrim').addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('hq-sheet').hidden) closeSheet();
    });

    $('hq-unlock-go').addEventListener('click', function () {
      var tok = String($('hq-token').value || '').trim();
      if (!tok) {
        var st = $('hq-unlock-status');
        st.className = 'hq-status bad';
        st.textContent = 'Paste the key from the Command Center first.';
        return;
      }
      set(TOKEN_KEY, tok);
      set(BASE_KEY, API.normBase($('hq-base').value));
      $('hq-token').value = '';
      makeClient();
      showApp();
    });

    // Pause the loop when the tab is hidden; resume immediately when it comes
    // back, so switching apps on a phone never leaves a stale room on screen.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling();
      else if (get(TOKEN_KEY)) tick();
    });

    if (get(TOKEN_KEY)) showApp();
    else showUnlock('');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
