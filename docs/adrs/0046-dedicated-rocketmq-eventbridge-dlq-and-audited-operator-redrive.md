---
id: "0046"
title: "Dedicated RocketMQ EventBridge DLQ and audited operator redrive"
status: Accepted
date: "2026-07-30"
aliases: [D-GH-209]
prd_references: "`prds/reflo-prd.md` v2.7 §6 F2 and §§9–11 and 13; ADR 0012; ADR 0031; ADR 0045; issue #199"
ownership:
  proposer: "@deepessh through issue #209"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #199 for the bounded Demo Day dev deployment; owners of separately authorized successor DLQ and redrive work for other environments"
authorization:
  decider: "@deepessh, repository owner and named architecture decider for issue #209"
  approval_basis: >-
    owner review of the proposal and the evidence/constraints recorded in
    https://github.com/deepessh/reflo-learning/issues/209#issuecomment-5134712497,
    followed by the explicit instruction: “Proceed.”
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/209
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/209#issuecomment-5134729281
  record_pr: https://github.com/deepessh/reflo-learning/pull/211
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0046: Dedicated RocketMQ EventBridge DLQ and audited operator redrive

## Context

ADR 0012 requires one environment-scoped dead-letter queue for each registered
message name, RDS-authoritative finalization, sanitized diagnostics,
operator-controlled audited redrive, current authorization and retention
rechecks, immutable application identity, and deletion coverage. ADR 0031
limits finalized queue and DLQ retention to the proven replay window and no
more than 30 days, while its active and derived-store deletion outcome remains
24 hours. ADR 0045 separately selects the transactional-outbox relay and
RocketMQ producer boundary; it does not select a dead-letter destination.

Issue #199 and draft PR #205 define a bounded `dev` path in which a private
RocketMQ 5.x topic feeds one Function Compute jobs function through an
EventBridge event stream. The current stream uses bounded backoff retries and
`ErrorsTolerance: NONE`. That state fails closed after exhaustion and prevents
silent discard, but one poison event can block later work and there is no owned
provider destination or trusted redrive path.

Alibaba documents that EventBridge can use ApsaraMQ for RocketMQ as a task-level
DLQ. With fault tolerance allowed, EventBridge sends an exhausted raw event to
the configured DLQ and continues later work; without a configured DLQ, the same
setting discards the event. The EventBridge and Function Compute trigger
contracts expose a dead-letter ARN and private-network settings. RocketMQ
native consumer dead-lettering is a different mechanism: it follows RocketMQ
consumer retries, is disabled by default, changes the broker message ID, and
does not prove the EventBridge-to-Function-Compute terminal handoff.

EventBridge stores the raw CloudEvents delivery wrapper rather than a new
authoritative Reflo record. For the current source, that wrapper contains the
original RocketMQ message body and provider transport metadata. The embedded
body is the already constrained `reflo-event-envelope-v1`; the wrapper and its
broker identifiers cannot grant authority, replace RDS state, or become a
second diagnostic or retention record.

This record chooses only the physical provider DLQ topology for
`audio.generate.v1` in bounded `dev` and the trusted operator boundary that
inspects and redrives it. It does not change ADR 0012 application semantics,
approve a cloud plan or apply, authorize resource creation or service
activation, add compute or another cloud service, approve spending, publish a
message, create a secret, or permit public use or external learner data.

## Options

Use one dedicated normal topic in the existing RocketMQ instance as the
EventBridge task DLQ; rely on the main RocketMQ consumer group native
dead-letter policy after a separate Singapore proof; add MNS, Kafka, or an
EventBridge event bus; or keep the event stream permanently blocked after
exhaustion.

## Decision

### Authorized verdict

Adopt `rocketmq-eventbridge-dlq-redrive-v1` for issue #199's bounded Demo Day
`dev` deployment.

#### Provider topology and fail-closed activation

