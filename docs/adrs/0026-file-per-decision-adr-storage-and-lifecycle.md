---
id: "0026"
title: "File-per-decision ADR storage and lifecycle"
status: Accepted
date: "2026-07-22"
aliases: [D-GH-125]
prd_references: "`prds/reflo-prd.md` §9; `AGENTS.md` §2; D-BOOTSTRAP-001"
ownership:
  proposer: "@deepessh"
  decision_dri: "@deepessh"
  implementation_owner: "codex-root for this effective record; owners of separately triaged dependent work for the ADR schema, migration, and authority cutover"
authorization:
  decider: "@deepessh, repository owner and founding-team decision authority"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/125
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/125#issuecomment-5053405642
  record_pr: https://github.com/deepessh/reflo-learning/pull/128
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0026: File-per-decision ADR storage and lifecycle

## Context

Reflo currently stores every effective implementation and process verdict in one `DECISIONS.md` register. That register preserves authorization but is difficult to navigate, makes concurrent decision changes conflict-prone, and combines effective records with mandate and pending indexes. This verdict controls the storage and lifecycle of effective governed decisions. It does not change any product requirement, architectural choice, sprint priority, PRD authority, or GitHub authorization requirement during migration.

## Options

Keep the monolithic `DECISIONS.md` register; adopt one immutable ADR file per effective decision while retaining GitHub proposals, evidence, discussion, authorization, and Reflo-specific provenance; or use GitHub issues as the only durable decision record.

## Decision

### Authorized verdict

Adopt one immutable ADR file per effective governed decision. Use lifecycle states `Accepted`, `Deprecated`, and `Superseded`. An `Accepted` ADR governs its decided target only after its record PR merges. A `Superseded` ADR no longer governs and links bidirectionally to the newer accepted ADR. A `Deprecated` ADR no longer governs and requires its own decision issue, owner-authored verdict, decision date, and record PR. Accepted decision content is immutable except typo, formatting, and navigational corrections; semantic clarification, reversal, or replacement requires a new authorized ADR. Rejected proposals remain searchable in GitHub and never become ADR files.

Preserve existing effective register content one-to-one during migration: `Context and boundary` becomes `Context`, `Options considered` becomes `Options`, `Authorized verdict` and `Rationale` become `Decision`, `Testable consequences` becomes `Verification`, and `Reversal criteria` remains `Reversal criteria`. Keep ownership and authorization as distinct structured provenance. Support `github-decision`, `bootstrap-exception`, and `prd-mandate` provenance, each with the exact source issue, verdict comment, record PR, or immutable historical source its kind requires. During staged migration, `DECISIONS.md` remains authoritative through `partial-mirror` and `complete-mirror` modes. ADR authority begins only through an atomic `adr-authoritative` cutover that deletes `DECISIONS.md`. Every effective decision accepted during coexistence is dual-written so late decisions cannot be lost.

### Rationale

File-per-decision records reduce navigation and merge-conflict costs while preserving the authority split established by the PRD and D-BOOTSTRAP-001: GitHub remains the proposal and authorization trail, and a merged repository record is still required for effectiveness. Immutable accepted content plus explicit successor records keeps semantic history auditable, while staged mirroring, exact provenance, dual-writing, and an atomic cutover prevent migration from silently changing or losing governing decisions.

## Verification

Separately triaged implementation work establishes an ADR schema and validator for the three lifecycle states and provenance kinds; migrates every PRD mandate and effective record without semantic loss using the authorized field mapping; rejects missing, mutable, mismatched, or non-exact provenance; enforces bidirectional supersession links and independently authorized deprecation; and proves accepted semantic content changes only through a new authorized ADR. Coexistence tests prove `DECISIONS.md` remains authoritative in `partial-mirror` and `complete-mirror`, every newly effective decision is dual-written, and the mirrors are complete and equivalent before one atomic `adr-authoritative` change deletes `DECISIONS.md` and transfers authority. Rejected GitHub verdicts produce no ADR file.

## Reversal criteria

Supersede if file-per-decision storage creates materially worse discovery, review, validation, or coordination overhead than the monolithic register; immutable files prevent necessary auditable maintenance; staged mirroring cannot prove lossless equivalence; or dual-writing and atomic cutover cannot prevent authority ambiguity. Any successor must preserve PRD supremacy, exact GitHub authorization provenance, merged repository effectiveness, semantic history, and a lossless transition for every governing record.
