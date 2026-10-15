// RIG-61: the single list of database columns that hold a rig name, and the pure rewrite helpers
// that every rename surface (DB, spec files, state files) shares.
//
// Why a manifest: the rig name appears as plain text in ~60 columns because session names are
// `{seat}@{rig}` and most tables key on the session name, not the rig id. The test in
// rig-rename-manifest.test.ts walks the REAL migrated schema and fails when a column that looks
// like it holds a rig or session name is in neither RIG_RENAME_MANIFEST nor RIG_RENAME_EXCLUSIONS.
// A future migration cannot add such a column silently.
//
// SQL identifiers used by the rename come from this file only. Names from the user are bound
// parameters, never concatenated into SQL.

export type ManifestKind =
  /** The column holds the rig name itself. Rewritten when equal to the old name. */
  | "rig-name"
  /** The column holds `{seat}@{rig}`. Rewritten only when the part after the FIRST `@` equals the old name. */
  | "session"
  /** The column holds JSON. Strings are rewritten as `session`; values of rig-name keys are rewritten when equal to the old name. */
  | "json"
  /** The column holds structured text (YAML). `@{old}` is rewritten where the rig name ends at a boundary. */
  | "text";

export interface ManifestColumn {
  table: string;
  column: string;
  kind: ManifestKind;
}

const rigName = (table: string, column: string): ManifestColumn => ({ table, column, kind: "rig-name" });
const session = (table: string, ...columns: string[]): ManifestColumn[] =>
  columns.map((column) => ({ table, column, kind: "session" as const }));
const json = (table: string, ...columns: string[]): ManifestColumn[] =>
  columns.map((column) => ({ table, column, kind: "json" as const }));

export const RIG_RENAME_MANIFEST: readonly ManifestColumn[] = [
  // The rig name itself.
  rigName("rigs", "name"),
  rigName("session_digests", "rig_name"),
  rigName("review_runs", "rig_name"),
  rigName("daily_token_snapshots", "rig_name"),
  rigName("workflow_specs", "target_rig"),
  rigName("workflow_instances", "bound_rig"),

  // Session names (`seat@rig`).
  ...session("sessions", "session_name"),
  ...session("bindings", "tmux_session"),
  ...session("context_usage", "session_name"),
  ...session("seat_identity_verdicts", "session_name"),
  ...session("session_digests", "seat_session"),
  ...session("daily_token_snapshots", "seat_session"),
  ...session("usage_samples", "seat_session"),
  ...session("queue_items", "source_session", "destination_session", "handed_off_to", "handed_off_from", "closure_target"),
  ...session("queue_transitions", "actor_session", "closure_target"),
  ...session("queue_transitions_archive", "actor_session", "closure_target"),
  ...session("inbox_entries", "destination_session", "sender_session"),
  ...session("outbox_entries", "sender_session", "destination_session", "retired_by"),
  ...session("stream_items", "source_session", "hint_destination"),
  ...session("watchdog_jobs", "target_session", "registered_by_session"),
  ...session("watchdog_history", "delivery_target_session"),
  ...session("workflow_instances", "created_by_session"),
  ...session("workflow_step_trails", "actor_session"),
  ...session("mission_control_actions", "actor_session"),
  ...session("classifier_leases", "classifier_session", "reclaimed_by_session"),
  ...session("classification_attempts", "classifier_session"),
  ...session("project_classifications", "classifier_session"),
  ...session("views_custom", "registered_by_session"),
  ...session("chat_messages", "sender"),
  ...session("thread_seat_map", "seat"),
  ...session("thread_part_map", "seat"),
  ...session("node_permission_selections", "actor"),
  ...session("seat_delivery_guards", "actor"),
  ...session("seat_delivery_guard_changes", "actor"),
  ...session("nodes", "previous_occupant"),

  // Cached workflow specs and workflow state. Workflow roles carry `preferred_targets: seat@rig`.
  ...json("workflow_specs", "roles_json", "steps_json", "spec_json"),
  ...json("workflow_instances", "current_frontier_json", "last_continuation_decision_json", "lifecycle_binding_json"),

  // Watchdog policy YAML names its target session.
  { table: "watchdog_jobs", column: "spec_yaml", kind: "text" },
];

/**
 * A column the guard test would otherwise flag, with the reason it is NOT rewritten. `column` may
 * be a RegExp to cover a family (every `rig_id` is a ULID foreign key, not a name).
 */
export interface ManifestExclusion {
  table?: string;
  column: string | RegExp;
  reason: string;
}

