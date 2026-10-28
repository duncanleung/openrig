// RIG-116 — install-level pins: the compaction restore bridge IS WIRED into the effective
// Claude settings after project(). The stub tests (stub-runner-restore-e2e etc.) prove the
// bridge SCRIPT works when spawned; they cannot catch the bridge never being registered,
// which is how restore markers were written for weeks and never read.
//
// Uses the REAL shipped claude.json manifest and bridge asset on a real temp filesystem, so a
// manifest change that drops the bridge groups fails here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { claudeCompactionBridgePath, parseManagedClaudeNodeCommand } from "../src/domain/claude-activity-hooks.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import * as fs from "node:fs";

const ASSETS = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks");
const RELAY_SRC = join(ASSETS, "scripts/activity-relay.cjs");
const BRIDGE_SRC = join(ASSETS, "scripts/compaction-restore-bridge.cjs");
const MANIFEST_SRC = join(ASSETS, "claude.json");

let root: string;
let cwd: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rig116-"));
  cwd = join(root, "project");
  stateDir = join(root, "openrig-home");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const realFs: ClaudeAdapterFsOps = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
  copyFile: (a, b) => fs.copyFileSync(a, b),
  listFiles: () => [],
  statMode: (p) => fs.statSync(p).mode,
  chmod: (p, m) => fs.chmodSync(p, m),
  homedir: join(root ?? "/nonexistent", "home"),
} as ClaudeAdapterFsOps;

