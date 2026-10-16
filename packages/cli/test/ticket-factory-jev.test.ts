import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runJevClassify, type JevClassifyDeps, type JevClassifyOptions } from "../src/commands/ticket-factory-jev.js";

const KEY = "sentinel-typesafe-key-DO-NOT-LEAK";
const GH_OUT = JSON.stringify({
  files: [
    { path: "packages/cli/src/a.ts", additions: 10, deletions: 2 },
    { path: "packages/cli/test/a.test.ts", additions: 20, deletions: 0 },
  ],
});

function verdictBody(autoMergeSafe: number) {
  return {
    model: "jev-latest-x",
    answers: {
      risk_class: { type: "choice", choice: "AUTO", probabilities: { AUTO: 0.9 }, confidence: 0.9 },
      auto_merge_safe: { type: "noul", noul: autoMergeSafe },
    },
  };
}

function okFetch(autoMergeSafe: number) {
  return vi.fn(async () => new Response(JSON.stringify(verdictBody(autoMergeSafe)), { status: 200 }));
}

function harness(over: Partial<JevClassifyDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const runGh = vi.fn(async (_args: string[]) => GH_OUT);
  const deps: JevClassifyDeps = {
    runGh,
    loadClassifier: async () => (await import("@openrig/daemon/jev-classifier")) as any,
    fetchImpl: okFetch(0.95) as unknown as typeof fetch,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...over,
  };
  return { deps, out, err, runGh };
}

async function run(opts: JevClassifyOptions, over: Partial<JevClassifyDeps> = {}) {
  const h = harness(over);
  const code = await runJevClassify({ pr: "7", bucket: "AUTO", json: true, ...opts }, h.deps);
  return { ...h, code, json: h.out.length && (opts.json ?? true) ? JSON.parse(h.out[0]) : null };
}

