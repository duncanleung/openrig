import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REDUCER = join(__dirname, "..", "assets", "plugins", "openrig-core", "skills", "retro", "scripts", "reduce-transcript.mjs");

type Call = { name: string; input: Record<string, unknown> };
type StallPattern = { type: string; turnRange: [number, number]; details: Record<string, unknown> };

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "reduce-stall-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

let filler = 0;
const bash = (command: string): Call => ({ name: "Bash", input: { command } });
const read = (file_path: string): Call => ({ name: "Read", input: { file_path } });
const edit = (): Call => ({ name: "Edit", input: { file_path: "/x", old_string: "a", new_string: "b" } });
/** A unique, non-mutating, non-repeating call. */
const idle = (): Call => read(`/idle/${filler++}.txt`);

/** One call per assistant message, so call index N (1-based) is turn N. */
function reduce(calls: Call[]): { stallPatterns: StallPattern[]; totalTurns: number; repeatedReads: unknown[] } {
  const lines = calls.map((c, i) => JSON.stringify({
    type: "assistant",
    message: { id: `msg_${i}`, content: [{ type: "tool_use", id: `tu_${i}`, name: c.name, input: c.input }] },
  }));
  const file = join(tmpDir, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return JSON.parse(execFileSync("node", [REDUCER, file], { encoding: "utf8" }));
}

const idles = (n: number): Call[] => Array.from({ length: n }, idle);
const ofType = (r: ReturnType<typeof reduce>, type: string) => r.stallPatterns.filter((p) => p.type === type);

describe("reduce-transcript stallPatterns — retry-loop", () => {
  it("does not flag 2 identical calls", () => {
    const r = reduce([bash("npm test"), bash("npm test"), edit()]);
    expect(ofType(r, "retry-loop")).toEqual([]);
  });

  it("flags 3 identical Bash calls with trimmed command", () => {
    const r = reduce([bash("npm test"), bash("  npm test "), edit(), bash("npm test")]);
    expect(ofType(r, "retry-loop")).toEqual([
      { type: "retry-loop", turnRange: [1, 4], details: { tool: "Bash", command: "npm test", count: 3 } },
    ]);
  });

  it("does not flag the same command with different text", () => {
    const r = reduce([bash("npm test a"), bash("npm test b"), bash("npm test c")]);
    expect(ofType(r, "retry-loop")).toEqual([]);
  });

  it("keys non-Bash tools on the JSON of the input", () => {
    const grep = (pattern: string): Call => ({ name: "Grep", input: { pattern } });
    const r = reduce([grep("foo"), grep("foo"), grep("bar"), grep("foo")]);
    expect(ofType(r, "retry-loop")).toEqual([
      { type: "retry-loop", turnRange: [1, 4], details: { tool: "Grep", command: JSON.stringify({ pattern: "foo" }), count: 3 } },
    ]);
  });

  it("flags 3 calls inside a 10-turn window (turns 1 and 10 inclusive)", () => {
    const r = reduce([bash("x"), ...idles(4), bash("x"), ...idles(3), bash("x")]);
    expect(r.totalTurns).toBe(10);
    expect(ofType(r, "retry-loop").map((p) => p.turnRange)).toEqual([[1, 10]]);
  });

  it("does not flag 3 calls at turns 1, 6 and 11 (outside the window)", () => {
    const r = reduce([bash("x"), ...idles(4), bash("x"), ...idles(4), bash("x")]);
    expect(r.totalTurns).toBe(11);
    expect(ofType(r, "retry-loop")).toEqual([]);
  });

  it("merges overlapping windows into one span with the full count", () => {
    // turns 1, 5, 9, 13, 17: every 3 consecutive calls fit a window; the windows overlap.
    const calls: Call[] = [];
    for (let i = 0; i < 5; i++) { calls.push(bash("make")); if (i < 4) calls.push(...idles(3)); }
    const r = reduce(calls);
    expect(ofType(r, "retry-loop")).toEqual([
      { type: "retry-loop", turnRange: [1, 17], details: { tool: "Bash", command: "make", count: 5 } },
    ]);
  });

  it("reports two separate loops for the same key once each", () => {
    const r = reduce([bash("a"), bash("a"), bash("a"), ...idles(30), bash("a"), bash("a"), bash("a")]);
    expect(ofType(r, "retry-loop").map((p) => [p.turnRange, p.details.count])).toEqual([
      [[1, 3], 3],
      [[34, 36], 3],
    ]);
  });

  it("truncates the command to 200 characters", () => {
    const long = "echo " + "y".repeat(500);
    const r = reduce([bash(long), bash(long), bash(long)]);
    expect((ofType(r, "retry-loop")[0].details.command as string).length).toBe(200);
  });
});

describe("reduce-transcript stallPatterns — read-storm", () => {
  it("does not flag 4 reads of one file", () => {
    const r = reduce(Array.from({ length: 4 }, () => read("/a.ts")));
    expect(ofType(r, "read-storm")).toEqual([]);
  });

  it("flags 5 reads as warn with the first and last read turn", () => {
    const r = reduce([read("/a.ts"), ...idles(2), read("/a.ts"), read("/a.ts"), edit(), read("/a.ts"), read("/a.ts")]);
    expect(ofType(r, "read-storm")).toEqual([
      { type: "read-storm", turnRange: [1, 8], details: { path: "/a.ts", count: 5, severity: "warn" } },
    ]);
  });

  it("flags 9 reads as warn and 10 reads as high", () => {
    const nine = reduce(Array.from({ length: 9 }, () => read("/a.ts")));
    expect(ofType(nine, "read-storm")[0].details).toEqual({ path: "/a.ts", count: 9, severity: "warn" });
    const ten = reduce(Array.from({ length: 10 }, () => read("/a.ts")));
    expect(ofType(ten, "read-storm")[0].details).toEqual({ path: "/a.ts", count: 10, severity: "high" });
  });

  it("leaves repeatedReads unchanged", () => {
    const r = reduce(Array.from({ length: 5 }, () => read("/a.ts")));
    expect(r.repeatedReads).toEqual([{ path: "/a.ts", count: 5 }]);
  });
});

describe("reduce-transcript stallPatterns — stall", () => {
  it("does not flag 49 turns without a mutation", () => {
    const r = reduce(idles(49));
    expect(ofType(r, "stall")).toEqual([]);
  });

  it("flags 50 turns without a mutation", () => {
    const r = reduce(idles(50));
    expect(ofType(r, "stall")).toEqual([
      { type: "stall", turnRange: [1, 50], details: { turns: 50, mutationCount: 0 } },
    ]);
  });

  it("is broken by an Edit, emitting one entry per maximal span", () => {
    const r = reduce([...idles(50), edit(), ...idles(49), ...idles(1)]);
    expect(ofType(r, "stall")).toEqual([
      { type: "stall", turnRange: [1, 50], details: { turns: 50, mutationCount: 0 } },
      { type: "stall", turnRange: [52, 101], details: { turns: 50, mutationCount: 0 } },
    ]);
  });

  it("does not flag when an Edit splits 60 turns into two short spans", () => {
    const r = reduce([...idles(30), edit(), ...idles(29)]);
    expect(ofType(r, "stall")).toEqual([]);
  });

  it("treats Write and NotebookEdit as mutations", () => {
    for (const name of ["Write", "NotebookEdit"]) {
      const r = reduce([...idles(30), { name, input: { file_path: "/x" } }, ...idles(30)]);
      expect(ofType(r, "stall")).toEqual([]);
    }
  });

  it("treats an allowlisted read-only Bash command as non-mutating", () => {
    const cmds = ["ls -la", "git status", "git log --oneline | head -5", "rig queue show abc", "gh pr view 3", "cd /x && git diff", "sleep 30", "grep foo a 2>/dev/null"];
    const r = reduce(Array.from({ length: 50 }, (_, i) => bash(cmds[i % cmds.length] + ` # ${i}`)));
    expect(ofType(r, "stall")).toHaveLength(1);
  });

  it("treats non-allowlisted or write-capable Bash commands as mutations", () => {
    for (const cmd of ["npm install", "git commit -m x", "git push", "sed -i s/a/b/ f", "cat a > b", "ls && rm f", "echo $(rm f)", "gh pr merge 3", "git status; touch f"]) {
      const r = reduce([...idles(30), bash(cmd), ...idles(30)]);
      expect(ofType(r, "stall"), cmd).toEqual([]);
    }
  });
});

describe("reduce-transcript stallPatterns — output", () => {
  it("is an empty array for a short clean session", () => {
    expect(reduce([read("/a"), edit()]).stallPatterns).toEqual([]);
  });

  it("is deterministic and ordered by turn", () => {
    const calls = [bash("x"), bash("x"), bash("x"), ...Array.from({ length: 5 }, () => read("/a.ts")), ...idles(60)];
    const a = reduce(calls);
    filler = 0;
    const b = reduce([bash("x"), bash("x"), bash("x"), ...Array.from({ length: 5 }, () => read("/a.ts")), ...idles(60)]);
    // The 5 identical Reads are also a retry-loop (same tool, identical input, 3+ in 10 turns).
    expect(a.stallPatterns.map((p) => p.type)).toEqual(["retry-loop", "retry-loop", "read-storm", "stall"]);
    expect(JSON.stringify(a.stallPatterns)).toBe(JSON.stringify(a.stallPatterns.slice().sort((x, y) => x.turnRange[0] - y.turnRange[0])));
    expect(b.stallPatterns.map((p) => p.type)).toEqual(a.stallPatterns.map((p) => p.type));
  });
});
