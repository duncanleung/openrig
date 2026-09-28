---
title: No upstream PR review
type: correction
confidence: high
last_verified: 2026-09-27
tags: [git, review, fork]
source: session
---

# No upstream PR review

When the repo is a fork (`upstream` remote exists distinct from `origin`),
never review, validate, or act on upstream PRs. Only review PRs on `origin`.

This applies to all rig seats. Orchestrators must not dispatch upstream PR
reviews. Reviewers must not self-initiate them.

Use `--repo duncanleung/openrig` with all `gh` commands to ensure they target
the fork, not upstream. `gh repo view --json nameWithOwner` returns the
upstream repo, not the fork.
