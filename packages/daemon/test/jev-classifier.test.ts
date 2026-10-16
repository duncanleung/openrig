import { describe, it, expect, vi } from "vitest";
import {
  buildPrSummary,
  classifyWithJev,
  decideJev,
  fileKind,
  MAX_SUMMARY_FILES,
  type JevVerdict,
} from "../src/domain/jev-classifier.js";

const KEY = "tsk_test_SECRETKEY_1234567890";

const goodBody = {
  model: "jev-1.13.0",
  answers: {
    risk_class: {
      type: "choice",
      choice: "ADJUDICATE_LIGHT",
      probabilities: { AUTO: 0.1, ADJUDICATE_LIGHT: 0.7, ADJUDICATE_HEAVY: 0.15, ESCALATE: 0.05 },
      confidence: 0.7,
    },
    auto_merge_safe: { type: "noul", noul: 0.85 },
  },
  usage: { input_tokens: 120, output_tokens: null },
};

function okFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const summary = buildPrSummary({ files: [{ path: "src/a.ts", additions: 3, deletions: 1 }], ruleBucket: "AUTO" });

function withAnswers(patch: Record<string, unknown>) {
  return { ...goodBody, answers: { ...goodBody.answers, ...patch } };
}

describe("buildPrSummary", () => {
  it("derives kinds, totals and test ratio from paths only", () => {
    const s = buildPrSummary({
      ruleBucket: "ADJUDICATE_LIGHT",
      files: [
        { path: "packages/daemon/src/x.ts", additions: 10, deletions: 2 },
        { path: "packages/daemon/test/x.test.ts", additions: 20, deletions: 0 },
        { path: "docs/a.md", additions: 1, deletions: 1 },
        { path: "packages/daemon/src/db/migrations/001.sql", additions: 5, deletions: 0 },
        { path: ".factory.yml", additions: 1, deletions: 0 },
      ],
    });
    expect(s.totals).toEqual({ files: 5, additions: 37, deletions: 3 });
    expect(s.kindCounts).toMatchObject({ source: 1, test: 1, docs: 1, migration: 1, config: 1 });
    expect(s.testFileRatio).toBeCloseTo(0.2);
    expect(s.ruleBucket).toBe("ADJUDICATE_LIGHT");
    expect(Object.keys(s.files[0]!).sort()).toEqual(["additions", "deletions", "kind", "path"]);
  });

  it("classifies file kinds", () => {
    expect(fileKind("a/b.spec.ts")).toBe("test");
    expect(fileKind("README.md")).toBe("docs");
    expect(fileKind("package.json")).toBe("config");
    expect(fileKind("logo.png")).toBe("other");
  });

  it("caps the file list and records the truncated count", () => {
    const files = Array.from({ length: MAX_SUMMARY_FILES + 25 }, (_, i) => ({ path: `src/f${i}.ts`, additions: 1, deletions: 0 }));
    const s = buildPrSummary({ files, ruleBucket: "AUTO" });
    expect(s.files).toHaveLength(MAX_SUMMARY_FILES);
    expect(s.truncatedFiles).toBe(25);
    expect(s.totals.files).toBe(MAX_SUMMARY_FILES + 25);
  });

  it("redacts secrets embedded in paths", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const s = buildPrSummary({ files: [{ path: `config/${secret}.json`, additions: 1, deletions: 0 }], ruleBucket: "AUTO" });
    expect(JSON.stringify(s)).not.toContain(secret);
    expect(JSON.stringify(s)).toContain("[REDACTED]");
  });

  it("carries no source-text fields even if the input has extra properties", () => {
    const s = buildPrSummary({
      ruleBucket: "AUTO",
      files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "const password = 'hunter2'", message: "fix: x" } as any],
    });
    const json = JSON.stringify(s);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("fix: x");
  });

  it("handles an empty file list", () => {
    expect(buildPrSummary({ files: [], ruleBucket: "AUTO" }).testFileRatio).toBe(0);
  });
});

