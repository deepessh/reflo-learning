---
id: "0008"
title: "Isolated local document parsing, scanning, and OCR"
status: Accepted
date: "2026-07-20"
aliases: [D-GH-8]
prd_references: "`prds/reflo-prd.md` §6 F1, §9, §11, and §13; D-GH-4, D-GH-9, and D-GH-12"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the secure-ingestion supervisor, isolated-worker, normalized-document, and upload-validation implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/8
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/8#issuecomment-5026852220
  record_pr: https://github.com/deepessh/reflo-learning/pull/90
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0008: Isolated local document parsing, scanning, and OCR

## Context

Reflo must extract reproducible source text and locators from untrusted PDF, EPUB, and DOCX uploads while detecting malware and scanned content without giving parser-controlled code network access, ambient credentials, or authority over trusted stores. This verdict controls the production parser, malware scanner, OCR engine, isolated-worker boundary, initial resource and archive ceilings, scanned-page routing, normalized parser output, failure policy, and security fixtures. It does not change the PRD size, page, format, latency, privacy, deletion, or pilot gates; authorize managed document processing, new cloud services, or ECS capacity purchases; replace D-GH-4 capability ports, D-GH-9 chunking and source-span contracts, or D-GH-12 queue semantics; or resolve the PRD ambiguity that EPUB is reflowable and DOCX pagination is renderer-dependent.

## Options

A self-hosted local toolchain; managed scanning and OCR; a hybrid path with managed fallback; and a local-only implementation behind the existing narrow capability ports.

## Decision

### Authorized verdict

Adopt `isolated-ingestion-v1`, a local-only production path behind D-GH-4 capability ports. Pin Apache Tika `3.3.1` and invoke its restricted PDF, EPUB, and OOXML parsers in-process rather than Tika Server; disable remote fetchers, external resource resolution, embedded execution, inline OCR, and every parser outside the allowlist. Pin ClamAV `1.4.5` LTS; a separate connected maintenance job verifies and publishes signed signature snapshots, while workers mount one immutable snapshot read-only and fail closed when it is absent, invalid, or more than 24 hours old. Pin Tesseract `5.5.2` with a checksum-pinned English `tessdata_fast` artifact for asynchronous page-by-page OCR; additional language packs require separately versioned fixtures and approval. Pin rootless Podman `6.0.1` as the OCI runtime on a dedicated ECS parser pool. Build one reproducible worker image from exact component and base-image pins, admit it outside local development only by `sha256` digest, record that digest with build provenance before deployment, and reject mutable-only image references; no deployment digest is authorized before the image exists and passes license, support, vulnerability, and fixture gates. Provisioning or enlarging the ECS pool remains separately human-approved when it can incur spending.

A trusted least-privilege supervisor alone reads the quarantined OSS object and publishes validated results. It reauthorizes current owner scope and retention state, verifies the recorded SHA-256, stages one read-only file on job-scoped ephemeral storage, and launches a fresh non-root worker with `--network=none`, all Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, default seccomp, no inherited environment except a closed non-sensitive allowlist, no secrets, host sockets, cloud metadata route, or service identity, and bounded writable input/output mounts. The untrusted worker never reads OSS, RocketMQ, RDS, or AnalyticDB. The supervisor validates the output schema, size, hashes, locators, and allowlisted diagnostics before atomically finalizing through D-GH-12, then destroys all ephemeral input and output on every terminal path.

`isolated-ingestion-limits-v1` permits at most 2 vCPU, 4 GiB memory, 256 PIDs, 4 GiB temporary storage, and 512 MiB normalized output per worker. Standard digital parsing has a 90-second worker wall limit; the asynchronous large/OCR path has a 30-minute document limit and a 60-second per-page OCR limit. Input limits remain the PRD values: 50 MB and, where the format has stable pages, 800 pages; the standard path is at most 20 MB and 200 stable pages. ZIP-based EPUB and DOCX additionally permit at most 10,000 entries, nesting depth four, 1 GiB total expansion, 100 MiB for one entry, and a 100:1 aggregate expansion ratio. Type acceptance requires an allowlisted extension, detected signature, client MIME, and internal container structure to agree. Encrypted input, active content, macros, external relationships, malformed containers, limit exhaustion, and ambiguous type fail closed. These are initial safety ceilings, not entitlement to consume the full allowance; lower benchmark-proven operating limits may be applied without weakening the hard ceilings.

