---
id: "0004"
title: "Provider capability ports and adapter rollout"
status: Accepted
date: "2026-07-18"
aliases: [D-GH-4]
prd_references: "`prds/reflo-prd.md` §9 and §13"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the integration implementation issues, beginning with issue #28"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/4
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/4#issuecomment-5013547754
  record_pr: https://github.com/deepessh/reflo-learning/pull/65
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0004: Provider capability ports and adapter rollout

## Context

Reflo must integrate model, media, storage, delivery, and observability providers without spreading vendor SDKs through feature code or weakening the named Alibaba P0 production path. This verdict controls the shared provider-adapter boundary, activation eligibility, configuration, and cross-capability rollout rules only; capability-specific behavior remains independently reversible in its owning decision.

## Options

Narrow capability ports with thin provider adapters; one universal provider SDK wrapper; direct vendor SDK calls from feature/domain code.

## Decision

### Authorized verdict

Use narrow capability ports with thin provider adapters. Shared capability packages own provider-independent Reflo contracts, deterministic fakes, and reusable conformance suites. Only adapter modules may import vendor SDKs or types; composition roots import public adapter factories and select from an explicit allowlist using validated configuration, while feature/domain code never names providers. Adapters normalize failures and expose only allowlisted sanitized diagnostics. Adapters are unavailable by default until common conformance, adapter-specific translation/redaction, target-environment integration, and all applicable security, privacy, provider-setting, quota/capacity, feature, consent, and quality gates are current. Unknown, disabled, or no-longer-approved selections fail closed. Each operation uses exactly one approved adapter; rollback chooses another currently approved configuration or disables the capability. Fallback is capability-specific, implemented by the owning router/policy outside adapters and provider-agnostic callers, and permitted only when the PRD or an effective decision authorizes it under the same applicable gates. It may not weaken privacy or owner-scope controls, bypass P1 gates, violate delivery priority, or replace the named Alibaba P0 production path. Do not build a universal provider wrapper or runtime plugin registry.

### Rationale

Small capability contracts preserve service-specific semantics while providing deterministic tests, explicit activation, controlled fallback, and replaceable implementations. A universal wrapper would either leak vendor details or reduce distinct model, storage, messaging, and observability services to a weak common denominator; direct SDK calls would scatter policy and make offline/testing paths inconsistent.

## Verification

Import-boundary checks reject vendor SDK access outside adapters and provider branching in feature/domain packages. Common conformance suites run against deterministic fakes and every adapter, while adapter-specific tests cover translation and diagnostic redaction. Configuration fails closed for unknown, disabled, or stale adapters; rollout never shadow-sends learner data or duplicates messages/assets/authoritative writes; authorized fallback preserves the capability contract and applicable gates. Decisions #10 through #13 retain model-routing, TTS, event/retry, and OSS/CDN details; #14 retains P1 flag enforcement and #20 retains pilot rollout and kill switches.

## Reversal criteria

Supersede if measured adapter overhead blocks sprint delivery, capability contracts cannot express required provider semantics without pervasive escape hatches, or the boundary prevents a mandatory integration. Any replacement must preserve the PRD's model-routing, security, privacy, testing, and named P0 production-path requirements.
