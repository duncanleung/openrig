/**
 * Review finding suppress rules (RIG-9).
 *
 * Pure logic, no database and no I/O. The pipeline that reviews code calls
 * applySuppressRules() before it shows findings. A suppressed finding is not
 * dropped silently: it comes back in `suppressed` with the rule id and reason, so
 * the caller can log it for audit.
 *
 * Safety valve: a finding is never suppressed when its verdict is must-fix or its
 * category is security. The caller can also pass `override` to show every finding
 * for one review.
 *
 * Rule scope: a rule applies only to the repo it names. A quarantined rule applies
 * only to the review of its source PR. An active rule applies to the whole repo.
 * A retired rule applies nowhere.
 */

export const USER_ACTIONS = ["accepted", "dismissed", "fixed-before-merge", "deferred"] as const;
export type UserAction = (typeof USER_ACTIONS)[number];

export function isUserAction(value: unknown): value is UserAction {
  return typeof value === "string" && (USER_ACTIONS as readonly string[]).includes(value);
}

export const SUPPRESS_RULE_STATUSES = ["quarantined", "active", "retired"] as const;
export type SuppressRuleStatus = (typeof SUPPRESS_RULE_STATUSES)[number];

export interface SuppressRule {
  id: number;
  repo: string;
  category: string | null;
  fileGlob: string | null;
  descriptionHash: string | null;
  reason: string;
  status: SuppressRuleStatus;
  quarantinedPr: number | null;
  createdAt: string;
  lastMatchedAt: string | null;
  matchCount: number;
}

/** The fields of a finding that a rule can match on. */
export interface SuppressibleFinding {
  findingId: string;
  file: string | null;
  category: string | null;
  verdict: string | null;
  descriptionHash: string | null;
}

export interface SuppressOptions {
  /** The repo under review. Rules for another repo never apply. */
  repo: string;
  /** The PR under review. A quarantined rule applies only when this equals its source PR. */
  prNumber?: number | null;
  /** Show every finding for this review. Nothing is suppressed. */
  override?: boolean;
}

export interface SuppressedFinding<F extends SuppressibleFinding> {
  finding: F;
  ruleId: number;
  reason: string;
}

export interface SuppressResult<F extends SuppressibleFinding> {
  shown: F[];
  suppressed: SuppressedFinding<F>[];
  /** True when the caller asked to show every finding. */
  overridden: boolean;
}

function normalizeToken(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** A finding that no suppress rule can hide: must-fix verdicts and security findings. */
export function isSuppressExempt(finding: Pick<SuppressibleFinding, "verdict" | "category">): boolean {
  return normalizeToken(finding.verdict) === "must_fix" || normalizeToken(finding.category) === "security";
}

/**
 * Glob to regex. `**` crosses directories, `*` and `?` stay inside one path segment.
 * A glob with no `/` matches against the file's base name, so "*_test.go" covers
 * every directory.
 */
export function fileGlobMatches(glob: string, file: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const target = glob.includes("/") ? file : file.slice(file.lastIndexOf("/") + 1);
  return new RegExp(`^${re}$`).test(target);
}

/** True when the rule is in scope for this review (repo, status, quarantine). */
export function ruleAppliesToReview(rule: SuppressRule, opts: SuppressOptions): boolean {
  if (rule.repo !== opts.repo) return false;
  if (rule.status === "active") return true;
  if (rule.status === "quarantined") {
    return rule.quarantinedPr != null && opts.prNumber != null && rule.quarantinedPr === opts.prNumber;
  }
  return false;
}

/** Every matcher the rule sets must match. A rule with no matcher matches nothing. */
export function ruleMatchesFinding(rule: SuppressRule, finding: SuppressibleFinding): boolean {
  if (rule.category == null && rule.fileGlob == null && rule.descriptionHash == null) return false;
  if (rule.category != null && normalizeToken(rule.category) !== normalizeToken(finding.category)) return false;
  if (rule.fileGlob != null && (finding.file == null || !fileGlobMatches(rule.fileGlob, finding.file))) return false;
  if (rule.descriptionHash != null && rule.descriptionHash !== finding.descriptionHash) return false;
  return true;
}

export function applySuppressRules<F extends SuppressibleFinding>(
  findings: readonly F[],
  rules: readonly SuppressRule[],
  opts: SuppressOptions,
): SuppressResult<F> {
  if (opts.override === true) {
    return { shown: [...findings], suppressed: [], overridden: true };
  }
  const inScope = rules.filter((r) => ruleAppliesToReview(r, opts));
  const shown: F[] = [];
  const suppressed: SuppressedFinding<F>[] = [];
  for (const finding of findings) {
    if (isSuppressExempt(finding)) {
      shown.push(finding);
      continue;
    }
    const rule = inScope.find((r) => ruleMatchesFinding(r, finding));
    if (rule) suppressed.push({ finding, ruleId: rule.id, reason: rule.reason });
    else shown.push(finding);
  }
  return { shown, suppressed, overridden: false };
}

export interface ReviewRunStart {
  repo: string | null;
  /** ISO or SQLite datetime text. Runs with no start time are ignored. */
  startedAt: string | null;
}

export interface StaleSuppressRule {
  rule: SuppressRule;
  /** Review runs for the rule's repo since the rule last matched (or was created). */
  runsSinceMatch: number;
}

function toMs(value: string): number {
  // SQLite datetime('now') has no zone; read it as UTC.
  const text = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  return Date.parse(text);
}

/**
 * Unmatched-rule detection. An active or quarantined rule is stale when at least
 * `maxRunsWithoutMatch` review runs of its repo started after its last match (or
 * after its creation when it never matched). Stale rules mask nothing today but
 * may hide a real finding tomorrow, so the caller flags them for retirement.
 * Retired rules are never reported.
 */
export function findStaleSuppressRules(
  rules: readonly SuppressRule[],
  runs: readonly ReviewRunStart[],
  maxRunsWithoutMatch = 10,
): StaleSuppressRule[] {
  const stale: StaleSuppressRule[] = [];
  for (const rule of rules) {
    if (rule.status === "retired") continue;
    const since = toMs(rule.lastMatchedAt ?? rule.createdAt);
    if (Number.isNaN(since)) continue;
    let runsSinceMatch = 0;
    for (const run of runs) {
      if (run.repo !== rule.repo || run.startedAt == null) continue;
      const at = toMs(run.startedAt);
      if (!Number.isNaN(at) && at > since) runsSinceMatch++;
    }
    if (runsSinceMatch >= maxRunsWithoutMatch) stale.push({ rule, runsSinceMatch });
  }
  return stale;
}
