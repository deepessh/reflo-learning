---
id: "0022"
title: "Single-segment Wan sprint prototype and long-form deferral"
status: Accepted
date: "2026-07-22"
aliases: [D-GH-120]
prd_references: "`prds/reflo-prd.md` §6 F2, §7, §9, §12, §13, and §14; mandate M-005; D-GH-4, D-GH-10, D-GH-12, D-GH-13, and D-GH-14"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #38 for the bounded prototype; future production composition requires separately triaged fast-follow work"
authorization:
  decider: "@deepessh, repository owner and founding-team product/decision authority named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/120
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/120#issuecomment-5051564255
  record_pr: https://github.com/deepessh/reflo-learning/pull/122
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0022: Single-segment Wan sprint prototype and long-form deferral

## Context

Wan 2.7 produces one bounded video per asynchronous task, while the earlier PRD target of one 60–120 second explainer would require multi-segment storyboarding, durable child operations, trusted composition, narration timing, continuity validation, and materially more quality and cost evidence. The sprint needs a bounded Wan production-path proof without allowing speculative P1 composition work to displace P0 exit gates. This verdict and the matching PRD v1.8 revision control only the sprint video scope, single-segment boundary, prototype labeling, and deferral of long-form composition. They do not replace the existing provider, router, retry/finalization, private-delivery, feature-flag, source-provenance, content-rights, quota, spending, or quality controls; enable the P1 runtime flag; approve provider access or capacity; certify a live artifact; or authorize full-course generation.

## Options

Compose 4–8 source-backed Wan segments into a 60–120 second asset during the sprint; keep one bounded 15-second generation as a labeled sprint prototype and defer production composition; or revise the PRD to select a provider path that natively produces the earlier duration.

## Decision

### Authorized verdict

Keep exactly one source-backed nominal 15-second hardest-concept Wan generation in sprint scope as a default-off P1 prototype. Use one D-GH-12 durable operation and one accepted provider task through D-GH-10 `media.video.v1`; preserve source-span and model/prompt/version provenance, bounded media validation, no blind resubmission after provider acceptance, trusted private-asset finalization, and D-GH-13 delivery controls. The prototype creates no P0 text/audio dependency and is not learner-visible unless every D-GH-14 gate and other applicable approval is current. Present it as a prototype unless those separate runtime eligibility gates pass. Do not add a stitching or composition library, multi-segment child-operation orchestration, or claim 60–120 second continuity, latency, or visual-quality acceptance. Do not attempt full-course generation. Move production 60–120 second storyboarding, continuity, trusted composition, and full-course video to post–Demo Day fast-follow work. Live generation remains blocked until rights-cleared material, Model Studio access, and quota/spending authorization as applicable are recorded; this verdict authorizes none of them.

### Rationale

A single provider task exercises the real Wan adapter, shared router, asynchronous reconciliation, provenance, media validation, and private-asset boundary while keeping the experiment small, honestly labeled, and isolated from P0 delivery. Chaining independently generated clips before live evidence would commit the sprint to an unproven continuity and narration strategy, add a trusted media runtime and new failure modes, increase provider cost and retry exposure, and still require human visual review. Deferral preserves the useful production-path proof without treating deterministic stitching as a solution to probabilistic visual discontinuity.

## Verification

PRD and scope checks identify one nominal 15-second prototype and classify production 60–120 second composition and full-course generation as fast-follow. Router and adapter tests prove one logical operation maps to at most one accepted provider task, a timeout after acceptance cannot resubmit blindly, the validated result is a single allowlisted media payload with complete source and route provenance, and finalization remains authoritative under D-GH-12. Static and dependency checks reject a compositor dependency or multi-segment orchestration added under #38. P1 tests keep video default-off and reject enqueue, provider access, publication, signing, or delivery when the flag, P0-preservation policy, approvals, or evidence are absent or stale. P0 tests prove text and audio work unchanged with video unavailable. Demo and documentation checks label the artifact as a prototype unless separate runtime gates pass and reject claims of 60–120 second or full-course acceptance.

## Reversal criteria

Revisit through new product authority and a separately triaged decision when measured live prototype evidence supports a production-video investment, Wan or another PRD-authorized route can satisfy long-form duration and continuity with materially lower composition risk, or post–Demo Day priorities bring production explainers into an active milestone. Any successor must preserve P0 priority, default-off P1 enforcement, source grounding and complete provenance, no duplicate paid submissions, trusted finalization, private delivery, honest labeling, and all applicable rights, quota, spending, privacy, security, and quality gates.
