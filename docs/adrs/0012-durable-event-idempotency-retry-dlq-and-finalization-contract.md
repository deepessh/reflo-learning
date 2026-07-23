---
id: "0012"
title: "Durable event, idempotency, retry, DLQ, and finalization contract"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-12]
prd_references: "`prds/reflo-prd.md` §6 F2, F4, F6, and F7; §§9–12"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of durable generation, learning-event, messaging-delivery, and deletion-job implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/12
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/12#issuecomment-5016725056
  record_pr: https://github.com/deepessh/reflo-learning/pull/74
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0012: Durable event, idempotency, retry, DLQ, and finalization contract

## Context

Queue-driven generation, append-only learning events, replay-safe messaging, and deletion cleanup must survive duplicate, delayed, reordered, and failed delivery without duplicating assets, attempts, mastery changes, messages, or destructive work. This verdict controls the application event envelope, schema-version lifecycle, idempotency namespace, RDS outbox/inbox and operation-state boundary, outer queue retries, DLQ ownership/redrive, and terminal-state finalization. It does not replace D-GH-3's RDS schema/write ownership, D-GH-4's adapter boundaries, D-GH-7's owner-scope enforcement, D-GH-10's immediate model-router attempt policy, #11's TTS fallback, #17's grading rules, or #18's consent, retention, deletion execution, and final-telemetry policy.

## Options

Separate per-domain envelopes; one minimal shared application envelope with typed domain payloads; broker-native metadata without an application contract.

## Decision

### Authorized verdict

Adopt `reflo-event-envelope-v1`, a minimal immutable application envelope over RocketMQ with runtime-validated typed and versioned domain payloads. It contains a globally unique opaque `message_id`; `message_kind` (`command` or `event`); stable dotted `message_name`; positive integer `message_version`; UTC `occurred_at`; stable `producer`; `environment`; `correlation_id`; optional `causation_id`; globally namespaced `idempotency_key`; optional `deadline_at`; optional sanitized trace context; and the typed payload. Scoped work carries only the opaque resource and owner-scope references needed to re-resolve authorization; queue values are never authority, and consumers reauthorize current membership, ownership, retention, feature, and consent state. Envelopes, broker properties, logs, and DLQ diagnostics exclude raw source passages, learner answers, generated content, contact data, credentials, provider payloads, and raw diagnostics. Names and versions select checked-in validators. Backward-compatible optional additions may retain a version; removals, meaning changes, or required-field additions require a new version and an explicit consumer migration. Unknown names or versions fail closed as non-retryable `unsupported_contract` before domain logic. Consumers remain compatible with versions that can exist in a live queue, DLQ, outbox, or redrive window. Use the ASCII namespace `environment/message-name/v<version>/<opaque-business-key>`; stable server-issued identifiers and operation versions form the business key, while sensitive or user-controlled material is represented only by a keyed digest. The complete key is unique in RDS. Retries and redrives retain the original message ID and idempotency key; changed intent or payload creates a new operation key and, when derived, a causally linked message. Message IDs deduplicate transport delivery and idempotency keys deduplicate the logical business effect. `packages/db` owns transactional outbox, inbox/idempotency, operation-state, lease, and attempt-record entry points. Producers commit authoritative state and an outbox row in one transaction; relays may republish until broker acknowledgement. Consumers atomically claim an idempotency key with a lease, record attempts, and acknowledge only after finalization commits. Completed duplicates return the stored outcome; active duplicates cannot execute concurrently and use bounded lease recovery. External side effects receive the logical key only where the adapter proves idempotent submission; otherwise the consumer submits once, persists the provider request identifier before resubmission, and reconciles instead of blindly repeating an ambiguous call. D-GH-10's immediate model-router attempts remain within one queue attempt and cannot reset the outer budget or deadline. Every message name selects a checked-in versioned policy declaring its owner, retryable normalized failure classes, maximum deliveries, backoff and jitter, and absolute deadline or expiry. Ordinary work permits at most five total queue deliveries, uses bounded exponential backoff with deterministic-testable jitter, and never retries past its deadline. Only normalized transient availability, timeout, throttling, or contention failures retry. Invalid payloads, unsupported contracts, authorization/policy/safety failures, cancellation, and known non-idempotent ambiguity do not retry blindly. Deletion cleanup is the only longer-running policy class: it is bounded by the PRD's 24-hour active/derived-store window, records per-store retries, and exposes terminal failure rather than claiming success; delivery retries stop at persisted expiry. Each message name has one registered owning domain and one environment-scoped DLQ. Exhausted or non-retryable failures preserve the original envelope plus only sanitized failure class, policy version, attempt count, first/last failure times, and correlation identifiers, and alert the owner. Cancellation and normal expiry finalize without DLQ unless their policy marks expiry exceptional. Redrive is operator-controlled and audited, rechecks cause, authorization, and retention state, and reuses the original envelope and key; payload correction creates a new causally linked message and operation. DLQ and outbox data participate in deletion and cannot become shadow retention stores. RDS operation state is authoritative: nonterminal states are `queued`, `processing`, and `retry_scheduled`; terminal states are `succeeded`, `failed_permanent`, `cancelled`, and `expired`. `dead_lettered` is a delivery disposition on `failed_permanent`, not business success or a separate business outcome. Success atomically persists validated output, terminal state, and completion outbox event; permanent failure atomically persists a sanitized failure and failure outbox event before acknowledgement or DLQ handoff. Compare-and-set finalization makes the first committed terminal state win, so late, duplicate, stale-lease, and out-of-order completions cannot overwrite it or emit a second logical effect. This is at-least-once delivery with exactly-once logical effects, not distributed exactly-once execution.

### Rationale

A small shared envelope makes cross-domain reliability, correlation, schema validation, privacy, and operations consistent while preserving typed domain semantics. RDS outbox/inbox and compare-and-set finalization close the crash windows that broker acknowledgements alone cannot close. Explicit idempotency and external-call reconciliation accept RocketMQ's at-least-once reality without making an unprovable exactly-once claim. Bounded policy-driven retry avoids both silent loss and retry storms, while owned sanitized DLQs make permanent failure recoverable without creating a PII shadow store.

## Verification

Contract tests validate every registered envelope/payload pair, version transition, policy, owner, terminal mapping, and PII denylist; unknown contracts fail before domain code. Crash-point tests cover commit-before-publish, publish-before-outbox-mark, claim-before-work, external-submit reconciliation, output-before-ack, and terminal-commit-before-ack without lost work or duplicate effects. Duplicate, concurrent, reordered, stale-lease, late-success, retry-exhaustion, cancellation, expiry, and controlled-redrive tests prove first-terminal-state-wins behavior. Retry tests prove only eligible normalized failures retry, ordinary work never exceeds five deliveries or its deadline, router attempts do not reset the outer budget, deletion stops within its PRD window, and jitter is deterministic under test. Authorization tests prove queue values never grant access and redrive rechecks current scope, retention, consent, and feature state. DLQ and telemetry tests prove ownership and alerts, immutable redrive identity, sanitized diagnostics, and deletion from queue, DLQ, outbox, inbox, and attempt stores without resurrection.

## Reversal criteria

Supersede if transactional outbox/inbox overhead prevents the PRD SLOs, the shared envelope cannot express a required domain contract without pervasive escape fields, RocketMQ semantics make lease or redrive rules unsafe, or measured policies cause unacceptable loss or retry amplification. Any replacement must preserve RDS authority, D-GH-3/4/7/10 boundaries, replay-safe delivery, first-terminal-state-wins behavior, bounded retries, deletion coverage, privacy, and exactly-once logical effects under duplicate delivery.
