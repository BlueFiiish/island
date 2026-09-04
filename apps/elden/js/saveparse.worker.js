/* saveparse.worker.js - the off-thread half of the save import.
 *
 * WHY A WORKER, AND WHY SLICES. ER0000.sl2 is ~29 MB. Reading it with one
 * file.arrayBuffer() on the main thread costs a 29 MB copy in the tab's heap
 * and freezes the UI while the ten slots are walked. On an iPhone that is the
 * difference between "it imported" and "Safari reloaded the page". So:
 *
 *   - the File is handed to this worker by REFERENCE (structured clone of a
 *     File does not copy its bytes - it hands over the same blob handle), and
 *   - every read is a file.slice(...).arrayBuffer(), so the largest buffer
 *     alive at any moment is one slot's flag block (1.75 MB), released before
 *     the next slot is read.
 *
 * Peak memory for a 10-character save is therefore about 2.2 MB, not 29 MB.
 *
 * PROTOCOL
 *   in   {type:'parse', file:File, wantFlags:[number],
 *         bst:<object>            - the parsed eventflag_bst table, OR
 *         bstUrl:<absolute url>   - fetched here instead (preferred: keeps the
 *                                   main thread out of a 225 KB JSON parse)}
 *   out  {type:'progress', pct:0..100, note:string}
 *        {type:'done', format, slots:[...], ms}
 *        {type:'error', code, message, detail}
 *
 * The result's `flags` are ARRAYS of ids, not the Sets js/saveparse.js returns:
 * a Set survives structured clone, but an array is smaller on the wire and the
 * tracker only ever iterates them. js/tracker.js rebuilds whatever it needs.
 *
 * FILE FENCE (island RULES R7): js/tracker.js, js/saveparse.js,
 * js/saveparse.worker.js, css/tracker.css, tools/test-saveparse.mjs.
 *
 * SHIP CONTRACT: copied verbatim by the island assembler (js/ is a copy dir,
 * and a worker is not in the registry `scripts` list), so this file must
 * contain ZERO dot-slash path literals (the assembler's no-relative gate
 * greps for a quote followed by dot-slash). importScripts() below resolves
 * against THIS file's own URL, which is correct in both the standalone app and
 * the island build, and the BST url is handed in already absolute.
 *
 * READ-ONLY. Nothing here writes to the file, and no byte of it leaves the
 * device: there is no fetch to anywhere but the app's own origin.
 */
/* global importScripts, SaveParse */
'use strict';

importScripts('saveparse.js');

var C = SaveParse.C;

/* ------------------------------------------------------------------ reads */

/* Blob.arrayBuffer() is the fast path (Safari 14+, Chrome 76+). The
 * FileReader fallback exists because a worker on an older WebView still has to
 * either work or refuse by name - never silently return nothing. */
function sliceBytes(file, start, len) {
  var end = Math.min(start + len, file.size);
  var blob = file.slice(start, end);
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () {
      resolve(new Uint8Array(fr.result));
    };
    fr.onerror = function () {
      reject(new Error('the file could not be read - it may have been moved or the game may be writing to it'));
    };
    fr.readAsArrayBuffer(blob);
  });
}

function post(msg) {
  try {
    self.postMessage(msg);
  } catch (e) {
    /* the page went away mid-parse; nothing to do and nobody to tell */
  }
}

function progress(pct, note) {
  post({ type: 'progress', pct: Math.max(0, Math.min(100, Math.round(pct))), note: note || '' });
}

function postError(err) {
  post({
    type: 'error',
    code: (err && err.code) || 'READ_FAILED',
    message: (err && err.message) || 'The save could not be read.',
    detail: (err && err.detail) || null
  });
}

/* ------------------------------------------------------------------- bst */

function loadBst(msg) {
  if (msg.bst && typeof msg.bst === 'object') return Promise.resolve(msg.bst);
  if (!msg.bstUrl) {
    return Promise.reject(new Error('the event-flag table was not supplied'));
  }
  return fetch(msg.bstUrl, { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) throw new Error('the event-flag table could not be loaded (' + r.status + ')');
    return r.json();
  });
}

/* ------------------------------------------------------------------ parse */