describe("classifyWithJev", () => {
  it("parses a successful response and sends the bearer header to the systemone endpoint", async () => {
    const fetchImpl = okFetch(goodBody);
    const v = await classifyWithJev(summary, { apiKey: KEY, fetchImpl });
    expect(v).toEqual({
      model: "jev-1.13.0",
      riskClass: { choice: "ADJUDICATE_LIGHT", probabilities: goodBody.answers.risk_class.probabilities, confidence: 0.7 },
      autoMergeSafe: 0.85,
      usage: { inputTokens: 120 },
    });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("jev-latest");
    expect(Object.keys(sent.questions)).toEqual(["risk_class", "auto_merge_safe"]);
    expect(sent.state).toEqual(summary);
  });

  it("honors model and baseUrl options", async () => {
    const fetchImpl = okFetch(goodBody);
    await classifyWithJev(summary, { apiKey: KEY, fetchImpl, model: "jev-latest", baseUrl: "http://localhost:1/" });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("http://localhost:1/v1/systemone");
    expect(JSON.parse(init.body).model).toBe("jev-latest");
  });

  it("makes no network call without a key", async () => {
    const fetchImpl = okFetch(goodBody);
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(await classifyWithJev(summary, { fetchImpl })).toBeNull();
      expect(await classifyWithJev(summary, { apiKey: "", fetchImpl })).toBeNull();
      expect(await classifyWithJev(summary, { apiKey: "   ", fetchImpl })).toBeNull();
    } finally {
      if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the key from TYPESAFE_API_KEY when not injected", async () => {
    const fetchImpl = okFetch(goodBody);
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    try {
      expect(await classifyWithJev(summary, { fetchImpl })).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prev;
    }
  });

  it.each([500, 401, 429])("returns null on HTTP %i without retrying", async (status) => {
    const fetchImpl = okFetch({ error: "x" }, status);
    expect(await classifyWithJev(summary, { apiKey: KEY, fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null on network rejection, and the key is not exposed", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`connect failed ${KEY}`); }) as unknown as typeof fetch;
    const v = await classifyWithJev(summary, { apiKey: KEY, fetchImpl });
    expect(v).toBeNull();
  });

  it("returns null on timeout when fetch never resolves", async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    expect(await classifyWithJev(summary, { apiKey: KEY, fetchImpl, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns null when fetch rejects on abort", async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    expect(await classifyWithJev(summary, { apiKey: KEY, fetchImpl, timeoutMs: 30 })).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json{", { status: 200 })) as unknown as typeof fetch;
    expect(await classifyWithJev(summary, { apiKey: KEY, fetchImpl })).toBeNull();
  });

  it.each([
    ["null body", null],
    ["missing model", { ...goodBody, model: undefined }],
    ["missing answers", { model: "m" }],
    ["risk_class wrong type", withAnswers({ risk_class: { type: "noul", noul: 0.5 } })],
    ["choice not a string", withAnswers({ risk_class: { ...goodBody.answers.risk_class, choice: 3 } })],
    ["unknown choice label", withAnswers({ risk_class: { ...goodBody.answers.risk_class, choice: "MAYBE" } })],
    ["probability not a number", withAnswers({ risk_class: { ...goodBody.answers.risk_class, probabilities: { AUTO: "high" } } })],
    ["probability out of range", withAnswers({ risk_class: { ...goodBody.answers.risk_class, probabilities: { AUTO: 1.5 } } })],
    ["confidence out of range", withAnswers({ risk_class: { ...goodBody.answers.risk_class, confidence: 2 } })],
    ["noul is a string", withAnswers({ auto_merge_safe: { type: "noul", noul: "0.9" } })],
    ["noul above 1", withAnswers({ auto_merge_safe: { type: "noul", noul: 1.2 } })],
    ["noul below 0", withAnswers({ auto_merge_safe: { type: "noul", noul: -0.1 } })],
    ["noul NaN-like null", withAnswers({ auto_merge_safe: { type: "noul", noul: null } })],
    ["auto_merge_safe missing", withAnswers({ auto_merge_safe: undefined })],
  ])("returns null on malformed shape: %s", async (_name, body) => {
    expect(await classifyWithJev(summary, { apiKey: KEY, fetchImpl: okFetch(body) })).toBeNull();
  });

  it("never puts the key in the request body or the returned verdict", async () => {
    const fetchImpl = okFetch(goodBody);
    const v = await classifyWithJev(summary, { apiKey: KEY, fetchImpl });
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.body).not.toContain(KEY);
    expect(JSON.stringify(v)).not.toContain(KEY);
  });

  it("tolerates missing usage", async () => {
    const { usage: _u, ...rest } = goodBody;
    const v = await classifyWithJev(summary, { apiKey: KEY, fetchImpl: okFetch(rest) });
    expect(v).not.toBeNull();
    expect(v!.usage).toBeUndefined();
  });
});

describe("decideJev (reporting only)", () => {
  const verdict = (autoMergeSafe: number): JevVerdict => ({
    model: "m",
    riskClass: { choice: "AUTO", probabilities: {}, confidence: 1 },
    autoMergeSafe,
  });

  it("uses >= against the threshold", () => {
    expect(decideJev(verdict(0.79), "AUTO", 0.8).wouldAutoMerge).toBe(false);
    expect(decideJev(verdict(0.8), "AUTO", 0.8).wouldAutoMerge).toBe(true);
    expect(decideJev(verdict(0.81), "AUTO", 0.8).wouldAutoMerge).toBe(true);
  });

  it("never lowers an ESCALATE rule bucket", () => {
    const d = decideJev(verdict(1), "ESCALATE", 0.8);
    expect(d.wouldAutoMerge).toBe(false);
    expect(d.reason).toContain("ESCALATE");
  });

  it("is false for a null verdict", () => {
    expect(decideJev(null, "AUTO", 0.8)).toMatchObject({ wouldAutoMerge: false });
  });

  it("defaults the threshold to 0.8", () => {
    expect(decideJev(verdict(0.8), "AUTO").wouldAutoMerge).toBe(true);
    expect(decideJev(verdict(0.79), "AUTO").wouldAutoMerge).toBe(false);
  });
});
