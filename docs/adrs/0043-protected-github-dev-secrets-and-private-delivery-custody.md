---
id: "0043"
title: "Protected GitHub dev secrets and private-delivery custody"
status: Accepted
date: "2026-07-28"
aliases: [D-GH-203]
prd_references: "`prds/reflo-prd.md` v2.7 §3 G5, §6 F2 and F7, and §§9–11 and 13; ADR 0005; ADR 0013; ADR 0034; ADR 0042"
ownership:
  proposer: "@deepessh through issue #203"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #199 for the bounded Demo Day dev deployment; owners of separately authorized staging, pilot, production, or successor secret-delivery work for those environments"
authorization:
  decider: "@deepessh, repository owner and named architecture decider for issue #203"
  approval_basis: >-
    The owner approved option 2 because Alibaba KMS Secrets Manager is too
    expensive for the staff-controlled demo, then explicitly approved
    expanding the successor to replace ADR 0013's KMS custody clause only for
    the bounded Demo Day dev secret path while retaining every other private
    delivery control.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/203
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/203#issuecomment-5108142320
  record_pr: https://github.com/deepessh/reflo-learning/pull/204
supersedes: ["0005", "0013"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0043: Protected GitHub dev secrets and private-delivery custody

## Context

Reflo needs reproducible Alibaba Cloud infrastructure and private asset
delivery for the staff-controlled connected Demo Day application. ADR 0005
selected exact-pinned OpenTofu, explicit environment roots, private encrypted
remote state, TableStore locking, GitHub OIDC-to-STS identity, KMS-only runtime
secrets, and evidence-bearing promotion. ADR 0013 selected private OSS delivery
through short-lived, owner-authorized Alibaba CDN URLs and independently
required its signing key to live in KMS Secrets Manager.

The bounded Demo Day dev deployment in issue #199 would therefore need a paid
KMS instance even if ADR 0005 alone changed. The repository owner determined
that cost is disproportionate for this temporary, staff-controlled,
demo-only environment and authorized protected GitHub Environment secrets to
enter OpenTofu as sensitive inputs, accepting that their values persist in
private encrypted state.

This decision replaces ADRs 0005 and 0013 as one complete target so their
retained controls continue to govern without ambiguity. It changes secret
custody only for the Demo Day `dev` environment. It does not authorize cloud
spending or provisioning; select an account, region, hostname, resource class,
or messaging destination; enable staging, pilot, production, public users,
external learner data, or external recipients; weaken private delivery,
owner-scope authorization, parser isolation, or secure product behavior; make
a deferred qualification pass; or make the connected application
production-ready.

## Options

Retain KMS Secrets Manager for every environment; allow protected GitHub
Environment secrets to enter OpenTofu state only for the bounded Demo Day dev
environment; or keep secrets out of state by designing a separate runtime
delivery mechanism.

## Decision

### Authorized verdict

Adopt `protected-dev-secret-custody-v1`.

Use OpenTofu CLI with the official Alibaba Cloud provider as the sole
infrastructure-as-code path, pinning OpenTofu `1.12.0` and
`aliyun/alicloud` `1.283.0` exactly and committing the dependency lock file.
Use one `infra/bootstrap` root and explicit `dev`, `staging`, and `pilot`
roots; do not use OpenTofu workspaces for environment isolation. Store
distinct environment state in private, versioned, encrypted OSS backends with
TableStore locking. Separate environments by state, resource groups and tags,
networks, identities, data stores, buckets, queues, logs, and service
configuration, including separate KMS secret namespaces for staging and pilot.
Pilot has no dependency on a lower environment.

For the bounded Demo Day `dev` environment only, approved runtime secrets,
including the high-entropy Alibaba CDN Type A signing key, originate as
protected GitHub Environment secrets. Only the protected post-merge dev apply
job may read them. It passes them to OpenTofu as explicitly declared sensitive
variables and accepts that plaintext-equivalent values can persist inside
saved plans, provider-managed resource configuration, and private encrypted
remote state. A `sensitive` mark is output redaction, not encryption or
state exclusion, and must never be described otherwise.

The dev state backend and any saved plan are secret-bearing security
boundaries. Permit access only to the repository- and environment-bound GitHub
OIDC deployment role and named break-glass administrators. Runtime roles, the
browser-facing web application, parser workers, Function Compute code,
ordinary contributors, pull-request jobs, and public GitHub artifacts receive
no plan or state access. Each runtime component receives only the exact secret
its approved capability requires; the browser bundle and networkless,
credential-free parser receive none. The browser-facing web application
receives no cloud or database credential.

Do not place secret values in source, committed tfvars, issues, logs, traces,
outputs, plan summaries, evidence, or long-lived CI configuration. Do not
upload raw plans or state as GitHub artifacts. Keep a saved plan only inside
the protected apply boundary on encrypted ephemeral storage, apply that exact
plan under the environment concurrency lock, record only its sanitized digest
and non-secret metadata, and destroy the local plan after the apply attempt.
Treat every remote state version as sensitive even after credentials rotate.
Masking and `sensitive` annotations supplement rather than replace bounded
diagnostics and explicit secret-bearing-field checks.

GitHub Actions exchanges repository- and environment-bound OIDC tokens for
short-lived Alibaba STS credentials; no long-lived Alibaba access key enters
GitHub. Pull-request workflows may validate configuration but cannot receive
the protected environment secrets, read state, create a secret-bearing plan,
or apply. Dev applies only after merge, explicit protected-environment
approval, a fresh exact plan, and the concurrency lock. Changed plans require
reapproval.

Rotate every dev secret after teardown and immediately after suspected
exposure. Rotation creates new high-entropy values, updates only the protected
GitHub Environment and intended runtime configuration, verifies that old
credentials no longer work, and records sanitized completion evidence.
Retained state versions remain protected and are never used as a secret
recovery source for a new environment. The Demo Day dev exception cannot be
promoted, copied, or relabeled as staging, pilot, or production.

Staging and pilot retain KMS Secrets Manager as the sole runtime secret store.
Plaintext payloads for those environments never enter GitHub secrets, tfvars,
plans, state, logs, outputs, issues, or long-lived CI configuration. Staging
requires dev evidence and protected-environment approval. Pilot additionally
requires the exact approved plan digest, staging evidence, every currently
active PRD gate, and named-human approval. Unknown environments, stale
approvals or active gates, unexplained drift, lock failure, and unapproved
spending fail closed.

Retain `private-delivery-v1`. Use separate private OSS buckets per environment
for quarantine and CDN delivery. The quarantine bucket is never
CDN-accessible, and the delivery bucket contains only intentionally
client-deliverable validated source objects and generated assets. Enable Block
Public Access, deny anonymous and direct OSS delivery, and grant Alibaba CDN
only minimum read-only private-origin access. Keep parser artifacts,
unvalidated uploads, state, and internal derivatives outside the delivery
bucket.

Use opaque immutable object keys without names, email addresses, original
filenames, or other direct identifiers. Preserve the canonical layouts
`owners/{owner_scope_id}/sources/{source_document_id}/versions/{version_id}/original.{ext}`
and
`owners/{owner_scope_id}/courses/{course_id}/assets/{asset_id}/generations/{generation_id}/payload.{ext}`.
Keep RDS authoritative for identity, active version, ownership, retention, and
status. The application accepts only an asset or source-document ID, resolves
the canonical key server-side, and applies active-membership and owner-scope
authorization before signing.

Deliver over HTTPS using Alibaba CDN Type A per-object URL signing with the
frozen canonical-path and encoding implementation. The Demo Day dev signing
key follows the protected GitHub/OpenTofu custody exception above; staging and
pilot signing keys remain in KMS Secrets Manager. A signed URL is a bearer
credential with a 15-minute TTL, minted only at playback or download time.
Revocation stops new signing immediately, while an already issued URL can
remain usable until expiry. Enable byte-range delivery; clients reauthorize,
refresh an expired URL, and resume at the last byte or time offset.

Never store signed URLs in local storage or service-worker caches. Prohibit
full signed URLs and signing parameters from application logs, traces,
analytics, and support diagnostics; minimize or redact provider logs before
downstream ingestion. Immutable canonical paths may use independently
configured long-lived POP caching only after CDN authentication succeeds,
signing parameters never enter the canonical cache key, and client-facing
cache behavior prevents durable unauthorized persistence without breaking
media playback.

Deletion first tombstones the resource in RDS, then deletes the OSS object,
submits a forced purge for the unsigned canonical CDN URL, and polls purge
status. Deletion is incomplete until OSS absence and CDN purge completion are
verified within the applicable product deadline, including the 24-hour
active/derived-store limit when that retained pilot contract applies. Planned
signing-key rotation uses primary/secondary overlap; suspected compromise
replaces every accepted key immediately so outstanding URLs fail
authentication.

ECS byte proxying remains rejected as the default because of application
bandwidth, latency, and scaling risk. Signed cookies remain rejected because
their broader path grants weaken per-object auditability. CDN remote
authentication remains rejected for pilot because it adds a public
application dependency and authorization round trip to every request,
including byte ranges; adopting it requires a later successor that fails
closed.

Every apply records sanitized immutable version, actor, approval, change,
migration, smoke, drift, rollback, and plan-digest evidence. Completion
requires a no-op post-apply plan. Application rollback selects a known-good
immutable artifact; infrastructure recovery uses reviewed roll-forward or a
new reviewed rollback plan. Recovery documentation covers bootstrap migration,
state restore, force-unlock, secret rotation, failed applies, application
rollback, and infrastructure roll-forward. Neither this record nor any plan
authorizes spending. Application deployables and dbmate migrations retain
their existing artifact and schema boundaries. OpenTofu provides workflow
portability only: a provider switch still requires provider-specific modules,
state and data migration, testing, and any required product-authority change.

### Rationale

The accepted state exposure is proportionate only because the exception is
limited to a temporary staff-controlled dev environment with no public users,
external learner data, pilot activation, or production claim. Protected
environment approval, short-lived deployment identity, narrowly restricted
state custody, non-publication, rotation, and teardown sharply bound the
additional risk. KMS remains the target for staging and pilot, where the
environment lifetime, data sensitivity, and operational exposure are greater.

Keeping ADR 0013's private-origin, owner-scope, short-lived capability,
redaction, range, rotation, and deletion controls prevents a secret-custody
change from weakening asset authorization. Retaining the exact OpenTofu,
environment, identity, promotion, drift, and recovery controls prevents the
cost exception from becoming a manual-provisioning or long-lived-credential
exception. A new secret-delivery mechanism would keep values out of state but
adds design and implementation work that the bounded demo does not justify.

## Verification

ADR validation proves ADRs 0005 and 0013 are superseded by this record, links
both lifecycle transitions bidirectionally, validates the exact owner verdict
and record PR, and allocates canonical ID 0043 in merge order. The architecture
view contains this record as the active infrastructure and private-delivery
target without representing it as deployed.

Repository policy rejects committed state, plans, tfvars, crash logs, unpinned
core or provider versions, non-bootstrap local backends, and workspace-based
environment selection. Workflow and fixture tests prove pull-request jobs
cannot read the dev GitHub Environment, state, or secret-bearing plans; only
the exact protected post-merge dev apply job can obtain the environment's
secrets and OIDC identity; plan and apply concurrency is enforced; and raw
plans and state cannot become artifacts or unbounded logs.

IAM and backend tests prove only the repository/environment-bound deployment
role and named break-glass administrators can read dev state, while runtime
roles, parser workers, Function Compute code, ordinary contributors, and
cross-environment identities cannot. Composition checks prove the
browser-facing web application and parser receive no credentials, each
authorized runtime receives only its required secret, and dev has no KMS
Secrets Manager dependency solely for runtime or CDN signing secrets. Staging
and pilot checks continue to require KMS-backed custody and reject GitHub
secret payloads in their plans or state.

Private-delivery tests prove direct and anonymous OSS denial, delivery-only
origin access, server-only key resolution, owner-scope and revoked-membership
denial, canonical URL signing, tampering and expiry rejection, unsigned
cache-hit denial, range playback across expiry, signed-URL redaction and
non-persistence, planned and emergency key rotation, immutable-version
behavior, OSS deletion, and forced CDN purge completion. Configuration fails
closed on public access, overbroad origin permission, missing signing or range
controls, signing parameters in cache keys, unredacted bearer URLs, or deletion
completion without verified purge.

A sanitized teardown rehearsal rotates every dev secret, proves old
credentials fail, preserves protected state recovery, and records no secret,
raw plan, state, private hostname, messaging destination, learner data, or
other sensitive value. Deployment and smoke evidence remains bounded
operational evidence under ADR 0042 and never becomes formal qualification,
production-readiness, pilot, or spending authority.

## Reversal criteria

Supersede if the environment accepts public or external use; real learner data
or external recipients enter scope; the dev exception is needed beyond the
bounded Demo Day lifecycle; GitHub Environment protection, OIDC binding,
state-access isolation, redaction, rotation, or teardown cannot be proved; a
secret reaches an unauthorized runtime or artifact; or a separate
state-excluding delivery mechanism materially reduces risk without blocking
delivery. Any successor must preserve exact-pinned reproducible
infrastructure, environment isolation, short-lived CI identity, private state,
locked and reviewed applies, least privilege, private owner-authorized asset
delivery, bounded bearer URLs, deletion and rotation, honest evidence, and
human spending authority.
