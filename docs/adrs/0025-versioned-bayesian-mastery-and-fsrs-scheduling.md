---
id: "0025"
title: "Versioned Bayesian mastery and FSRS-style scheduling"
status: Accepted
date: "2026-07-22"
aliases: [M-003]
prd_references: "`prds/reflo-prd.md` §6, F4 at v1.8 commit `52ebf23e60dddea3ef74fdb3010a26d38477d998`"
ownership:
  proposer: "Founding team through the approved PRD"
  decision_dri: "Product requirements governance"
  implementation_owner: "Owner of issue #134 for this staged mirror; implementation remains with separately claimed issues"
authorization:
  decider: "@deepessh, repository owner confirming the approved PRD mandate"
  approval_basis: "The exact owner-authored confirmation comment is preserved in provenance; authority remains with the PRD until cutover."
provenance:
  kind: prd-mandate
  prd_version: "1.8"
  prd_commit: "52ebf23e60dddea3ef74fdb3010a26d38477d998"
  prd_path: prds/reflo-prd.md
  prd_sections: ["§6 F4"]
  confirmation_issue: https://github.com/deepessh/reflo-learning/issues/24
  confirmation_comment: https://github.com/deepessh/reflo-learning/issues/24#issuecomment-5008411680
  authority_state: transferred
  cutover_pr: https://github.com/deepessh/reflo-learning/pull/0
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0025: Versioned Bayesian mastery and FSRS-style scheduling

## Context

The approved PRD defines the learner knowledge model as per-learner, per-concept mastery, confidence, last-review time, review count, and forgetting-curve half-life. Only confidently graded retrieval evidence may update mastery and forgetting state. The implementation must keep its priors, evidence mapping, confidence threshold, knowledge-algorithm version, and FSRS grade mapping reproducible. This staged mirror records that technical mandate without changing the product behavior or claiming implementation.

## Options

The PRD already resolved the sprint algorithm family: use a versioned Bayesian mastery update with FSRS-style spaced-repetition scheduling. Inventing novel psychometrics during the three-week sprint is outside scope.

## Decision

### Authorized verdict

Knowledge updates use a versioned Bayesian mastery update and FSRS-style scheduling; novel psychometrics are out of scope.

### Rationale

Using established, versioned algorithm families makes knowledge updates reproducible and keeps the sprint focused on trustworthy evidence and the adaptive loop instead of unvalidated psychometric invention.

## Verification

Until the atomic authority-transfer PR merges, `prds/reflo-prd.md` and the mandate index in `DECISIONS.md` remain authoritative. This mirror must retain `authority_state: staged`, a null `cutover_pr`, immutable PRD v1.8 commit provenance, and the exact owner confirmation. Tests must continue to prove that exposure alone cannot change mastery and that every eligible update records the algorithm version needed for reproduction.

## Reversal criteria

PRD revision only; discovery [#24](https://github.com/deepessh/reflo-learning/issues/24); confirmation [owner comment](https://github.com/deepessh/reflo-learning/issues/24#issuecomment-5008411680)
