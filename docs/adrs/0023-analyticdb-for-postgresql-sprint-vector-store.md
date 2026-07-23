---
id: "0023"
title: "AnalyticDB for PostgreSQL sprint vector store"
status: Accepted
date: "2026-07-22"
aliases: [M-001]
prd_references: "`prds/reflo-prd.md` §9 at v1.8 commit `52ebf23e60dddea3ef74fdb3010a26d38477d998`"
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
  prd_sections: ["§9"]
  confirmation_issue: https://github.com/deepessh/reflo-learning/issues/22
  confirmation_comment: https://github.com/deepessh/reflo-learning/issues/22#issuecomment-5008411222
  authority_state: transferred
  cutover_pr: https://github.com/deepessh/reflo-learning/pull/144
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0023: AnalyticDB for PostgreSQL sprint vector store

## Context

The approved PRD makes RDS PostgreSQL the system of record and requires a vector store for source-backed retrieval. For the sprint, the vector store is AnalyticDB for PostgreSQL with pgvector-compatible behavior. This staged mirror records that technical mandate without changing its source of authority or claiming that the target has been implemented.

## Options

The PRD already resolved the sprint choice between AnalyticDB for PostgreSQL and a separate Milvus deployment. AnalyticDB remains required for the sprint; migration to Milvus is permitted only post-launch if corpus scale demands it.

## Decision

### Authorized verdict

AnalyticDB for PostgreSQL is the sprint vector store.

### Rationale

AnalyticDB provides Postgres-native operations and one fewer moving part for a three-person sprint. Builder Day feedback remains advisory, and the selected store cannot change without revising the PRD.

## Verification

Until the atomic authority-transfer PR merges, `prds/reflo-prd.md` and the mandate index in `DECISIONS.md` remain authoritative. This mirror must retain `authority_state: staged`, a null `cutover_pr`, immutable PRD v1.8 commit provenance, and the exact owner confirmation. Implementations must continue to satisfy the PRD mandate and its grounding, owner-scope, privacy, deletion, and release-gate requirements.

## Reversal criteria

PRD revision only; discovery [#22](https://github.com/deepessh/reflo-learning/issues/22); confirmation [owner comment](https://github.com/deepessh/reflo-learning/issues/22#issuecomment-5008411222)
