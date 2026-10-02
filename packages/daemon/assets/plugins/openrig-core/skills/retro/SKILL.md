---
name: retro
description: "Use when asked for a retrospective, session review, environment improvement analysis, or /retro. Analyzes the current seat's transcript and produces prioritized environment improvements across 7 categories: navigation, automated checks, coding standards, instruction quality, tool economy, context efficiency, and cross-seat coordination. Output is propose-only — never auto-applies changes."
metadata:
  openrig:
    stage: field-captured
    sibling_skills:
      - openrig-skills
      - pr-review-lifecycle
---

# /retro — Session Retrospective

Analyze the current seat's transcript and produce prioritized environment improvements. Output is propose-only: list what to change and why, then stop. Do not apply changes.

## When to use

- After completing a task or a multi-session ticket
- When the operator asks for a retrospective or environment review
- When patterns of repeated work or errors are visible

## Input contract

- **Default:** analyze the current seat's transcript (session ID from `$CLAUDE_CODE_SESSION_ID`)
- **`--rig`:** loop over all seats + one cross-seat pass (category 7)
- **`--seat <name>`:** analyze a specific named seat's transcript
- **`--transcript <path>`:** analyze a specific JSONL file directly

## Step 1 — Locate the transcript

```bash
# Default: current session
echo $CLAUDE_CODE_SESSION_ID
ls ~/.claude/projects/*/\${CLAUDE_CODE_SESSION_ID}.jsonl 2>/dev/null | head -1
```

If `--seat <name>` was given, find the most recent JSONL for that seat:
```bash
rig whoami --json   # shows transcriptPath for self
# For another seat, use rig capture or ask orch-lead for the transcript path
```

## Step 2 — Run the pre-reduction script

Run the deterministic extraction script BEFORE the LLM analysis pass. This reduces the raw transcript (~39K tokens) to a structured digest (~5-10K tokens).

The script is at `<base-directory>/scripts/reduce-transcript.mjs` where `<base-directory>` is this skill's base directory (shown in the injected header above). You may also use the installed copy at `~/.claude/skills/retro/scripts/reduce-transcript.mjs`.

```bash
node <base-directory>/scripts/reduce-transcript.mjs <path-to.jsonl>
```

The script outputs a JSON digest to stdout. Capture it. If the script errors, report the error and stop — do not attempt LLM analysis on the raw transcript.

**Digest schema:**
```json
{
  "seat": "dev-impl@openrig",
  "totalTurns": 142,
  "toolCalls": { "Read": 45, "Edit": 12, "Bash": 30, "Write": 5, "Skill": 3 },
  "repeatedReads": [{ "path": "packages/daemon/src/domain/types.ts", "count": 13 }],
  "reviewFindings": ["finding text 1", "finding text 2"],
  "handoffEvents": [{ "type": "send", "to": "orch-lead@openrig", "message": "...", "turn": 372 }],
  "claudeMdLoaded": ["CLAUDE.md", "AGENTS.md"],
  "errors": [{ "tool": "Bash", "message": "error: unknown option '--assigned-to'", "turn": 55 }]
}
```

## Step 3 — Analyze the digest across 7 categories

Using the digest, analyze each category. Every finding must cite transcript evidence: seat name, turn number (from the digest field), or path.

### Category 1 — Navigation

**What to check:** repeated reads on the same paths (waste signal), missing codemap/as-built pointers that would have directed the agent to the right file in fewer reads.

Signal: `digest.repeatedReads` where `count > 2`.

For each heavily-repeated path, ask: does `docs/as-built/codemap.md` already point to this file? If not, that is the finding.

### Category 2 — Automated checks

**What to check:** review findings that a linter, type checker, or automated test could have caught before human review.

Signal: `digest.reviewFindings` — look for findings about type errors, null handling, missing fields, or patterns a static check could catch.

### Category 3 — Coding standards

**What to check:** recurring review findings that should become a CLAUDE.md instruction or a lint rule — patterns that appeared in review and would appear again without a standing instruction.

Signal: `digest.reviewFindings` — find patterns that repeat across two or more findings.

### Category 4 — Instruction quality

**What to check:** CLAUDE.md / AGENTS.md instructions that were loaded but did not prevent errors in the session. Apply the writing-for-agents framework: are any instructions no-ops, sediment, or negation traps?

Signal: `digest.claudeMdLoaded` (which files were loaded), `digest.errors` (failures that a better instruction might have prevented).

Reference: `docs/reference/writing-for-agents.md` for the analysis checklist.

### Category 5 — Tool economy

**What to check:** token waste from unnecessary operations. Repeated reads on the same file in the same task. Redundant searches. Bash commands that could have been a Read.

Signal: `digest.repeatedReads` (high-count paths), `digest.toolCalls` (disproportionate Read-to-Edit ratio).

### Category 6 — Context efficiency

**What to check:** missing context the agent should have had at the start: missing codemap pointers, skills that were not available, as-built docs not loaded, reference docs not found.

Signal: `digest.errors` (failed lookups, unknown skills), `digest.repeatedReads` (navigated to files instead of reading a pointer).

### Category 7 — Cross-seat coordination (rig-wide only)

**What to check:** failed handoffs, lost messages, work duplicated across seats.

Signal: `digest.handoffEvents` across all seats. Only run in `--rig` mode.

## Step 4 — Format the output

For each finding, use this format. Never include a finding without a citation.

```
### Finding: <short title>

**Category:** <N> — <category name>
**Evidence:** <seat name>, turns <X-Y> — <what the evidence shows>
**Recommendation:** <specific proposed change — quote the proposed instruction text or file edit>
**Impact:** <what improves if this is applied>
```

Group findings by priority:
1. **High-impact findings** — prevent repeated review findings or significant token waste
2. **Instruction improvements** — CLAUDE.md / AGENTS.md changes
3. **Navigation improvements** — codemap / as-built additions
4. **Low-signal / optional** — minor improvements

End the report with a summary table:

```
## Summary

| # | Category | Finding | Recommendation | Impact |
|---|----------|---------|----------------|--------|
| 1 | Navigation | seat-handover-service.ts read 49× | Add pointer to codemap | ~500 tokens/task |
```

## Output contract

- Propose only. Do not edit CLAUDE.md, AGENTS.md, or any codemap.
- Every finding has a citation (seat + turn range or path).
- If a category has no findings, write "No findings — [brief reason]."
- End with the summary table.
