---
name: wiki-update
description: Curate the project wiki at session wrap-up — add, update, or mark pages stale. Enforces write-side adjudication so the wiki stays useful over time.
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - queue-handoff
      - session-compaction-and-restore
      - claude-compaction-restore
---

# Wiki Update

Curate the project wiki (`wiki/` directory in the project root) at session
wrap-up. The wiki holds project-scoped knowledge that agents lose across
sessions: work history, corrections, failed approaches, and conventions that
ADRs and CLAUDE.md do not capture.

## When to invoke

- At session wrap-up, before handoff or compaction
- After completing a non-trivial piece of work
- When a correction or convention is learned that future sessions need
- When an existing wiki page is found to be stale or wrong

Do NOT invoke mid-task or after trivial work (rebases, renames, config
changes). The wiki captures knowledge worth preserving, not a session log.

## Page schema

Every wiki page uses this frontmatter:

```yaml
---
title: "Short descriptive title"
type: decision | convention | correction | context | episode
confidence: high | medium | low
last_verified: YYYY-MM-DD
tags: [tag1, tag2]
related: [[other-page]]
source: session | adr | manual
---
```

**Types:**
- `decision` — a choice that was made and why (not an ADR — those go in `docs/decisions/`)
- `convention` — a pattern or practice the project follows
- `correction` — something that was wrong and how it was fixed; "do not repeat"
- `context` — background knowledge about a subsystem or feature
- `episode` — a notable event (migration, rename, incident)

## Write-side adjudication

Before writing a new page, check whether an existing page covers the topic:

1. Read `wiki/index.md`
2. Search for related pages by tag or title
3. If a page exists on the same topic: **update it** instead of creating a new one
4. If a page exists but is wrong: update it and change `confidence` to reflect
   the correction
5. Only create a new page when the topic is genuinely new

This prevents the wiki from accumulating duplicate or contradictory pages.

## Steps

### Adding a new page

1. Write the page in `wiki/<slug>.md` with the frontmatter schema above
2. Add the page to `wiki/index.md` under the appropriate section
3. Set `last_verified` to today's date
4. Link related pages with `[[slug]]` syntax

### Updating an existing page

1. Read the existing page
2. Update the content. Preserve the original structure where possible
3. Update `last_verified` to today's date
4. Adjust `confidence` if the update changes certainty

### Marking a page stale

If you discover a page contains outdated information but cannot verify the
current state:

1. Change `confidence` to `low`
2. Add a note at the top: `> ⚠️ This page may be stale. Last verified YYYY-MM-DD.`
3. Do NOT delete the page — stale context is better than no context

### Lint check

When updating the wiki, scan for:
- Pages with `last_verified` older than 30 days → flag in `wiki/index.md`
- Pages with `confidence: low` that have not been re-verified
- Broken `[[wiki-links]]` that reference pages that do not exist
- Duplicate topics across pages

## What belongs in the wiki vs. elsewhere

| Knowledge | Where it goes |
|-----------|--------------|
| Architectural decisions | `docs/decisions/` (ADRs) |
| Project conventions loaded at session start | `CLAUDE.md` |
| User preferences and corrections | Auto memory (`~/.claude/projects/*/memory/`) |
| Work context, episodes, failed approaches | **Wiki** |
| Session state for compaction recovery | Restore packets |
| Per-seat working notes | `LEARNED.md` / `NOTES.md` |

## Do not

- Do not use the wiki as a session log. Capture the knowledge, not the narrative.
- Do not create pages for information derivable from `git log` or the code itself.
- Do not create pages for ADR-level decisions — those belong in `docs/decisions/`.
- Do not create pages without adding them to `wiki/index.md`.
