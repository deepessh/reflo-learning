---
id: "0041"
title: "PDF-only Demo release-gate contract v2"
status: Accepted
date: "2026-07-27"
aliases: [D-GH-196]
prd_references: "`prds/reflo-prd.md` v2.6 §3 G1, §5, §6 F1, §7, §8 Flow A, §11, §12, and §13; ADR 0003; ADR 0008; ADR 0015; ADR 0028"
ownership:
  proposer: "@deepessh through issue #196"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #100 and owners of release-gate corpus, runner, publisher, index, promotion-consumer, and upload-boundary work"
authorization:
  decider: "@deepessh, repository owner and named human decider"
  approval_basis: "The decider explicitly approved PDF-only ingestion for Demo Day, deferred EPUB/DOCX to fast-follow, directed the PRD and needed ADRs to be updated, and authorized the coordinated v2 release-gate contract family in the exact linked verdict comment."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/196
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/196#issuecomment-5096658975
  record_pr: https://github.com/deepessh/reflo-learning/pull/197
supersedes: ["0015"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0041: PDF-only Demo release-gate contract v2

## Context

PRD v2.6 makes digitally generated PDF the only Demo Day ingestion format and
defers EPUB and DOCX product support to fast-follow. The authoritative
performance corpus must therefore stop treating EPUB and DOCX as supported
documents, while upload-security evidence must prove that both formats are
rejected before ingestion processing begins.

ADR 0015 adopted the repository-owned `evaluation-contract-v1` family and
requires a new version when dataset eligibility, strata, or gate meaning
changes. Mutating v1 would make retained manifests, evidence bundles, scorer
outputs, and attestations change meaning. Keeping v1 current would let release
evidence assert an obsolete multi-format product boundary.

This decision controls only the coordinated version transition and its
PDF-only gate meaning. Product support remains PRD authority. The internal
multi-format parser groundwork accepted by ADRs 0008, 0009, and 0020 remains
available for separately authorized fast-follow work and does not constitute
Demo Day product support.

## Options

Advance the evaluation, dataset-manifest, evidence-bundle, scorer, and
gate-attestation contracts together to v2 while retaining v1 history; mutate
v1 in place; or leave v1 authoritative and encode the PDF-only boundary in
ad hoc runner configuration.

## Decision

### Authorized verdict

Adopt `evaluation-contract-v2`, `dataset-manifest-v2`,
`evidence-bundle-v2`, `release-gate-scorer-v2`, and
`gate-attestation-v2` as one non-composable authoritative family. New
authoritative runs and current attestations use only this family. V1 schemas
and stored records remain immutable historical evidence; the forward database
migration supersedes every current v1 attestation and permits a v1 row only
when it is already historical. Results and attestations from different
contract families never aggregate.

The v2 performance dataset contains at least 40 human-rights-approved,
standard-profile PDFs. Every document is 5–200 pages and 0.5–20 MB, and the
frozen corpus covers the PRD's page, size, table, image, and simple/complex
structure strata. EPUB and DOCX items are ineligible and cannot help pass the
Demo Day performance gate.

The v2 upload-security dataset retains the supported-PDF and existing
malformed, encrypted, over-limit, archive, scope, network, credential, and
scanner assertions. It additionally requires explicit unsupported-DOCX and
unsupported-EPUB routes whose expected result is `unsupported_type` before
quarantine, parsing, OCR, storage publication, or generation scheduling.
Adversarial-document evidence uses supported PDFs.

This ADR supersedes ADR 0015 and incorporates every ADR 0015 decision except
its v1 contract-family identity and its former multi-format performance
eligibility. Repository ownership, exact PRD threshold mapping, immutable
membership and digests, human rights approval, no learner PII, portable
runners, target-environment execution, deterministic scoring, human-review
authority, complete sanitized evidence, dependency currentness, fail-closed
promotion, storage separation, deletion applicability, and rejection of ad
hoc or externally authoritative evidence remain unchanged.

This verdict approves no corpus, paid capacity, production deployment, pilot,
external upload, or EPUB/DOCX support. A fast-follow format becomes product
support only through a later PRD revision and a newly versioned evaluation
contract with deterministic format-native eligibility; renderer-derived or
invented page counts are not acceptable substitutes.

### Rationale

A coordinated version family makes the approved product boundary executable
and keeps every historical artifact's meaning stable. Explicit rejection
routes turn the deferred formats into tested negative cases instead of silent
or accidental support. Superseding current v1 attestations prevents stale
multi-format evidence from authorizing the PDF-only release.

## Verification

Schema and TypeScript tests require the exact v2 identities, reject EPUB/DOCX
performance items, enforce non-null PDF page counts from 5 through 200, and
retain the v1 schemas unchanged. Contract tests require all PDF performance
strata plus the explicit DOCX and EPUB rejection routes. API and UI tests prove
that only bounded `.pdf` selections are advertised and accepted and that
unsupported media receives clear PDF-only guidance before processing.

Database migration tests and canonical-schema comparison prove v1/v1 and
v2/v2 pairing, reject cross-version pairs, require every v1 row to be
superseded, and keep at most one current environment/gate verdict. Publisher
and index tests use v2. Existing ADR 0015 evidence, currentness, privacy,
rights, scoring, and fail-closed tests remain green.

## Reversal criteria

Supersede this record when the PRD authorizes another ingestion format, a
format-native corpus and eligibility contract is ready, or release-gate
evidence needs another semantic change. Any successor must preserve immutable
historical meaning, prevent cross-version aggregation, invalidate stale
current attestations, and retain ADR 0015's repository-owned, rights-approved,
privacy-safe, target-bound, deterministic, and fail-closed guarantees.
