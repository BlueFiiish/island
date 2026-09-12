/**
 * public/config.js - runtime configuration, SENTINELS ONLY.
 *
 * This file is committed with placeholder values and is safe to publish.
 * tools/deploy.ps1 substitutes the real values from tools/secrets.local.json
 * (git-ignored, never in the vault) into the COPY inside the deploy clone.
 * If secrets.local.json is absent the sentinels ship as-is and every
 * config-gated feature stays off - which is the correct P0 state.
 *
 * Pattern lifted from projects/fiiish-shopping/app/config.js.
 *
 * Anything here is PUBLIC. A Supabase anon key is designed to be public and is
 * only safe because row-level security is on; nothing else may ever go in here.
 */
window.FIIISH_CONFIG = {
  supabaseUrl: '__SUPABASE_URL__',
  supabaseAnonKey: '__SUPABASE_ANON_KEY__',
};

/** True only once real values have been substituted in. */
window.FIIISH_CONFIGURED = !/^__[A-Z_]+__$/.test(window.FIIISH_CONFIG.supabaseUrl);
