import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fleetCommand } from "../src/commands/fleet.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}
function runningDeps(client: unknown): StatusDeps {
  return {
    lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "t.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState) : null)), fetch: vi.fn(async () => ({ ok: true })) },
    clientFactory: () => client as DaemonClient,
  };
}
function stoppedDeps(): StatusDeps {
  const refused = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  return { lifecycleDeps: { ...mockLifecycleDeps(), fetch: vi.fn(async () => { throw refused; }) }, clientFactory: () => { throw new Error("client must not be created"); } };
}
async function run(deps: StatusDeps, args: string[]) {
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
  const prog = new Command(); prog.exitOverride();
  prog.addCommand(fleetCommand(deps));
  try { await prog.parseAsync(["node", "rig", "fleet", ...args]); } finally { console.log = origLog; console.error = origErr; }
  const exitCode = process.exitCode; process.exitCode = origExit;
  return { out: logs.join("\n"), exitCode };
}

const summary = {
  totals: { rigs: 1, sessions: 3, input_tokens: 1234567, output_tokens: 89, total_tokens: 1234656, review_runs: 2, must_fix: 1, suggestion: 0, dismissed: 0, escalations: 0 },
  rigs: [{ rig_name: "atlas", sessions: 3, input_tokens: 1234567, output_tokens: 89, total_tokens: 1234656, review_runs: 2, must_fix: 1 }],
  top_seats: [], reviews_by_seat_week: [], truncated: false,
  stats: { session_digests: { count: 3, last_ingested_at: "2026-10-06 10:00:00", total_escalations: 0 }, review_runs: { count: 2, last_ingested_at: null }, review_findings: { count: 0 }, daily_token_snapshots: { count: 1, last_snapshot_at: "2026-10-06 09:00:00" } },
};

describe("rig fleet summary / aggregate / dashboard", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agg-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("summary prints a table, labels tokens, and shows data-as-of", async () => {
    const get = vi.fn(async () => ({ status: 200, data: { ok: true, summary } }));
    const { out, exitCode } = await run(runningDeps({ get }), ["summary", "--rig", "atlas", "--since", "2026-10-01"]);
    expect(exitCode).toBeUndefined();
    expect(get).toHaveBeenCalledWith("/api/fleet/summary?rig=atlas&since=2026-10-01", expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(out).toContain("tokens, not dollars");
    expect(out).toContain("atlas");
    expect(out).toContain("1,234,567");
    expect(out).toContain("Data as of");
    expect(out).toContain("reviews: never");
  });

  it("summary --json prints the raw payload", async () => {
    const get = vi.fn(async () => ({ status: 200, data: { ok: true, summary } }));
    const { out } = await run(runningDeps({ get }), ["summary", "--json"]);
    expect(JSON.parse(out).summary.totals.sessions).toBe(3);
  });

  it("summary on an empty store says how to ingest", async () => {
    const empty = { ...summary, totals: { ...summary.totals, rigs: 0 }, rigs: [] };
    const get = vi.fn(async () => ({ status: 200, data: { ok: true, summary: empty } }));
    const { out } = await run(runningDeps({ get }), ["summary"]);
    expect(out).toContain("rig fleet reconcile");
  });

  it("summary reports API errors with exit code 1", async () => {
    const get = vi.fn(async () => ({ status: 400, data: { ok: false, error: "since must be a date in YYYY-MM-DD form." } }));
    const { out, exitCode } = await run(runningDeps({ get }), ["summary", "--since", "bad"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("since must be a date");
  });

  it("aggregate tokens --by seat requests the right path and prints rows", async () => {
    const get = vi.fn(async () => ({ status: 200, data: { ok: true, truncated: false, rows: [{ rig_name: "atlas", seat_name: "dev-impl", model: "opus", input_tokens: 10, output_tokens: 5, total_tokens: 15 }] } }));
    const { out } = await run(runningDeps({ get }), ["aggregate", "tokens", "--by", "seat"]);
    expect(get.mock.calls[0]![0]).toBe("/api/fleet/aggregate/tokens?by=seat");
    expect(out).toContain("dev-impl");
  });

  it("aggregate rejects an unknown kind without calling the daemon", async () => {
    const get = vi.fn();
    const { out, exitCode } = await run(runningDeps({ get }), ["aggregate", "costs"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("kind must be");
    expect(get).not.toHaveBeenCalled();
  });

  it("dashboard writes the HTML to --out and prints the path", async () => {
    const html = "<!doctype html><title>Fleet dashboard</title>";
    const getText = vi.fn(async () => ({ status: 200, data: html }));
    const outFile = path.join(tmp, "dash.html");
    const { out, exitCode } = await run(runningDeps({ getText }), ["dashboard", "--out", outFile, "--rig", "atlas"]);
    expect(exitCode).toBeUndefined();
    expect(getText.mock.calls[0]![0]).toBe("/api/fleet/dashboard?rig=atlas");
    expect(out.trim()).toBe(outFile);
    expect(fs.readFileSync(outFile, "utf-8")).toBe(html);
  });

  it("dashboard does not write a file when the daemon returns an error", async () => {
    const getText = vi.fn(async () => ({ status: 400, data: JSON.stringify({ ok: false, error: "bad since" }) }));
    const outFile = path.join(tmp, "dash.html");
    const { out, exitCode } = await run(runningDeps({ getText }), ["dashboard", "--out", outFile]);
    expect(exitCode).toBe(1);
    expect(out).toContain("bad since");
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it("all new commands stop cleanly when the daemon is not running", async () => {
    for (const args of [["summary"], ["aggregate", "tokens"], ["dashboard", "--out", path.join(tmp, "x.html")]]) {
      const { exitCode } = await run(stoppedDeps(), args);
      expect(exitCode, args.join(" ")).not.toBeUndefined();
    }
    expect(fs.existsSync(path.join(tmp, "x.html"))).toBe(false);
  });
});
