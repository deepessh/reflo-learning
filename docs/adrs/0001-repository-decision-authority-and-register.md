---
id: "0001"
title: "Repository decision authority and register"
status: Accepted
date: "2026-07-17"
aliases: [D-BOOTSTRAP-001]
prd_references: "`prds/reflo-prd.md` §9"
ownership:
  proposer: "Repository owner"
  decision_dri: "Repository governance"
  implementation_owner: "Initial governance-change implementer"
authorization:
  decider: "Repository owner, through the explicit bootstrap instruction recorded in this change"
  approval_basis: "Repository owner directive dated 2026-07-17, durably recorded by the authoritative bootstrap record."
provenance:
  kind: bootstrap-exception
  owner_directive: "Repository owner directive dated 2026-07-17, durably recorded by this entry"
  directive_date: "2026-07-17"
  bounded_exception: "Yes — limited to the files listed in the Bootstrap exception section"
  migration_pr: https://github.com/deepessh/reflo-learning/pull/140
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0001: Repository decision authority and register

## Context

GitHub-only decision history is difficult to discover as a coherent architectural record, while a file-only process lacks the discussion, approval, and coordination trail required by `AGENTS.md`. This verdict controls implementation/process decision governance; it does not change product requirements.

## Options

GitHub issues as the sole source; `DECISIONS.md` as the sole source; GitHub authorization plus a merged repository register.

## Decision

### Authorized verdict

The PRD controls product requirements and mandates. GitHub decision issues control proposal, evidence, discussion, and authorization. An authorized verdict becomes effective and searchable only when its matching record is merged into `DECISIONS.md`. Code and implementation issues must conform to both the PRD and effective records.

### Rationale

The split preserves GitHub's audit and coordination strengths while making effective verdicts reviewable in one version-controlled location.

## Verification

`AGENTS.md`, PRD §9, and this file state the same authority model; future non-bootstrap effective records link to an issue, exact verdict comment, and merged PR; decision issues close only after the register change merges; pending entries are never implementation authority.

## Reversal criteria

Replace only if the workflow creates measurable coordination failure or tooling cannot keep issue authorization and the merged register consistent. Any replacement requires a new authorized record and corresponding PRD/AGENTS updates.
