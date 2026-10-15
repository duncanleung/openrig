// RIG-61: the database half of `rig rename`. One better-sqlite3 transaction rewrites every manifest
// column. Identifiers come from RIG_RENAME_MANIFEST only; user-supplied names are bound parameters.

import type Database from "better-sqlite3";
import { ACTIVE_QUEUE_STATES } from "./queue-repository.js";
import {
  RIG_RENAME_MANIFEST,
  rewriteJsonText,
  rewriteSessionRefsInText,
  type ManifestColumn,
} from "./rig-rename-manifest.js";

const IDENT = /^[a-z][a-z0-9_]*$/;

function quoted(identifier: string): string {
  if (!IDENT.test(identifier)) throw new Error(`rig-rename: refusing unsafe SQL identifier ${JSON.stringify(identifier)}`);
  return `"${identifier}"`;
}

/** SQL predicate: the column is `{seat}@{rig}` with a non-empty seat and the rig after the FIRST `@` equal to ?. */
function sessionPredicate(column: string): string {
  const c = quoted(column);
  return `(instr(${c}, '@') > 1 AND substr(${c}, instr(${c}, '@') + 1) = ?)`;
}

export interface ColumnImpact extends ManifestColumn {
  rows: number;
}

export class RigRenameDbError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function assertSchema(db: Database.Database): void {
  const have = new Map<string, Set<string>>();
  for (const m of RIG_RENAME_MANIFEST) {
    if (!have.has(m.table)) {
      const cols = db.prepare(`PRAGMA table_info(${quoted(m.table)})`).all() as Array<{ name: string }>;
      have.set(m.table, new Set(cols.map((c) => c.name)));
    }
    if (!have.get(m.table)!.has(m.column)) {
      throw new RigRenameDbError("manifest_schema_mismatch", `rig-rename manifest names ${m.table}.${m.column}, which is not in this database`);
    }
  }
}

function rewriteCell(kind: "json" | "text", value: string, from: string, to: string): { text: string; count: number } {
  return kind === "json" ? rewriteJsonText(value, from, to) : rewriteSessionRefsInText(value, from, to);
}

/** Rows of one manifest column that reference `name` (and would change in a rename away from it). */
export function countColumn(db: Database.Database, m: ManifestColumn, name: string, to = "\u0000renamed"): number {
  const t = quoted(m.table);
  const c = quoted(m.column);
  if (m.kind === "rig-name") {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`).get(name) as { n: number }).n;
  }
  if (m.kind === "session") {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${sessionPredicate(m.column)}`).get(name) as { n: number }).n;
  }
  let rows = 0;
  const cursor = db.prepare(`SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND instr(${c}, ?) > 0`).iterate(name) as IterableIterator<{ v: unknown }>;
  for (const row of cursor) {
    if (typeof row.v === "string" && rewriteCell(m.kind, row.v, name, to).count > 0) rows += 1;
  }
  return rows;
}

/** Per-column impact of renaming away from `name`. Only columns with rows > 0 are returned. */
export function planDbRename(db: Database.Database, name: string): ColumnImpact[] {
  assertSchema(db);
  const out: ColumnImpact[] = [];
  for (const m of RIG_RENAME_MANIFEST) {
    const rows = countColumn(db, m, name);
    if (rows > 0) out.push({ ...m, rows });
  }
  return out;
}

/**
 * Rows that already reference `name` as a rig. A rename TO that name is refused when any exist:
 * the compensating update (new -> old) would otherwise also rewrite them, and the rename could not
 * be reversed exactly.
 */
export function existingReferences(db: Database.Database, name: string): ColumnImpact[] {
  return planDbRename(db, name);
}

export interface DbBlockers {
  liveSessions: Array<{ sessionName: string; status: string }>;
  activeWorkflows: Array<{ instanceId: string; workflow: string; status: string }>;
  openQueueItems: Array<{ qitemId: string; state: string; source: string; destination: string }>;
  activeWatchdogJobs: Array<{ jobId: string; policy: string; target: string }>;
}

export const NON_LIVE_SESSION_STATUSES = ["exited", "superseded", "detached"] as const;
export const OPEN_WORKFLOW_STATUSES = ["active", "waiting"] as const;

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(",");

