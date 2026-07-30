---
id: "0045"
title: "Supervised RocketMQ transactional-outbox relay on API ECS"
status: Accepted
date: "2026-07-30"
aliases: [D-GH-208]
prd_references: "`prds/reflo-prd.md` v2.7 §6 F2 and §§9–11 and 13; ADR 0003; ADR 0004; ADR 0012; issue #199"
ownership:
  proposer: "@deepessh through issue #208"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #199 for the bounded Demo Day dev deployment; owners of separately authorized successor relay work for other environments"
authorization:
  decider: "@deepessh, repository owner and named architecture decider for issue #208"
  approval_basis: >-
    owner review of the proposal and the evidence/constraints recorded in
    https://github.com/deepessh/reflo-learning/issues/208#issuecomment-5112951264,
    followed by the explicit instruction: “Approve option 1 for #208 with the
    constraints in the evidence comment.”
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/208
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/208#issuecomment-5134476836
  record_pr: https://github.com/deepessh/reflo-learning/pull/210
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0045: Supervised RocketMQ transactional-outbox relay on API ECS

## Context

ADR 0012 makes RDS PostgreSQL authoritative for durable asynchronous work.
Producers commit authoritative state and an outbox row in one transaction; a
relay may republish until the broker acknowledges the message; consumers use
the immutable Reflo envelope, inbox claims, idempotency keys, leases, and
first-terminal-state-wins finalization to absorb duplicate, delayed, and
reordered delivery.

The current repository creates `outbox_message` rows and issue #199 has a
deployable private RocketMQ-triggered Function Compute consumer, but nothing
publishes those rows. The bounded Demo Day dev topology has one existing API
ECS host, one private RocketMQ 5.x endpoint, and one immutable Node deployment
archive. It excludes additional relay compute, Alibaba Container Registry,
SLS, KMS Secrets Manager, and NAT. Relay implementation must preserve ADR
0003's `packages/db` ownership, ADR 0004's narrow provider-adapter boundary,
and ADR 0012's application identity and acknowledgement semantics.

Alibaba Cloud identifies `rocketmq-client-nodejs@1.0.5` as its tested and
recommended Node client for RocketMQ 5.x. The exact published Apache-2.0
release supports the private endpoint, explicit producer startup and
shutdown, normal-message sends, message keys and properties, request
timeouts, and send receipts. It also defaults to three internal send attempts,
generates a new broker message ID for each outer `send()` call, provides no
abort signal for a send, and can fail while notifying the broker during
shutdown. Those behaviors require an explicit adapter policy rather than
becoming implicit application semantics.

This record chooses only the relay runtime topology and exact provider client.
Issue #209 independently owns the RocketMQ/EventBridge DLQ and trusted redrive
boundary. This record does not authorize a cloud plan or apply, resource
creation, service activation, message publication, secret, additional
compute, spending change, public use, or external learner data.

## Options

Run a separate supervised Node relay on the existing API ECS host; run a timer
inside the API HTTP process; add a scheduled Function Compute poller; or build
a separate artifact around a different officially supported language client.

## Decision

### Authorized verdict

Adopt `supervised-rocketmq-outbox-relay-v1` for issue #199's bounded Demo Day
dev deployment.

Run exactly one active relay as a separate `systemd` service on the existing
API ECS host. Package it in the same content-addressed immutable deployment
archive as the API, but give it a separate composition root, entrypoint,
lifecycle, health state, restart policy, and bounded shutdown window. Do not
run relay polling inside the HTTP process and do not add a scheduled function,
another host, another language runtime, or another deployment artifact. A
single configured instance is the bounded dev topology; the database claim
contract must nevertheless remain safe if a replacement process overlaps
during restart or a later separately authorized environment runs more than
one relay.

Keep all durable relay behavior provider-neutral. `packages/db` owns the
append-only migration and deliberate public entry points for bounded outbox
claim, lease recovery, acknowledgement, and failed-attempt release. Claim
unpublished rows in stable priority and creation order using database locking
that skips rows already claimed by another active transaction. Persist a
bounded lease before network publication, recover only expired leases, and
leave an unacknowledged row eligible for a later claim under its registered
message policy and deadline. Raw PostgreSQL access is prohibited in the
RocketMQ adapter and relay composition root.

Expose a narrow publishing port whose input is one runtime-validated
`reflo-event-envelope-v1` and whose successful result means only that the
configured broker acknowledged the send. The port does not expose RocketMQ
types, broker retries, routing, credentials, receipts, or message IDs.
Provider failures are normalized into the existing sanitized failure
taxonomy. Outbox claim, lease, retry eligibility, deadline, acknowledgement,
and state transitions remain DB-owned and provider-independent.

Implement the port with one thin adapter pinned exactly to
`rocketmq-client-nodejs@1.0.5`; commit the exact transitive dependency
resolution in the pnpm lockfile. Only that adapter may import the package or
its types. Configure one long-lived `Producer` for the predeclared normal
topic, the private VPC endpoint, the instance namespace, an explicitly
bounded request timeout, and `maxAttempts: 1`. The SDK's route-discovery
startup retries are lifecycle behavior; its default three send attempts must
not become a second publication-retry policy.

Publish normal messages only. The RDS transactional outbox is the transaction
boundary; do not use RocketMQ transactional messages. Serialize the complete
validated Reflo envelope as the body and include the immutable Reflo
`message_id` as an opaque broker key or allowlisted property for diagnosis.
The Reflo `message_id` and `idempotency_key`, not the SDK-generated broker
message ID, remain authoritative across retries and redrives. Do not place raw
source passages, learner answers, generated content, contact data,
credentials, provider payloads, or raw diagnostics in the body, keys,
properties, logs, or traces.

