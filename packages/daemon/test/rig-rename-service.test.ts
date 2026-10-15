import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import {
  RigRenameInvalidError,
  RigRenameNotFoundError,
  RigRenameRecoveryError,
  RigRenameRolledBackError,
  RigRenameService,
  type RigRenameDeps,
} from "../src/domain/rig-rename-service.js";
import { journalPaths, nodeRenameFs, type RenameFs } from "../src/domain/rig-rename-files.js";
import { RIG_RENAME_MANIFEST } from "../src/domain/rig-rename-manifest.js";

// RIG-61 — every test uses a temp OPENRIG_HOME and a temp sqlite file. Nothing here reads or writes
// the real ~/.openrig or the daemon's database.

const OLD = "poly-copy";
const NEW = "prediction-market";

let home: string;
let db: Database.Database;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rig-rename-")));
  db = createDb(path.join(home, "test.sqlite"));
  migrate(db, ALL_MIGRATIONS);
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- fixtures ---------------------------------------------------------------------------------

let seq = 0;
const uid = (p: string): string => `${p}-${++seq}`;

function seedRig(name: string, opts: { sessionStatus?: string; archived?: boolean } = {}): { rigId: string; nodeId: string } {
  const rigId = uid("rig");
  const nodeId = uid("node");
  db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES (?, ?, ?)").run(rigId, name, opts.archived ? "2026-01-01" : null);
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(nodeId, rigId, "orch-lead");
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)")
    .run(uid("sess"), nodeId, `orch-lead@${name}`, opts.sessionStatus ?? "exited");
  return { rigId, nodeId };
}

/** Values for columns that would otherwise trip a quiescence blocker or a CHECK. */
const SAFE_VALUES: Record<string, string | number> = {
  "queue_items.state": "done",
  "workflow_instances.status": "completed",
  "watchdog_jobs.state": "stopped",
  "usage_samples.lane": "context",
  "classification_attempts.status": "written",
  "context_usage.runtime": "claude-code",
  "node_startup_context.runtime": "claude-code",
};

/** One row per table, holding a value in each manifest column in that column's shape, so every column is proved. */
function seedEveryManifestColumn(oldName: string): void {
  db.pragma("foreign_keys = OFF");
  const byTable = new Map<string, typeof RIG_RENAME_MANIFEST[number][]>();
  for (const m of RIG_RENAME_MANIFEST) {
    if (m.table === "rigs") continue; // seedRig covers rigs.name with real rows
    byTable.set(m.table, [...(byTable.get(m.table) ?? []), m]);
  }
  for (const [table, entries] of byTable) {
    const info = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
    const manifestValue = (m: typeof RIG_RENAME_MANIFEST[number]): string =>
      m.kind === "rig-name" ? oldName
        : m.kind === "session" ? `seat-${m.column}@${oldName}`
        : m.kind === "json" ? JSON.stringify({ rig: oldName, target: `seat@${oldName}`, keep: `seat@${oldName}-2` })
        : `target: seat@${oldName}\nother: seat@${oldName}-2\n`;
    const cols: string[] = [];
    const vals: Array<string | number> = [];
    for (const c of info) {
      const entry = entries.find((e) => e.column === c.name);
      const safe = SAFE_VALUES[`${table}.${c.name}`] ?? (c.name === "runtime" ? "claude-code" : undefined);
      if (entry) { cols.push(c.name); vals.push(manifestValue(entry)); continue; }
      if (safe !== undefined) { cols.push(c.name); vals.push(safe); continue; }
      if (c.notnull === 1 && c.dflt_value === null) {
        cols.push(c.name);
        vals.push(/INT|REAL|NUM/i.test(c.type) ? 1 : uid(`${table}-${c.name}`));
      } else if (c.pk > 0) {
        cols.push(c.name);
        vals.push(/INT|REAL|NUM/i.test(c.type) ? ++seq + 100000 : uid(`${table}-${c.name}`));
      }
    }
    db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
  }
  db.pragma("foreign_keys = ON");
}

