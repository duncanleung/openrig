import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig rename <old> <new>` (RIG-61). Backs `POST /api/rigs/:name/rename`.
 * The daemon renames the rig in its database (one transaction) and then under OPENRIG_HOME
 * (journaled, undone in reverse on failure). This command only asks, prints the plan, and reports.
 * Without --yes it prints the plan and changes nothing. See docs/reference/rig-rename.md.
 */

export interface RenameBlocker { code: string; message: string; items?: string[] }

export interface RenameReport {
  oldName: string;
  newName: string;
  dryRun: boolean;
  applied: boolean;
  rigs: Array<{ id: string; archived: boolean }>;
  blockers: RenameBlocker[];
  db: { rows: number; columns: Array<{ table: string; column: string; kind: string; rows: number }> };
  files: {
    ops: Array<{ surface: string; kind: "write" | "rename"; path?: string; from?: string; to?: string; detail: string }>;
    skipped: Array<{ path: string; reason: string }>;
  };
  residue?: Array<{ path: string; where: "name" | "content"; count: number }>;
}

const MAX_LISTED = 25;

function listed<T>(items: T[], line: (item: T) => string): string[] {
  const out = items.slice(0, MAX_LISTED).map(line);
  if (items.length > MAX_LISTED) out.push(`    ... and ${items.length - MAX_LISTED} more`);
  return out;
}

export function renderBlockers(blockers: RenameBlocker[]): string[] {
  const lines: string[] = [];
  for (const b of blockers) {
    lines.push(`  blocked: ${b.message} [${b.code}]`);
    for (const item of b.items ?? []) lines.push(`    - ${item}`);
  }
  return lines;
}

export function renderRenameReport(r: RenameReport): string[] {
  const lines: string[] = [];
  const verb = r.applied ? "Renamed" : "Plan to rename";
  lines.push(`${verb} rig ${r.oldName} -> ${r.newName} (${r.rigs.length} rig row(s))`);
  if (r.blockers.length > 0) {
    lines.push("", "The rename is refused:", ...renderBlockers(r.blockers));
    return lines;
  }
  lines.push(
    "",
    `Database: ${r.db.rows} row(s) in ${r.db.columns.length} column(s), one transaction`,
    ...listed(r.db.columns, (c) => `  ${c.table}.${c.column}: ${c.rows}`),
  );
  const writes = r.files.ops.filter((o) => o.kind === "write");
  const renames = r.files.ops.filter((o) => o.kind === "rename");
  lines.push(
    "",
    `Files: ${writes.length} rewrite(s), ${renames.length} rename(s)`,
    ...listed(writes, (o) => `  rewrite ${o.path}  (${o.detail})`),
    ...listed(renames, (o) => `  rename  ${o.from} -> ${o.to}`),
  );
  if (r.files.skipped.length > 0) lines.push("", "Skipped:", ...listed(r.files.skipped, (s) => `  ${s.path}: ${s.reason}`));
  lines.push("", "Not renamed: live sessions and tmux names, transcript text, message bodies and event history.");
  if (r.applied) {
    const residue = r.residue ?? [];
    lines.push("", residue.length === 0
      ? `Residue scan: no remaining references to ${r.oldName} in the state directories.`
      : `Residue scan: ${residue.length} remaining reference(s) to ${r.oldName} (not rewritten):`);
    lines.push(...listed(residue, (h) => `  ${h.where}: ${h.path}${h.where === "content" ? ` (${h.count})` : ""}`));
  } else {
    lines.push("", r.dryRun ? "Dry run: nothing was changed. Re-run with --yes to apply." : "Nothing was changed.");
  }
  return lines;
}

interface ErrorBody { error?: string; message?: string; stage?: string; journal?: string; state?: { database: string; files: string } }

export async function runRename(
  deps: StatusDeps,
  oldName: string,
  newName: string,
  opts: { yes: boolean; dryRun: boolean; json: boolean },
): Promise<void> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return;
  const client = deps.clientFactory(getDaemonUrl(status));
  const dryRun = opts.dryRun || !opts.yes;
  const res = await client.post<RenameReport | ErrorBody>(
    `/api/rigs/${encodeURIComponent(oldName)}/rename`,
    { newName, dryRun },
    { timeoutMs: 120_000 },
  );

  if (opts.json) {
    console.log(JSON.stringify(res.data));
    if (res.status >= 500) process.exitCode = 2;
    else if (res.status >= 400) process.exitCode = 1;
    return;
  }
  if (res.status === 200 || res.status === 409) {
    const report = res.data as RenameReport;
    for (const line of renderRenameReport(report)) console.log(line);
    if (report.blockers.length > 0) process.exitCode = 1;
    return;
  }
  printError(res.status, res.data as ErrorBody);
}

function printError(status: number, body: ErrorBody): void {
  console.error(`rig rename failed: ${body.message ?? body.error ?? `HTTP ${status}`}`);
  if (body.error === "rename_failed_rolled_back") console.error(`The ${body.stage ?? "rename"} step failed and everything was restored. Nothing changed.`);
  if (body.error === "rename_recovery_required") {
    console.error("Manual attention is required. The rename did NOT finish and was NOT fully undone.");
    if (body.state) console.error(`  database: ${body.state.database}\n  files:    ${body.state.files}`);
    if (body.journal) console.error(`  journal:  ${body.journal}`);
    console.error("Run 'rig rename --recover' after fixing the cause.");
  }
  process.exitCode = status >= 500 ? 2 : 1;
}

export async function runRecover(deps: StatusDeps, json: boolean): Promise<void> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return;
  const client = deps.clientFactory(getDaemonUrl(status));
  const res = await client.post<{ recovered: boolean; message: string } | ErrorBody>("/api/rig-rename/recover", undefined, { timeoutMs: 120_000 });
  if (json) {
    console.log(JSON.stringify(res.data));
    if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
    return;
  }
  if (res.status >= 400) return printError(res.status, res.data as ErrorBody);
  console.log((res.data as { message: string }).message);
}

export function renameCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("rename").description(
    "Rename a stopped rig in the database and under OPENRIG_HOME. Prints the plan; --yes applies it.",
  );
  const getDeps = (): StatusDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("[old]", "Current rig name")
    .argument("[new]", "New rig name (letters, digits, '-', '_', '.')")
    .option("--yes", "Apply the rename (default: print the plan only)")
    .option("--dry-run", "Print the plan and change nothing (the default; wins over --yes)")
    .option("--recover", "Roll back a rename that did not finish, using its journal")
    .option("--json", "JSON output for agents")
    .action(async (oldName: string | undefined, newName: string | undefined, opts: { yes?: boolean; dryRun?: boolean; recover?: boolean; json?: boolean }) => {
      const deps = getDeps();
      if (opts.recover) return runRecover(deps, opts.json ?? false);
      if (!oldName || !newName) {
        console.error("usage: rig rename <old> <new> [--yes] [--dry-run] [--json]   |   rig rename --recover");
        process.exitCode = 1;
        return;
      }
      await runRename(deps, oldName, newName, { yes: opts.yes ?? false, dryRun: opts.dryRun ?? false, json: opts.json ?? false });
    });
  return cmd;
}
