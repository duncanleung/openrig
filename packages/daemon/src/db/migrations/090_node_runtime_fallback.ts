import type { Migration } from "../migrate.js";

// RIG-43: runtime fallback on provider usage limit.
// Seven nullable columns on nodes:
//   fallback_runtime          — declared fallback runtime from spec (e.g. "claude-code")
//   fallback_model            — declared fallback model from spec (nullable)
//   fallback_state            — null | 'on_fallback' | 'swap_back_pending'
//   fallback_pool_key         — usage-limit pool that triggered the fallback
//   fallback_entered_at       — ISO timestamp of forward swap
//   fallback_swap_back        — 'at_expiry' | 'manual'
//   fallback_original_runtime — original runtime stored at forward-swap so swap-back knows what to restore
// All nullable so rows created before this migration are unaffected.
export const nodeRuntimeFallbackSchema: Migration = {
  name: "090_node_runtime_fallback.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN fallback_runtime TEXT;
    ALTER TABLE nodes ADD COLUMN fallback_model TEXT;
    ALTER TABLE nodes ADD COLUMN fallback_state TEXT;
    ALTER TABLE nodes ADD COLUMN fallback_pool_key TEXT;
    ALTER TABLE nodes ADD COLUMN fallback_entered_at TEXT;
    ALTER TABLE nodes ADD COLUMN fallback_swap_back TEXT;
    ALTER TABLE nodes ADD COLUMN fallback_original_runtime TEXT;
  `,
};
