---
id: "0010"
title: "Typed model routing, prompt, provenance, retry, and trace contract"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-10]
prd_references: "`prds/reflo-prd.md` §6 F2–F5, §9, and §11; mandate M-002"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the model-router, prompt-registry, model-provenance, and tracing implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/10
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/10#issuecomment-5016680211
  record_pr: https://github.com/deepessh/reflo-learning/pull/73
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0010: Typed model routing, prompt, provenance, retry, and trace contract

## Context

Every model call must use the PRD-mandated shared traced router, but direct provider calls and a universal completion-shaped gateway cannot preserve the distinct contracts of grounded generation, grading, embedding, speech, and video. This verdict controls semantic task IDs, the initial versioned route matrix, prompt and result contracts, model-call provenance, immediate provider-attempt policy, the trace envelope, and router fakes. It does not replace D-GH-4's provider adapter boundary, D-GH-9's embedding and vector contract, #11's fallback TTS choice, #12's queue retry/DLQ/idempotency/finalization rules, #14's feature-flag enforcement, #17's grading rubric and confidence policy, #18's retention/deletion/final telemetry policy, #15's release-gate evaluation evidence, or the orchestrator's re-teach trigger and similarity rules.

## Options

Typed semantic task routes coordinating narrow capability ports; one generic completion gateway; direct provider SDK calls from feature and domain code.

## Decision

### Authorized verdict

Adopt a typed semantic task router coordinating the narrow capability ports established by D-GH-4. Every operation has a stable task ID, versioned input and result contract, immutable prompt bundle where applicable, and an entry in `route-policy-v1`. The initial matrix is: `curriculum.structure.v1` to an approved Qwen structured selector with a strict curriculum result and no fallback; `lesson.text.v1`, `lesson.reteach.v1`, and `lesson.audio-script.v1` to an approved Qwen grounded-generation selector with typed, source-provenance-carrying lesson or narration results and no fallback; `assessment.quiz.v1` to an approved Qwen structured selector with a strict quiz-item result and no fallback; `assessment.grade-short-answer.v1` to an approved Qwen grading selector with a strict evidence-candidate result and no fallback; `tutor.answer.v1` to an approved Qwen grounded-dialogue selector with authorized source-span IDs or a not-found result and no fallback; `embedding.document.v1` and `embedding.query.v1` to D-GH-9 `embedding-v1` using `text_type=document` and `text_type=query` respectively and no fallback; `media.tts.v1` to Qwen-TTS primary with the common audio-asset result and fallback only when #11 authorizes it; and `media.video.v1` to Wanx with a video-asset result, no fallback, and availability only while its P1 default-off flag and applicable gates are current. Each semantic selector resolves through validated allowlisted configuration to exactly one concrete provider model per environment; feature and domain code never select models or name providers. Prompt bundles keep fixed instructions, source material, learner answers, tool declarations, output schemas, and generation parameters in distinct typed fields. Uploaded or retrieved content and learner answers are untrusted data and cannot change instructions, authorization, tools, rubrics, schemas, or citation rules. Tools are operation-specific and least-privilege, and displayed citations resolve server-side from authorized source-span IDs. Structured operations reject schema-invalid results; text and media operations validate typed envelopes and provenance before success or persistence. Persist the task and route-policy versions, prompt ID and immutable digest, input/result schema and generation-parameter versions, adapter version, requested selector, effective provider model/version, and validation outcome. Model changes require controlled route-policy activation, and mutable aliases require drift canaries. Router retries apply only to eligible transient failures and are bounded by attempt count and the caller's total deadline; language and embedding routes permit at most two immediate attempts, while media submits once unless its adapter proves submission idempotency. There is no generic fallback, hedging, or shadow sending. Emit one logical-call trace with sanitized per-attempt spans and a deny-by-default field allowlist; allowed fields include task and policy versions, model identifiers, timing and usage, normalized outcomes, retry reasons, and validation status, while raw prompts, source passages, learner answers, generated content, contact data, provider payloads, credentials, and raw diagnostics are prohibited. Provide deterministic scriptable fakes and router tests. Reject a generic completion gateway and direct provider SDK access from feature or domain code.

### Rationale

Typed semantic routes make task-to-model policy explicit and reproducible without collapsing distinct model and media semantics into a weak common denominator. Immutable prompt and schema identities preserve grading and artifact provenance, deny-by-default tracing satisfies the PRD's PII-minimization rule, and bounded non-hedged attempts avoid duplicate work while retaining safe transient recovery. Explicit boundaries preserve the independently authorized adapter, embedding, TTS, queue, grading, privacy, feature, and evaluation decisions.

## Verification

Import checks reject provider SDK access and provider/model branching in feature and domain code. The router rejects unknown tasks, selectors, prompt or schema versions, unavailable adapters, schema-invalid structured results, invalid typed envelopes, unapproved fallback, late or duplicate success, more than two immediate language or embedding attempts, and media resubmission without proven idempotency. Contract tests cover every route, prompt immutability, selector resolution, persisted provenance, mutable-alias drift, untrusted-content containment, operation-specific tool declarations, server-resolved citations, transient retry deadlines, authorized and unauthorized fallback, P1 video gating, and deterministic failure sequences. Trace tests prove one logical call with per-attempt spans and reject every non-allowlisted or prohibited content field. D-GH-4 conformance suites remain authoritative for adapters; #15 owns release-gate evaluation evidence.

## Reversal criteria

Supersede if measured router overhead prevents the PRD SLOs, typed task contracts cannot express a required model operation without pervasive escape hatches, prompt or route activation cannot be made reproducible, or the trace contract cannot satisfy production diagnosis without weakening privacy. Any replacement must preserve M-002, D-GH-4's adapter boundary, D-GH-9's embedding contract, fail-closed routing, artifact and grading provenance, untrusted-content isolation, P1 gates, and PII-minimized tracing.
