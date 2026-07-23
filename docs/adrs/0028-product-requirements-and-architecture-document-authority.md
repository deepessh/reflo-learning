---
id: "0028"
title: "Product requirements and architecture document authority"
status: Accepted
date: "2026-07-22"
aliases: [D-GH-127]
prd_references: "`prds/reflo-prd.md` §§5, 6, 9, 10, 11, and 13; `AGENTS.md` §§1–2; D-BOOTSTRAP-001; D-GH-125; D-GH-126"
ownership:
  proposer: "@deepessh"
  decision_dri: "@deepessh"
  implementation_owner: "codex-root for this effective record; owners of separately triaged work for the PRD revision, mandate promotion, architecture views, validation, and atomic authority cutover"
authorization:
  decider: "@deepessh, repository owner and founding-team decision authority"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/127
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/127#issuecomment-5053465481
  record_pr: https://github.com/deepessh/reflo-learning/pull/130
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0028: Product requirements and architecture document authority

## Context

The PRD currently owns product requirements while also embedding technologies, providers, topology, entity catalogs, algorithms, and implementation mechanisms. This makes product outcomes and architectural authorization difficult to evolve independently and makes target architecture easy to mistake for implemented behavior. This verdict controls the intended document classes, authority boundaries, retain/move matrix, architecture views, and future atomic transfer process. It does not itself amend the PRD, waive or change any product requirement, scope, priority, SLO, safety or privacy outcome, pilot or release gate, offline-demo behavior, technical mandate, or existing architecture; authorize a new architecture; make preparatory ADR, architecture, skill, or problem-document work authoritative; or transfer authority before the separately authorized atomic cutover merges.

## Options

Keep product and architecture choices together in the PRD; separate product requirements from ADR-governed architecture while keeping architecture and problem documents non-authorizing; or remove implementation detail without creating durable architecture governance.

## Decision

### Authorized verdict

Adopt a separated document-authority model through a later human-approved PRD revision and atomic cutover. The PRD retains product outcomes, user-visible behavior, scope, priorities, safety and privacy outcomes, SLOs, pilot and release gates, offline-demo behavior, honest labeling, messaging-channel priority mandate M-004, P1 scope and default-off mandate M-005, and the product-behavior portion of M-006. Technologies and named providers, component and environment topology, storage and infrastructure choices, exact entity and schema catalogs, algorithms and implementation mechanisms, the named Alibaba production path, and the provider and storage portions of M-006 move from the PRD only through that approved revision and ADR-backed cutover. Promote M-001 through M-003 into ADRs with truthful `prd-mandate` provenance containing the immutable PRD version and commit, exact confirmation issue and comment, and authority-transfer pull request; decompose M-006 without changing its retained product behavior. Accepted ADRs authorize decided architecture only after their record pull requests merge. `docs/architecture.md` remains a non-authorizing view that separately identifies decided target architecture and evidence-backed implemented state, links to ADRs instead of duplicating detailed rules, and never presents accepted-but-unbuilt targets as shipped. Broad problem documents remain non-authoritative exploration and contain no status, owner, task list, milestone, or verdict; GitHub remains the sole proposal and task tracker. Preparatory work cannot change authority. The final cutover must atomically apply the approved PRD revision, update `AGENTS.md`, activate `adr-authoritative` governance and ADR/architecture validation, prove complete register-to-ADR coverage including late decisions, delete `DECISIONS.md`, and preserve required-check continuity. Existing PRD and register authority remains unchanged until that cutover merges.

### Rationale

Separating product outcomes from architecture authorization allows each to evolve through its appropriate approval path without weakening the PRD's product contract. Explicit target and implemented-state views make architecture useful without turning descriptive prose into authority or overstating shipped behavior. Truthful mandate provenance, dual-written preparation, complete coverage validation, and one atomic cutover prevent partial migration from creating contradictory sources of truth or silently dropping governing decisions.

## Verification

The human-approved PRD revision retains every item in the approved retain matrix and removes only the approved technical detail; M-001 through M-003 and the provider/storage portions of M-006 resolve to ADRs with exact immutable provenance while M-004, M-005, and M-006 product behavior remain product requirements. Architecture validation generates or verifies the active-ADR target index, requires implemented-state claims to link code, component README, schema, or release evidence, and rejects target/state conflation and broken references. Problem-document validation rejects task or authority fields and keeps proposals and work in GitHub. Coexistence checks preserve current PRD and `DECISIONS.md` authority, dual-write every late effective decision, and prove complete semantic coverage before a single cutover change simultaneously merges the approved PRD and `AGENTS.md` updates, switches to `adr-authoritative`, enables ADR and architecture validation under uninterrupted required checks, and deletes the old register. Until that succeeds, no preparatory artifact can override the PRD or effective register.

## Reversal criteria

Supersede if separating product and architecture authority causes materially worse discovery, review, coordination, or release safety; the retain/move boundary cannot preserve product requirements and gates without ambiguity; architecture target and implemented-state views cannot remain evidence-backed and non-authorizing; or a lossless atomic cutover cannot be demonstrated. Any successor must preserve human control of product requirements, exact GitHub authorization provenance, merged-record effectiveness, honest implemented-state labeling, complete governing-history retention, and an unambiguous authority transition.
