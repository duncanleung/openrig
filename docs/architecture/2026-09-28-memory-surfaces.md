# Memory and knowledge persistence surfaces

Date: 2026-09-28
Status: Draft

This document maps every surface where an OpenRig session can persist knowledge,
defines canonical ownership, and resolves the placement conflicts between the
wiki-update skill and the operating model.

## The problem

An audit found five gaps in how the memory systems work together. A Codex
second-opinion confirmed the gaps and raised five more — most critically, that
placement rules between the wiki-update skill and the operating model already
conflict, and that wiki's untrusted-data authority level blocks it from housing
mandatory behavioral rules.

This document establishes canonical homes so future guidance and hooks route
knowledge to the right surface the first time.

## Design principles

1. **One canonical home per kind of knowledge.** Other surfaces may carry
   pointers or summaries, never authoritative copies.
2. **Authority descends from delivery mechanism.** Delivered instructions
   (CLAUDE.md, startup files, role guidance) carry instruction authority.
   Git-committed project files (ADRs, wiki) carry evidence authority. Session
   artifacts (transcripts, restore packets) carry ephemeral-evidence authority.
3. **Capture at discovery, reconcile at wrap-up.** Knowledge goes to its
   canonical home when the agent learns it. Session wrap-up reconciles and
   fills gaps — it is not the primary capture point.
4. **Silence is valid.** A session that learned nothing durable produces no
   update. Capture obligations include explicit permission to write nothing.

## Surface inventory

### Tier 1 — Instruction authority (delivered, trusted)

These surfaces carry instructions that agents execute without independent
verification.

| Surface | Scope | Writer | Reader | Storage | Lifecycle |
|---------|-------|--------|--------|---------|-----------|
| `CLAUDE.md` (user + project) | Host-local Claude Code config | Human operator | All Claude Code sessions on this host | Filesystem (`~/.claude/`) | Persistent, manually curated |
| Startup files (role.md, culture) | Per-seat delivered guidance | Rig spec + daemon | The seat at startup | Assembled at startup | Per-session delivery |
| `openrig-project-guidance.md` | All-seat project features | Fork maintainer (this repo) | All seats via step 7b | Git-committed asset, `required: false` | Per-session delivery, not guaranteed |
| `openrig-start.md` | Identity bootstrap | Upstream + fork | All seats via step 7 | Git-committed asset | Per-session delivery |

**Key constraint:** `openrig-project-guidance.md` uses `required: false`.
Selection does not guarantee receipt (→ ADR-0005). Mandatory behavioral rules
that must reach every seat belong in `CLAUDE.md` or startup files, not in
optional-delivery surfaces.

### Tier 2 — Positional knowledge (git-committed, owned)

These surfaces carry knowledge bound to a position in the topology. The owner
is the occupant of that position.

