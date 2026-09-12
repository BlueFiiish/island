/**
 * hash-tabs.js - the shared deep-link shim for ported apps.
 *
 * The shell owns `location.pathname`; an app owns `location.hash`. Apps that
 * already do their own hash routing (Rust) need NOTHING from this file, so it
 * hard no-ops for them - running two hash routers on one page is how you get a
 * tab that flickers back to the first view on every click.
 *
 * Apps whose tabs are plain buttons with no hash (Calamity, Isaac in P1)
 * declare `tabs: { bar, item, attr }` in src/registry.mjs and get:
 *   - the tab named by the current hash activated on load
 *   - the hash rewritten (replaceState, no new history entry) on tab click
 *   - back/forward driving the tabs
 *
 * Config is handed over on window.FI_APP by AppFrame.astro, so this file stays
 * a static asset with no per-app build step.
 */
(function () {
  'use strict';
  var cfg = window.FI_APP;
  if (!cfg || cfg.nativeHashRouting || !cfg.tabs) return;

  var t = cfg.tabs;
  var bar = document.querySelector(t.bar);
  if (!bar) return;

  function items() {
    return Array.prototype.slice.call(bar.querySelectorAll(t.item));
  }
  function nameOf(el) {
    return el.getAttribute(t.attr) || '';
  }
  function activate(name, push) {
    var list = items();
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (nameOf(list[i]) === name) target = list[i];
    }
    if (!target) return false;
    if (push && location.hash.slice(1) !== name) {
      history.replaceState(history.state, '', '#' + name);
    }
    target.click();
    return true;
  }

  bar.addEventListener(
    'click',
    function (e) {
      var el = e.target.closest ? e.target.closest(t.item) : null;
      if (!el || !bar.contains(el)) return;
      var name = nameOf(el);
      if (name && location.hash.slice(1) !== name) {
        history.replaceState(history.state, '', '#' + name);
      }
    },
    true
  );

  window.addEventListener('hashchange', function () {
    activate(location.hash.slice(1), false);
  });

  var start = location.hash.slice(1);
  if (start) activate(start, false);
})();