/** Quiescence facts for the rig(s) named `name`, read from the database. */
export function readDbBlockers(db: Database.Database, name: string): DbBlockers {
  const liveSessions = (db.prepare(
    `SELECT s.session_name AS sessionName, s.status AS status
       FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
      WHERE r.name = ? AND s.status NOT IN (${marks(NON_LIVE_SESSION_STATUSES.length)})
      ORDER BY s.session_name`,
  ).all(name, ...NON_LIVE_SESSION_STATUSES)) as DbBlockers["liveSessions"];

  const activeWorkflows = (db.prepare(
    `SELECT instance_id AS instanceId, workflow_name AS workflow, status
       FROM workflow_instances
      WHERE status IN (${marks(OPEN_WORKFLOW_STATUSES.length)})
        AND (bound_rig = ? OR ${sessionPredicate("created_by_session")})
      ORDER BY created_at`,
  ).all(...OPEN_WORKFLOW_STATUSES, name, name)) as DbBlockers["activeWorkflows"];

  const openQueueItems = (db.prepare(
    `SELECT qitem_id AS qitemId, state, source_session AS source, destination_session AS destination
       FROM queue_items
      WHERE state IN (${marks(ACTIVE_QUEUE_STATES.length)})
        AND (${sessionPredicate("source_session")} OR ${sessionPredicate("destination_session")} OR ${sessionPredicate("handed_off_to")})
      ORDER BY ts_created`,
  ).all(...ACTIVE_QUEUE_STATES, name, name, name)) as DbBlockers["openQueueItems"];

  const activeWatchdogJobs = (db.prepare(
    `SELECT job_id AS jobId, policy, target_session AS target
       FROM watchdog_jobs
      WHERE state = 'active' AND ${sessionPredicate("target_session")}
      ORDER BY job_id`,
  ).all(name)) as DbBlockers["activeWatchdogJobs"];

  return { liveSessions, activeWorkflows, openQueueItems, activeWatchdogJobs };
}

export function hasDbBlockers(b: DbBlockers): boolean {
  return b.liveSessions.length + b.activeWorkflows.length + b.openQueueItems.length + b.activeWatchdogJobs.length > 0;
}

export interface DbRenameResult {
  rowsChanged: number;
  columns: ColumnImpact[];
}

/**
 * Rewrites every manifest column from `from` to `to` in ONE transaction. The quiescence check runs
 * again inside the transaction (rename only), so a seat that started after the pre-check cannot
 * slip through. Any error rolls the whole transaction back.
 *
 * `recheckQuiescence` is false for the compensating call (to -> from), which must always be allowed.
 */
export function applyDbRename(
  db: Database.Database,
  from: string,
  to: string,
  opts: { recheckQuiescence: boolean },
): DbRenameResult {
  assertSchema(db);
  const run = db.transaction((): DbRenameResult => {
    if (opts.recheckQuiescence) {
      const blockers = readDbBlockers(db, from);
      if (hasDbBlockers(blockers)) {
        throw new RigRenameDbError("not_quiescent", "the rig became active during the rename; nothing was changed");
      }
    }
    const columns: ColumnImpact[] = [];
    let rowsChanged = 0;
    for (const m of RIG_RENAME_MANIFEST) {
      const t = quoted(m.table);
      const c = quoted(m.column);
      let changed = 0;
      if (m.kind === "rig-name") {
        // `rigs` also gets a fresh updated_at; every other table has no such column to touch.
        const extra = m.table === "rigs" ? ", updated_at = datetime('now')" : "";
        changed = db.prepare(`UPDATE ${t} SET ${c} = ?${extra} WHERE ${c} = ?`).run(to, from).changes;
      } else if (m.kind === "session") {
        changed = db.prepare(
          `UPDATE ${t} SET ${c} = substr(${c}, 1, instr(${c}, '@')) || ? WHERE ${sessionPredicate(m.column)}`,
        ).run(to, from).changes;
      } else {
        const update = db.prepare(`UPDATE ${t} SET ${c} = ? WHERE rowid = ?`);
        const rows = db.prepare(
          `SELECT rowid AS rid, ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND instr(${c}, ?) > 0`,
        ).all(from) as Array<{ rid: number; v: unknown }>;
        for (const row of rows) {
          if (typeof row.v !== "string") continue;
          const next = rewriteCell(m.kind, row.v, from, to);
          if (next.count === 0) continue;
          update.run(next.text, row.rid);
          changed += 1;
        }
      }
      if (changed > 0) {
        columns.push({ ...m, rows: changed });
        rowsChanged += changed;
      }
    }
    return { rowsChanged, columns };
  });
  return run();
}

/** Ids of the rigs (active and archived) named `name`. */
export function rigsNamed(db: Database.Database, name: string): Array<{ id: string; archived: boolean }> {
  return (db.prepare("SELECT id, archived_at AS archivedAt FROM rigs WHERE name = ? ORDER BY created_at").all(name) as Array<{ id: string; archivedAt: string | null }>)
    .map((r) => ({ id: r.id, archived: r.archivedAt !== null }));
}

/** Session names of the rig(s) named `name`, from the sessions table. Used for the tmux liveness probe. */
export function sessionNamesOfRig(db: Database.Database, name: string): string[] {
  return (db.prepare(
    `SELECT DISTINCT s.session_name AS n FROM sessions s JOIN nodes nd ON nd.id = s.node_id JOIN rigs r ON r.id = nd.rig_id
      WHERE r.name = ? AND s.session_name IS NOT NULL`,
  ).all(name) as Array<{ n: string }>).map((r) => r.n);
}
