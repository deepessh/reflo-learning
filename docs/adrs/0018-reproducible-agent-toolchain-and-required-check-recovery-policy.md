---
id: "0018"
title: "Reproducible agent toolchain and required-check recovery policy"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-81]
prd_references: "`prds/reflo-prd.md` §13; opening “Ways of working” declaration"
ownership:
  proposer: "codex-root, based on the issue #27 and PR #80 correction evidence"
  decision_dri: "@deepessh"
  implementation_owner: "Repository governance maintainers and owners of generated schema and CI workflow changes"
authorization:
  decider: "@deepessh, repository owner"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/81
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/81#issuecomment-5019117665
  record_pr: https://github.com/deepessh/reflo-learning/pull/82
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0018: Reproducible agent toolchain and required-check recovery policy

## Context

A schema snapshot correction exposed command discovery drift, a local Node version below the repository pin, unavailable local Docker, exact `pg_dump` build sensitivity, Turborepo environment filtering, a ruleset-required status that could be absent from a pull request, premature auto-merge, accidental reuse of a squash-merged branch, and unbounded generated-file diagnostics. This verdict hardens contributor tooling, generated-schema reproducibility, required-check reporting, corrective-branch recovery, and blocker semantics. It extends D-GH-3's generated-schema boundary and D-GH-67's operating workflow without changing work-item priority, claim ownership, product scope, architecture mandates, or release gates.

## Options

Keep ad hoc command and CI diagnosis; update `AGENTS.md` without executable enforcement; update `AGENTS.md` together with an exact toolchain doctor, checked-in pin policy, canonical container schema generator, required-check manifest and live-ruleset validation, and focused tests.

## Decision

### Authorized verdict

Adopt the documented-and-enforced workflow. Keep exact Node, pnpm, and digest-pinned PostgreSQL image values in a checked-in toolchain manifest and validate that `.nvmrc`, package metadata, CI, Turborepo, database scripts, and documentation remain aligned. Provide a shell-based doctor that runs even when Node is missing, resolves standard command locations, distinguishes missing tools from tools outside `PATH`, verifies exact Node and Corepack-provided pnpm versions, and reports whether the exact container `pg_dump` is available locally or only in CI. Generate `packages/db/schema.sql` only through the canonical wrapper that exposes `pg_dump` from the configured digest-pinned PostgreSQL container; never hand-edit the snapshot or substitute a host client that merely matches the server major version. Declare every task-required variable in Turborepo `env` or `passThroughEnv` and test the propagation boundary. Maintain a checked-in list of required pull-request status contexts; every listed workflow uses an unfiltered `pull_request` trigger and an unconditional matching job, governance CI compares that list with the effective GitHub main-branch rules, and documentation-only and code-only changes receive every required status. Auto-merge may be enabled only after every expected required status appears and passes. A required failure discovered after merge reopens the same issue and uses a new corrective branch from freshly fetched `origin/main`; squash-merged feature branches are never recreated or reused. Large generated-file mismatches emit only bounded lengths or hashes, first-difference position, and small contexts or tails. The two-approach blocking threshold applies to materially different attempts against the same unchanged blocker; independent failures revealed after successful fixes do not accumulate under one threshold.

### Rationale

Documentation alone cannot detect drift between local commands, package metadata, workflow triggers, repository rules, and generated artifacts. A small exact manifest plus local policy checks makes drift fail during review, while live ruleset comparison covers the external configuration that source-only tests cannot observe. Container-only schema generation makes the client build reproducible. Explicit merge and recovery rules prevent a missing status or stale branch from converting a fixable CI failure into ambiguous task state, and bounded diagnostics preserve the useful evidence within CI log limits.

## Verification

The doctor passes with exact fake tools, identifies an installed command outside `PATH`, and verifies the container client path. Toolchain policy tests reject version, PostgreSQL image, schema-generator, Turborepo environment, documentation, or bounded-diagnostic drift. Required-check tests prove both documentation-only and code-only pull requests trigger every declared context, reject path-filtered workflows and conditional required jobs, and extract the effective ruleset contexts without duplication; governance CI compares the manifest to GitHub. Database tests prove the canonical dump command exposes only the container-backed `pg_dump`. Review confirms `AGENTS.md` contains the auto-merge, post-merge recovery, fresh-branch, generated-artifact, environment propagation, bounded-output, and unchanged-blocker rules.

## Reversal criteria

Supersede if exact patch-level Node pinning prevents supported production or CI operation, the doctor cannot run portably in supported contributor shells, the GitHub branch-rules endpoint cannot be read reliably by governance CI, or the container-only schema path cannot reproduce the deployed PostgreSQL schema. Any replacement must preserve deterministic tool discovery, exact generated-schema provenance, unconditional required statuses, live ruleset alignment, bounded diagnostics, and durable post-merge recovery.
