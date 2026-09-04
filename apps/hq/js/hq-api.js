// Fiiiish HQ - the PURE half. Base URL + token in, JSON out.
//
// Nothing in this file touches the DOM, localStorage or the URL. It is handed a
// { base, token } and returns a client; every formatter and reducer below is a
// plain function of its arguments. That is what makes the whole route testable
// and mockable: hq.js owns storage and rendering, this file owns the wire.
//
// MOCK MODE. hq.js passes { mock: true } when the device has opted in (see
// island.hq.mock in hq.js). The client then serves a small, MUTABLE fixture set
// instead of fetching - assign really does move a recording between states, the
// autopilot toggle really does stick, and a job really does have a log tail -
// so the UI can be driven end to end in a browser with no server running.
// Turn it on from the console:  localStorage.setItem('island.hq.mock','1')
//
// TRANSPORT NOTES
//   - every call sends `Authorization: Bearer <token>` and expects JSON.
//   - 401 means the token is dead. It is NOT the same as unreachable: the
//     caller shows "re-unlock", not "offline".
//   - a rejected fetch (PC asleep, off the tailnet, DNS) is `offline: true`.
//     There is no way to tell those apart from a browser, and the copy says so.
//   - nothing here ever throws. Every call resolves to the same envelope:
//       { ok, status, data, error, offline, unauthorized }
(function (root) {
  'use strict';

  // The Command Center answers on the tailnet host over https. Overridable at
  // runtime (the deep link's &b=, or the base field in the settings sheet) so a
  // rename or a port change is a paste, not a redeploy.
  var DEFAULT_BASE = 'https://bigbertha.taild5eb1b.ts.net:8443';

  // Reconnect backoff, copied in shape from the Pilot live link: capped low,
  // because the machine on the other end is one Josia is actively using and a
  // 60s hole reads as broken.
  var BACKOFF_MS = [3000, 5000, 10000, 20000, 30000];
  function backoffMs(attempt) {
    var i = Math.max(0, Math.min(BACKOFF_MS.length - 1, Number(attempt) || 0));
    return BACKOFF_MS[i];
  }

  // ==========================================================================
  // Formatters + reducers. Pure.
  // ==========================================================================

  /** Trim a base URL to no trailing slash. '' when there is nothing usable. */
  function normBase(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    s = s.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }

  /** Seconds -> H:MM:SS (or M:SS under an hour). Tape timecode, not prose. */
  function fmtDuration(sec) {
    var n = Number(sec);
    if (!isFinite(n) || n < 0) return '--:--';
    n = Math.round(n);
    var h = Math.floor(n / 3600);
    var m = Math.floor((n % 3600) / 60);
    var s = n % 60;
    var mm = h ? (m < 10 ? '0' + m : String(m)) : String(m);
    var ss = s < 10 ? '0' + s : String(s);
    return (h ? h + ':' : '') + mm + ':' + ss;
  }

  /** Bytes -> the biggest unit that keeps one decimal honest. */
  function fmtSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '--';
    if (n < 1024) return n + ' B';
    var units = ['kB', 'MB', 'GB', 'TB'];
    var i = -1;
    do {
      n = n / 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    return (n >= 10 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }

  /**
   * When a recording happened, as `YYYY-MM-DD HH:MM`.
   *
   * Prefers recorded_at, but falls back to the OBS filename stamp
   * (2026-08-31_21-14-07) because the legacy folder's files predate the
   * sidecar and their mtime is a copy date, not a capture date.
   */
  function fmtWhen(iso, filename) {
    var d = iso ? new Date(iso) : null;
    if (d && !isNaN(d.getTime())) {
      return (
        d.getFullYear() +
        '-' +
        two(d.getMonth() + 1) +
        '-' +
        two(d.getDate()) +
        ' ' +
        two(d.getHours()) +
        ':' +
        two(d.getMinutes())
      );
    }
    var m = /(\d{4})-(\d{2})-(\d{2})[_ -](\d{2})-(\d{2})/.exec(String(filename || ''));
    if (m) return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
    return 'date unknown';
  }
  function two(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** Free-disk / duration style rounding for the status strip. */
  function fmtGb(gb) {
    var n = Number(gb);
    if (!isFinite(n)) return '--';
    return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' GB';
  }

  /**
   * Confidence -> lit lamps out of three. Deliberately coarse: the classifier
   * reports a share-of-polls, and rendering that as "0.83" would claim a
   * precision it does not have.
   */
  function confidenceDots(c) {
    var n = Number(c);
    if (!isFinite(n) || n <= 0) return 0;
    if (n >= 0.8) return 3;
    if (n >= 0.5) return 2;
    return 1;
  }

  /** How the verdict was reached, in words a person reads. */
  var METHOD_LABEL = {
    process: 'saw the game running',
    sidecar: 'saw the game running',
    log: 'matched the game log',
    eftlog: 'matched the game log',
    filename: 'guessed from the filename',
    manual: 'you set this',
    none: 'no evidence',
  };
  function methodLabel(method) {
    var k = String(method || '').toLowerCase();
    return METHOD_LABEL[k] || (k ? k : 'no evidence');
  }

  // The recording lifecycle, in order. `unsorted` is off the rail on purpose -
  // it is the state BEFORE the pipeline, not a step inside it.
  var PIPELINE = ['sorted', 'queued', 'editing', 'review'];
  var STATE_LABEL = {
    unsorted: 'Needs you',
    sorted: 'Sorted',
    queued: 'Queued',
    editing: 'Editing',
    review: 'Review',
    banked: 'Banked',
    stopped: 'Stopped',
    error: 'Error',
  };
  function stateLabel(s) {
    return STATE_LABEL[String(s || '').toLowerCase()] || 'Unknown';
  }
  /** The CSS custom-property value that colours a state's lamp and spine. */
  function stateColorVar(s) {
    var k = String(s || '').toLowerCase();
    return STATE_LABEL[k] ? 'var(--hq-s-' + k + ')' : 'var(--hq-line)';
  }
  /** Where a state sits on the rail: -1 = off the rail (banked/stopped/error). */
  function railIndex(s) {
    return PIPELINE.indexOf(String(s || '').toLowerCase());
  }

  /** Can Josia press Start on this recording right now? */
  function canStart(rec, game) {
    if (!rec) return false;
    var s = String(rec.state || '').toLowerCase();
    if (s !== 'sorted' && s !== 'banked' && s !== 'stopped' && s !== 'error') return false;
    if (!game || !game.recipe || !game.recipe.built) return false;
    return true;
  }
  /** Can it be cancelled? */
  function canCancel(rec) {
    var s = rec ? String(rec.state || '').toLowerCase() : '';
    return s === 'queued' || s === 'editing';
  }

  /** Percent clamped to 0-100 for a progress bar width. */
  function pct(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    if (n <= 1 && n > 0) n = n * 100; // tolerate a 0-1 fraction
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /**
   * Fold one poll result into the connection state machine. Same vocabulary as
   * the Pilot live link: off / connecting / connected / reconnecting / error.
   * Returns a NEW state object; nothing is mutated.
   */
  function reduceConn(prev, res) {
    var p = prev || { state: 'off', attempt: 0, error: null };
    if (!res) return p;
    if (res.ok) return { state: 'connected', attempt: 0, error: null };
    if (res.unauthorized) return { state: 'error', attempt: 0, error: 'unauthorized' };
    if (res.offline) {
      return {
        state: p.state === 'connected' ? 'reconnecting' : 'reconnecting',
        attempt: (p.attempt || 0) + 1,
        error: 'offline',
      };
    }
    return { state: 'error', attempt: (p.attempt || 0) + 1, error: res.error || 'server error' };
  }

  // ==========================================================================
  // The live client
  // ==========================================================================

  function envelope(ok, status, data, error, flags) {
    return {
      ok: !!ok,
      status: status || 0,
      data: data || null,
      error: error || null,
      offline: !!(flags && flags.offline),
      unauthorized: !!(flags && flags.unauthorized),
    };
  }

  function create(cfg) {
    var conf = cfg || {};
    var base = normBase(conf.base) || DEFAULT_BASE;
    var token = String(conf.token == null ? '' : conf.token).trim();
    if (conf.mock) return mockClient(base, token);

    function call(method, path, body) {
      var init = {
        method: method,
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        // No cookies cross-origin; the bearer token is the whole auth story.
        credentials: 'omit',
        cache: 'no-store',
      };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return fetch(base + path, init).then(
        function (res) {
          if (res.status === 401 || res.status === 403) {
            return envelope(false, res.status, null, 'token rejected', { unauthorized: true });
          }
          return res
            .json()
            .catch(function () {
              return null;
            })
            .then(function (doc) {
              if (!res.ok) {
                return envelope(false, res.status, doc, (doc && doc.error) || 'server said ' + res.status, {});
              }
              return envelope(true, res.status, doc, null, {});
            });
        },
        function (e) {
          // A rejected fetch is indistinguishable from "the PC is asleep" here.
          return envelope(false, 0, null, (e && e.message) || 'unreachable', { offline: true });
        }
      );
    }

    return client(base, call, false);
  }

  /** The verb surface, shared by the live and mock clients. */
  function client(base, call, isMock) {
    return {
      base: base,
      isMock: !!isMock,
      /**
       * Absolute URL for a media path (thumb / peek / artifact), or null.
       *
       * L3: this is the one gate before a server-supplied string reaches an
       * <img>/<video> src or an <a href> with no further check - OBS writes
       * the filename, the classifier writes the reason text, so treat every
       * path as untrusted. Only an absolute http(s) URL or a path this app
       * itself prefixes with `base` is allowed; a `data:` or `blob:` URI (an
       * inline SVG can carry a <script>) is refused, not passed through.
       * Anything refused is null, and the caller renders it as inert text.
       */
      mediaUrl: function (p) {
        if (!p) return null;
        var s = String(p);
        if (/^https?:\/\//i.test(s)) return s;
        if (s.charAt(0) === '/') return base + s;
        return null;
      },
      status: function () {
        return call('GET', '/api/hq/status');
      },
      games: function () {
        return call('GET', '/api/hq/games');
      },
      setAutopilot: function (key, on) {
        return call('PATCH', '/api/hq/games/' + encodeURIComponent(key), { autopilot: !!on });
      },
      recordings: function (q) {
        var o = q || {};
        var parts = [];
        if (o.state) parts.push('state=' + encodeURIComponent(o.state));
        if (o.game) parts.push('game=' + encodeURIComponent(o.game));
        if (o.limit) parts.push('limit=' + encodeURIComponent(o.limit));
        return call('GET', '/api/hq/recordings' + (parts.length ? '?' + parts.join('&') : ''));
      },
      recording: function (id) {
        return call('GET', '/api/hq/recordings/' + encodeURIComponent(id));
      },
      assign: function (id, gameKey) {
        return call('POST', '/api/hq/recordings/' + encodeURIComponent(id) + '/assign', { game_key: gameKey });
      },
      start: function (id) {
        return call('POST', '/api/hq/recordings/' + encodeURIComponent(id) + '/start', {});
      },
      hide: function (id) {
        return call('POST', '/api/hq/recordings/' + encodeURIComponent(id) + '/hide', {});
      },
      jobs: function (limit) {
        return call('GET', '/api/hq/jobs' + (limit ? '?limit=' + encodeURIComponent(limit) : ''));
      },
      job: function (id) {
        return call('GET', '/api/hq/jobs/' + encodeURIComponent(id));
      },
      cancelJob: function (id) {
        return call('POST', '/api/hq/jobs/' + encodeURIComponent(id) + '/cancel', {});
      },
      rescan: function () {
        return call('POST', '/api/hq/rescan', {});
      },
    };
  }

  // ==========================================================================
  // Mock. A small world that behaves like the real one.
  // ==========================================================================

  function mockClient(base, token) {
    var now = Date.now();
    var iso = function (minsAgo) {
      return new Date(now - minsAgo * 60000).toISOString();
    };

    var games = [
      { key: 'tarkov', label: 'Tarkov', folder: 'Tarkov', count: 3, unsorted_count: 0, autopilot: false, recipe: { built: true, label: 'Session story + shorts', stages: ['manifest', 'cut', 'render', 'shorts'] } },
      { key: 'rust', label: 'Rust', folder: 'Rust', count: 12, unsorted_count: 2, autopilot: false, recipe: null },
      { key: 'smite2', label: 'SMITE 2', folder: 'SMITE 2', count: 0, unsorted_count: 0, autopilot: false, recipe: { built: false, label: 'not built yet', stages: [] } },
      { key: 'dbd', label: 'Dead by Daylight', folder: 'DBD', count: 1, unsorted_count: 0, autopilot: false, recipe: null },
      { key: 'isaac', label: 'Isaac', folder: 'Isaac', count: 0, unsorted_count: 0, autopilot: false, recipe: null },
      { key: 'other', label: 'Other', folder: 'Other', count: 4, unsorted_count: 2, autopilot: false, recipe: null },
    ];

    var recs = [
      {
        id: 101, clip_id: 9101, filename: '2026-08-31_21-14-07.mp4', path: 'Inbox', game_key: null,
        state: 'unsorted', detected_game: 'tarkov', confidence: 0.92, method: 'process',
        duration_s: 4327, size_bytes: 6.1 * 1024 * 1024 * 1024, recorded_at: iso(140),
        width: 3840, height: 2160, thumb_url: null, peek_url: null, job_id: null, reason: null, legacy: false,
      },
      {
        id: 102, clip_id: 9102, filename: '2026-08-31_18-02-55.mp4', path: 'Inbox', game_key: null,
        state: 'unsorted', detected_game: 'rust', confidence: 0.44, method: 'filename',
        duration_s: 1811, size_bytes: 2.4 * 1024 * 1024 * 1024, recorded_at: iso(330),
        width: 3840, height: 2160, thumb_url: null, peek_url: null, job_id: null, reason: null, legacy: true,
      },
      {
        id: 103, clip_id: 9103, filename: '2026-08-30_23-41-12_rust.mp4', path: 'Rust', game_key: null,
        state: 'unsorted', detected_game: null, confidence: null, method: 'none',
        duration_s: 902, size_bytes: 1.1 * 1024 * 1024 * 1024, recorded_at: iso(1500),
        width: 2560, height: 1440, thumb_url: null, peek_url: null, job_id: null, reason: null, legacy: true,
      },
      {
        id: 104, clip_id: 9104, filename: '2026-08-30_20-05-30.mp4', path: 'Tarkov', game_key: 'tarkov',
        state: 'sorted', detected_game: 'tarkov', confidence: 0.97, method: 'log',
        duration_s: 5210, size_bytes: 7.8 * 1024 * 1024 * 1024, recorded_at: iso(1700),
        width: 3840, height: 2160, thumb_url: null, peek_url: null, job_id: null, reason: null, legacy: false,
      },
      {
        id: 105, clip_id: 9105, filename: '2026-08-29_19-22-04.mp4', path: 'Tarkov', game_key: 'tarkov',
        state: 'editing', detected_game: 'tarkov', confidence: 0.99, method: 'log',
        duration_s: 6640, size_bytes: 9.4 * 1024 * 1024 * 1024, recorded_at: iso(3100),
        width: 3840, height: 2160, thumb_url: null, peek_url: null, job_id: 7, reason: null, legacy: false,
      },
      {
        id: 106, clip_id: 9106, filename: '2026-08-28_17-48-19.mp4', path: 'Tarkov', game_key: 'tarkov',
        state: 'banked', detected_game: 'tarkov', confidence: 0.88, method: 'log',
        duration_s: 720, size_bytes: 0.9 * 1024 * 1024 * 1024, recorded_at: iso(4600),
        width: 3840, height: 2160, thumb_url: null, peek_url: null, job_id: 6,
        reason: 'Under the 15 minute floor - waiting for another Tarkov day to combine with.', legacy: false,
      },
    ];

    var jobs = [
      {
        id: 7, recording_id: 105, filename: '2026-08-29_19-22-04.mp4', game_key: 'tarkov', recipe: 'tarkov',
        status: 'running', stage: 'cut', pct: 46, message: 'Pacing gate: pass 2 of 5, median shot 3.9s',
        stop_reason: null, created_at: iso(52), started_at: iso(50), finished_at: null,
      },
      {
        id: 6, recording_id: 106, filename: '2026-08-28_17-48-19.mp4', game_key: 'tarkov', recipe: 'tarkov',
        status: 'stopped', stage: 'cut', pct: 61, message: 'Projected runtime 12:04, under the floor',
        stop_reason: 'banked', created_at: iso(1400), started_at: iso(1399), finished_at: iso(1330),
      },
      {
        id: 5, recording_id: 104, filename: '2026-08-27_20-11-02.mp4', game_key: 'tarkov', recipe: 'tarkov',
        status: 'done', stage: 'shorts', pct: 100, message: 'Master + 3 shorts delivered',
        stop_reason: null, created_at: iso(3000), started_at: iso(2999), finished_at: iso(2700),
      },
    ];

    var jobDetail = {
      7: {
        status: { stage: 'cut', step: 'pacing gate', pct: 46, message: 'Pacing gate: pass 2 of 5, median shot 3.9s', artifacts: [], stop_reason: null, stop_detail: null, updated_at: iso(1) },
        log_tail: [
          '[21:04:11] stage cut: reading beats.json (412 beats)',
          '[21:05:02] filler audit: 38 candidate cuts',
          '[21:06:44] pacing gate pass 1: median 5.2s - FAIL (ceiling 4.5s)',
          '[21:08:19] re-cut: tightened 22 shots',
          '[21:09:57] pacing gate pass 2: median 3.9s - checking density',
        ],
        artifacts: [],
      },
      6: {
        status: { stage: 'cut', step: 'runtime check', pct: 61, message: 'Projected runtime 12:04, under the floor', artifacts: [], stop_reason: 'banked', stop_detail: 'One other unedited Tarkov recording exists - combine 2026-08-28 with it.', updated_at: iso(1330) },
        log_tail: ['[18:12:03] stage cut: EDL built, 44 shots', '[18:14:40] projected runtime 12:04', '[18:14:41] STOP banked: under the 15:00 floor'],
        artifacts: [],
      },
      5: {
        status: { stage: 'shorts', step: 'delivered', pct: 100, message: 'Master + 3 shorts delivered', artifacts: [], stop_reason: null, stop_detail: null, updated_at: iso(2700) },
        log_tail: ['[20:40:00] render: 4K60 complete', '[20:52:11] verify harness: pass', '[21:01:30] shorts: 3 cuts written', '[21:02:00] POST-KIT written'],
        artifacts: [
          { label: 'Master (720p review copy)', path: 'review/2026-08-27.mp4', url: '/api/hq/artifact/5/master' },
          { label: 'POST-KIT', path: 'review/2026-08-27-postkit.txt', url: '/api/hq/artifact/5/postkit' },
        ],
      },
    };

    var mockStatus = {
      ok: true,
      server_time: new Date(now).toISOString(),
      obs: { connected: true, recording: false, current_profile: 'Rust' },
      inbox_count: 3,
      unsorted_count: 3,
      slot: { busy: true, label: 'tarkov recipe job 7', since: iso(50) },
      disk: { free_gb: 812.4, min_gb: 150 },
      queue_len: 1,
      version: '0.1.0-mock',
    };

    function ok(data) {
      return Promise.resolve(envelope(true, 200, data, null, {}));
    }
    function findRec(id) {
      for (var i = 0; i < recs.length; i++) if (String(recs[i].id) === String(id)) return recs[i];
      return null;
    }
    function recount() {
      var unsorted = 0;
      for (var i = 0; i < recs.length; i++) if (recs[i].state === 'unsorted') unsorted++;
      mockStatus.unsorted_count = unsorted;
      mockStatus.inbox_count = unsorted;
      for (var g = 0; g < games.length; g++) {
        var n = 0;
        for (var j = 0; j < recs.length; j++) if (recs[j].game_key === games[g].key) n++;
        games[g].count = n;
      }
    }
    recount();

    var call = function (method, path, body) {
      // Route by the same paths the live client uses, so the mock cannot drift
      // from the contract without this switch failing loudly.
      if (path === '/api/hq/status') return ok(JSON.parse(JSON.stringify(mockStatus)));
      if (path === '/api/hq/games') return ok({ games: JSON.parse(JSON.stringify(games)) });
      if (path.indexOf('/api/hq/recordings') === 0) {
        var mAssign = /^\/api\/hq\/recordings\/(\d+)\/assign$/.exec(path);
        if (mAssign) {
          var rec = findRec(mAssign[1]);
          if (!rec) return Promise.resolve(envelope(false, 404, null, 'no such recording', {}));
          rec.game_key = body && body.game_key;
          rec.state = 'sorted';
          rec.method = 'manual';
          rec.confidence = 1;
          rec.detected_game = rec.game_key;
          recount();
          return ok({ ok: true, recording: JSON.parse(JSON.stringify(rec)), job_id: rec.game_key === 'tarkov' ? null : null });
        }
        var mStart = /^\/api\/hq\/recordings\/(\d+)\/start$/.exec(path);
        if (mStart) {
          var r2 = findRec(mStart[1]);
          if (!r2) return Promise.resolve(envelope(false, 404, null, 'no such recording', {}));
          r2.state = 'queued';
          r2.job_id = 8;
          jobs.unshift({
            id: 8, recording_id: r2.id, filename: r2.filename, game_key: r2.game_key, recipe: r2.game_key,
            status: 'queued', stage: 'manifest', pct: 0, message: 'Waiting for the edit slot',
            stop_reason: null, created_at: new Date().toISOString(), started_at: null, finished_at: null,
          });
          jobDetail[8] = { status: { stage: 'manifest', step: 'queued', pct: 0, message: 'Waiting for the edit slot', artifacts: [], stop_reason: null, stop_detail: null, updated_at: new Date().toISOString() }, log_tail: ['[queued] position 1'], artifacts: [] };
          return ok({ ok: true, job_id: 8, position: 1 });
        }
        var mHide = /^\/api\/hq\/recordings\/(\d+)\/hide$/.exec(path);
        if (mHide) {
          for (var k = 0; k < recs.length; k++) {
            if (String(recs[k].id) === mHide[1]) {
              recs.splice(k, 1);
              break;
            }
          }
          recount();
          return ok({ ok: true });
        }
        var mOne = /^\/api\/hq\/recordings\/(\d+)$/.exec(path);
        if (mOne) {
          var r3 = findRec(mOne[1]);
          return r3 ? ok({ recording: r3, job: r3.job_id ? jobDetail[r3.job_id] || null : null }) : Promise.resolve(envelope(false, 404, null, 'no such recording', {}));
        }
        var qs = path.split('?')[1] || '';
        var wantState = /(?:^|&)state=([^&]*)/.exec(qs);
        var wantGame = /(?:^|&)game=([^&]*)/.exec(qs);
        var out = recs.filter(function (r) {
          if (wantState && decodeURIComponent(wantState[1]) !== r.state) return false;
          if (wantGame && decodeURIComponent(wantGame[1]) !== r.game_key) return false;
          return true;
        });
        return ok({ recordings: JSON.parse(JSON.stringify(out)) });
      }
      if (path.indexOf('/api/hq/games/') === 0) {
        var key = decodeURIComponent(path.slice('/api/hq/games/'.length));
        for (var gi = 0; gi < games.length; gi++) {
          if (games[gi].key === key) {
            games[gi].autopilot = !!(body && body.autopilot);
            return ok({ ok: true, game: JSON.parse(JSON.stringify(games[gi])) });
          }
        }
        return Promise.resolve(envelope(false, 404, null, 'no such game', {}));
      }
      if (path.indexOf('/api/hq/jobs') === 0) {
        var mCancel = /^\/api\/hq\/jobs\/(\d+)\/cancel$/.exec(path);
        if (mCancel) {
          for (var ji = 0; ji < jobs.length; ji++) {
            if (String(jobs[ji].id) === mCancel[1]) {
              jobs[ji].status = 'cancelled';
              jobs[ji].message = 'Cancelled from the phone';
            }
          }
          return ok({ ok: true });
        }
        var mJob = /^\/api\/hq\/jobs\/(\d+)$/.exec(path);
        if (mJob) {
          var jd = jobDetail[mJob[1]];
          var jrow = null;
          for (var jj = 0; jj < jobs.length; jj++) if (String(jobs[jj].id) === mJob[1]) jrow = jobs[jj];
          if (!jd || !jrow) return Promise.resolve(envelope(false, 404, null, 'no such job', {}));
          return ok({ job: JSON.parse(JSON.stringify(jrow)), status: jd.status, log_tail: jd.log_tail.slice(), artifacts: jd.artifacts.slice() });
        }
        return ok({ jobs: JSON.parse(JSON.stringify(jobs)) });
      }
      return Promise.resolve(envelope(false, 404, null, 'mock has no route for ' + path, {}));
    };

    // Two fixtures carry an inline poster and one carries none, so a mock run
    // exercises BOTH branches of the peek well - the poster and the hatched
    // "no preview yet" placeholder - without a media server.
    recs[0].thumb_url = poster('#1d2430', '#e0b45a', 'TARKOV');
    recs[3].thumb_url = poster('#221a14', '#8fb8d8', 'TARKOV');
    recs[1].thumb_url = poster('#241612', '#ce422b', 'RUST');

    var c = client(base, call, true);
    // mediaUrl's L3 allowlist (http(s) + server-relative paths) is right for
    // anything that came off the wire, but the poster() fixtures above are
    // inline SVG this file generates itself, not server input - so the mock
    // client accepts its own `data:image/*` the same way it accepts its own
    // fixture data, and defers to the strict rule for everything else.
    var strictMediaUrl = c.mediaUrl;
    c.mediaUrl = function (p) {
      var s = p ? String(p) : '';
      if (/^data:image\//i.test(s)) return s;
      return strictMediaUrl(p);
    };
    return c;
  }

  /** A tiny inline poster frame, so mock mode has something to show in the well. */
  function poster(bg, ink, label) {
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'>" +
      "<rect width='320' height='180' fill='" + bg + "'/>" +
      "<rect x='0' y='0' width='320' height='180' fill='none' stroke='" + ink + "' stroke-opacity='.35'/>" +
      "<text x='160' y='96' text-anchor='middle' font-family='monospace' font-size='20' letter-spacing='6' fill='" +
      ink + "' fill-opacity='.8'>" + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var API = {
    DEFAULT_BASE: DEFAULT_BASE,
    BACKOFF_MS: BACKOFF_MS,
    PIPELINE: PIPELINE,
    backoffMs: backoffMs,
    normBase: normBase,
    fmtDuration: fmtDuration,
    fmtSize: fmtSize,
    fmtWhen: fmtWhen,
    fmtGb: fmtGb,
    confidenceDots: confidenceDots,
    methodLabel: methodLabel,
    stateLabel: stateLabel,
    stateColorVar: stateColorVar,
    railIndex: railIndex,
    canStart: canStart,
    canCancel: canCancel,
    pct: pct,
    reduceConn: reduceConn,
    create: create,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.HQ_API = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