function adapter(opts: { bridge?: string | undefined } = { bridge: BRIDGE_SRC }) {
  const tmux = {
    sessionExists: async () => true, sendKeys: async () => {}, capturePaneContent: async () => "",
    getPaneCommand: async () => "", listSessions: async () => [], runCommandInSession: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: async () => {},
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
  return new ClaudeCodeAdapter({
    tmux, fsOps: { ...realFs, homedir: join(root, "home") } as ClaudeAdapterFsOps, stateDir,
    activityRelayPath: RELAY_SRC, claudeHooksManifestPath: MANIFEST_SRC,
    ...(opts.bridge ? { compactionBridgePath: opts.bridge } : {}),
  } as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);
}

const binding = (): NodeBinding => ({ id: "b", nodeId: "n", tmuxSession: "t", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd } as NodeBinding);
const plan = (entries: ProjectionEntry[]): ProjectionPlan => ({ runtime: "claude-code", cwd, entries, startup: {} as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [] });
const activityEntry = (): ProjectionEntry => ({
  category: "runtime_resource", effectiveId: "claude-activity-hooks", sourceSpec: "shared", sourcePath: "shared/activity",
  resourcePath: "activity", absolutePath: RELAY_SRC, resourceType: "claude_activity_hooks", classification: "safe_projection",
});

const settingsPath = () => join(cwd, ".claude", "settings.local.json");
const settings = () => JSON.parse(readFileSync(settingsPath(), "utf-8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>> };
// Ownership is the managed node command (pinned executable + one quoted path), the same shape the
// activity relay uses; match it by parsing so the test does not depend on the executable's path.
const isBridgeCmd = (command: string) => {
  const parsed = parseManagedClaudeNodeCommand(command);
  return parsed?.args.length === 1 && parsed.args[0] === claudeCompactionBridgePath(stateDir);
};
const bridgeGroups = (s: ReturnType<typeof settings>, event: string) =>
  (s.hooks[event] ?? []).filter((g) => g.hooks.some((h) => isBridgeCmd(h.command)));

describe("RIG-116 compaction bridge hook wiring", () => {
  it("wires the bridge for SessionStart(compact), UserPromptSubmit and PostCompact", async () => {
    await adapter().project(plan([activityEntry()]), binding());
    const s = settings();
    const ss = bridgeGroups(s, "SessionStart");
    expect(ss).toHaveLength(1);
    expect(ss[0]!.matcher).toBe("compact");
    expect(bridgeGroups(s, "UserPromptSubmit")).toHaveLength(1);
    expect(bridgeGroups(s, "PostCompact")).toHaveLength(1);
    expect(bridgeGroups(s, "UserPromptSubmit")[0]!.matcher).toBeUndefined();
  });

  it("points the hooks at a delivered, executable-by-node copy of the real bridge", async () => {
    await adapter().project(plan([activityEntry()]), binding());
    const dest = claudeCompactionBridgePath(stateDir);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe(readFileSync(BRIDGE_SRC, "utf-8"));
    // The registered command must run: it exits 0 on an empty payload and an empty home.
    const r = spawnSync("node", [dest], { input: "{}", env: { ...process.env, OPENRIG_HOME: join(root, "empty") }, encoding: "utf-8" });
    expect(r.status).toBe(0);
  });

  it("does not register PreCompact or any managed-compaction hook", async () => {
    await adapter().project(plan([activityEntry()]), binding());
    expect(settings().hooks["PreCompact"]).toBeUndefined();
  });

  it("is idempotent across repeated project() calls", async () => {
    const a = adapter();
    await a.project(plan([activityEntry()]), binding());
    const first = readFileSync(settingsPath(), "utf-8");
    await a.project(plan([activityEntry()]), binding());
    expect(readFileSync(settingsPath(), "utf-8")).toBe(first);
  });

  it("preserves user hooks and strips only the owned bridge entries on disable", async () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { PostCompact: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    const a = adapter();
    await a.project(plan([activityEntry()]), binding());
    expect(settings().hooks["PostCompact"]).toHaveLength(2);
    await a.project(plan([]), binding());
    const s = settings();
    expect(s.hooks["PostCompact"]).toEqual([{ hooks: [{ type: "command", command: "echo mine" }] }]);
    expect(bridgeGroups(s, "SessionStart")).toHaveLength(0);
  });

  it("leaves existing bridge entries untouched when the bridge source is unavailable", async () => {
    await adapter().project(plan([activityEntry()]), binding());
    await adapter({ bridge: join(root, "missing.cjs") }).project(plan([activityEntry()]), binding());
    const s = settings();
    for (const ev of ["SessionStart", "UserPromptSubmit", "PostCompact"]) expect(bridgeGroups(s, ev)).toHaveLength(1);
  });

  it("fails closed on an unparseable settings file", async () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{ not json");
    await adapter().project(plan([activityEntry()]), binding());
    expect(readFileSync(settingsPath(), "utf-8")).toBe("{ not json");
  });

  it("the shipped manifest still declares the bridge groups the installer derives", () => {
    const m = JSON.parse(readFileSync(MANIFEST_SRC, "utf-8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const ev of ["SessionStart", "UserPromptSubmit", "PostCompact"]) {
      expect(m[ev]!.some((g) => g.hooks.some((h) => h.command.includes("compaction-restore-bridge.cjs")))).toBe(true);
    }
    expect(statSync(BRIDGE_SRC).isFile()).toBe(true);
  });
});

describe("RIG-116 bridge drops are loud", () => {
  it("writes a stderr line, and no stdout, when the transcript path does not match the marker", () => {
    const home = join(root, "home2");
    const dir = join(home, "compaction", "restore-pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "seat@x.json"), JSON.stringify({
      version: 1, sessionName: "seat@x", sessionId: "sid1", transcriptPath: "/old/sid1.jsonl", outputDir: "/tmp/p", deliveredAt: null, deliveryCount: 0,
    }));
    const r = spawnSync("node", [BRIDGE_SRC], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sid1", transcript_path: "/new/sid1.jsonl" }),
      env: { ...process.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: "seat@x" }, encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("compaction-restore-bridge:");
    expect(r.stderr).toContain("/old/sid1.jsonl");
    expect(r.stderr).toContain("/new/sid1.jsonl");
    expect(JSON.parse(readFileSync(join(dir, "seat@x.json"), "utf-8")).deliveryCount).toBe(0);
  });

  it("still delivers (stdout, no stderr) when identity matches", () => {
    const home = join(root, "home3");
    const dir = join(home, "compaction", "restore-pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "seat@x.json"), JSON.stringify({
      version: 1, sessionName: "seat@x", sessionId: "sid1", transcriptPath: "/t/sid1.jsonl", outputDir: "/tmp/p", deliveredAt: null, deliveryCount: 0,
    }));
    const r = spawnSync("node", [BRIDGE_SRC], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "sid1", transcript_path: "/t/sid1.jsonl" }),
      env: { ...process.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: "seat@x" }, encoding: "utf-8",
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("additionalContext");
  });
});
