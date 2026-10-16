import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { sessionDigestsSchema } from "../src/db/migrations/096_session_digests.js";
import { reviewRunsSchema } from "../src/db/migrations/097_review_runs.js";
import { reviewFindingsSchema } from "../src/db/migrations/098_review_findings.js";
import { dailyTokenSnapshotsSchema } from "../src/db/migrations/099_daily_token_snapshots.js";
import { digestTokenUsageSchema } from "../src/db/migrations/100_digest_token_usage.js";
import { digestEscalationCountSchema } from "../src/db/migrations/101_digest_escalation_count.js";
import { digestSessionTimestampsSchema } from "../src/db/migrations/102_digest_session_timestamps.js";
import { digestSkillInvocationsSchema } from "../src/db/migrations/103_digest_skill_invocations.js";
import { digestStallPatternsSchema } from "../src/db/migrations/108_session_digest_stall_patterns.js";
import {
  FleetStore,
  UNATTRIBUTED,
  UNDATED,
  type SessionDigestInput,
  type ReviewRunInput,
  type DailyTokenSnapshotInput,
} from "../src/domain/fleet-store.js";
import { fleetStoreRoutes } from "../src/routes/fleet-store.js";
import { renderFleetDashboard, escapeHtml } from "../src/domain/fleet-dashboard.js";

function freshDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  for (const m of [
    reviewRunsSchema, reviewFindingsSchema, sessionDigestsSchema, dailyTokenSnapshotsSchema,
    digestTokenUsageSchema, digestEscalationCountSchema, digestSessionTimestampsSchema,
    digestSkillInvocationsSchema, digestStallPatternsSchema,
  ]) db.exec(m.sql);
  return db;
}

let n = 0;
const digest = (over: Partial<SessionDigestInput> = {}): SessionDigestInput => ({
  rigName: "atlas", seatSession: "dev-impl@atlas", seatName: "dev-impl", nodeLogicalId: null, rigId: null, nodeId: null,
  nativeSessionId: `sess-${++n}`, generationUuid: null, occupantGeneration: null, transcriptPath: "/tmp/t.jsonl",
  transcriptBytes: null, transcriptModifiedAt: null, totalTurns: 10, conversationTurns: 5,
  toolCalls: "{}", repeatedReads: "{}", reviewFindings: "{}", handoffEvents: "[]", skillInvocations: "[]",
  claudeMdLoaded: "[]", errors: "[]", irreversibleActions: "[]", stallPatterns: "[]", compactionBoundaries: "[]",
  compactionLosses: "[]", tokenUsage: "[]", totalInputTokens: 100, totalOutputTokens: 50,
  totalCacheCreationTokens: 0, totalCacheReadTokens: 0, escalationCount: 0,
  startedAt: null, endedAt: null, durationMs: null, sourceHash: null, parserVersion: null, ...over,
});
const review = (over: Partial<ReviewRunInput> = {}): ReviewRunInput => ({
  traceId: `trace-${++n}`, prNumber: 1, repo: "r/r", branch: "b", ticket: null, headSha: "sha", mode: null,
  validationMode: null, modelReview: null, modelValidator: null, bundleSizeChars: null, mustFix: 1, suggestion: 2,
  dismissed: 3, deferred: 0, escalated: 0, crossAgreed: 0, crossClaudeOnly: 0, crossCodexOnly: 0, metricsJson: "{}",
  rigName: "atlas", seatName: "reviewer", startedAt: null, completedAt: "2026-10-06T10:00:00Z", durationSeconds: null,
  logDir: null, sourceHash: null, parserVersion: null, ...over,
});
const snap = (over: Partial<DailyTokenSnapshotInput> = {}): DailyTokenSnapshotInput => ({
  day: "2026-10-06", seatSession: "dev-impl@atlas", rigName: "atlas", seatName: "dev-impl", model: "opus",
  inputTokensDelta: 1000, outputTokensDelta: 500, totalTokensDelta: 1500, samples: 3, resets: 0, schemaVersion: null, ...over,
});

