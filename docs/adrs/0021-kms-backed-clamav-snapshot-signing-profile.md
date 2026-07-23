---
id: "0021"
title: "KMS-backed ClamAV snapshot signing profile"
status: Accepted
date: "2026-07-21"
aliases: [D-GH-96]
prd_references: "`prds/reflo-prd.md` §6 F1, §9, §11, and §13; D-GH-5 and D-GH-8"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #29"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/96
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/96#issuecomment-5037326529
  record_pr: https://github.com/deepessh/reflo-learning/pull/98
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0021: KMS-backed ClamAV snapshot signing profile

## Context

D-GH-8 requires the connected maintenance path to verify and publish signed immutable ClamAV signature snapshots and disconnected ingestion to reject a snapshot that is absent, invalid, or more than 24 hours old, but it intentionally selects no signing algorithm, detached wire format, key-custody mechanism, rotation protocol, or provider integration. This verdict controls the production v1 Reflo signature over the exact snapshot manifest bytes, the Alibaba signing adapter, offline public-key verification contract, key identity and custody, rotation overlap, and signing-failure behavior. It does not replace upstream ClamAV-native verification before publication; change D-GH-8's scanner version, 24-hour lifetime, isolation boundary, fixture gates, or immutable snapshot requirement; grant the untrusted worker network access or credentials; create a general-purpose signing abstraction; or authorize a KMS instance, capacity, spending, deployment, or pilot activation.

## Options

Ed25519 over the exact manifest bytes with an exportable private key held in the connected maintenance identity's D-GH-5 secret boundary; ECDSA over NIST `secp256r1` with SHA-256 using a non-exportable Alibaba KMS asymmetric key; RSA-PSS/SHA-256 using KMS; and HMAC-SHA-256 with shared signing and verification authority.

## Decision

### Authorized verdict

Adopt `clamav-snapshot-signature-v1`. Generate a software-protected Alibaba KMS `EC_P256` key with `SIGN/VERIFY` usage and use `ECDSA_SHA_256` over SHA-256 of the exact immutable `snapshot-manifest-v1` byte sequence. The publisher signs the same UTF-8-without-BOM bytes that it writes; line endings and the presence or absence of a trailing newline are part of those bytes, and no verifier parses and reserializes the manifest before signature verification. The detached artifact is strict padded standard Base64 of one exact ASN.1 DER ECDSA `(r,s)` value. Reject whitespace, noncanonical Base64, malformed or trailing DER data, unknown signature profiles or keys, and any byte change. The manifest includes its contract and signature-profile versions, an application-level `kid`, the SHA-256 fingerprint of the corresponding SPKI public key, publication time, snapshot identity, and every included database file's digest and size.

Only the connected maintenance publisher may request a signature, using short-lived D-GH-5 identity and least-privilege signing permission on the exact KMS key. It receives no key-administration, deletion, secret-retrieval, wildcard-alias, or verifier authority. A separate provisioning identity retrieves and validates the public key. Keep the Alibaba key identity in publisher configuration and sanitized provenance; offline verifiers resolve only the application `kid` through a deployment-pinned allowlist of exact SPKI public keys and fingerprints and receive no KMS credential, provider lookup, or network dependency. Freeze one Alibaba API and RAW-versus-DIGEST path in the provider adapter. A digest path computes SHA-256 exactly once before KMS signing, while Node verification hashes the original manifest bytes exactly once; never pass that digest through a second SHA-256 verification step. A real KMS golden vector must prove the provider response encoding and Node interoperability before activation. If Alibaba output needs conversion, only the publisher adapter performs one fixed fixture-proven conversion to the profile's strict DER; the verifier never auto-detects signature formats.

Rotation creates a new asymmetric key rather than changing the meaning of an existing `kid`. First deploy verifier pins for both old and new keys, then switch the publisher to the new exact key, retain the old verifier pin for longer than the 24-hour snapshot lifetime and until rollout is confirmed, and finally remove it. Do not assume provider automatic rotation preserves this application contract. If KMS signing or publication fails, publish no partial or unsigned replacement. Continue using only the last valid immutable snapshot until it reaches the D-GH-8 age limit, then fail closed. Production never falls back to HMAC, an exportable local key, a different algorithm, or an unknown signature encoding.

### Rationale

A KMS-held `secp256r1` key prevents the reusable private key from entering publisher memory, storage, images, logs, or snapshots and limits a compromise from turning into permanent offline key theft; an attacker controlling the authorized publisher could still request signatures while that access remains active, so exact IAM scope, audit evidence, revocation, and publisher isolation remain required. ECDSA over `secp256r1` with SHA-256 has direct Alibaba and Node support and a portable offline-verification shape across major cloud KMS products, while the provider-specific operation stays inside one narrow adapter. Ed25519 is simpler and fixed-width but would require exporting the private key from D-GH-5 custody into the maintenance process. RSA-PSS adds larger keys and signatures plus salt-length rules without a compensating benefit. HMAC is rejected because every offline verifier secret would also grant snapshot-forging authority. D-GH-5 already requires KMS Secrets Manager for production runtime secrets, but neither that record nor this one approves paid KMS resources.

## Verification

Contract fixtures include a real Alibaba-KMS-to-Node golden vector and frozen local vectors for the exact manifest bytes, digest, strict DER signature, Base64 artifact, SPKI, fingerprint, and `kid`. Tests cover UTF-8/BOM, newline, whitespace, field-order, and reserialization changes; wrong digest, key, fingerprint, profile, algorithm, or snapshot identity; malformed, noncanonical, truncated, oversized, or trailing signature encodings; absent and stale snapshots; and signed manifests whose file digest or size does not match the mounted immutable database. Rotation tests prove old-only, overlap, new-only, premature-removal rejection, rollout confirmation, and retirement after more than 24 hours. Failure tests prove KMS or publication errors cannot expose partial artifacts, silently reuse an expired snapshot, or trigger any algorithm or local-key fallback. IAM and import-boundary checks prove only the maintenance adapter can invoke signing on the exact key, provisioning authority is separate, private material is never returned or persisted, and the worker and offline verifier have no cloud credential or network path. Provenance records the profile, `kid`, fingerprint, provider key identity, signing response identity, exact manifest digest, and publication result without recording private material or granting runtime authority. Activation remains blocked until the interoperability, isolation, provenance, upstream-verification, spending-approval, and D-GH-8 gates pass.

## Reversal criteria

Supersede if Alibaba KMS cannot produce or reliably convert a stable signature that passes the exact cross-runtime fixtures; the required paid capacity is not approved or creates disproportionate cost; signing availability repeatedly exhausts the 24-hour safe window; KMS identity or audit controls cannot satisfy D-GH-5; ECDSA over `secp256r1` with SHA-256 becomes unacceptable; or a portable non-exportable signer provides materially lower operational risk. Any successor must retain asymmetric offline verification with no verifier signing secret, exact-byte and immutable-file binding, explicit version and key identity, bounded rotation, least-privilege custody, real provider interoperability evidence, no untrusted-worker credentials or network, and fail-closed behavior after the 24-hour limit.
