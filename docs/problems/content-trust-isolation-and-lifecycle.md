# Content trust, isolation, and lifecycle

> **Non-authoritative:** This document explores a durable architectural problem. It does not authorize architecture, record a decision, or track delivery work. Product requirements remain in the [PRD](../../prds/reflo-prd.md), and effective implementation verdicts remain in the [decision register](../../DECISIONS.md).

## Problem

Reflo turns learner-supplied documents into parsed text, embeddings, curriculum,
assessment items, and private media. The source crosses several execution and
storage boundaries while remaining untrusted, owner-scoped, rights-sensitive,
and deletable. A weakness at any transition can expose another learner's
material, let document text influence privileged behavior, leave derived copies
behind after deletion, or make a legitimate source impossible to audit.

The durable problem is preserving one understandable trust and ownership
boundary from upload through every derivative and eventual erasure, even as
parsers, model providers, storage systems, and delivery mechanisms change.

## Forces and constraints

- Source formats vary in structure, compression behavior, scan quality, and
  parser risk. The standard path, large-document path, OCR path, and clear
  failure paths have different operational envelopes without changing the
  treatment of source content as untrusted data.
- A course, source document, source span, embedding namespace, generated asset,
  and signed delivery request share an owner scope, but they live in systems
  with different authorization and consistency mechanisms.
- Retrieval must apply scope filters before content enters model context.
  Citations must resolve through authorized server-side source-span identities
  rather than labels or locations supplied by a model.
- Private source and generated assets need short-lived delivery access while
  durable storage remains inaccessible to public callers and unrelated
  workloads.
- Deletion and consent withdrawal reach transactional data, vectors, object
  storage, queues, caches, traces, evaluation exports, and backups on different
  clocks. The final audit evidence cannot retain a subject identifier.
- Product limits, ingestion SLOs, rights evidence, malware handling, and
  authorization guarantees are product constraints rather than conclusions of
  this document.

## Risks

- A parser or OCR dependency gains ambient credentials or network access and
  turns malformed content into a cross-boundary execution path.
- Scope is checked at the API edge but lost in a queue message, vector query,
  asset lookup, cache key, or retry path.
- Source text is interpreted as an instruction that can alter prompts, tools,
  grading, citation behavior, or authorization filters.
- Derived data loses its source-span or owner-scope lineage, making grounding,
  access review, or deletion incomplete.
- Signed URLs, CDN caches, or provider-held media outlive the access or consent
  state that justified them.
- Deletion evidence remains linkable to the deleted learner, or a nominally
  complete deletion omits a retry queue, dead-letter path, trace, or evaluation
  copy.

## Evidence to preserve

- Boundary tests showing that file signature, resource-limit, malware, and
  isolation controls fail closed across representative document classes.
- Authorization tests that exercise direct, queued, cached, retrieval, signing,
  and retry paths with cross-scope attempts.
- Provenance joins from an authorized source span to each derivative without
  relying on model-generated locators.
- Deletion reconciliation evidence by store and retention class, including
  failure visibility before completion and a non-linkable terminal receipt.
- Adversarial-document results demonstrating that source content cannot change
  policy, invoke unintended capabilities, or manufacture an authorized
  citation.

## Open questions

- Which invariants can be enforced once in shared contracts, and which need
  independent enforcement because a runtime or store has a distinct trust
  boundary?
- How can lineage remain inspectable when progressive work is retried,
  superseded, or regenerated under a new parser, embedding, or prompt version?
- What is the smallest deletion receipt that proves store coverage and timing
  without creating a durable subject lookup?
- How should access revocation interact with already issued URLs, provider
  jobs, caches, and offline material while preserving the product's stated
  behavior?

## Related authoritative sources

- [PRD §6, F1 and F7; §9; §10; §11](../../prds/reflo-prd.md)
- [D-GH-7 — layered owner-scope enforcement](../../DECISIONS.md#d-gh-7--layered-owner-scope-enforcement)
- [D-GH-8 — isolated local document parsing, scanning, and OCR](../../DECISIONS.md#d-gh-8--isolated-local-document-parsing-scanning-and-ocr)
- [D-GH-9 — versioned source-span embedding and vector namespace contract](../../DECISIONS.md#d-gh-9--versioned-source-span-embedding-and-vector-namespace-contract)
- [D-GH-13 — private OSS delivery, CDN signing, expiry, and invalidation](../../DECISIONS.md#d-gh-13--private-oss-delivery-cdn-signing-expiry-and-invalidation-contract)

The corresponding [ADR mirrors](../adrs/README.md) are navigation aids during
coexistence and do not replace these authoritative sources.
