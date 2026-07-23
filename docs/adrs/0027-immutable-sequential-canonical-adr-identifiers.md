---
id: "0027"
title: "Immutable sequential canonical ADR identifiers"
status: Accepted
date: "2026-07-22"
aliases: [D-GH-126]
prd_references: "`prds/reflo-prd.md` §9; `AGENTS.md` §2; D-BOOTSTRAP-001; D-GH-125"
ownership:
  proposer: "@deepessh"
  decision_dri: "@deepessh"
  implementation_owner: "codex-root for this effective record; owners of separately triaged ADR validator, migration, resolver, and authoring-skill work for implementation"
authorization:
  decider: "@deepessh, repository owner and founding-team decision authority"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/126
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/126#issuecomment-5053465036
  record_pr: https://github.com/deepessh/reflo-learning/pull/129
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0027: Immutable sequential canonical ADR identifiers

## Context

Existing effective decisions use stable issue-derived identifiers such as `D-GH-2`, while PRD mandates use identifiers such as `M-001`. The file-per-decision lifecycle accepted in D-GH-125 needs one predictable canonical ADR identifier and filename policy without erasing the historical provenance carried by those identifiers. This verdict controls ADR identity and number allocation only; it does not change ADR lifecycle, document authority, the substance or effectiveness of any existing decision or mandate, or the requirement for GitHub authorization and a merged repository record.

## Options

Keep GitHub issue-derived identifiers as canonical ADR IDs; adopt sequential four-digit canonical ADR IDs while retaining every historical identifier as an alias; or use content-derived or category-prefixed ADR identifiers.

## Decision

### Authorized verdict

Adopt immutable four-digit sequential canonical ADR identifiers allocated as `0001`, `0002`, and so on. The canonical ID and filename become immutable when the ADR record PR merges; only unmerged drafts may be renumbered. Allocation must check the local branch, the target branch, and open pull requests for collisions. Existing `D-BOOTSTRAP-001`, `D-GH-*`, and `M-*` identifiers remain permanent searchable aliases through a resolver or index. Accepted ADRs are never renamed, and immutable SQL migrations and historical provenance comments containing legacy identifiers are never rewritten; mutable documentation and code comments may be updated when that improves navigation without damaging provenance.

Reserve the bootstrap allocation as follows: `0001` for `D-BOOTSTRAP-001`; `0002`–`0016` for `D-GH-2`–`D-GH-16`; `0017`–`0022` for `D-GH-67`, `D-GH-81`, `D-GH-83`, `D-GH-95`, `D-GH-96`, and `D-GH-120`, respectively; `0023`–`0025` for `M-001`–`M-003`; and `0026`–`0028` for the three ADR-foundation ratification decisions in issue-creation order: storage and lifecycle, identifier policy, then document authority. Decisions accepted later receive `0029` and above in record-merge order.

### Rationale

Stable sequential filenames make the ADR collection predictable to browse and independent of the provenance source's naming scheme. Keeping every legacy identifier as a permanent alias preserves searchability, issue and migration history, and links from existing code and documentation. Merge-time immutability plus collision checks prevents concurrent authors from silently reusing or renumbering canonical identities.

## Verification

The ADR validator and authoring workflow accept exactly four-digit canonical IDs, enforce the reserved bootstrap mapping, reject duplicate or renumbered merged IDs and filenames, and allocate later IDs in record-merge order only after checking the local branch, target branch, and open pull requests. A resolver or generated index maps every retained `D-BOOTSTRAP-001`, `D-GH-*`, and `M-*` alias to one canonical ADR. Migration and navigation tests prove accepted ADR filenames, immutable SQL migrations, and historical provenance comments are not rewritten, while any updates to mutable references preserve valid resolution.

## Reversal criteria

Supersede if sequential allocation creates unmanageable merge contention, the collision checks cannot prevent duplicate canonical IDs across concurrent work, or permanent alias resolution cannot preserve historical navigation. Any successor must keep canonical identities immutable after merge, prevent ID reuse, and preserve all legacy provenance identifiers without rewriting immutable history.
