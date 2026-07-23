---
id: "0015"
title: "Repository-owned release-gate evaluation evidence"
status: Accepted
date: "2026-07-20"
aliases: [D-GH-15]
prd_references: "`prds/reflo-prd.md` §6 F7, §11, and §13; D-GH-3, D-GH-5, D-GH-10, D-GH-13, D-GH-14, and pending issue #18"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the evaluation harness, dataset manifests, gate-attestation publisher and index, target-environment benchmark runners, and release-gate evidence issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/15
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/15#issuecomment-5027987825
  record_pr: https://github.com/deepessh/reflo-learning/pull/92
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0015: Repository-owned release-gate evaluation evidence

## Context

Reflo must turn the PRD performance, audio, quiz-quality, grading-accuracy, artifact-grounding, and adversarial requirements into reproducible evidence that production promotion, pilot activation, and P1 prerequisites can consume without trusting mutable dashboards, favorable samples, or ad hoc scripts. This verdict controls the repository-owned evaluation contract, dataset and annotation identity, authoritative execution boundaries, scoring and review authority, evidence-bundle and gate-attestation formats, currentness and aggregation, the trusted environment-scoped attestation index, and the sprint role of external evaluation platforms. It does not change any PRD threshold, sample size, timing, content-rights, privacy, consent, deletion, or pilot requirement; approve a particular corpus, learner-data use, paid service, storage capacity, or production deployment; replace D-GH-5 promotion controls, D-GH-10 model provenance, D-GH-13 client delivery, D-GH-14 prerequisite enforcement, or issue #18 retention and deletion execution; or make GitHub comments runtime authority.

## Options

Repository-owned manifests, portable runners, deterministic scorers, and production evidence; an external evaluation platform as the authoritative harness or evidence store; ad hoc scripts without a shared versioned contract.

## Decision

### Authorized verdict

Adopt `evaluation-contract-v1`. Checked-in code owns versioned gate-contract, dataset-manifest, annotation and attestation schemas; exact PRD threshold mappings; deterministic scorers and aggregation; portable runners and reproducibility checks; and small synthetic or redistribution-cleared fixtures. Larger rights-cleared corpora and authoritative run bundles use SHA-256-addressed objects in a separate private, encrypted, environment-isolated internal OSS bucket that is never the D-GH-13 client-delivery bucket or exposed through CDN. An existing digest cannot identify different bytes. Content addressing grants no retention, deletion, consent, or rights-withdrawal exemption, and this verdict approves no new paid capacity or service expenditure.

Each authoritative dataset version freezes its schema version, exact item membership and digests, required document and threat strata, held-out status, intended gates, predeclared selection and sampling method and seed, all pre-run exclusions with reasons, annotation, rubric, reviewer and adjudication protocol versions, and human-approved rights references. Changes to content, membership, labels, eligibility, strata, or adjudication create a new version. Post-run failures, timeouts, retries, terminal errors, or unfavorable results cannot be excluded or reclassified. This verdict approves no corpus: each one still requires the PRD human-approved rights record. V1 authoritative corpora and bundles contain no learner PII, assessment data, or learner-uploaded content. Any future exception requires separate authorization, remains subject to the PRD and issue #18, and invalidates dependent attestations when required evidence is deleted.

CI validates contracts, manifests, membership and digests, rights-reference presence, frozen fixtures, deterministic scoring and aggregation, reproducibility, sanitization, and fail-closed malformed-evidence behavior. CI alone cannot pass the performance or audio gates. Those gates run in the target production deployment with the exact PRD cold-cache, concurrency, sample, repetition, capacity, and quota profiles. Adversarial authorization, cross-scope, citation, prompt-injection, grading-manipulation, and tool-policy assertions run end-to-end through real or production-equivalent authorization, retrieval, model-routing, citation, and tool boundaries. Quiz, grading, and grounding suites may run elsewhere only when the evidence binds to the exact deployable, prompt, route, resolved model, adapter, schema, artifact, and relevant configuration identities being released.