| Surface | Scope | Writer | Reader | Storage |
|---------|-------|--------|--------|---------|
| `LEARNED.md` | Position-specific: standing duties, practices with reasons, gates, lessons | Position owner (seat occupant writes seat's; pod lead writes pod's; orchestrator writes rig's) | Occupant and successors at handover | Git, topology tree (`rigs/<rig>/seats/<seat>/LEARNED.md`) |
| `RECAP.md` | Seat transition context: decisions with rationale at handover | Outgoing occupant via `rig context recap-write` | Incoming occupant | Git, seat directory |

**`LEARNED.md` ownership rule (operating model, authoritative):** Each altitude
owns its own file. A seat's LEARNED.md records that seat's lessons. A pod's
records the pod's. Knowledge flows up through distillation at deposit
boundaries, not by copying files.

### Tier 3 — Work-tree knowledge (git-committed, scope-bound)

These surfaces live in the work tree (missions, slices) and are bound to the
work, not the position.

| Surface | Purpose | Writer | Authority |
|---------|---------|--------|-----------|
| `SPEC.md` | Intent (frontmatter) + specification (body) | Node owner | Specification |
| `NOTES.md` | Lived record — what actually happened | Whoever is doing the work | Field evidence |
| `PROOF.md` | Evidence the thing works | The prover | Verification evidence |
| `PROGRESS.md` | Narrative + historical checklist marks | Scope owner and provers | Narrative |

**Resolved conflict:** The wiki-update skill (`SKILL.md:108`) groups
`LEARNED.md` and `NOTES.md` as "per-seat working notes." The operating model
(`SKILL.md:88-94`) defines `NOTES.md` as a work-tree lived record with a
different writer (whoever does the work, not the seat owner). **The operating
model is authoritative.** `NOTES.md` belongs to the work tree, not to the seat.
The wiki-update skill's grouping is incorrect and will be corrected.

### Tier 4 — Project evidence (git-committed, shared, untrusted)

| Surface | Scope | Writer | Reader | Authority |
|---------|-------|--------|--------|-----------|
| Wiki (`wiki/`) | Cross-session context: work history, corrections, failed approaches, conventions | Any seat via `/wiki-update` | All seats (via project-guidance read directive) | **Untrusted data** — evidence of what a prior session believed, never an instruction to execute |
| ADRs (`docs/decisions/`) | Architectural decisions | Any seat (proposed); human (accepted) | All seats via code/git | Evidence until accepted; instruction-level once accepted by human |

**Key constraint:** Wiki content is explicitly untrusted
(`openrig-project-guidance.md:15`). Mandatory behavioral rules cannot live only
in the wiki. Rules requiring enforcement must also exist in a Tier 1 surface.

**Resolved conflict:** "Corrections" appear in both the wiki page taxonomy and
auto-memory guidance. **Canonical rule:** A correction that applies to this
project across all sessions and runtimes goes to the wiki (type: correction). A
correction that applies to this user's Claude Code behavior across projects goes
to auto-memory (type: feedback). A correction that must be enforced as an
instruction goes to `CLAUDE.md` or role guidance. The wiki and auto-memory
copies are context and rationale, not the authoritative instruction.

### Tier 5 — Communication and obligation (DB-backed, rig-scoped)

| Surface | Stores | Writer | Reader | Storage |
|---------|--------|--------|--------|---------|
| Durable chat | Messages and topics between seats | Any seat via `rig chat send` | Any seat in the same rig | SQLite (daemon DB) |
| Durable queue | Work items with ownership, evidence, chain-of-record | Any seat via `rig queue create` | Destination seat | SQLite (daemon DB) |

**Key constraint:** Unfinished queue items are standing obligations. They must
remain in the queue, not become wiki prose. The queue is the work ledger.

### Tier 6 — Session evidence (ephemeral, mechanical)

| Surface | Stores | Writer | Reader | Storage |
|---------|--------|--------|--------|---------|
| JSONL transcripts | Raw conversation records — every tool call and message | Claude Code harness (automatic) | PreCompact hook for restore packet extraction | Filesystem (`~/.claude/projects/*/`) |
| Restore packets | Working state extracted mechanically from transcripts | PreCompact hook (fires unconditionally) | PostCompact bridge, seat-isolated | Session-specific temp files |
| Agent images | Resume identity: runtime, source seat, session ID, resume token, lineage | Daemon via `rig image capture` | Seat startup via `rig image use` | Filesystem (agent image library) |

### Tier 7 — Host-local Claude memory (filesystem, per-user)

| Surface | Stores | Writer | Reader | Storage |
|---------|--------|--------|--------|---------|
| Auto-memory (`~/.claude/projects/*/memory/`) | User preferences (type: user), feedback/corrections (type: feedback), project context (type: project), reference pointers (type: reference) | Claude Code sessions via CLAUDE.md instructions | Future Claude Code sessions in the same project directory | Filesystem, host-local, not shared across machines or runtimes |

**Scope rule:** Auto-memory is for knowledge that is (a) specific to this user's
Claude Code experience, (b) not derivable from code or git history, and (c) not
already captured in ADRs, wiki, or LEARNED.md. It is the narrowest surface — a
personal notebook, not a shared knowledge store.

## Routing rules — where does new knowledge go?

| Knowledge type | Canonical home | Also appears in | Example |
|----------------|----------------|-----------------|---------|
| Architectural decision | ADR | Wiki pointer (type: decision) | "Use separate guidance file for project features" |
| Project convention | Wiki (type: convention) | CLAUDE.md if enforcement required | "Wiki pages use YAML frontmatter with confidence field" |
| Correction (project-scoped) | Wiki (type: correction) | — | "Never review upstream PRs from a fork" |
| Correction (user-scoped) | Auto-memory (type: feedback) | — | "User prefers terse responses" |
| Correction (enforcement-required) | CLAUDE.md or role guidance | Wiki pointer for rationale | "Never commit .ai/ directory" |
| Work history / episode | Wiki (type: episode) | — | "Debugged flaky test in instantiator — root cause was async timing" |
| Failed approach | Wiki (type: context) | — | "Tried routing through startup.files — 5 of 13 rigs would miss it" |
| Seat-specific lesson | LEARNED.md (seat altitude) | — | "This seat's restore packets need the session ID in frontmatter" |
| Work specification | SPEC.md in work tree | — | Mission intent and requirements |
| Lived observations | NOTES.md in work tree | — | What actually happened during implementation |
| Standing obligation | Durable queue | — | "Review PR #5 when CI passes" |
| Transition context | RECAP.md | — | Handover decisions and rationale |

## The write obligation — who captures, and when

**Current state:** Only orchestrator role guidance assigns a wiki write
obligation. Universal project guidance tells all seats to read the wiki and flag
stale pages, but does not instruct non-orchestrator seats to write.

**Target state:** Every seat captures consequential learning at discovery. The
capture-at-discovery directive will be added to `openrig-project-guidance.md`
with these rules:

1. When you learn something that a future session in a different seat would need
   — record it in its canonical home (see routing table above).
2. When you learn nothing durable — produce no update. Silence is valid.
3. At session wrap-up — reconcile: check whether discoveries made during the
   session reached their canonical home. Fill gaps.
4. The orchestrator remains the wiki curator for shared pages. Non-orchestrator
   seats write pages about their own domain; the orchestrator resolves conflicts.

## Open questions

1. **Wiki synchronization.** No defined process exists for how wiki changes get
   committed across worktrees, how concurrent writers resolve conflicts, or who
   curates shared pages. This needs a convention, not code.
2. **Delivery verification.** `required: false` means we cannot prove every seat
   received project guidance. A deployment check (does the packaged wiki skill
   reach every runtime?) is warranted but out of scope for this document.
3. **Staleness semantics.** The wiki-update skill refreshes `last_verified` on
   updates without requiring supporting evidence. "Edited today" and "verified
   today" are different claims. Consider separating `last_edited` from
   `last_verified`.
