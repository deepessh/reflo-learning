# Reflo architecture

> **Non-authoritative:** This page is a reviewable projection of Reflo's decided
> target and repository-evidenced state. Product authority remains with the
> [PRD](../prds/reflo-prd.md); the linked
> [ADR records](adrs/README.md) authorize architecture and process decisions.

## Decided target architecture

**View contract:** this is the decided target, sourced from the active records below. It is not evidence of repository or runtime state.

The active index is generated from canonical ADR metadata. “Accepted” identifies
a decided target; it does not imply that its verification criteria have passed.
Detailed rules live in the linked records.

<!-- prettier-ignore-start -->
<!-- BEGIN GENERATED ACTIVE ADRS -->
| ADR | Decided target | Legacy IDs | Current authority |
|---|---|---|---|
| [ADR 0001](adrs/0001-repository-decision-authority-and-register.md) | Repository decision authority and register | `D-BOOTSTRAP-001` | ADR |
| [ADR 0002](adrs/0002-workspace-tooling-and-deployable-service-boundaries.md) | Workspace tooling and deployable service boundaries | `D-GH-2` | ADR |
| [ADR 0003](adrs/0003-sql-migrations-schema-ownership-and-write-boundaries.md) | SQL migrations, schema ownership, and write boundaries | `D-GH-3` | ADR |
| [ADR 0004](adrs/0004-provider-capability-ports-and-adapter-rollout.md) | Provider capability ports and adapter rollout | `D-GH-4` | ADR |
| [ADR 0005](adrs/0005-opentofu-infrastructure-environment-secret-and-promotion-controls.md) | OpenTofu infrastructure, environment, secret, and promotion controls | `D-GH-5` | ADR |
| [ADR 0006](adrs/0006-passwordless-email-authentication-and-revocable-server-sessions.md) | Passwordless email authentication and revocable server sessions | `D-GH-6` | ADR |
| [ADR 0007](adrs/0007-layered-owner-scope-enforcement.md) | Layered owner-scope enforcement | `D-GH-7` | ADR |
| [ADR 0008](adrs/0008-isolated-local-document-parsing-scanning-and-ocr.md) | Isolated local document parsing, scanning, and OCR | `D-GH-8` | ADR |
| [ADR 0009](adrs/0009-versioned-source-span-embedding-and-vector-namespace-contract.md) | Versioned source-span, embedding, and vector-namespace contract | `D-GH-9` | ADR |
| [ADR 0010](adrs/0010-typed-model-routing-prompt-provenance-retry-and-trace-contract.md) | Typed model routing, prompt, provenance, retry, and trace contract | `D-GH-10` | ADR |
| [ADR 0011](adrs/0011-cpu-fallback-tts-and-layered-audio-asset-contract.md) | CPU fallback TTS and layered audio-asset contract | `D-GH-11` | ADR |
| [ADR 0012](adrs/0012-durable-event-idempotency-retry-dlq-and-finalization-contract.md) | Durable event, idempotency, retry, DLQ, and finalization contract | `D-GH-12` | ADR |
| [ADR 0013](adrs/0013-private-oss-delivery-cdn-signing-expiry-and-invalidation-contract.md) | Private OSS delivery, CDN signing, expiry, and invalidation contract | `D-GH-13` | ADR |
| [ADR 0014](adrs/0014-p1-feature-flags-and-default-off-enforcement.md) | P1 feature flags and default-off enforcement | `D-GH-14` | ADR |
| [ADR 0015](adrs/0015-repository-owned-release-gate-evaluation-evidence.md) | Repository-owned release-gate evaluation evidence | `D-GH-15` | ADR |
| [ADR 0016](adrs/0016-provisional-bayesian-mastery-and-reproducibility-contract.md) | Provisional Bayesian mastery and reproducibility contract | `D-GH-16` | ADR |
| [ADR 0017](adrs/0017-worktree-based-issue-pickup-and-claim-labels.md) | Worktree-based issue pickup and claim labels | `D-GH-67` | ADR |
| [ADR 0018](adrs/0018-reproducible-agent-toolchain-and-required-check-recovery-policy.md) | Reproducible agent toolchain and required-check recovery policy | `D-GH-81` | ADR |
| [ADR 0019](adrs/0019-evidence-backed-contributor-agent-improvement-loop.md) | Evidence-backed contributor-agent improvement loop | `D-GH-83` | ADR |
| [ADR 0020](adrs/0020-java-25-base-family-for-the-isolated-ingestion-worker.md) | Java 25 base family for the isolated-ingestion worker | `D-GH-95` | ADR |
| [ADR 0021](adrs/0021-kms-backed-clamav-snapshot-signing-profile.md) | KMS-backed ClamAV snapshot signing profile | `D-GH-96` | ADR |
| [ADR 0022](adrs/0022-single-segment-wan-sprint-prototype-and-long-form-deferral.md) | Single-segment Wan sprint prototype and long-form deferral | `D-GH-120` | ADR |
| [ADR 0023](adrs/0023-analyticdb-for-postgresql-sprint-vector-store.md) | AnalyticDB for PostgreSQL sprint vector store | `M-001` | ADR |
| [ADR 0024](adrs/0024-shared-traced-model-routing-module.md) | Shared traced model-routing module | `M-002` | ADR |
| [ADR 0025](adrs/0025-versioned-bayesian-mastery-and-fsrs-scheduling.md) | Versioned Bayesian mastery and FSRS-style scheduling | `M-003` | ADR |
| [ADR 0026](adrs/0026-file-per-decision-adr-storage-and-lifecycle.md) | File-per-decision ADR storage and lifecycle | `D-GH-125` | ADR |
| [ADR 0027](adrs/0027-immutable-sequential-canonical-adr-identifiers.md) | Immutable sequential canonical ADR identifiers | `D-GH-126` | ADR |
| [ADR 0028](adrs/0028-product-requirements-and-architecture-document-authority.md) | Product requirements and architecture document authority | `D-GH-127` | ADR |
<!-- END GENERATED ACTIVE ADRS -->
<!-- prettier-ignore-end -->

