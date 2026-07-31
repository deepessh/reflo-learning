---
id: "0047"
title: "Operator-hosted connected Demo Day runtime"
status: Accepted
date: "2026-07-31"
aliases: [D-GH-214]
prd_references: "`prds/reflo-prd.md` v2.7 §3 G5, §6 F1–F7, §8 Flows A–B, and §§9–13; ADR 0034; ADR 0042; ADR 0043; ADR 0044"
ownership:
  proposer: "@deepessh through issue #214"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of a separately triaged W3 implementation and rehearsal issue; owner of issue #213 for Alibaba resource disposition"
authorization:
  decider: "@deepessh, repository owner and founding-team product and architecture authority"
  approval_basis: >-
    The owner explicitly instructed Codex in the active task to pick this issue
    and stated, ‘I approve the ADR.’
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/214
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/214#issuecomment-5148131096
  record_pr: https://github.com/deepessh/reflo-learning/pull/215
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0047: Operator-hosted connected Demo Day runtime

## Context

Reflo needs one reliable connected application for Demo Day. PRD v2.7 and ADR
0034 require the live seeded adaptive loop, a separate staff-controlled PDF
upload, online dependency preflight, honest unavailable states, resettable demo
data, rights-cleared sources, and staff-only identities and delivery
destinations. They prohibit an offline bundle, a local product identity,
fabricated live behavior, public signup or uploads, external learner data or
messages, and production or pilot claims.

Issue #199 attempted the bounded Alibaba Cloud deployment. Alibaba rejected
OSS activation after six bootstrap resources had been created, so no remote
state migration, application apply, artifact publication, parser proof, or
application deployment completed. Issue #213 owns the protected inventory and
eventual disposition of that partial state. Resuming or destroying cloud
resources still needs the exact plans and human approvals recorded there.

The repository already contains a connected local execution path: the fixed
`reflo-local` Compose project builds and runs the independently packaged web,
API, and jobs applications; uses digest-pinned PostgreSQL and pgvector stores;
applies schemas through a bounded setup job; gives the API a DML-only database
role; stores connected artifacts in a named local volume; and binds host ports
to loopback. The connected application uses real repositories, the typed model
router, a resettable synthetic weak-concept seed, owner-scoped authorization,
dependency preflight, the browser Flow B surface, and the PDF-only approved
source boundary. The local ingestion smoke uses an exact-allowlisted rootless
Podman client and a fresh networkless worker with the retained parser, scanner,
resource, provenance, and cleanup contracts.

Issues #112, #162, and #165 deliberately labeled these capabilities as
development execution rather than the Demo Day deployment target. Promoting
them is an independently reversible topology and operational decision. It
does not permit an offline product, relax secure behavior, establish release
qualification, or decide how the Alibaba resources are disposed.

## Options

Keep Alibaba as the only authorized Demo Day path and wait for OSS activation;
authorize the existing local Compose profile as the primary operator-hosted
connected Demo Day runtime; authorize another cloud provider after new
provider, migration, and spending decisions; or use a recorded-only demo that
cannot satisfy the live Flow B and upload proof.

## Decision

### Authorized verdict

Adopt `operator-hosted-connected-demo-v1` for Demo Day through August 15.

Use the existing fixed `reflo-local` Compose `apps` profile as the primary
application runtime. Keep the independently packaged web, API, and jobs
services, the bounded setup job, the separate digest-pinned PostgreSQL and
pgvector services, the DML-only API role, the named artifact volume, bounded
health checks, and scoped `up`, `status`, `logs`, `down`, and `reset` commands.
The deployment remains `REFLO_ENV=dev` and is described as a staff-controlled,
operator-hosted connected demo, never as production, pilot, or cloud
deployment.

Bind web, API, jobs, database, and vector ports to loopback by default. A
presentation network, reverse proxy, tunnel, public hostname, or non-loopback
bind requires a separate human-approved implementation boundary before use.
This record authorizes none of them. Do not enable public signup, public or
external uploads, external learner identities or data, external delivery
recipients, WhatsApp, staging, pilot, or production.

Preserve ADR 0034 without qualification. The seeded initial course, synthetic
weak state, and staff identity are fixtures and are labeled as such. The
adaptive study interaction uses the connected application, real PostgreSQL
repositories, owner-scope checks, typed model routing, and persisted evidence.
The model gateway and any enabled delivery or tracing adapters remain online
dependencies. Preflight reports application, PostgreSQL, vector, model,
storage, and delivery state with bounded sanitized diagnostics. An unavailable
dependency produces an explicit failure state and never a seeded, cached,
recorded, or pre-generated result presented as live.

Keep runtime configuration only in the ignored mode-0600 local configuration
boundary generated below `.reflo/local-stack/`. Images and tracked files
contain no environment files, provider credentials, contact addresses, link
tokens, generated private assets, or database contents. The browser receives
no model, database, delivery, or storage credential. Logs, traces, issue
comments, rehearsal evidence, and demo artifacts contain no secret, token,
contact address, signed URL, private learner data, or unbounded provider
payload. Configure only human-approved providers and dedicated staff-controlled
test destinations; this record authorizes no paid capacity or spending.

Use `local-filesystem-v1` as the Demo Day object-store adapter. Store source and
generated artifacts under opaque owner-scoped identifiers in the named local
artifact volume. The API remains authoritative for membership, ownership,
active version, status, and asset access; the browser never receives a host
filesystem path. Authorized playback and download go through the existing
owner-scoped application route. Reset and teardown remove only the fixed Reflo
Compose project and its named resources. Operators back up no demo volume and
do not copy it into cloud, staging, pilot, or production.

