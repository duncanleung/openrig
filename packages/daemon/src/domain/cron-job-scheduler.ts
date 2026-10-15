import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type Database from "better-sqlite3";
import { CronJobsRepository, type CronJob, type CronJobInput, type CronRunResult } from "./cron-jobs-repository.js";
import { nextSlot, parseSchedule, previousSlot, ScheduleParseError } from "./cron-schedule.js";
import { CronCommandError, validateCronArgs, validateCronCommand } from "./cron-command-path.js";

/**
 * Cron job scheduler (RIG-84; daemon-native supervision tree member). Runs orchestration-layer
 * shell jobs, the ones that read the daemon's own database or queue. Data-pipeline jobs stay on
 * launchd (ADR-0007). Joins createDaemon's lifecycle like WatchdogScheduler: started post-bind
 * by index.ts, stopped in the named "cron" shutdown phase.
 *
 * Loop semantics:
 *   - Wakes every `tickIntervalMs` (default 30 s; slots have minute resolution). A job is due
 *     when its most recent slot is newer than `last_run_at` AND no older than the job's
 *     `catchup_window_seconds`. Startup is not special: the first tick after boot is the
 *     catch-up pass, and it runs a missed slot at most once.
 *   - Catch-up guard: `last_run_at` is set to the slot time in the same synchronous UPDATE that
 *     decides the job is due (CronJobsRepository.claim), BEFORE the child starts. A crash
 *     mid-run therefore never re-fires the slot on restart.
 *   - The first tick runs from a timer, never inside start(), so a slow or throwing job cannot
 *     delay or crash daemon startup.
 *
 * Concurrency:
 *   - One in-flight tick at a time; jobs within a tick run sequentially; at most one child
 *     process exists at any moment. A manual run while a child is running is refused (busy).
 *
 * Child processes:
 *   - spawn(path, argv, shell:false) with an explicit minimal env: PATH, HOME, OPENRIG_HOME.
 *     process.env is never passed through, so daemon secrets do not reach jobs.
 *   - Detached into its own process group. Timeout (and shutdown) sends SIGTERM to the group,
 *     then SIGKILL after `killGraceMs`.
 *   - stdout/stderr tails (last `tailBytes` each) go to <OPENRIG_HOME>/cron/<name>.log, which is
 *     overwritten each run, so it cannot grow without bound.
 *
 * Shutdown:
 *   - stop() clears the timer, kills any in-flight child, and awaits the tick and the child.
 *     Idempotent.
 */

export const CRON_CHILD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export class CronValidationError extends Error {}
export class CronNotFoundError extends Error {}
export class CronBusyError extends Error {}

export interface CronJobSchedulerDeps {
  db: Database.Database;
  /** OPENRIG_HOME. Jobs run with it, and commands must live under it (or `extraAllowedDirs`). */
  openrigHome: string;
  /** Daemon HOME passed to children. Default os.homedir(). */
  home?: string;
  /** Extra directories a command may live under. */
  extraAllowedDirs?: string[];
  /** Tick wake-up cadence. Default 30000 ms. */
  tickIntervalMs?: number;
  /** Delay before the first (catch-up) tick. Default 0: the next timer turn. */
  startupDelayMs?: number;
  /** SIGTERM to SIGKILL grace. Default 5000 ms. */
  killGraceMs?: number;
  /** Bytes of stdout and of stderr kept per run. Default 8192. */
  tailBytes?: number;
  /** Override clock for tests. */
  now?: () => Date;
  /** Override timer scheduler for tests (tick loop only). */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Override spawn for tests. */
  spawn?: typeof nodeSpawn;
  /** Notification on errors (defaults to console.error). */
  onError?: (err: unknown) => void;
}

export interface CronRunOutcome extends CronRunResult {
  job: CronJob;
}

