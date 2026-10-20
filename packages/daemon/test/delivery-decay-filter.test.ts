// RIG-111 — delivery-time decay filter: mechanics only (stub data, no model calls, no winner chosen).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import {
  AccessWeightedRetention, DreamingPromotionGates, noDecayFilter, type DecayItem, type DeliveryDecayFilter,
} from "../src/domain/delivery-decay-filter.js";
import { deliveredPaths, lostCorrections, runMemoryComparison, type DecayScenario } from "./helpers/eval-memory-comparison.js";
import { FakeProvider } from "./helpers/eval-provider.js";

const NOW = new Date("2026-10-20T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const item = (surface: string, path: string, ageDays: number, accessCount = 0): DecayItem =>
  ({ surface, path, lastAccess: daysAgo(ageDays), accessCount });

describe("AccessWeightedRetention", () => {
  const f = new AccessWeightedRetention({ ttlDaysBySurface: { wiki: 10 }, accessBonus: 0.5, now: () => NOW });
  it("delivers a surface inside its ttl and drops it past it", () => {
    expect(f.shouldDeliver(item("wiki", "a", 10))).toBe(true);
    expect(f.shouldDeliver(item("wiki", "a", 11))).toBe(false);
  });
  it("extends the ttl with each access", () => {
    expect(f.shouldDeliver(item("wiki", "a", 14, 0))).toBe(false);
    expect(f.shouldDeliver(item("wiki", "a", 14, 1))).toBe(true); // 10 * 1.5 = 15
    expect(f.shouldDeliver(item("wiki", "a", 26, 3))).toBe(false); // 10 * 2.5 = 25
  });
  it("never decays a surface it has no ttl for", () => {
    expect(f.shouldDeliver(item("guidance", "CLAUDE.md", 9999))).toBe(true);
  });
});

describe("DreamingPromotionGates", () => {
  const f = new DreamingPromotionGates({
    ephemeralTtlDays: { "restore-packet": 2 }, durableDemoteAfterDays: { wiki: 30 }, promoteMinAccessCount: 3, now: () => NOW,
  });
  it("expires ephemeral items and demotes stale durable ones", () => {
    expect(f.shouldDeliver(item("restore-packet", "r", 1))).toBe(true);
    expect(f.shouldDeliver(item("restore-packet", "r", 3))).toBe(false);
    expect(f.shouldDeliver(item("wiki", "w", 30))).toBe(true);
    expect(f.shouldDeliver(item("wiki", "w", 31))).toBe(false);
    expect(f.shouldDeliver(item("skill", "s", 999))).toBe(true);
  });
  it("names promotion candidates without writing anything", () => {
    const items = [item("restore-packet", "hot", 1, 5), item("restore-packet", "cold", 1, 1), item("restore-packet", "gone", 9, 9), item("wiki", "w", 1, 9)];
    expect(f.promotionCandidates(items).map((i) => i.path)).toEqual(["hot"]);
  });
});

describe("decay scenarios on the RIG-110 harness", () => {
  const items = [item("wiki", "wiki/fresh.md", 1), item("wiki", "wiki/old.md", 40), item("guidance", "CLAUDE.md", 400)];
  const scenarios: DecayScenario[] = [
    { id: "d1", name: "fresh correction survives", priorCorrection: "x", prompt: "P1", expectedBehavior: ["fresh"], items, mustDeliver: ["wiki/fresh.md"] },
    { id: "d2", name: "old correction is erased by decay", priorCorrection: "y", prompt: "P2", expectedBehavior: ["old"], items, mustDeliver: ["wiki/old.md"] },
  ];
  const decay = new AccessWeightedRetention({ ttlDaysBySurface: { wiki: 30 }, now: () => NOW });

  it("lists what a filter delivers, and no-decay delivers everything", () => {
    expect(deliveredPaths(items, decay)).toEqual(["wiki/fresh.md", "CLAUDE.md"]);
    expect(deliveredPaths(items, noDecayFilter)).toHaveLength(3);
  });
  it("flags scenarios whose correction source decay would drop", () => {
    expect(lostCorrections(scenarios, decay)).toEqual(["d2"]);
    expect(lostCorrections(scenarios, noDecayFilter)).toEqual([]);
  });
  it("scores with-decay against without-decay through the unchanged scorer", async () => {
    const without = new FakeProvider({ P1: "fresh", P2: "old" });
    const withDecay = new FakeProvider({ P1: "fresh", P2: "unknown" });
    const r = await runMemoryComparison(scenarios, { withMemory: without, withoutMemory: withDecay });
    expect(r.improvementScore).toBe(0.5);
    expect(r.scenarios.map((s) => s.verdict)).toEqual(["both_pass", "improved"]);
  });
});

describe("StartupOrchestrator + decay filter", () => {
  let db: Database.Database; let dir: string;
  beforeEach(() => { db = createFullTestDb(); dir = mkdtempSync(join(tmpdir(), "rig111-")); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, ageDays: number): ResolvedStartupFile {
    const abs = join(dir, name);
    writeFileSync(abs, "# content");
    const t = daysAgo(ageDays).getTime() / 1000;
    utimesSync(abs, t, t);
    return { path: `wiki/${name}`, absolutePath: abs, ownerRoot: ".", deliveryHint: "send_text", required: false, appliesOn: ["fresh_start"] };
  }

  async function run(files: ResolvedStartupFile[], decayFilter?: DeliveryDecayFilter) {
    const sessionRegistry = new SessionRegistry(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("decay-rig");
    const node = rigRepo.addNode(rig.id, "seat", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    const tmux = { sendText: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => true), sendKeys: vi.fn(async () => ({ ok: true as const })), listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []) } as unknown as TmuxAdapter;
    const orch = new StartupOrchestrator({ db, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: tmux, readFile: () => "x", sleep: async () => {}, decayFilter });
    const input: StartupInput = {
      rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "b", nodeId: node.id, tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." },
      adapter: { runtime: "claude-code", listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })), deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady: vi.fn(async () => ({ ready: true })), launchHarness: vi.fn(async () => ({ ok: true })) },
      plan: { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: files, startupActions: [], isRestore: false,
    } as unknown as StartupInput;
    const result = await orch.startNode(input);
    const row = db.prepare("SELECT payload FROM events WHERE type = 'node.startup_delivery_manifest'").get() as { payload: string } | undefined;
    return { result, paths: row ? (JSON.parse(row.payload).deliveredFiles as Array<{ path: string }>).map((d) => d.path) : [] };
  }

  const decay = new AccessWeightedRetention({ ttlDaysBySurface: { wiki: 30 } });

  it("is a no-op when no filter is set", async () => {
    const { paths } = await run([file("fresh.md", 1), file("old.md", 90)]);
    expect(paths).toEqual(["wiki/fresh.md", "wiki/old.md"]);
  });

  it("skips a stale file, keeps a fresh one, and says so in the warnings", async () => {
    const { paths, result } = await run([file("fresh.md", 1), file("old.md", 90)], decay);
    expect(paths).toEqual(["wiki/fresh.md"]);
    expect(result.warnings?.some((w) => w.includes("access-weighted-retention skipped wiki/old.md"))).toBe(true);
  });

  it("delivers the file when the filter throws", async () => {
    const boom: DeliveryDecayFilter = { name: "boom", shouldDeliver: () => { throw new Error("x"); } };
    const { paths } = await run([file("old.md", 90)], boom);
    expect(paths).toEqual(["wiki/old.md"]);
  });

  it("delivers the file when its mtime cannot be read", async () => {
    const f = file("gone.md", 90);
    const { paths } = await run([{ ...f, absolutePath: join(dir, "missing.md") }], decay);
    expect(paths).toEqual(["wiki/gone.md"]);
  });
});