Create exactly one dedicated `NORMAL` RocketMQ 5.x topic for the
`dev/audio.generate.v1` EventBridge DLQ in the already approved private
RocketMQ instance. Its deterministic repository name is
`reflo-dev-audio-generate-v1-dlq`. Do not reuse the original `reflo-jobs`
topic, a transactional or scheduled topic, another message name's DLQ, or a
topic in another service or instance.

Create one dedicated operator-only consumer group named
`reflo-dev-audio-generate-v1-dlq-operator`. The normal jobs consumer group must
never subscribe to the DLQ topic, and no continuously running application
consumer may use the operator group. Do not create a second native RocketMQ
dead-letter destination for this operator group or route its failures back to
the original or EventBridge DLQ topic.

Configure the existing EventBridge task dead-letter option with the exact topic
ARN and the existing private VPC, vSwitch, and security-group boundary. The
EventBridge service-linked role may publish only to that destination. No public
endpoint, NAT path, cross-region route, MNS queue, Kafka topic, event bus, SLS
store, or new compute unit is permitted.

Keep `ErrorsTolerance: NONE` until the topic, operator group, private-network
fields, least-privilege access, alerts, retention, deletion behavior, and
activation proof in this record are present and verified. Only then may the
same event stream use `ErrorsTolerance: ALL`. Repository policy must reject
fault tolerance allowed without the exact DLQ configuration. Any provider
schema rejection, missing destination, permission drift, or health failure
returns the stream to the blocked fail-closed state; it never enables discard.

Keep the accepted bounded backoff retry policy. EventBridge retries do not
replace the message policy, outer delivery budget, deadline, application
attempt history, or RDS finalization rules in ADR 0012. A provider handoff is a
delivery disposition, not business success.

#### Safe record and identity boundary

The DLQ message body is an EventBridge-generated CloudEvents wrapper. Treat it
only as untrusted transport evidence. A closed runtime validator must:

1. accept only the expected RocketMQ source and EventBridge wrapper shape;
2. require the bounded `dev`, `audio.generate.v1`, and original-topic
   relationship;
3. decode and validate exactly one embedded `reflo-event-envelope-v1`;
4. reject unknown message names or versions, unexpected environment or topic
   values, malformed encoding, oversized fields, and disallowed properties;
   and
5. pass only the validated embedded Reflo envelope and sanitized correlation
   identifiers across the application boundary.

The original producer must keep source text, learner answers, generated
content, contact data, credentials, provider payloads, and raw diagnostics out
of the envelope and broker properties. The operator must not copy the raw
CloudEvents wrapper, instance or broker identifiers, raw properties, or
provider diagnostics into RDS, audit rows, logs, traces, issue comments, or
evidence.

The embedded Reflo `message_id` and `idempotency_key` remain authoritative and
unchanged across inspection, retry, and redrive. EventBridge event IDs,
RocketMQ broker message IDs, and the new broker ID assigned to a redriven
publication are bounded sanitized diagnostics only. They never authorize work
or deduplicate a logical effect. A changed payload, intent, owner reference, or
operation version creates a new ADR 0012 operation and causally linked message;
the operator cannot edit a dead letter in place.

Resolve the envelope against authoritative RDS operation, inbox, outbox,
attempt, failure, authorization, retention, feature, and deletion state.
Queue values cannot create or revive authority. A business failure that
reached the handler must finalize its sanitized RDS outcome before the handler
returns failure. A pre-invocation transport failure may leave nonterminal RDS
state; the operator path must use a narrow `packages/db` reconciliation entry
point to record the normalized transport outcome before it can authorize a
redrive. Missing, contradictory, or already deleted authoritative state fails
closed.

#### Trusted operator redrive

Implement redrive as an explicit, bounded command on the existing API ECS
control plane. It is not an HTTP endpoint, scheduled task, automatic consumer,
background daemon, or general RocketMQ administration tool. Only an approved
operator using the existing protected administrative path can invoke it.
Separate command authorization, OS execution identity, database entry points,
and broker permissions from the public API process as far as the accepted
single-host and credential-free private-VPC boundary permits.

