---
id: "0003"
title: "SQL migrations, schema ownership, and write boundaries"
status: Accepted
date: "2026-07-18"
aliases: [D-GH-3]
prd_references: "`prds/reflo-prd.md` §9 and §10"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #27"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/3
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/3#issuecomment-5013417611
  record_pr: https://github.com/deepessh/reflo-learning/pull/64
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0003: SQL migrations, schema ownership, and write boundaries

## Context

RDS PostgreSQL is the transactional system of record, while the independently deployable API and jobs must not create competing schema or write ownership. This verdict controls migrations and write access to the RDS system-of-record schema only; it does not govern the AnalyticDB vector schema or namespace contract, owner-scope/RLS policy details, deployment orchestration, or runtime query-library selection.

## Options

One application-owned plain-SQL migration stack and shared database boundary; service-owned migrations; ORM-managed schema synchronization without an explicit owner.

## Decision

### Authorized verdict

Use dbmate as the sole migration tool for the transactional RDS PostgreSQL schema, initially pinned exactly to `dbmate@2.34.1`, with every future version exactly pinned. `packages/db` exclusively owns append-only timestamped SQL migrations, the generated checked-in `schema.sql`, and deliberate public transaction/repository entry points. Merged migrations cannot be edited, renamed, or deleted, and no ORM or query library may push or synchronize the schema. Production runs `dbmate --strict migrate` as an explicit serialized deployment operation under a DDL-capable migrator role; it never runs during application startup or Function Compute cold starts. The deployment guarantees one active runner or uses a PostgreSQL advisory-lock wrapper. Web has no database credentials; API and job runtime roles have only required DML privileges. Raw database-client use outside `packages/db` is prohibited. Independently deployed non-Node workers write through versioned, runtime-validated, language-neutral API or RocketMQ command contracts rather than directly to core RDS tables. Deployed migrations are forward-only, use expand/contract compatibility, default to transactional execution, and require explicit review for `transaction:false`.

### Rationale

Plain SQL preserves PostgreSQL-native constraints and features without making an ORM or one programming language the schema authority. A single shared owner keeps independently deployed runtimes consistent, while explicit serialized deployment, least-privilege roles, append-only enforcement, and expand/contract changes address dbmate's lack of content checksums and a built-in global migration lock. The boundary also keeps future non-Node workers possible without permitting competing direct-write implementations.

## Verification

CI rejects edits, renames, or deletion of merged migrations; provisions an empty compatible PostgreSQL database; applies every migration from zero with strict ordering; explicitly runs `dbmate dump` using a pinned compatible PostgreSQL client; and fails on a `schema.sql` diff. Import checks reject raw database clients outside `packages/db`. Production runtime roles cannot execute DDL or create databases, concurrent migration attempts cannot both proceed, and old/new API and job versions remain compatible during deployment. The existing human escalation rule still governs post-activation changes to `KnowledgeState` or `Attempt`.

## Reversal criteria

Supersede if plain-SQL ownership creates measured delivery or safety failures, dbmate cannot support required PostgreSQL migration behavior, or the cross-runtime command boundary prevents required workload isolation. Any replacement requires a new authorized decision and merged record.