`scan-detect-v1` first performs bounded text extraction on every PDF page and raster-probes only pages with fewer than 50 normalized non-whitespace characters. A probed page is an OCR candidate when rendered non-background content covers at least 5 percent of the page. Zero candidates is digital, at least one but fewer than 80 percent of pages is mixed, and at least 80 percent is scanned. Any candidate routes the document to the visible asynchronous OCR state; mixed documents OCR only candidate pages. Rasterization is fixed at 300 DPI, OCR is English-only, and OCR output never overwrites successfully extracted digital text. The thresholds and renderer build are part of the classifier version and must pass frozen digital, mixed, scanned, blank-page, title-page, table, and image fixtures before pilot use.

Emit `normalized-document-v1`: ordered immutable blocks containing block kind, canonical unchanged text, half-open canonical offsets, deterministic order, text hash, parser/config/image/classifier versions, and format-native locators. PDF locators use real page plus section coordinates; EPUB locators use spine item, resource, and section path; DOCX locators use body element, section, and heading path. EPUB and DOCX record `page=null` and never invent rendered page numbers. Until a human-approved PRD clarification defines how the 200/800-page limits apply to those formats, implementation may validate, parse, and enforce byte, archive, content, and resource limits but may not claim the page-limit or affected activation-gate requirement is satisfied.

Normalize at least `mime_mismatch`, `malware_detected`, `scan_db_stale`, `encrypted`, `unsupported_type`, `archive_limit`, `page_limit`, `ocr_required`, `parse_timeout`, `parse_oom`, `parser_crash`, `invalid_output`, and `infrastructure_unavailable`. Deterministic document, malware, policy, limit, timeout-at-the-same-profile, OOM-at-the-same-profile, and schema failures do not retry blindly. Only D-GH-12-authorized transient launch, host, storage, or queue failures retry within the registered deadline and attempt budget; ambiguous completion reconciles by the original operation and input hash. Contract fixtures cover valid provenance for every format, digital/mixed/scanned PDFs, encrypted and malformed input, MIME disagreement, zip bombs and nested archives, XML entities, macros/scripts/external references, malware test signatures, stale signatures, parser hang/OOM/crash, prompt injection, duplicate jobs, invalid or oversized output, and ephemeral cleanup after every terminal outcome.

### Rationale

A local-only path satisfies the PRD networkless parser/OCR boundary and prevents an uploaded document from turning provider access, credentials, or remote content resolution into an attack surface. The trusted-supervisor split lets the system use OSS and durable queues without granting that authority to untrusted parsers. Tika supplies maintained format parsers under one restricted integration, ClamAV 1.4 is the supported LTS line through August 2027, Tesseract 5.5.2 is the current stable OCR engine, and rootless Podman provides a concrete OCI enforcement surface. Exact component, configuration, classifier, and image provenance make parser behavior reproducible and upgradeable through a new reviewed profile rather than a mutable runtime alias. Managed OCR is rejected because it contradicts the current networkless-worker mandate and would add provider, privacy, retention, deletion, data-location, and potentially spending decisions.

## Verification

Static checks allow only the pinned parser/scanner/OCR/runtime versions and reject Tika Server, unapproved parsers or language packs, mutable deployment images, inherited secrets, network access, privileged/root workers, writable roots, host sockets, missing seccomp, excess resources, and stale scanner data. Isolation tests prove the supervisor can stage and publish while the worker cannot reach cloud metadata, DNS, OSS, queues, databases, or another job. Format and adversarial fixtures prove type agreement, archive and page ceilings, malware fail-closed behavior, stable canonical offsets and locators, asynchronous OCR routing, digital-text preservation, bounded output, normalized failures, D-GH-12 retry/finalization behavior, and cleanup. The Week 1 and pilot gates remain unsatisfied until the PRD benchmark and adversarial suites pass and the EPUB/DOCX page-limit ambiguity is resolved through human-controlled PRD change.

## Reversal criteria

Supersede if the pinned toolchain cannot meet the PRD latency, extraction, grounding, malware, OCR, or isolation gates; upstream support or security posture becomes unacceptable; or a different local toolchain provides equivalent fail-closed isolation and reproducibility with materially lower measured risk. Managed processing additionally requires a PRD revision and a separate human-authorized provider/privacy verdict, including retention, training, deletion, data location, and spending where applicable. Any replacement must preserve the trusted-supervisor boundary, networkless and credential-free untrusted workers, bounded deterministic output, source provenance, owner-scope reauthorization, and D-GH-12 finalization.