export interface CronJobPatch {
  schedule?: string;
  enabled?: boolean;
  timeoutSeconds?: number;
  catchupWindowSeconds?: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export class CronJobScheduler {
  private readonly repo: CronJobsRepository;
  private readonly openrigHome: string;
  private readonly home: string;
  private readonly allowedRoots: string[];
  private readonly tickIntervalMs: number;
  private readonly startupDelayMs: number;
  private readonly killGraceMs: number;
  private readonly tailBytes: number;
  private readonly now: () => Date;
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (handle: NodeJS.Timeout) => void;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly onError: (err: unknown) => void;

  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private executing: Promise<CronRunResult> | null = null;
  private child: { proc: ChildProcess; killReason: "timeout" | "shutdown" | null; escalation: Promise<void> | null } | null = null;
  private shuttingDown = false;
  private started = false;
  private stopPromise: Promise<void> | null = null;

  constructor(deps: CronJobSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.repo = new CronJobsRepository(deps.db, this.now);
    this.openrigHome = deps.openrigHome;
    this.home = deps.home ?? os.homedir();
    this.allowedRoots = [deps.openrigHome, ...(deps.extraAllowedDirs ?? [])];
    this.tickIntervalMs = deps.tickIntervalMs ?? 30_000;
    this.startupDelayMs = deps.startupDelayMs ?? 0;
    this.killGraceMs = deps.killGraceMs ?? 5000;
    this.tailBytes = deps.tailBytes ?? 8192;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.onError = deps.onError ?? ((err) => console.error("[cron] error", err));
  }

  // ---- lifecycle ----

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    try {
      this.repo.markInterrupted();
    } catch (err) {
      this.onError(err);
    }
    this.scheduleNextTick(this.startupDelayMs);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.shuttingDown = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.killChild("shutdown");
    this.stopPromise = (async () => {
      try {
        await this.inflight;
        await this.executing;
      } catch {
        // Errors already reported via onError; suppress during shutdown.
      }
      this.started = false;
      this.stopPromise = null;
    })();
    return this.stopPromise;
  }

  isRunning(): boolean {
    return this.started && !this.shuttingDown;
  }

