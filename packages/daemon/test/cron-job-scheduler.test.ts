import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as realSpawn } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { cronJobsSchema } from "../src/db/migrations/107_cron_jobs.js";
import { CronBusyError, CronJobScheduler, CronNotFoundError, CronValidationError, CRON_CHILD_PATH } from "../src/domain/cron-job-scheduler.js";
import { createDaemonShutdown } from "../src/daemon-shutdown.js";

// RIG-84 — scheduler behavior with real child processes (fixture scripts under a temp OPENRIG_HOME).
// TZ is pinned so slot times are deterministic. The real fleet-audit script is never run.

const originalTz = process.env["TZ"];
beforeAll(() => { process.env["TZ"] = "UTC"; });
afterAll(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});

const SLOT = "2026-10-15T06:00:00.000Z"; // daily 06:00 in UTC
const at = (hms: string) => new Date(`2026-10-15T${hms}Z`);

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("CronJobScheduler (RIG-84)", () => {
  let home: string;
  let db: Database.Database;
  let t: Date;
  let errors: unknown[];
  let timers: Array<{ cb: () => void; ms: number; cleared: boolean }>;
  const live: CronJobScheduler[] = [];

  const script = (name: string, body: string, mode = 0o755) => {
    const file = path.join(home, name);
    fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode });
    return file;
  };
  const make = (over: Partial<ConstructorParameters<typeof CronJobScheduler>[0]> = {}) => {
    const sched = new CronJobScheduler({
      db, openrigHome: home, home: "/tmp/fake-home", killGraceMs: 200,
      now: () => t,
      setTimer: (cb, ms) => { const rec = { cb, ms, cleared: false }; timers.push(rec); return rec as unknown as NodeJS.Timeout; },
      clearTimer: (h) => { (h as unknown as { cleared: boolean }).cleared = true; },
      onError: (e) => errors.push(e),
      ...over,
    });
    live.push(sched);
    return sched;
  };
  const register = (sched: CronJobScheduler, name: string, command: string, extra: Record<string, unknown> = {}) =>
    sched.register({ name, schedule: "daily 06:00", command, ...extra });
  const row = (name: string) => db.prepare("SELECT * FROM cron_jobs WHERE name = ?").get(name) as Record<string, unknown>;
  const countLines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-sched-")));
    db = createDb(path.join(home, "test.sqlite"));
    migrate(db, [cronJobsSchema]);
    t = at("06:00:30");
    errors = [];
    timers = [];
  });
  afterEach(async () => {
    for (const s of live.splice(0)) await s.stop();
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env["PUSHOVER_APP_TOKEN"];
  });

  describe("catch-up guard", () => {
    it("a never-run job with a missed slot inside the window fires once", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "job", script("count.sh", `echo x >> "${counter}"`));
      t = at("08:00:00"); // slot is 2h old, window is 6h
      await sched.runTickNow();
      await sched.runTickNow();
      expect(countLines(counter)).toBe(1);
      expect(row("job")).toMatchObject({ last_run_at: SLOT, last_status: "ok", last_exit_code: 0 });
    });

    it("start, run, stop, start inside the window: the second start does not fire again", async () => {
      const counter = path.join(home, "count.txt");
      const first = make();
      register(first, "job", script("count.sh", `echo x >> "${counter}"`));
      first.start();
      expect(timers).toHaveLength(1);
      timers[0]!.cb();
      await waitFor(() => row("job")["last_status"] === "ok");
      await first.stop();
      expect(countLines(counter)).toBe(1);

      t = at("07:30:00");
      const second = make();
      second.start();
      timers[timers.length - 1]!.cb();
      await second.runTickNow();
      await second.stop();
      expect(countLines(counter)).toBe(1);
    });

    it("a slot older than the catch-up window is skipped", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "job", script("count.sh", `echo x >> "${counter}"`));
      t = at("12:30:00"); // slot is 6.5h old
      await sched.runTickNow();
      expect(countLines(counter)).toBe(0);
      expect(row("job")["last_run_at"]).toBeNull();
    });

    it("a per-job window of 0 only fires on the slot itself", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "job", script("count.sh", `echo x >> "${counter}"`), { catchupWindowSeconds: 0 });
      await sched.runTickNow(); // 30s after the slot
      expect(countLines(counter)).toBe(0);
    });

    it("writes last_run_at and status=running BEFORE the child starts", async () => {
      const seen: Array<Record<string, unknown>> = [];
      const sched = make({
        spawn: ((...args: Parameters<typeof realSpawn>) => {
          seen.push(row("job"));
          return realSpawn(...args);
        }) as typeof realSpawn,
      });
      register(sched, "job", script("ok.sh", "exit 0"));
      await sched.runTickNow();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ last_run_at: SLOT, last_status: "running" });
    });

    it("a crash mid-run does not re-fire the slot, and the stale 'running' row is marked interrupted at start", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "job", script("count.sh", `echo x >> "${counter}"`));
      // Simulate the claim happening and the daemon dying before the result was recorded.
      db.prepare("UPDATE cron_jobs SET last_run_at = ?, last_status = 'running'").run(SLOT);
      const next = make();
      next.start();
      expect(row("job")["last_status"]).toBe("interrupted");
      await next.runTickNow();
      expect(countLines(counter)).toBe(0);
    });

    it("skips disabled jobs", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "job", script("count.sh", `echo x >> "${counter}"`), { enabled: false });
      await sched.runTickNow();
      expect(countLines(counter)).toBe(0);
    });
  });

  describe("child environment", () => {
    it("passes only PATH, HOME and OPENRIG_HOME; daemon secrets do not leak", async () => {
      process.env["PUSHOVER_APP_TOKEN"] = "canary-secret";
      const dump = path.join(home, "env-dump.txt");
      const sched = make();
      register(sched, "job", script("env.sh", `/usr/bin/env > "${dump}"`));
      await sched.runTickNow();
      const text = fs.readFileSync(dump, "utf8");
      expect(text).not.toContain("canary-secret");
      expect(text).not.toContain("PUSHOVER");
      const vars = Object.fromEntries(text.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      expect(vars["PATH"]).toBe(CRON_CHILD_PATH);
      expect(vars["HOME"]).toBe("/tmp/fake-home");
      expect(vars["OPENRIG_HOME"]).toBe(home);
      // bash itself adds PWD, SHLVL and _; nothing else may appear.
      const extras = Object.keys(vars).filter((k) => !["PATH", "HOME", "OPENRIG_HOME", "PWD", "SHLVL", "_", "OLDPWD"].includes(k));
      expect(extras).toEqual([]);
    });

    it("spawns argv without a shell", async () => {
      const calls: Array<{ cmd: string; args: readonly string[]; opts: Record<string, unknown> }> = [];
      const sched = make({
        spawn: ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
          calls.push({ cmd, args, opts });
          return realSpawn(cmd, args as string[], opts as never);
        }) as typeof realSpawn,
      });
      const out = path.join(home, "args.txt");
      register(sched, "job", script("args.sh", `printf '%s\\n' "$@" > "${out}"`), { args: ["a b", "$(touch /tmp/pwned)", ";ls"] });
      await sched.runTickNow();
      expect(calls[0]!.opts["shell"]).toBe(false);
      expect(fs.readFileSync(out, "utf8")).toBe("a b\n$(touch /tmp/pwned)\n;ls\n");
    });
  });

  describe("timeout", () => {
    it("kills a hung child, records timeout, and the next job still runs", async () => {
      const pidFile = path.join(home, "pid.txt");
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "a-hang", script("hang.sh", `echo $$ > "${pidFile}"; sleep 30`), { timeoutSeconds: 1 });
      register(sched, "b-after", script("after.sh", `echo x >> "${counter}"`));
      const started = Date.now();
      await sched.runTickNow();
      expect(Date.now() - started).toBeLessThan(6000);
      expect(row("a-hang")).toMatchObject({ last_status: "timeout" });
      expect(alive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(false);
      expect(countLines(counter)).toBe(1);
    });

    it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
      const pidFile = path.join(home, "pid.txt");
      const sched = make();
      register(sched, "stubborn", script("stubborn.sh", `trap '' TERM; echo $$ > "${pidFile}"; sleep 30`), { timeoutSeconds: 1 });
      await sched.runTickNow();
      expect(row("stubborn")["last_status"]).toBe("timeout");
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      await waitFor(() => !alive(pid), 2000);
    });
  });

  describe("concurrency", () => {
    it("overlapping ticks run a job once, and a manual run during a run is refused", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "slow", script("slow.sh", `echo x >> "${counter}"; sleep 1`));
      const a = sched.runTickNow();
      const b = sched.runTickNow();
      await waitFor(() => countLines(counter) === 1);
      await expect(sched.runNow("slow")).rejects.toBeInstanceOf(CronBusyError);
      await Promise.all([a, b]);
      expect(countLines(counter)).toBe(1);
    });

    it("a manual run holds the child slot; a due tick waits for it instead of overlapping", async () => {
      const log = path.join(home, "order.txt");
      const sched = make();
      register(sched, "manual-job", script("m.sh", `echo m-start >> "${log}"; sleep 1; echo m-end >> "${log}"`), { enabled: false });
      register(sched, "tick-job", script("t.sh", `echo t >> "${log}"`));
      const manual = sched.runNow("manual-job");
      const tick = sched.runTickNow();
      await Promise.all([manual, tick]);
      expect(fs.readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["m-start", "m-end", "t"]);
    });
  });

  describe("stop and shutdown", () => {
    it("stop() mid-run kills the child, records interrupted, and is idempotent", async () => {
      const pidFile = path.join(home, "pid.txt");
      const sched = make();
      register(sched, "long", script("long.sh", `echo $$ > "${pidFile}"; sleep 30`));
      sched.start();
      timers[0]!.cb();
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      const started = Date.now();
      await Promise.all([sched.stop(), sched.stop()]);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(alive(pid)).toBe(false);
      expect(row("long")["last_status"]).toBe("interrupted");
      expect(timers).toHaveLength(1); // no further tick was scheduled after stop
      await sched.stop();
      expect(sched.isRunning()).toBe(false);
    });

    it("stop() clears the pending tick timer so nothing runs afterwards", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "job", script("count.sh", `echo x >> "${counter}"`));
      sched.start();
      await sched.stop();
      expect(timers[0]!.cleared).toBe(true);
      await sched.runTickNow();
      expect(countLines(counter)).toBe(0);
    });

    it("shutdown ordering: the cron phase finishes killing its child before the connections phase", async () => {
      const pidFile = path.join(home, "pid.txt");
      const sched = make();
      register(sched, "long", script("long.sh", `echo $$ > "${pidFile}"; sleep 30`));
      sched.start();
      timers[0]!.cb();
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      const order: string[] = [];
      let childAliveAtConnections: boolean | null = null;
      const exited = new Promise<number>((resolve) => {
        const shutdown = createDaemonShutdown({
          phases: [
            ["watchdog", () => { order.push("watchdog"); }],
            ["cron", async () => { await sched.stop(); order.push("cron"); }],
            ["connections", () => { childAliveAtConnections = alive(pid); order.push("connections"); }],
          ],
          markClean: () => {},
          receiptPath: path.join(home, "receipt.json"),
          exit: resolve,
          log: () => {},
        });
        shutdown("SIGTERM");
      });
      expect(await exited).toBe(0);
      expect(order).toEqual(["watchdog", "cron", "connections"]);
      expect(childAliveAtConnections).toBe(false);
    });

    it("async catch-up: start() returns without running anything; the first tick comes from a timer", async () => {
      const spawnSpy = vi.fn(realSpawn);
      const sched = make({ spawn: spawnSpy as unknown as typeof realSpawn, startupDelayMs: 0 });
      register(sched, "job", script("ok.sh", "exit 0"));
      sched.start();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(timers).toHaveLength(1);
      expect(timers[0]!.ms).toBe(0);
      timers[0]!.cb();
      await waitFor(() => row("job")["last_status"] === "ok");
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });

    it("start() survives a broken database row without throwing", () => {
      const sched = make();
      db.exec("DROP TABLE cron_jobs");
      expect(() => sched.start()).not.toThrow();
      expect(errors).toHaveLength(1);
    });
  });

  describe("failure containment", () => {
    it("records a non-zero exit as failed and keeps going", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "a-fail", script("fail.sh", "echo boom >&2; exit 3"));
      register(sched, "b-ok", script("ok.sh", `echo x >> "${counter}"`));
      await sched.runTickNow();
      expect(row("a-fail")).toMatchObject({ last_status: "failed", last_exit_code: 3 });
      expect(countLines(counter)).toBe(1);
      expect(fs.readFileSync(path.join(home, "cron", "a-fail.log"), "utf8")).toContain("boom");
    });

    it("a spawn that throws is recorded as error and does not crash the tick", async () => {
      let n = 0;
      const sched = make({
        spawn: ((...args: Parameters<typeof realSpawn>) => {
          if (n++ === 0) throw new Error("spawn exploded");
          return realSpawn(...args);
        }) as typeof realSpawn,
      });
      const counter = path.join(home, "count.txt");
      register(sched, "a-throw", script("ok.sh", "exit 0"));
      register(sched, "b-ok", script("count.sh", `echo x >> "${counter}"`));
      await expect(sched.runTickNow()).resolves.toBeUndefined();
      expect(row("a-throw")).toMatchObject({ last_status: "error" });
      expect(countLines(counter)).toBe(1);
      expect(errors).toHaveLength(1);
    });

    it("a script removed after registration is recorded as error, not run", async () => {
      const sched = make();
      const file = script("gone.sh", "exit 0");
      register(sched, "job", file);
      fs.rmSync(file);
      await sched.runTickNow();
      expect(row("job")["last_status"]).toBe("error");
    });

    it("a symlink swapped in after registration is refused at run time", async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-outside-")));
      try {
        const evil = path.join(outside, "evil.sh");
        fs.writeFileSync(evil, "#!/bin/bash\ntouch " + path.join(outside, "ran") + "\n", { mode: 0o755 });
        const sched = make();
        const file = script("swap.sh", "exit 0");
        register(sched, "job", file);
        fs.rmSync(file);
        fs.symlinkSync(evil, file);
        await sched.runTickNow();
        expect(row("job")["last_status"]).toBe("error");
        expect(fs.existsSync(path.join(outside, "ran"))).toBe(false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("bounds the per-job log to the tail of the output", async () => {
      const sched = make({ tailBytes: 1024 });
      register(sched, "noisy", script("noisy.sh", `head -c 200000 /dev/zero | tr '\\0' 'a'; echo; echo LAST-LINE; head -c 200000 /dev/zero | tr '\\0' 'b' >&2`));
      await sched.runTickNow();
      const log = fs.readFileSync(path.join(home, "cron", "noisy.log"), "utf8");
      expect(log.length).toBeLessThan(4000);
      expect(log).toContain("LAST-LINE");
    });
  });

  describe("manual runs", () => {
    it("records the result but never moves the schedule guard, and works on a disabled job", async () => {
      const sched = make();
      register(sched, "job", script("ok.sh", "echo hi"), { enabled: false });
      const out = await sched.runNow("job");
      expect(out).toMatchObject({ status: "ok", exitCode: 0 });
      expect(row("job")).toMatchObject({ last_run_at: null, last_status: "ok", last_exit_code: 0 });
    });

    it("does not suppress a missed scheduled slot", async () => {
      const counter = path.join(home, "count.txt");
      const sched = make();
      register(sched, "job", script("count.sh", `echo x >> "${counter}"`));
      await sched.runNow("job");
      await sched.runTickNow();
      expect(countLines(counter)).toBe(2);
      expect(row("job")["last_run_at"]).toBe(SLOT);
    });

    it("async mode returns once started and unknown names are 404-class", async () => {
      const sched = make();
      register(sched, "job", script("sleep1.sh", "sleep 1"));
      const out = await sched.runNow("job", { wait: false });
      expect(out).toMatchObject({ started: true });
      await expect(sched.runNow("nope")).rejects.toBeInstanceOf(CronNotFoundError);
      await sched.stop();
    });
  });

  describe("registration", () => {
    it("upserts by name and keeps run history", async () => {
      const sched = make();
      const file = script("ok.sh", "exit 0");
      const first = register(sched, "job", file);
      expect(first.created).toBe(true);
      expect(first.job).toMatchObject({ kind: "shell", timeoutSeconds: 300, catchupWindowSeconds: 21600, enabled: true, args: [] });
      await sched.runTickNow();
      const second = register(sched, "job", file, { schedule: "weekly sun 06:00", timeoutSeconds: 60 });
      expect(second.created).toBe(false);
      expect(second.job).toMatchObject({ schedule: "weekly sun 06:00", timeoutSeconds: 60, lastRunAt: SLOT, lastStatus: "ok" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM cron_jobs").get()).toEqual({ n: 1 });
    });

    it("rejects invalid input", () => {
      const sched = make();
      const file = script("ok.sh", "exit 0");
      const bad = (over: Record<string, unknown>) => () => sched.register({ name: "job", schedule: "daily 06:00", command: file, ...over });
      expect(bad({ name: "Bad Name" })).toThrow(CronValidationError);
      expect(bad({ name: undefined })).toThrow(CronValidationError);
      expect(bad({ schedule: "*/5 * * * *" })).toThrow(CronValidationError);
      expect(bad({ timeoutSeconds: 0 })).toThrow(CronValidationError);
      expect(bad({ timeoutSeconds: 1.5 })).toThrow(CronValidationError);
      expect(bad({ timeoutSeconds: "300" })).toThrow(CronValidationError);
      expect(bad({ catchupWindowSeconds: -1 })).toThrow(CronValidationError);
      expect(bad({ args: "a" })).toThrow(CronValidationError);
      expect(bad({ args: [1] })).toThrow(CronValidationError);
      expect(bad({ enabled: "yes" })).toThrow(CronValidationError);
      expect(bad({})).not.toThrow();
    });

    it("the table only accepts the shell kind", () => {
      make();
      expect(() => db.prepare(
        "INSERT INTO cron_jobs (job_id, name, schedule, kind, command, created_at, updated_at) VALUES ('x','x','daily 06:00','queue-create','/x','t','t')",
      ).run()).toThrow(/CHECK/);
    });

    it("patch changes only the given fields", () => {
      const sched = make();
      register(sched, "job", script("ok.sh", "exit 0"));
      const job = sched.patch("job", { enabled: false, timeoutSeconds: 10 });
      expect(job).toMatchObject({ enabled: false, timeoutSeconds: 10, schedule: "daily 06:00", catchupWindowSeconds: 21600 });
      expect(() => sched.patch("job", { schedule: "nope" })).toThrow(CronValidationError);
      expect(() => sched.patch("missing", {})).toThrow(CronNotFoundError);
    });

    it("lists a next slot for enabled jobs only", () => {
      const sched = make();
      register(sched, "on", script("a.sh", "exit 0"));
      register(sched, "off", script("b.sh", "exit 0"), { enabled: false });
      const jobs = Object.fromEntries(sched.list().map((j) => [j.name, j.nextRunAt]));
      expect(jobs).toEqual({ on: "2026-10-16T06:00:00.000Z", off: null });
    });
  });

  describe("command path validation at registration", () => {
    let outside: string;
    beforeEach(() => { outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-outside-"))); });
    afterEach(() => { fs.rmSync(outside, { recursive: true, force: true }); });
    const tryRegister = (sched: CronJobScheduler, command: unknown) => () => register(sched, "job", command as string);

    it("rejects a relative path", () => {
      const sched = make();
      script("ok.sh", "exit 0");
      expect(tryRegister(sched, "ok.sh")).toThrow(/absolute/);
      expect(tryRegister(sched, "./ok.sh")).toThrow(/absolute/);
    });

    it("rejects .. segments even when the target is inside", () => {
      const sched = make();
      script("ok.sh", "exit 0");
      expect(tryRegister(sched, `${home}/sub/../ok.sh`)).toThrow(/\.\./);
    });

    it("rejects an absolute path outside OPENRIG_HOME", () => {
      const sched = make();
      const file = path.join(outside, "x.sh");
      fs.writeFileSync(file, "#!/bin/bash\n", { mode: 0o755 });
      expect(tryRegister(sched, file)).toThrow(/outside/);
      expect(tryRegister(sched, "/bin/echo")).toThrow(/outside/);
    });

    it("rejects a symlink that escapes OPENRIG_HOME", () => {
      const sched = make();
      const target = path.join(outside, "x.sh");
      fs.writeFileSync(target, "#!/bin/bash\n", { mode: 0o755 });
      const link = path.join(home, "link.sh");
      fs.symlinkSync(target, link);
      expect(tryRegister(sched, link)).toThrow(/outside/);
    });

    it("rejects a symlinked directory that escapes OPENRIG_HOME", () => {
      const sched = make();
      fs.writeFileSync(path.join(outside, "x.sh"), "#!/bin/bash\n", { mode: 0o755 });
      fs.symlinkSync(outside, path.join(home, "dirlink"));
      expect(tryRegister(sched, path.join(home, "dirlink", "x.sh"))).toThrow(/outside/);
    });

    it("rejects a nonexistent file, a directory, a non-executable file, and bad types", () => {
      const sched = make();
      fs.mkdirSync(path.join(home, "adir"));
      script("noexec.sh", "exit 0", 0o644);
      expect(tryRegister(sched, path.join(home, "missing.sh"))).toThrow(/does not exist/);
      expect(tryRegister(sched, path.join(home, "adir"))).toThrow(/regular file/);
      expect(tryRegister(sched, path.join(home, "noexec.sh"))).toThrow(/executable/);
      expect(tryRegister(sched, "")).toThrow(CronValidationError);
      expect(tryRegister(sched, 42)).toThrow(CronValidationError);
      expect(tryRegister(sched, `${home}/ok\0.sh`)).toThrow(CronValidationError);
    });

    it("accepts a symlink that stays inside OPENRIG_HOME and an explicitly allowed extra directory", () => {
      const target = script("real.sh", "exit 0");
      fs.symlinkSync(target, path.join(home, "inside-link.sh"));
      const sched = make();
      expect(() => register(sched, "link", path.join(home, "inside-link.sh"))).not.toThrow();
      const extra = path.join(outside, "x.sh");
      fs.writeFileSync(extra, "#!/bin/bash\n", { mode: 0o755 });
      expect(() => register(sched, "extra", extra)).toThrow(/outside/);
      const withExtra = make({ extraAllowedDirs: [outside] });
      expect(() => register(withExtra, "extra", extra)).not.toThrow();
    });
  });
});