function write(rel: string, content: string): string {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const read = (rel: string): string => fs.readFileSync(path.join(home, rel), "utf-8");
const exists = (rel: string): boolean => fs.existsSync(path.join(home, rel));

const RIG_SPEC = `# keep this comment
version: "0.2"
name: ${OLD}   # trailing comment
summary: >
  hand off to orch-lead@${OLD}, not orch-lead@${OLD}-2
pods:
  - id: orch
`;
const WORKFLOW = `# ticket factory
workflow:
  id: ticket-factory
  target:
    rig: ${OLD}   # the rig
  roles:
    lead:
      preferred_targets: [orch-lead@${OLD}, other@${OLD}-2]
`;

function seedFiles(): void {
  write(`specs/${OLD}/rig.yaml`, RIG_SPEC);
  write("specs/workflows/ticket-factory.yaml", WORKFLOW);
  write(`topology/rigs/${OLD}/RIG.md`, `Seats: orch-lead@${OLD}\n`);
  write(`state/provider-usage/1b9d6bcd-bbfd-4b2d-9b5d-000000000001.json`, JSON.stringify({ session: `orch-lead@${OLD}`, rigName: OLD, other: `x@${OLD}-2` }, null, 2) + "\n");
  write(`state/provider-usage/orch-lead@${OLD}.json`, JSON.stringify({ seat: `orch-lead@${OLD}` }));
  write(`state/provider-usage/other@other-rig.json`, JSON.stringify({ seat: "other@other-rig" }));
  write(`state/context-usage/1b9d6bcd-bbfd-4b2d-9b5d-000000000002.json`, JSON.stringify({ sessionName: `orch-lead@${OLD}`, used: 5 }));
  write(`compaction/restore-pending/orch-lead@${OLD}.json`, JSON.stringify({ seat: `orch-lead@${OLD}` }));
  write(`transcripts/${OLD}/orch-lead@${OLD}.log`, `history mentions orch-lead@${OLD} and stays\n`);
  write(`logs/orch-lead@${OLD}.log`, "log\n");
  write(`refocus/${OLD}/note.md`, `refocus orch-lead@${OLD}\n`);
  write(`prompts/orch-lead@${OLD}.md`, `prompt for orch-lead@${OLD}\n`);
}

function seedWorkflowSpecRow(sourcePath: string): void {
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO workflow_specs (spec_id, name, version, target_rig, roles_json, steps_json, source_path, source_hash, cached_at)
     VALUES (?, 'ticket-factory', '1', ?, ?, '[]', ?, 'h', datetime('now'))`,
  ).run(uid("spec"), OLD, JSON.stringify({ lead: { preferred_targets: [`orch-lead@${OLD}`] } }), sourcePath);
  db.pragma("foreign_keys = ON");
}

function makeService(extra: Partial<RigRenameDeps> = {}): RigRenameService {
  return new RigRenameService({ db, openrigHome: home, specRoots: [path.join(home, "specs")], ...extra });
}

function dumpDb(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return JSON.stringify(tables.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]));
}

function snapshotTree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(home, full);
      // The journal directory is daemon-owned and may remain empty after a clean rollback.
      if (rel.startsWith("test.sqlite") || rel === "run") continue;
      if (e.isDirectory()) { out[`${rel}/`] = "dir"; walk(full); }
      else out[rel] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(home);
  return out;
}

/** An fs that fails on a chosen call; everything else is the real filesystem. */
function flakyFs(opts: { failRename?: (from: string, to: string, n: number) => boolean; failWrite?: (p: string, n: number) => boolean }): RenameFs {
  let renames = 0;
  let writes = 0;
  return {
    ...nodeRenameFs,
    rename: (a, b) => {
      renames += 1;
      if (opts.failRename?.(a, b, renames)) throw new Error(`injected rename failure ${a} -> ${b}`);
      nodeRenameFs.rename(a, b);
    },
    writeText: (p, c, m) => {
      // The journal and its backups are never the injected failure; the planned file edits are.
      if (!p.includes(`${path.sep}run${path.sep}`)) {
        writes += 1;
        if (opts.failWrite?.(p, writes)) throw new Error(`injected write failure ${p}`);
      }
      nodeRenameFs.writeText(p, c, m);
    },
  };
}

// ---- tests ------------------------------------------------------------------------------------

describe("rig rename: full rename on a fixture (RIG-61)", () => {
  it("rewrites every manifest column, leaves look-alikes alone, and renames and rewrites files", async () => {
    seedRig(OLD);
    seedRig("other-rig");
    seedEveryManifestColumn(OLD);
    seedFiles();
    seedWorkflowSpecRow(path.join(home, "specs/workflows/ticket-factory.yaml"));
    // Look-alikes that a naive REPLACE would corrupt.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, (SELECT id FROM nodes LIMIT 1), ?, 'exited')").run(uid("sess"), `x@${OLD}-2`);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, (SELECT id FROM nodes LIMIT 1), ?, 'exited')").run(uid("sess"), `${OLD}@host`);

    const report = await makeService().rename(OLD, NEW, { dryRun: false });
    expect(report.blockers).toEqual([]);
    expect(report.applied).toBe(true);

    // Database: nothing refers to the old name any more, every manifest column moved.
    for (const m of RIG_RENAME_MANIFEST) {
      const col = `"${m.column}"`;
      const left = m.kind === "rig-name"
        ? db.prepare(`SELECT COUNT(*) AS n FROM "${m.table}" WHERE ${col} = ?`).get(OLD)
        : db.prepare(`SELECT COUNT(*) AS n FROM "${m.table}" WHERE instr(${col}, ?) > 0 AND instr(${col}, ?) = 0`).get(`@${OLD}`, `@${OLD}-2`);
      expect((left as { n: number }).n, `${m.table}.${m.column} still holds the old name`).toBe(0);
      const moved = db.prepare(`SELECT COUNT(*) AS n FROM "${m.table}" WHERE ${col} LIKE ?`).get(m.kind === "rig-name" ? NEW : `%${NEW}%`);
      expect((moved as { n: number }).n, `${m.table}.${m.column} has no row with the new name`).toBeGreaterThan(0);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(OLD) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(NEW) as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = 'other-rig'").get() as { n: number }).n).toBe(1);
    const names = (db.prepare("SELECT session_name AS n FROM sessions ORDER BY session_name").all() as Array<{ n: string }>).map((r) => r.n);
    expect(names).toContain(`orch-lead@${NEW}`);
    expect(names).toContain(`x@${OLD}-2`);
    expect(names).toContain(`${OLD}@host`);
    // Workflow cache: bare rig name, JSON preferred targets, and the keep-me look-alike inside JSON.
    const spec = db.prepare("SELECT target_rig, roles_json FROM workflow_specs WHERE source_path = ?").get(path.join(home, "specs/workflows/ticket-factory.yaml")) as { target_rig: string; roles_json: string };
    expect(spec.target_rig).toBe(NEW);
    expect(spec.roles_json).toContain(`orch-lead@${NEW}`);
    const json = db.prepare("SELECT spec_json FROM workflow_specs WHERE spec_json LIKE '%keep%'").get() as { spec_json: string };
    expect(JSON.parse(json.spec_json)).toEqual({ rig: NEW, target: `seat@${NEW}`, keep: `seat@${OLD}-2` });

    // Files.
    expect(exists(`specs/${NEW}/rig.yaml`)).toBe(true);
    expect(exists(`specs/${OLD}`)).toBe(false);
    const spec2 = read(`specs/${NEW}/rig.yaml`);
    expect(spec2).toContain(`name: ${NEW}   # trailing comment`);
    expect(spec2).toContain("# keep this comment");
    expect(spec2).toContain(`orch-lead@${NEW}, not orch-lead@${OLD}-2`);
    const wf = read("specs/workflows/ticket-factory.yaml");
    expect(wf).toContain(`rig: ${NEW}   # the rig`);
    expect(wf).toContain(`[orch-lead@${NEW}, other@${OLD}-2]`);
    expect(read(`topology/rigs/${NEW}/RIG.md`)).toBe(`Seats: orch-lead@${NEW}\n`);
    // UUID-named state files: content rewritten, name kept; indentation kept.
    const uuidFile = read("state/provider-usage/1b9d6bcd-bbfd-4b2d-9b5d-000000000001.json");
    expect(uuidFile).toBe(JSON.stringify({ session: `orch-lead@${NEW}`, rigName: NEW, other: `x@${OLD}-2` }, null, 2) + "\n");
    expect(JSON.parse(read("state/context-usage/1b9d6bcd-bbfd-4b2d-9b5d-000000000002.json"))).toEqual({ sessionName: `orch-lead@${NEW}`, used: 5 });
    // Seat-named files: renamed, content rewritten. Other rigs untouched.
    expect(exists(`state/provider-usage/orch-lead@${OLD}.json`)).toBe(false);
    expect(JSON.parse(read(`state/provider-usage/orch-lead@${NEW}.json`))).toEqual({ seat: `orch-lead@${NEW}` });
    expect(read("state/provider-usage/other@other-rig.json")).toContain("other@other-rig");
    expect(exists(`compaction/restore-pending/orch-lead@${NEW}.json`)).toBe(true);
    expect(exists(`refocus/${NEW}/note.md`)).toBe(true);
    expect(read(`refocus/${NEW}/note.md`)).toBe(`refocus orch-lead@${NEW}\n`);
    expect(exists(`prompts/orch-lead@${NEW}.md`)).toBe(true);
    expect(exists(`logs/orch-lead@${NEW}.log`)).toBe(true);
    // Transcripts: directory and file renamed in place, history text untouched.
    expect(exists(`transcripts/${OLD}`)).toBe(false);
    expect(read(`transcripts/${NEW}/orch-lead@${NEW}.log`)).toBe(`history mentions orch-lead@${OLD} and stays\n`);
    // Journal is gone. Residue lists the transcripts only if any remain (none by name).
    expect(fs.existsSync(journalPaths(home).file)).toBe(false);
    expect(report.residue?.filter((r) => r.where === "name")).toEqual([]);
  });

  it("queue items are deliverable under the new name and the old name no longer resolves", async () => {
    seedRig(OLD);
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
       VALUES ('qitem-20260101000000-aaaaaaaa', '2026-01-01', '2026-01-01', ?, ?, 'done', 'old work')`,
    ).run(`a@${OLD}`, `b@${OLD}`);
    await makeService().rename(OLD, NEW, { dryRun: false });

    const closed = db.prepare("SELECT source_session AS s, destination_session AS d FROM queue_items").get() as { s: string; d: string };
    expect(closed).toEqual({ s: `a@${NEW}`, d: `b@${NEW}` });

    const validateRig = (ref: string): boolean => {
      const rig = ref.slice(ref.indexOf("@") + 1);
      return (db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(rig) as { n: number }).n > 0;
    };
    const repo = new QueueRepository(db, new EventBus(db), { validateRig });
    const created = await repo.create({ sourceSession: `a@${NEW}`, destinationSession: `b@${NEW}`, body: "new work" });
    expect(created.destinationSession).toBe(`b@${NEW}`);
    await expect(repo.create({ sourceSession: `a@${NEW}`, destinationSession: `b@${OLD}`, body: "stale" })).rejects.toBeInstanceOf(QueueRepositoryError);
  });

  it("renames a plain <name>.yaml spec file and keeps unrelated spec files", async () => {
    seedRig(OLD);
    write(`specs/${OLD}.yaml`, RIG_SPEC);
    write("specs/unrelated.yaml", "name: unrelated\npods: []\n");
    await makeService().rename(OLD, NEW, { dryRun: false });
    expect(exists(`specs/${NEW}.yaml`)).toBe(true);
    expect(read(`specs/${NEW}.yaml`)).toContain(`name: ${NEW}`);
    expect(read("specs/unrelated.yaml")).toBe("name: unrelated\npods: []\n");
  });

  it("renames archived rigs with the same name too", async () => {
    seedRig(OLD);
    seedRig(OLD, { archived: true });
    const report = await makeService().rename(OLD, NEW, { dryRun: false });
    expect(report.rigs).toHaveLength(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(NEW) as { n: number }).n).toBe(2);
  });

  it("does not edit a workflow spec that lives under a protected (built-in) directory", async () => {
    seedRig(OLD);
    const builtin = path.join(home, "builtin");
    fs.mkdirSync(builtin);
    const file = path.join(builtin, "wf.yaml");
    fs.writeFileSync(file, WORKFLOW);
    seedWorkflowSpecRow(file);
    const report = await makeService({ protectedRoots: [builtin] }).rename(OLD, NEW, { dryRun: false });
    expect(fs.readFileSync(file, "utf-8")).toBe(WORKFLOW);
    expect(report.files.skipped.some((s) => s.path === file)).toBe(true);
    // The cached row still moves in the database.
    expect((db.prepare("SELECT target_rig AS t FROM workflow_specs").get() as { t: string }).t).toBe(NEW);
  });
});

describe("rig rename: dry run (RIG-61)", () => {
  it("returns the full plan and writes nothing", async () => {
    seedRig(OLD);
    seedEveryManifestColumn(OLD);
    seedFiles();
    const beforeDb = dumpDb();
    const beforeTree = snapshotTree();

    const report = await makeService().rename(OLD, NEW, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.blockers).toEqual([]);
    expect(report.db.rows).toBeGreaterThan(RIG_RENAME_MANIFEST.length - 5);
    expect(report.db.columns.find((c) => c.table === "queue_items" && c.column === "destination_session")?.rows).toBe(1);
    expect(report.files.ops.some((o) => o.kind === "rename" && o.to === path.join(home, "transcripts", NEW))).toBe(true);
    expect(report.files.ops.some((o) => o.kind === "write" && o.path === path.join(home, "specs", OLD, "rig.yaml"))).toBe(true);
    expect(report.files.ops.every((o) => !("content" in o))).toBe(true);
    expect(dumpDb()).toBe(beforeDb);
    expect(snapshotTree()).toEqual(beforeTree);
    expect(exists("run")).toBe(false);
  });
});

describe("rig rename: validation (RIG-61)", () => {
  it.each([["", "empty"], ["a/b", "separator"], ["..", "dot-dot"], ["a b", "space"], ["a@b", "at"], [OLD, "same name"]])(
    "refuses new name %j (%s)", async (bad) => {
      seedRig(OLD);
      await expect(makeService().rename(OLD, bad, { dryRun: true })).rejects.toBeInstanceOf(RigRenameInvalidError);
    });
  it("refuses an unknown rig", async () => {
    await expect(makeService().rename("nope", NEW, { dryRun: true })).rejects.toBeInstanceOf(RigRenameNotFoundError);
  });
});

describe("rig rename: pre-check blockers (RIG-61)", () => {
  const expectBlocked = async (code: string, mustMention: string): Promise<void> => {
    const before = dumpDb();
    const treeBefore = snapshotTree();
    const report = await makeService().rename(OLD, NEW, { dryRun: false });
    expect(report.applied).toBe(false);
    const blocker = report.blockers.find((b) => b.code === code);
    expect(blocker, `expected blocker ${code}, got ${report.blockers.map((b) => b.code).join(",")}`).toBeDefined();
    expect(JSON.stringify(blocker)).toContain(mustMention);
    expect(dumpDb()).toBe(before);
    expect(snapshotTree()).toEqual(treeBefore);
  };

  it("refuses a rig with a running session", async () => {
    seedRig(OLD, { sessionStatus: "running" });
    await expectBlocked("live_sessions", `orch-lead@${OLD} (running)`);
  });

  it.each(["unknown", "launched", "resumable"])("refuses a rig whose session status is %s (not known to be stopped)", async (status) => {
    seedRig(OLD, { sessionStatus: status });
    await expectBlocked("live_sessions", status);
  });

  it("allows exited, detached and superseded sessions", async () => {
    const { nodeId } = seedRig(OLD, { sessionStatus: "exited" });
    for (const status of ["detached", "superseded"]) {
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)").run(uid("sess"), nodeId, `orch-lead@${OLD}`, status);
    }
    const report = await makeService().rename(OLD, NEW, { dryRun: true });
    expect(report.blockers).toEqual([]);
  });

  it("refuses when tmux still has a session of the rig, even if the stored status says exited", async () => {
    seedRig(OLD, { sessionStatus: "exited" });
    const report = await makeService({ probeSession: async (n) => ({ state: n === `orch-lead@${OLD}` ? "present" : "absent" }) }).rename(OLD, NEW, { dryRun: true });
    expect(report.blockers.map((b) => b.code)).toEqual(["live_tmux_sessions"]);
  });

  it.each(["active", "waiting"])("refuses an open workflow instance (%s)", async (status) => {
    seedRig(OLD);
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, bound_rig, status, created_at) VALUES ('wf-1', 'w', '1', ?, ?, ?, 't')")
      .run("someone@elsewhere", OLD, status);
    await expectBlocked("active_workflows", "wf-1");
  });

  it("allows completed workflow instances", async () => {
    seedRig(OLD);
    db.prepare("INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, bound_rig, status, created_at) VALUES ('wf-1', 'w', '1', ?, ?, 'completed', 't')")
      .run(`a@${OLD}`, OLD);
    expect((await makeService().rename(OLD, NEW, { dryRun: true })).blockers).toEqual([]);
  });

  it.each(["pending", "in-progress", "blocked"])("refuses a %s queue item addressed to the rig", async (state) => {
    seedRig(OLD);
    db.prepare("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q-1', 't', 't', 'a@elsewhere', ?, ?, 'b')")
      .run(`dev@${OLD}`, state);
    await expectBlocked("open_queue_items", "q-1");
  });

  it("refuses a pending queue item that the rig sent", async () => {
    seedRig(OLD);
    db.prepare("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q-2', 't', 't', ?, 'a@elsewhere', 'pending', 'b')")
      .run(`dev@${OLD}`);
    await expectBlocked("open_queue_items", "q-2");
  });

  it("ignores open queue items of a look-alike rig (x@old-2)", async () => {
    seedRig(OLD);
    db.prepare("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q-3', 't', 't', 'a@elsewhere', ?, 'pending', 'b')")
      .run(`dev@${OLD}-2`);
    expect((await makeService().rename(OLD, NEW, { dryRun: true })).blockers).toEqual([]);
  });

  it("refuses an active watchdog job that targets the rig", async () => {
    seedRig(OLD);
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO watchdog_jobs (job_id, policy, spec_yaml, target_session, interval_seconds, state, registered_by_session, registered_at) VALUES ('job-1', 'periodic-reminder', 'x', ?, 60, 'active', 'h@kernel', 't')")
      .run(`dev@${OLD}`);
    await expectBlocked("active_watchdog_jobs", "job-1");
  });

  it("allows a stopped watchdog job and rewrites its target and YAML", async () => {
    seedRig(OLD);
    db.prepare("INSERT INTO watchdog_jobs (job_id, policy, spec_yaml, target_session, interval_seconds, state, registered_by_session, registered_at) VALUES ('job-1', 'periodic-reminder', ?, ?, 60, 'stopped', 'h@kernel', 't')")
      .run(`target:\n  session: dev@${OLD}\n`, `dev@${OLD}`);
    await makeService().rename(OLD, NEW, { dryRun: false });
    expect(db.prepare("SELECT target_session AS t, spec_yaml AS y FROM watchdog_jobs").get()).toEqual({ t: `dev@${NEW}`, y: `target:\n  session: dev@${NEW}\n` });
  });

  it("lists every blocker at once", async () => {
    seedRig(OLD, { sessionStatus: "running" });
    db.prepare("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q-1', 't', 't', 'a@elsewhere', ?, 'pending', 'b')").run(`dev@${OLD}`);
    const report = await makeService().rename(OLD, NEW, { dryRun: true });
    expect(report.blockers.map((b) => b.code).sort()).toEqual(["live_sessions", "open_queue_items"]);
  });
});

describe("rig rename: name collisions (RIG-61)", () => {
  it("refuses a name used by an active rig", async () => {
    seedRig(OLD);
    seedRig(NEW);
    const report = await makeService().rename(OLD, NEW, { dryRun: false });
    expect(report.blockers.map((b) => b.code)).toContain("name_collision_rig");
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(OLD) as { n: number }).n).toBe(1);
  });

  it("refuses a name used by an archived rig", async () => {
    seedRig(OLD);
    seedRig(NEW, { archived: true });
    const report = await makeService().rename(OLD, NEW, { dryRun: true });
    expect(report.blockers.find((b) => b.code === "name_collision_rig")?.items?.[0]).toContain("(archived)");
  });

  it.each([
    ["spec file", () => write(`specs/${NEW}.yaml`, "name: x\n")],
    ["spec whose name: is the new name", () => write("specs/other.yaml", `name: ${NEW}\npods: []\n`)],
    ["spec directory", () => fs.mkdirSync(path.join(home, "specs", NEW), { recursive: true })],
    ["topology dir", () => fs.mkdirSync(path.join(home, "topology", "rigs", NEW), { recursive: true })],
    ["transcripts dir", () => fs.mkdirSync(path.join(home, "transcripts", NEW), { recursive: true })],
    ["refocus dir", () => fs.mkdirSync(path.join(home, "refocus", NEW), { recursive: true })],
    ["state file", () => write(`state/provider-usage/orch-lead@${NEW}.json`, "{}")],
  ])("refuses when a %s for the new name exists", async (_label, make) => {
    seedRig(OLD);
    make();
    const treeBefore = snapshotTree();
    const report = await makeService().rename(OLD, NEW, { dryRun: false });
    expect(report.blockers.map((b) => b.code)).toContain("name_collision_files");
    expect(snapshotTree()).toEqual(treeBefore);
  });

  it("refuses when history in the database already refers to the new name", async () => {
    seedRig(OLD);
    db.prepare("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q-9', 't', 't', ?, 'z@elsewhere', 'done', 'b')")
      .run(`ghost@${NEW}`);
    const report = await makeService().rename(OLD, NEW, { dryRun: false });
    const blocker = report.blockers.find((b) => b.code === "new_name_in_history");
    expect(blocker?.items?.join(" ")).toContain("queue_items.source_session");
  });
});

describe("rig rename: failure injection (RIG-61)", () => {
  it("DB failure: the transaction rolls back, nothing on disk is touched, no journal is left", async () => {
    seedRig(OLD);
    seedEveryManifestColumn(OLD);
    seedFiles();
    // rigs.name is rewritten before queue_items, so this proves the whole transaction rolled back.
    db.exec("CREATE TRIGGER inject_fail BEFORE UPDATE ON queue_items BEGIN SELECT RAISE(ABORT, 'injected db failure'); END;");
    const beforeDb = dumpDb();
    const beforeTree = snapshotTree();

    const err = await makeService().rename(OLD, NEW, { dryRun: false }).catch((e) => e);

    expect(err).toBeInstanceOf(RigRenameRolledBackError);
    expect((err as RigRenameRolledBackError).stage).toBe("db");
    expect(String(err.message)).toContain("injected db failure");
    expect(dumpDb()).toBe(beforeDb);
    expect(snapshotTree()).toEqual(beforeTree);
  });

  it("file failure mid-way: files are restored in reverse and the database is reverted", async () => {
    seedRig(OLD);
    seedEveryManifestColumn(OLD);
    seedFiles();
    const beforeDb = dumpDb();
    const beforeTree = snapshotTree();
    // Fail the third file rename: some writes and renames have already happened.
    const service = makeService({ fs: flakyFs({ failRename: (_a, _b, n) => n === 3 }) });

    const err = await service.rename(OLD, NEW, { dryRun: false }).catch((e) => e);

    expect(err).toBeInstanceOf(RigRenameRolledBackError);
    expect((err as RigRenameRolledBackError).stage).toBe("files");
    expect(snapshotTree()).toEqual(beforeTree);
    expect(dumpDb()).toBe(beforeDb);
    expect(fs.existsSync(journalPaths(home).file)).toBe(false);
  });

  it("file write failure mid-way rolls back too", async () => {
    seedRig(OLD);
    seedFiles();
    const beforeDb = dumpDb();
    const beforeTree = snapshotTree();
    const service = makeService({ fs: flakyFs({ failWrite: (_p, n) => n === 3 }) });
    const err = await service.rename(OLD, NEW, { dryRun: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RigRenameRolledBackError);
    expect(snapshotTree()).toEqual(beforeTree);
    expect(dumpDb()).toBe(beforeDb);
  });

  it("compensation failure is loud, keeps the journal, and `recover` finishes the job", async () => {
    seedRig(OLD);
    seedEveryManifestColumn(OLD);
    seedFiles();
    const beforeDb = dumpDb();
    const beforeTree = snapshotTree();
    const service = makeService({
      fs: flakyFs({ failRename: (_a, _b, n) => n === 1 }),
      // After the forward transaction commits, block the reverse one: any update back to the old name fails.
      hooks: { afterDbCommit: () => db.exec(`CREATE TRIGGER block_reverse BEFORE UPDATE ON queue_items WHEN NEW.destination_session LIKE '%@${OLD}' BEGIN SELECT RAISE(ABORT, 'injected compensation failure'); END;`) },
    });

    const err = await service.rename(OLD, NEW, { dryRun: false }).catch((e) => e);

    expect(err).toBeInstanceOf(RigRenameRecoveryError);
    const recovery = err as RigRenameRecoveryError;
    expect(recovery.message).toContain("could NOT be reverted");
    expect(recovery.message).toContain(`still uses "${NEW}"`);
    expect(recovery.state.database).toContain(NEW);
    expect(recovery.state.files).toContain("restored");
    expect(recovery.journalPath).toBe(journalPaths(home).file);
    // Files are back; the database is not; the journal is preserved with the exact phase.
    expect(Object.fromEntries(Object.entries(snapshotTree()).filter(([k]) => !k.startsWith("run")))).toEqual(beforeTree);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(NEW) as { n: number }).n).toBe(1);
    const journal = JSON.parse(fs.readFileSync(journalPaths(home).file, "utf-8"));
    expect(journal.phase).toBe("compensation-failed");
    expect(journal.error).toContain("injected compensation failure");

    // A new rename is refused while the journal exists, and says where it is.
    const blocked = await service.rename(OLD, "another-name", { dryRun: true });
    expect(blocked.blockers.map((b) => b.code)).toContain("journal_present");
    expect(blocked.blockers.find((b) => b.code === "journal_present")?.message).toContain(journalPaths(home).file);

    // Fix the cause and recover.
    db.exec("DROP TRIGGER block_reverse");
    const result = await service.recover();
    expect(result.recovered).toBe(true);
    expect(dumpDb()).toBe(beforeDb);
    expect(snapshotTree()).toEqual(beforeTree);
    expect(fs.existsSync(journalPaths(home).file)).toBe(false);
  });

  it("rollback failure is loud, does NOT revert the database, and keeps the journal", async () => {
    seedRig(OLD);
    seedFiles();
    // One rename succeeds, then every rename fails, including the ones that would undo the first.
    let renames = 0;
    const partial: RenameFs = {
      ...nodeRenameFs,
      rename: (a, b) => {
        renames += 1;
        if (renames === 1) return nodeRenameFs.rename(a, b);
        throw new Error("injected rename failure");
      },
    };

    const err = await makeService({ fs: partial }).rename(OLD, NEW, { dryRun: false }).catch((e) => e);

    expect(err).toBeInstanceOf(RigRenameRecoveryError);
    expect(err.message).toContain("could not be fully restored");
    expect(err.message).toContain("NOT reverted");
    expect(JSON.parse(fs.readFileSync(journalPaths(home).file, "utf-8")).phase).toBe("rollback-failed");
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(NEW) as { n: number }).n).toBe(1);

    // With a working filesystem, recover restores everything.
    const result = await makeService().recover();
    expect(result.recovered).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(OLD) as { n: number }).n).toBe(1);
    expect(exists(`transcripts/${OLD}/orch-lead@${OLD}.log`)).toBe(true);
  });

  it("recover with no journal does nothing", async () => {
    expect(await makeService().recover()).toEqual({ recovered: false, message: expect.stringContaining("No rename journal") });
  });

  it("a throw right after the DB commit unwinds cleanly", async () => {
    seedRig(OLD);
    seedFiles();
    const beforeTree = snapshotTree();
    const service = makeService({ hooks: { afterDbCommit: () => { throw new Error("daemon hiccup"); } } });
    const err = await service.rename(OLD, NEW, { dryRun: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RigRenameRolledBackError);
    expect(snapshotTree()).toEqual(beforeTree);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(OLD) as { n: number }).n).toBe(1);
  });

  it("recovers a journal left by a hard crash after the DB commit", async () => {
    seedRig(OLD);
    seedFiles();
    const beforeTree = snapshotTree();
    // The post-crash state, built by hand: the DB side committed, a journal exists, no file op ran.
    fs.mkdirSync(path.dirname(journalPaths(home).file), { recursive: true });
    fs.writeFileSync(journalPaths(home).file, JSON.stringify({ version: 1, id: "j", oldName: OLD, newName: NEW, startedAt: "t", phase: "planned", ops: [] }));
    db.prepare("UPDATE rigs SET name = ?").run(NEW);
    db.prepare("UPDATE sessions SET session_name = ?").run(`orch-lead@${NEW}`);

    const svc = makeService();
    // Until recovered, a new rename is refused with a pointer to the journal.
    const refused = await svc.rename(NEW, "third-name", { dryRun: false });
    expect(refused.applied).toBe(false);
    expect(refused.blockers.map((b) => b.code)).toEqual(["journal_present"]);

    const result = await svc.recover();

    expect(result.recovered).toBe(true);
    expect((db.prepare("SELECT name FROM rigs").get() as { name: string }).name).toBe(OLD);
    expect((db.prepare("SELECT session_name AS n FROM sessions").get() as { n: string }).n).toBe(`orch-lead@${OLD}`);
    expect(snapshotTree()).toEqual(beforeTree);
  });
});

describe("rig rename: review fixes (RIG-61)", () => {
  it("F2: a rig that takes the new name during the tmux probe fails the rename and leaves the DB unchanged", async () => {
    seedRig(OLD);
    seedFiles();
    const service = makeService({
      probeSession: async () => {
        // Another writer creates a rig with the new name while the pre-check awaits.
        db.prepare("INSERT INTO rigs (id, name) VALUES ('late', ?)").run(NEW);
        return { state: "absent" as const };
      },
    });
    const beforeTree = snapshotTree();
    const err = await service.rename(OLD, NEW, { dryRun: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RigRenameRolledBackError);
    expect((err as RigRenameRolledBackError).stage).toBe("db");
    expect(err.message).toContain("was taken");
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(OLD) as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(NEW) as { n: number }).n).toBe(1);
    expect(snapshotTree()).toEqual(beforeTree);
  });

  it("F10: a probe that throws blocks the rename instead of counting as absent", async () => {
    seedRig(OLD);
    const report = await makeService({ probeSession: async () => { throw new Error("EPERM tmux socket"); } }).rename(OLD, NEW, { dryRun: false });
    expect(report.applied).toBe(false);
    const blocker = report.blockers.find((b) => b.code === "tmux_unconfirmed");
    expect(blocker?.items?.join(" ")).toContain("EPERM tmux socket");
    expect((db.prepare("SELECT COUNT(*) AS n FROM rigs WHERE name = ?").get(OLD) as { n: number }).n).toBe(1);
  });

  it("F10: transport trouble other than 'no server running' blocks; 'no server running' proves absence", async () => {
    seedRig(OLD);
    const blocked = await makeService({ probeSession: async () => ({ state: "transport_unavailable" as const, cause: "permission denied on socket" }) }).rename(OLD, NEW, { dryRun: true });
    expect(blocked.blockers.map((b) => b.code)).toEqual(["tmux_unconfirmed"]);
    const ok = await makeService({ probeSession: async () => ({ state: "transport_unavailable" as const, cause: "no server running on /tmp/tmux-1/default" }) }).rename(OLD, NEW, { dryRun: true });
    expect(ok.blockers).toEqual([]);
  });

  it.each([
    "error connecting to /private/tmp/tmux-501/default (No such file or directory)",
    "error connecting to /private/tmp/tmux-501/default (Connection refused)",
  ])("F10-v2: tmux cause %j proves absence", async (cause) => {
    seedRig(OLD);
    const report = await makeService({ probeSession: async () => ({ state: "transport_unavailable" as const, cause }) }).rename(OLD, NEW, { dryRun: true });
    expect(report.blockers).toEqual([]);
  });

  it("F10-v2: a permission-denied connect error still blocks", async () => {
    seedRig(OLD);
    const report = await makeService({ probeSession: async () => ({ state: "transport_unavailable" as const, cause: "error connecting to /private/tmp/tmux-501/default (Permission denied)" }) }).rename(OLD, NEW, { dryRun: true });
    expect(report.blockers.map((b) => b.code)).toEqual(["tmux_unconfirmed"]);
  });

  it("F1: renaming rig v1 does not touch files of rig v1.2", async () => {
    seedRig("v1");
    seedRig("v1.2");
    write("state/provider-usage/lead@v1.json", JSON.stringify({ s: "lead@v1" }));
    write("state/provider-usage/lead@v1.2.json", JSON.stringify({ s: "lead@v1.2" }));
    write("logs/lead@v1.2.log", "x");
    write("logs/lead@v1.log", "x");
    await makeService().rename("v1", "v9", { dryRun: false });
    expect(exists("state/provider-usage/lead@v9.json")).toBe(true);
    expect(exists("state/provider-usage/lead@v1.2.json")).toBe(true);
    expect(read("state/provider-usage/lead@v1.2.json")).toContain("lead@v1.2");
    expect(exists("logs/lead@v9.log")).toBe(true);
    expect(exists("logs/lead@v1.2.log")).toBe(true);
    expect(exists("logs/lead@v9.2.log")).toBe(false);
  });

  it("F1: renaming rig old does not rename the file of a rig called old.json", async () => {
    seedRig("old");
    seedRig("old.json");
    write("logs/lead@old.json.log", "x");
    write("logs/lead@old.log", "x");
    await makeService().rename("old", "fresh", { dryRun: false });
    expect(exists("logs/lead@old.json.log")).toBe(true);
    expect(exists("logs/lead@fresh.log")).toBe(true);
  });
});

describe("rig rename: single flight (RIG-61)", () => {
  it("a second rename started while one is running is refused", async () => {
    seedRig(OLD);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const service = makeService({ probeSession: async () => { await gate; return { state: "absent" as const }; } });

    const first = service.rename(OLD, NEW, { dryRun: false });
    expect(service.isRunning()).toBe(true);
    const second = await service.rename(OLD, "third-name", { dryRun: true });
    expect(second.blockers.map((b) => b.code)).toEqual(["rename_in_progress"]);

    release();
    const done = await first;
    expect(done.applied).toBe(true);
    expect(service.isRunning()).toBe(false);
  });
});
