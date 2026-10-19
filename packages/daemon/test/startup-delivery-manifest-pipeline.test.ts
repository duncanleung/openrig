/**
 * RIG-108: memory observation pipeline tests.
 *
 * The pipeline: StartupOrchestrator emits node.startup_delivery_manifest, the event
 * bus stores it in the daemon DB, and scripts/analyze-memory-usage.py (kept in the
 * separate openrig-memory repo) reads it back.
 *
 * Two layers:
 *  1. Contract: the stored payload keeps the fields the analysis tool reads, with the
 *     right types. A rename or a removal fails here, with the field named.
 *  2. End to end: the real stored event goes through the real Python reader. The reader
 *     uses payload.get(...) with defaults, so a renamed field gives zeros and no error.
 *     Only a test that checks the counts can see that.
 *
 * The end-to-end test needs python3 and a checkout of openrig-memory. It looks in
 * $OPENRIG_MEMORY_DIR, then in a folder named openrig-memory next to this repo. When
 * neither exists the test is reported as skipped, never as passed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// -- Harness (same shape as eval-memory-delivery.test.ts) --

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockAdapter(): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

function makeBinding(): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." };
}

// Three files: one pre-launch (guidance_merge) and two post-launch (send_text), on two surfaces.
const FILES = [
  { path: "CLAUDE.md", hint: "guidance_merge", content: "# Project rules" },
  { path: "guidance/role.md", hint: "send_text", content: "You are the dev-impl seat." },
  { path: "agent_spec/orchestrator.md", hint: "send_text", content: "Role: orchestrator" },
] as const;

// -- Contract: what the analysis tool reads --
// Keep this list in step with query_delivery_manifests() in
// openrig-memory/scripts/analyze-memory-usage.py.
const MANIFEST_TOP_LEVEL = ["sessionName", "deliveredFiles", "summary"] as const;
const MANIFEST_SUMMARY = ["preLaunchCount", "postLaunchCount", "surfaceCounts"] as const;
const MANIFEST_FILE_FIELDS = ["path", "deliveryHint", "surface", "phase", "contentHash"] as const;

// -- Where the analysis tool lives --

function findAnalyzer(): string | null {
  const candidates: string[] = [];
  if (process.env.OPENRIG_MEMORY_DIR) candidates.push(resolve(process.env.OPENRIG_MEMORY_DIR));
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", cwd: __dirname }).trim();
    candidates.push(resolve(dirname(common), "..", "openrig-memory"));
  } catch {
    // not a git checkout: only the env var can point at the tool
  }
  for (const dir of candidates) {
    const script = join(dir, "scripts", "analyze-memory-usage.py");
    if (existsSync(script)) return script;
  }
  return null;
}

function python3Available(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ANALYZER = findAnalyzer();
const CAN_RUN_E2E = ANALYZER !== null && python3Available();

describe("Delivery manifest pipeline (RIG-108)", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
  });

  afterEach(() => { db.close(); });

  async function startWithFiles(files: readonly { path: string; hint: string; content: string }[]) {
    const rig = rigRepo.createRig("pipeline-rig");
    const node = rigRepo.addNode(rig.id, "pipeline-seat", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const resolved: ResolvedStartupFile[] = files.map((f, i) => ({
      path: f.path,
      absolutePath: `/pipeline/${i}/${f.path}`,
      ownerRoot: ".",
      deliveryHint: f.hint as ResolvedStartupFile["deliveryHint"],
      required: false,
      appliesOn: ["fresh_start"] as ResolvedStartupFile["appliesOn"],
    }));
    const contents = new Map(files.map((f, i) => [`/pipeline/${i}/${f.path}`, f.content]));
    const input: StartupInput = {
      rigId: rig.id,
      nodeId: node.id,
      sessionId: session.id,
      binding: makeBinding(),
      adapter: mockAdapter(),
      plan: emptyPlan(),
      resolvedStartupFiles: resolved,
      startupActions: [],
      isRestore: false,
    };
    const orch = new StartupOrchestrator({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: mockTmux(),
      readFile: (p: string) => contents.get(p) ?? "",
      sleep: async () => {},
    });
    await orch.startNode(input);
    return { nodeId: node.id };
  }

  function storedManifests(): Array<Record<string, unknown>> {
    const rows = db.prepare(
      "SELECT payload FROM events WHERE type = 'node.startup_delivery_manifest'"
    ).all() as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload));
  }

  describe("schema contract", () => {
    it("stored manifest keeps every top-level field the analysis tool reads", async () => {
      await startWithFiles(FILES);
      const manifests = storedManifests();
      expect(manifests).toHaveLength(1);
      for (const key of MANIFEST_TOP_LEVEL) {
        expect(manifests[0], `manifest lost top-level field "${key}"`).toHaveProperty(key);
      }
      expect(typeof manifests[0].sessionName).toBe("string");
      expect(Array.isArray(manifests[0].deliveredFiles)).toBe(true);
    });

    it("summary keeps its counters and surfaceCounts map", async () => {
      await startWithFiles(FILES);
      const summary = storedManifests()[0].summary as Record<string, unknown>;
      for (const key of MANIFEST_SUMMARY) {
        expect(summary, `manifest summary lost "${key}"`).toHaveProperty(key);
      }
      expect(typeof summary.preLaunchCount).toBe("number");
      expect(typeof summary.postLaunchCount).toBe("number");
      expect(summary.surfaceCounts !== null && typeof summary.surfaceCounts === "object").toBe(true);
    });

    it("each delivered file keeps path, deliveryHint, surface, phase and contentHash", async () => {
      await startWithFiles(FILES);
      const files = storedManifests()[0].deliveredFiles as Array<Record<string, unknown>>;
      expect(files).toHaveLength(FILES.length);
      for (const file of files) {
        for (const key of MANIFEST_FILE_FIELDS) {
          expect(file, `delivered file lost "${key}"`).toHaveProperty(key);
          expect(typeof file[key], `delivered file field "${key}" changed type`).toBe("string");
        }
        expect(["pre_launch", "post_launch"]).toContain(file.phase);
      }
    });

    it("counts agree with the delivered files", async () => {
      await startWithFiles(FILES);
      const manifest = storedManifests()[0] as {
        deliveredFiles: Array<{ surface: string; phase: string }>;
        summary: { preLaunchCount: number; postLaunchCount: number; surfaceCounts: Record<string, number> };
      };
      const { deliveredFiles, summary } = manifest;
      expect(summary.preLaunchCount + summary.postLaunchCount).toBe(deliveredFiles.length);
      expect(summary.preLaunchCount).toBe(deliveredFiles.filter((f) => f.phase === "pre_launch").length);
      const total = Object.values(summary.surfaceCounts).reduce((a, b) => a + b, 0);
      expect(total).toBe(deliveredFiles.length);
      for (const f of deliveredFiles) expect(summary.surfaceCounts[f.surface]).toBeGreaterThan(0);
    });

    it("a startup that delivers no files emits no manifest", async () => {
      await startWithFiles([]);
      expect(storedManifests()).toHaveLength(0);
    });
  });

  describe("end to end through the analysis tool", () => {
    function runAnalyzer(dbPath: string): Record<string, unknown> {
      const code = [
        "import importlib.util, json, sys",
        "spec = importlib.util.spec_from_file_location('analyze_memory_usage', sys.argv[1])",
        "mod = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mod)",
        "print(json.dumps(mod.query_delivery_manifests(sys.argv[2])))",
      ].join("\n");
      const out = execFileSync("python3", ["-I", "-c", code, ANALYZER!, dbPath], { encoding: "utf8" });
      return JSON.parse(out);
    }

    function dumpDb(): { dir: string; path: string } {
      const dir = mkdtempSync(join(tmpdir(), "rig108-"));
      const path = join(dir, "openrig.sqlite");
      writeFileSync(path, db.serialize());
      return { dir, path };
    }

    it.skipIf(!CAN_RUN_E2E)("emitted manifest is stored and read back with the right counts", async () => {
      await startWithFiles(FILES);
      const { dir, path } = dumpDb();
      try {
        const result = runAnalyzer(path) as {
          available: boolean;
          manifest_count: number;
          manifests: Array<{ session_name: string; file_count: number; surfaces: string[]; summary: { surfaceCounts: Record<string, number> } }>;
        };
        expect(result.available).toBe(true);
        expect(result.manifest_count).toBe(1);
        const m = result.manifests[0];
        expect(m.session_name).toBe("r01-impl");
        expect(m.file_count).toBe(FILES.length);
        expect(m.surfaces.length).toBeGreaterThan(0);
        const stored = storedManifests()[0] as { summary: { surfaceCounts: Record<string, number> } };
        expect(m.summary.surfaceCounts).toEqual(stored.summary.surfaceCounts);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(!CAN_RUN_E2E)("a database with no manifests reads back as zero, not as an error", async () => {
      await startWithFiles([]);
      const { dir, path } = dumpDb();
      try {
        const result = runAnalyzer(path) as { available: boolean; manifest_count: number; manifests: unknown[] };
        expect(result.available).toBe(true);
        expect(result.manifest_count).toBe(0);
        expect(result.manifests).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
