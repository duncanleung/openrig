// RIG-61 - `rig rename` CLI surface. The daemon side is proven in the daemon suite
// (rig-rename-service.test.ts, rig-rename-routes.test.ts); here the CLI must send the right
// request and show each outcome and blocker faithfully. A local HTTP server stands in for the daemon.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { renameCommand, renderRenameReport, type RenameReport } from "../src/commands/rename.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
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

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE
        ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" } as DaemonState)
        : null)),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

async function capture(fn: () => Promise<void>): Promise<{ out: string; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try { await fn(); } finally { console.log = origLog; console.error = origErr; }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { out: logs.join("\n"), exitCode };
}

const plan: RenameReport = {
  oldName: "old-rig", newName: "new-rig", dryRun: true, applied: false,
  rigs: [{ id: "r1", archived: false }], blockers: [],
  db: { rows: 12, columns: [{ table: "sessions", column: "session_name", kind: "session", rows: 4 }] },
  files: {
    ops: [
      { surface: "specs", kind: "write", path: "/h/specs/old-rig/rig.yaml", detail: "rewrite 2 reference(s)" },
      { surface: "transcripts", kind: "rename", from: "/h/transcripts/old-rig", to: "/h/transcripts/new-rig", detail: "rename directory" },
    ],
    skipped: [{ path: "/h/specs/big.yaml", reason: "larger than 2097152 bytes; not rewritten" }],
  },
};

describe("rig rename CLI (RIG-61)", () => {
  let server: http.Server;
  let port: number;
  let last: { url: string; body: Record<string, unknown> };
  let reply: { status: number; body: unknown };

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      last = { url: req.url ?? "", body: raw ? JSON.parse(raw) : {} };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });

  const run = (...args: string[]) => capture(async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(renameCommand(runningDeps(port)));
    await prog.parseAsync(["node", "rig", "rename", ...args]);
  });

  it("without --yes it asks for a dry run, prints the plan, and exits 0", async () => {
    reply = { status: 200, body: plan };
    const { out, exitCode } = await run("old-rig", "new-rig");
    expect(last.url).toBe("/api/rigs/old-rig/rename");
    expect(last.body).toEqual({ newName: "new-rig", dryRun: true });
    expect(out).toContain("Plan to rename rig old-rig -> new-rig");
    expect(out).toContain("sessions.session_name: 4");
    expect(out).toContain("rename  /h/transcripts/old-rig -> /h/transcripts/new-rig");
    expect(out).toContain("rewrite /h/specs/old-rig/rig.yaml");
    expect(out).toContain("larger than");
    expect(out).toContain("Re-run with --yes to apply");
    expect(exitCode).toBeUndefined();
  });

  it("--yes applies (dryRun false) and reports the residue scan", async () => {
    reply = { status: 200, body: { ...plan, dryRun: false, applied: true, residue: [{ path: "/h/state/x.json", where: "content", count: 2 }] } };
    const { out, exitCode } = await run("old-rig", "new-rig", "--yes");
    expect(last.body).toEqual({ newName: "new-rig", dryRun: false });
    expect(out).toContain("Renamed rig old-rig -> new-rig");
    expect(out).toContain("1 remaining reference(s) to old-rig");
    expect(out).toContain("content: /h/state/x.json (2)");
    expect(exitCode).toBeUndefined();
  });

  it("--dry-run wins over --yes", async () => {
    reply = { status: 200, body: plan };
    await run("old-rig", "new-rig", "--yes", "--dry-run");
    expect(last.body).toEqual({ newName: "new-rig", dryRun: true });
  });

  it("prints every blocker with its items and exits 1", async () => {
    reply = {
      status: 409,
      body: {
        ...plan,
        blockers: [
          { code: "live_sessions", message: "The rig has live sessions. Stop it first with 'rig down old-rig'.", items: ["lead@old-rig (running)"] },
          { code: "open_queue_items", message: "Queue items for the rig are still open.", items: ["q-1 pending a@x -> b@old-rig"] },
        ],
      },
    };
    const { out, exitCode } = await run("old-rig", "new-rig", "--yes");
    expect(out).toContain("The rename is refused");
    expect(out).toContain("[live_sessions]");
    expect(out).toContain("- lead@old-rig (running)");
    expect(out).toContain("[open_queue_items]");
    expect(out).toContain("- q-1 pending a@x -> b@old-rig");
    expect(exitCode).toBe(1);
  });

  it("shows a bad name or unknown rig as a plain error with exit 1", async () => {
    reply = { status: 404, body: { error: "rig_not_found", message: 'no rig named "ghost"' } };
    const { out, exitCode } = await run("ghost", "new-rig", "--yes");
    expect(out).toContain('rig rename failed: no rig named "ghost"');
    expect(exitCode).toBe(1);
  });

  it("a failure that was fully undone says nothing changed and exits 2", async () => {
    reply = { status: 500, body: { error: "rename_failed_rolled_back", stage: "files", message: "rename failed during files step and was fully rolled back: boom" } };
    const { out, exitCode } = await run("old-rig", "new-rig", "--yes");
    expect(out).toContain("everything was restored. Nothing changed.");
    expect(exitCode).toBe(2);
  });

  it("a failure that needs recovery prints the journal and exact state", async () => {
    reply = {
      status: 500,
      body: {
        error: "rename_recovery_required",
        message: "database could NOT be reverted",
        journal: "/h/run/rig-rename-journal.json",
        state: { database: 'still renamed to "new-rig"', files: "restored to the old names" },
      },
    };
    const { out, exitCode } = await run("old-rig", "new-rig", "--yes");
    expect(out).toContain("did NOT finish and was NOT fully undone");
    expect(out).toContain('database: still renamed to "new-rig"');
    expect(out).toContain("files:    restored to the old names");
    expect(out).toContain("journal:  /h/run/rig-rename-journal.json");
    expect(out).toContain("rig rename --recover");
    expect(exitCode).toBe(2);
  });

  it("--json prints the raw body", async () => {
    reply = { status: 200, body: plan };
    const { out, exitCode } = await run("old-rig", "new-rig", "--json");
    expect(JSON.parse(out)).toMatchObject({ oldName: "old-rig", newName: "new-rig" });
    expect(exitCode).toBeUndefined();
  });

  it("--recover calls the recover route and prints its message", async () => {
    reply = { status: 200, body: { recovered: true, message: "Rolled back the unfinished rename." } };
    const { out, exitCode } = await run("--recover");
    expect(last.url).toBe("/api/rig-rename/recover");
    expect(out).toContain("Rolled back the unfinished rename.");
    expect(exitCode).toBeUndefined();
  });

  it("asks for both names when they are missing", async () => {
    const { out, exitCode } = await run("old-rig");
    expect(out).toContain("usage: rig rename <old> <new>");
    expect(exitCode).toBe(1);
  });
});

describe("renderRenameReport (RIG-61)", () => {
  it("tells the reader what is not renamed", () => {
    expect(renderRenameReport(plan).join("\n")).toContain("Not renamed: live sessions and tmux names, transcript text");
  });
  it("says so when the residue scan is clean", () => {
    const text = renderRenameReport({ ...plan, dryRun: false, applied: true, residue: [] }).join("\n");
    expect(text).toContain("Residue scan: no remaining references to old-rig");
  });
  it("caps long lists", () => {
    const columns = Array.from({ length: 40 }, (_, i) => ({ table: `t${i}`, column: "c", kind: "session", rows: 1 }));
    const text = renderRenameReport({ ...plan, db: { rows: 40, columns } }).join("\n");
    expect(text).toContain("... and 15 more");
  });
});