  /** Run one tick and wait for it. Exposed for tests; production uses the timer loop. */
  async runTickNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.tick();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.shuttingDown) return;
    this.timer = this.setTimer(() => {
      void this.runTickNow()
        .catch((err) => this.onError(err))
        .finally(() => this.scheduleNextTick(this.tickIntervalMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private isDue(job: CronJob): boolean {
    const slotMs = previousSlot(job.schedule, this.now()).getTime();
    const lastMs = job.lastRunAt ? Date.parse(job.lastRunAt) : Number.NEGATIVE_INFINITY;
    return slotMs > lastMs && this.now().getTime() - slotMs <= job.catchupWindowSeconds * 1000;
  }

  private async tick(): Promise<void> {
    if (this.shuttingDown) return;
    for (const snapshot of this.repo.list()) {
      if (this.shuttingDown) return;
      if (!snapshot.enabled) continue;
      try {
        if (!this.isDue(snapshot)) continue;
        // Earlier jobs and manual runs own the single child slot until they finish.
        while (this.executing) await this.executing.catch(() => undefined);
        if (this.shuttingDown) return;
        // The snapshot may be stale after that wait: re-read, and use the fresh row throughout.
        const job = this.repo.get(snapshot.name);
        if (!job || !job.enabled || !this.isDue(job)) continue;
        const slot = previousSlot(job.schedule, this.now());
        // Claim before the child starts (see the class comment). False: another writer took the slot.
        if (!this.repo.claim(job.name, slot.toISOString())) continue;
        await this.runJob(job, "scheduled");
      } catch (err) {
        this.onError(err);
      }
    }
  }

  // ---- registration API ----

  list(): Array<CronJob & { nextRunAt: string | null }> {
    return this.repo.list().map((job) => ({ ...job, nextRunAt: this.nextRunAt(job) }));
  }

  get(name: string): (CronJob & { nextRunAt: string | null }) | null {
    const job = this.repo.get(name);
    return job ? { ...job, nextRunAt: this.nextRunAt(job) } : null;
  }

  /** Register or update a job by name. Validates everything; throws CronValidationError. */
  register(input: Record<string, unknown>): { job: CronJob; created: boolean } {
    const name = input.name;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new CronValidationError("name must match [a-z0-9][a-z0-9._-]{0,62}");
    }
    const normalized: CronJobInput = {
      name,
      schedule: this.checkSchedule(input.schedule),
      command: this.checkCommand(input.command),
      args: this.checkArgs(input.args),
      timeoutSeconds: this.checkInt("timeoutSeconds", input.timeoutSeconds, 300, 1, 86_400),
      catchupWindowSeconds: this.checkInt("catchupWindowSeconds", input.catchupWindowSeconds, 21_600, 0, 604_800),
      enabled: this.checkBool(input.enabled, true),
    };
    return this.repo.upsert(normalized);
  }

  patch(name: string, patch: CronJobPatch): CronJob {
    const existing = this.repo.get(name);
    if (!existing) throw new CronNotFoundError(`no cron job named "${name}"`);
    const { job } = this.repo.upsert({
      name,
      schedule: patch.schedule === undefined ? existing.schedule : this.checkSchedule(patch.schedule),
      command: existing.command,
      args: existing.args,
      timeoutSeconds: patch.timeoutSeconds === undefined ? existing.timeoutSeconds : this.checkInt("timeoutSeconds", patch.timeoutSeconds, 300, 1, 86_400),
      catchupWindowSeconds: patch.catchupWindowSeconds === undefined ? existing.catchupWindowSeconds : this.checkInt("catchupWindowSeconds", patch.catchupWindowSeconds, 21_600, 0, 604_800),
      enabled: patch.enabled === undefined ? existing.enabled : this.checkBool(patch.enabled, existing.enabled),
    });
    return job;
  }

  /**
   * Run a job now, outside the schedule. Same single child slot, env, timeout and path guard as a
   * scheduled run. It records last_status/exit code/duration but NEVER touches last_run_at, so it
   * neither consumes the next scheduled slot nor suppresses a missed one. Works on a disabled job.
   * `wait: false` returns once the child has started.
   */
  async runNow(name: string, opts: { wait?: boolean } = {}): Promise<CronRunOutcome | { job: CronJob; started: true }> {
    const job = this.repo.get(name);
    if (!job) throw new CronNotFoundError(`no cron job named "${name}"`);
    if (this.shuttingDown) throw new CronBusyError("scheduler is shutting down");
    if (this.executing) throw new CronBusyError("another cron job is running");
    this.repo.markRunning(name);
    const run = this.runJob(job, "manual");
    if (opts.wait === false) return { job: this.repo.get(name)!, started: true };
    const result = await run;
    return { ...result, job: this.repo.get(name)! };
  }

  // ---- internals ----

  private nextRunAt(job: CronJob): string | null {
    if (!job.enabled) return null;
    try {
      return nextSlot(job.schedule, this.now()).toISOString();
    } catch {
      return null;
    }
  }

  private checkSchedule(value: unknown): string {
    try {
      parseSchedule(value as string);
    } catch (err) {
      if (err instanceof ScheduleParseError) throw new CronValidationError(err.message);
      throw err;
    }
    return (value as string).trim();
  }

  private checkCommand(value: unknown): string {
    try {
      validateCronCommand(value, this.allowedRoots);
    } catch (err) {
      if (err instanceof CronCommandError) throw new CronValidationError(err.message);
      throw err;
    }
    return value as string;
  }

  private checkArgs(value: unknown): string[] {
    try {
      return validateCronArgs(value);
    } catch (err) {
      if (err instanceof CronCommandError) throw new CronValidationError(err.message);
      throw err;
    }
  }

  private checkInt(field: string, value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new CronValidationError(`${field} must be an integer from ${min} to ${max}`);
    }
    return value;
  }

  private checkBool(value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new CronValidationError("enabled must be a boolean");
    return value;
  }

  /** Track the single child slot. Never rejects. */
  private runJob(job: CronJob, mode: "scheduled" | "manual"): Promise<CronRunResult> {
    const p = this.execute(job, mode);
    this.executing = p;
    const clear = () => {
      if (this.executing === p) this.executing = null;
    };
    p.then(clear, clear);
    return p;
  }

  private killChild(reason: "timeout" | "shutdown"): void {
    const current = this.child;
    if (!current || current.killReason) return;
    current.killReason = reason;
    this.signalGroup(current.proc, "SIGTERM");
    // The group SIGKILL is NOT cancelled when the leader exits: a descendant in the same group
    // may have ignored SIGTERM. execute() awaits this before it releases the child slot, so a
    // survivor is always killed before the next run or the end of shutdown.
    current.escalation = new Promise<void>((resolve) => {
      const escalate = setTimeout(() => {
        this.signalGroup(current.proc, "SIGKILL");
        resolve();
      }, this.killGraceMs);
      escalate.unref?.();
    });
  }

  private signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, signal);
    } catch {
      try { proc.kill(signal); } catch { /* already gone */ }
    }
  }

  private async execute(job: CronJob, mode: "scheduled" | "manual"): Promise<CronRunResult> {
    const startedAt = Date.now();
    let result: CronRunResult;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let note = "";
    try {
      // Re-validate at run time: a file swapped for a symlink since registration is refused.
      const command = validateCronCommand(job.command, this.allowedRoots);
      const keep = (buf: Buffer, chunk: Buffer) => {
        const next = Buffer.concat([buf, chunk]);
        return next.length > this.tailBytes ? next.subarray(next.length - this.tailBytes) : next;
      };
      const proc = this.spawnFn(command, job.args, {
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: fs.existsSync(this.openrigHome) ? this.openrigHome : undefined,
        env: { PATH: CRON_CHILD_PATH, HOME: this.home, OPENRIG_HOME: this.openrigHome },
      });
      const current = { proc, killReason: null as "timeout" | "shutdown" | null, escalation: null as Promise<void> | null };
      this.child = current;
      proc.stdout?.on("data", (chunk: Buffer) => { stdout = keep(stdout, chunk); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr = keep(stderr, chunk); });
      const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
      const timeout = setTimeout(() => this.killChild("timeout"), job.timeoutSeconds * 1000);
      const outcome: { exitCode: number | null; error: Error | null } = { exitCode: null, error: null };
      try {
        await new Promise<void>((resolve) => {
          proc.once("error", (err) => { outcome.error = err; resolve(); });
          proc.once("exit", (code) => { outcome.exitCode = code; resolve(); });
        });
        // Let buffered output drain, but never wait on a grandchild that holds the pipes open.
        if (!outcome.error) {
          let cap: NodeJS.Timeout | undefined;
          await Promise.race([closed, new Promise<void>((resolve) => { cap = setTimeout(resolve, 500); })]);
          clearTimeout(cap);
        }
      } finally {
        clearTimeout(timeout);
        // A kill was requested: wait for the final group SIGKILL before freeing the slot.
        if (current.escalation) await current.escalation;
        this.child = null;
      }
      const { exitCode, error } = outcome;
      const status = error ? "error"
        : current.killReason === "timeout" ? "timeout"
        : current.killReason === "shutdown" ? "interrupted"
        : exitCode === 0 ? "ok" : "failed";
      if (error) note = `spawn error: ${error.message}`;
      result = { status, exitCode, durationMs: Date.now() - startedAt };
    } catch (err) {
      note = `error: ${err instanceof Error ? err.message : String(err)}`;
      this.onError(err);
      result = { status: "error", exitCode: null, durationMs: Date.now() - startedAt };
    }
    try {
      this.repo.recordResult(job.name, result);
    } catch (err) {
      this.onError(err);
    }
    this.writeLog(job, mode, result, note, stdout, stderr);
    return result;
  }

  private writeLog(job: CronJob, mode: string, result: CronRunResult, note: string, stdout: Buffer, stderr: Buffer): void {
    try {
      const dir = path.join(this.openrigHome, "cron");
      fs.mkdirSync(dir, { recursive: true });
      const body = [
        `# ${new Date().toISOString()} ${mode} status=${result.status} exit=${result.exitCode ?? "none"} duration_ms=${result.durationMs ?? "none"}`,
        ...(note ? [`# ${note}`] : []),
        `--- stdout (last ${this.tailBytes} bytes max)`,
        stdout.toString("utf8"),
        `--- stderr (last ${this.tailBytes} bytes max)`,
        stderr.toString("utf8"),
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, `${job.name}.log`), body, { mode: 0o600 });
    } catch (err) {
      this.onError(err);
    }
  }
}