Mark an outbox row published only after `send()` returns a structurally valid
receipt. A returned broker message ID is sanitized diagnostic evidence, not
application identity or authorization. A timeout, exception, invalid receipt,
process crash, or shutdown before the DB acknowledgement commits leaves the
row unpublished. A crash after broker acknowledgement but before
`published_at` commits may therefore cause a later publication with a
different broker message ID; ADR 0012's application envelope and consumer
inbox/idempotency contract must absorb that duplicate without a second
logical effect. Do not claim distributed exactly-once execution.

Use the private VPC endpoint only. The bounded dev adapter supplies no
RocketMQ username or password when the serverless instance's authenticated
network configuration permits authentication-free access from the approved
VPC boundary. If target-Singapore verification shows that credentials are
required, fail closed and return for separate secret and deployment authority;
do not add or derive a credential silently. No public endpoint, NAT path, or
fallback broker is permitted.

On startup, validate configuration, establish the producer, verify the
predeclared topic route, and report readiness before leasing rows. During
normal operation, use bounded batches, polling intervals, and in-flight
publication concurrency so relay work cannot starve the co-located API.
Backpressure leaves rows durable in RDS rather than accumulating unbounded
memory. Health reporting exposes only sanitized state and bounded counts.

On `SIGTERM` or `SIGINT`, stop polling and leasing new rows, allow only the
bounded in-flight send and DB acknowledgement window, and then invoke producer
shutdown within the `systemd` stop deadline. Treat broker-notification failure
during shutdown as best-effort cleanup: never convert it into a successful
publication or extend the service stop indefinitely. A hard stop relies on
persisted lease expiry and must not require manual row repair.

Do not activate the relay merely because unit and local integration tests
pass. Before activation, run a target-Singapore smoke against the exact
private RocketMQ 5.x instance, endpoint, topic, immutable application
artifact, runtime configuration, and database migration. Prove producer
startup, one normal send and validated receipt, Function Compute consumer
delivery, immutable application identity, graceful stop, lease recovery, and
the publish-before-mark crash window without duplicate logical effects. If
the exact client, endpoint, credential-free VPC path, receipt behavior, or
shutdown bound fails, stop and return to issue #208 for a successor decision
rather than changing client, protocol, credentials, topology, or retry
ownership.

### Rationale

A separate service isolates HTTP availability, restart behavior, graceful
shutdown, and queue backpressure without adding compute or another toolchain.
The shared immutable artifact and existing Node runtime minimize deployment
surface while `packages/db` and a narrow publishing port preserve the
accepted database and adapter boundaries.

Pinning Alibaba's tested client reduces provider-compatibility risk. Setting
one SDK attempt makes the broker receipt the adapter's only success boundary
and keeps durable retries observable and recoverable in RDS. Preserving Reflo
identity independently of broker-generated IDs accepts the unavoidable
publish-before-mark crash window and relies on the duplicate-safe semantics
already required by ADR 0012.

## Verification

ADR governance resolves alias `D-GH-208`, the exact decision issue, the owner
verdict comment, and this record PR. Architecture and import-boundary checks
retain ADRs 0003, 0004, and 0012 as active authorities and reject raw database
access outside `packages/db` or RocketMQ SDK imports outside the adapter.

Dependency policy verifies the exact direct package version and lockfile
resolution. Adapter tests freeze `maxAttempts: 1`, normal-message use,
private-endpoint configuration, optional-credential fail-closed behavior,
bounded request timeout, envelope serialization, application ID key/property
mapping, receipt validation, failure normalization, and diagnostic redaction.
Deterministic fakes run the same provider-neutral publishing-port conformance
suite.

PostgreSQL integration tests cover stable bounded claims, `SKIP LOCKED`
competition, lease expiry and stale-owner rejection, acknowledgement only by
the active lease holder, attempt release, deadlines, concurrent replacement
processes, and crash points before send, after send/before mark, and after
mark. Duplicate publications may have different broker IDs but must retain
one Reflo message ID and idempotency key and cause exactly one logical
consumer effect.

Service and packaging tests prove separate API and relay entrypoints and
`systemd` units, least-privilege runtime configuration, startup readiness,
bounded batches and concurrency, backpressure, restart behavior, signal
handling, bounded in-flight drain, best-effort producer shutdown, lease
recovery after hard termination, immutable artifact identity, and no new
compute, public endpoint, NAT, registry, SLS, KMS, secret, or DLQ choice.

The target-Singapore activation smoke records only sanitized endpoint class,
artifact identity, client version, timings, receipt outcome, delivery
outcome, crash-window result, and cleanup result. It publishes no secret,
account identifier, private hostname, raw message, learner data, or provider
diagnostic and makes no production-readiness or exactly-once-execution claim.

## Reversal criteria

Supersede if the exact Node client cannot pass the private Singapore smoke;
the serverless instance requires a credential that lacks separate authority;
the co-located relay causes measured API starvation or cannot stop within its
bound; database leasing cannot prevent unsafe concurrent publication; the
client's receipt or retry behavior cannot preserve ADR 0012 semantics; or a
separately authorized environment requires another topology or runtime. Any
successor must preserve RDS authority, narrow provider adapters, immutable
application identity, duplicate-safe consumer effects, bounded retries and
shutdown, private transport, sanitized diagnostics, and honest activation
evidence.