The command receives at most a small configured batch from the dedicated
operator group and processes each record independently. Before publication it
must:

1. validate and extract the safe envelope as specified above;
2. acquire a bounded RDS redrive claim keyed by original Reflo identity;
3. resolve the authoritative operation and sanitized failure;
4. require an operator reason code and reject free-form payload or diagnostic
   input;
5. recheck the failure cause and remediation state, current owner
   authorization, retention and deletion state, feature state, deadline,
   registered message policy, and target environment;
6. reject cancellation, expiry, unsupported contracts, policy and safety
   failures, deleted scopes, changed intent, and any state for which unchanged
   redrive is not valid; and
7. append an immutable sanitized `authorized` audit event before any publish.

Publish the unchanged validated envelope only through the ADR 0045
provider-neutral port and exact RocketMQ adapter. A structurally valid broker
receipt permits an immutable `published` audit event and acknowledgement of the
operator-group delivery. An exception, timeout, invalid receipt, process
termination, database failure, or ambiguous result cannot record success or
acknowledge the DLQ delivery.

The redrive claim and audit stream are replay-safe. An exact repeated operator
request returns or continues the stored outcome rather than creating a second
authorization. A crash after broker acknowledgement but before the RDS
published event or DLQ acknowledgement may republish the same envelope with a
new broker ID. ADR 0012 inbox and idempotency behavior must absorb that
duplicate without a second logical effect. The audit trail records each
sanitized publication attempt and never claims distributed exactly-once
execution.

An operator rejection that is permanent, including deletion, expiry, revoked
authorization, or invalid contract, records a sanitized immutable `rejected`
event and acknowledges the operator-group delivery so it cannot loop. A
transient operator-path failure leaves the delivery available within its
bounded invisibility and retry window and alerts the owner. The command stops
before the operator consumer group can exhaust into discard or another native
DLQ; reaching that guard is a visible blocked condition requiring remediation.

#### Retention, deletion, alerts, and evidence

Set the existing RocketMQ 5.x instance to its minimum 24-hour message
retention. Alibaba applies retention per instance rather than per topic, so the
same bound covers the original and DLQ topics. This satisfies ADR 0031's
24-hour active and derived-store erasure outcome without introducing a
separate longer-lived queue store. Do not raise the instance retention period
without a successor decision that preserves deletion and the approved spend.

Deletion and teardown cover the DLQ topic, operator consumer group and offsets,
in-flight claims, redrive audit linkage, original outbox and inbox state, and
all related sanitized evidence. The validator and operator command must deny
and acknowledge a DLQ record for a scope already under deletion, without
republishing it or retaining copied payload. Whole-topic deletion remains a
teardown or incident action, not a per-learner deletion mechanism.

Alert on EventBridge DLQ handoffs, DLQ topic backlog, oldest-record age,
operator-group retry guard, validator rejections, ambiguous publications, and
configuration drift. Alerts contain only bounded counts, times, message-policy
names, and sanitized failure classes. They contain no payload, envelope,
learner or owner identifier, broker or account identifier, private endpoint,
or raw diagnostic.

Do not activate fault tolerance from local tests alone. The target-Singapore
proof must use the exact private instance, EventBridge task, topic ARN, network
fields, operator group, immutable application artifact, and 24-hour retention.
With synthetic data it must prove:

- one exhausted delivery reaches exactly the dedicated DLQ and later source
  messages continue only after the DLQ is configured;
- fault tolerance without that destination is rejected before activation;
- the operator validator accepts the expected wrapper and rejects malformed,
  cross-environment, unknown-contract, and disallowed-property records;
- authoritative RDS reconciliation and every current-state recheck run before
  publication;
- unchanged redrive preserves Reflo identity and creates an immutable audit
  trail;
- a publish-before-audit or publish-before-ack crash can retry without a second
  logical effect;
