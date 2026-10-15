import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { cronJobsSchema } from "../src/db/migrations/107_cron_jobs.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { CronJobScheduler } from "../src/domain/cron-job-scheduler.js";
import { FLEET_AUDIT_JOB, fleetAuditCommand, seedDefaultCronJobs } from "../src/domain/cron-default-jobs.js";
import { cronRoutes } from "../src/routes/cron.js";

// RIG-84 — HTTP surface, migration registration, and the opt-in fleet-audit seed.
// Fixture scripts only; the real fleet-audit.sh is never run.

const originalTz = process.env["TZ"];
beforeAll(() => { process.env["TZ"] = "UTC"; });
afterAll(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});

describe("cron migration (RIG-84)", () => {
  it("is registered after 106 and creates cron_jobs idempotently", () => {
    const names = ALL_MIGRATIONS.map((m) => m.name);
    expect(names).toContain("107_cron_jobs.sql");
    expect(names.indexOf("107_cron_jobs.sql")).toBe(names.indexOf("106_ticket_factory_cutover.sql") + 1);
    const db = createDb(":memory:");
    migrate(db, [cronJobsSchema]);
    migrate(db, [cronJobsSchema]);
    const cols = (db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual([
      "job_id", "name", "schedule", "kind", "command", "args_json", "timeout_seconds", "catchup_window_seconds",
      "enabled", "last_run_at", "last_status", "last_exit_code", "last_duration_ms", "created_at", "updated_at",
    ]);
    db.close();
  });
});

describe("cron routes and seed (RIG-84)", () => {
  let home: string;
  let db: Database.Database;
  let sched: CronJobScheduler;
  let app: Hono;

  const script = (name: string, body: string) => {
    const file = path.join(home, name);
    fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const call = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-routes-")));
    db = createDb(path.join(home, "test.sqlite"));
    migrate(db, [cronJobsSchema]);
    sched = new CronJobScheduler({ db, openrigHome: home, now: () => new Date("2026-10-15T07:00:00Z"), onError: () => {} });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("cronJobScheduler" as never, sched); await next(); });
    app.route("/api/cron", cronRoutes());
  });
  afterEach(async () => {
    await sched.stop();
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("registers (201), updates (200), lists with the next slot, and patches", async () => {
    const command = script("job.sh", "echo hi");
    const created = await call("POST", "/api/cron/jobs", { name: "job", schedule: "daily 06:00", command });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ created: true, job: { name: "job", kind: "shell", enabled: true, timeoutSeconds: 300 } });

    const updated = await call("POST", "/api/cron/jobs", { name: "job", schedule: "daily 07:30", command, timeoutSeconds: 60 });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ created: false, job: { schedule: "daily 07:30", timeoutSeconds: 60 } });

    const listed = await (await call("GET", "/api/cron/jobs")).json() as { running: boolean; jobs: Array<Record<string, unknown>> };
    expect(listed.running).toBe(false);
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]).toMatchObject({ name: "job", nextRunAt: "2026-10-15T07:30:00.000Z" });

    const patched = await call("PATCH", "/api/cron/jobs/job", { enabled: false });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ job: { enabled: false } });
  });

  it("validates strictly: 400 for bad bodies, unknown PATCH fields, escaping paths; 404 for unknown jobs", async () => {
    const command = script("job.sh", "exit 0");
    expect((await call("POST", "/api/cron/jobs", [1])).status).toBe(400);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "*/5 * * * *", command })).status).toBe(400);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "daily 06:00", command: "/bin/echo" })).status).toBe(400);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "daily 06:00", command: "relative.sh" })).status).toBe(400);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "daily 06:00", command, kind: "queue-create" })).status).toBe(201); // extra field ignored; kind is always shell
    const kind = db.prepare("SELECT kind FROM cron_jobs WHERE name = 'x'").get();
    expect(kind).toEqual({ kind: "shell" });
    expect((await call("PATCH", "/api/cron/jobs/x", { command: "/bin/sh" })).status).toBe(400);
    expect((await call("PATCH", "/api/cron/jobs/x", { timeoutSeconds: -5 })).status).toBe(400);
    expect((await call("PATCH", "/api/cron/jobs/nope", { enabled: true })).status).toBe(404);
    expect((await call("POST", "/api/cron/jobs/nope/run")).status).toBe(404);
  });

  it("runs a job now, records the result, and leaves the schedule guard alone", async () => {
    const command = script("job.sh", "echo ran; exit 0");
    await call("POST", "/api/cron/jobs", { name: "job", schedule: "daily 06:00", command });
    const res = await call("POST", "/api/cron/jobs/job/run");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", exitCode: 0, job: { lastStatus: "ok", lastRunAt: null } });
  });

  it("answers 409 when another job holds the child slot, and 202 for async runs", async () => {
    await call("POST", "/api/cron/jobs", { name: "slow", schedule: "daily 06:00", command: script("slow.sh", "sleep 1") });
    const async1 = await call("POST", "/api/cron/jobs/slow/run?async=1");
    expect(async1.status).toBe(202);
    const busy = await call("POST", "/api/cron/jobs/slow/run");
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "cron_busy" });
  });

  it("answers 503 when the scheduler is absent", async () => {
    const bare = new Hono();
    bare.route("/api/cron", cronRoutes());
    for (const [method, url] of [["GET", "/api/cron/jobs"], ["POST", "/api/cron/jobs"], ["PATCH", "/api/cron/jobs/x"], ["POST", "/api/cron/jobs/x/run"]] as const) {
      const res = await bare.request(url, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(503);
    }
  });

  describe("fleet-audit registration", () => {
    it("registers the documented shape through the API", async () => {
      const command = script("fleet-audit.sh", "exit 0");
      expect(command).toBe(fleetAuditCommand(home));
      const res = await call("POST", "/api/cron/jobs", { name: "fleet-audit", schedule: "daily 06:00", command });
      expect(await res.json()).toMatchObject({
        job: { name: "fleet-audit", schedule: "daily 06:00", kind: "shell", command, args: [], timeoutSeconds: 300, catchupWindowSeconds: 21600, enabled: true },
      });
    });

    it("the seed is off by default", () => {
      script("fleet-audit.sh", "exit 0");
      seedDefaultCronJobs(sched, home, {}, () => {});
      expect(sched.list()).toEqual([]);
      seedDefaultCronJobs(sched, home, { OPENRIG_CRON_SEED_FLEET_AUDIT: "0" }, () => {});
      expect(sched.list()).toEqual([]);
    });

    it("the seed creates the job once when enabled, and never overwrites an operator's edits", () => {
      const command = script("fleet-audit.sh", "exit 0");
      const env = { OPENRIG_CRON_SEED_FLEET_AUDIT: "1" };
      seedDefaultCronJobs(sched, home, env, () => {});
      expect(sched.get("fleet-audit")).toMatchObject({ ...FLEET_AUDIT_JOB, command, kind: "shell", enabled: true });
      sched.patch("fleet-audit", { enabled: false, schedule: "daily 09:00" });
      seedDefaultCronJobs(sched, home, env, () => {});
      expect(sched.get("fleet-audit")).toMatchObject({ enabled: false, schedule: "daily 09:00" });
      expect(sched.list()).toHaveLength(1);
    });

    it("the seed skips quietly when the script is not installed", () => {
      const logs: string[] = [];
      seedDefaultCronJobs(sched, home, { OPENRIG_CRON_SEED_FLEET_AUDIT: "1" }, (m) => logs.push(m));
      expect(sched.list()).toEqual([]);
      expect(logs[0]).toContain("does not exist");
    });
  });
});
