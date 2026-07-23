---
id: "0031"
title: "Versioned privacy lifecycle and deletion control plane"
status: Accepted
date: "2026-07-23"
aliases: [D-GH-18]
prd_references: "`prds/reflo-prd.md` §6 F7, §9, §10, §11, and §13; ADR 0006; ADR 0007; ADR 0012; ADR 0013; ADR 0015"
ownership:
  proposer: "@deepessh through issue #18"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of separately claimed consent, deletion, authenticated-export, telemetry, provider-adapter, and pilot-activation implementation issues"
authorization:
  decider: "@deepessh, repository owner and named human decider for issue #18"
  approval_basis: >-
    ** I reviewed the condensed privacy-lifecycle-v1 proposal in
    https://github.com/deepessh/reflo-learning/issues/18#issuecomment-5064087274,
    including its seven explicit confirmation items, PRD privacy outcomes,
    retention periods, implementation consequences, human acceptance boundary,
    and reversal criteria. I approve that proposal as written.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/18
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/18#issuecomment-5064210480
  record_pr: https://github.com/deepessh/reflo-learning/pull/150
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0031: Versioned privacy lifecycle and deletion control plane

## Context

Pilot activation requires versioned informed consent, deletion across every
named active and derived store, an authenticated manual export path, and
PII-minimized telemetry. The PRD requires active and derived deletion within
24 hours, encrypted-backup expiry within 30 days, progress visibility during
retries, and a terminal receipt that cannot link back to the deleted learner.
It also requires manual export fulfillment within seven days and verified
provider retention, deletion, and training settings.

These outcomes cross independently owned RDS, vector, object, queue, delivery,
provider, evaluation, analysis, backup, and telemetry systems. This decision
controls their shared consent, retention, deletion, export, and redaction
policy and the narrow authorization needed to execute deletion after normal
membership is revoked. It does not move domain-store ownership into one
service, approve a paid provider, waive any pilot gate, or make an
accepted-but-unimplemented target shipped behavior.

## Options

A centralized versioned policy and deletion control plane with domain-owned
handlers; independent per-service policies; or pilot-only manual handling.
Per-service policy cannot prove complete lifecycle coverage, while manual
handling does not satisfy the PRD's self-serve deletion and tracked export
requirements.

## Decision

### Authorized verdict

Adopt `privacy-lifecycle-v1`: a versioned privacy policy and
RDS-authoritative control plane for consent, retention, deletion, export, and
telemetry redaction. Domain stores and provider adapters keep their existing
ownership but must implement the registered policy. Queues, caches, traces,
providers, evaluation data, and exports are inside the lifecycle.

The following reviewed boundaries are explicit:

- The first learning-data or pilot withdrawal action is a reversible
  `withdrawal_requested` state that immediately pauses the affected purpose.
  The confirmed deletion-starting withdrawal is irreversible.
- The API enforces trusted-origin and CSRF under ADR 0006. Database procedures
  independently verify the persisted session digest, recent-auth time, pending
  intent, consent revision, and idempotency binding; bearer and CSRF secrets
  never enter RDS.
- Each deletion makes every earlier backup non-promotable. A verified
  post-deletion recovery point must exist before terminal success. This
  intentionally reduces usable recovery history to the newest verified
  post-deletion point. Failure to create it keeps deletion visibly incomplete
  and blocks pilot activation without delaying the 24-hour active/derived
  erasure deadline.
- Every export request records `requested_at` and `fulfill_by`. Overdue work
  remains visible, alerts the owner, and continues through retry or remediation
  until `ready` or cancelled by deletion. `failed` is not fulfillment.
- A deletion intent expires no later than the 15-minute recent-auth window.
  Expired, abandoned, and superseded intent and capability material is erased.
- Pilot activation requires checked evidence that provider training and shared
  data reuse are disabled.
- A non-linkable receipt expires and is erased one year after deletion
  completion; retrieval fails after expiry.

#### Consent and withdrawal

Record consent as append-only immutable events, separate from learning events.
Each grant binds the learner, purpose, policy and notice versions, rendered
notice digest, affirmative action, time, locale, and collection surface. Never
infer consent from silence, account creation, or another purpose.

