---
id: "0014"
title: "P1 feature flags and default-off enforcement"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-14]
prd_references: "`prds/reflo-prd.md` §6 F2 and F5–F7, §9, §11, and §13; mandate M-005"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the feature-flag registry, P1 capability entry points, deployment configuration, prerequisite evaluation, and resource-admission implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/14
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/14#issuecomment-5017132545
  record_pr: https://github.com/deepessh/reflo-learning/pull/76
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0014: P1 feature flags and default-off enforcement

## Context

Video, voice, OAuth, WhatsApp, Stripe, and self-service export are P1 runtime capabilities that must remain disabled by default, cannot bypass their prerequisites, and cannot displace P0 work. This verdict controls global P1 capability eligibility, default-off definitions, requested state, deployment ceilings, server-side enforcement, cache freshness, P0 resource protection, disabled-work handling, and narrow maintenance callbacks. Issue #15 controls release-gate evidence identity, currentness, and aggregation; issue #20 controls pilot/cohort rollout, emergency kill-switch workflow, and the operational disable-propagation SLO. Feature eligibility never grants owner-scope authorization, consent, provider approval, release-gate status, or product scope.

## Options

Build-time or browser environment flags; database-backed typed server-authoritative flags with a restrictive deployment ceiling; an external feature-flag service.

## Decision

### Authorized verdict

Adopt `p1-flags-v1`. Keep one checked-in closed registry with the initial Boolean keys `p1.media.video`, `p1.tutor.voice`, `p1.auth.oauth`, `p1.delivery.whatsapp`, `p1.billing.stripe`, and `p1.export.self_service`. Every definition has literal `default: false`, an owning capability, a complete immutable prerequisite-policy ID and version, and any required resource-admission policy; keys cannot be created dynamically, and unknown, removed, malformed, or missing keys evaluate false. Every entry has a complete capability-specific policy covering applicable PRD and effective-decision gates, approvals, provider eligibility, P0 preservation, and admission limits. `p1.media.video` is necessary but not sufficient for video: admission also accepts the closed operation kind `chapter_explainer` or `full_course`, and `full_course` independently requires current Week 2 P0 exit evidence. Store requested environment-level state in RDS with optimistic revision and record every attempted change in an append-only audit containing the key, environment, prior and requested state, outcome, authorized actor, UTC time, reason, registry and policy versions, and non-sensitive approval or evidence references. A least-privilege operator CLI changes requested state and writes the audit row transactionally; v1 has no mutation HTTP endpoint or admin UI. Enablement requires capability- and environment-specific authorization plus validated references, not authentication alone. Each deployment supplies an explicit server-only allowlist as a restrictive ceiling; it can keep a capability off but cannot enable it by itself. Missing, unknown, wildcard, or malformed configuration produces an empty P1 allowlist and a sanitized operator error while P0 remains available. Effective eligibility requires a known definition, RDS requested enablement, deployment allowance, a current satisfied prerequisite result from the authoritative contract eventually established by #15, and a valid resource-admission policy where capacity is shared. Until that evidence contract exists, or when evidence identity or currentness is indeterminate, the prerequisite evaluates false. Policy code may encode only existing PRD mandates and effective decisions; a version bump cannot loosen them. Each P1 capability sharing finite worker, queue, model, media, storage, or provider capacity with P0 has a checked-in bounded concurrency or rate policy and an explicit P0 reservation or priority rule; isolated capacity is declared. Missing or invalid policy evaluates false, and saturation defers or cancels P1 before P0. Evaluate through a typed trusted-server API accepting a registry key and, where required, a closed operation kind. The same current checks guard HTTP and server-rendered admission, command producers, schedulers, queue consumers and redrives, asset signing, publication and delivery, and provider or model adapter/router availability; clients and queue messages are never authority. Begin with a bounded process-local evaluated snapshot. Cached true results expire after a finite checked-in maximum-staleness deadline; after expiry, failed authoritative refresh evaluates false. Invalidation is an optimization, and #20 may impose a stricter bound. Producers may persist evaluated revisions only for diagnosis. Consumers and redrives reevaluate before external or learner-visible effects. If disabled before admission, compare-and-set only a nonterminal D-GH-12 operation to `cancelled`; never rewrite a terminal state, retry or dead-letter solely because the flag is off, or automatically resurrect cancelled intent. Renewed intent uses a new causally linked operation and idempotency key. Already finalized artifacts may remain stored but cannot be newly signed, published, or delivered while off. Irreversible provider submissions admitted before disablement are reconciled without duplication and remain unavailable to learners while off. Disabled capabilities cannot use callbacks to activate, establish new links, deliver content, or create learning effects, but narrow authenticated, replay-safe, idempotent maintenance paths remain available for deauthorization, consent or opt-out enforcement, refunds or cancellations, prior-provider reconciliation, and cleanup; those paths cannot re-enable exposure or update mastery. Removing or renaming a flag requires disabling it in every environment before the code change, and stale RDS rows remain inert. Build-time and browser flags are rejected because they are exposed or bypassed too easily, require deployment for every change, and do not provide durable authorization or worker and redrive rechecks. An external flag service is rejected for the sprint because it adds a production dependency and targeting surface before cohort evaluation is required.

### Rationale

A closed registry plus independently necessary RDS state, deployment allowance, prerequisites, and admission policy makes accidental activation fail closed without making the client, deployment config, cache, or queue authoritative. RDS provides auditable runtime state without another production service. Typed operation staging prevents a broad video flag from bypassing the full-course gate. Rechecking at every side-effect boundary and preserving D-GH-12 terminal semantics handles delayed and duplicate work safely, while narrow maintenance callbacks allow revocation and reconciliation after a feature is disabled. Explicit P0 reservations turn M-005's priority requirement into enforceable admission behavior rather than documentation.

## Verification

Registry and static checks prove every P1 runtime surface is represented exactly once, defaults false, and invokes the common guard at each entry and side-effect boundary. Unit tests cover missing state, unknown keys, absent or malformed deployment policy with P0 still available, missing or stale prerequisite evidence, invalid resource policy, RDS or cache failure, unauthorized CLI mutation, optimistic concurrency, and client attempts to self-enable. Integration tests cover HTTP and UI hiding, enqueue and consumer/redrive rechecks, adapter/router and signing unavailability, chapter-versus-full-course video separation, nonterminal cancellation without terminal-state rewrite, no resurrection, narrow callback maintenance, in-flight reconciliation, and audit completeness. Saturation tests prove P1 concurrency or rate limits and P0 reservation or priority under shared-capacity exhaustion. Disable tests prove no new admissions after a disabled revision is observed and no learner-visible publication or delivery after the propagation bound later authorized by #20, while separately reconciling provider work admitted before disablement. Production-like tests start with every P1 capability effectively off.

## Reversal criteria

Supersede if RDS-backed evaluation cannot meet measured request or worker latency with the bounded snapshot, cannot satisfy #20's propagation SLO, cannot protect P0 under shared-capacity saturation, or cannot consume #15 gate verdicts without duplicating authority. Any replacement must preserve literal default-off definitions, trusted-server enforcement at every side-effect boundary, audited authorized changes, a restrictive deployment ceiling, current prerequisites, typed operation staging, P0 capacity protection, and fail-closed behavior without treating the client or queue as authority.
