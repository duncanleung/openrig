/**
 * RIG-36 item 2: Memory delivery evaluation suite.
 *
 * Deterministic scenarios that verify the delivery pipeline routes each
 * memory surface correctly: file → partition (pre/post launch) → surface
 * classification → manifest event. Each scenario represents a real
 * correction or knowledge artifact an agent would encounter.
 *
 * Namespace: openrig.memory.* (decided 2026-09-29, RIG-36)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// -- Test infrastructure --

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

// -- Scenario definitions --

interface DeliveryScenario {
  name: string;
  file: {
    path: string;
    deliveryHint: string;
    content: string;
  };
  expected: {
    surface: string;
    phase: "pre_launch" | "post_launch";
    resolvedHint: string;
  };
}

const SCENARIOS: DeliveryScenario[] = [
  // -- Tier 1: Instruction authority --
  {
    name: "role guidance via guidance_merge",
    file: { path: "guidance/role.md", deliveryHint: "guidance_merge", content: "You are the orchestrator lead." },
    expected: { surface: "guidance", phase: "pre_launch", resolvedHint: "guidance_merge" },
  },
  {
    name: "role guidance via send_text (pattern match)",
    file: { path: "guidance/role.md", deliveryHint: "send_text", content: "You are the dev-impl seat." },
    expected: { surface: "role", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "CLAUDE.md project instructions",
    file: { path: "CLAUDE.md", deliveryHint: "guidance_merge", content: "# Project rules" },
    expected: { surface: "guidance", phase: "pre_launch", resolvedHint: "guidance_merge" },
  },
  {
    name: "CLAUDE.md via send_text",
    file: { path: "CLAUDE.md", deliveryHint: "send_text", content: "# Project rules" },
    expected: { surface: "guidance", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "openrig-start identity bootstrap",
    file: { path: "openrig-start.md", deliveryHint: "guidance_merge", content: "# OpenRig Start" },
    expected: { surface: "guidance", phase: "pre_launch", resolvedHint: "guidance_merge" },
  },
  {
    name: "openrig-project-guidance universal features",
    file: { path: "openrig-project-guidance.md", deliveryHint: "guidance_merge", content: "# Project guidance" },
    expected: { surface: "guidance", phase: "pre_launch", resolvedHint: "guidance_merge" },
  },
  {
    name: "agent_spec role definition",
    file: { path: "agent_spec/orchestrator.md", deliveryHint: "send_text", content: "Role: orchestrator" },
    expected: { surface: "role", phase: "post_launch", resolvedHint: "send_text" },
  },

  // -- Tier 2: Skills --
  {
    name: "skill via skill_install hint",
    file: { path: "skills/wiki-update/SKILL.md", deliveryHint: "skill_install", content: "# SKILL wiki-update" },
    expected: { surface: "skill", phase: "pre_launch", resolvedHint: "skill_install" },
  },
  {
    name: "skill in nested directory",
    file: { path: "skills/code-review/dual/SKILL.md", deliveryHint: "skill_install", content: "# SKILL dual review" },
    expected: { surface: "skill", phase: "pre_launch", resolvedHint: "skill_install" },
  },
  {
    name: "skill via auto hint (content detection)",
    file: { path: "custom-skill.md", deliveryHint: "auto", content: "# SKILL Custom Tool\nDoes things." },
    expected: { surface: "skill", phase: "pre_launch", resolvedHint: "skill_install" },
  },

  // -- Tier 3: Wiki (project evidence, untrusted) --
  {
    name: "wiki convention page",
    file: { path: "wiki/tailwind-class-ordering.md", deliveryHint: "send_text", content: "---\ntype: convention\n---" },
    expected: { surface: "wiki", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "wiki correction page",
    file: { path: "wiki/no-upstream-pr-review.md", deliveryHint: "send_text", content: "---\ntype: correction\n---\nNever review upstream PRs." },
    expected: { surface: "wiki", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "wiki episode page",
    file: { path: "wiki/debugged-flaky-instantiator.md", deliveryHint: "send_text", content: "---\ntype: episode\n---" },
    expected: { surface: "wiki", phase: "post_launch", resolvedHint: "send_text" },
  },

  // -- Tier 4: ADRs --
  {
    name: "ADR in decisions directory",
    file: { path: "decisions/0005-separate-guidance-file.md", deliveryHint: "send_text", content: "---\nstatus: accepted\n---" },
    expected: { surface: "adr", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "ADR in docs/decisions path",
    file: { path: "docs/decisions/0001-migrate-skills.md", deliveryHint: "send_text", content: "---\nstatus: proposed\n---" },
    expected: { surface: "adr", phase: "post_launch", resolvedHint: "send_text" },
  },

  // -- Tier 5: Restore packets --
  {
    name: "restore packet",
    file: { path: "restore/packet-abc123.md", deliveryHint: "send_text", content: "## Working State" },
    expected: { surface: "restore-packet", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "restore context with different naming",
    file: { path: "restore-context.md", deliveryHint: "send_text", content: "## Restore Context" },
    expected: { surface: "restore-packet", phase: "post_launch", resolvedHint: "send_text" },
  },

  // -- Tier 6: Context packs --
  {
    name: "context pack file",
    file: { path: "context-pack/world/profile.md", deliveryHint: "send_text", content: "World context" },
    expected: { surface: "context-pack", phase: "post_launch", resolvedHint: "send_text" },
  },

  // -- Tier 7: Auto-resolved hints --
  {
    name: "auto hint resolves to guidance_merge for .md file",
    file: { path: "onboarding.md", deliveryHint: "auto", content: "You are an agent in OpenRig." },
    expected: { surface: "guidance", phase: "pre_launch", resolvedHint: "guidance_merge" },
  },
  {
    name: "auto hint resolves to send_text for non-.md file",
    file: { path: "config.yaml", deliveryHint: "auto", content: "key: value" },
    expected: { surface: "other", phase: "post_launch", resolvedHint: "send_text" },
  },

  // -- Edge cases --
  {
    name: "unrecognized file falls to 'other'",
    file: { path: "random-notes.txt", deliveryHint: "send_text", content: "some notes" },
    expected: { surface: "other", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "empty content still produces a hash",
    file: { path: "guidance/empty.md", deliveryHint: "guidance_merge", content: "" },
    expected: { surface: "guidance", phase: "pre_launch", resolvedHint: "guidance_merge" },
  },
  {
    name: "deeply nested skill path",
    file: { path: "skills/core/openrig-skills/SKILL.md", deliveryHint: "skill_install", content: "# SKILL" },
    expected: { surface: "skill", phase: "pre_launch", resolvedHint: "skill_install" },
  },
  {
    name: "wiki index page",
    file: { path: "wiki/index.md", deliveryHint: "send_text", content: "# Wiki Index" },
    expected: { surface: "wiki", phase: "post_launch", resolvedHint: "send_text" },
  },
  {
    name: "culture file as guidance",
    file: { path: "CULTURE.md", deliveryHint: "guidance_merge", content: "# Culture" },
    expected: { surface: "guidance", phase: "pre_launch", resolvedHint: "guidance_merge" },
  },
];

// -- Test suite --

describe("Memory delivery evaluation suite (RIG-36)", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;
  let tmux: TmuxAdapter;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
    tmux = mockTmux();
  });

  afterEach(() => { db.close(); });

  function seedSession() {
    const rig = rigRepo.createRig("eval-rig");
    const node = rigRepo.addNode(rig.id, "eval-seat", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(seed: { rigId: string; nodeId: string; sessionId: string }, files: ResolvedStartupFile[]): StartupInput {
    return {
      rigId: seed.rigId,
      nodeId: seed.nodeId,
      sessionId: seed.sessionId,
      binding: makeBinding(),
      adapter: mockAdapter(),
      plan: emptyPlan(),
      resolvedStartupFiles: files,
      startupActions: [],
      isRestore: false,
    };
  }

  // Run each scenario as its own test
  for (const scenario of SCENARIOS) {
    it(`scenario: ${scenario.name}`, async () => {
      const seed = seedSession();
      const fileContent = scenario.file.content;

      const file: ResolvedStartupFile = {
        path: scenario.file.path,
        absolutePath: `/eval/${scenario.file.path}`,
        ownerRoot: ".",
        deliveryHint: scenario.file.deliveryHint as ResolvedStartupFile["deliveryHint"],
        required: false,
        appliesOn: ["fresh_start"],
      };

      const orch = new StartupOrchestrator({
        db,
        sessionRegistry,
        eventBus,
        tmuxAdapter: tmux,
        readFile: () => fileContent,
        sleep: async () => {},
      });

      await orch.startNode(makeInput(seed, [file]));

      const row = db.prepare(
        "SELECT payload FROM events WHERE type = 'node.startup_delivery_manifest'"
      ).get() as { payload: string } | undefined;

      expect(row, `manifest event missing for "${scenario.name}"`).toBeDefined();
      const payload = JSON.parse(row!.payload);
      expect(payload.deliveredFiles).toHaveLength(1);

      const delivered = payload.deliveredFiles[0];
      expect(delivered.surface).toBe(scenario.expected.surface);
      expect(delivered.phase).toBe(scenario.expected.phase);
      expect(delivered.deliveryHint).toBe(scenario.expected.resolvedHint);
      expect(delivered.path).toBe(scenario.file.path);
      expect(typeof delivered.contentHash).toBe("string");
    });
  }

  // Aggregate evaluation: run all scenarios together and verify no collisions
  it("all scenarios delivered together produce correct surface counts", async () => {
    const seed = seedSession();

    const files: ResolvedStartupFile[] = SCENARIOS.map((s, i) => ({
      path: s.file.path,
      absolutePath: `/eval/${i}/${s.file.path}`,
      ownerRoot: ".",
      deliveryHint: s.file.deliveryHint as ResolvedStartupFile["deliveryHint"],
      required: false,
      appliesOn: ["fresh_start"] as ResolvedStartupFile["appliesOn"],
    }));

    const contentMap = new Map<string, string>();
    SCENARIOS.forEach((s, i) => {
      contentMap.set(`/eval/${i}/${s.file.path}`, s.file.content);
    });

    const orch = new StartupOrchestrator({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux,
      readFile: (path: string) => contentMap.get(path) ?? "",
      sleep: async () => {},
    });

    await orch.startNode(makeInput(seed, files));

    const row = db.prepare(
      "SELECT payload FROM events WHERE type = 'node.startup_delivery_manifest'"
    ).get() as { payload: string };
    const payload = JSON.parse(row.payload);

    expect(payload.deliveredFiles).toHaveLength(SCENARIOS.length);

    // Count expected surfaces
    const expectedSurfaceCounts: Record<string, number> = {};
    for (const s of SCENARIOS) {
      expectedSurfaceCounts[s.expected.surface] = (expectedSurfaceCounts[s.expected.surface] ?? 0) + 1;
    }
    expect(payload.summary.surfaceCounts).toEqual(expectedSurfaceCounts);

    // Count expected phases
    const expectedPreLaunch = SCENARIOS.filter(s => s.expected.phase === "pre_launch").length;
    const expectedPostLaunch = SCENARIOS.filter(s => s.expected.phase === "post_launch").length;
    expect(payload.summary.preLaunchCount).toBe(expectedPreLaunch);
    expect(payload.summary.postLaunchCount).toBe(expectedPostLaunch);
  });

  // Coverage metric: every known surface label is tested at least once
  it("evaluation covers all surface labels from SURFACE_PATTERNS", () => {
    const testedSurfaces = new Set(SCENARIOS.map(s => s.expected.surface));
    const requiredSurfaces = ["role", "skill", "wiki", "adr", "restore-packet", "context-pack", "guidance", "other"];
    for (const surface of requiredSurfaces) {
      expect(testedSurfaces.has(surface), `surface "${surface}" not covered by any scenario`).toBe(true);
    }
  });

  // Verify no scenario has a duplicate name
  it("all scenario names are unique", () => {
    const names = SCENARIOS.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
