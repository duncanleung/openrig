// RIG-61: `rig rename`. Renames a rig in the database and under OPENRIG_HOME.
//
// Order: validate -> pre-check -> journal -> DB transaction -> file ops (journaled) -> verify.
//   * DB first, because it is atomic and rolls back by itself. Nothing on disk is touched until it commits.
//   * A file failure rolls the files back in reverse, then runs the same manifest new -> old inside
//     one transaction. If either step fails the journal is kept and the error states exactly what is
//     left (see docs/reference/rig-rename.md, "Recovery").
//   * The rig must be quiescent. Live sessions are never renamed (tmux names stay as they are).
// The service owns the file side as well as the database side so the CLI stays a thin client and
// OPENRIG_HOME is resolved in one place, the daemon.

import type Database from "better-sqlite3";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import {
  applyDbRename,
  existingReferences,
  otherRigNames,
  planDbRename,
  readDbBlockers,
  rigsNamed,
  sessionNamesOfRig,
  type ColumnImpact,
} from "./rig-rename-db.js";
import {
  applyOps,
  buildFilePlan,
  findNameArtifacts,
  journalPaths,
  newJournal,
  nodeRenameFs,
  readJournal,
  removeJournal,
  rollbackOps,
  scanResidue,
  verifyOps,
  writeJournal,
  type FilePlan,
  type Journal,
  type PlannedOp,
  type RenameFs,
  type ResidueHit,
} from "./rig-rename-files.js";
import type { SessionProbe } from "../adapters/tmux.js";
import { validateNewRigName } from "./rig-rename-manifest.js";

export type BlockerCode =
  | "rename_in_progress"
  | "journal_present"
  | "name_collision_rig"
  | "name_collision_files"
  | "new_name_in_history"
  | "live_sessions"
  | "live_tmux_sessions"
  | "tmux_unconfirmed"
  | "active_workflows"
  | "open_queue_items"
  | "active_watchdog_jobs";

export interface Blocker {
  code: BlockerCode;
  message: string;
  items?: string[];
}

export interface RigRenameReport {
  oldName: string;
  newName: string;
  dryRun: boolean;
  applied: boolean;
  rigs: Array<{ id: string; archived: boolean }>;
  blockers: Blocker[];
  db: { rows: number; columns: ColumnImpact[] };
  files: { ops: Array<Omit<PlannedOp, "content">>; skipped: FilePlan["skipped"] };
  residue?: ResidueHit[];
}

export class RigRenameInvalidError extends Error {}
export class RigRenameNotFoundError extends Error {}

/** The rename failed and everything was restored. Nothing changed. */
export class RigRenameRolledBackError extends Error {
  constructor(readonly stage: "db" | "files" | "verify", message: string) {
    super(message);
  }
}

/** The rename failed and could not be fully undone. The journal is kept. */
export class RigRenameRecoveryError extends Error {
  constructor(message: string, readonly journalPath: string, readonly state: { database: string; files: string }) {
    super(message);
  }
}

export interface RigRenameDeps {
  db: Database.Database;
  /** OPENRIG_HOME. */
  openrigHome: string;
  /** Where user spec files live. Default: `<home>/specs`. */
  specRoots?: string[];
  /** Directories the rename must never edit (built-in specs shipped with the daemon). */
  protectedRoots?: string[];
  /** tmux probe (TmuxAdapter.probeSession). Absence must be proven: a probe error or an unconfirmed answer blocks the rename. */
  probeSession?: (sessionName: string) => Promise<SessionProbe>;
  fs?: RenameFs;
  /** Test seam: runs right after the database transaction commits and before any file changes. */
  hooks?: { afterDbCommit?: () => void };
  now?: () => Date;
  newId?: () => string;
}

/** tmux answers that prove no server, so no session, exists. Anything else (permission denied, ...) proves nothing. */
const TMUX_NO_SERVER = /no server running|error connecting to .*\((No such file or directory|Connection refused)\)/i;

const LIST_LIMIT = 20;
const brief = (items: string[]): string[] =>
  items.length > LIST_LIMIT ? [...items.slice(0, LIST_LIMIT), `... and ${items.length - LIST_LIMIT} more`] : items;

export class RigRenameService {
  private readonly fs: RenameFs;
  private readonly specRoots: string[];
  private readonly protectedRoots: string[];
  private inFlight = false;

  constructor(private readonly deps: RigRenameDeps) {
    this.fs = deps.fs ?? nodeRenameFs;
    this.specRoots = deps.specRoots ?? [nodePath.join(deps.openrigHome, "specs")];
    this.protectedRoots = deps.protectedRoots ?? [];
  }

