import type { Migration } from "../migrate.js";

/**
 * RIG-186 — nodes.context_lifecycle column.
 *
 * Adds `context_lifecycle TEXT` to the nodes table. Holds the seat's declared
 * context lifecycle ("elephant" | "goldfish") from the rig spec when present.
 * NULL = no explicit lifecycle declared (equivalent to "elephant" default).
 * Written by createMemberNode → addNode; read by getNodeInventory and projected
 * into the whoami peers and ps --nodes JSON responses.
 */
export const nodeContextLifecycleSchema: Migration = {
  name: "130_node_context_lifecycle.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN context_lifecycle TEXT;
  `,
};
