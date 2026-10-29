# Vendored tesseract.js - pinned, self-hosted, no CDN

Added 2026-09-09 by the pre-launch security hardening pass (client-audit finding
**C-02**, severity HIGH).

## What this replaces

`js/app.js` used to load the OCR engine like this:

```js
s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
```

That was the **only** third-party script the Fiiiish App loaded anywhere, and it
was the worst possible shape for one:

- a **floating major** (`@5`), so jsDelivr served whatever the newest 5.x was at
  the moment of the click - a fresh malicious 5.x publish would be served
  automatically, to everyone, with no redeploy;
- **no `integrity`**, no `crossorigin`, so SRI could not be enforced;
- injected into `document.head`, i.e. running with full same-origin privileges
  on an origin whose `localStorage` holds the Command Center bearer token
  (`island.hq[...].token`) and the TarkovTracker API token.

tesseract.js also fetches its **worker script**, its **WASM core** and its
**language data** from remote CDNs at runtime, so one click on "scan" was four
un-pinned third-party fetches, not one.

Everything is now served from this app's own origin. There is no CDN in the OCR
path at all, the feature works offline, and the app's Content-Security-Policy no
longer needs `https://cdn.jsdelivr.net` or `https://tessdata.projectnaptha.com`
in `script-src` / `connect-src`.

## Exact pins

| File | Package | Version |
|---|---|---|
| `tesseract.min.js`, `worker.min.js` | `tesseract.js` | **5.1.1** |
| `core/tesseract-core-simd-lstm.wasm.js`, `core/tesseract-core-lstm.wasm.js` | `tesseract.js-core` | **5.1.1** |
| `lang/eng.traineddata.gz` | `@tesseract.js-data/eng` (`4.0.0_best_int`) | **1.0.0** |

Obtained with `npm pack <pkg>@<version>` and copied verbatim - no edits, no
minification, no transform. `SHA256SUMS.txt` in this directory records the
digest of every file as shipped.

To re-verify or to bump the pin:

```
npm pack tesseract.js@5.1.1
npm pack tesseract.js-core@5.1.1
npm pack @tesseract.js-data/eng@1.0.0
```

then diff the extracted files against this directory and regenerate
`SHA256SUMS.txt`.

## Why both core builds

`tesseract.js` picks its WASM core at runtime from a directory: SIMD-capable
browsers get `tesseract-core-simd-lstm.wasm.js`, everything else gets
`tesseract-core-lstm.wasm.js`. Shipping only the SIMD build would 404 on an
older browser and read as "the OCR is broken", so both are here. Only the
LSTM-only pair is vendored, because `js/app.js` creates its worker with the
default `OEM.LSTM_ONLY` - the legacy (non-LSTM) cores are never requested.

`4.0.0_best_int` is the language model tesseract.js itself defaults to for
LSTM-only mode (2.9 MB) rather than the 11 MB combined legacy+LSTM model.

## Load cost

Nothing here is precached and nothing is fetched on page load. The whole
directory is pulled only when the user opens the Rust genetics screen-scanner
and clicks "scan"; the service worker then runtime-caches it into the Rust app
bucket, so the second scan is instant and works offline.

## Licences

tesseract.js and tesseract.js-core are Apache-2.0; the licence texts ship
alongside the code (`LICENSE.tesseract.js.txt`,
`core/LICENSE.tesseract.js-core.txt`, and the two webpack `*.LICENSE.txt`
banners). The `eng` traineddata is Apache-2.0 from the upstream `tessdata`
project.
