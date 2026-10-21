// RIG-120 — `rig health --operational` renders the daemon's operational summary.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { healthCommand, type HealthDeps } from "../src/commands/health.js";
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

function depsFor(port: number): HealthDeps {
  const state: DaemonState = { pid: 1, port, db: "t.sqlite", startedAt: "2026-10-21T00:00:00Z" };
  return {
    lifecycleDeps: lifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    resolveIdentity: () => ({ sessionName: "guard@rig-a" }),
  };
}

const SUMMARY = {
  schema: "openrig.health-operational/v0alpha1",
  observedAt: "2026-10-21T22:00:00.000Z",
  scope: { kind: "daemon", rig: null, hosts: "this-daemon-only" },
  seats: { total: 3, bySessionStatus: { running: 3 }, byLifecycle: { running: 2, attention_required: 1 }, attentionRequired: 1 },
  terminalInput: { count: 1, seats: [{ rig: "openrig", logicalId: "dev.qa", session: "dev-qa@openrig", count: 1, reason: "permission prompt" }] },
  humanGates: { count: 1, items: [{ qitemId: "qitem-1", state: "blocked", destination: "dev-impl@openrig", blockedOn: "human-review@kernel", summary: "approve the plan", evidenceRef: "docs/plan.md", updatedAt: "2026-10-21T21:00:00Z" }] },
  stalledWork: { count: 1, items: [{ qitemId: "qitem-2", owner: "dev-impl@openrig", evidence: "no meaningful queue change for 60 min", updatedAt: "2026-10-21T20:00:00Z" }] },
  watchdog: { activeJobs: 2, newestEvaluationAt: "2026-10-21T21:59:30Z", neverEvaluated: 0, stale: [] },
  coverage: [
    { source: "seats", status: "complete", examined: 3 },
    { source: "humanGates", status: "partial", examined: 500, limit: 500, reason: "the attention read hit its row limit; more gates may exist" },
  ],
  verdict: "attention",
};

describe("rig health --operational", () => {
  let server: http.Server;
  let port: number;
  let requests: string[] = [];
  let respond: { status: number; body: unknown } = { status: 200, body: SUMMARY };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(respond.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respond.body));
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });
  beforeEach(() => { requests = []; respond = { status: 200, body: SUMMARY }; });

  async function run(args: string[]) {
    const logs: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const err = console.error;
    const code = process.exitCode;
    process.exitCode = undefined;
    console.log = (...v: unknown[]) => logs.push(v.join(" "));
    console.error = (...v: unknown[]) => errors.push(v.join(" "));
    try {
      await healthCommand(depsFor(port)).parseAsync(["node", "rig", ...args]);
    } finally {
      console.log = log;
      console.error = err;
    }
    const exitCode = process.exitCode;
    process.exitCode = code;
    return { logs, errors, exitCode };
  }

  it("calls the operational route and prints the three concepts as separate sections", async () => {
    const { logs, exitCode } = await run(["--operational"]);
    expect(requests).toEqual(["/api/health/operational"]);
    const out = logs.join("\n");
    expect(out).toContain("observed=2026-10-21T22:00:00.000Z");
    expect(out).toContain("this daemon only");
    expect(out).toContain("Verdict: ATTENTION");
    expect(out).toContain("Terminal input needed (seat is waiting at a prompt): 1");
    expect(out).toContain("dev-qa@openrig");
    expect(out).toContain("Human gates (a person must decide): 1");
    expect(out).toContain("approve the plan");
    expect(out).toContain("evidence=docs/plan.md");
    expect(out).toContain("Stalled work (claimed, no meaningful change): 1");
    expect(out).toContain("Watchdog: 2 active job(s)");
    expect(exitCode).toBeUndefined();
  });

  it("names a partial source and says it is not healthy", async () => {
    const out = (await run(["--operational"])).logs.join("\n");
    expect(out).toContain("PARTIAL: humanGates: the attention read hit its row limit");
    expect(out).toContain("not healthy until it is read in full");
  });

  it("prints INDETERMINATE with an explicit warning, never a healthy line", async () => {
    respond = { status: 200, body: { ...SUMMARY, terminalInput: { count: 0, seats: [] }, humanGates: { count: 0, items: [] }, stalledWork: { count: 0, items: [] }, verdict: "indeterminate" } };
    const out = (await run(["--operational"])).logs.join("\n");
    expect(out).toContain("Verdict: INDETERMINATE");
    expect(out).toContain("Do not read this as healthy");
    expect(out).not.toMatch(/Verdict: CLEAR/);
  });

  it("--rig passes the name to the daemon", async () => {
    await run(["--operational", "--rig", "my rig"]);
    expect(requests).toEqual(["/api/health/operational?rig=my%20rig"]);
  });

  it("--json prints the daemon payload unchanged", async () => {
    const { logs } = await run(["--operational", "--json"]);
    expect(JSON.parse(logs.join("\n"))).toEqual(SUMMARY);
  });

  it("--quiet prints one line of counts and the verdict", async () => {
    const { logs } = await run(["--operational", "--quiet"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe("verdict=attention seats=3 attention-required=1 terminal-input=1 human-gates=1 stalled=1 incomplete-sources=1 observed=2026-10-21T22:00:00.000Z");
  });

  it("--quiet without --operational is refused", async () => {
    const { errors, exitCode } = await run(["--quiet"]);
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--quiet applies only to --operational");
    expect(requests).toEqual([]);
  });

  it("--operational conflicts with --seat", async () => {
    const cmd = healthCommand(depsFor(port));
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => undefined });
    await expect(cmd.parseAsync(["node", "rig", "--operational", "--seat", "n1"])).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("reports an unknown rig as a structured error", async () => {
    respond = { status: 404, body: { error: "rig_not_found", message: "rig not found: nope" } };
    const { logs, exitCode } = await run(["--operational", "--rig", "nope", "--json"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ schema: "openrig.health-error/v0alpha1", error: "rig_not_found" });
  });

  it("explains an older daemon that lacks the route", async () => {
    respond = { status: 404, body: { error: "not_found" } };
    const { errors, exitCode } = await run(["--operational"]);
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("does not expose the operational summary");
  });
});
