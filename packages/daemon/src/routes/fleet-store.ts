import { Hono } from "hono";
import type { Database } from "better-sqlite3";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { FleetStore } from "../domain/fleet-store.js";
import type {
  SessionDigestInput,
  ReviewRunInput,
  ReviewFindingInput,
  DailyTokenSnapshotInput,
} from "../domain/fleet-store.js";
import type { FleetIngestionService } from "../domain/fleet-ingestion-service.js";

export interface FleetStoreRouteDeps {
  db: () => Database;
  bearerToken?: string | null;
  /** Optional ingestion service — enables POST /reconcile. */
  fleetIngestion?: FleetIngestionService;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function strRequired(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numRequired(v: unknown): number | undefined {
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}

function strOrDefault(v: unknown, def: string): string {
  if (v === null || v === undefined) return def;
  return typeof v === "string" ? v : def;
}

function numOrDefault(v: unknown, def: number): number {
  if (v === null || v === undefined) return def;
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

function normalizeDigest(body: Record<string, unknown>): SessionDigestInput | string {
  const nativeSessionId = strRequired(body.nativeSessionId);
  if (!nativeSessionId) return "nativeSessionId is required.";
  const seatSession = strRequired(body.seatSession);
  if (!seatSession) return "seatSession is required.";
  const transcriptPath = strRequired(body.transcriptPath);
  if (!transcriptPath) return "transcriptPath is required.";
  const totalTurns = numRequired(body.totalTurns);
  if (totalTurns === undefined) return "totalTurns is required (number).";
  const conversationTurns = numRequired(body.conversationTurns);
  if (conversationTurns === undefined) return "conversationTurns is required (number).";

  return {
    rigName: strOrNull(body.rigName),
    seatSession,
    seatName: strOrNull(body.seatName),
    nodeLogicalId: strOrNull(body.nodeLogicalId),
    rigId: strOrNull(body.rigId),
    nodeId: strOrNull(body.nodeId),
    nativeSessionId,
    generationUuid: strOrNull(body.generationUuid),
    occupantGeneration: numOrNull(body.occupantGeneration),
    transcriptPath,
    transcriptBytes: numOrNull(body.transcriptBytes),
    transcriptModifiedAt: strOrNull(body.transcriptModifiedAt),
    totalTurns,
    conversationTurns,
    toolCalls: strOrDefault(body.toolCalls, "{}"),
    repeatedReads: strOrDefault(body.repeatedReads, "{}"),
    reviewFindings: strOrDefault(body.reviewFindings, "{}"),
    handoffEvents: strOrDefault(body.handoffEvents, "[]"),
    claudeMdLoaded: strOrDefault(body.claudeMdLoaded, "[]"),
    errors: strOrDefault(body.errors, "[]"),
    irreversibleActions: strOrDefault(body.irreversibleActions, "[]"),
    compactionBoundaries: strOrDefault(body.compactionBoundaries, "[]"),
    compactionLosses: strOrDefault(body.compactionLosses, "[]"),
    sourceHash: strOrNull(body.sourceHash),
    parserVersion: strOrNull(body.parserVersion),
  };
}

function normalizeReviewRun(body: Record<string, unknown>): ReviewRunInput | string {
  const traceId = strRequired(body.traceId);
  if (!traceId) return "run.traceId is required.";
  const metricsJson = strRequired(body.metricsJson);
  if (metricsJson === undefined) return "run.metricsJson is required.";

  return {
    traceId,
    prNumber: numOrNull(body.prNumber),
    repo: strOrNull(body.repo),
    branch: strOrNull(body.branch),
    ticket: strOrNull(body.ticket),
    headSha: strOrNull(body.headSha),
    mode: strOrNull(body.mode),
    validationMode: strOrNull(body.validationMode),
    modelReview: strOrNull(body.modelReview),
    modelValidator: strOrNull(body.modelValidator),
    bundleSizeChars: numOrNull(body.bundleSizeChars),
    mustFix: numOrDefault(body.mustFix, 0),
    suggestion: numOrDefault(body.suggestion, 0),
    dismissed: numOrDefault(body.dismissed, 0),
    deferred: numOrDefault(body.deferred, 0),
    escalated: numOrDefault(body.escalated, 0),
    crossAgreed: numOrDefault(body.crossAgreed, 0),
    crossClaudeOnly: numOrDefault(body.crossClaudeOnly, 0),
    crossCodexOnly: numOrDefault(body.crossCodexOnly, 0),
    metricsJson,
    rigName: strOrNull(body.rigName),
    seatName: strOrNull(body.seatName),
    startedAt: strOrNull(body.startedAt),
    completedAt: strOrNull(body.completedAt),
    durationSeconds: numOrNull(body.durationSeconds),
    logDir: strOrNull(body.logDir),
    sourceHash: strOrNull(body.sourceHash),
    parserVersion: strOrNull(body.parserVersion),
  };
}

function normalizeFinding(f: Record<string, unknown>, runTraceId: string): ReviewFindingInput | string {
  const findingId = strRequired(f.findingId);
  if (!findingId) return "findingId is required.";

  return {
    runTraceId,
    findingId,
    file: strOrNull(f.file),
    lines: strOrNull(f.lines),
    category: strOrNull(f.category),
    hunterKey: strOrNull(f.hunterKey),
    stack: strOrNull(f.stack),
    score: numOrNull(f.score),
    verdict: strOrNull(f.verdict),
    hasFixSpec: numOrNull(f.hasFixSpec),
    descriptionPrefix: strOrNull(f.descriptionPrefix),
    descriptionHash: strOrNull(f.descriptionHash),
  };
}

function normalizeSnapshot(body: Record<string, unknown>): DailyTokenSnapshotInput | string {
  const day = strRequired(body.day);
  if (!day) return "day is required.";
  const seatSession = strRequired(body.seatSession);
  if (!seatSession) return "seatSession is required.";

  return {
    day,
    seatSession,
    rigName: strOrNull(body.rigName),
    seatName: strOrNull(body.seatName),
    model: strOrNull(body.model),
    inputTokensDelta: numOrNull(body.inputTokensDelta),
    outputTokensDelta: numOrNull(body.outputTokensDelta),
    totalTokensDelta: numOrNull(body.totalTokensDelta),
    samples: numOrNull(body.samples),
    resets: numOrDefault(body.resets, 0),
    schemaVersion: strOrNull(body.schemaVersion),
  };
}

export function fleetStoreRoutes(deps: FleetStoreRouteDeps): Hono {
  const app = new Hono();

  const writeApp = new Hono();
  writeApp.use("*", authBearerTokenMiddleware({ expectedToken: deps.bearerToken ?? null }));

  function store(): FleetStore {
    return new FleetStore(deps.db());
  }

  writeApp.post("/digests", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
    }

    if (!isRecord(raw)) {
      return c.json({ ok: false, code: "invalid_json", error: "Body must be a JSON object." }, 400);
    }

    const input = normalizeDigest(raw);
    if (typeof input === "string") {
      return c.json({ ok: false, code: "missing_field", error: input }, 400);
    }

    try {
      const result = store().upsertDigest(input);
      return c.json({ ok: true, ...result }, result.created ? 201 : 200);
    } catch (err) {
      if (err instanceof RangeError || err instanceof TypeError) {
        return c.json({ ok: false, code: "invalid_field", error: "Invalid field type or missing parameter." }, 400);
      }
      return c.json({ ok: false, code: "fleet_store_error", error: "Internal fleet store error." }, 500);
    }
  });

  writeApp.post("/reviews", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
    }

    if (!isRecord(raw)) {
      return c.json({ ok: false, code: "invalid_json", error: "Body must be a JSON object." }, 400);
    }

    if (!isRecord(raw.run)) {
      return c.json({ ok: false, code: "missing_field", error: "run must be an object." }, 400);
    }

    const run = normalizeReviewRun(raw.run);
    if (typeof run === "string") {
      return c.json({ ok: false, code: "missing_field", error: run }, 400);
    }

    const rawFindings = raw.findings ?? [];
    if (!Array.isArray(rawFindings)) {
      return c.json({ ok: false, code: "missing_field", error: "findings must be an array." }, 400);
    }

    const findings: ReviewFindingInput[] = [];
    for (let i = 0; i < rawFindings.length; i++) {
      const rf = rawFindings[i];
      if (!isRecord(rf)) {
        return c.json({ ok: false, code: "missing_field", error: `findings[${i}] must be an object.` }, 400);
      }
      const f = normalizeFinding(rf, run.traceId);
      if (typeof f === "string") {
        return c.json({ ok: false, code: "missing_field", error: `findings[${i}].${f}` }, 400);
      }
      findings.push(f);
    }

    try {
      const result = store().upsertReviewRun(run, findings);
      return c.json({ ok: true, ...result }, result.created ? 201 : 200);
    } catch (err) {
      if (err instanceof RangeError || err instanceof TypeError) {
        return c.json({ ok: false, code: "invalid_field", error: "Invalid field type or missing parameter." }, 400);
      }
      return c.json({ ok: false, code: "fleet_store_error", error: "Internal fleet store error." }, 500);
    }
  });

  writeApp.post("/snapshots", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
    }

    const rawItems = Array.isArray(raw) ? raw : [raw];
    const items: DailyTokenSnapshotInput[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const ri = rawItems[i];
      if (!isRecord(ri)) {
        return c.json({ ok: false, code: "missing_field", error: `items[${i}] must be an object.` }, 400);
      }
      const s = normalizeSnapshot(ri);
      if (typeof s === "string") {
        return c.json({ ok: false, code: "missing_field", error: `items[${i}].${s}` }, 400);
      }
      items.push(s);
    }

    try {
      if (items.length === 1) {
        const result = store().upsertSnapshot(items[0]!);
        return c.json({ ok: true, ...result }, result.created ? 201 : 200);
      }
      const result = store().upsertSnapshots(items);
      return c.json({ ok: true, ...result }, 200);
    } catch (err) {
      if (err instanceof RangeError || err instanceof TypeError) {
        return c.json({ ok: false, code: "invalid_field", error: "Invalid field type or missing parameter." }, 400);
      }
      return c.json({ ok: false, code: "fleet_store_error", error: "Internal fleet store error." }, 500);
    }
  });

  app.route("/", writeApp);

  app.get("/stats", (c) => {
    try {
      const result = store().stats();
      return c.json({ ok: true, ...result });
    } catch {
      return c.json({ ok: false, code: "fleet_store_error", error: "Internal fleet store error." }, 500);
    }
  });

  writeApp.post("/reconcile", async (c) => {
    const ingestion = deps.fleetIngestion;
    if (!ingestion) {
      return c.json({ ok: false, code: "not_configured", error: "Fleet ingestion service not available." }, 503);
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.json().catch(() => ({}));
      if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
    } catch { /* empty body is fine */ }

    const force = body.force === true;
    const digestsOnly = body.digests === true;
    const reviewsOnly = body.reviews === true;
    const snapshotsOnly = body.snapshots === true;

    try {
      if (digestsOnly) {
        const result = await ingestion.reconcileDigests({ force });
        return c.json({ ok: true, digests: result });
      }
      if (reviewsOnly) {
        const result = await ingestion.reconcileReviews({ force });
        return c.json({ ok: true, reviews: result });
      }
      if (snapshotsOnly) {
        const result = await ingestion.rollUpSnapshots();
        return c.json({ ok: true, snapshots: result });
      }
      const result = await ingestion.reconcile({ force });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ ok: false, code: "reconcile_error", error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