  /** Current journal, or null. A journal means a rename did not finish. */
  journal(): Journal | null {
    return readJournal(this.fs, this.deps.openrigHome);
  }

  isRunning(): boolean {
    return this.inFlight;
  }

  async rename(oldName: string, newName: string, opts: { dryRun: boolean }): Promise<RigRenameReport> {
    if (typeof oldName !== "string" || oldName.length === 0) throw new RigRenameInvalidError("old rig name must be a non-empty string");
    const nameError = validateNewRigName(newName);
    if (nameError) throw new RigRenameInvalidError(nameError);
    if (oldName === newName) throw new RigRenameInvalidError("new rig name is the same as the old name");

    if (this.inFlight) {
      return this.emptyReport(oldName, newName, opts.dryRun, [{
        code: "rename_in_progress",
        message: "Another rig rename is running in this daemon. Wait for it to finish.",
      }]);
    }
    this.inFlight = true;
    try {
      return await this.run(oldName, newName, opts.dryRun);
    } finally {
      this.inFlight = false;
    }
  }

  private emptyReport(oldName: string, newName: string, dryRun: boolean, blockers: Blocker[]): RigRenameReport {
    return { oldName, newName, dryRun, applied: false, rigs: [], blockers, db: { rows: 0, columns: [] }, files: { ops: [], skipped: [] } };
  }

  private planContext(oldName: string, newName: string) {
    const { db, openrigHome } = this.deps;
    const like = `@${oldName}`;
    const rows = db.prepare(
      `SELECT DISTINCT source_path AS p FROM workflow_specs
        WHERE source_path IS NOT NULL AND source_path != ''
          AND (target_rig = ? OR instr(roles_json, ?) > 0 OR instr(steps_json, ?) > 0 OR instr(COALESCE(spec_json, ''), ?) > 0)`,
    ).all(oldName, like, like, like) as Array<{ p: string }>;
    return {
      home: openrigHome,
      specRoots: this.specRoots,
      protectedRoots: this.protectedRoots,
      workflowSourcePaths: rows.map((r) => r.p).filter((p) => nodePath.isAbsolute(p)),
      otherRigNames: otherRigNames(db, oldName),
      from: oldName,
      to: newName,
    };
  }

  private async preCheck(oldName: string, newName: string): Promise<Blocker[]> {
    const { db, openrigHome } = this.deps;
    const blockers: Blocker[] = [];

    const clash = rigsNamed(db, newName);
    if (clash.length > 0) {
      blockers.push({
        code: "name_collision_rig",
        message: `A rig named "${newName}" already exists (active or archived).`,
        items: clash.map((r) => `${r.id}${r.archived ? " (archived)" : ""}`),
      });
    }
    const history = existingReferences(db, newName);
    if (history.length > 0 && clash.length === 0) {
      blockers.push({
        code: "new_name_in_history",
        message:
          `Rows in the database already refer to "${newName}" (a rig that was deleted earlier). ` +
          `The rename could not be reversed exactly, so it is refused.`,
        items: brief(history.map((h) => `${h.table}.${h.column}: ${h.rows} row(s)`)),
      });
    }
    const artifacts = findNameArtifacts(this.fs, { home: openrigHome, specRoots: this.specRoots, protectedRoots: this.protectedRoots, workflowSourcePaths: [], otherRigNames: otherRigNames(db, newName), name: newName });
    if (artifacts.length > 0) {
      blockers.push({
        code: "name_collision_files",
        message: `Files or directories for "${newName}" already exist.`,
        items: brief(artifacts),
      });
    }

    const q = readDbBlockers(db, oldName);
    if (q.liveSessions.length > 0) {
      blockers.push({
        code: "live_sessions",
        message: `The rig has live sessions. Stop it first with 'rig down ${oldName}'. Live sessions are never renamed.`,
        items: brief(q.liveSessions.map((s) => `${s.sessionName} (${s.status})`)),
      });
    }
    if (this.deps.probeSession) {
      const alive: string[] = [];
      const unconfirmed: string[] = [];
      for (const name of sessionNamesOfRig(db, oldName)) {
        try {
          const probe = await this.deps.probeSession(name);
          if (probe.state === "present") alive.push(name);
          // No tmux server proves no session exists; any other transport trouble proves nothing.
          else if (probe.state === "transport_unavailable" && !TMUX_NO_SERVER.test(probe.cause)) unconfirmed.push(`${name}: ${probe.cause}`);
        } catch (err) {
          unconfirmed.push(`${name}: ${errMessage(err)}`);
        }
      }
      if (alive.length > 0) {
        blockers.push({
          code: "live_tmux_sessions",
          message: `tmux sessions of the rig still exist. Stop them first with 'rig down ${oldName}'.`,
          items: brief(alive),
        });
      }
      if (unconfirmed.length > 0) {
        blockers.push({
          code: "tmux_unconfirmed",
          message: "Could not confirm that the rig's tmux sessions are gone. Fix tmux access and retry.",
          items: brief(unconfirmed),
        });
      }
    }
    if (q.activeWorkflows.length > 0) {
      blockers.push({
        code: "active_workflows",
        message: "Workflow instances for the rig are still open (status active or waiting).",
        items: brief(q.activeWorkflows.map((w) => `${w.instanceId} ${w.workflow} (${w.status})`)),
      });
    }
    if (q.openQueueItems.length > 0) {
      blockers.push({
        code: "open_queue_items",
        message: "Queue items for the rig are still open (state pending, in-progress or blocked). Close or hand them off first.",
        items: brief(q.openQueueItems.map((i) => `${i.qitemId} ${i.state} ${i.source} -> ${i.destination}`)),
      });
    }
    if (q.activeWatchdogJobs.length > 0) {
      blockers.push({
        code: "active_watchdog_jobs",
        message: "Watchdog jobs that target the rig are active. Stop them first.",
        items: brief(q.activeWatchdogJobs.map((j) => `${j.jobId} ${j.policy} -> ${j.target}`)),
      });
    }
    return blockers;
  }

