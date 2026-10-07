import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import type { Database } from "better-sqlite3";
import {
  FleetStore,
  type DailyTokenSnapshotInput,
  type SessionDigestInput,
  type ReviewRunInput,
  type ReviewFindingInput,
} from "./fleet-store.js";

export interface FleetIngestionServiceDeps {
  db: Database;
  fleetStore: FleetStore;
  homedir: string;
  reducerPath: string;
  eventBus?: { subscribe: (cb: (event: { type: string; nodeId?: string }) => void) => () => void };
}

export interface ReconcileResult {
  digests: { discovered: number; ingested: number; skipped: number; errors: string[] };
  reviews: { discovered: number; ingested: number; skipped: number; errors: string[] };
  snapshots: { daysRolledUp: number; snapshotsUpserted: number };
  durationMs: number;
  skippedOverlap?: boolean;
}

export interface DigestReconcileResult {
  discovered: number;
  ingested: number;
  skipped: number;
  errors: string[];
}

export interface ReviewReconcileResult {
  discovered: number;
  ingested: number;
  skipped: number;
  errors: string[];
}

export interface SnapshotRollupResult {
  daysRolledUp: number;
  snapshotsUpserted: number;
}

const PARSER_VERSION = "reduce-transcript.mjs@1";
const MAX_CONCURRENT_REDUCERS = 3;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Lightweight source hash: first 4KB + file size + mtime. Avoids reading large JSONLs fully. */
function sourceHash(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    const fd = readFileSync(filePath, { encoding: null });
    const preview = fd.slice(0, 4096);
    return sha256Hex(Buffer.concat([
      preview,
      Buffer.from(`|${st.size}|${st.mtime.getTime()}`),
    ]));
  } catch {
    return null;
  }
}

