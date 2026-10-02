# Writing for Agents — Reference Framework

Last validated: 2026-10-02
Scope: SKILL.md files, CLAUDE.md files, AGENTS.md, dispatch briefs, queue items, and any other instruction text consumed by an agent.

This document describes concepts and checks for writing effective agent instructions. It does not replace judgment — it gives a vocabulary for diagnosing why an instruction works or fails.

External reference: [mattpocock/skills — writing-for-agents](https://github.com/mattpocock/skills) (original source; concepts below are adapted for OpenRig context).

---

## Core Concepts

### Context Load

**Definition:** The token cost of an instruction relative to the information it delivers. A high-context-load instruction consumes many tokens to convey a small change in behavior. A low-context-load instruction conveys a large behavioral change in few tokens.

**OpenRig example (good):** In global CLAUDE.md:
> "Use the `/adr-create` skill for the creation workflow (auto-numbering, template, validation). Do not hand-write ADR files."

Twelve words replace 200+ lines of workflow instructions. The pointer costs twelve tokens; the detail lives in the skill and is loaded only when needed.

**Anti-pattern:** The `AskUserQuestion` section of global CLAUDE.md runs to six paragraphs plus a table to convey a three-tier validation policy. Most of that text re-explains the tiers rather than defining them. The behavioral content could fit in the table alone; the surrounding paragraphs are context overhead.

**Actionable check:** Count the tokens in the instruction. Count the decisions it drives. If the ratio is high, push detail behind a pointer or a skill.

---

### Cognitive Load

**Definition:** The mental effort an agent needs to parse an instruction before it can act. High cognitive load comes from nested conditionals, multi-clause sentences, exceptions stacked on exceptions, and rules that require cross-referencing other sections to resolve.

**OpenRig example (good):** From global CLAUDE.md, ASD-STE-100 rules:
> "Active voice. One instruction per sentence. One word per meaning."

Each rule is a single, complete, unambiguous action. An agent can apply each rule without reading any other rule first.

**Anti-pattern:** From AGENTS.md:
> "Run it again after any compaction, restart or restore — **before** concluding anything about where you are or what you were doing. And if a predecessor's transcript looks thin or empty, know that transcript capture is unreliable on some runtimes — **little or no output does not mean the session was quiet.**"

This is three logical instructions compressed into two sentences with a subordinate clause, a negation, and an implicit conditional. The meaning is correct but costs more parsing effort than necessary.

**Actionable check:** Read the instruction once. Can you act on it immediately, or do you need to re-read a clause to resolve an ambiguity? If re-read is required, rewrite as two shorter sentences.

---

### Information Hierarchy

**Definition:** The principle that instructions deliver the minimum needed to act at each layer, with detail pushed behind explicit pointers. The three layers are: in-file step (execute this), in-file reference (see this section), and disclosed reference (read this external file or skill).

**OpenRig example (good):** The dispatch message for this task:
> "Read `.ai/dispatch-pocock-items-1-2.md` for the full brief."

The dispatch itself is two sentences. The brief is a separate file. An agent that only needs to know the task exists reads two sentences; an agent implementing the task reads the brief.

Another example from global CLAUDE.md:
> "Use the `/adr-create` skill for the creation workflow."

The in-file instruction is one line. The full workflow lives in the skill. The hierarchy is: CLAUDE.md → skill → skill script.

**Anti-pattern:** The `<!-- BEGIN OpenRig MANAGED BLOCK: openrig-start.md -->` section of the project CLAUDE.md inlines the full `openrig-start.md` content directly (80+ lines on `rig` commands and identity). Agents who only need the culture section must still parse past the identity block. The content belongs in a pointed resource, loaded at the moment it is relevant.

**Actionable check:** For each instruction, ask: does the agent need this detail to decide whether to proceed, or only after deciding to proceed? If the latter, push it behind a pointer.

---

### Leading Words

**Definition:** Compact pretrained concepts that anchor agent behavior in very few tokens. When an instruction uses a term the model already knows deeply — from training on technical documentation, standards, or code — it inherits all associated patterns without further explanation.

**OpenRig example (good):** From review findings comments in this codebase:
> "TOCTOU guard — `WHERE id = ? AND fallback_state IS NULL`"

"TOCTOU" triggers a full mental model: time-of-check/time-of-use race condition, the fix is an atomic conditional update, the guard belongs in the WHERE clause. Five characters carry what would take two paragraphs to explain.

Similarly, "fail-closed" in the seat-handover deliveryGuard instruction triggers defensive-programming behavior: throw on absent config, never silently succeed.

**Anti-pattern:** Writing "a check that prevents two operations from happening at the same time for the same node, so the second one does not proceed if the first is still running" instead of "in-flight guard" or "mutex per node." The long description is accurate but wastes tokens on a concept the model already has.

**Actionable check:** Does your instruction explain a concept by describing its behavior? If the concept has a standard name, use the name and remove the description.

---

### No-ops

**Definition:** Instructions the model already follows by default, without any instruction. A no-op adds token cost and visual noise without changing behavior.

**OpenRig example (no-op candidate):** From AGENTS.md:
> "Use judgment from the goal in front of you."

Models apply goal-directed reasoning by default. This instruction only becomes load-bearing when read alongside its contrast: "Keep hard rules for genuinely high-stakes boundaries." Without the contrast, the instruction is a no-op.

**A non-no-op:** From global CLAUDE.md:
> "Never commit the `.ai/` directory — scan staged files for `.ai/` paths and unstage them before committing."

No model knows this project-specific convention without being told. The instruction is necessary.

**Actionable check:** Remove the instruction from a copy of the file. Would the model's behavior on a standard task change? If not, the instruction is a no-op. Verify with a specific test task, not general intuition.

---

### Sediment

**Definition:** Stale instruction layers that accumulate over time because adding a rule feels safe and removing one feels risky. Sediment is instructions that were once necessary but no longer reflect the current environment, codebase, or policy.

**OpenRig example:** From global CLAUDE.md, Herdr section:
> "Default to `claude-opus-4-6[1m]` only when no current model is detectable."

This instruction names a specific model ID. As the model landscape changes, this default silently becomes wrong — an agent following the instruction would spin up a session on a model that may no longer be the right orchestrator choice. The instruction was written for a specific moment; that moment has likely passed.

**How sediment forms:** Instructions are added to address a problem ("we got bitten by X"). The problem is later resolved (different tooling, different process, different model), but the instruction stays. Over time, CLAUDE.md accumulates a layer of guards for problems that no longer exist.

**Actionable check:** For each instruction, ask: when was this last verified as necessary? Instructions older than 90 days that address a tooling or model-specific problem should be re-tested. If the behavior they guard against no longer occurs without the instruction, remove it.

---

### Negation Trap

**Definition:** An instruction phrased as "don't do X" that activates the concept of X, making it more likely to happen. Negations prime the behavior they prohibit. The fix is to reframe as a positive action.

**OpenRig example (negation trap):** From global CLAUDE.md:
> "Never hand-write Co-Authored-By: Claude ... trailers or Generated with Claude Code footers in commit messages or PR bodies"

This instruction primes the behavior of hand-writing attribution trailers. The Parenthetical explanation ("The users attribution setting… suppresses harness auto-adds but cannot strip text typed into git commit -m HEREDOCs") then further reinforces the concept.

**Positive rewrite:** "Add commit attribution only through the settings file (`~/.claude/settings.json`). The settings file handles attribution automatically; commit messages need no attribution lines."

**Another example:** "Do NOT push until orch-lead gives clearance" primes pushing. Better: "Push only after orch-lead gives clearance."

**Actionable check:** Find every "don't", "never", "not", and "avoid" in the instruction. Rewrite each as the positive action the agent should take instead. If no positive action exists, the negation may be acceptable — but first check whether the behavior is already covered by a default or another rule.

---

## Skill Author Checklist

Run this checklist when writing or revising a SKILL.md file.

1. **Context load:** Can any section be replaced with a pointer to another skill, file, or step? Push detail behind a pointer if the agent does not need it to decide the first action.
2. **Leading words:** Does the skill use standard framework terms (ADR, TOCTOU, fail-closed, in-flight guard) where available? Remove descriptions that restate what the term already means.
3. **No-ops:** List every instruction. For each, describe what would happen if it were removed. Remove instructions where the answer is "nothing."
4. **Negation trap:** Find every "don't", "never", "not", "avoid." Rewrite as positive actions. Keep negations only when no positive equivalent exists.
5. **Cognitive load:** Read each step once. If re-reading is required to resolve an ambiguity or conditional, break the step into two shorter steps.
6. **Information hierarchy:** Does each step deliver the minimum needed to proceed? Is detail about the step's mechanics separated from the trigger condition?
7. **Sediment check:** Note the date any instruction was added or last verified. For instructions that reference specific model IDs, thresholds, or tool versions: verify they still reflect reality before publishing.

---

## CLAUDE.md Editor Checklist

Run this checklist when writing or revising a CLAUDE.md or AGENTS.md file.

1. **Scope:** Does this instruction belong in CLAUDE.md, or does it belong in a skill, an ADR, or a queue item? CLAUDE.md instructions apply to every agent on every task. Narrow-scope instructions inflate every context window — move them to the right layer.
2. **No-ops:** Every CLAUDE.md instruction carries token cost on every agent invocation. Verify each instruction against a current task. If the model follows it by default, remove it.
3. **Sediment:** Check the last-verified date for model IDs, tool versions, thresholds, and workarounds (e.g., `--dangerously-skip-permissions`). An instruction that references infrastructure scheduled for replacement is sediment.
4. **Negation trap:** Audit every "never", "not", "don't", "avoid." Rewrite as positive actions. "Only push after clearance" beats "do not push without clearance."
5. **Information hierarchy:** Does CLAUDE.md inline content that belongs in a skill? Use skill pointers (`/skill-name`) instead of inlining workflows. The CLAUDE.md instruction should be: trigger condition + skill name. The skill holds the method.
6. **Context load:** CLAUDE.md is loaded on every turn. Remove sections that are only relevant to one seat role or one rare scenario. Move them to a role-specific overlay or a skill.
7. **Cognitive load:** Read the CLAUDE.md as a new agent on a new task. Which sections require cross-referencing to resolve? Flatten or reorder those sections.

---

## External Reference

Original framework: Matt Pocock's `writing-for-agents` skill in the [mattpocock/skills](https://github.com/mattpocock/skills) repository. The concepts in this document (context load, cognitive load, information hierarchy, leading words, no-ops, sediment, negation trap) originate there; the examples and checklists above are adapted for OpenRig's files and conventions.