Maintain a monotonic revision for each `(learner, purpose)`. A command
compare-and-sets the expected revision and atomically commits the event,
current state, idempotency intent, and outcome. Exact retries return the stored
outcome; changed payloads or stale revisions fail. State changes are never
automatically retried. Re-consent requires a new affirmative action against
the current notice and revision.

Use separately revocable grants for pilot participation, learning-data
processing, Telegram, email, randomized re-teach assignment, pilot analysis,
and Demo Day aggregate reporting. Material notice changes require re-consent.
WhatsApp and other P1 purposes remain unavailable until their independent
gates pass.

A checked-in `privacy-action-policy-v1` registry defines the exact grant
conjunction for every product action. Every request, job, send, provider
submission, experiment assignment, and analysis inclusion rechecks current
consent and account state at point of use. Queue snapshots are not authority;
unknown actions and missing grants deny. Privacy controls remain available
without product-purpose consent and cannot bypass product-action checks.

Channel opt-out immediately stops sends and removes linked provider state
within 24 hours. Experiment or analysis withdrawal stops new inclusion and
removes identifiable working data within 24 hours. Demo Day withdrawal
excludes unpublished reporting and recomputes affected unpublished aggregates.
Previously published aggregates may remain only if irreversibly anonymized and
permitted by the recorded consent.

Learning-data or pilot withdrawal uses the same disclosure, recent-auth, and
two-step confirmation as account deletion. `withdrawal_requested` immediately
pauses the purpose but is reversible through a new affirmative grant until
deletion is confirmed. Confirmation atomically records
`withdrawal_confirmed`, starts deletion, and becomes irreversible. Re-consent
records `withdrawal_cancelled_by_reconsent` and invalidates older destructive
intents.

Before activation, the UI reproduces the exact current notice covering
collection, channels, experiments, analysis, Demo Day reporting, retention,
withdrawal, and deletion consequences.

#### Retention

Maintain a checked-in `retention-policy-v1` registry. Every data class and
external submission declares its purpose, owner, store or provider, maximum
retention, deletion or crypto-shredding action, verification method, and
backup treatment. Unknown stores and data classes fail closed before pilots.

Maximum retention is:

- product and learning records: while the account and applicable purpose
  remain active; deletion or withdrawal overrides normal retention;
- identifiable pilot-analysis and evaluation extracts: seven days after the
  August 15 analysis cut, or within 24 hours of earlier withdrawal or deletion;
- raw operational logs and traces: 30 days;
- queue, inbox, outbox, operation-attempt, and sanitized DLQ evidence: the
  proven replay, redrive, and reconciliation window, never more than 30 days
  once finalized;
- unresolved deletion control evidence: until resolved, limited to the
  association needed for retry and visible failure;
- provider payloads and logs: the shortest supported period, never more than
  30 days, with verified subject deletion within 24 hours;
- export artifacts: seven days after becoming ready;
- completed non-linkable deletion receipts: one year from completion;
- encrypted backups: 30 days; and
- abuse-control origin digests: 24 hours.

Only consent-permitted irreversibly anonymized aggregates may outlive subject
deletion. ADR 0015 release-gate fixtures remain rights-cleared and free of
learner PII.

Create and verify a post-deletion encrypted recovery point before terminal
success. Mark every earlier backup non-promotable and let it expire within 30
days. Restores remain quarantined until backup generation and deletion
coverage are verified; a pre-cutoff backup can never serve traffic.

#### Deletion flow and receipt

Deletion follows six stages:

1. **Prepare.** After authentication no older than 15 minutes, the API enforces
   origin and CSRF and displays the complete F7 disclosure: covered stores,
   24-hour active and derived deletion, 30-day backup expiry, the anonymized
   aggregate exception, visible retry and failure status, temporary minimum
   contact retention, and the exact receipt fields.
2. **Create intent.** A narrow database procedure derives actor and scope from
   the persisted session digest and binds a single-use intent to the session,
   recent-auth time, disclosure digest, action, applicable consent revision,
   and idempotency key. It expires within 15 minutes. The future random receipt
   ID is shown once as a recovery code and installed as a path-scoped
   `Secure`, `HttpOnly`, `SameSite=Strict` status cookie.
