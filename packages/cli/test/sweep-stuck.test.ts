import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { sweepStuckCommand, type SweepStuckDeps } from "../src/commands/sweep-stuck.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

function lifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
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
    ...overrides,
  };
}

function depsFor(port: number): SweepStuckDeps {
  const state: DaemonState = { pid: 1, port, db: "t.sqlite", startedAt: "2026-11-04T00:00:00Z" };
  return {
    lifecycleDeps: lifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

describe("rig sweep-stuck", () => {
  let server: http.Server;
  let port: number;
  let bodies: unknown[] = [];
  let respond: { status: number; body: unknown } = {
    status: 200,
    body: {
      scannedAt: "2026-11-04T22:00:00.000Z",
      dryRun: true,
      graceMs: 60000,
      examined: 1,
      items: [],
      unresolved: false,
    },
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { bodies.push(JSON.parse(raw || "{}")); } catch { bodies.push(raw); }
        res.writeHead(respond.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respond.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });
  beforeEach(() => {
    bodies = [];
    respond = {
      status: 200,
      body: {
        scannedAt: "2026-11-04T22:00:00.000Z",
        dryRun: true,
        graceMs: 60000,
        examined: 1,
        items: [],
        unresolved: false,
      },
    };
  });

  async function run(args: string[]) {
    const logs: string[] = [];
    const log = console.log;
    const code = process.exitCode;
    process.exitCode = undefined;
    console.log = (...v: unknown[]) => logs.push(v.join(" "));
    try {
      // parseAsync on the command itself — argv after node/script are flags only (no command name).
      await sweepStuckCommand(depsFor(port)).parseAsync(["node", "rig", ...args.filter((a) => a !== "sweep-stuck")]);
      return { logs, exitCode: process.exitCode ?? 0 };
    } finally {
      console.log = log;
      process.exitCode = code;
    }
  }

  it("posts dry-run to /api/transport/sweep-stuck and prints JSON", async () => {
    const { logs, exitCode } = await run(["sweep-stuck", "--dry-run", "--json"]);
    expect(bodies[0]).toMatchObject({ dryRun: true });
    expect(JSON.parse(logs[0]!)).toMatchObject({ examined: 1, unresolved: false });
    expect(exitCode).toBe(0);
  });

  it("exits non-zero when the report is unresolved", async () => {
    respond = {
      status: 409,
      body: {
        scannedAt: "2026-11-04T22:00:00.000Z",
        dryRun: false,
        graceMs: 60000,
        examined: 1,
        items: [{
          rig: "alpha", logicalId: "dev.impl", session: "dev-impl@alpha", runtime: "claude-code",
          action: "needs_human", attribution: "human_draft", unchangedMs: 90000,
          excerpt: "draft", detail: "not ours",
        }],
        unresolved: true,
      },
    };
    const { exitCode, logs } = await run(["sweep-stuck", "--json"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ unresolved: true });
    expect(exitCode).toBe(1);
  });
});
