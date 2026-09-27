// OPE-2: E2E tests for observer provisioning dedup with real filesystem.
// Verifies that statusLine and activity-hook dedup logic works with real
// file reads/writes, real path resolution, and real JSON round-trips.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync, chmodSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

function realFsOps(homedir: string): ClaudeAdapterFsOps {
  return {
    readFile: (p: string) => readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => writeFileSync(p, c, "utf-8"),
    exists: (p: string) => existsSync(p),
    mkdirp: (p: string) => mkdirSync(p, { recursive: true }),
    copyFile: (src: string, dest: string) => {
      const content = readFileSync(src);
      writeFileSync(dest, content);
    },
    statMode: (p: string) => statSync(p).mode & 0o777,
    chmod: (p: string, m: number) => chmodSync(p, m),
    homedir,
  };
}

function stubTmux() {
  return {
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
    setSessionOption: async () => ({ ok: true as const }),
    getSessionOption: async () => null,
  } as unknown as TmuxAdapter;
}

const RELAY_ASSET = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const MANIFEST_ASSET = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json");
const COLLECTOR_ASSET = resolve(import.meta.dirname, "../assets/claude-statusline-context.cjs");

function activityEntry(relayPath: string): ProjectionEntry {
  return {
    category: "runtime_resource", effectiveId: "claude-activity-hooks", sourceSpec: "shared",
    sourcePath: "shared/activity", resourcePath: "activity", absolutePath: relayPath,
    resourceType: "claude_activity_hooks", classification: "safe_projection",
  };
}

function plan(cwd: string, entries: ProjectionEntry[]): ProjectionPlan {
  return { runtime: "claude-code", cwd, entries, startup: {} as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [] };
}

function binding(cwd: string): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "t", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd } as NodeBinding;
}

describe("Observer dedup E2E — real filesystem", () => {
  let root: string;
  let homeDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ope2-e2e-"));
    homeDir = join(root, "home");
    projectDir = join(root, "project");
    stateDir = join(root, "state");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeAdapter(fs: ClaudeAdapterFsOps) {
    return new ClaudeCodeAdapter({
      tmux: stubTmux(),
      fsOps: fs,
      stateDir,
      collectorAssetPath: COLLECTOR_ASSET,
      activityRelayPath: RELAY_ASSET,
      claudeHooksManifestPath: MANIFEST_ASSET,
    });
  }

  function readJsonFile(p: string): Record<string, unknown> {
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  describe("statusLine dedup", () => {
    it("injects statusLine into a fresh project settings file", async () => {
      const fs = realFsOps(homeDir);
      await makeAdapter(fs).deliverStartup([], { cwd: projectDir, tmuxSession: "test", nodeId: "n1" } as any);

      const settings = readJsonFile(join(projectDir, ".claude", "settings.local.json"));
      expect(settings.statusLine).toBeDefined();
      expect((settings.statusLine as any).command).toContain("context-collector.cjs");
    });

    it("removes OpenRig statusLine when global user statusLine exists", async () => {
      writeFileSync(
        join(projectDir, ".claude", "settings.local.json"),
        JSON.stringify({
          customKey: true,
          statusLine: { type: "command", command: "node /old/context-collector.cjs /a /b" },
        }),
      );
      writeFileSync(
        join(homeDir, ".claude", "settings.json"),
        JSON.stringify({ statusLine: { type: "command", command: "/usr/local/bin/my-statusline.sh" } }),
      );

      const fs = realFsOps(homeDir);
      await makeAdapter(fs).deliverStartup([], { cwd: projectDir, tmuxSession: "t", nodeId: "n1" } as any);

      const settings = readJsonFile(join(projectDir, ".claude", "settings.local.json"));
      expect(settings.statusLine).toBeUndefined();
      expect(settings.customKey).toBe(true);
    });

    it("preserves user-defined project statusLine even with no global", async () => {
      writeFileSync(
        join(projectDir, ".claude", "settings.local.json"),
        JSON.stringify({ statusLine: { type: "command", command: "/my/custom-statusline.sh" } }),
      );

      const fs = realFsOps(homeDir);
      await makeAdapter(fs).deliverStartup([], { cwd: projectDir, tmuxSession: "t", nodeId: "n1" } as any);

      const settings = readJsonFile(join(projectDir, ".claude", "settings.local.json"));
      expect((settings.statusLine as any).command).toBe("/my/custom-statusline.sh");
    });
  });

  describe("activity hook dedup via project()", () => {
    it("writes hooks to project when no global hooks exist", async () => {
      const fs = realFsOps(homeDir);
      const adapter = makeAdapter(fs);
      await adapter.project(plan(projectDir, [activityEntry(RELAY_ASSET)]), binding(projectDir));

      const settingsPath = join(projectDir, ".claude", "settings.local.json");
      expect(existsSync(settingsPath), "settings file created").toBe(true);
      const settings = readJsonFile(settingsPath);
      const hooks = settings.hooks as Record<string, unknown[]>;
      expect(hooks).toBeDefined();
      expect(Object.keys(hooks).length).toBeGreaterThanOrEqual(4);
    });

    it("skips project hooks when global covers all relay events", async () => {
      const relayCmd = `node '${join(homeDir, ".openrig", "hooks", "scripts", "activity-relay.cjs")}'`;
      const globalHooks: Record<string, unknown[]> = {};
      for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
        globalHooks[ev] = [{ hooks: [{ type: "command", command: relayCmd, timeout: 5 }] }];
      }
      writeFileSync(join(homeDir, ".claude", "settings.json"), JSON.stringify({ hooks: globalHooks }));

      const fs = realFsOps(homeDir);
      await makeAdapter(fs).project(plan(projectDir, [activityEntry(RELAY_ASSET)]), binding(projectDir));

      const settingsPath = join(projectDir, ".claude", "settings.local.json");
      if (!existsSync(settingsPath)) return; // no file = no project hooks, correct
      const settings = readJsonFile(settingsPath);
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      const allCmds = Object.values(hooks ?? {}).flat().flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(allCmds.filter((c: string) => c.includes("activity-relay.cjs"))).toEqual([]);
    });
  });

  describe("cwd=home guard (OPE-3)", () => {
    it("writes project hooks even when global covers all events — because cwd IS home", async () => {
      const relayCmd = `node '${join(homeDir, ".openrig", "hooks", "scripts", "activity-relay.cjs")}'`;
      const globalHooks: Record<string, unknown[]> = {};
      for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
        globalHooks[ev] = [{ hooks: [{ type: "command", command: relayCmd, timeout: 5 }] }];
      }
      writeFileSync(join(homeDir, ".claude", "settings.json"), JSON.stringify({ hooks: globalHooks }));

      const fs = realFsOps(homeDir);
      await makeAdapter(fs).project(plan(homeDir, [activityEntry(RELAY_ASSET)]), binding(homeDir));

      const settingsPath = join(homeDir, ".claude", "settings.local.json");
      expect(existsSync(settingsPath), "settings.local.json created").toBe(true);
      const settings = readJsonFile(settingsPath);
      const hooks = settings.hooks as Record<string, unknown[]>;
      expect(hooks).toBeDefined();
      const allCmds = Object.values(hooks).flat().flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(
        allCmds.filter((c: string) => c.includes("activity-relay.cjs")).length,
        "hooks written despite global coverage when cwd=home",
      ).toBeGreaterThanOrEqual(4);
    });
  });
});
