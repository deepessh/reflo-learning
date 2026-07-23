---
id: "0011"
title: "CPU fallback TTS and layered audio-asset contract"
status: Accepted
date: "2026-07-20"
aliases: [D-GH-11]
prd_references: "`prds/reflo-prd.md` §6 F2, §9, §10, §11, and §13; D-GH-4, D-GH-10, D-GH-12, and D-GH-13"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the TTS adapters, CPU media worker, model router, audio finalizer, and release-gate implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/11
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/11#issuecomment-5027808188
  record_pr: https://github.com/deepessh/reflo-learning/pull/91
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0011: CPU fallback TTS and layered audio-asset contract

## Context

P0 chapter audio needs a Qwen-TTS primary plus a quota-independent non-GPU fallback that produces the same authorized asset contract and passes the target-production latency and listening gate. The fallback must remain independently operable without making an adapter authoritative for owner scope, durable operation state, object identity, or delivery authorization. This verdict controls the fallback engine and initial voice candidate, dependency and artifact pinning, the TTS request and audio-payload boundaries, fallback eligibility, and fallback-specific activation evidence. It does not change Qwen-TTS as the PRD primary; authorize paid CPU, managed speech, or other capacity; certify GPL compliance; make the initial voice production-eligible without evidence; replace D-GH-10 routing and trace rules, D-GH-12 durable-operation semantics, D-GH-13 private delivery, or the PRD audio gate; or define the implementation work item's deployment topology beyond a bounded CPU-only media worker.

## Options

A local CPU TTS adapter using Piper, Kokoro, or MeloTTS; a separately provisioned managed non-GPU TTS service; and pre-generation only.

## Decision

### Authorized verdict

Adopt `tts-fallback-v1` for D-GH-10's `media.tts.v1` route. Qwen-TTS remains primary. Select Piper CPU TTS as the quota-independent non-GPU fallback behind D-GH-4's narrow speech capability port. Use the established Python inference path with `piper-tts==1.4.2`; do not depend on Piper 1.5.0's newly reintroduced C++ CLI unless a later versioned profile passes the same target-container regression and release gates. Run the adapter only on CPU in a bounded non-GPU media worker. Pin the base image, Python runtime, Piper wheel and published digest, ONNX Runtime, embedded eSpeak components, voice model and configuration, and final image digest. Mirror model artifacts during the controlled build, verify recorded SHA-256 digests, and prohibit runtime downloads and mutable artifact references.

The initial voice-profile candidate is `en-US/reflo-narrator-v1`, mapped only inside the Piper adapter to `en_US-ljspeech-high`. Before activation, record the immutable artifact revision, model and configuration SHA-256 values, model card, and public-domain dataset evidence, and pass the complete PRD audio gate. Treat the model card's inconsistent quality and sample-rate metadata as test evidence rather than silently normalizing it. Do not use the Lessac voice without a separate human legal/compliance verdict clearing its restrictive source-dataset terms. Unsupported locale or profile combinations fail closed without implicit English substitution. Additional mappings require versioned artifacts and the same license, quality, capacity, and conformance evidence.

Piper is GPL-3.0-or-later. This verdict selects the engine but does not certify the binary or container distribution posture. Pilot activation requires a separately recorded human legal/compliance clearance covering the intended packaging, deployment, source-offer and notice obligations, and distribution model. Generated audio is not the licensing decision surface. This verdict authorizes no new ECS, reserved CPU, managed-service, or other spend; capacity that can incur new charges still requires the named-human approval in `AGENTS.md`.

Separate the boundary into three contracts. `tts-synthesis-request-v1` is created within one D-GH-12 operation after current owner scope, retention state, provenance, and route/profile eligibility are reauthorized. Queue envelopes contain only opaque references. The trusted caller resolves the narration and passes the adapter the operation or generation reference, server-resolved text, script digest, locale, approved provider-neutral profile, bounded speaking-rate multiplier, output requirements, and original absolute deadline; these values are input, never authority. `audio-payload-v1` contains only controlled WAV/PCM-S16LE/mono bytes or a job-scoped temporary handle plus actual sample rate, channel count, duration, byte length, payload SHA-256, engine/voice/settings provenance, and header and integrity validation. Version 1 permits explicitly recorded 22,050 Hz and 24,000 Hz output so the adapters do not require quality-losing resampling merely to share a contract. The payload contains no application authorization result, canonical OSS key, signed URL, or terminal operation state. The trusted finalizer validates that payload and alone assigns and persists `Asset` and generation identities, narration-script reference and digest, source spans, task/route/adapter/engine/voice/artifact/settings provenance, validation state, and the D-GH-13 canonical private OSS key. D-GH-12 compare-and-set finalization and D-GH-13 delivery remain authoritative.