- permanent rejection cannot loop or resurrect deleted work;
- alerts contain no payload or correlatable identifiers; and
- the synthetic DLQ record, consumer state, audit linkage, and test operation
  are deleted or expire within the accepted bound.

If the Singapore API rejects the exact DLQ ARN or private-network fields,
EventBridge emits content outside the closed safe wrapper, the operator group
cannot avoid discard or a second native DLQ, the instance cannot enforce the
24-hour retention bound, or duplicate redrive breaks ADR 0012 behavior, keep
`ErrorsTolerance: NONE` and return to issue #209 for a successor decision.

### Rationale

A dedicated topic makes the EventBridge terminal-delivery boundary explicit
and preserves later work without adding a service, compute unit, public
endpoint, or independent retention system. Keeping the main consumer group
away from the DLQ prevents a poison message from re-entering the ordinary
retry loop. The operator-only group makes inspection and acknowledgement
bounded and auditable.

Validating only the embedded Reflo envelope preserves the accepted application
contract while acknowledging that EventBridge necessarily stores a provider
wrapper. RDS rechecks prevent stale queue data from reviving authorization or
retention. Original application identity plus inbox/idempotency handling closes
the unavoidable publish-before-audit and publish-before-ack crash windows.

The instance-wide 24-hour minimum retention is the only supported configuration
that satisfies the existing deletion outcome without adding a dedicated
shorter-retention service. Keeping fault tolerance prohibited until the entire
destination and operator path pass in Singapore prevents both silent discard
and an unverified success claim.

## Verification

ADR governance resolves alias `D-GH-209`, the exact decision issue, the owner
verdict comment, and this record PR. Architecture validation retains ADRs 0012,
0031, and 0045 as active authorities and identifies this record as the
provider-DLQ and operator-redrive specialization for issue #199.

Infrastructure policy freezes the one normal DLQ topic, one operator group,
same private instance, EventBridge topic ARN and network fields, 24-hour
instance retention, bounded retry, and conditional `ErrorsTolerance: ALL`.
Tests reject another provider, instance, topic type, environment, public or
cross-region route, automatic subscriber, main-group subscription, missing
DLQ, tolerance without DLQ, a second native DLQ, and unapproved retention
drift.

Contract tests cover closed wrapper and envelope validation, size and property
limits, environment/topic/name/version mismatch, disallowed data, provider
metadata rejection, authoritative RDS lookup, current-state rechecks, changed
intent, and deletion. Database tests cover redrive claims, exact request
replay, concurrent operators, immutable authorization/rejection/publication
events, missing and contradictory state, and sanitized audit fields.

Adapter and command tests cover bounded receive and invisibility, least
privilege, reason-code allowlisting, original-envelope publication through the
ADR 0045 port, receipt validation, acknowledgement ordering, transient retry
guard, permanent rejection acknowledgement, graceful interruption, and no
HTTP, scheduler, daemon, or general administration path.

Crash tests cover receipt-before-audit, audit-before-ack, process termination,
lease expiry, ambiguous send, repeated operator invocation, and delivery with
a different broker ID while proving one Reflo identity and one logical effect.
Retention, deletion, alert, teardown, and target-Singapore tests prove the
outcomes and evidence limits in the decision.

## Reversal criteria

Supersede if EventBridge cannot use the exact private RocketMQ topic in
Singapore; its wrapper cannot remain inside the safe contract; RocketMQ
operator-group semantics require discard or another shadow DLQ; 24-hour
instance retention cannot satisfy product operation or deletion; least
privilege cannot be preserved on the single ECS control plane; redrive cannot
remain replay-safe and RDS-authoritative; or an already approved destination
offers materially safer deletion and operations without expanding cost or
service surface. Any successor must preserve fail-closed no-discard behavior,
one owner per message policy, immutable Reflo identity, RDS authority, current
authorization and retention rechecks, audited operator control, bounded
retries, deletion coverage, sanitized evidence, and duplicate-safe logical
effects.
