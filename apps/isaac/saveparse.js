window.ISAAC_BASE = "/island/apps/isaac/";
"use strict";
/* Browser-side Binding of Isaac: Repentance+ save parser.
   JS port of tools/parse_save.py — parses a persistentgamedata .dat ArrayBuffer and
   derives owned items / unlocked characters / completion marks / defeated bosses using
   ach_index.json + boss_index.json. Runs entirely client-side (save never leaves the browser). */
const SaveParse = (function () {
  const MAGIC = "ISAACNGSAVE09R  ";               // 16 bytes
  const RUN_HEADERS = ["ISAACNG_GSR0018", "ISAACNG_GSR0034", "ISAACNG_GSR0065", "ISAACNG_GSR0142"];
  const CHUNK = {1:"achievements",2:"counters",3:"level_counters",4:"collectibles",5:"minibosses",
                 6:"bosses",7:"challenge_counters",8:"cutscene_counters",9:"game_settings",
                 10:"special_seed_counters",11:"bestiary_counters"};

  function headerString(dv, n) { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(i)); return s; }

  function parse(buf) {
    const dv = new DataView(buf);
    const head = headerString(dv, 16);
    if (RUN_HEADERS.includes(head.trim())) throw new Error("That's a run/gamestate file. Pick the persistent file: rep+persistentgamedata1.dat (or 2/3).");
    if (head !== MAGIC) throw new Error("Not a Repentance save file (unexpected header). Use rep+persistentgamedataN.dat from your Repentance+ save folder.");
    let off = 16;
    const s4 = () => { const v = dv.getInt32(off, true); off += 4; return v; };
    s4(); // crc
    const out = {};
    for (let k = 0; k < 11; k++) {
      if (off + 8 > dv.byteLength) break;
      const ctype = s4(); s4(); // type, len (unreliable, ignored)
      const name = CHUNK[ctype] || ("unknown_" + ctype);
      if ([1, 4, 5, 6, 7, 10].includes(ctype)) {          // count + count * u1
        const n = s4(); const vals = new Array(n);
        for (let i = 0; i < n; i++) vals[i] = dv.getUint8(off++);
        out[name] = { count: n, values: vals };
      } else if ([2, 3, 8, 9].includes(ctype)) {          // count + count * s4
        const n = s4(); const vals = new Array(n);
        for (let i = 0; i < n; i++) { vals[i] = dv.getInt32(off, true); off += 4; }
        out[name] = { count: n, values: vals };
      } else { break; }                                    // bestiary (11) is last + unneeded
    }
    if (!out.achievements) throw new Error("Couldn't read achievements from that save file.");
    return out;
  }

  function computeImported(parsed, dataset, achIndex, bossIndex) {
    const ach = (parsed.achievements && parsed.achievements.values) || [];
    const earned = []; ach.forEach((v, i) => { if (v) earned.push(i); });
    const coll = (parsed.collectibles && parsed.collectibles.values) || [];
    const bossVals = (parsed.bosses && parsed.bosses.values) || [];
    const items = {}, chars = { isaac: true }, marks = {}, bosses = {};
    earned.forEach(aid => {
      const e = achIndex[String(aid)]; if (!e) return;
      if (e.item_slug) items[e.item_slug] = true;
      if (e.char_slug) chars[e.char_slug] = true;
      if (e.proves_mark) { (marks[e.proves_mark.char_slug] = marks[e.proves_mark.char_slug] || {})[e.proves_mark.mark_key] = "normal"; }
    });
    dataset.collectibles.forEach(it => {
      const gid = it.game_id;
      if (Number.isInteger(gid) && gid >= 0 && gid < coll.length && coll[gid]) items[it.slug] = true;
    });
    if (bossIndex) { for (const v in bossIndex) { const idx = +v; if (idx >= 0 && idx < bossVals.length && bossVals[idx]) bosses[bossIndex[v]] = true; } }
    return {
      items, characters: chars, marks, bosses,
      counts: {
        achievements_earned: earned.length, achievements_total: (parsed.achievements || {}).count,
        collectibles_seen: coll.filter(Boolean).length,
        bosses_seen: bossVals.filter(Boolean).length, bosses_defeated: Object.keys(bosses).length,
        items_owned: Object.keys(items).length, characters_unlocked: Object.keys(chars).length,
      },
    };
  }

  return { parse, computeImported };
})();
if (typeof window !== "undefined") window.SaveParse = SaveParse;