export const RIG_RENAME_EXCLUSIONS: readonly ManifestExclusion[] = [
  { column: "rig_id", reason: "ULID foreign key to rigs.id; the id does not change on rename" },
  { column: "node_id", reason: "ULID foreign key to nodes.id" },
  { column: "claimed_node_id", reason: "ULID foreign key to nodes.id" },
  { column: /^(source_id|target_id)$/, reason: "edges endpoint: node ULIDs" },
  { column: "session_id", reason: "provider (native) session id, a UUID; not a seat@rig name" },
  { column: "native_session_id", reason: "provider (native) session id, a UUID" },
  { column: "native_session_id_at_boot", reason: "provider (native) session id, a UUID. The reviewer list named it; it holds no rig name" },
  { column: /^(seat_name|node_logical_id|logical_id)$/, reason: "the seat part only, no `@rig` suffix" },
  { column: "tmux_window", reason: "tmux window index/name inside a session; no rig name" },
  { column: "tmux_pane", reason: "tmux pane id" },
  { column: "external_session_name", reason: "name of an externally claimed session; chosen by the owner of that session, not derived from the rig" },
  { table: "discovered_sessions", column: "tmux_session", reason: "tmux sessions found by discovery before any claim; external names, not rig-derived" },
  { column: "registered_pane", reason: "tmux pane id" },
  { column: /^resume_/, reason: "provider resume tokens and probe results; no rig name" },
  { table: "sessions", column: "origin", reason: "launch origin enum" },
  { table: "sessions", column: "restore_policy", reason: "policy enum" },
  { table: "sessions", column: "startup_status", reason: "status enum" },
  { table: "sessions", column: "startup_completed_at", reason: "timestamp" },
  { table: "nodes", column: "session_source_json", reason: "launch session source (paths and provider ids); no seat@rig reference" },
  { table: "nodes", column: "restore_policy", reason: "policy enum" },
  { column: /^(source_kind|source_ref|source_spec|source_hash|source_path)$/, reason: "provenance of a spec or package (file path or hash); the spec files are handled by the file side, hashes refresh on rescan" },
  { column: "evidence_source", reason: "evidence enum" },
  { column: "continuity_source", reason: "continuity enum" },
  { column: "source", reason: "sample source enum" },
  { column: /^(target_path|target_root|rig_root|install_root|rig_policy_declaring_dir|policy_declaring_dir)$/, reason: "filesystem path; moved by the file side or not owned by the rig name" },
  { column: /^(rig_policy_origin|rig_policy_resolved_target|rig_policy_launch_posture|policy_origin|policy_resolved_target|policy_launch_posture)$/, reason: "permission policy reference; not a rig name" },
  { column: /^(fallback_original_runtime|fallback_state)$/, reason: "runtime fallback state enum" },
  { column: "claimed_by_generation_uuid", reason: "generation UUID" },
  { column: /^(classification_destination|classifier_version)$/, reason: "classification output (a destination label, a version string), not a session address" },
  { column: "closure_required_at", reason: "timestamp" },
  { column: "target_repo", reason: "repository name, not a rig" },
  { column: /^owner_notification_(kind|level)$/, reason: "notification enums" },
  { column: "claimed_at", reason: "timestamp" },
  { column: /^(registered_at|last_seen_at|created_at|updated_at)$/, reason: "timestamp" },
  { column: /^(registered_by_generation_uuid|target_generation_uuid)$/, reason: "generation UUID" },
  { column: "hint_type", reason: "hint kind enum" },
  { column: "hint_urgency", reason: "urgency enum" },
  { column: "hint_tags", reason: "tags, not addresses" },
  { column: "evidence_ref", reason: "pointer to evidence, not an address" },
  { column: "audit_pointer", reason: "pointer to an audit record" },
  { column: "guard_binding", reason: "delivery guard binding id" },
  { column: "retirement_reason", reason: "free-text reason" },
  { table: "seat_identity_verdicts", column: "verdict", reason: "verdict enum" },
  { table: "thread_seat_map", column: "state", reason: "state enum" },
  { table: "events", column: "payload", reason: "append-only event history; kept as written (reported in the residue scan)" },
  { table: "queue_items", column: "body", reason: "message text; kept as written (reported in the residue scan)" },
  { table: "queue_items", column: "chain_of_record", reason: "historical provenance; kept as written" },
  { table: "inbox_entries", column: "body", reason: "message text; kept as written" },
  { table: "outbox_entries", column: "body", reason: "message text; kept as written" },
  { table: "stream_items", column: "body", reason: "message text; kept as written" },
  { table: "chat_messages", column: "body", reason: "message text; kept as written" },
  { table: "watchdog_history", column: "delivery_message", reason: "message text; kept as written" },
  { table: "watchdog_history", column: "evaluation_notes", reason: "log text; kept as written" },
];

