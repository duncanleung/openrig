import { execFile } from "node:child_process";
import type { JevVerdict, PrSummary } from "@openrig/daemon/jev-classifier";

/**
 * `rig ticket-factory jev-classify` (RIG-99): report what the Jev classifier thinks of a PR next to
 * the rule-based bucket. SHADOW MODE (ADR-0008): the output never changes merge behavior, so
 * `effectivePolicy` is always "human-approval". A Jev failure is a null verdict, not an error.
 */

export const JEV_BUCKETS = ["AUTO", "ADJUDICATE_LIGHT", "ADJUDICATE_HEAVY", "ESCALATE"] as const;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const GH_TIMEOUT_MS = 30_000;

export interface JevClassifierApi {
  buildPrSummary(input: { files: Array<{ path: string; additions: number; deletions: number }>; ruleBucket: string }): PrSummary;
  classifyWithJev(summary: PrSummary, opts?: { fetchImpl?: typeof fetch; model?: string }): Promise<JevVerdict | null>;
  decideJev(verdict: JevVerdict | null, ruleBucket: string, threshold?: number): { wouldAutoMerge: boolean; reason: string };
  JEV_DEFAULT_MODEL: string;
  JEV_DEFAULT_THRESHOLD: number;
}

export interface JevClassifyDeps {
  /** Run `gh` with an argv array (no shell). Resolves stdout; rejects on failure. */
  runGh: (args: string[]) => Promise<string>;
  loadClassifier: () => Promise<JevClassifierApi>;
  fetchImpl?: typeof fetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface JevClassifyOptions {
  pr?: string;
  bucket?: string;
  repo?: string;
  threshold?: string;
  model?: string;
  json?: boolean;
}

export function realJevDeps(): JevClassifyDeps {
  return {
    runGh: (args) =>
      new Promise((resolve, reject) => {
        execFile("gh", args, { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, shell: false }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      }),
    loadClassifier: async () => (await import("@openrig/daemon/jev-classifier")) as unknown as JevClassifierApi,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

function scrub(text: string): string {
  const key = process.env.TYPESAFE_API_KEY;
  return key && key.trim() !== "" ? text.split(key).join("[redacted]") : text;
}

/** Returns an error message, or the validated values. */
function validate(opts: JevClassifyOptions):
  | { error: string }
  | { pr: string; bucket: string; repo?: string; threshold?: number; model?: string } {
  if (!opts.pr || !/^[1-9]\d*$/.test(opts.pr)) return { error: "--pr must be a positive integer" };
  if (!opts.bucket || !(JEV_BUCKETS as readonly string[]).includes(opts.bucket)) {
    return { error: `--bucket must be one of ${JEV_BUCKETS.join(", ")}` };
  }
  if (opts.repo !== undefined && (!REPO_PATTERN.test(opts.repo) || opts.repo.startsWith("-"))) {
    return { error: "--repo must look like owner/name" };
  }
  let threshold: number | undefined;
  if (opts.threshold !== undefined) {
    threshold = /^\s*\d*\.?\d+\s*$/.test(opts.threshold) ? Number(opts.threshold) : NaN;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return { error: "--threshold must be a number between 0 and 1" };
  }
  if (opts.model !== undefined && opts.model.trim() === "") return { error: "--model must not be empty" };
  return { pr: opts.pr, bucket: opts.bucket, repo: opts.repo, threshold, model: opts.model?.trim() };
}

function parseFiles(stdout: string): Array<{ path: string; additions: number; deletions: number }> {
  const doc = JSON.parse(stdout) as { files?: unknown };
  if (!doc || !Array.isArray(doc.files)) throw new Error("gh output has no files array");
  return doc.files.map((f: any) => ({ path: String(f?.path ?? ""), additions: Number(f?.additions ?? 0), deletions: Number(f?.deletions ?? 0) }));
}

/** Returns the process exit code. 0 even when Jev is unavailable; non-zero only for bad flags or a bad gh call. */
export async function runJevClassify(opts: JevClassifyOptions, deps: JevClassifyDeps): Promise<number> {
  const v = validate(opts);
  if ("error" in v) {
    deps.stderr(`rig ticket-factory jev-classify: ${v.error}`);
    return 1;
  }

  let files: Array<{ path: string; additions: number; deletions: number }>;
  try {
    const args = ["pr", "view", v.pr, "--json", "files", ...(v.repo ? ["--repo", v.repo] : [])];
    files = parseFiles(await deps.runGh(args));
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : "unknown error";
    deps.stderr(scrub(`rig ticket-factory jev-classify: could not read PR #${v.pr} changed files via gh: ${msg}`));
    return 1;
  }

  const api = await deps.loadClassifier();
  const model = v.model ?? api.JEV_DEFAULT_MODEL;
  const threshold = v.threshold ?? api.JEV_DEFAULT_THRESHOLD;
  const summary = api.buildPrSummary({ files, ruleBucket: v.bucket });
  let verdict: JevVerdict | null = null;
  try {
    verdict = await api.classifyWithJev(summary, { model, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  } catch {
    verdict = null; // classifyWithJev does not throw; stay safe anyway
  }
  const decision = api.decideJev(verdict, v.bucket, threshold);
  const result = {
    shadow: true,
    effectivePolicy: "human-approval",
    ruleBucket: v.bucket,
    jev: verdict,
    decision,
    model,
    threshold,
  };

  if (opts.json) {
    deps.stdout(scrub(JSON.stringify(result)));
    return 0;
  }
  const lines = [
    `jev-classify PR #${v.pr} (shadow mode; effective policy: human-approval)`,
    `  rule bucket: ${v.bucket}`,
    verdict
      ? `  jev:         ${verdict.riskClass.choice} (confidence ${verdict.riskClass.confidence}), auto_merge_safe ${verdict.autoMergeSafe}`
      : "  jev:         no verdict",
    `  decision:    would auto-merge: ${decision.wouldAutoMerge ? "yes" : "no"} (${decision.reason})`,
    `  model:       ${model}, threshold ${threshold}`,
  ];
  for (const line of lines) deps.stdout(scrub(line));
  return 0;
}
