---
id: "0013"
title: "Private OSS delivery, CDN signing, expiry, and invalidation contract"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-13]
prd_references: "`prds/reflo-prd.md` §6 F2 and F7, §9, §10, and §11"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of private object storage, CDN signing, media delivery, and deletion implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/13
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/13#issuecomment-5017044157
  record_pr: https://github.com/deepessh/reflo-learning/pull/75
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0013: Private OSS delivery, CDN signing, expiry, and invalidation contract

## Context

Reflo must deliver private validated source documents and generated assets through CDN without making OSS public, bypassing owner-scope authorization, leaking bearer URLs, breaking ranged media playback, or leaving deleted content in edge caches. This verdict controls OSS trust-boundary and object-key layout, private CDN origin access, signing and expiry, already-issued URL behavior, client and POP caching, byte ranges, logging, key rotation, and OSS/CDN invalidation. It does not replace D-GH-5's environment, secret, or infrastructure-promotion controls, D-GH-7's owner-scope authorization contract, issue #12's queue finalization semantics, issue #18's full retention/deletion and telemetry policy, or the PRD's audio, privacy, and deletion gates.

## Options

Proxy every asset byte through ECS; issue short-lived per-object CDN URLs after application authorization; grant session/path access through signed cookies; perform CDN remote authentication on every request.

## Decision

### Authorized verdict

Adopt `private-delivery-v1`. Use separate private OSS buckets per environment for quarantine and CDN delivery. The quarantine bucket is never CDN-accessible. Because private-origin authorization is bucket-wide rather than prefix-scoped, the delivery bucket contains only intentionally client-deliverable validated source objects and generated assets; parser artifacts, unvalidated uploads, state, and internal derivatives remain outside it. Enable Block Public Access, deny anonymous and direct OSS delivery, and grant Alibaba CDN only minimum read-only private-origin access to the delivery bucket. Use immutable opaque keys without names, email addresses, original filenames, or other direct identifiers. Canonical layouts are `owners/{owner_scope_id}/sources/{source_document_id}/versions/{version_id}/original.{ext}` and `owners/{owner_scope_id}/courses/{course_id}/assets/{asset_id}/generations/{generation_id}/payload.{ext}`; RDS remains authoritative for identity, active version, ownership, retention, and status. The application accepts only an asset or source-document ID, resolves the canonical key server-side, and applies D-GH-7 active-membership and owner-scope authorization before signing. Deliver over HTTPS using Alibaba CDN Type A URL signing with a high-entropy key held in KMS Secrets Manager and a frozen canonical-path and encoding implementation. A signed URL is a bearer credential with a 15-minute TTL, minted only at playback or download time. Revocation stops new signing immediately, while an already issued URL can remain usable until expiry. Enable byte-range delivery; clients reauthorize, refresh an expired URL, and resume at the last byte or time offset. Signed URLs are never stored in local storage or service-worker caches, and full signed URLs and signing parameters are prohibited from application logs, traces, analytics, and support diagnostics; provider logs are minimized or redacted before downstream ingestion and remain governed by issue #18. Immutable canonical paths may use independently configured long-lived POP caching only after CDN authentication succeeds, signing parameters never enter the canonical cache key, and client-facing cache behavior prevents durable unauthorized browser or service-worker persistence without breaking media playback. Deletion first tombstones the resource in RDS, then deletes the OSS object, submits a forced purge for the unsigned canonical CDN URL, and polls purge status; deletion is incomplete until OSS absence and CDN purge completion are verified and recorded within the PRD's 24-hour active/derived-store limit. Planned key rotation uses primary/secondary overlap; suspected compromise replaces both accepted keys immediately so outstanding URLs fail authentication. ECS byte proxying is rejected as the default due to application bandwidth, latency, and scaling risk. Signed cookies are rejected because their broader path grants weaken per-object auditability without a required first-class provider contract. Remote authentication is rejected for the pilot because it adds a public application dependency and authorization round trip to every request, including ranges; future adoption must fail closed and requires a superseding decision.

### Rationale

Per-object CDN URLs preserve the PRD-mandated CDN data path and cache efficiency while keeping authorization and object resolution in the application. Physical separation ensures bucket-wide origin permission cannot expose quarantine or internal artifacts. Opaque immutable keys make cache, rollback, audit, and purge behavior deterministic. Fifteen-minute capabilities bound post-revocation exposure, while explicit range refresh and resume preserve the 5–10 minute audio flow. Tombstone-first deletion plus verified origin removal and forced edge purge closes both future-signing and cached-delivery paths.

## Verification

Conformance tests prove direct and anonymous OSS denial, server-only key resolution, cross-scope and revoked-membership denial, URL tampering and expiry, unsigned cache-hit denial, canonical encoding, range playback across expiry with refresh and resume, client and service-worker non-persistence, signed-URL redaction, planned and emergency key rotation, immutable-version behavior, OSS deletion plus forced CDN purge completion, and absence of quarantine or internal artifacts from the delivery bucket. Configuration checks fail closed on public access, non-read-only CDN origin access, missing signing or range controls, signing parameters in cache keys, unredacted bearer URLs, or deletion completion without verified purge.

## Reversal criteria

Supersede if 15-minute URLs cannot pass the required audio and range tests, private-origin access cannot be constrained to a delivery-only bucket, CDN authentication or cache behavior cannot fail closed, purge completion cannot meet deletion requirements, or measured latency, cost, or security evidence favors remote authentication or proxy delivery. Any replacement must preserve the PRD's owner-scope, short-lived authorization, private-origin, deletion, privacy, and audio-quality requirements.
