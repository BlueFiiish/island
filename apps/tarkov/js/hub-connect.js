// Pilot Hub - "Connect my progress" for the web island.
//
// WEB ONLY. Loaded by src/pages/tarkov.astro AFTER hub.js, alongside
// hub-web-adapter.js. It turns a TarkovTracker progress payload into writes
// against the adapter's existing validate+save path (importQuestState +
// saveProfile), so a connect can never put the hub in a state a hand edit
// could not. It owns NO DOM - the page's inline wiring drives it - and it is
// pure enough to unit-test under node (module.exports).
//
// -------------------------------------------------------------------------
// SHIPPED PATH DECISION (see the connect flow's own help text):
//
//   Direct browser fetch of the TarkovTracker API from this static origin is
//   impossible: api.tarkovtracker.org (the maintained fork) hardcodes its CORS
//   allowlist to tarkovtracker.org, so a GitHub Pages origin is rejected at the
//   preflight. (The legacy .io host is dead - DNS NXDOMAIN.)
//
//   THE FIX (2026-08-30): a tiny Cloudflare Worker CORS proxy,
//   tt-proxy.bluefiiish.workers.dev (source: projects/tarkov/tt-proxy/). The
//   browser calls the Worker with the token in the Authorization header; the
//   Worker forwards it server-side to api.tarkovtracker.org (where CORS does
//   not apply) and returns the JSON with CORS headers for our origin. So the
//   Connect button is now TRUE ONE-CLICK: paste token -> it fetches.
//
//   The paste / import box is KEPT as a fallback for when the Worker is
//   unreachable (or a user prefers offline). The token is persisted for
//   refreshes either way.
// -------------------------------------------------------------------------
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotTTConnect = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // The maintained fork. The .io host the desktop mental model names is dead;
  // .org is where a token generated at tarkovtracker.org actually works. Kept
  // for reference / an explicit `base` override; the browser never calls it
  // directly (CORS) - it goes through WORKER_BASE.
  const API_BASE = 'https://api.tarkovtracker.org';

  // The CORS proxy Worker. Source: projects/tarkov/tt-proxy/. Change this one
  // constant if the Worker is ever renamed/moved. GET WORKER_BASE + '/progress'
  // with an Authorization: Bearer <token> header returns the same JSON
  // api.tarkovtracker.org/api/v2/progress would, with CORS for our origin.
  const WORKER_BASE = 'https://tt-proxy.bluefiiish.workers.dev';

  const TOKEN_KEY = 'island.tarkov.tt.token';
  const SYNC_KEY = 'island.tarkov.tt.sync.v1';

  // Same task-id rule the adapter enforces (24 hex). TarkovTracker task ids ARE
  // tarkov.dev ids, which is exactly what quests.json is keyed by, so there is
  // no id translation to do for tasks.
  const TASK_ID_RE = /^[0-9a-f]{24}$/i;

  function normFaction(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    return (s === 'usec' || s === 'bear') ? s : null;
  }
  function normLevel(v) {
    const n = Number(v);
    return (Number.isInteger(n) && n >= 1 && n <= 79) ? n : null;
  }

  // Accept: a raw /progress response ({ data: ProgressData, meta }), a bare
  // ProgressData ({ tasksProgress, playerLevel, ... }), or the same nested one
  // level deeper. Anything else -> null.
  function extractData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.tasksProgress)) return payload;
    return null;
  }

  // tasksProgress -> our questState. The v2 contract (tarkovtracker-org
  // openapi.ts, schema ProgressTask): { id, complete, failed?, invalid? }.
  //   failed === true              -> 'failed'
  //   complete === true && !invalid -> 'finished'
  //   otherwise                     -> omitted (uncompleted / invalidated)
  // No per-task timestamp is in the payload, so `at` is the import time, exactly
  // like a hand-marked task.
  function mapProgress(payload) {
    const data = extractData(payload);
    const res = {
      questState: {},
      playerLevel: null,
      faction: null,
      displayName: null,
      counts: { tasks: 0, finished: 0, failed: 0, skipped: 0 },
    };
    if (!data) return res;
    const tp = Array.isArray(data.tasksProgress) ? data.tasksProgress : [];
    const now = Date.now();
    for (let i = 0; i < tp.length; i++) {
      const t = tp[i];
      if (!t || typeof t !== 'object') continue;
      const id = String(t.id == null ? '' : t.id);
      if (!TASK_ID_RE.test(id)) { res.counts.skipped++; continue; }
      if (t.failed === true) {
        res.questState[id] = { status: 'failed', at: now };
        res.counts.tasks++; res.counts.failed++;
      } else if (t.complete === true && t.invalid !== true) {
        res.questState[id] = { status: 'finished', at: now };
        res.counts.tasks++; res.counts.finished++;
      }
      // else: not complete, or invalidated by an alt branch -> leave unmarked
    }
    res.playerLevel = normLevel(data.playerLevel);
    res.faction = normFaction(data.pmcFaction);
    if (typeof data.displayName === 'string') res.displayName = data.displayName;
    return res;
  }

  // id -> id and normalizedName/name -> id, built from OUR traders.json. Used
  // only for the rare payload that DOES carry trader standings (v2 /progress
  // does not; this future-proofs alt exports / tools). Our trader ids already
  // ARE tarkov.dev ids, so an id keyed map is a straight pass-through.
  function buildTraderIndex(traders) {
    const byId = {}; const byName = {};
    const list = Array.isArray(traders) ? traders : [];
    for (let i = 0; i < list.length; i++) {
      const tr = list[i];
      if (!tr || !tr.id) continue;
      byId[String(tr.id)] = String(tr.id);
      if (tr.normalizedName) byName[String(tr.normalizedName).toLowerCase()] = String(tr.id);
      if (tr.name) byName[String(tr.name).toLowerCase()] = String(tr.id);
    }
    return { byId, byName };
  }

  function mapExplicitTraders(data, traders) {
    const raw = (data && (data.traderLevels || data.traderStandings || data.traders)) || null;
    if (!raw) return null;
    const idx = buildTraderIndex(traders);
    const out = {};
    const put = (key, lvl) => {
      const n = Number(lvl);
      if (!Number.isInteger(n) || n < 1 || n > 4) return;
      const id = idx.byId[String(key)] || idx.byName[String(key).toLowerCase()];
      if (id) out[id] = n;
    };
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i++) {
        const e = raw[i];
        if (e && typeof e === 'object') put(e.id || e.trader || e.name, e.level || e.loyaltyLevel || e.standing);
      }
    } else if (typeof raw === 'object') {
      Object.keys(raw).forEach((k) => {
        const v = raw[k];
        put(k, (v && typeof v === 'object') ? (v.level || v.loyaltyLevel) : v);
      });
    }
    return out;
  }

  // Fetch progress THROUGH the CORS proxy Worker. One-click: token in the
  // Authorization header, the Worker forwards it to TarkovTracker server-side.
  // Classifies the failure so the UI can say the right thing:
  //   kind:'auth'    -> token rejected (401/403) - the user must fix the token
  //   kind:'http'    -> upstream 429/5xx etc - show the Worker's clean message
  //   kind:'cors'    -> the Worker itself was unreachable - fall back to paste
  // `base` overrides the Worker (defaults to WORKER_BASE); pass API_BASE only if
  // TarkovTracker ever allowlists us and the direct path becomes possible.
  function fetchProgress(token, base) {
    const b = String(base || WORKER_BASE).replace(/\/+$/, '');
    // If someone passes the raw API base, keep the old /api/v2 path; the Worker
    // uses the short /progress route.
    const path = (b === API_BASE.replace(/\/+$/, '')) ? '/api/v2/progress' : '/progress';
    return fetch(b + path, { headers: { Authorization: 'Bearer ' + String(token || '') }, credentials: 'omit' })
      .catch((e) => {
        // A rejected fetch here means the Worker (not TarkovTracker) is
        // unreachable - offline, DNS, or Worker down. Degrade to paste.
        const err = new Error('Could not reach the connect service.');
        err.kind = 'cors';
        err.detail = (e && e.message) ? e.message : String(e);
        throw err;
      })
      .then((res) => {
        if (res.status === 401 || res.status === 403) {
          return res.json().catch(() => null).then((body) => {
            const msg = (body && body.message) ? body.message
              : 'That token was rejected (401/403). Check you pasted it whole.';
            const err = new Error(msg);
            err.kind = 'auth'; err.status = res.status; throw err;
          });
        }
        if (!res.ok) {
          return res.json().catch(() => null).then((body) => {
            const msg = (body && body.message) ? body.message
              : 'TarkovTracker answered ' + res.status + '.';
            const err = new Error(msg);
            err.kind = 'http'; err.status = res.status; throw err;
          });
        }
        return res.json();
      });
  }

  // The one write path. Maps, then persists through the SAME validate+echo the
  // adapter exposes, so quests/traders/kit re-render live off the pushes.
  function apply(payload, ctx) {
    const c = ctx || {};
    const hubApi = c.api;
    const host = c.host;
    if (!hubApi || !host) throw new Error('hub not ready');
    const data = extractData(payload);
    if (!data) throw new Error('That is not a TarkovTracker progress payload.');

    const mapped = mapProgress(payload);

    // 1) quests, wholesale. On a fresh connect TarkovTracker IS the source of
    //    truth, matching the existing Pilot import (also wholesale).
    host.importQuestState(mapped.questState);

    // 2) level + faction through the validating save path.
    const patch = {};
    if (mapped.playerLevel != null) patch.playerLevel = mapped.playerLevel;
    if (mapped.faction != null) patch.faction = mapped.faction;
    if (Object.keys(patch).length) hubApi.saveProfile(patch);

    // 3) trader loyalty. Prefer explicit standings if the payload carries any;
    //    otherwise derive from the just-imported quests via the same estimator
    //    the "Guess" button uses. v2 /progress has no standings, so estimate is
    //    the normal path.
    let traderLevels = null; let traderSource = 'none'; let uncertain = 0;
    const explicit = mapExplicitTraders(data, c.traders);
    if (explicit && Object.keys(explicit).length) {
      traderLevels = explicit; traderSource = 'payload';
    } else if (root.PilotKit && typeof root.PilotKit.estimateTraderLevels === 'function' && c.quests && c.traders) {
      const stored = host.getStored();
      const est = root.PilotKit.estimateTraderLevels({
        quests: c.quests,
        questState: stored.questState,
        traders: c.traders,
        playerLevel: stored.playerLevel,
      });
      traderLevels = {};
      Object.keys(est).forEach((id) => {
        traderLevels[id] = est[id].level;
        if (est[id].uncertain) uncertain++;
      });
      traderSource = 'estimate';
    }
    if (traderLevels && Object.keys(traderLevels).length) hubApi.saveProfile({ traderLevels });

    const summary = {
      tasks: mapped.counts.tasks,
      finished: mapped.counts.finished,
      failed: mapped.counts.failed,
      skipped: mapped.counts.skipped,
      playerLevel: mapped.playerLevel,
      faction: mapped.faction,
      displayName: mapped.displayName,
      traders: traderLevels ? Object.keys(traderLevels).length : 0,
      traderSource: traderSource,
      uncertain: uncertain,
      at: Date.now(),
    };
    saveSync(summary);
    return summary;
  }

  // ---- best-effort persistence (localStorage throws in some browser modes) --
  function getToken() { try { return (typeof localStorage !== 'undefined' && localStorage.getItem(TOKEN_KEY)) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (typeof localStorage === 'undefined') return; if (t) localStorage.setItem(TOKEN_KEY, String(t)); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function saveSync(s) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch (e) {} }
  function getSync() { try { const r = (typeof localStorage !== 'undefined') ? localStorage.getItem(SYNC_KEY) : null; return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function clearSync() { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(SYNC_KEY); } catch (e) {} }

  return {
    API_BASE, WORKER_BASE, TOKEN_KEY, SYNC_KEY,
    extractData, mapProgress, buildTraderIndex, mapExplicitTraders,
    fetchProgress, apply,
    getToken, setToken, getSync, saveSync, clearSync,
  };
}));
