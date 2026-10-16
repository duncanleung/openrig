// RIG-63 — GateGuard PreToolUse hook. Runs the shipped script as a child process
// against a per-test OPENRIG_HOME so the real stdin/stdout/exit-code contract is tested.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PLUGIN = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const SCRIPT = path.join(PLUGIN, "hooks/scripts/gateguard.cjs");
const CLAUDE_HOOKS = path.join(PLUGIN, "hooks/claude.json");

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "gateguard-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface RunOptions {
  args?: string[];
  gate?: string | undefined;
  home?: string;
}

function run(input: unknown, options: RunOptions = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENRIG_HOME: options.home ?? home };
  if ("gate" in options) {
    if (options.gate === undefined) delete env.OPENRIG_GATEGUARD;
    else env.OPENRIG_GATEGUARD = options.gate;
  } else {
    env.OPENRIG_GATEGUARD = "1";
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...(options.args ?? [])], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

function edit(file: string, n: number, session = "s1") {
  return {
    session_id: session,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: lines(n), new_string: lines(n) + "x" },
  };
}

function write(file: string, n: number, session = "s1") {
  return { session_id: session, tool_name: "Write", tool_input: { file_path: file, content: lines(n) } };
}

function multi(file: string, perEdit: number, count: number, session = "s1") {
  return {
    session_id: session,
    tool_name: "MultiEdit",
    tool_input: {
      file_path: file,
      edits: Array.from({ length: count }, () => ({ old_string: lines(perEdit), new_string: lines(perEdit) })),
    },
  };
}

function notebook(file: string, n: number, session = "s1") {
  return { session_id: session, tool_name: "NotebookEdit", tool_input: { notebook_path: file, new_source: lines(n) } };
}