Fallback is permitted only for normalized transient unavailability, capacity, quota, or rate-limit failures when the primary is known not to have accepted work, or after D-GH-12 reconciliation proves an ambiguous primary submission has no live or terminal result. A timeout alone is not proof of non-acceptance. Preserve the original operation identity, idempotency key, attempt budget, and deadline. Never hedge, shadow-send, or run both adapters concurrently. Never fall back for invalid input, unsupported locale or profile, authorization, policy, safety, retention, cancellation, or other deterministic failures. The first committed terminal state wins and a late result cannot replace it or create another asset.

Activation requires evidence from the target environment rather than a generic real-time claim. Record the exact CPU profile, vCPU and memory, worker count, cold start, concurrency limit, queue reservation, and existing or separately approved capacity. Both paths must run the PRD's at-least-30-script, five-course-concurrency benchmark, meet chapter-one p95 of at most ten minutes including validation and authorized OSS finalization, produce playable range-compatible private assets, and yield zero unintelligible samples in two-reviewer listening QA at 1.0× and 1.5×. The Week 1 gate remains failed until both paths and their capacity or quota evidence pass. Reject pre-generation because it cannot satisfy that gate. Reject a managed fallback by default while its free capacity is below the required concurrency or paid capacity lacks approval. Keep Kokoro as the named reversal candidate if Piper fails quality, throughput, dependency or security support, or GPL clearance.

### Rationale

Piper provides a small local ONNX-based CPU path that is operationally independent of Model Studio quota and produces WAV directly, while the older 1.4.2 Python path avoids making the sprint depend on a newly reintroduced native CLI. Keeping the voice mapping activation-gated acknowledges favorable public-domain dataset evidence without treating inconsistent model metadata as proof of quality. Separating adapter payload, durable operation state, and persisted assets prevents a provider or worker from acquiring authorization or storage authority. Explicit reconciliation and first-terminal-state-wins rules prevent fallback from duplicating media, and named legal, spending, capacity, and listening gates keep architecture approval from being misrepresented as production readiness.

## Verification

Import and composition checks permit Piper only inside the approved adapter and reject provider names in feature or domain code, unknown versions or profiles, mutable or runtime-downloaded artifacts, GPU providers, unpinned runtime components, and adapter-selected owner scopes, object keys, signed URLs, or terminal states. Build evidence records component and artifact digests, model-card and license provenance, a reproducible image and SBOM, and the separate human GPL clearance before activation. Contract tests run deterministic fakes plus both adapters through `tts-synthesis-request-v1` and `audio-payload-v1`, reject malformed headers, codecs, channel counts, sample rates, sizes, hashes, provenance, and temporary-handle escape, and prove trusted-only asset finalization. Failure-sequence tests reject hedging, fallback after invalid or policy failures, timeout-as-non-acceptance, changed operation identities or deadlines, duplicate or late finalization, and unsupported locale substitution. Target-environment evidence records the exact CPU envelope and proves both paths meet every PRD sample, concurrency, latency, authorization, range-playback, and two-reviewer listening requirement without unapproved spend; otherwise the adapter remains unavailable and the Week 1 gate remains failed.

## Reversal criteria

Supersede if Piper cannot pass listening quality or aggregate CPU throughput, the pinned runtime cannot be supported securely, the initial or alternative voice lacks acceptable rights evidence, GPL compliance cannot be cleared for the deployment model, or a different local CPU engine such as Kokoro meets the same gates with materially lower risk. A managed replacement additionally requires independently verified capacity, privacy, retention, deletion, data-location, and spending approvals. Any replacement must preserve Qwen-TTS as the PRD primary, D-GH-4 and D-GH-10 routing boundaries, the three-layer request/payload/asset contract, immutable provenance, owner-scope and private-delivery controls, D-GH-12 reconciliation and finalization, quota independence, CPU operation, and the full PRD audio gate.