### Target decision map

- Repository, delivery, and infrastructure boundaries:
  [ADR 0002](adrs/0002-workspace-tooling-and-deployable-service-boundaries.md),
  [ADR 0005](adrs/0005-opentofu-infrastructure-environment-secret-and-promotion-controls.md),
  [ADR 0012](adrs/0012-durable-event-idempotency-retry-dlq-and-finalization-contract.md),
  and [ADR 0015](adrs/0015-repository-owned-release-gate-evaluation-evidence.md).
- Content trust, scope, and retrieval:
  [ADR 0007](adrs/0007-layered-owner-scope-enforcement.md),
  [ADR 0008](adrs/0008-isolated-local-document-parsing-scanning-and-ocr.md),
  [ADR 0009](adrs/0009-versioned-source-span-embedding-and-vector-namespace-contract.md),
  [ADR 0013](adrs/0013-private-oss-delivery-cdn-signing-expiry-and-invalidation-contract.md),
  and [ADR 0023](adrs/0023-analyticdb-for-postgresql-sprint-vector-store.md).
- Model and media capabilities:
  [ADR 0004](adrs/0004-provider-capability-ports-and-adapter-rollout.md),
  [ADR 0010](adrs/0010-typed-model-routing-prompt-provenance-retry-and-trace-contract.md),
  [ADR 0011](adrs/0011-cpu-fallback-tts-and-layered-audio-asset-contract.md),
  [ADR 0022](adrs/0022-single-segment-wan-sprint-prototype-and-long-form-deferral.md),
  and [ADR 0024](adrs/0024-shared-traced-model-routing-module.md).
- Learner evidence and product controls:
  [ADR 0006](adrs/0006-passwordless-email-authentication-and-revocable-server-sessions.md),
  [ADR 0014](adrs/0014-p1-feature-flags-and-default-off-enforcement.md),
  [ADR 0016](adrs/0016-provisional-bayesian-mastery-and-reproducibility-contract.md),
  and [ADR 0025](adrs/0025-versioned-bayesian-mastery-and-fsrs-scheduling.md).
- Decision and contributor governance:
  [ADR 0001](adrs/0001-repository-decision-authority-and-register.md),
  [ADR 0017](adrs/0017-worktree-based-issue-pickup-and-claim-labels.md),
  [ADR 0018](adrs/0018-reproducible-agent-toolchain-and-required-check-recovery-policy.md),
  [ADR 0019](adrs/0019-evidence-backed-contributor-agent-improvement-loop.md),
  [ADR 0026](adrs/0026-file-per-decision-adr-storage-and-lifecycle.md),
  [ADR 0027](adrs/0027-immutable-sequential-canonical-adr-identifiers.md),
  and [ADR 0028](adrs/0028-product-requirements-and-architecture-document-authority.md).

## Implemented state

**View contract:** every row describes only the named implemented slice and must carry concrete evidence. A row does not prove its whole target ADR complete.

The inventory below describes checked-in repository state. It is not production
deployment, capacity, release-gate, or pilot-readiness evidence.

