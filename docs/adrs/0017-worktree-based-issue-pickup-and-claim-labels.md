---
id: "0017"
title: "Worktree-based issue pickup and claim labels"
status: Accepted
date: "2026-07-18"
aliases: [D-GH-67]
prd_references: "`prds/reflo-prd.md` §9 and §13"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Repository governance maintainers and agents using the work-item helper"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/67
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/67#issuecomment-5013820162
  record_pr: https://github.com/deepessh/reflo-learning/pull/68
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0017: Worktree-based issue pickup and claim labels

## Context

Comment-authoritative claims are hard to scan and require each agent to reconstruct ownership and ordering manually. This verdict controls repository issue pickup, claim identity, dependency-ready selection, concurrency handling, and release handoffs only; it does not change product scope, milestone membership, implementation priority, decision authority, or the PRD sprint schedule.

## Options

Retain comment-authoritative claims; use claim labels through hand-written GitHub commands; use one repository helper with worktree-scoped identity and label-authoritative claims.

## Decision

### Authorized verdict

Use `scripts/work-item.sh pick` and `scripts/work-item.sh release --handoff <message>` as the only supported claim interface. Generate and cache one deterministic `agent:wt-*` identity per Git worktree, permit at most one claim per worktree, and represent ownership with `work:claimed` plus that agent label without mutating assignees. The helper selects from the current sprint milestone, excludes assigned, claimed, `blocked`, and `needs-human` issues, requires every canonical `Depends on: #N, #M` dependency to be closed, prefers issues without `p1`, and then chooses the lowest issue number. Worktree-local locking serializes local callers; concurrent worktrees add both labels, resolve the winner from the earliest active agent-label event with event ID as the tie-breaker, and make losers remove only their own label before retrying. Every release requires an idempotent handoff, appends the releasing `CODEX_THREAD_ID` or `unavailable`, removes the shared claim label before the agent label, and clears local current-issue state last. Codex task IDs provide handoff attribution only and never define claim ownership.

### Rationale

A small checked-in helper makes the common workflow discoverable and testable while labels make availability visible in GitHub. Worktree identity matches the shared branch and index that constrain concurrent implementation, avoids one label per Codex task, and still records the releasing task in the durable handoff. Exact dependency syntax and fail-closed parsing avoid interpreting prose as scheduling authority.

## Verification

Agents do not post claim or withdrawal comments or issue hand-written claim API calls. One worktree cannot claim two issues even with simultaneous callers; separate worktrees deterministically resolve collisions; assigned, unavailable, human-only, blocked, malformed, inaccessible, and dependency-blocked work is skipped; P0-ready work precedes `p1`; missing local current-issue state recovers only from one unambiguous remote claim; repeated release after a partial failure posts one handoff per claim generation and leaves no ambiguous availability window. Governance CI runs Bash syntax checks and mocked GitHub integration tests.

## Reversal criteria

Supersede if GitHub label/event semantics cannot provide reliable ownership, worktree identity causes duplicate or stranded claims, dependency declarations cannot remain canonical, or maintaining the helper costs more coordination time than the comment protocol it replaces.
