# Reliable progressive learning delivery

> **Non-authoritative:** This document explores a durable architectural problem. It does not authorize architecture, record a decision, or track delivery work. Product requirements remain in the [PRD](../../prds/reflo-prd.md), and accepted architecture decisions remain in the [ADR collection](../adrs/README.md).

## Problem

Reflo presents one learning experience while work happens across interactive
requests, background generation, model and media providers, durable queues,
scheduled messages, signed web links, and a bounded offline demonstration. Some
artifacts are needed quickly, others arrive progressively, and optional
enhancements cannot block the core path.

The durable problem is making progress, retries, fallbacks, and terminal
outcomes coherent to learners and operators across those boundaries without
mistaking a target topology, a pre-generated fallback, or provider acceptance
for completed learner value.

## Forces and constraints

- The outline, first text lesson, placement quiz, and first playable audio have
  distinct SLOs; later artifacts fill in without delaying the usable course.
- Model, audio, and optional video capabilities can differ in latency, quota,
  payload shape, cancellation, and failure semantics while sharing provenance
  and tracing expectations.
- Durable background work crosses independently deployed runtimes. Retries and
  dead-letter handling must not create duplicate finalized artifacts or learner
  attempts.
- Primary and fallback audio paths need a common durable asset contract while
  remaining operationally independent.
- Video is a default-off enhancement and cannot become a hidden dependency of
  activation, study, or demo recovery.
- Telegram and opted-in email have different interaction models, yet each
  answer must resolve to one intended delivery item and one replay-safe
  attempt.
- Offline mode removes public internet, model APIs, the production backend, and
  CDN after preflight. It preserves a labeled, pre-generated Flow B rather than
  simulating live generation.
- A successful provider response is an intermediate fact; usable, authorized,
  source-backed output is the learner-visible completion condition.

## Risks

- A queue retry, timeout race, or late provider callback finalizes the same
  logical operation twice or overwrites a valid terminal result.
- The interface reports generic progress that cannot distinguish queued,
  running, retryable, permanently failed, superseded, or usable output.
- Fallback selection changes provenance or asset shape, or shares the same
  capacity dependency as the primary path.
- Optional media quietly enters readiness checks, navigation, or lesson
  completion and blocks P0 behavior.
- Message retries or webhook replays create duplicate deliveries or attempts;
  an emailed link can be redeemed by the wrong user or more than once.
- Offline artifacts drift from the online Flow B contract, or the demonstration
  implies that pre-generated behavior is live.
- A benchmark reports favorable completions while excluding cold caches,
  concurrent load, retries, terminal failures, or unsupported output.

## Evidence to preserve

- End-to-end operation histories that connect logical idempotency identities,
  provider attempts, retries, finalization, durable assets, and learner-visible
  state.
- Contract tests across provider adapters and primary/fallback paths, including
  cancellation, timeout, malformed response, replay, and late-success cases.
- SLO datasets that retain environment, corpus version, cold-cache conditions,
  concurrency, sample counts, misses, and complete latency distributions.
- Delivery tests showing that channel identity, intended learner, delivery
  item, expiry, and submission identity remain bound through retries and
  redemption.
- Online/offline parity evidence for the stored Flow B state transitions,
  accompanied by explicit capability and labeling differences.

## Open questions

- Which progress states are stable product concepts, and which provider details
  should remain behind an adapter boundary?
- How should a logical operation reconcile a late success after fallback,
  cancellation, expiry, or another terminal outcome?
- What evidence lets operators distinguish provider health, queue saturation,
  contract failure, authorization failure, and learner-visible unavailability
  without exposing learner content?
- How can the offline bundle prove behavioral parity while remaining small,
  deterministic, clearly pre-generated, and safe to refresh?

## Related authoritative sources

- [PRD §6, F1–F3 and F6; §8–§9; §11–§14](../../prds/reflo-prd.md)
- [ADR 0002 — workspace tooling and deployable service boundaries](../adrs/0002-workspace-tooling-and-deployable-service-boundaries.md)
- [ADR 0004 — provider capability ports and adapter rollout](../adrs/0004-provider-capability-ports-and-adapter-rollout.md)
- [ADR 0010 — typed model routing, prompt provenance, retry, and trace contract](../adrs/0010-typed-model-routing-prompt-provenance-retry-and-trace-contract.md)
- [ADR 0011 — CPU fallback TTS and layered audio asset contract](../adrs/0011-cpu-fallback-tts-and-layered-audio-asset-contract.md)
- [ADR 0012 — durable event idempotency, retry, DLQ, and finalization contract](../adrs/0012-durable-event-idempotency-retry-dlq-and-finalization-contract.md)
- [ADR 0014 — P1 feature flags and default-off enforcement](../adrs/0014-p1-feature-flags-and-default-off-enforcement.md)
- [ADR 0015 — repository-owned release-gate evaluation evidence](../adrs/0015-repository-owned-release-gate-evaluation-evidence.md)
