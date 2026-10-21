import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { reviewRunsSchema } from "../src/db/migrations/097_review_runs.js";
import { reviewFindingsSchema } from "../src/db/migrations/098_review_findings.js";
import { reviewSuppressRulesSchema } from "../src/db/migrations/109_review_suppress_rules.js";
import { FleetStore, type ReviewRunInput, type ReviewFindingInput } from "../src/domain/fleet-store.js";

function freshDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(reviewRunsSchema.sql);
  db.exec(reviewFindingsSchema.sql);
  db.exec(reviewSuppressRulesSchema.sql);
  return db;
}

const run: ReviewRunInput = {
  traceId: "trace-001", prNumber: 11, repo: "duncanleung/openrig", branch: "b", ticket: null, headSha: "abc",
  mode: "default", validationMode: "dual-stack", modelReview: "m", modelValidator: "v", bundleSizeChars: 1,
  mustFix: 0, suggestion: 1, dismissed: 0, deferred: 0, escalated: 0, crossAgreed: 0, crossClaudeOnly: 0,
  crossCodexOnly: 0, metricsJson: "{}", rigName: "r", seatName: "s", startedAt: "2026-10-05T23:49:58Z",
  completedAt: "2026-10-05T23:55:00Z", durationSeconds: 1, logDir: "/tmp", sourceHash: "h1", parserVersion: "1",
};
const finding: ReviewFindingInput = {
  runTraceId: "trace-001", findingId: "f-001", file: "a.ts", lines: "1", category: "style", hunterKey: "k",
  stack: "claude", score: 50, verdict: "SUGGESTION", hasFixSpec: 0, descriptionPrefix: "x", descriptionHash: "h",
};

let db: Database;
let store: FleetStore;
beforeEach(() => {
  db = freshDb();
  store = new FleetStore(db);
  store.upsertReviewRun(run, [finding]);
});

const action = () =>
  (db.prepare("SELECT user_action AS a FROM review_findings WHERE finding_id = 'f-001'").get() as { a: string | null }).a;

describe("setUserAction", () => {
  it("sets, changes and clears the action", () => {
    expect(action()).toBeNull();
    expect(store.setUserAction("trace-001", "f-001", "dismissed")).toBe(true);
    expect(action()).toBe("dismissed");
    expect(store.setUserAction("trace-001", "f-001", "fixed-before-merge")).toBe(true);
    expect(action()).toBe("fixed-before-merge");
    expect(store.setUserAction("trace-001", "f-001", null)).toBe(true);
    expect(action()).toBeNull();
  });

  it("rejects an invalid action and leaves the row alone", () => {
    expect(() => store.setUserAction("trace-001", "f-001", "ignored" as never)).toThrow(/invalid user_action/);
    expect(action()).toBeNull();
  });

  it("returns false for a missing finding", () => {
    expect(store.setUserAction("trace-001", "nope", "accepted")).toBe(false);
    expect(store.setUserAction("nope", "f-001", "accepted")).toBe(false);
  });

  it("survives a re-ingest of the same run", () => {
    store.setUserAction("trace-001", "f-001", "deferred");
    store.upsertReviewRun({ ...run, sourceHash: "h2", suggestion: 2 }, [{ ...finding, score: 90 }]);
    expect(action()).toBe("deferred");
  });
});

describe("schema constraints", () => {
  it("rejects a bad user_action at the database", () => {
    expect(() => db.prepare("UPDATE review_findings SET user_action = 'bogus'").run()).toThrow(/CHECK/);
  });

  it("rejects a rule with no matcher", () => {
    expect(() =>
      db.prepare("INSERT INTO review_suppress_rules (repo, reason, status, quarantined_pr) VALUES ('r','x','active',NULL)").run(),
    ).toThrow(/CHECK/);
  });

  it("rejects a quarantined rule with no source PR", () => {
    expect(() =>
      db.prepare("INSERT INTO review_suppress_rules (repo, category, reason, status) VALUES ('r','c','x','quarantined')").run(),
    ).toThrow(/CHECK/);
  });
});

describe("suppress rule CRUD", () => {
  it("creates a quarantined rule by default and lists it", () => {
    const r = store.createSuppressRule({ repo: "r", category: "style", reason: "noise", quarantinedPr: 7 });
    expect(r).toMatchObject({ status: "quarantined", quarantinedPr: 7, matchCount: 0, lastMatchedAt: null, fileGlob: null });
    expect(store.listSuppressRules()).toEqual([r]);
  });

  it("creates an active rule without a PR", () => {
    const r = store.createSuppressRule({ repo: "r", fileGlob: "*.md", reason: "docs", status: "active" });
    expect(r.status).toBe("active");
    expect(r.quarantinedPr).toBeNull();
  });

  it("refuses a rule with no matcher, no reason, no PR, or a retired start", () => {
    expect(() => store.createSuppressRule({ repo: "r", reason: "x", status: "active" })).toThrow(/matcher/);
    expect(() => store.createSuppressRule({ repo: "r", category: "c", reason: "  ", status: "active" })).toThrow(/reason/);
    expect(() => store.createSuppressRule({ repo: "r", category: "c", reason: "x" })).toThrow(/source PR/);
    expect(() => store.createSuppressRule({ repo: "r", category: "c", reason: "x", status: "retired" as never })).toThrow(/cannot start/);
  });

  it("filters by repo and status", () => {
    store.createSuppressRule({ repo: "a", category: "c", reason: "x", status: "active" });
    const b = store.createSuppressRule({ repo: "b", category: "c", reason: "x", quarantinedPr: 1 });
    expect(store.listSuppressRules({ repo: "b" })).toEqual([b]);
    expect(store.listSuppressRules({ status: "active" })).toHaveLength(1);
    expect(store.listSuppressRules({ repo: "a", status: "quarantined" })).toEqual([]);
  });

  it("retires a rule, keeps the row, and returns false the second time", () => {
    const r = store.createSuppressRule({ repo: "r", category: "c", reason: "x", status: "active" });
    expect(store.retireSuppressRule(r.id)).toBe(true);
    expect(store.listSuppressRules({ status: "retired" })).toHaveLength(1);
    expect(store.retireSuppressRule(r.id)).toBe(false);
    expect(store.retireSuppressRule(9999)).toBe(false);
  });

  it("records matches: count adds per entry and last_matched_at is set", () => {
    const a = store.createSuppressRule({ repo: "r", category: "c", reason: "x", status: "active" });
    const b = store.createSuppressRule({ repo: "r", category: "d", reason: "x", status: "active" });
    store.recordSuppressMatches([a.id, a.id]);
    const [ra, rb] = store.listSuppressRules();
    expect(ra!.matchCount).toBe(2);
    expect(ra!.lastMatchedAt).not.toBeNull();
    expect(rb!.id).toBe(b.id);
    expect(rb!.matchCount).toBe(0);
    expect(rb!.lastMatchedAt).toBeNull();
  });
});
