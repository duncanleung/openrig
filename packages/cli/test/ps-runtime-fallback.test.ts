// RIG-101 — `rig ps --nodes` shows a compact runtime-fallback indicator without replacing lifecycle.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand, formatRuntimeFallback } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function depsFor(port: number): StatusDeps {
  const base = lifecycleDeps();
  return {
    lifecycleDeps: {
      ...base,
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) =>
        p === STATE_FILE ? JSON.stringify({ pid: 1, port, db: "t.sqlite", startedAt: "2026-10-21T00:00:00Z" } as DaemonState) : null),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

const node = (logicalId: string, extra: Record<string, unknown> = {}) => ({
  rigId: "rig-a", rigName: "openrig", logicalId,
  podId: "pod", podNamespace: logicalId.split(".")[0],
  canonicalSessionName: `${logicalId.replace(".", "-")}@openrig`,
  nodeKind: "agent", runtime: "claude-code", model: null,
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  lifecycleState: "running", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
  hasAssignedWork: false, assignedWorkCount: 0, pendingWorkCount: 0,
  agentActivity: { state: "running" },
  ...extra,
});

const FALLBACK = {
  state: "on_fallback", originalRuntime: "codex", currentRuntime: "claude-code",
  poolKey: "codex:pool", enteredAt: "2026-10-21T10:00:00Z", expiresAt: "2026-10-21T15:00:00Z",
  swapBack: "at_expiry", swapBackPending: false,
};
const NODES = [
  node("dev.impl", { runtimeFallback: FALLBACK }),
  node("dev.qa", { runtimeFallback: { ...FALLBACK, state: "swap_back_pending", swapBackPending: true }, lifecycleState: "attention_required", startupStatus: "attention_required", latestError: "boom" }),
  node("orch.lead"),
];

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try { await fn(); } catch { /* exitOverride */ } finally { console.log = orig; }
  return logs;
}

describe("formatRuntimeFallback", () => {
  it("is null off fallback", () => {
    expect(formatRuntimeFallback({})).toBeNull();
  });
  it("names the original runtime", () => {
    expect(formatRuntimeFallback({ runtimeFallback: FALLBACK as never })).toBe("on fallback (was codex)");
  });
  it("marks a pending return", () => {
    const f = { ...FALLBACK, state: "swap_back_pending", swapBackPending: true } as never;
    expect(formatRuntimeFallback({ runtimeFallback: f })).toBe("fallback: return pending (was codex)");
  });
  it("omits the was-clause when the original runtime is unknown", () => {
    expect(formatRuntimeFallback({ runtimeFallback: { ...FALLBACK, originalRuntime: null } as never })).toBe("on fallback");
  });
});

describe("rig ps --nodes runtime fallback", () => {
  let server: http.Server;
  let port: number;
  let savedSession: string | undefined;

  beforeAll(async () => {
    savedSession = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/ps") {
        res.end(JSON.stringify([{ rigId: "rig-a", name: "openrig", rigName: "openrig", nodeCount: 3, runningCount: 3, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null }]));
      } else if (/^\/api\/rigs\/rig-a\/nodes/.test(req.url ?? "")) {
        res.end(JSON.stringify(NODES));
      } else {
        res.end("[]");
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
    if (savedSession !== undefined) process.env.OPENRIG_SESSION_NAME = savedSession;
  });

  const run = (args: string[]) => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(depsFor(port)));
    return capture(() => prog.parseAsync(["node", "rig", "ps", "--nodes", "-A", ...args]).then(() => undefined));
  };

  it("compact table marks fallback seats and leaves LIFECYCLE alone", async () => {
    const out = (await run([])).join("\n");
    const impl = out.split("\n").find((l) => l.includes("dev-impl@openrig"))!;
    expect(impl).toContain("on fallback (was codex)");
    expect(impl).toMatch(/running/i);
    const qa = out.split("\n").find((l) => l.includes("dev-qa@openrig"))!;
    expect(qa).toContain("fallback: return pending (was codex)");
    expect(qa).toContain("boom");
    expect(out.split("\n").find((l) => l.includes("orch-lead@openrig"))).not.toContain("fallback");
  });

  it("full table marks fallback seats too", async () => {
    const out = (await run(["--full"])).join("\n");
    expect(out.split("\n").find((l) => l.includes("dev-impl@openrig"))).toContain("on fallback (was codex)");
  });

  it("compact JSON carries runtimeFallback only for seats on fallback", async () => {
    const rows = JSON.parse((await run(["--json"])).join("\n")) as Array<Record<string, unknown>>;
    const by = (id: string) => rows.find((r) => r.logicalId === id)!;
    expect(by("dev.impl").runtimeFallback).toMatchObject({ state: "on_fallback", originalRuntime: "codex", swapBackPending: false });
    expect(by("dev.qa").runtimeFallback).toMatchObject({ state: "swap_back_pending", swapBackPending: true });
    expect("runtimeFallback" in by("orch.lead")).toBe(false);
  });

  it("--fields runtimeFallback is accepted", async () => {
    const raw = JSON.parse((await run(["--json", "--fields", "logicalId,runtimeFallback"])).join("\n")) as unknown;
    expect(JSON.stringify(raw)).toContain("swap_back_pending");
    expect(JSON.stringify(raw)).not.toContain("Unknown field");
  });
});