/* One slot, in three reads:
 *   1. the slot head (384 KB) - enough for the whole struct walk;
 *   2. nothing, if the walk refuses;
 *   3. the flag block (1.75 MB) at exactly the offset the walk found.
 *
 * walkSlot() runs twice - once here to learn the offset, once inside
 * readSlot() with the bytes already in hand. The walk is a few thousand
 * arithmetic steps over a typed array; running it twice costs under a
 * millisecond and buys a single implementation of the slot record shape. */
function readOneSlot(file, profile, bst, wantFlags) {
  var base = SaveParse.slotDataOffset(profile.index);
  var head;
  return sliceBytes(file, base, C.SLOT_HEAD_LEN)
    .then(function (bytes) {
      head = bytes;
      var walked = SaveParse.walkSlot(head);
      return sliceBytes(file, base + walked.flagOffset, C.FLAG_LEN);
    })
    .then(function (flagBytes) {
      var slot = SaveParse.readSlot(
        profile,
        head,
        function () {
          return flagBytes;
        },
        bst,
        wantFlags
      );
      head = null;
      flagBytes = null;
      /* Sets do not need to cross the wire. */
      slot.flags = Array.from(slot.flags);
      return slot;
    });
}

function run(msg) {
  var file = msg.file;
  var wantFlags = (msg.wantFlags || []).filter(function (n) {
    return typeof n === 'number' && isFinite(n);
  });
  if (!file || typeof file.slice !== 'function') {
    return postError(new Error('no file was handed to the reader'));
  }
  var t0 = Date.now();
  var bst = null;
  var format = 'sl2';
  var profiles = [];

  progress(2, 'Opening the file');

  loadBst(msg)
    .then(function (table) {
      bst = table;
      return sliceBytes(file, 0, 0x400);
    })
    .then(function (head) {
      /* Throws NOT_BND4 / GAMEPASS_HINT / BAD_SLOT_LAYOUT by name. */
      format = SaveParse.checkHeader(head, file.size, file.name || '');
      progress(6, 'Reading the character list');
      var tableBase = C.ACTIVE_0;
      var tableEnd = SaveParse.profileOffset(C.SLOT_COUNT - 1) + C.PROFILE_STRIDE;
      return sliceBytes(file, tableBase, tableEnd - tableBase).then(function (bytes) {
        return SaveParse.readProfiles(bytes, tableBase);
      });
    })
    .then(function (list) {
      profiles = list;
      var live = profiles.filter(function (p) {
        return p.active && p.name;
      });
      var slots = [];
      var doneCount = 0;

      /* Sequential on purpose: two slots in flight would double peak memory
       * for no wall-clock win (the work is I/O against one file handle). */
      return live
        .reduce(function (chain, p) {
          return chain.then(function () {
            progress(10 + (doneCount / Math.max(1, live.length)) * 88, 'Reading ' + (p.name || 'slot ' + (p.index + 1)));
            return readOneSlot(file, p, bst, wantFlags).then(
              function (slot) {
                doneCount++;
                slots.push(slot);
              },
              function (err) {
                /* One unreadable slot must not lose the other nine. It comes
                 * back marked, with the refusal code attached, and the tracker
                 * shows it greyed out instead of pretending it is empty. */
                doneCount++;
                var stub = SaveParse.emptySlot(p.index, p);
                stub.empty = false;
                stub.unreadable = true;
                stub.flags = [];
                stub.warnings = [(err && err.message) || 'this character could not be read'];
                stub.errorCode = (err && err.code) || 'READ_FAILED';
                slots.push(stub);
              }
            );
          });
        }, Promise.resolve())
        .then(function () {
          /* Empty slots are reported too, so the picker can show ten rows and
           * the user can see that slot 4 really is empty rather than missing. */
          profiles.forEach(function (p) {
            if (p.active && p.name) return;
            var e = SaveParse.emptySlot(p.index, p);
            e.flags = [];
            slots.push(e);
          });
          slots.sort(function (a, b) {
            return a.index - b.index;
          });
          progress(100, 'Done');
          post({ type: 'done', format: format, slots: slots, ms: Date.now() - t0 });
        });
    })
    .catch(postError);
}

self.onmessage = function (e) {
  var msg = e && e.data;
  if (!msg || msg.type !== 'parse') return;
  try {
    run(msg);
  } catch (err) {
    postError(err);
  }
};