3. **Confirm.** One transaction sets `deletion_pending`, retires the personal
   scope, revokes memberships and sessions, tombstones retrievable content,
   stops new message, model, and signing work, cancels exports and generation,
   creates the deletion operation, and emits its ADR 0012 command. Replayed,
   stale, altered, cross-account, and superseded intents fail.
4. **Erase and verify.** Registered idempotent handlers cover RDS, every vector
   generation, OSS and CDN, caches, queues and DLQs, inbox and outbox, logs and
   traces, providers, delivery systems, evaluation and analysis exports, and
   backup controls. Dispatch is not success; each handler reports sanitized
   verified outcomes inside the 24-hour deadline.
5. **Remediate.** Handler generations follow ADR 0012
   first-terminal-state-wins. A permanent handler failure moves the overall
   request, not the learner account, to visible `needs_remediation`. An
   audited, causally linked generation can retry after correction. The overall
   request never ages into success or unrecoverable terminal failure.
6. **Finalize.** Success requires every registered store verified, every
   subject-bound transport and provider effect quiescent, and a verified
   post-deletion recovery point. A deletion-specific terminal transaction
   removes subject-linked control and transport rows and writes the receipt as
   the sole output; no scoped completion event survives.

While work is active or failed, the status capability exposes only sanitized
per-store progress and remediation guidance. A saved recovery code can rotate
the cookie. Optional email recovery is permitted only before provider cleanup
starts and creates a cleanup obligation inside the original 24-hour deadline;
afterward, only the recovery code works.

Protect the future receipt ID during processing with a per-operation DEK,
KMS-wrapped under a versioned KEK, and AEAD-bound to the environment,
operation, intent, and key versions. Plaintext capability material never
enters persistent state, logs, traces, or queues. Referenced keys cannot be
retired while a deletion is unresolved.

On success, destroy every subject-to-operation and subject-to-receipt lookup.
The receipt contains only an opaque random receipt ID, request and completion
timing, per-store outcome categories and counts, and a deterministic
backup-expiry date no later than 30 days after request. It contains no user,
contact, scope, provider, content, pseudonym, correlation, operation, or policy
identifier.

#### Deletion authorization

Normal API and jobs roles lose access after membership revocation and are
never table owners, superusers, or `BYPASSRLS`. Forced RLS remains enabled. A
minimal deletion control table breaks the post-revocation bootstrap cycle and
is reachable only through versioned, fixed-`search_path`, fully qualified
`SECURITY DEFINER` procedures with `PUBLIC` execute revoked.

Separate no-login, non-inheriting roles own initiation, status and recovery,
and deletion procedures. Role-specific RLS policies and column grants allow
only the current operation, lease, subject and scope, handler, and action.
Runtime roles cannot `SET ROLE`; caller-set context and arbitrary identifiers
grant nothing.

The API enforces origin and CSRF. Initiation procedures independently validate
the persisted session digest, active account, recent-auth timestamp, pending
intent, expected consent revision, and idempotency binding. Deletion transport
procedures provide only the bounded ADR 0012 outbox, inbox, lease, attempt,
retry, and remediation mutations needed after scope retirement. External
adapters receive server-resolved opaque targets and least-privilege deletion
credentials.

#### Authenticated export

Export is a privacy-control right and does not require an active
product-purpose grant. Request and download require ADR 0006 recent-auth and
ADR 0007 owner-scope authorization.

Persist `requested`, `in_progress`, `ready`, `failed`, `expired`, or
`cancelled`, plus `requested_at`, `fulfill_by`, retry and remediation state,
and owner-alert status. Fulfillment means `ready` within seven days; `failed`
remains visible and actionable. Deletion cancels the request.

A server-resolved, operation-bound job exports allowlisted learner-owned
account, consent, source and upload, generated artifact, session, delivery,
attempt, evidence, knowledge, review, and provenance records. It excludes
other learners, secrets and digests, security controls, prompts, provider
diagnostics, signing material, and unauthorized data. Operators cannot supply
a target or inspect content.