Use the existing local isolated-ingestion path for the separate approved PDF
demonstration. The trusted API/supervisor reauthorizes owner scope and launches
a fresh, non-root, networkless Podman worker with no ambient credential or
trusted service endpoint and only job-scoped read-only input/scanner mounts and
bounded writable scratch/output mounts. Accept only the exact local development
Podman versions already enforced by the repository: `5.8.3` for Darwin AMD64
compatibility or `6.0.1`. Retain the exact Java 25, Apache Tika 3.3.1, ClamAV
1.4.5 LTS, Tesseract 5.5.2, upstream-signed scanner snapshot, PDF admission,
malware/type/encryption/page/size/resource controls, normalized output,
provenance, fail-closed errors, idempotency, and terminal cleanup contracts.
The scanner snapshot must be independently admitted and less than 24 hours old.
No worker may use the Compose network, Docker socket, host credentials, model
gateway, database, vector store, artifact volume, delivery service, cloud
metadata, or general host filesystem.

The local worker is a bounded Demo Day isolation target, not the Alibaba
Function Compute target and not production qualification. The separately
triaged implementation issue must prove the actual Demo Day host's non-root,
network, credential, mount, cross-job, resource, stale-scanner, output,
cleanup, and exact-artifact outcomes before the upload rehearsal is accepted.
A missing prerequisite or failed denial check makes upload unavailable; it
does not authorize an in-process parser or broader worker access.

Before Demo Day, the separately triaged implementation and rehearsal work must
prove one-command startup and bounded readiness; authenticated browser access;
the seeded connected Flow B in at most six minutes; the separate rights-cleared
standard-profile PDF upload with exact observed elapsed time; source-backed
artifacts; authorized private asset playback; one dedicated staff-only delivery
path; explicit dependency failure and recovery; clean shutdown; and scoped
reset. Run at least ten consecutive connected Flow B rehearsals and report the
run count, failures, and fixes. Do not describe any local smoke or rehearsal as
p95, capacity, release-gate, security-qualification, production-readiness,
pilot, retention, causal-learning, or certification evidence. ADR 0042 keeps
formal qualification deferred.

ADRs 0043 and 0044 remain accepted only for the suspended Alibaba deployment
path and any protected recovery or resumption authorized through issue #213.
Their Alibaba OpenTofu, OSS/CDN, GitHub Environment secret, and Function
Compute controls do not apply to `operator-hosted-connected-demo-v1`, are not
silently reinterpreted as local controls, and are not proof that the cloud
application was deployed. This record does not supersede them because issue
#213 must retain their exact authority while partial Alibaba state exists. It
authorizes no cloud inventory, plan, apply, destroy, state migration, resource,
credential rotation, or spending action.

### Rationale

The local runtime reuses the application, database, model-routing, ingestion,
and lifecycle boundaries already implemented and exercised by repository work.
It removes the blocked OSS activation from the critical Demo Day path without
adding another provider, migration, public endpoint, offline identity, or
recorded-only substitute. Loopback exposure, ignored runtime configuration,
fixed-project lifecycle commands, an external networkless parser, and
staff-controlled inputs keep the temporary operator-hosted boundary narrow.

Keeping the Alibaba decisions effective only for #213 avoids abandoning or
misrepresenting partially created resources and prevents a local-demo choice
from authorizing cloud teardown. Requiring host-specific denial proofs and
honest evidence labels recognizes that a successful development smoke is
useful Demo Day evidence but not environment or production qualification.

## Verification

ADR validation resolves `D-GH-214` to this record, verifies the exact issue,
owner verdict, and record PR, and keeps ADRs 0043 and 0044 active without
semantic overlap: they govern only Alibaba recovery or resumption through
#213, while this record governs the primary operator-hosted Demo Day runtime.
Architecture validation lists this decided target without treating it as
deployment or rehearsal proof.

Repository policy continues to prove exact image and toolchain pins,
default-deny build contexts, absence of secret-shaped runtime artifacts,
loopback-only Compose ports, bounded health checks and setup, a DML-only API
role, fixed-project lifecycle commands, owner-scoped storage routes, strict
environment admission, and development-only adapter rejection outside dev.
Contract and integration tests cover connected dependency preflight,
cross-scope denial, seed/reset replay, assessment and Tutor Agent evidence,
Flow B summary and Knowledge Map refresh, PDF-only admission, local object
storage, delivery replay safety, and clean shutdown.

The implementation issue records only sanitized host and artifact identities,
readiness results, observed upload and Flow B timings, denial-test outcomes,
rehearsal counts, failures, fixes, recovery, shutdown, and reset. It records no
runtime configuration, credentials, contact details, private paths, raw logs,
learner data, or generated private content. Any missing or failed dependency,
worker denial, owner-scope, artifact, delivery, cleanup, or replay check blocks
the affected demonstration and remains visible.

Issue #213 separately records sanitized Alibaba inventory and exact-plan
approval, recovery, resumption, teardown, rotation, and no-orphan/no-charge
evidence. This ADR and its implementation evidence never satisfy that issue.

## Reversal criteria

Supersede before exposing the runtime beyond loopback or an independently
approved private presentation network; accepting public users, external
uploads, learner data, or external recipients; using it after Demo Day;
changing the local storage, secret, network, parser-isolation, identity, or
delivery boundary; presenting pre-generated behavior as live; activating
staging, pilot, or production; or replacing it with a cloud provider. A
successor must preserve ADR 0034, owner-scope authorization, credential-free
untrusted parsing, exact artifacts, bounded resources and diagnostics,
replay-safe evidence, cleanup, staff-only data and delivery, honest labeling,
human spending authority, and separate disposition of any retained Alibaba
resources.
