---
id: "0029"
title: "ADR authority and enforcement guarantees"
status: Accepted
date: "2026-07-23"
aliases: [D-GH-145]
prd_references: "`prds/reflo-prd.md` §9; ADR 0001; ADR 0026; ADR 0027; ADR 0028"
ownership:
  proposer: "@deepessh"
  decision_dri: "@deepessh"
  implementation_owner: "agent:wt-71fc734b67931a75ae25 through issue #145"
authorization:
  decider: "@deepessh, repository owner and authorized decision authority"
  approval_basis: "repository-owner authorization to supersede obsolete ADR 0001 register authority and enforce exact GitHub provenance, bounded maintenance, complete open-PR enumeration, and merge-ordered sequential ADR identities as specified in #145."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/145
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/145#issuecomment-5060965963
  record_pr: https://github.com/deepessh/reflo-learning/pull/0
supersedes: ["0001"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0029: ADR authority and enforcement guarantees

## Context

The atomic ADR cutover established file-per-decision authority, but the post-cutover repository still left five connected enforcement defects. ADR 0001 remained active even though it required effective verdicts to merge into the deleted `DECISIONS.md`; link checking did not prove that the exact comment was an authorized accepted verdict or that its record PR carried the record; a maintenance marker could conceal arbitrary changes to immutable content; concurrently allocated drafts could merge out of numeric order; and open-PR discovery silently stopped at the GitHub CLI default of 30. This decision repairs that governance boundary without changing product requirements, product scope, other architectural targets, or immutable SQL history.

## Options

Leave the migration unchanged and rely on reviewer interpretation; supersede only ADR 0001 while leaving enforcement gaps; harden tooling while leaving ADR 0001 simultaneously active; or atomically supersede ADR 0001 and enforce exact authorization, narrowly bounded maintenance, complete concurrent-PR discovery, and merge-ordered sequential identity.

## Decision

### Authorized verdict

Adopt the atomic corrective contract. Supersede ADR 0001 through bidirectional lifecycle links while preserving its historical body and provenance. ADRs 0026, 0027, and 0028 remain active, and this record clarifies the repository-record authority they establish after cutover.

Required validation resolves every GitHub provenance resource through the GitHub API. It proves that the exact verdict comment belongs to the declared decision issue, records an accepted authorized verdict, identifies the issue's declared authorized decider, and states an approval basis; it rejects bare, unrelated, unauthorized, rejected, deleted, or mismatched evidence. The record PR must be the merged PR containing the canonical record, except that the matching currently open record PR may validate before its own merge. Migrated pre-cutover GitHub decisions retain their exact historical register PRs and are verified against the register path they originally merged; new ADRs are verified against their canonical ADR paths.

Accepted identity, filename, date, aliases, ownership, authorization, decision provenance, lifecycle history, and semantics remain immutable. A maintenance entry declares the exact body section changed and authorizes only a bounded typo, formatting, or navigation correction linked to its issue and merged PR. Mechanical checks reject changes outside that declaration; semantic classification remains a review responsibility. Clarification, reversal, or replacement requires a new authorized ADR.

Every open pull request targeting the base branch is enumerated with explicit pagination, and changed-file retrieval fails closed when incomplete. Draft allocation remains provisional. Before merge, the current record must use the next merge-eligible canonical ID: a higher-numbered ADR cannot merge ahead of a lower-numbered open claim, and an unused lower number cannot be skipped. Closed or abandoned draft claims are released through draft-only renumbering. Merged ADRs are never renumbered.

### Rationale

The file-per-decision cutover is authoritative only if active lifecycle records and required checks agree on where authority lives. Exact authorization and record evidence prevent a reachable URL from masquerading as a decision. Declared, mechanically bounded maintenance prevents metadata from becoming an immutability bypass. Complete pagination and a deterministic pre-merge ordering check make sequential IDs reflect merge order even under concurrent drafting, while retaining safe renumbering for drafts and permanent identity for merged records.

## Verification

ADR 0001 is `Superseded`, links to this record, and retains its original body and provenance; this record links back through `supersedes`. The generated active-ADR table omits ADR 0001 and includes ADR 0029. Fixture-backed API tests reject a same-issue bare `Accepted` comment, unauthorized actor, rejected verdict, unrelated or unmerged record PR, and a record PR missing its required record path, while valid historical and future provenance passes. Transition tests reject maintenance changes to identity, ownership, authorization, aliases, date, provenance, undeclared sections, semantic formatting deltas, oversized typo deltas, and non-link navigation deltas. Allocator tests inventory more than 30 open PRs and reject skipped or out-of-order merge eligibility. Existing aliases, all migrated records, required check contexts, and immutable SQL history remain intact.

## Reversal criteria

Supersede if the exact-evidence checks cannot represent a legitimate authorization path without weakening actor, issue, verdict, approval-basis, or merged-record guarantees; if bounded maintenance prevents safe non-semantic corrections; or if merge-order enforcement creates unavoidable deadlock that draft renumbering cannot resolve. Any successor must preserve auditable GitHub authorization, merged repository effectiveness, immutable accepted history, permanent merged identifiers, complete concurrent-claim discovery, and fail-closed enforcement.
