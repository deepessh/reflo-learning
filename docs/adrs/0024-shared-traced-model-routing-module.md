---
id: "0024"
title: "Shared traced model-routing module"
status: Accepted
date: "2026-07-22"
aliases: [M-002]
prd_references: "`prds/reflo-prd.md` §9 and `AGENTS.md` §5 at PRD v1.8 commit `52ebf23e60dddea3ef74fdb3010a26d38477d998`"
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
  confirmation_issue: https://github.com/deepessh/reflo-learning/issues/23
  confirmation_comment: https://github.com/deepessh/reflo-learning/issues/23#issuecomment-5008411544
  authority_state: transferred
  cutover_pr: https://github.com/deepessh/reflo-learning/pull/0
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0024: Shared traced model-routing module

## Context

The approved PRD assigns Qwen to curriculum, tutoring, quiz generation, and grading work; Qwen-TTS to audio; and the default-off, source-backed Wanx prototype to video. `AGENTS.md` prohibits scattered raw model API calls. This staged mirror records the cross-cutting routing and tracing mandate without transferring authority from those documents or presenting any provider path as implemented.

## Options

The PRD already resolved whether feature code may call model providers directly. All model-backed capabilities must use the shared router, with task-based routing and tracing; capability-specific adapter and execution details remain governed by their existing effective decisions.

## Decision

### Authorized verdict

Every model call uses the shared, traced model-routing module; Qwen, Qwen-TTS, and flagged Wanx are routed by task.

### Rationale

A single traced routing boundary keeps provider selection, prompt and model provenance, privacy controls, and task policy reviewable while preventing raw provider calls from spreading through feature code.

## Verification

Until the atomic authority-transfer PR merges, `prds/reflo-prd.md`, `AGENTS.md`, and the mandate index in `DECISIONS.md` remain authoritative. This mirror must retain `authority_state: staged`, a null `cutover_pr`, immutable PRD v1.8 commit provenance, and the exact owner confirmation. Import and integration checks must continue to reject model calls that bypass the shared traced router.

## Reversal criteria

PRD revision only; discovery [#23](https://github.com/deepessh/reflo-learning/issues/23); confirmation [owner comment](https://github.com/deepessh/reflo-learning/issues/23#issuecomment-5008411544)