  private async run(oldName: string, newName: string, dryRun: boolean): Promise<RigRenameReport> {
    const { db, openrigHome } = this.deps;
    // An unfinished rename comes first: it may have left the database under the new name.
    const unfinished = this.journal();
    if (unfinished) {
      return this.emptyReport(oldName, newName, dryRun, [{
        code: "journal_present",
        message:
          `A previous rename (${unfinished.oldName} -> ${unfinished.newName}, phase "${unfinished.phase}") did not finish. ` +
          `Its journal is at ${journalPaths(openrigHome).file}. Run 'rig rename --recover' to roll it back, or read the journal first.`,
      }]);
    }
    const rigs = rigsNamed(db, oldName);
    if (rigs.length === 0) throw new RigRenameNotFoundError(`no rig named "${oldName}"`);

    const blockers = await this.preCheck(oldName, newName);
    const dbPlan = planDbRename(db, oldName);
    const filePlan = buildFilePlan(this.fs, this.planContext(oldName, newName));
    for (const op of filePlan.ops) {
      if (op.kind === "rename" && op.to && this.fs.exists(op.to) && !blockers.some((b) => b.items?.includes(op.to!))) {
        const existing = blockers.find((b) => b.code === "name_collision_files");
        if (existing) existing.items = brief([...(existing.items ?? []), op.to]);
        else blockers.push({ code: "name_collision_files", message: `Files or directories for "${newName}" already exist.`, items: [op.to] });
      }
    }

    const report: RigRenameReport = {
      oldName, newName, dryRun, applied: false, rigs, blockers,
      db: { rows: dbPlan.reduce((n, c) => n + c.rows, 0), columns: dbPlan },
      files: { ops: filePlan.ops.map(({ content: _content, ...rest }) => rest), skipped: filePlan.skipped },
    };
    if (dryRun || blockers.length > 0) return report;

    // ---- apply ----
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const journal = newJournal(openrigHome, oldName, newName, filePlan, (this.deps.newId ?? randomUUID)(), now);
    writeJournal(this.fs, openrigHome, journal);

    try {
      applyDbRename(db, oldName, newName, { recheckQuiescence: true });
    } catch (err) {
      // The transaction rolled back by itself and no file was touched.
      removeJournal(this.fs, openrigHome);
      throw new RigRenameRolledBackError("db", `database rename failed and was rolled back: ${errMessage(err)}`);
    }

    try {
      journal.phase = "db-committed";
      writeJournal(this.fs, openrigHome, journal);
      this.deps.hooks?.afterDbCommit?.();
      applyOps(this.fs, openrigHome, journal, filePlan);
      const leftover = planDbRename(db, oldName);
      if (leftover.length > 0) {
        throw new VerifyError(`database still refers to "${oldName}": ${leftover.map((c) => `${c.table}.${c.column}`).join(", ")}`);
      }
      const problems = verifyOps(this.fs, journal);
      if (problems.length > 0) throw new VerifyError(problems.join("; "));
      journal.phase = "files-applied";
      writeJournal(this.fs, openrigHome, journal);
    } catch (err) {
      throw this.unwind(journal, oldName, newName, err);
    }

    removeJournal(this.fs, openrigHome);
    return { ...report, applied: true, residue: scanResidue(this.fs, openrigHome, oldName) };
  }

