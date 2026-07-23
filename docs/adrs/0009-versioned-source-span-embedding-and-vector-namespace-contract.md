---
id: "0009"
title: "Versioned source-span, embedding, and vector-namespace contract"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-9]
prd_references: "`prds/reflo-prd.md` §6 F1, §9, §10, and §11; mandate M-001"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the secure-ingestion, vector-adapter, source-span, and grounded-retrieval implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/9
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/9#issuecomment-5015788306
  record_pr: https://github.com/deepessh/reflo-learning/pull/72
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0009: Versioned source-span, embedding, and vector-namespace contract

## Context

Reflo needs reproducible source spans, embeddings, retrieval, owner isolation, re-indexing, and deletion behavior in the PRD-mandated AnalyticDB for PostgreSQL store. This verdict controls canonical chunk boundaries and locators, embedding identity and drift handling, the logical and physical vector-namespace layout, exact and approximate search activation, embedding-generation lifecycle, and vector deletion behavior. It does not revisit the AnalyticDB mandate, choose parsers or isolated-worker technology, define general provider-adapter or authorization architecture, authorize a reranker or sparse-vector path, or replace the PRD's grounding, privacy, deletion, and performance gates; those remain with M-001, issues #8 and #10, D-GH-4, D-GH-7, and the PRD.

## Options

Fixed token windows; hierarchical chapter/section parent-child chunks; deterministic structure-aware bounded semantic leaf chunks. Physical per-owner schemas/tables versus a shared contract-versioned table with logical owner namespaces. Provider-managed automatic chunking/embedding versus a Reflo-owned versioned contract. Exact search only versus benchmark-gated HNSW activation.

## Decision

### Authorized verdict

Adopt `chunk-v1`, `embedding-v1`, and `vector-namespace-v1`. `chunk-v1` deterministically packs canonical parsed blocks within one logical section toward approximately 450 tokens, merges fragments below approximately 150 tokens when possible without crossing sections, treats page boundaries as locators rather than mandatory splits, uses no overlap normally and at most one sentence or 64 tokens only when splitting an oversized semantic block, preserves lists and tables under the limit, and caps the complete submitted embedding input—including breadcrumbs, overlap, and repeated table headers—at 700 tokens under a named versioned tokenizer. Canonical source text is unchanged text from the versioned normalized parse; citations resolve only from that text through ordered page/section mappings and half-open canonical offsets. Persist parser, chunker, tokenizer, embedding-input-profile, locator, and text-hash provenance and derive stable span IDs from the source document, contract versions, ordered locators, and text hash. `embedding-v1` uses Alibaba Model Studio `text-embedding-v4`, dense 1024-dimensional vectors, cosine distance, `text_type=document` for source spans, and `text_type=query` for queries; it adds no custom instruction without a frozen evaluation. Persist the region/endpoint, provider identifier and available response metadata, dimensions, input mode and profile, input hash, request ID, timestamps, and outcome. Frozen embedding/retrieval canaries detect provider-alias drift; announced or detected behavior changes create a new evaluated profile and generation, and different profiles never share an index. Within each physically isolated environment, `vector-namespace-v1` is the logical `(environment, owner_scope_id)` namespace in one shared contract-versioned AnalyticDB table/collection rather than per-learner schemas, tables, or indexes. Every key and uniqueness constraint begins with non-null `owner_scope_id`; vector operations accept a server-issued authorization context and must constrain and revalidate owner scope, source-document status, active generation, and non-deleted retention state before canonical text enters model context. Exact cosine search is the sprint default. HNSW requires a frozen benchmark showing material latency benefit, recall@10 of at least 0.98 against exact search, correct filtered behavior without scoped under-return, and no scope or generation contamination; it must use cosine and may not initially use product quantization. Each rebuild creates an immutable generation stored under `(owner_scope_id, source_span_id, embedding_generation_id)`, builds and validates side-by-side, and atomically changes the authoritative RDS active-generation pointer at the source-document level; failure leaves the old generation active. Chunk-policy changes create new spans, embedding-only changes reuse spans, and superseded vectors retire only after the rollback window. Deletion synchronously makes the owner/source non-retrievable in RDS, requires retrieval-time authorization and retention rechecks, and asynchronously purges every vector generation with retries and audit evidence within the PRD's 24-hour requirement; rollback and fallback cannot bypass tombstones.

### Rationale

Structure-aware bounded chunks preserve semantic units and citation precision without the duplicate storage and two-stage retrieval complexity of hierarchical parent-child indexing. The current Alibaba guidance recommends `text-embedding-v4` and 1024 dimensions for general-purpose text retrieval, while explicit input and generation profiles make a mutable provider alias testable. A shared table keeps schema, index, migration, deletion, and re-index operations bounded; the logical owner namespace plus D-GH-7's mandatory server-resolved scope enforcement prevents cross-scope access without relying on dynamic per-learner database objects. Exact search gives deterministic full recall for the small pilot corpus, while evidence-gated HNSW preserves a safe performance path as the corpus grows.

## Verification

Deterministic PDF, EPUB, and DOCX fixtures prove canonical offsets, page/section mappings, stable IDs, complete provenance, section isolation, table/list behavior, and the full-input hard cap. Contract tests reject missing or forged authorization contexts, omitted or replaced filters, cross-scope batch writes, searches, and deletes, stale or deleted sources, inactive generations, contaminated results, dimension or metric mismatches, and query/document input-mode errors. Frozen canaries detect embedding behavior drift. Re-index tests cover idempotent side-by-side builds, completeness, no-orphans, activation, failure, rollback, and retirement. Deletion tests deny retrieval synchronously and purge every generation without resurrection. HNSW remains unavailable until filtered exact-versus-approximate recall, under-return, grounding, contamination, and latency fixtures satisfy the authorized activation criteria.

## Reversal criteria

Supersede if measured retrieval quality requires hierarchical or differently bounded chunks, `text-embedding-v4` cannot meet grounding or operational gates, provider alias drift cannot be detected reliably, the shared-table scope contract cannot preserve zero cross-scope disclosure, or exact/HNSW behavior cannot meet the required recall and latency envelope. Any replacement must preserve stable source provenance, owner-scoped fail-closed retrieval, generation-safe re-indexing, deletion across all generations, the PRD grounding and privacy gates, and M-001 unless the PRD itself changes.
