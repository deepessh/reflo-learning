---
id: "0007"
title: "Layered owner-scope enforcement"
status: Accepted
date: "2026-07-18"
aliases: [D-GH-7]
prd_references: "`prds/reflo-prd.md` §9, §10, and §11"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of authorization-sensitive implementation issues; issue #27 owns the initial RDS schema surface"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/7
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/7#issuecomment-5014469215
  record_pr: https://github.com/deepessh/reflo-learning/pull/69
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0007: Layered owner-scope enforcement

## Context

Every course and source must be isolated by owner scope, with active membership enforced before retrieval, mutation, asset signing, vector operations, and cached responses. This verdict controls the non-bypassable authorization contract across application guards, RDS data access, jobs, caches, asset-signing entry points, vector adapters, and server-resolved citations. It does not choose the physical vector namespace or index layout, OSS key layout or signing technology, URL expiry or invalidation, session mechanics, queue-envelope structure, deletion-role workflow, or migration-role ownership; those remain with issues #9, #13, #6, #12, #18, and D-GH-3 respectively.

## Options

Application authorization guards only; database row policies only; layered application authorization plus database and provider-boundary enforcement.

## Decision

### Authorized verdict

Adopt layered owner-scope enforcement. The server derives the actor and target scope from authenticated identity and persisted resource relationships; client, model, cache, or queue values are never authority. Typed application guards check active membership at the point of every retrieval, mutation, asset-signing request, vector operation, and cached response. RDS runtime access uses transaction-local actor and scope context that fails closed when absent. Runtime roles are not table owners, superusers, or granted `BYPASSRLS`; row-level security and database-enforced scoped relationships independently prevent cross-scope reads, writes, and links. During MVP only personal user scopes may be created, each active user scope has exactly one active owner membership, and organization scopes and non-owner roles remain disabled. Jobs reauthorize membership and resource ownership before privileged access; caches are scope-keyed and reauthorized before return. Asset signing accepts only server-resolved authorized resources and never arbitrary caller-supplied object keys. Vector adapters require a non-removable owner scope for every write, update, search, and result-validation path. Uploaded or retrieved source text cannot influence authorization or filters, and displayed citations resolve server-side only to currently authorized source spans.

### Rationale

Application guards express action-level policy and produce clear failures, but omissions in API or job code must not expose data. RLS and scoped relationships provide an independent RDS backstop, while explicit cache, signing, vector, and citation boundaries cover stores PostgreSQL cannot protect. Transaction-local context prevents pooled connections from leaking authorization state across requests, and least-privilege runtime roles keep the database backstop effective.

## Verification

Tests reject forged scope IDs, absent authorization context, revoked membership at point of use, zero or multiple active owners during a normal active user-scope lifecycle, cross-scope direct and multi-hop relationships, pooled-connection context reuse, cache leakage, tampered job messages, arbitrary or cross-scope asset references, missing or replaced vector filters, cross-scope vector writes or results, unauthorized source-span citations, and direct cross-scope access by runtime database roles. Application-guard and RLS conformance tests cover the same access matrix without assuming either layer replaces the other. Remaining validity of an already issued signed URL follows issue #13 rather than this verdict.

## Reversal criteria

Supersede if the layered contract cannot meet required latency or deployment behavior, PostgreSQL RLS cannot be operated safely with the selected connection and role model, or an alternative provides equivalent independently enforced isolation across every covered store with lower measured risk. Any replacement must preserve the PRD owner-scope, active-membership, untrusted-content, and zero-cross-scope-disclosure requirements.