<!-- prettier-ignore-start -->
<!-- BEGIN IMPLEMENTED STATE -->
| Implemented slice | Evidence | Target ADRs |
|---|---|---|
| Independently buildable web, API, and jobs application boundaries | [web package](../apps/web/package.json), [API entry point](../apps/api/src/index.ts), [jobs entry point](../apps/jobs/src/index.ts), and [boundary check](../scripts/check-boundaries.mjs) | [ADR 0002](adrs/0002-workspace-tooling-and-deployable-service-boundaries.md) |
| Transactional schema ownership and migration boundary | [database package guide](../packages/db/README.md), [migrations](../packages/db/migrations), and [schema checks](../packages/db/test/schema.test.mjs) | [ADR 0003](adrs/0003-sql-migrations-schema-ownership-and-write-boundaries.md) |
| Typed capability routing, prompt provenance, retry policy, and tracing interfaces | [router implementation](../packages/model-router/src/router.ts), [routing policy](../packages/model-router/src/policy.ts), and [router tests](../packages/model-router/src/router.test.ts) | [ADR 0004](adrs/0004-provider-capability-ports-and-adapter-rollout.md), [ADR 0010](adrs/0010-typed-model-routing-prompt-provenance-retry-and-trace-contract.md), and [ADR 0024](adrs/0024-shared-traced-model-routing-module.md) |
| Passwordless account service and API composition slice | [account package guide](../packages/accounts/README.md), [account service](../packages/accounts/src/service.ts), and [API composition tests](../apps/api/src/account-composition.test.ts) | [ADR 0006](adrs/0006-passwordless-email-authentication-and-revocable-server-sessions.md), [ADR 0007](adrs/0007-layered-owner-scope-enforcement.md) |
| Isolated upload validation, quarantine, malware-snapshot, parser-worker, and normalized-output slice | [ingestion package guide](../packages/ingestion/README.md), [supervisor service](../packages/ingestion/src/service.ts), [worker entry point](../packages/ingestion/worker/src/main/java/com/reflo/ingestion/WorkerMain.java), and [worker policy tests](../packages/ingestion/src/worker-image-policy.test.ts) | [ADR 0008](adrs/0008-isolated-local-document-parsing-scanning-and-ocr.md), [ADR 0020](adrs/0020-java-25-base-family-for-the-isolated-ingestion-worker.md), and [ADR 0021](adrs/0021-kms-backed-clamav-snapshot-signing-profile.md) |
| Versioned source-span chunking and AnalyticDB retrieval adapter slice | [retrieval package guide](../packages/retrieval/README.md), [chunker tests](../packages/retrieval/src/chunker.test.ts), and [AnalyticDB adapter tests](../packages/retrieval/src/analyticdb.test.ts) | [ADR 0009](adrs/0009-versioned-source-span-embedding-and-vector-namespace-contract.md), [ADR 0023](adrs/0023-analyticdb-for-postgresql-sprint-vector-store.md) |
| Layered audio operation, fallback adapter, retry, and evidence-contract slice | [audio package guide](../packages/audio/README.md), [audio service](../packages/audio/src/service.ts), [Piper adapter](../packages/model-router/src/adapters/piper-process.ts), and [audio worker tests](../apps/jobs/src/audio-worker.test.ts) | [ADR 0011](adrs/0011-cpu-fallback-tts-and-layered-audio-asset-contract.md), [ADR 0012](adrs/0012-durable-event-idempotency-retry-dlq-and-finalization-contract.md) |
| Owner-scoped private asset object keys and signed-delivery service slice | [asset-delivery package guide](../packages/asset-delivery/README.md), [delivery service](../packages/asset-delivery/src/service.ts), and [deletion tests](../packages/asset-delivery/src/deletion.test.ts) | [ADR 0007](adrs/0007-layered-owner-scope-enforcement.md), [ADR 0013](adrs/0013-private-oss-delivery-cdn-signing-expiry-and-invalidation-contract.md) |
| Default-off P1 flag registry and evaluation slice | [flag registry](../packages/feature-flags/src/registry.ts) and [flag tests](../packages/feature-flags/src/feature-flags.test.ts) | [ADR 0014](adrs/0014-p1-feature-flags-and-default-off-enforcement.md), [ADR 0022](adrs/0022-single-segment-wan-sprint-prototype-and-long-form-deferral.md) |
| Repository-owned evaluation contracts and attestation index slice | [evaluation package guide](../packages/evaluation/README.md), [attestation implementation](../packages/evaluation/src/attestation.ts), and [gate index](../packages/db/src/gate-attestation-index.ts) | [ADR 0015](adrs/0015-repository-owned-release-gate-evaluation-evidence.md) |
| Environment and module source-boundary scaffold | [infrastructure guide](../infra/README.md), [environment roots](../infra/environments), and [policy check](../scripts/check-infra-policy.mjs) | [ADR 0005](adrs/0005-opentofu-infrastructure-environment-secret-and-promotion-controls.md) |
| Authoritative ADR, problem-document, and architecture-view governance checks | [ADR validator](../scripts/validate_adrs.py), [problem validator](../scripts/validate_problem_docs.py), [architecture validator](../scripts/validate_architecture.py), and [required validation workflow](../.github/workflows/validate-decisions.yml) | [ADR 0026](adrs/0026-file-per-decision-adr-storage-and-lifecycle.md), [ADR 0027](adrs/0027-immutable-sequential-canonical-adr-identifiers.md), [ADR 0028](adrs/0028-product-requirements-and-architecture-document-authority.md) |
<!-- END IMPLEMENTED STATE -->
<!-- prettier-ignore-end -->

Free-form semantic contradictions remain review defects; this validation does not claim to detect them.

## Architectural problems

These documents preserve durable forces and evidence needs without authorizing a
solution or tracking delivery:

- [Content trust, isolation, and lifecycle](problems/content-trust-isolation-and-lifecycle.md)
- [Learning evidence integrity](problems/learning-evidence-integrity.md)
- [Reliable progressive learning delivery](problems/reliable-progressive-learning-delivery.md)