Deterministic measurements are authoritative for mechanical criteria including latency, counts, failures, timeouts, persisted source references, authorization outcomes, citation resolution, and security assertions. Human-adjudicated labels are authoritative for subjective quiz answerability, keyed-answer correctness and distractor plausibility, short-answer grading gold labels and bands, claim entailment and safety severity, and the required two-reviewer audio assessment. Deterministic scoring against frozen human labels is authoritative. LLM-assisted review may support diagnostics but cannot be the sole authority for subjective labels or replace required human review. Each gate applies its own PRD thresholds and hard failures; zero-tolerance failures cannot be averaged away. Results with different dataset, scorer, deployable, route, or model versions cannot be combined unless the versioned gate contract explicitly authorizes and validates the composition.

Every authoritative run emits a sanitized content-addressed evidence bundle containing the source commit and deployable digest; environment and relevant infrastructure or configuration fingerprints; harness, gate, dataset, manifest, annotation, rubric, scorer, prompt, route-policy, resolved model, adapter, schema, and generated-artifact identities; applicable cache, concurrency, capacity, quota, rights, reviewer, adjudication, and approval references; timestamps and declared seeds; every per-sample miss, retry, failure, and timeout; aggregate counts and distributions required by the PRD; bounded sanitized diagnostics; and the bundle digest. An authorized publisher emits an environment-scoped `gate-attestation-v1` with `passed`, `failed`, or `indeterminate`; the exact PRD gate and contract version; bundle, environment, and deployable identities; relevant dependency fingerprints; mutable approval, capacity, quota, rights, and provider-evidence references and validity; publication time; and publisher identity. Through D-GH-3, RDS stores the trusted current attestation index containing verdict metadata and references, not raw evaluation content. D-GH-5 and D-GH-14 consume that index. GitHub records only safe summaries and digests.

An attestation is current only while its environment and deployable match the active release, every declared relevant dependency fingerprint matches, required rights remain valid, mutable provider, quota, capacity, privacy, and operational evidence remains valid, and no later authoritative result invalidates or supersedes it. A relevant change invalidates only dependent gates and requires their rerun. Missing, malformed, unauthorized, mismatched, expired, deleted, or unverifiable evidence is `indeterminate`; both `failed` and `indeterminate` evaluate false for promotion, release, pilot, and feature prerequisites. Reject ad hoc scripts. Reject an external evaluation platform as a required or authoritative sprint dependency. A future supplementary platform must export complete evidence into the Reflo-owned contract, remain non-authoritative, and receive every applicable privacy, rights, provider, and spending approval.

### Rationale

Repository ownership makes gate meaning, dataset identity, scoring, provenance, and currentness reviewable and portable while allowing the measurements that depend on real caches, capacity, authorization, routing, and infrastructure to execute in the correct environment. Predeclared membership and exclusions prevent cherry-picking, frozen human labels separate subjective adjudication from deterministic scoring, and a fail-closed RDS index gives promotion and feature consumers one trusted verdict surface without treating GitHub or an external dashboard as authority. The split avoids adding another processor and vendor dependency during the sprint while preserving a future supplementary integration path.

## Verification

Schema and fixture tests reject unknown contract versions, duplicate or changed item identities, digest mismatches, missing rights references, undeclared strata or exclusions, post-run sample removal, invalid labels, unbounded diagnostics, PII or learner-content fields, incomplete provenance, and non-deterministic scoring. Execution tests prove CI cannot assert production-only gates, target runs use the required cache, concurrency, count and repetition profiles, adversarial suites traverse production-equivalent boundaries, and offline suites bind to exact released identities. Reviewer tests require the specified human adjudication for subjective criteria while permitting deterministic mechanical assertions. Attestation tests cover authorized publication, all three statuses, dependency-specific invalidation, mutable-evidence expiry, supersession, deletion, cross-version aggregation rejection, zero-tolerance failures, and fail-closed D-GH-5 and D-GH-14 consumption. Storage and privacy tests prove environment isolation, separation from client delivery, digest immutability while retained, sanitized GitHub summaries, no v1 learner data, and no retention exemption. Import and workflow checks reject authoritative ad hoc scripts or external dashboards.

## Reversal criteria

Supersede if the portable harness cannot support the PRD datasets, human-review throughput, target-environment execution, or evidence consumption within the sprint, or a different approach measurably reduces delivery risk without weakening repository-owned gate definitions, exact dataset identity, rights approval, deterministic scoring, production-bound evidence, environment-scoped currentness, fail-closed attestations, privacy and deletion compliance, complete evidence export, or independence from mutable proprietary evidence.