describe("FleetStore aggregation", () => {
  let db: Database;
  let store: FleetStore;
  beforeEach(() => { db = freshDb(); store = new FleetStore(db); });

  it("empty store returns empty rows and a zero summary", () => {
    expect(store.tokensByRigDay()).toEqual({ rows: [], truncated: false });
    expect(store.tokensBySeat().rows).toEqual([]);
    expect(store.reviewsBySeatWeek().rows).toEqual([]);
    expect(store.sessionsByRig().rows).toEqual([]);
    const s = store.summary();
    expect(s.rigs).toEqual([]);
    expect(s.totals.total_tokens).toBe(0);
    expect(s.stats.session_digests.count).toBe(0);
  });

  it("tokensByRigDay sums per rig per day across seats", () => {
    store.upsertSnapshot(snap());
    store.upsertSnapshot(snap({ seatSession: "dev-qa@atlas", seatName: "dev-qa", inputTokensDelta: 10, outputTokensDelta: 5, totalTokensDelta: 15, samples: 1 }));
    store.upsertSnapshot(snap({ rigName: "beta", seatSession: "x@beta", seatName: "x" }));
    store.upsertSnapshot(snap({ day: "2026-10-07", seatSession: "dev-impl@atlas" }));
    const { rows } = store.tokensByRigDay();
    expect(rows.map((r) => [r.day, r.rig_name])).toEqual([
      ["2026-10-07", "atlas"], ["2026-10-06", "atlas"], ["2026-10-06", "beta"],
    ]);
    const atlas6 = rows.find((r) => r.day === "2026-10-06" && r.rig_name === "atlas")!;
    expect(atlas6).toMatchObject({ input_tokens: 1010, output_tokens: 505, total_tokens: 1515, seats: 2, samples: 4 });
  });

  it("falls back to input+output when total_tokens_delta is NULL", () => {
    store.upsertSnapshot(snap({ totalTokensDelta: null }));
    expect(store.tokensByRigDay().rows[0]!.total_tokens).toBe(1500);
  });

  it("sums large numbers without loss below 2^53", () => {
    store.upsertSnapshot(snap({ inputTokensDelta: 4_000_000_000, outputTokensDelta: 1, totalTokensDelta: 4_000_000_001 }));
    store.upsertSnapshot(snap({ seatSession: "b@atlas", seatName: "b", inputTokensDelta: 4_000_000_000, outputTokensDelta: 1, totalTokensDelta: 4_000_000_001 }));
    expect(store.tokensByRigDay().rows[0]!).toMatchObject({ input_tokens: 8_000_000_000, total_tokens: 8_000_000_002 });
  });

  it("labels NULL rig, seat and model instead of dropping them", () => {
    store.upsertSnapshot(snap({ rigName: null, seatName: null, model: null, seatSession: "orphan" }));
    const day = store.tokensByRigDay().rows;
    expect(day).toHaveLength(1);
    expect(day[0]!.rig_name).toBe(UNATTRIBUTED);
    const seat = store.tokensBySeat().rows[0]!;
    expect(seat).toMatchObject({ rig_name: UNATTRIBUTED, seat_name: UNATTRIBUTED, model: "(unknown)" });
    store.upsertDigest(digest({ rigName: null, seatName: null }));
    expect(store.sessionsByRig().rows[0]!.rig_name).toBe(UNATTRIBUTED);
    store.upsertReviewRun(review({ rigName: null, seatName: null }), null);
    expect(store.reviewsBySeatWeek().rows[0]).toMatchObject({ rig_name: UNATTRIBUTED, seat_name: UNATTRIBUTED });
  });

  it("tokensBySeat groups by rig, seat and model and orders by total", () => {
    store.upsertSnapshot(snap());
    store.upsertSnapshot(snap({ day: "2026-10-07", totalTokensDelta: 1500 }));
    store.upsertSnapshot(snap({ seatSession: "big@atlas", seatName: "big", model: "sonnet", inputTokensDelta: 9, outputTokensDelta: 9, totalTokensDelta: 99999 }));
    const { rows } = store.tokensBySeat();
    expect(rows[0]).toMatchObject({ seat_name: "big", model: "sonnet", total_tokens: 99999 });
    expect(rows[1]).toMatchObject({ seat_name: "dev-impl", total_tokens: 3000, days: 2 });
  });

  it("reviewsBySeatWeek buckets by Monday week start, incl. Sunday and week boundary", () => {
    // 2026-10-04 is a Sunday (week of Mon 2026-09-28); 2026-10-05 is a Monday.
    store.upsertReviewRun(review({ completedAt: "2026-10-04T23:59:59Z" }), null);
    store.upsertReviewRun(review({ completedAt: "2026-10-05T00:00:00Z" }), null);
    store.upsertReviewRun(review({ completedAt: "2026-10-11T12:00:00Z" }), null); // Sunday, week of 10-05
    const { rows } = store.reviewsBySeatWeek();
    expect(rows.map((r) => [r.week_start, r.runs])).toEqual([["2026-10-05", 2], ["2026-09-28", 1]]);
    expect(rows[0]).toMatchObject({ must_fix: 2, suggestion: 4, dismissed: 6 });
  });

  it("reviewsBySeatWeek puts NULL completed_at under (undated) and since excludes it", () => {
    store.upsertReviewRun(review({ completedAt: null }), null);
    store.upsertReviewRun(review(), null);
    expect(store.reviewsBySeatWeek().rows.map((r) => r.week_start)).toContain(UNDATED);
    expect(store.reviewsBySeatWeek({ since: "2026-01-01" }).rows.map((r) => r.week_start)).not.toContain(UNDATED);
  });

  it("sessionsByRig sums turns, tokens and escalations", () => {
    store.upsertDigest(digest({ escalationCount: 2 }));
    store.upsertDigest(digest({ escalationCount: 1, totalTurns: 20 }));
    store.upsertDigest(digest({ rigName: "beta" }));
    const { rows } = store.sessionsByRig();
    expect(rows[0]).toMatchObject({ rig_name: "atlas", sessions: 2, total_turns: 30, input_tokens: 200, output_tokens: 100, escalations: 3 });
    expect(rows[1]!.rig_name).toBe("beta");
  });

  it("applies rig, since and until filters (until is inclusive of the whole day)", () => {
    store.upsertSnapshot(snap({ day: "2026-10-01" }));
    store.upsertSnapshot(snap({ day: "2026-10-05" }));
    store.upsertSnapshot(snap({ day: "2026-10-09" }));
    store.upsertSnapshot(snap({ day: "2026-10-05", rigName: "beta", seatSession: "y@beta" }));
    expect(store.tokensByRigDay({ since: "2026-10-02", until: "2026-10-05" }).rows.map((r) => r.day)).toEqual(["2026-10-05", "2026-10-05"]);
    expect(store.tokensByRigDay({ rig: "beta" }).rows).toHaveLength(1);
    store.upsertReviewRun(review({ completedAt: "2026-10-05T18:00:00Z" }), null);
    expect(store.reviewsBySeatWeek({ until: "2026-10-05" }).rows).toHaveLength(1);
    expect(store.reviewsBySeatWeek({ until: "2026-10-04" }).rows).toHaveLength(0);
  });

  it("caps result groups and reports truncation", () => {
    for (let i = 0; i < 5; i++) store.upsertSnapshot(snap({ day: `2026-10-0${i + 1}` }));
    const r = store.tokensByRigDay({ limit: 3 });
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(store.tokensByRigDay({ limit: 5 }).truncated).toBe(false);
    expect(store.tokensByRigDay({ limit: 100000 }).rows).toHaveLength(5);
  });

  it("treats SQL metacharacters in filters as data", () => {
    store.upsertSnapshot(snap());
    expect(store.tokensByRigDay({ rig: "atlas' OR '1'='1" }).rows).toEqual([]);
    expect(store.listSnapshots().total).toBe(1);
  });

  it("summary merges rigs across sources, with totals and last-ingest", () => {
    store.upsertSnapshot(snap());
    store.upsertDigest(digest({ escalationCount: 4 }));
    store.upsertReviewRun(review(), null);
    store.upsertDigest(digest({ rigName: "gamma" })); // sessions only
    const s = store.summary();
    const atlas = s.rigs.find((r) => r.rig_name === "atlas")!;
    expect(atlas).toMatchObject({ sessions: 1, total_tokens: 1500, review_runs: 1, must_fix: 1 });
    expect(s.rigs.find((r) => r.rig_name === "gamma")).toMatchObject({ sessions: 1, total_tokens: 0 });
    expect(s.totals).toMatchObject({ rigs: 2, sessions: 2, total_tokens: 1500, review_runs: 1, escalations: 4 });
    expect(s.stats.session_digests.last_ingested_at).not.toBeNull();
    expect(s.top_seats[0]!.seat_name).toBe("dev-impl");
  });

  it("is read-only: aggregation does not change row counts", () => {
    store.upsertSnapshot(snap());
    const before = JSON.stringify(store.stats());
    store.summary(); store.tokensBySeat(); store.reviewsBySeatWeek(); store.sessionsByRig();
    expect(JSON.stringify(store.stats())).toBe(before);
  });
});

