---
id: "0035"
title: "Upstream-signed ClamAV cloud-demo snapshot admission"
status: Accepted
date: "2026-07-26"
aliases: [D-GH-176]
prd_references: "`prds/reflo-prd.md` §6 F1, §9, §11, and §13; ADR 0008; ADR 0021; issue #55"
ownership:
  proposer: "codex-root through issue #176"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #55 and its implementation pull request"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in issue #176"
  approval_basis: "Owner-authorized replacement of the disproportionate, unapproved dedicated Alibaba Software KMS dependency for the bounded staff-controlled demo while preserving upstream signature verification, immutable identity, freshness, independent runtime verification, isolation, and fail-closed behavior."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/176
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/176#issuecomment-5085999591
  record_pr: https://github.com/deepessh/reflo-learning/pull/0
supersedes: ["0021"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0035: Upstream-signed ClamAV cloud-demo snapshot admission

## Context

The PRD requires malware scanning, untrusted-upload validation, parser
isolation, honest dependency failure, and demo-only safety. It does not require
a Reflo-signed snapshot manifest or KMS. ADR 0008 requires a separate connected
maintenance job to verify and publish an immutable ClamAV signature snapshot
and requires disconnected ingestion to reject a snapshot that is absent,
invalid, or more than 24 hours old. ADR 0021 made that snapshot depend on a
Reflo ECDSA signature from a dedicated Alibaba Software KMS instance.

That dedicated-instance cost is disproportionate to the staff-controlled local
and Alibaba Cloud Demo Day path and has not been approved. Official ClamAV
CVD/CLD databases are already digitally signed upstream and can be
independently verified with the pinned ClamAV toolchain. This verdict controls
the snapshot-admission trust profile for that bounded demo path. It supersedes
ADR 0021 in full and replaces only ADR 0008's requirement for a separately
Reflo-signed snapshot; every other ADR 0008 scanner, isolation, immutability,
freshness, fixture, and failure contract remains active.

This verdict does not change the PRD scanning requirement, the 24-hour
freshness ceiling, immutable snapshot identity, fail-closed behavior, worker
isolation, or the prohibition on public or external-learner uploads through
Demo Day. It does not authorize spending, a public-upload path, a real-user
pilot, or a production-readiness claim. Any post-hackathon real-user trust
profile remains separately reversible and requires separate human
authorization.

## Options

Retain ADR 0021 and provision Alibaba KMS; adopt an upstream-signature,
hash-and-immutability admission profile for the cloud demo; or introduce
another managed or keyless signer with a new provider, identity model, adapter,
and verification profile.

## Decision

### Authorized verdict

Adopt `upstream-clamav-cloud-demo-v1` for the staff-controlled local and Alibaba
Cloud demo deployment.

A connected maintenance job uses the digest-pinned FreshClam image to retrieve
only official ClamAV databases. Before publication it verifies every included
CVD/CLD upstream signature with the pinned `sigtool`, enforces the supported
ClamAV version and the 24-hour freshness ceiling, and records the exact
versioned filename set, byte length, SHA-256 digest, database version, build
time, publication time, toolchain identity, and resulting snapshot identity.
An absent, extra, duplicate, unsupported, unverifiable, ambiguous, or stale
database prevents publication.

Publish the verified databases and their exact identity metadata at
content-addressed immutable paths in a private OSS boundary with overwrite
prevention. The connected publisher receives narrowly scoped write authority
only for that boundary. Runtime services receive read-only authority through
RAM roles and may not publish or overwrite snapshots.

Before admitting a snapshot, the trusted runtime admission component
independently repeats the upstream-signature, exact filename-set, supported
version, freshness, byte-length, SHA-256, content-address, and toolchain-identity
checks. It fails closed on absence, mismatch, staleness, ambiguity, unsupported
metadata, or verifier failure. Only the independently admitted files are
mounted read-only into the networkless, credential-free scanner. Snapshot
metadata, object-store values, or a publisher role never grant authority to the
untrusted worker.

This profile has no KMS instance, private signing key, public-key pin, detached
Reflo signature, KMS adapter, rotation ceremony, or KMS golden-vector
requirement. A refresh or publication failure exposes no partial replacement.
The runtime may continue using only the last independently verified immutable
snapshot until it reaches the 24-hour limit, after which scanning fails closed.

Keep public uploads, external learner data, pilot activation, and
production-readiness claims out of scope. The profile is a bounded Demo Day
trust decision, not authorization for a post-hackathon real-user production
path.

### Rationale

Upstream ClamAV signatures authenticate the database publisher. Exact hashes,
lengths, closed filename sets, content-addressed immutable storage, least-
privilege publication, and independent runtime verification preserve the
snapshot's identity across Reflo's maintenance, storage, and admission
boundaries. Repeating the authoritative signature and identity checks at
runtime prevents publisher metadata alone from admitting substituted bytes.

A second Reflo signature would add a dedicated paid KMS dependency and
operational key lifecycle without improving the bounded demo enough to justify
that cost. Another managed or keyless signer would add a provider and identity
surface with the same unnecessary second-attestation layer. Removing that
layer does not weaken the networkless, credential-free scanner boundary or the
existing freshness, immutability, and fail-closed requirements.

## Verification

Contract fixtures pin the FreshClam image, ClamAV and `sigtool` versions,
supported database metadata, filename-set policy, and snapshot-identity
construction. Publisher and runtime suites independently accept valid official
fixtures and reject missing, extra, duplicate, unsupported, unsigned,
signature-invalid, tampered, stale, future-dated, hash-mismatched,
length-mismatched, wrong-version, wrong-toolchain, content-address-mismatched,
mutable, or partially published snapshots. Tests prove the 24-hour boundary,
last-valid-snapshot behavior, and fail-closed behavior when refresh,
publication, storage, verification, or admission is unavailable.

OSS and RAM policy checks prove the publisher has only narrowly scoped write
authority, runtime services are read-only, immutable objects cannot be
overwritten, and the scanner receives no credentials or network path.
Isolation tests retain every ADR 0008 worker, mount, resource, malware,
adversarial-document, retry, finalization, and cleanup guarantee. Static and
composition checks prove this profile has no Alibaba KMS instance, signer,
private-key, public-key-pin, detached-signature, rotation, or golden-vector
dependency.

Issue #55's connected browser verification must exercise the rights-cleared,
staff-controlled upload path against the admitted snapshot and record honest
latency and failure evidence. Passing this record's fixtures or that bounded
demo proof does not authorize public uploads, external learner data, pilot
activation, or a production-readiness claim.

## Reversal criteria

Supersede if official ClamAV signatures cannot be verified reproducibly with
the pinned toolchain; the upstream database or signature format becomes
unacceptable; independent publisher and runtime admission cannot preserve
exact immutable identity within the 24-hour window; or a separately
human-authorized post-hackathon real-user profile requires additional publisher
attestation. Any successor must preserve verified malware databases, exact
immutable identity, bounded freshness, independent admission, least-privilege
publication, networkless and credential-free scanning, fail-closed behavior,
and the PRD's untrusted-upload and honest-labeling boundaries.
