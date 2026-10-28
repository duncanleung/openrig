// RIG-111 — the decay filter is applied by the startup orchestrator when it partitions startup files.
// delivery-decay-filter.test.ts asserts through the node.startup_delivery_manifest event, which merge
// e02d09c64 also removed; this test asserts on what the orchestrator actually hands to the seat, so it
// does not depend on the manifest.
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
import { AccessWeightedRetention, type DeliveryDecayFilter } from "../src/domain/delivery-decay-filter.js";

const NOW = new Date("2026-10-20T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("StartupOrchestrator applies the decay filter (RIG-111)", () => {
  let db: Database.Database; let dir: string;
  beforeEach(() => { db = createFullTestDb(); dir = mkdtempSync(join(tmpdir(), "rig111-")); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, ageDays: number): ResolvedStartupFile {
    const abs = join(dir, name);
    writeFileSync(abs, `# content-of-${name}`);
    const t = daysAgo(ageDays).getTime() / 1000;
    utimesSync(abs, t, t);
    return { path: `wiki/${name}`, absolutePath: abs, ownerRoot: ".", deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start"] };
  }

  async function run(files: ResolvedStartupFile[], decayFilter?: DeliveryDecayFilter) {
    const sessionRegistry = new SessionRegistry(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("decay-rig");
    const node = rigRepo.addNode(rig.id, "seat", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    const tmux = { sendText: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => true), sendKeys: vi.fn(async () => ({ ok: true as const })), listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []) } as unknown as TmuxAdapter;
    const orch = new StartupOrchestrator({ db, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: tmux, readFile: (p: string) => `# content-of-${p.split("/").pop()}`, sleep: async () => {}, decayFilter });
    const input: StartupInput = {
      rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "b", nodeId: node.id, tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." },
      adapter: { runtime: "claude-code", listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })), deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady: vi.fn(async () => ({ ready: true })), launchHarness: vi.fn(async () => ({ ok: true })) },
      plan: { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: files, startupActions: [], isRestore: false,
    } as unknown as StartupInput;
    const result = await orch.startNode(input);
    // Pre-launch files (guidance_merge) are what the orchestrator hands to the adapter.
    const deliverStartup = input.adapter.deliverStartup as unknown as { mock: { calls: Array<[ResolvedStartupFile[]]> } };
    const paths = deliverStartup.mock.calls.flatMap((c) => c[0].map((f) => f.path));
    return { result, paths };
  }

  // guidance_merge files classify as the "guidance" surface.
  const decay = new AccessWeightedRetention({ ttlDaysBySurface: { guidance: 30 } });

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
