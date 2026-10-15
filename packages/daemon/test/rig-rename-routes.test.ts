import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRenameService } from "../src/domain/rig-rename-service.js";
import { nodeRenameFs } from "../src/domain/rig-rename-files.js";
import { rigRenameRoutes } from "../src/routes/rig-rename.js";

// RIG-61 — HTTP surface. Temp OPENRIG_HOME and temp database only.

let home: string;
let db: Database.Database;
let app: Hono;

function mount(service: RigRenameService | undefined): Hono {
  const a = new Hono();
  a.use("*", async (c, next) => { c.set("rigRenameService" as never, service); await next(); });
  a.route("/api", rigRenameRoutes());
  return a;
}
const post = (url: string, body?: unknown) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rig-rename-routes-")));
  db = createDb(path.join(home, "test.sqlite"));
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'old-rig')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'lead')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', 'n1', 'lead@old-rig', 'exited')").run();
  app = mount(new RigRenameService({ db, openrigHome: home }));
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("rig rename routes (RIG-61)", () => {
  it("dry run returns 200 with the plan and changes nothing", async () => {
    const res = await post("/api/rigs/old-rig/rename", { newName: "new-rig", dryRun: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { dryRun: boolean; applied: boolean; db: { rows: number } };
    expect(body.dryRun).toBe(true);
    expect(body.applied).toBe(false);
    expect(body.db.rows).toBeGreaterThan(0);
    expect((db.prepare("SELECT name FROM rigs").get() as { name: string }).name).toBe("old-rig");
  });

  it("applies the rename", async () => {
    const res = await post("/api/rigs/old-rig/rename", { newName: "new-rig" });
    expect(res.status).toBe(200);
    expect((await res.json() as { applied: boolean }).applied).toBe(true);
    expect((db.prepare("SELECT name FROM rigs").get() as { name: string }).name).toBe("new-rig");
  });

  it("answers 409 with the blockers when the rig is not quiescent", async () => {
    db.prepare("UPDATE sessions SET status = 'running'").run();
    const res = await post("/api/rigs/old-rig/rename", { newName: "new-rig" });
    expect(res.status).toBe(409);
    const body = await res.json() as { blockers: Array<{ code: string }> };
    expect(body.blockers.map((b) => b.code)).toEqual(["live_sessions"]);
    expect((db.prepare("SELECT name FROM rigs").get() as { name: string }).name).toBe("old-rig");
  });

  it("answers 400 for a bad new name and for a missing body", async () => {
    expect((await post("/api/rigs/old-rig/rename", { newName: "a/b" })).status).toBe(400);
    expect((await post("/api/rigs/old-rig/rename", { dryRun: true })).status).toBe(400);
    expect((await post("/api/rigs/old-rig/rename")).status).toBe(400);
  });

  it("answers 404 for an unknown rig", async () => {
    expect((await post("/api/rigs/ghost/rename", { newName: "new-rig" })).status).toBe(404);
  });

  it("answers 500 rename_failed_rolled_back when a stage fails and is undone", async () => {
    db.exec("CREATE TRIGGER inject BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const res = await post("/api/rigs/old-rig/rename", { newName: "new-rig" });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; stage: string };
    expect(body).toMatchObject({ error: "rename_failed_rolled_back", stage: "db" });
  });

  it("answers 500 rename_recovery_required with the journal path when recovery is needed, and recover clears it", async () => {
    db.pragma("foreign_keys = OFF");
    let renames = 0;
    app = mount(new RigRenameService({
      db,
      openrigHome: home,
      fs: { ...nodeRenameFs, rename: (a, b) => { renames += 1; if (renames === 1) throw new Error("rename blew up"); nodeRenameFs.rename(a, b); } },
      hooks: { afterDbCommit: () => db.exec("CREATE TRIGGER block BEFORE UPDATE ON sessions WHEN NEW.session_name LIKE '%@old-rig' BEGIN SELECT RAISE(ABORT, 'no reverse'); END;") },
    }));
    fs.mkdirSync(path.join(home, "transcripts", "old-rig"), { recursive: true });

    const res = await post("/api/rigs/old-rig/rename", { newName: "new-rig" });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; journal: string; state: { database: string } };
    expect(body.error).toBe("rename_recovery_required");
    expect(body.journal).toBe(path.join(home, "run", "rig-rename-journal.json"));
    expect(body.state.database).toContain("new-rig");

    const journal = await (await app.request("/api/rig-rename/journal")).json() as { journal: { phase: string } };
    expect(journal.journal.phase).toBe("compensation-failed");

    db.exec("DROP TRIGGER block");
    const recovered = await (await post("/api/rig-rename/recover")).json() as { recovered: boolean };
    expect(recovered.recovered).toBe(true);
    expect((db.prepare("SELECT name FROM rigs").get() as { name: string }).name).toBe("old-rig");
    expect((await (await app.request("/api/rig-rename/journal")).json() as { journal: unknown }).journal).toBeNull();
  });

  it("answers 503 when the service is not wired", async () => {
    app = mount(undefined);
    expect((await post("/api/rigs/old-rig/rename", { newName: "new-rig" })).status).toBe(503);
    expect((await app.request("/api/rig-rename/journal")).status).toBe(503);
    expect((await post("/api/rig-rename/recover")).status).toBe(503);
  });
});
