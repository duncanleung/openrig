// RIG-97: calibrated PR-risk classifier backed by the TypeSafe AI System One API.
//
// SHADOW MODE: nothing here gates a merge. The verdict is reported next to the rule-based
// bucket so a human can compare the two over time (ADR-0008). Everything that leaves the
// process is a redacted summary of paths and counts: no source text, no diff hunks, no
// commit messages.

import { redactDigestValue } from "./digest-redaction.js";

export const JEV_DEFAULT_MODEL = "jev-1.13";
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_TIMEOUT_MS = 10_000;
export const JEV_DEFAULT_THRESHOLD = 0.8;
export const MAX_SUMMARY_FILES = 200;

export const RISK_CLASSES = ["AUTO", "ADJUDICATE_LIGHT", "ADJUDICATE_HEAVY", "ESCALATE"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export type FileKind = "test" | "docs" | "source" | "config" | "migration" | "other";

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrSummaryInput {
  files: ChangedFile[];
  /** Bucket from the rule-based classifier (AUTO, ADJUDICATE_LIGHT, ...). */
  ruleBucket: string;
  /** Optional override for the number of test files; derived from paths when absent. */
  testFileCount?: number;
}

export interface PrSummary {
  ruleBucket: string;
  files: Array<{ path: string; additions: number; deletions: number; kind: FileKind }>;
  truncatedFiles: number;
  totals: { files: number; additions: number; deletions: number };
  kindCounts: Record<FileKind, number>;
  testFileRatio: number;
}

export function fileKind(path: string): FileKind {
  const p = path.toLowerCase();
  if (/(^|\/)migrations?\//.test(p)) return "migration";
  if (/(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[a-z0-9]+$/.test(p)) return "test";
  if (/(^|\/)docs?\//.test(p) || /\.(md|mdx|txt|rst)$/.test(p)) return "docs";
  if (/\.(ya?ml|toml|json|ini|env)$/.test(p) || /(^|\/)\.[a-z]+rc$/.test(p)) return "config";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sh|sql|css|html)$/.test(p)) return "source";
  return "other";
}

function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Build the only payload that is ever sent to the vendor. Paths and counts only. */
export function buildPrSummary(input: PrSummaryInput): PrSummary {
  const all = input.files.map((f) => ({
    path: String(f.path),
    additions: count(f.additions),
    deletions: count(f.deletions),
    kind: fileKind(String(f.path)),
  }));
  const kindCounts: Record<FileKind, number> = { test: 0, docs: 0, source: 0, config: 0, migration: 0, other: 0 };
  let additions = 0;
  let deletions = 0;
  for (const f of all) {
    kindCounts[f.kind] += 1;
    additions += f.additions;
    deletions += f.deletions;
  }
  const testFiles = input.testFileCount !== undefined ? count(input.testFileCount) : kindCounts.test;
  const summary: PrSummary = {
    ruleBucket: String(input.ruleBucket),
    files: all.slice(0, MAX_SUMMARY_FILES),
    truncatedFiles: Math.max(0, all.length - MAX_SUMMARY_FILES),
    totals: { files: all.length, additions, deletions },
    kindCounts,
    testFileRatio: all.length === 0 ? 0 : Math.min(1, testFiles / all.length),
  };
  return redactDigestValue(summary);
}

export interface JevVerdict {
  model: string;
  riskClass: { choice: RiskClass; probabilities: Record<string, number>; confidence: number };
  autoMergeSafe: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface JevOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
}

const QUESTIONS = {
  risk_class: {
    type: "choice",
    instructions:
      "Classify the review risk of this pull request from its changed-file summary (paths, kinds, line counts, test ratio).",
    criteria: {
      AUTO: "Peripheral changes only (docs, tests, scripts); safe to merge without extra review.",
      ADJUDICATE_LIGHT: "Small, well-tested source change with limited blast radius; a quick second look suffices.",
      ADJUDICATE_HEAVY: "Large or cross-cutting source change, or thin test coverage; needs a careful second review.",
      ESCALATE: "Touches migrations, security, permissions, concurrency or other irreversible behavior; a human must decide.",
    },
  },
  auto_merge_safe: {
    type: "noul",
    instructions: "This pull request is safe to auto-merge after dual-stack review.",
  },
} as const;

function isUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

function tokenCount(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseVerdict(body: unknown): JevVerdict | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || b.model === "") return null;
  const answers = b.answers as Record<string, any> | null | undefined;
  if (!answers || typeof answers !== "object") return null;
  const rc = answers.risk_class;
  const ams = answers.auto_merge_safe;
  if (!rc || rc.type !== "choice" || typeof rc.choice !== "string") return null;
  if (!(RISK_CLASSES as readonly string[]).includes(rc.choice)) return null;
  if (!rc.probabilities || typeof rc.probabilities !== "object" || Array.isArray(rc.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(rc.probabilities as Record<string, unknown>)) {
    if (!isUnit(v)) return null;
    probabilities[k] = v;
  }
  if (!isUnit(rc.confidence)) return null;
  if (!ams || ams.type !== "noul" || !isUnit(ams.noul)) return null;
  const verdict: JevVerdict = {
    model: b.model,
    riskClass: { choice: rc.choice as RiskClass, probabilities, confidence: rc.confidence },
    autoMergeSafe: ams.noul,
  };
  const usage = b.usage as Record<string, unknown> | null | undefined;
  if (usage && typeof usage === "object") {
    const inputTokens = tokenCount(usage.input_tokens);
    const outputTokens = tokenCount(usage.output_tokens);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      verdict.usage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      };
    }
  }
  return verdict;
}

/**
 * Ask System One to classify the summary. Returns null on any failure: missing key, non-2xx,
 * network error, timeout, invalid JSON, malformed shape. Never throws, never retries, never
 * echoes the API key.
 */
export async function classifyWithJev(summary: PrSummary, opts: JevOptions = {}): Promise<JevVerdict | null> {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    const request = (async () => {
      const res = await fetchImpl(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: summary, model: opts.model ?? JEV_DEFAULT_MODEL, questions: QUESTIONS }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return parseVerdict(await res.json());
    })();
    request.catch(() => {}); // a late rejection after the timeout wins the race must not go unhandled
    return await Promise.race([request, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reporting only. In shadow mode (ADR-0008) no caller may gate a merge on this result.
 * ESCALATE from the rule-based classifier is a floor the Jev score can never lower.
 * The threshold comparison is `>=`: a score exactly at the threshold passes.
 */
export function decideJev(
  verdict: JevVerdict | null,
  ruleBucket: string,
  threshold: number = JEV_DEFAULT_THRESHOLD,
): { wouldAutoMerge: boolean; reason: string } {
  if (ruleBucket === "ESCALATE") return { wouldAutoMerge: false, reason: "rule bucket is ESCALATE (floor)" };
  if (!verdict) return { wouldAutoMerge: false, reason: "no Jev verdict available" };
  if (verdict.autoMergeSafe < threshold) {
    return { wouldAutoMerge: false, reason: `auto_merge_safe ${verdict.autoMergeSafe} is below threshold ${threshold}` };
  }
  return { wouldAutoMerge: true, reason: `auto_merge_safe ${verdict.autoMergeSafe} meets threshold ${threshold}` };
}