  /** Undo after a failure past the DB commit. Returns the error to throw. */
  private unwind(journal: Journal, oldName: string, newName: string, cause: unknown): Error {
    const { db, openrigHome } = this.deps;
    const journalFile = journalPaths(openrigHome).file;
    const stage = cause instanceof VerifyError ? "verify" : "files";
    journal.phase = "rolling-back";
    journal.error = errMessage(cause);
    try { writeJournal(this.fs, openrigHome, journal); } catch { /* the in-memory journal still drives the rollback */ }

    const failures = rollbackOps(this.fs, openrigHome, journal);
    if (failures.length > 0) {
      journal.phase = "rollback-failed";
      journal.error = `${errMessage(cause)}; rollback failed: ${failures.map((f) => `${f.op}: ${f.error}`).join("; ")}`;
      try { writeJournal(this.fs, openrigHome, journal); } catch { /* reported below */ }
      return new RigRenameRecoveryError(
        `Rename ${oldName} -> ${newName} failed (${errMessage(cause)}) and the files could not be fully restored. ` +
        `The database was NOT reverted and still uses "${newName}". Journal kept at ${journalFile}. ` +
        `Fix the cause, then run 'rig rename --recover'.`,
        journalFile,
        { database: `renamed to "${newName}"`, files: `${failures.length} undo step(s) failed: ${failures.map((f) => f.op).join("; ")}` },
      );
    }

    try {
      applyDbRename(db, newName, oldName, { recheckQuiescence: false });
    } catch (err) {
      journal.phase = "compensation-failed";
      journal.error = `${errMessage(cause)}; database compensation failed: ${errMessage(err)}`;
      try { writeJournal(this.fs, openrigHome, journal); } catch { /* reported below */ }
      return new RigRenameRecoveryError(
        `Rename ${oldName} -> ${newName} failed (${errMessage(cause)}). The files were restored but the database could NOT be reverted (${errMessage(err)}). ` +
        `The database still uses "${newName}". Journal kept at ${journalFile}. ` +
        `Run 'rig rename --recover', or revert by hand: rename every manifest column from "${newName}" back to "${oldName}" (docs/reference/rig-rename.md).`,
        journalFile,
        { database: `still renamed to "${newName}"`, files: "restored to the old names" },
      );
    }

    removeJournal(this.fs, openrigHome);
    return new RigRenameRolledBackError(stage, `rename failed during ${stage} step and was fully rolled back: ${errMessage(cause)}`);
  }

  /**
   * Finishes or undoes a rename that did not complete: rolls the files back from the journal, then
   * reverses the database if it was renamed. Safe to run more than once.
   */
  async recover(): Promise<{ recovered: boolean; message: string }> {
    if (this.inFlight) throw new RigRenameInvalidError("a rename is running in this daemon");
    this.inFlight = true;
    try {
      const { db, openrigHome } = this.deps;
      const journal = this.journal();
      if (!journal) return { recovered: false, message: "No rename journal found. Nothing to recover." };
      if (journal.id === "unreadable") {
        throw new RigRenameRecoveryError(journal.error ?? "journal unreadable", journalPaths(openrigHome).file, { database: "unknown", files: "unknown" });
      }
      const failures = rollbackOps(this.fs, openrigHome, journal);
      if (failures.length > 0) {
        throw new RigRenameRecoveryError(
          `Recovery could not restore every file: ${failures.map((f) => `${f.op}: ${f.error}`).join("; ")}`,
          journalPaths(openrigHome).file,
          { database: "unchanged by this recovery", files: `${failures.length} undo step(s) failed` },
        );
      }
      const renamedRigs = rigsNamed(db, journal.newName).length;
      const originalRigs = rigsNamed(db, journal.oldName).length;
      if (renamedRigs > 0 && originalRigs === 0) {
        try {
          applyDbRename(db, journal.newName, journal.oldName, { recheckQuiescence: false });
        } catch (err) {
          throw new RigRenameRecoveryError(
            `Files restored, but the database could not be reverted: ${errMessage(err)}`,
            journalPaths(openrigHome).file,
            { database: `still renamed to "${journal.newName}"`, files: "restored to the old names" },
          );
        }
      }
      removeJournal(this.fs, openrigHome);
      return { recovered: true, message: `Rolled back the unfinished rename ${journal.oldName} -> ${journal.newName}. The rig keeps the name "${journal.oldName}".` };
    } finally {
      this.inFlight = false;
    }
  }
}

class VerifyError extends Error {}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