const denied = (r: { stdout: string }) => r.stdout !== "";
const events = () => {
  const file = path.join(home, "state/gateguard/events.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>)
    : [];
};
const decisions = () => events().map((e) => e.decision);

describe("RIG-63 GateGuard hook script", () => {
  it("denies the first gated call with the documented JSON shape and message", () => {
    const r = run(edit("/repo/src/a.ts", 10));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.any(String),
      },
    });
    const reason = out.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("(a) the specific files that import/consume this code");
    expect(reason).toContain("(b) the schema or interface contract");
    expect(reason).toContain("(c) the verbatim user instruction or ticket requirement");
  });

  it("allows the second call in the same turn and keeps the rest of the turn free", () => {
    expect(denied(run(edit("/repo/src/a.ts", 10)))).toBe(true);
    for (let i = 0; i < 3; i++) {
      const r = run(edit("/repo/src/a.ts", 10));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(decisions()).toEqual(["deny", "allow-second", "allow-second", "allow-second"]);
  });

  it("--reset starts a new turn so the next gated call is denied again", () => {
    run(edit("/repo/src/a.ts", 10));
    expect(denied(run(edit("/repo/src/a.ts", 10)))).toBe(false);
    const reset = run({ session_id: "s1", hook_event_name: "UserPromptSubmit" }, { args: ["--reset"] });
    expect(reset.status).toBe(0);
    expect(reset.stdout).toBe("");
    expect(denied(run(edit("/repo/src/a.ts", 10)))).toBe(true);
  });

  it("--reset with the gate off or a missing session id exits 0 silently", () => {
    expect(run({ session_id: "s1" }, { args: ["--reset"], gate: "0" })).toMatchObject({ status: 0, stdout: "" });
    expect(run({}, { args: ["--reset"] })).toMatchObject({ status: 0, stdout: "" });
    expect(run("not json", { args: ["--reset"] })).toMatchObject({ status: 0, stdout: "" });
  });

  it("isolates state per session", () => {
    expect(denied(run(edit("/repo/src/a.ts", 10, "sA")))).toBe(true);
    expect(denied(run(edit("/repo/src/a.ts", 10, "sB")))).toBe(true);
    expect(denied(run(edit("/repo/src/a.ts", 10, "sA")))).toBe(false);
    run({ session_id: "sB" }, { args: ["--reset"] });
    expect(denied(run(edit("/repo/src/a.ts", 10, "sA")))).toBe(false);
    expect(denied(run(edit("/repo/src/a.ts", 10, "sB")))).toBe(true);
  });

  it.each([
    ["Edit", edit("/repo/src/a.ts", 10, "t-edit")],
    ["Write", write("/repo/src/a.ts", 10, "t-write")],
    ["MultiEdit", multi("/repo/src/a.ts", 10, 1, "t-multi")],
    ["NotebookEdit", notebook("/repo/nb.ipynb", 10, "t-nb")],
  ])("gates %s", (_tool, input) => {
    expect(denied(run(input))).toBe(true);
    expect(denied(run(input))).toBe(false);
  });

  it("ignores tools it does not gate", () => {
    const r = run({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(r).toMatchObject({ status: 0, stdout: "" });
    expect(events()).toEqual([]);
  });

  it.each([
    "/repo/test/foo.ts",
    "/repo/tests/foo.ts",
    "/repo/src/__tests__/foo.ts",
    "/repo/src/foo.test.ts",
    "/repo/src/foo.spec.tsx",
    "C:\\repo\\test\\foo.ts",
    "C:\\repo\\src\\foo.test.ts",
    "test/foo.ts",
  ])("bypasses test file %s", (file) => {
    expect(run(write(file, 50)).stdout).toBe("");
    expect(decisions()).toEqual(["allow-bypass-test"]);
  });

  it("does not bypass near-miss paths", () => {
    expect(denied(run(write("/repo/src/contest.ts", 50, "n1")))).toBe(true);
    expect(denied(run(write("/repo/src/attest/x.ts", 50, "n2")))).toBe(true);
  });

  it("bypasses trivial edits: 4 lines allowed, 5 lines denied (Edit)", () => {
    expect(run({ ...edit("/repo/src/a.ts", 4), tool_input: { file_path: "/repo/src/a.ts", old_string: lines(4), new_string: lines(4) } }).stdout).toBe("");
    expect(decisions()).toEqual(["allow-bypass-trivial"]);
    expect(denied(run({ ...edit("/repo/src/a.ts", 5), tool_input: { file_path: "/repo/src/a.ts", old_string: lines(5), new_string: "x" } }))).toBe(true);
  });

  it("uses the larger of old and new line counts for Edit", () => {
    const input = { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: lines(5) } };
    expect(denied(run(input))).toBe(true);
  });

  it("bypasses trivial edits: 4 lines allowed, 5 lines denied (Write)", () => {
    expect(run(write("/repo/src/a.ts", 4)).stdout).toBe("");
    expect(denied(run(write("/repo/src/a.ts", 5)))).toBe(true);
    expect(decisions()).toEqual(["allow-bypass-trivial", "deny"]);
  });

  it("sums MultiEdit lines: 4 allowed, 5 denied", () => {
    expect(run(multi("/repo/src/a.ts", 2, 2)).stdout).toBe("");
    expect(denied(run(multi("/repo/src/a.ts", 1, 5)))).toBe(true);
  });

  it("applies the same limit to NotebookEdit", () => {
    expect(run(notebook("/repo/nb.ipynb", 4)).stdout).toBe("");
    expect(denied(run(notebook("/repo/nb.ipynb", 5)))).toBe(true);
  });

  it("is inert unless OPENRIG_GATEGUARD is truthy", () => {
    for (const gate of [undefined, "", "0", "false", "off", "no", "maybe"]) {
      const r = run(edit("/repo/src/a.ts", 10), { gate });
      expect(r, `gate=${String(gate)}`).toMatchObject({ status: 0, stdout: "" });
    }
    expect(existsSync(path.join(home, "state"))).toBe(false);
    for (const [i, gate] of ["1", "true", "TRUE", "on", "yes"].entries()) {
      expect(denied(run(edit("/repo/src/a.ts", 10, `on-${i}`), { gate })), `gate=${gate}`).toBe(true);
    }
  });

  it("fails open on bad JSON, empty stdin, and non-object JSON", () => {
    for (const input of ["{not json", "", "[]", "null", "42"]) {
      expect(run(input), JSON.stringify(input)).toMatchObject({ status: 0, stdout: "" });
    }
    expect(decisions()).toEqual(Array(5).fill("allow-error"));
  });

  it("fails open when session_id is missing", () => {
    expect(run({ tool_name: "Write", tool_input: { file_path: "/a.ts", content: lines(10) } })).toMatchObject({ status: 0, stdout: "" });
  });

  it("fails open when the state dir cannot be written", () => {
    const blocker = path.join(home, "not-a-dir");
    writeFileSync(blocker, "x");
    const r = run(edit("/repo/src/a.ts", 10), { home: blocker });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("keeps hostile session ids inside the state dir", () => {
    const hostile = ["../../escape", "..", "a/b", "/abs/path", "x\0y", ""];
    for (const id of hostile) run(edit("/repo/src/a.ts", 10, id));
    const stateDir = path.join(home, "state/gateguard");
    const names = readdirSync(stateDir);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(existsSync(path.join(home, "escape.json"))).toBe(false);
    expect(readdirSync(home)).toEqual(["state"]);
    // A hostile id still gets normal deny-then-allow behaviour.
    expect(denied(run(edit("/repo/src/a.ts", 10, "../../escape")))).toBe(false);
  });

  it("writes one event line per decision with the right fields", () => {
    run(edit("/repo/src/a.ts", 10));
    run(edit("/repo/src/a.ts", 10));
    run(write("/repo/src/foo.test.ts", 10));
    run(write("/repo/src/b.ts", 2));
    run("bad json");
    const logged = events();
    expect(logged.map((e) => e.decision)).toEqual(["deny", "allow-second", "allow-bypass-test", "allow-bypass-trivial", "allow-error"]);
    expect(logged[0]).toMatchObject({ session: "s1", tool: "Edit", file: "/repo/src/a.ts", decision: "deny" });
    for (const e of logged) expect(Number.isNaN(Date.parse(e.ts!))).toBe(false);
  });

  it("writes no event log when the gate is off", () => {
    run(edit("/repo/src/a.ts", 10), { gate: "0" });
    expect(events()).toEqual([]);
  });
});

describe("RIG-63 GateGuard claude.json registration", () => {
  const manifest = JSON.parse(readFileSync(CLAUDE_HOOKS, "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
  };

  it("registers the PreToolUse gate with the file-edit matcher", () => {
    const entries = manifest.hooks.PreToolUse ?? [];
    const entry = entries.find((e) => e.hooks.some((h) => h.command.includes("gateguard.cjs")));
    expect(entry?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(entry?.hooks[0]).toEqual({
      type: "command",
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gateguard.cjs"',
      timeout: 5,
    });
  });

  it("registers the --reset hook on UserPromptSubmit", () => {
    const commands = (manifest.hooks.UserPromptSubmit ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain('node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gateguard.cjs" --reset');
  });

  it("every plugin-relative command in the manifest exists on disk", () => {
    const missing: string[] = [];
    for (const entries of Object.values(manifest.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          const match = hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/);
          if (match && !existsSync(path.join(PLUGIN, match[1]!))) missing.push(match[1]!);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