The archive contains a manifest and machine-readable JSON. Paths are normalized
and reject traversal, links, devices, and special files. Entry counts and sizes
are bounded; each entry and the committed archive have verified cryptographic
checksums.

Store exports in a dedicated private, environment-isolated, KMS-encrypted
bucket, not the ADR 0013 CDN bucket. The worker has bound write and
reconciliation access but no content-read or decrypt access; only the
authenticated download service may read and decrypt. Downloads stream through
the API over TLS; never issue a CDN or OSS bearer URL or email the archive.

Bind every multipart operation to an immutable generation fence. Recheck the
fence and deletion state before each part, completion, and final RDS `ready`
compare-and-set. Persist upload, part, and object identities and reconcile
ambiguous results. Deletion cannot succeed until uploads are aborted and late
object versions are verified absent. Encrypted scratch is bounded, registered,
and erased after success, failure, cancellation, crash recovery, expiry, or
deletion.

#### Telemetry and provider privacy

Keep authoritative product and learning events out of operational traces.
Telemetry uses versioned deny-by-default schemas with bounded operational
fields only. Any correlation, message, operation, causation, or purpose
pseudonym that can join to a learner has a purpose, TTL, and deletion index.
Treat all learner and request-path identifiers as correlatable unless a
separate system schema proves they never touched learner or request data.

Prohibit contact data, raw IP, precise location, user agent, filenames,
titles, passages, answers, prompts, results, generated content, provider
payloads and raw diagnostics, learner or request URLs and query strings,
tokens, cookies, secrets, and unbounded bodies from telemetry, issues, and
queue or DLQ diagnostics. Controlled ADR 0015 non-learner evaluation evidence
is not telemetry.

Enforce redaction before every sink and again at provider adapters. Before
pilots, verify provider retention and deletion settings and prove training and
shared-data reuse are disabled.

#### Human acceptance boundary

Approval accepts these policy choices while implementation evidence remains a
separate pilot gate: provider-side subject deletion within 24 hours; one-year
retention of the non-linkable receipt; no more than 30 days of raw operational
telemetry; the backup recovery-history and RPO reduction described above; a
verified post-deletion recovery point before terminal success; and capacity to
fulfill low-volume manual exports through the API within seven days.

### Rationale

A single policy and control plane makes lifecycle coverage testable without
moving every store into one service. Purpose-specific consent prevents one
opt-in from authorizing unrelated messaging, experiments, or analysis.
Tombstone-first verified deletion composes with existing authorization, queue,
storage, evaluation, and authentication decisions. Deny-by-default telemetry
and bounded retention reduce the data deletion must find.

## Verification

Before pilot activation, contract and integration tests prove:

- consent event immutability, revision, compare-and-set, and idempotency
  behavior; every action-purpose conjunction; material re-consent; withdrawal
  effects; exact notice reproduction; and privacy-control access;
- complete store inventory; 24-hour deletion coverage; visible remediation;
  non-resurrection; status recovery; intent expiry and cleanup; key tamper and
  rotation behavior; forced-RLS role isolation; deletion-specific ADR 0012
  transport; verified backup cutoff; exact receipt fields; unlinkability; and
  one-year receipt erasure;
- export allowlist and exclusions; the seven-day request-to-`ready` deadline
  and breach visibility; safe archive paths, limits, and checksums; least
  privilege; multipart race fencing; deletion cleanup; bucket isolation;
  encryption; TLS-only delivery; and seven-day artifact expiry; and
- telemetry field rejection, deletion indexing, provider retention and
  deletion, and disabled provider training and data reuse.

Any unregistered store, provider, or sink; missed deadline; unresolved required
handler; unverifiable backup or export state; or privacy-control authorization
bypass fails closed. The verdict alone is not pilot evidence.

## Reversal criteria

Supersede if the control plane becomes a measured bottleneck, the backup
contract cannot provide safe recovery, a required provider cannot meet
retention, deletion, or training controls, or the retention periods prevent
required evaluation or incident response. A successor must preserve explicit
purpose consent, point-of-use checks, privacy-control access, visible deletion
progress, 24-hour active and derived erasure, 30-day backup expiry,
non-linkable receipts, authenticated export, telemetry minimization, and
non-resurrection.