describe("rig ticket-factory jev-classify (RIG-99)", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = KEY; });
  afterEach(() => { if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved; });

  describe("flag validation", () => {
    it.each([
      [{ pr: undefined }, "--pr"],
      [{ pr: "0" }, "--pr"],
      [{ pr: "-3" }, "--pr"],
      [{ pr: "1.5" }, "--pr"],
      [{ pr: "12; rm -rf /" }, "--pr"],
      [{ pr: "$(id)" }, "--pr"],
      [{ bucket: undefined }, "--bucket"],
      [{ bucket: "auto" }, "--bucket"],
      [{ bucket: "NOPE" }, "--bucket"],
      [{ repo: "owner" }, "--repo"],
      [{ repo: "a/b; id" }, "--repo"],
      [{ repo: "a/b/c" }, "--repo"],
      [{ repo: "--web/x" }, "--repo"],
      [{ repo: "-x/y" }, "--repo"],
      [{ repo: "a/b$(id)" }, "--repo"],
      [{ threshold: "1.5" }, "--threshold"],
      [{ threshold: "-0.1" }, "--threshold"],
      [{ threshold: "abc" }, "--threshold"],
      [{ model: "  " }, "--model"],
    ] as Array<[JevClassifyOptions, string]>)("rejects %j before any process or fetch starts", async (bad, flag) => {
      const fetchImpl = vi.fn();
      const r = await run(bad, { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain(flag);
      expect(r.runGh).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(r.out).toEqual([]);
    });
  });

  it("calls gh with an argv array and passes --repo through", async () => {
    const r = await run({ repo: "duncanleung/openrig" });
    expect(r.code).toBe(0);
    expect(r.runGh).toHaveBeenCalledWith(["pr", "view", "7", "--json", "files", "--repo", "duncanleung/openrig"]);
    const r2 = await run({});
    expect(r2.runGh).toHaveBeenCalledWith(["pr", "view", "7", "--json", "files"]);
  });

  it("meets the threshold exactly and above: wouldAutoMerge true", async () => {
    const above = await run({ threshold: "0.8" }, { fetchImpl: okFetch(0.95) as unknown as typeof fetch });
    expect(above.json.decision.wouldAutoMerge).toBe(true);
    const at = await run({ threshold: "0.8" }, { fetchImpl: okFetch(0.8) as unknown as typeof fetch });
    expect(at.json.decision.wouldAutoMerge).toBe(true);
    expect(at.json.jev.autoMergeSafe).toBe(0.8);
  });

  it("below the threshold: wouldAutoMerge false", async () => {
    const r = await run({ threshold: "0.8" }, { fetchImpl: okFetch(0.79) as unknown as typeof fetch });
    expect(r.code).toBe(0);
    expect(r.json.decision.wouldAutoMerge).toBe(false);
    expect(r.json.decision.reason).toContain("below threshold");
  });

  it("ESCALATE floor: a high score with rule bucket ESCALATE never would-auto-merge", async () => {
    const r = await run({ bucket: "ESCALATE" }, { fetchImpl: okFetch(0.99) as unknown as typeof fetch });
    expect(r.code).toBe(0);
    expect(r.json.jev.autoMergeSafe).toBe(0.99);
    expect(r.json.ruleBucket).toBe("ESCALATE");
    expect(r.json.decision.wouldAutoMerge).toBe(false);
    expect(r.json.decision.reason).toContain("ESCALATE");
  });

  it("effectivePolicy is always human-approval and the shape is stable, defaults to jev-latest", async () => {
    for (const autoMergeSafe of [0.1, 0.99]) {
      for (const bucket of ["AUTO", "ESCALATE"]) {
        const r = await run({ bucket }, { fetchImpl: okFetch(autoMergeSafe) as unknown as typeof fetch });
        expect(r.json.shadow).toBe(true);
        expect(r.json.effectivePolicy).toBe("human-approval");
        expect(Object.keys(r.json).sort()).toEqual(["decision", "effectivePolicy", "jev", "model", "ruleBucket", "shadow", "threshold"]);
        expect(r.json.model).toBe("jev-latest");
        expect(r.json.threshold).toBe(0.8);
      }
    }
  });

  it("sends the requested model and only a path-and-count summary", async () => {
    const fetchImpl = okFetch(0.9);
    const r = await run({ model: "jev-custom" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.json.model).toBe("jev-custom");
    const sent = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(sent.model).toBe("jev-custom");
    expect(sent.state.totals.files).toBe(2);
  });

  it("missing key: jev null, exit 0, no fetch call", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchImpl = vi.fn();
    const r = await run({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.json.jev).toBeNull();
    expect(r.json.decision).toEqual({ wouldAutoMerge: false, reason: "no Jev verdict available" });
    expect(r.json.effectivePolicy).toBe("human-approval");
  });

  it.each([
    ["network failure", async () => { throw new Error(`connect failed with ${KEY}`); }],
    ["HTTP error", async () => new Response("nope", { status: 500 })],
    ["bad body", async () => new Response(JSON.stringify({ model: "x" }), { status: 200 })],
    ["non-JSON body", async () => new Response("<html>", { status: 200 })],
  ])("%s: jev null, exit 0", async (_n, impl) => {
    const r = await run({}, { fetchImpl: vi.fn(impl) as unknown as typeof fetch });
    expect(r.code).toBe(0);
    expect(r.json.jev).toBeNull();
    expect(r.json.decision.reason).toBe("no Jev verdict available");
  });

  it("timeout: jev null, exit 0", async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn(() => new Promise<Response>(() => {}));
      const p = run({}, { fetchImpl: never as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(11_000);
      const r = await p;
      expect(r.code).toBe(0);
      expect(r.json.jev).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gh failure: non-zero exit, clear message, no fetch", async () => {
    const fetchImpl = vi.fn();
    const r = await run({}, {
      runGh: vi.fn(async () => { throw new Error("gh: Could not resolve to a PullRequest"); }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("could not read PR #7");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.out).toEqual([]);
  });

  it("gh returns unparseable output: non-zero exit", async () => {
    const r = await run({}, { runGh: vi.fn(async () => "not json") });
    expect(r.code).toBe(1);
  });

  it("the API key never appears in any output, JSON or readable, success or failure", async () => {
    const cases: Array<[JevClassifyOptions, Partial<JevClassifyDeps>]> = [
      [{ json: true }, {}],
      [{ json: false }, {}],
      [{ json: true }, { fetchImpl: vi.fn(async () => { throw new Error(`boom ${KEY}`); }) as unknown as typeof fetch }],
      [{ json: false }, { fetchImpl: vi.fn(async () => new Response(`echo ${KEY}`, { status: 500 })) as unknown as typeof fetch }],
      [{ json: false }, { runGh: vi.fn(async () => { throw new Error(`gh failed token=${KEY}`); }) }],
    ];
    for (const [opts, over] of cases) {
      const r = await run(opts, over);
      expect([...r.out, ...r.err].join("\n")).not.toContain(KEY);
    }
  });

  it("readable output states shadow mode and the decision", async () => {
    const h = harness();
    const code = await runJevClassify({ pr: "7", bucket: "ESCALATE" }, h.deps);
    expect(code).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("shadow mode");
    expect(text).toContain("human-approval");
    expect(text).toContain("rule bucket: ESCALATE");
    expect(text).toContain("would auto-merge: no");
  });
});
