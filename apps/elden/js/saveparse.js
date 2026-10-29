/* saveparse.js - Elden Ring save-file reader (ER0000.sl2 / ER0000.co2).
 *
 * OWNS: nothing but pure parsing. No DOM, no fetch, no globals beyond the one
 * export. Loaded three ways, all of them classic-script friendly:
 *   - in the browser worker:  importScripts('saveparse.js')  -> self.SaveParse
 *   - in node (CJS interop):  import SaveParse from '../js/saveparse.js'
 *   - in a page (not used):   <script src=...>                -> window.SaveParse
 *
 * FILE FENCE (island RULES R7): this file, js/saveparse.worker.js,
 * js/tracker.js, css/tracker.css, tools/test-saveparse.mjs.
 *
 * SHIP CONTRACT: this file is COPIED verbatim by the island assembler (it is
 * not in the registry `scripts` list, so no path rewriting happens to it).
 * Therefore it must contain ZERO dot-slash path literals (the assembler greps
 * for a quote followed by dot-slash) and load no resources of its own. Everything it needs - the bytes, the BST table, the flag ids we care
 * about - is handed in by the caller.
 *
 * READ-ONLY FOREVER. Nothing here writes, and the file's 16-byte MD5 digests
 * are never recomputed, because recomputing them is only needed to write a
 * save back. That is the whole reason this is anti-cheat safe: it touches a
 * file on disk, never a running process.
 *
 * ------------------------------------------------------------------ format
 *
 * The container is FromSoftware's BND4 archive, unencrypted on PC:
 *
 *   0x000            "BND4" magic
 *   0x300 + i*0x280010   16-byte MD5 of slot i's data
 *   0x310 + i*0x280010   slot i character data, 0x280000 bytes, i = 0..9
 *   0x1901D04 + i        one "slot is in use" byte per slot
 *   0x1901D0E + i*0x24C  slot i profile summary: name (16 UTF-16LE chars),
 *                        level u16 at +0x22, seconds played u32 at +0x26,
 *                        rune memory u32 at +0x2A
 *
 * Inside a slot, the character struct is a chain of fixed-size blocks with
 * three variable-length ones (the ga_items table, the projectile list and the
 * visited-regions list). Walking it lands on the event-flag bitfield, which is
 * 0x1BF99F bytes of packed bits. The walk is a port of the logic in
 * CyberGiant7's Elden-Ring-Automatic-Checklist (MIT) - re-implemented here,
 * not copied, and re-derived block by block against a real save.
 *
 * Flags are NOT one flat bit array. A flag id decomposes as
 *   block = floor(id / 1000)      bit-in-block = id % 1000
 * and `block` is mapped through the vendored eventflag_bst.json table to an
 * ORDINAL, which is then multiplied by 125 (1000 bits = 125 bytes) to get the
 * block's byte offset. Bits inside a byte run most-significant-first.
 *
 * ------------------------------------------------- what was verified, and how
 *
 * Every offset below was confirmed against a real local save file
 * (5 characters, 5 empty slots) before this file was written:
 *   - names, levels and seconds-played read out correctly for all 5;
 *   - the 8 stats sum to exactly (level - 1 + 80) for two Wretch characters,
 *     i.e. the stat block and the level field agree arithmetically;
 *   - the level-103 character's decoded boss flags are a coherent main-path
 *     progression (Margit -> Godrick -> Rennala -> Radahn -> Morgott ->
 *     Maliketh -> Mohg -> Radagon), while the level-1 and level-7 characters
 *     decode to zero boss flags. Random offsets do not do that.
 *
 * TWO CORRECTIONS to the plan's notes, found by that check:
 *   1. "all-zero MD5 = empty slot" is NOT true on a real file - the unused
 *      slots carried non-zero digests. The authoritative empty-slot signal is
 *      the per-slot in-use byte at 0x1901D04, cross-checked with a blank name.
 *   2. The magic pattern B0 AD 01 00 01 (+ FF FF FF) does not sit at the edge
 *      of the flag block; it marks the inventory list much earlier in the
 *      slot, at a FIXED distance of 113,061 bytes before the flag block (the
 *      distance is constant because every struct between the two is fixed
 *      size). So the pattern is used here as a cross-check on the struct walk,
 *      and as a fallback locator if the walk lands out of range - never as the
 *      primary.
 *
 * NOT EXTRACTED: the NG+ / journey counter. It could not be located to a
 * confident byte on the local save (no character in it has been through a
 * second journey to anchor the search), so `ngPlus` is reported as null rather
 * than guessed. The tracker treats NG+ as a manual field.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.SaveParse = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  /* --------------------------------------------------------------- layout */

  var C = {
    SLOT_COUNT: 10,
    MAGIC: [0x42, 0x4e, 0x44, 0x34],          /* "BND4" */
    SLOT_MD5_0: 0x300,
    SLOT_DATA_0: 0x310,
    SLOT_STRIDE: 0x280010,
    SLOT_LEN: 0x280000,
    ACTIVE_0: 0x1901d04,                       /* 10 in-use bytes, one per slot */
    PROFILE_0: 0x1901d0e,                      /* slot 0 summary: name first    */
    PROFILE_STRIDE: 0x24c,
    PROFILE_NAME_LEN: 32,                      /* 16 UTF-16LE code units        */
    PROFILE_LEVEL: 0x22,                       /* u16, relative to PROFILE_0    */
    PROFILE_SECONDS: 0x26,                     /* u32 */
    PROFILE_MEMORY: 0x2a,                      /* u32 */
    FLAG_LEN: 0x1bf99f,                        /* 1,833,375 bytes of flag bits  */
    FLAG_BLOCK_BYTES: 125,                     /* 1000 flags per BST block      */
    /* How much of a slot we must hold to complete the struct walk. The walk
     * cannot exceed ~290 KB (the ga_items table caps at 0x1400 * 21 bytes and
     * everything else is fixed), so 0x60000 is a generous ceiling that still
     * keeps the worker's per-slot read small. */
    SLOT_HEAD_LEN: 0x60000,
    /* Player stat block, relative to the start of PlayerGameData. */
    PGD_LEN: 432,
    PGD_STATS: 0x34,                           /* 8 x u32: vig mind end str dex int fai arc */
    PGD_LEVEL: 0x60,
    PGD_RUNES: 0x64,
    PGD_MEMORY: 0x68,
    PGD_NAME: 0x94,                            /* UTF-16LE, same name as the summary */
    /* Inventory marker, used only to cross-check / rescue the walk. */
    PATTERN: [0xb0, 0xad, 0x01, 0x00, 0x01, 0xff, 0xff, 0xff],
    PATTERN_DLC: [0xb0, 0xad, 0x01, 0x00, 0x01],
    PATTERN_TO_FLAGS: 113061
  };

  /* Smallest file that can contain the whole profile table. */
  C.MIN_FILE = C.PROFILE_0 + C.SLOT_COUNT * C.PROFILE_STRIDE + 64;

  var STAT_KEYS = ['vig', 'mind', 'end', 'str', 'dex', 'int', 'fai', 'arc'];

  /* ---------------------------------------------------------------- errors */

  var ERRORS = {
    NOT_BND4: 'That file is not an Elden Ring save. Pick ER0000.sl2 (or ER0000.co2 for Seamless Co-op).',
    BAD_SLOT_LAYOUT: 'The file starts like a save but its character slots are the wrong size. It may be truncated, still being written, or from another game.',
    NO_FLAG_BLOCK: 'A character slot could not be read - the progress bitfield was not where the layout says it is. If the game was running, quit it and try again.',
    GAMEPASS_HINT: 'That looks like an Xbox or Game Pass save. Those are stored in a sealed container with no .sl2 file, so they cannot be read. The Steam version works.'
  };

  function fail(code, extra) {
    var e = new Error(ERRORS[code] || code);
    e.code = code;
    if (extra) e.detail = extra;
    return e;
  }

  /* ----------------------------------------------------------- byte helpers */

  function u8(view) {
    if (view instanceof Uint8Array) return view;
    if (view && view.buffer) return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return new Uint8Array(view);
  }

  function dv(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function startsWith(bytes, sig) {
    if (bytes.length < sig.length) return false;
    for (var i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
    return true;
  }

  function indexOfBytes(hay, needle, from) {
    var n = needle.length, end = hay.length - n, i, j;
    for (i = from || 0; i <= end; i++) {
      if (hay[i] !== needle[0]) continue;
      for (j = 1; j < n; j++) if (hay[i + j] !== needle[j]) break;
      if (j === n) return i;
    }
    return -1;
  }

  /* UTF-16LE, NUL-terminated, decoded without TextDecoder so the same code
   * runs in node, in a worker and on a page with no capability check. */
  function utf16(bytes, off, byteLen) {
    var out = '', i, c;
    for (i = 0; i + 1 < byteLen; i += 2) {
      c = bytes[off + i] | (bytes[off + i + 1] << 8);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  /* ------------------------------------------------------------- container */

  function slotDataOffset(i) { return C.SLOT_DATA_0 + i * C.SLOT_STRIDE; }
  function slotMd5Offset(i) { return C.SLOT_MD5_0 + i * C.SLOT_STRIDE; }
  function profileOffset(i) { return C.PROFILE_0 + i * C.PROFILE_STRIDE; }

  /* A Game Pass save is not a renamed .sl2 - it is an opaque blob inside a
   * "container" directory with GUID-named parts and no extension at all. When
   * the magic fails AND the name looks like one of those, say so by name
   * instead of the generic refusal, because the user cannot fix it. */
  function looksGamePass(fileName) {
    if (!fileName) return false;
    var n = String(fileName).toLowerCase();
    if (/^container(\.[0-9]+)?$/.test(n)) return true;
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}/.test(n) && n.indexOf('.sl2') < 0 && n.indexOf('.co2') < 0) return true;
    return n.indexOf('.') < 0;
  }

  function formatOf(fileName) {
    return (fileName && /\.co2$/i.test(String(fileName))) ? 'co2' : 'sl2';
  }

  /* Validates the first bytes and the overall size. `head` needs only to cover
   * the magic; `fileSize` is the whole file's length. Throws, or returns the
   * declared format. `.co2` (Seamless Co-op) is ATTEMPTED with exactly the same
   * checks and refused by name if any of them fails - it is documented as a
   * byte-compatible rename, and this is where that claim gets tested. */
  function checkHeader(head, fileSize, fileName) {
    var bytes = u8(head);
    if (!startsWith(bytes, C.MAGIC)) {
      if (looksGamePass(fileName)) throw fail('GAMEPASS_HINT');
      throw fail('NOT_BND4');
    }
    if (!(fileSize >= C.MIN_FILE)) {
      throw fail('BAD_SLOT_LAYOUT', 'file is ' + fileSize + ' bytes, needs at least ' + C.MIN_FILE);
    }
    if (fileSize < slotDataOffset(C.SLOT_COUNT - 1) + C.SLOT_LEN) {
      throw fail('BAD_SLOT_LAYOUT', 'file cannot hold ' + C.SLOT_COUNT + ' slots');
    }
    return formatOf(fileName);
  }

  /* `table` must be the bytes from ACTIVE_0 up to at least the end of the last
   * profile summary; `tableBase` is that region's absolute file offset. */
  function readProfiles(table, tableBase) {
    var bytes = u8(table), d = dv(bytes), out = [], i, rel, name, active;
    for (i = 0; i < C.SLOT_COUNT; i++) {
      active = bytes[C.ACTIVE_0 + i - tableBase] === 1;
      rel = profileOffset(i) - tableBase;
      name = utf16(bytes, rel, C.PROFILE_NAME_LEN).trim();
      out.push({
        index: i,
        active: active,
        name: name,
        level: d.getUint16(rel + C.PROFILE_LEVEL, true),
        secondsPlayed: d.getUint32(rel + C.PROFILE_SECONDS, true),
        runeMemory: d.getUint32(rel + C.PROFILE_MEMORY, true)
      });
    }
    return out;
  }

  /* --------------------------------------------------------- the slot walk */

  /* Walks the character struct from the start of a slot to the event-flag
   * bitfield. `head` is the first SLOT_HEAD_LEN bytes of the slot. Returns the
   * byte offsets, relative to the slot, of PlayerGameData and of the flags.
   *
   * Every "+=" below is one block of the struct, in order, with its size. The
   * three reads are the only variable-length pieces. */
  function walkSlot(head) {
    var bytes = u8(head), d = dv(bytes), lim = bytes.length;
    var o = 0, i, itemId, tag, count;

    function need(n) {
      if (o + n > lim) throw fail('NO_FLAG_BLOCK', 'walk ran past the ' + lim + '-byte slot head at ' + o);
    }

    need(32); o += 4 + 4 + 0x18;              /* version, map id, padding      */

    /* ga_items: 0x1400 entries, each 8 bytes plus a tail that depends on the
     * item id's top nibble. This is the first variable-length block and the
     * reason a plain fixed offset never works. */
    for (i = 0; i < 0x1400; i++) {
      need(8);
      itemId = d.getUint32(o + 4, true);
      o += 8;
      if (itemId !== 0) {
        tag = itemId & 0xf0000000;
        if (tag === 0) { need(13); o += 13; }
        else if (tag === 0x10000000) { need(8); o += 8; }
      }
    }

    var playerOffset = o;
    need(C.PGD_LEN); o += C.PGD_LEN;          /* PlayerGameData                */
    o += 0xd0;                                 /* unnamed block                 */
    o += 88;                                   /* EquipData                     */
    o += 116;                                  /* ChrAsm                        */
    o += 88;                                   /* ChrAsm2                       */
    o += 4 + (0xa80 * 12) + 4 + (0x180 * 12) + 4 + 4;  /* main inventory 37,520 */
    o += 116;                                  /* EquipMagicData                */
    o += 140;                                  /* EquipItemData                 */
    o += 24;                                   /* equipped gestures             */

    need(4); count = d.getInt32(o, true);      /* projectiles (variable)        */
    if (count < 0 || count > 0x10000) throw fail('BAD_SLOT_LAYOUT', 'projectile count ' + count);
    o += 4 + count * 8;

    o += 156;                                  /* EquippedItems                 */
    o += 8;                                    /* EquipPhysicsData              */
    o += 4;
    o += 0x12f;                                /* face data                     */
    o += 4 + (0x780 * 12) + 4 + (0x80 * 12) + 4 + 4;   /* storage box   24,592  */
    o += 256;                                  /* gesture unlock table          */

    need(4); count = d.getUint32(o, true);     /* visited regions (variable)    */
    if (count > 0x10000) throw fail('BAD_SLOT_LAYOUT', 'region count ' + count);
    o += 4 + count * 4;

    o += 40;                                   /* RideGameData                  */
    o += 77;
    o += 0x1008;                               /* menu profile save/load        */
    o += 0x34;                                 /* trophy equip data             */
    o += 4 + 4 + (0x1b58 * 16);                /* GaItemData          112,008   */
    o += 0x408;                                /* tutorial data                 */
    o += 0x1d;

    var flagOffset = o;
    var located = 'walk';

    /* Cross-check / rescue with the inventory marker. */
    var pat = indexOfBytes(bytes, C.PATTERN, 0);
    if (pat < 0) pat = indexOfBytes(bytes, C.PATTERN_DLC, 0);
    var patternOffset = pat >= 0 ? pat + C.PATTERN_TO_FLAGS : -1;

    if (!inRange(flagOffset)) {
      if (patternOffset >= 0 && inRange(patternOffset)) {
        flagOffset = patternOffset;
        located = 'pattern';
      } else {
        throw fail('NO_FLAG_BLOCK', 'walk offset ' + o + ' is outside the slot');
      }
    }

    return {
      playerOffset: playerOffset,
      flagOffset: flagOffset,
      located: located,
      /* Non-fatal: the two locators disagreed. Surfaced so a future save format
       * change shows up as a warning instead of as silently wrong ticks. */
      warn: (patternOffset >= 0 && patternOffset !== flagOffset)
        ? 'flag locators disagree (walk ' + o + ', marker ' + patternOffset + ')'
        : null
    };
  }

  function inRange(off) {
    return off > 0x10000 && off + C.FLAG_LEN <= C.SLOT_LEN && off < C.SLOT_HEAD_LEN;
  }

  /* Reads level, the 8 stats, runes held and rune memory out of
   * PlayerGameData. `head` is the same slot head walkSlot() was given. */
  function readPlayer(head, playerOffset) {
    var bytes = u8(head), d = dv(bytes), base = playerOffset, stats = {}, i, total = 0, v;
    for (i = 0; i < STAT_KEYS.length; i++) {
      v = d.getUint32(base + C.PGD_STATS + i * 4, true);
      stats[STAT_KEYS[i]] = v;
      total += v;
    }
    return {
      level: d.getUint32(base + C.PGD_LEVEL, true),
      stats: stats,
      statTotal: total,
      runes: d.getUint32(base + C.PGD_RUNES, true),
      runeMemory: d.getUint32(base + C.PGD_MEMORY, true),
      name: utf16(bytes, base + C.PGD_NAME, C.PROFILE_NAME_LEN)
    };
  }

  /* A character's level and stats are locked together: every level after the
   * first buys exactly one stat point. So (sum of stats) - (level - 1) is the
   * starting class's stat total, which is 79..91 for the ten classes. Anything
   * outside that window means the stat block was misread. */
  function statsLookSane(player) {
    if (!(player.level >= 1 && player.level <= 900)) return false;
    var base = player.statTotal - (player.level - 1);
    return base >= 75 && base <= 95;
  }

  /* ---------------------------------------------------------------- flags */

  /* `flags` is the FLAG_LEN-byte bitfield, `bst` the vendored block table,
   * `wantFlags` the only ids we care about (boss + grace flag ids). Returns a
   * Set of the ids that are set. Ids whose block is missing from the table are
   * reported separately rather than silently counted as "not done". */
  function readFlags(flags, bst, wantFlags) {
    var bytes = u8(flags), set = new Set(), unknown = [], i, id, block, ord, off, bit;
    if (!wantFlags || !wantFlags.length) return { set: set, unknown: unknown, checked: 0 };
    for (i = 0; i < wantFlags.length; i++) {
      id = wantFlags[i];
      if (typeof id !== 'number' || !isFinite(id) || id < 0) continue;
      block = Math.floor(id / 1000);
      ord = bst[block];
      if (ord === undefined || ord === null) { unknown.push(id); continue; }
      off = ord * C.FLAG_BLOCK_BYTES + Math.floor((id % 1000) / 8);
      if (off >= bytes.length) { unknown.push(id); continue; }
      bit = 7 - (id % 8);
      if ((bytes[off] & (1 << bit)) !== 0) set.add(id);
    }
    return { set: set, unknown: unknown, checked: wantFlags.length };
  }

  /* ------------------------------------------------------------- one slot */

  /* The per-slot half of the parse, shared by parse() and the worker. `head`
   * is the slot's first SLOT_HEAD_LEN bytes; `readFlagBytes` is a callback
   * that returns the FLAG_LEN bytes starting at the offset it is handed, so
   * the worker can defer the big read until it knows where to read. */
  function readSlot(profile, head, readFlagBytes, bst, wantFlags) {
    var walked = walkSlot(head);
    var player = readPlayer(head, walked.playerOffset);
    var flagBytes = readFlagBytes(walked.flagOffset);
    var flags = readFlags(flagBytes, bst, wantFlags);
    var sane = statsLookSane(player);
    return {
      index: profile.index,
      empty: false,
      name: profile.name || player.name || ('Slot ' + (profile.index + 1)),
      level: player.level,
      stats: player.stats,
      runes: player.runes,
      runeMemory: player.runeMemory,
      secondsPlayed: profile.secondsPlayed,
      /* Not located confidently in the save - see the header note. */
      ngPlus: null,
      flags: flags.set,
      flagsChecked: flags.checked,
      flagsUnknown: flags.unknown.length,
      located: walked.located,
      /* Collected, never thrown: a slot that reads oddly is still shown, with
       * the caveat attached, rather than failing the whole import. */
      warnings: [walked.warn, sane ? null : 'level and stats do not agree - treat this slot with suspicion']
        .filter(Boolean)
    };
  }

  function emptySlot(i, profile) {
    return {
      index: i, empty: true, name: (profile && profile.name) || '', level: 0,
      stats: null, runes: 0, runeMemory: 0, secondsPlayed: 0, ngPlus: null,
      flags: new Set(), flagsChecked: 0, flagsUnknown: 0, located: null, warnings: []
    };
  }

  /* ------------------------------------------------------------------ API */

  /* parse(bytes, bst, opts) - the whole-buffer path. The browser does NOT use
   * this (the worker reads slices so a 29 MB file is never cloned); it is what
   * node and tools/test-saveparse.mjs use.
   *
   *   bytes  Uint8Array of the entire file
   *   bst    the parsed data/eventflag_bst.json object
   *   opts   {fileName, wantFlags:[number]}
   *
   * Returns {format, slots:[...]}, and throws a coded Error on refusal. */
  function parse(bytes, bst, opts) {
    var b = u8(bytes);
    var o = opts || {};
    var want = o.wantFlags || [];
    var format = checkHeader(b, b.length, o.fileName);
    var tableBase = C.ACTIVE_0;
    var tableEnd = profileOffset(C.SLOT_COUNT - 1) + C.PROFILE_STRIDE;
    var profiles = readProfiles(b.subarray(tableBase, tableEnd), tableBase);
    var slots = [], i, p, base;

    for (i = 0; i < C.SLOT_COUNT; i++) {
      p = profiles[i];
      if (!p.active || !p.name) { slots.push(emptySlot(i, p)); continue; }
      base = slotDataOffset(i);
      slots.push(readSlot(
        p,
        b.subarray(base, base + C.SLOT_HEAD_LEN),
        function (off) { return b.subarray(base + off, base + off + C.FLAG_LEN); },
        bst,
        want
      ));
    }
    return { format: format, slots: slots };
  }

  return {
    parse: parse,
    /* Building blocks, so the worker can do the same job over slices. */
    checkHeader: checkHeader,
    readProfiles: readProfiles,
    walkSlot: walkSlot,
    readPlayer: readPlayer,
    readFlags: readFlags,
    readSlot: readSlot,
    emptySlot: emptySlot,
    slotDataOffset: slotDataOffset,
    slotMd5Offset: slotMd5Offset,
    profileOffset: profileOffset,
    statsLookSane: statsLookSane,
    STAT_KEYS: STAT_KEYS,
    ERRORS: ERRORS,
    C: C
  };
}));