/**
 * Columns the guard test inspects: every non-numeric column whose name matches this pattern must be
 * in the manifest or be excluded with a reason.
 */
export const RIG_RENAME_GUARD_PATTERN =
  /(rig|session|seat|actor|sender|destination|handed_off|closure_target|retired_by|previous_occupant|tmux|bound_|hint_dest|payload|body)/i;

/** Keys whose string value is a bare rig name inside JSON documents. */
export const RIG_NAME_JSON_KEYS: ReadonlySet<string> = new Set([
  "rig", "target_rig", "bound_rig", "rigName", "rig_name", "targetRig", "boundRig",
]);

// ---- name validation ------------------------------------------------------------------

const NEW_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_RIG_NAME_LENGTH = 64;

/**
 * Validates the NEW rig name. The character set is the one session names allow (a-z A-Z 0-9 - _ .)
 * minus `@`: the rig is everything after the first `@` of a session address, and the name becomes
 * a directory and file name, so path separators and `..` are refused.
 * Returns an error message, or null when the name is valid.
 */
export function validateNewRigName(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return "new rig name must be a non-empty string";
  if (name.length > MAX_RIG_NAME_LENGTH) return `new rig name must be at most ${MAX_RIG_NAME_LENGTH} characters`;
  if (name.includes("/") || name.includes("\\")) return "new rig name must not contain a path separator";
  if (name.includes("..")) return 'new rig name must not contain ".."';
  if (name.includes("@")) return 'new rig name must not contain "@" (it separates the seat from the rig in session names)';
  if (!NEW_NAME_PATTERN.test(name)) {
    return "new rig name may use letters, digits, '-', '_' and '.', and must start with a letter or digit";
  }
  return null;
}

// ---- pure rewrite helpers --------------------------------------------------------------

/**
 * Rewrites one `{seat}@{rig}` string. The part after the FIRST `@` must equal `from` exactly, and
 * the seat part must be non-empty. `x@old` changes; `x@old-2`, `old@x` and `a@b@old` do not.
 */
export function rewriteSessionRef(value: string, from: string, to: string): string {
  const at = value.indexOf("@");
  if (at < 1) return value;
  return value.slice(at + 1) === from ? `${value.slice(0, at + 1)}${to}` : value;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites `@{from}` inside free text (YAML, markdown). The rig name must end at a boundary: the
 * next character cannot continue a name (`A-Za-z0-9_@-`), and a `.` continues it only when a name
 * character follows (`@old.example` is another name; `see seat@old.` is the end of a sentence).
 * The text before `@` must be a seat character, so an e-mail-like `@old` at the start is left alone.
 */
export function rewriteSessionRefsInText(text: string, from: string, to: string): { text: string; count: number } {
  const re = new RegExp(`(?<=[A-Za-z0-9_.-])@${escapeRegExp(from)}(?![A-Za-z0-9_@-]|\\.[A-Za-z0-9_-])`, "g");
  let count = 0;
  const out = text.replace(re, () => {
    count += 1;
    return `@${to}`;
  });
  return { text: out, count };
}

/** Walks a parsed JSON value. Strings rewrite as session refs; rig-name keys rewrite when equal to `from`. */
export function rewriteJsonValue(value: unknown, from: string, to: string): { value: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown, keyName?: string): unknown => {
    if (typeof node === "string") {
      if (keyName !== undefined && RIG_NAME_JSON_KEYS.has(keyName) && node === from) {
        count += 1;
        return to;
      }
      const next = rewriteSessionRef(node, from, to);
      if (next !== node) count += 1;
      return next;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, keyName));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const nextKey = rewriteSessionRef(key, from, to);
        if (nextKey !== key) count += 1;
        out[nextKey] = walk(child, key);
      }
      return out;
    }
    return node;
  };
  const result = walk(value);
  return { value: result, count };
}

/** JSON text in, JSON text out. Text that does not parse falls back to the free-text rewrite. */
export function rewriteJsonText(text: string, from: string, to: string): { text: string; count: number } {
  try {
    const parsed = JSON.parse(text) as unknown;
    const { value, count } = rewriteJsonValue(parsed, from, to);
    return count === 0 ? { text, count: 0 } : { text: JSON.stringify(value), count };
  } catch {
    return rewriteSessionRefsInText(text, from, to);
  }
}