describe("fleet aggregation routes", () => {
  let db: Database;
  let store: FleetStore;
  let app: Hono;
  beforeEach(() => {
    db = freshDb();
    store = new FleetStore(db);
    app = new Hono();
    app.route("/api/fleet", fleetStoreRoutes({ db: () => db }));
  });
  const get = (p: string) => app.request(`/api/fleet${p}`);

  it("returns 200 JSON shapes for each aggregate route", async () => {
    store.upsertSnapshot(snap());
    store.upsertDigest(digest());
    store.upsertReviewRun(review(), null);
    for (const p of ["/aggregate/tokens", "/aggregate/tokens?by=seat", "/aggregate/reviews", "/aggregate/sessions"]) {
      const res = await get(p);
      expect(res.status, p).toBe(200);
      const body = await res.json() as { ok: boolean; rows: unknown[]; truncated: boolean };
      expect(body.ok).toBe(true);
      expect(body.rows.length).toBe(1);
      expect(body.truncated).toBe(false);
    }
    const sum = await (await get("/summary")).json() as { ok: boolean; summary: { totals: { rigs: number } } };
    expect(sum.ok).toBe(true);
    expect(sum.summary.totals.rigs).toBe(1);
  });

  it("is not shadowed by existing param routes", async () => {
    const res = await get("/aggregate/reviews");
    expect(res.status).toBe(200);
    const dash = await get("/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.headers.get("content-type")).toContain("text/html");
    // existing routes still resolve
    expect((await get("/reviews/abc/findings")).status).toBe(200);
    expect((await get("/stats")).status).toBe(200);
  });

  it("rejects bad params with 400 invalid_field", async () => {
    for (const p of [
      "/aggregate/tokens?by=nope", "/aggregate/tokens?limit=0", "/aggregate/tokens?limit=abc",
      "/aggregate/sessions?since=2026-10-01T00:00:00Z", "/aggregate/reviews?until=yesterday",
      "/summary?since=10/01/2026", "/dashboard?since=bad",
    ]) {
      const res = await get(p);
      expect(res.status, p).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_field");
    }
  });

  it("returns 500 fleet_store_error when the store fails", async () => {
    db.exec("DROP TABLE daily_token_snapshots");
    const res = await get("/aggregate/tokens");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("fleet_store_error");
  });

  it("has no write verbs on the new routes", async () => {
    for (const p of ["/aggregate/tokens", "/summary", "/dashboard"]) {
      const res = await app.request(`/api/fleet${p}`, { method: "POST", body: "{}" });
      expect(res.status, p).toBe(404);
    }
  });

  it("dashboard escapes untrusted rig, seat and model names", async () => {
    const evil = `<script>alert(1)</script>"&'`;
    store.upsertSnapshot(snap({ rigName: evil, seatName: evil, model: evil, seatSession: "e" }));
    store.upsertDigest(digest({ rigName: evil }));
    store.upsertReviewRun(review({ rigName: evil, seatName: evil }), null);
    const html = await (await get("/dashboard")).text();
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;");
  });

  it("dashboard renders an empty state and a populated page without external assets", async () => {
    const empty = await (await get("/dashboard")).text();
    expect(empty).toContain("no data yet");
    store.upsertSnapshot(snap());
    store.upsertDigest(digest());
    store.upsertReviewRun(review(), null);
    const html = await (await get("/dashboard")).text();
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("Rig activity");
    expect(html).toContain("Data as of");
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//);
  });
});

describe("renderFleetDashboard", () => {
  it("escapeHtml escapes all five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  it("escapes filter values in the header", () => {
    const s = new FleetStore(freshDb()).summary();
    expect(renderFleetDashboard(s, { filters: { rig: `"><img src=x>` } })).not.toContain("<img");
  });
});
