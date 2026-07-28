---
id: "0044"
title: "Serverless isolated-ingestion task for Demo Day dev"
status: Accepted
date: "2026-07-28"
aliases: [D-GH-206]
prd_references: "`prds/reflo-prd.md` v2.7 §3 G1 and G5, §6 F1, §8 Flow A, and §§9–13; ADR 0008; ADR 0012; ADR 0020; ADR 0035; ADR 0042; ADR 0043"
ownership:
  proposer: "@deepessh through issue #206"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #199 for the bounded Demo Day dev deployment; owners of separately authorized staging, pilot, production, or successor ingestion work for those environments"
authorization:
  decider: "@deepessh, repository owner and named product and architecture decider for issue #206"
  approval_basis: >-
    The owner reviewed the provider-verified Function Compute
    SESSION_EXCLUSIVE design and approved it because it preserves the retained
    parser isolation and product limits without a dedicated ECS host, Alibaba
    Container Registry, or SLS.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/206
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/206#issuecomment-5110720035
  record_pr: https://github.com/deepessh/reflo-learning/pull/207
supersedes: ["0008"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0044: Serverless isolated-ingestion task for Demo Day dev

## Context

Reflo must scan and parse staff-controlled PDF uploads without allowing
parser-controlled code to obtain network access, ambient credentials, or
authority over OSS, RocketMQ, RDS, AnalyticDB, cloud metadata, or another job.
The product supports digitally generated PDFs up to 50 MB and 800 pages. The
standard path remains at most 20 MB and 200 pages; the larger path is
asynchronous and carries no standard-path latency target.

ADR 0008 selected a trusted supervisor on a dedicated ECS parser pool that
launched a fresh networkless rootless-Podman worker. Issue #199 is the bounded
staff-controlled Alibaba Cloud Demo Day dev deployment. Its initially approved
bill of materials assigned one continuously billable `ecs.g7.large` instance
to that parser pool even though uploads are intermittent, the pool
command/result protocol has not been implemented, and Alibaba Container
Registry and SLS are explicitly excluded.

Function Compute can supply the required CPU, memory, temporary disk, and wall
time on demand, but an ordinary OSS-triggered function would give
parser-controlled code cloud identity and storage/network authority. One
direct synchronous or asynchronous invocation is also too small for the
retained 50 MB input and 512 MiB normalized-output ceilings. Current Function
Compute session isolation instead dedicates one instance and filesystem to a
session across multiple authenticated synchronous calls. The owner therefore
authorized `SESSION_EXCLUSIVE` isolation and bounded chunk transfer between
the trusted API/orchestrator and a no-role parser runtime.

This record replaces ADR 0008 as one complete target so its retained parser,
scanner, OCR, normalization, resource, failure, and verification controls stay
unambiguous. The hosting and transport change applies only to the bounded Demo
Day `dev` environment in issue #199. It does not authorize a cloud plan,
apply, resource creation, spending, hostname, external message, public upload,
external learner or learner data, staging, pilot, production, formal
qualification pass, or production-readiness claim.

## Options

Keep the dedicated ECS supervisor and rootless-Podman worker; run one ordinary
Function Compute handler with an OSS role; expose a public streaming trigger;
or use a no-role Function Compute custom runtime with session-exclusive
isolation and authenticated synchronous chunks.

## Decision

### Authorized verdict

Adopt `serverless-isolated-ingestion-v1` for issue #199's bounded Demo Day
`dev` environment.

The trusted API/orchestrator remains the connected authority. It consumes the
durable ingestion command, reauthorizes current owner scope and retention
state, reads the exact quarantined OSS object, verifies its recorded hash, and
uses the Function Compute session APIs under a least-privilege action set for
the exact parser function. It creates one unique session, serially invokes the
function to upload the source, triggers parsing, serially downloads the
result, validates and atomically finalizes it through ADR 0012, and calls
`DeleteSession` on every terminal path. The browser receives no function
endpoint or invocation credential. No HTTP, public, anonymous, OSS,
EventBridge, or direct RocketMQ trigger is permitted.

Configure Function Compute `SESSION_EXCLUSIVE` isolation with header-field
affinity, one concurrent request per session instance, serialized client
calls, a bounded idle timeout and TTL, and session-ID reuse disabled. One
session maps to one ingestion operation and one dedicated function instance
and temporary filesystem. The session ID is an opaque transport identifier,
never owner authorization, and is redacted from logs and traces. Expiry and
instance destruction are cleanup backstops; the trusted orchestrator still
calls `DeleteSession` explicitly.

Use binary chunks of at most 8 MiB with monotonic sequence numbers, total
lengths, content hashes, a versioned envelope, and the registered
operation/idempotency identity. The trusted side uploads at most the PRD's
50 MB PDF input. The function rejects missing, duplicate, out-of-order,
oversized, mismatched, expired, cross-session, or replayed input before
parsing. It stores normalized output only in the session-private temporary
filesystem, exposes it through bounded 8 MiB download chunks, and never
accepts more than the existing 512 MiB normalized-output ceiling. The trusted
side validates the complete schema, size, hashes, locators, provenance, and
allowlisted diagnostics before finalization. A disconnected or ambiguous call
reconciles by the original operation and input hash; it does not create a
second logical parse.

Provision one Function Compute `custom.debian11` runtime in Singapore with
2 vCPU, 4 GiB memory, 10 GiB temporary disk, concurrency one, a 1,800-second
function timeout, zero minimum or provisioned instances, and
`internet_access = false`. Give the function no RAM role, VPC attachment,
mounted OSS or NAS filesystem, log configuration, database or queue endpoint,
secret environment, or long-lived credential. Omit credential injection by
construction: without a function role, no runtime STS identity is available.
The trusted API role receives only the exact create, synchronous invoke, get,
and delete session actions required for this function.

Package the parser as content-addressed custom-runtime code and no more than
five immutable layers loaded from the existing private artifact bucket by the
Function Compute control plane. No code archive or layer exceeds Singapore's
500 MB compressed limit and total attached layers do not exceed 2 GB. The
artifacts contain the exact Java 25 runtime, session handler, worker, native
tools, licenses, manifest, and scanner data needed at execution. Put the
independently admitted ClamAV snapshot in its own content-addressed read-only
layer, publish a new exact layer and function version before the 24-hour
admission window expires, and fail closed if freshness or identity does not
match. The runtime cannot fetch an update. Do not create or use Alibaba
Container Registry or SLS.

Treat the Function Compute session instance as the cloud isolation boundary.
The custom runtime and parser execute non-root; `/code` and `/opt` remain
read-only; only the session-private bounded temporary path is writable. The
runtime receives no invocation credential header, OSS key, bucket name, queue
message, service identity, or trusted connection string. It cannot access
another session's files. Function Compute, rather than application
configuration, owns host capabilities, seccomp, and the platform process
limit; provider 1.283.0 exposes no Podman-equivalent capability-drop, seccomp,
or 256-PID knobs. That difference is explicitly accepted only for this
bounded dev target and only after deployed denial tests prove the retained
credential, network, identity, filesystem, and cross-session outcomes. The
runtime destroys job-scoped input and output on terminal paths before the
trusted side deletes the session.

Retain `isolated-ingestion-v1`. Pin Apache Tika `3.3.1` and invoke only its
restricted PDF, EPUB, and OOXML parsers in process rather than Tika Server;
disable remote fetchers, external resource resolution, embedded execution,
inline OCR, and every parser outside the allowlist. Demo Day admission remains
PDF-only under the PRD; internal EPUB and DOCX groundwork is not exposed.
Pin ClamAV `1.4.5` LTS and Tesseract `5.5.2` with the checksum-pinned English
`tessdata_fast` artifact. Retain ADR 0035's independently verified,
upstream-signed `upstream-clamav-cloud-demo-v1` snapshot admission. The
function fails closed when the exact read-only snapshot layer is absent,
invalid, mismatched, or more than 24 hours old. It never runs `freshclam` or
contacts an update service.

Retain `isolated-ingestion-limits-v1` except for the superseded
Podman-specific 256-PID enforcement surface: at most 2 vCPU, 4 GiB memory,
4 GiB job-scoped temporary storage within the 10 GiB function disk, and
512 MiB normalized output per operation. Standard digital parsing has a
90-second wall limit; the asynchronous large/OCR path has a 30-minute document
limit and a 60-second per-page OCR limit. The runtime reserves enough of each
1,800-second invocation deadline to fail closed and clean up. Input limits
remain 50 MB and, where the format has stable pages, 800 pages; the standard
path remains at most 20 MB and 200 pages. Existing archive-entry, nesting,
expansion, type, encryption, active-content, malformed-container, and ambiguity
controls remain unchanged. These are ceilings, not resource entitlements;
lower benchmark-proven operating limits remain permitted.

Retain `normalized-document-v1`, including ordered immutable blocks, canonical
unchanged text, half-open offsets, deterministic order, text hash, exact
parser/config/runtime/classifier provenance, and format-native locators. PDF
locators use real page plus section coordinates. EPUB and DOCX retain their
internal non-product locator rules and never invent rendered page numbers.

Retain the normalized failures from ADR 0008, including `mime_mismatch`,
`malware_detected`, `scan_db_stale`, `encrypted`, `unsupported_type`,
`archive_limit`, `page_limit`, `ocr_required`, `parse_timeout`, `parse_oom`,
`parser_crash`, `invalid_output`, and `infrastructure_unavailable`.
Deterministic document, malware, policy, limit, repeat timeout/OOM, and schema
failures do not retry blindly. Only ADR 0012-authorized transient invocation,
host, or transport failures retry within the registered deadline and attempt
budget.

Do not deploy this target merely because provider validation accepts the
resource configuration. Before the first dev plan, repository policy and a
live Singapore session-isolation probe must show that the function has no RAM
role, credential environment or injected credential headers; cannot reach
public Internet, VPC addresses, DNS, cloud metadata, OSS, queues, databases,
or another session; runs non-root with read-only `/code` and `/opt` and only
session-private temporary files; enforces storage, memory, time, input, and
output bounds; rejects stale scanner data; validates output; deletes every
session on terminal paths; and uses the exact recorded artifact identities.
If Function Compute, session isolation, or the no-registry package cannot
satisfy every proof, this target has no deployment authority. Stop issue #199
and return for a revised owner decision and cost approval rather than granting
broader worker authority.

### Rationale

The serverless task removes a continuously billable host from an intermittent
staff-only workflow while keeping trusted OSS and queue authority outside
parser-controlled code. Session-exclusive bounded chunks through the already
trusted orchestrator avoid per-request payload ceilings without granting the
function an OSS role, mount, public trigger, or VPC path. Function-level egress
denial, no runtime identity, non-root execution, read-only artifacts,
session-private storage, validation, and explicit session deletion retain the
trusted-supervisor outcome.

A custom-runtime archive and layers preserve exact dependency identity without
reintroducing Alibaba Container Registry. Zero minimum instances preserves the
cost benefit; cold-start and first-upload latency are accepted only for the
staff-controlled Demo Day dev environment and must be observed honestly.
Staging, pilot, production, managed document processing, an OSS-authorized
worker, a public trigger, or a different isolation mechanism require separate
authority.

## Verification

ADR validation proves ADR 0008 is superseded by this record and this record is
the active authority for isolated ingestion. Architecture validation lists
this record as the decided target without claiming the Function Compute path
has been implemented or deployed.

Static infrastructure tests reject a parser ECS instance, parser ECS role,
parser security-group/vSwitch allocation, ACR, SLS, EventBridge, a parser
function RAM role, `internet_access = true`, any parser VPC, OSS/NAS mount or
log configuration, public or asynchronous trigger, nonzero minimum instances,
concurrency above one, isolation other than `SESSION_EXCLUSIVE`, missing
header affinity or session-ID reuse prevention, mutable artifacts, resource
ceilings above the verdict, and missing timeout, digest, or cleanup
configuration. Provider-schema tests freeze the exact 1.283.0 field names and
accepted values. Packaging tests prove `custom.debian11` and all archives and
layers fit Singapore limits and contain exact Java, Tika, ClamAV, Tesseract,
language-data, license, scanner-snapshot, handler, worker, and manifest
identities.

Contract tests cover session create/invoke/get/delete behavior, serialized
authenticated 8 MiB chunks, the 20 MB standard and 50 MB maximum boundaries,
512 MiB output enforcement with bounded diagnostics, ordering,
duplicate/replay and cross-session behavior, disconnect, expiry and timeout
reconciliation, hash and schema validation, stale scanner rejection,
normalized failure mapping, and cleanup. Isolation fixtures attempt metadata,
DNS, public, private, OSS, RocketMQ, RDS, AnalyticDB, cross-session,
environment/header credential, filesystem, privilege, memory, storage, and
network escapes from the parser runtime and must fail closed. Existing parser,
malware, archive, malformed PDF, encrypted PDF, scanned/mixed PDF,
prompt-injection, hang/OOM/crash, provenance, locator, output, idempotency,
retry, and deletion fixtures remain green.

A deployed staff-only smoke invokes the exact function artifact with a
rights-cleared PDF, records cold and warm observed latency and metered
Function Compute usage, proves the denial canaries from inside the worker,
verifies the final normalized object and cleanup, and labels formal
secure-ingestion qualification deferred under ADR 0042. No smoke result
authorizes public use, external data, production or pilot readiness, or a
formal p95/security claim.

## Reversal criteria

Supersede before using this path outside issue #199's bounded Demo Day dev
environment; if Function Compute changes runtime, package, session, identity,
networking, isolation, or billing behavior; if cold-start, throughput,
package-size, scanner-freshness, or denial tests fail; if the runtime needs any
cloud identity, storage mount, public/VPC egress, public trigger, or broader
filesystem access; if ACR or SLS becomes required; if product limits or
supported formats change; or if a different parser/scanner/OCR/runtime profile
is selected. Any successor must retain explicit product authority, exact
component and artifact provenance, independent malware-snapshot admission,
credential-free untrusted parsing, bounded resource and output controls,
owner-scope reauthorization, deterministic normalized output, fail-closed
errors, durable idempotency, cleanup, and evidence-backed isolation.