/** Run reduce-transcript.mjs as a child process; returns parsed output or throws. */
function runReducer(reducerPath: string, jsonlPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [reducerPath, jsonlPath], {
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 300);
        reject(new Error(`reducer exited ${code}: ${msg}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Extract the Claude session UUID from a JSONL filename (uuid.jsonl). */
function sessionIdFromPath(filePath: string): string {
  return basename(filePath, ".jsonl");
}

/** Look up occupant tenure by native session ID for identity enrichment. */
function lookupOccupantTenure(db: Database, nativeSessionId: string): {
  rigName: string | null;
  seatSession: string | null;
  seatName: string | null;
  nodeLogicalId: string | null;
  rigId: string | null;
  nodeId: string | null;
  generationUuid: string | null;
  occupantGeneration: number | null;
} | null {
  try {
    const row = db.prepare(`
      SELECT ot.generation_uuid, ot.ordinal,
             n.logical_id AS node_logical_id, n.session_name AS seat_name,
             n.node_id, r.rig_id, r.name AS rig_name
        FROM occupant_tenures ot
        LEFT JOIN nodes n ON n.node_id = ot.node_id
        LEFT JOIN rigs r ON r.rig_id = n.rig_id
       WHERE ot.native_session_id_at_boot = ?
       LIMIT 1
    `).get(nativeSessionId) as {
      generation_uuid: string | null;
      ordinal: number | null;
      node_logical_id: string | null;
      seat_name: string | null;
      node_id: string | null;
      rig_id: string | null;
      rig_name: string | null;
    } | undefined;

    if (!row) return null;

    return {
      rigName: row.rig_name ?? null,
      seatSession: row.seat_name ?? null,
      seatName: row.seat_name ?? null,
      nodeLogicalId: row.node_logical_id ?? null,
      rigId: row.rig_id ?? null,
      nodeId: row.node_id ?? null,
      generationUuid: row.generation_uuid ?? null,
      occupantGeneration: row.ordinal ?? null,
    };
  } catch {
    return null;
  }
}

function adaptDigest(
  reducerOutput: Record<string, unknown>,
  filePath: string,
  identity: ReturnType<typeof lookupOccupantTenure>,
  hash: string | null,
): SessionDigestInput {
  const str = (v: unknown): string => {
    if (typeof v === "string") return v;
    return JSON.stringify(v ?? []);
  };

  const st = (() => {
    try { return statSync(filePath); } catch { return null; }
  })();

  const nativeSessionId = sessionIdFromPath(filePath);

  return {
    rigName: identity?.rigName ?? null,
    seatSession: identity?.seatSession ?? (typeof reducerOutput.seat === "string" ? reducerOutput.seat : nativeSessionId),
    seatName: identity?.seatName ?? null,
    nodeLogicalId: identity?.nodeLogicalId ?? null,
    rigId: identity?.rigId ?? null,
    nodeId: identity?.nodeId ?? null,
    nativeSessionId,
    generationUuid: identity?.generationUuid ?? null,
    occupantGeneration: identity?.occupantGeneration ?? null,
    transcriptPath: filePath,
    transcriptBytes: st?.size ?? null,
    transcriptModifiedAt: st?.mtime.toISOString() ?? null,
    totalTurns: typeof reducerOutput.totalTurns === "number" ? reducerOutput.totalTurns : 0,
    conversationTurns: typeof reducerOutput.conversationTurns === "number" ? reducerOutput.conversationTurns : 0,
    toolCalls: str(reducerOutput.toolCalls),
    repeatedReads: str(reducerOutput.repeatedReads),
    reviewFindings: str(reducerOutput.reviewFindings),
    handoffEvents: str(reducerOutput.handoffEvents),
    claudeMdLoaded: str(reducerOutput.claudeMdLoaded),
    errors: str(reducerOutput.errors),
    irreversibleActions: "[]",
    compactionBoundaries: "[]",
    compactionLosses: "[]",
    sourceHash: hash,
    parserVersion: PARSER_VERSION,
  };
}

function adaptReviewRun(
  metricsJson: Record<string, unknown>,
  logDir: string,
  hash: string | null,
): ReviewRunInput {
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

  const classifications = (metricsJson.classifications as Record<string, unknown>) ?? {};

  return {
    traceId: typeof metricsJson.traceId === "string" ? metricsJson.traceId : sha256Hex(logDir),
    prNumber: numOrNull(metricsJson.pr_number),
    repo: strOrNull(metricsJson.repo),
    branch: strOrNull(metricsJson.branch),
    ticket: strOrNull(metricsJson.ticket),
    headSha: strOrNull(metricsJson.head_sha),
    mode: strOrNull(metricsJson.mode),
    validationMode: strOrNull(metricsJson.validation_mode),
    modelReview: strOrNull(metricsJson.model_review),
    modelValidator: strOrNull(metricsJson.model_validator),
    bundleSizeChars: numOrNull(metricsJson.bundle_size_chars),
    mustFix: num(classifications.must_fix ?? metricsJson.must_fix),
    suggestion: num(classifications.suggestion ?? metricsJson.suggestion),
    dismissed: num(classifications.dismissed ?? metricsJson.dismissed),
    deferred: num(classifications.deferred ?? metricsJson.deferred),
    escalated: num(classifications.escalated ?? metricsJson.escalated),
    crossAgreed: num((metricsJson.cross_stack as Record<string, unknown> | undefined)?.agreed ?? metricsJson.cross_agreed),
    crossClaudeOnly: num((metricsJson.cross_stack as Record<string, unknown> | undefined)?.claude_only ?? metricsJson.cross_claude_only),
    crossCodexOnly: num((metricsJson.cross_stack as Record<string, unknown> | undefined)?.codex_only ?? metricsJson.cross_codex_only),
    metricsJson: JSON.stringify(metricsJson),
    rigName: strOrNull(metricsJson.rig_name),
    seatName: strOrNull(metricsJson.seat_name),
    startedAt: strOrNull(metricsJson.started_at),
    completedAt: strOrNull(metricsJson.completed_at),
    durationSeconds: numOrNull(metricsJson.duration_seconds),
    logDir,
    sourceHash: hash,
    parserVersion: "metrics.json@1",
  };
}

function adaptFinding(
  traceId: string,
  f: Record<string, unknown>,
): ReviewFindingInput {
  const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const findingId = typeof f.findingId === "string" ? f.findingId
    : typeof f.id === "string" ? f.id
    : sha256Hex(`${traceId}:${JSON.stringify(f)}`).slice(0, 16);
  const description = typeof f.description === "string" ? f.description
    : typeof f.summary === "string" ? f.summary : "";
  return {
    runTraceId: traceId,
    findingId,
    file: strOrNull(f.file),
    lines: strOrNull(f.lines ?? f.line),
    category: strOrNull(f.category),
    hunterKey: strOrNull(f.hunterKey ?? f.hunter_key),
    stack: strOrNull(f.stack),
    score: numOrNull(f.score),
    verdict: strOrNull(f.verdict),
    hasFixSpec: typeof f.hasFix === "boolean" ? (f.hasFix ? 1 : 0)
      : typeof f.has_fix_spec === "number" ? f.has_fix_spec : null,
    descriptionPrefix: description.slice(0, 200) || null,
    descriptionHash: description ? sha256Hex(description) : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Find a single transcript file by its native session UUID. */
function findTranscriptBySessionId(homedir: string, nativeSessionId: string): string | null {
  if (!UUID_RE.test(nativeSessionId)) return null;
  const projectsDir = join(homedir, ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  const target = `${nativeSessionId}.jsonl`;
  try {
    for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;
      const candidate = join(projectsDir, projectEntry.name, target);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* unreadable */ }
  return null;
}

/** Scan ~/.claude/projects/ for JSONL transcript files. */
function discoverTranscripts(homedir: string): string[] {
  const projectsDir = join(homedir, ".claude", "projects");
  if (!existsSync(projectsDir)) return [];
  const files: string[] = [];
  try {
    for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;
      const projectPath = join(projectsDir, projectEntry.name);
      try {
        for (const f of readdirSync(projectPath)) {
          if (f.endsWith(".jsonl")) {
            files.push(join(projectPath, f));
          }
        }
      } catch { /* skip unreadable project dir */ }
    }
  } catch { /* projects dir unreadable */ }
  return files;
}

/** Scan ~/.claude/logs/code-review/dual-{id} directories for metrics.json files. */
function discoverReviewLogs(homedir: string): string[] {
  const logsDir = join(homedir, ".claude", "logs", "code-review");
  if (!existsSync(logsDir)) return [];
  const dirs: string[] = [];
  try {
    for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("dual-")) continue;
      const metricsPath = join(logsDir, entry.name, "metrics.json");
      if (existsSync(metricsPath)) {
        dirs.push(join(logsDir, entry.name));
      }
    }
  } catch { /* unreadable */ }
  return dirs;
}

/** Run up to `max` promises concurrently. */
async function pooled<T>(
  items: T[],
  max: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, worker));
}

export class FleetIngestionService {
  private readonly db: Database;
  private readonly fleetStore: FleetStore;
  private readonly homedir: string;
  private readonly reducerPath: string;
  private readonly eventBus?: FleetIngestionServiceDeps["eventBus"];
  private eventUnsubscribe?: () => void;
  private reviewTimer: ReturnType<typeof setTimeout> | null = null;
  private activeReconcile: Promise<ReconcileResult> | null = null;

  constructor(deps: FleetIngestionServiceDeps) {
    this.db = deps.db;
    this.fleetStore = deps.fleetStore;
    this.homedir = deps.homedir;
    this.reducerPath = deps.reducerPath;
    this.eventBus = deps.eventBus;
  }

  async reconcile(opts?: { force?: boolean }): Promise<ReconcileResult> {
    if (this.activeReconcile) {
      if (opts?.force) {
        await this.activeReconcile.catch(() => {});
      } else {
        console.log("[fleet-ingestion] reconcile skipped — already in progress");
        return {
          digests: { discovered: 0, ingested: 0, skipped: 0, errors: [] },
          reviews: { discovered: 0, ingested: 0, skipped: 0, errors: [] },
          snapshots: { daysRolledUp: 0, snapshotsUpserted: 0 },
          durationMs: 0,
          skippedOverlap: true,
        };
      }
    }
    const p = this.runReconcile(opts);
    this.activeReconcile = p;
    return p.finally(() => {
      if (this.activeReconcile === p) this.activeReconcile = null;
    });
  }

  private async runReconcile(opts?: { force?: boolean }): Promise<ReconcileResult> {
    const t0 = Date.now();
    const [digests, reviews, snapshots] = await Promise.all([
      this.reconcileDigests(opts),
      this.reconcileReviews(opts),
      this.rollUpSnapshots(),
    ]);
    const result: ReconcileResult = {
      digests,
      reviews,
      snapshots,
      durationMs: Date.now() - t0,
    };
    console.log(
      `[fleet-ingestion] reconcile done in ${result.durationMs}ms — ` +
      `digests: ${digests.ingested} ingested, ${digests.skipped} skipped, ${digests.errors.length} errors; ` +
      `reviews: ${reviews.ingested} ingested, ${reviews.skipped} skipped, ${reviews.errors.length} errors; ` +
      `snapshots: ${snapshots.snapshotsUpserted} upserted`,
    );
    return result;
  }

  async reconcileDigests(opts?: { force?: boolean }): Promise<DigestReconcileResult> {
    const files = discoverTranscripts(this.homedir);
    const result: DigestReconcileResult = { discovered: files.length, ingested: 0, skipped: 0, errors: [] };

    await pooled(files, MAX_CONCURRENT_REDUCERS, async (filePath) => {
      try {
        const hash = sourceHash(filePath);
        if (!opts?.force && hash !== null) {
          const existing = this.db.prepare(
            "SELECT source_hash FROM session_digests WHERE native_session_id = ?",
          ).get(sessionIdFromPath(filePath)) as { source_hash: string | null } | undefined;
          if (existing?.source_hash === hash) {
            result.skipped++;
            return;
          }
        }

        const reducerOutput = await runReducer(this.reducerPath, filePath);
        const identity = lookupOccupantTenure(this.db, sessionIdFromPath(filePath));
        const input = adaptDigest(reducerOutput, filePath, identity, hash);
        this.fleetStore.upsertDigest(input);
        result.ingested++;
      } catch (err) {
        result.errors.push(`${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    return result;
  }

  async reconcileReviews(opts?: { force?: boolean }): Promise<ReviewReconcileResult> {
    const logDirs = discoverReviewLogs(this.homedir);
    const result: ReviewReconcileResult = { discovered: logDirs.length, ingested: 0, skipped: 0, errors: [] };

    for (const logDir of logDirs) {
      try {
        const metricsPath = join(logDir, "metrics.json");
        const hash = sourceHash(metricsPath);

        if (!opts?.force && hash !== null) {
          const raw = JSON.parse(readFileSync(metricsPath, "utf-8")) as Record<string, unknown>;
          const traceId = typeof raw.traceId === "string" ? raw.traceId : sha256Hex(logDir);
          const existing = this.db.prepare(
            "SELECT source_hash FROM review_runs WHERE trace_id = ?",
          ).get(traceId) as { source_hash: string | null } | undefined;
          if (existing?.source_hash === hash) {
            result.skipped++;
            continue;
          }
        }

        const metricsRaw = JSON.parse(readFileSync(metricsPath, "utf-8")) as Record<string, unknown>;
        const run = adaptReviewRun(metricsRaw, logDir, hash);

        let findings: ReviewFindingInput[] | null = null;
        const reportPath = join(logDir, "report.json");
        if (existsSync(reportPath)) {
          try {
            const reportRaw = JSON.parse(readFileSync(reportPath, "utf-8")) as unknown;
            const arr = Array.isArray(reportRaw) ? reportRaw
              : Array.isArray((reportRaw as Record<string, unknown>)?.findings)
                ? (reportRaw as Record<string, unknown>).findings as unknown[]
                : null;
            if (arr !== null) {
              const parsed: ReviewFindingInput[] = [];
              for (const f of arr) {
                if (f && typeof f === "object") {
                  parsed.push(adaptFinding(run.traceId, f as Record<string, unknown>));
                }
              }
              findings = parsed;
            }
          } catch { /* report.json absent or unparseable — null preserves existing findings */ }
        }

        this.fleetStore.upsertReviewRun(run, findings);
        result.ingested++;
      } catch (err) {
        result.errors.push(`${resolve(logDir)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  async rollUpSnapshots(opts?: { days?: number }): Promise<SnapshotRollupResult> {
    const days = opts?.days ?? 15;
    const seats = this.db.prepare(`
      SELECT DISTINCT seat_session
        FROM usage_samples
       WHERE lane = 'context'
         AND captured_at >= date('now', ?)
    `).all(`-${days} days`) as Array<{ seat_session: string }>;

    const result: SnapshotRollupResult = { daysRolledUp: 0, snapshotsUpserted: 0 };
    const snapshots: DailyTokenSnapshotInput[] = [];

    for (const { seat_session: seatSession } of seats) {
      for (let d = days - 1; d >= 0; d--) {
        const day = this.db.prepare("SELECT date('now', ?) AS day").get(`-${d} days`) as { day: string };
        const snap = this.rollUpDay(seatSession, day.day);
        if (snap.samples === 0) continue;

        const existing = this.db.prepare(`
          SELECT samples FROM daily_token_snapshots WHERE day = ? AND seat_session = ?
        `).get(day.day, seatSession) as { samples: number | null } | undefined;

        if (existing && (existing.samples ?? 0) >= (snap.samples ?? 0)) continue;

        snapshots.push(snap);
        result.daysRolledUp++;
      }
    }

    if (snapshots.length > 0) {
      const { upserted } = this.fleetStore.upsertSnapshots(snapshots);
      result.snapshotsUpserted = upserted;
    }

    return result;
  }

  /** Ingest a single session's transcript by its node ID (from a session.stopped event). */
  async ingestSessionByNodeId(nodeId: string): Promise<{ ingested: boolean; nativeSessionId: string | null; error?: string }> {
    try {
      const row = this.db.prepare(
        "SELECT native_session_id_at_boot FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1",
      ).get(nodeId) as { native_session_id_at_boot: string | null } | undefined;

      const nativeSessionId = row?.native_session_id_at_boot ?? null;
      if (!nativeSessionId) {
        return { ingested: false, nativeSessionId: null, error: "no native session ID for node" };
      }

      const transcriptPath = findTranscriptBySessionId(this.homedir, nativeSessionId);
      if (!transcriptPath) {
        return { ingested: false, nativeSessionId, error: "transcript file not found" };
      }

      const hash = sourceHash(transcriptPath);
      const reducerOutput = await runReducer(this.reducerPath, transcriptPath);
      const identity = lookupOccupantTenure(this.db, nativeSessionId);
      const input = adaptDigest(reducerOutput, transcriptPath, identity, hash);
      this.fleetStore.upsertDigest(input);

      return { ingested: true, nativeSessionId };
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = rawMsg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<redacted>");
      return { ingested: false, nativeSessionId: null, error: safeMsg };
    }
  }

  /** Ingest review logs modified within the given time window. */
  async ingestRecentReviews(sinceMs: number = 10 * 60 * 1000): Promise<ReviewReconcileResult> {
    const cutoff = Date.now() - sinceMs;
    const allDirs = discoverReviewLogs(this.homedir);
    const recentDirs = allDirs.filter((dir) => {
      try {
        const metricsPath = join(dir, "metrics.json");
        return statSync(metricsPath).mtime.getTime() >= cutoff;
      } catch {
        return false;
      }
    });

    const result: ReviewReconcileResult = { discovered: recentDirs.length, ingested: 0, skipped: 0, errors: [] };
    for (const logDir of recentDirs) {
      try {
        const metricsPath = join(logDir, "metrics.json");
        const hash = sourceHash(metricsPath);

        if (hash !== null) {
          const raw = JSON.parse(readFileSync(metricsPath, "utf-8")) as Record<string, unknown>;
          const traceId = typeof raw.traceId === "string" ? raw.traceId : sha256Hex(logDir);
          const existing = this.db.prepare(
            "SELECT source_hash FROM review_runs WHERE trace_id = ?",
          ).get(traceId) as { source_hash: string | null } | undefined;
          if (existing?.source_hash === hash) {
            result.skipped++;
            continue;
          }
        }

        const metricsRaw = JSON.parse(readFileSync(metricsPath, "utf-8")) as Record<string, unknown>;
        const run = adaptReviewRun(metricsRaw, logDir, hash);

        let findings: ReviewFindingInput[] | null = null;
        const reportPath = join(logDir, "report.json");
        if (existsSync(reportPath)) {
          try {
            const reportRaw = JSON.parse(readFileSync(reportPath, "utf-8")) as unknown;
            const arr = Array.isArray(reportRaw) ? reportRaw
              : Array.isArray((reportRaw as Record<string, unknown>)?.findings)
                ? (reportRaw as Record<string, unknown>).findings as unknown[]
                : null;
            if (arr !== null) {
              const parsed: ReviewFindingInput[] = [];
              for (const f of arr) {
                if (f && typeof f === "object") {
                  parsed.push(adaptFinding(run.traceId, f as Record<string, unknown>));
                }
              }
              findings = parsed;
            }
          } catch { /* report.json absent or unparseable — null preserves existing findings */ }
        }

        this.fleetStore.upsertReviewRun(run, findings);
        result.ingested++;
      } catch (err) {
        result.errors.push(`${resolve(logDir)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  /** Subscribe to session.stopped events for immediate ingestion. Returns unsubscribe fn. */
  subscribeLifecycleEvents(): () => void {
    if (!this.eventBus) return () => {};
    if (this.eventUnsubscribe) return this.eventUnsubscribe;

    const DEBOUNCE_MS = 2_000;

    this.eventUnsubscribe = this.eventBus.subscribe((event) => {
      if (event.type !== "session.stopped" || !event.nodeId) return;

      const nodeId = event.nodeId;
      this.ingestSessionByNodeId(nodeId).then((r) => {
        if (r.ingested) {
          console.log(`[fleet-ingestion] lifecycle: ingested session for node ${nodeId}`);
        } else if (r.error !== "no native session ID for node") {
          console.log(`[fleet-ingestion] lifecycle: skip node ${nodeId} — ${r.error}`);
        }
      }).catch((err: unknown) => {
        console.error(`[fleet-ingestion] lifecycle ingest error for node ${nodeId}:`, err);
      });

      if (this.reviewTimer) clearTimeout(this.reviewTimer);
      this.reviewTimer = setTimeout(() => {
        this.reviewTimer = null;
        this.ingestRecentReviews().catch((err: unknown) => {
          console.error("[fleet-ingestion] lifecycle review ingest error:", err);
        });
      }, DEBOUNCE_MS);
    });

    return this.eventUnsubscribe;
  }

  /** Unsubscribe from lifecycle events. */
  unsubscribeLifecycleEvents(): void {
    if (this.reviewTimer) {
      clearTimeout(this.reviewTimer);
      this.reviewTimer = null;
    }
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = undefined;
    }
  }

  private rollUpDay(seatSession: string, day: string): DailyTokenSnapshotInput {
    // Include the last sample of the previous day as a baseline for the first delta.
    const prevDaySample = this.db.prepare(`
      SELECT total_input_tokens, total_output_tokens
        FROM usage_samples
       WHERE lane = 'context' AND seat_session = ?
         AND date(captured_at) < ?
       ORDER BY captured_at DESC, id DESC
       LIMIT 1
    `).get(seatSession, day) as { total_input_tokens: number | null; total_output_tokens: number | null } | undefined;

    const samples = this.db.prepare(`
      SELECT total_input_tokens, total_output_tokens, captured_at
        FROM usage_samples
       WHERE lane = 'context' AND seat_session = ?
         AND date(captured_at) = ?
       ORDER BY captured_at ASC, id ASC
    `).all(seatSession, day) as Array<{ total_input_tokens: number | null; total_output_tokens: number | null; captured_at: string }>;

    const allSamples = prevDaySample ? [prevDaySample, ...samples] : samples;

    let inputDelta = 0;
    let outputDelta = 0;
    let resets = 0;

    for (let i = 1; i < allSamples.length; i++) {
      const prev = allSamples[i - 1]!;
      const cur = allSamples[i]!;
      const prevTotal = (prev.total_input_tokens ?? 0) + (prev.total_output_tokens ?? 0);
      const curTotal = (cur.total_input_tokens ?? 0) + (cur.total_output_tokens ?? 0);
      const delta = curTotal - prevTotal;
      if (delta >= 0) {
        inputDelta += (cur.total_input_tokens ?? 0) - (prev.total_input_tokens ?? 0);
        outputDelta += (cur.total_output_tokens ?? 0) - (prev.total_output_tokens ?? 0);
      } else {
        resets++;
      }
    }

    return {
      day,
      seatSession,
      rigName: null,
      seatName: null,
      model: null,
      inputTokensDelta: inputDelta,
      outputTokensDelta: outputDelta,
      totalTokensDelta: inputDelta + outputDelta,
      samples: samples.length,
      resets,
      schemaVersion: "1",
    };
  }
}

export const FLEET_RECONCILE_DEFAULT_MS = 5 * 60 * 1000;
const FLEET_RECONCILE_MIN_MS = 60_000;
const FLEET_RECONCILE_MAX_MS = 86_400_000;

export function resolveFleetReconcileIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return FLEET_RECONCILE_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < FLEET_RECONCILE_MIN_MS) {
    console.warn(`[fleet-ingestion] invalid OPENRIG_FLEET_RECONCILE_INTERVAL_MS="${raw}" — using default ${FLEET_RECONCILE_DEFAULT_MS}ms`);
    return FLEET_RECONCILE_DEFAULT_MS;
  }
  if (n > FLEET_RECONCILE_MAX_MS) {
    console.warn(`[fleet-ingestion] OPENRIG_FLEET_RECONCILE_INTERVAL_MS=${raw} exceeds maximum — clamping to ${FLEET_RECONCILE_MAX_MS}ms`);
    return FLEET_RECONCILE_MAX_MS;
  }
  return n;
}

export function startFleetIngestionScheduler(
  ingestion: FleetIngestionService,
  intervalMs = FLEET_RECONCILE_DEFAULT_MS,
): ReturnType<typeof setInterval> {
  const runOnce = (): void => {
    ingestion.reconcile().catch((err: unknown) => {
      console.error(`[fleet-ingestion] reconcile error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  runOnce();
  return setInterval(runOnce, intervalMs);
}
