---
id: "0005"
title: "OpenTofu infrastructure, environment, secret, and promotion controls"
status: Accepted
date: "2026-07-18"
aliases: [D-GH-5]
prd_references: "`prds/reflo-prd.md` §9, §11, and §13"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #26 for the initial repository and CI surface; cloud-resource implementation requires a separately triaged issue and assigned owner"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/5
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/5#issuecomment-5013676908
  record_pr: https://github.com/deepessh/reflo-learning/pull/66
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0005: OpenTofu infrastructure, environment, secret, and promotion controls

## Context

Reflo needs reproducible Alibaba Cloud infrastructure, isolated development, staging, and pilot environments, repository-owned state custody, KMS-backed runtime secrets, and evidence-bearing promotion without long-lived CI credentials. This verdict controls the IaC tool, remote-state and environment boundaries, infrastructure identities, secret-payload boundary, promotion evidence, drift handling, and infrastructure recovery. It does not authorize spending, replace feature-specific provider decisions, change the PRD-mandated Alibaba P0 production path, or make provider-specific resources portable without migration work.

## Options

OpenTofu or Terraform CLI with self-managed remote state; native or hosted Terraform through Alibaba Resource Orchestration Service; documented manual provisioning; managed Alibaba IaC Service as a future alternative if its controls and coverage are verified.

## Decision

### Authorized verdict

Use OpenTofu CLI with the official Alibaba Cloud provider as the sole IaC path, initially pinning OpenTofu `1.12.0` and `aliyun/alicloud` `1.283.0` exactly and committing the dependency lock file. Use one `infra/bootstrap` root and explicit `dev`, `staging`, and `pilot` roots; do not use workspaces for environment isolation. Store distinct environment state in a private, versioned, encrypted OSS backend with TableStore locking and tightly restricted plan, apply, and break-glass access. Separate environments by state, resource groups and tags, networks, RAM roles, KMS secret namespaces, data stores, buckets, queues, logs, and service identities; pilot has no dependency on lower environments. KMS Secrets Manager is the sole runtime secret store, plaintext payloads never enter source, tfvars, plans, logs, outputs, issues, or long-lived CI configuration, and web receives no cloud or database credentials. GitHub Actions exchanges repository- and environment-bound OIDC tokens for short-lived Alibaba STS credentials; PR workflows can validate and plan but not apply. Dev applies a fresh exact plan after merge under a concurrency lock; staging requires dev evidence and environment approval; pilot additionally requires the exact approved plan digest, staging evidence, current PRD gates, and named-human approval. Changed plans require reapproval, spending remains human-approved, and every apply records immutable version, actor, approval, change, migration, smoke, drift, and rollback evidence. Application deployables and dbmate migration retain the D-GH-2 and D-GH-3 boundaries. Application rollback selects a known-good immutable artifact; infrastructure recovery uses reviewed roll-forward or a new reviewed rollback plan. Unknown environments, stale approvals or gates, unexplained drift, lock failure, and unapproved spending fail closed. OpenTofu provides workflow portability only: a future provider switch still requires cloud-specific modules, state and data migration, testing, and any required PRD revision.

### Rationale

OpenTofu preserves an open, reviewable, exact-pinned workflow and a cleaner future control-plane exit than ROS while satisfying the current Alibaba production mandate. Its built-in OSS backend supports TableStore locking, the official Alibaba provider covers the required service families and OIDC role assumption, and the modest bootstrap burden is acceptable for the sprint. Native ROS adds proprietary template coupling, hosted ROS Terraform requires coverage verification, and manual provisioning cannot satisfy reproducibility or drift control. Provider-specific resources remain intentionally explicit rather than hidden behind a speculative multi-cloud abstraction.

## Verification

CI rejects unpinned core, provider, or external module versions; unreviewed lock-file changes; committed state, plan, or secret files; non-bootstrap local backends; and workspaces used as environment boundaries. Lock contention prevents concurrent mutation. Role tests prove PR jobs cannot mutate, runtime roles cannot read state, web has no cloud or database credential, and one environment cannot access another. Promotion tests reject non-main pilot applies, mismatched or stale plan digests, missing staging evidence, stale gates, unexplained drift, and unapproved spend. Completion requires a no-op post-apply plan plus recorded commit, artifact, plan, version, approver, actor, schema, smoke, drift, and rollback evidence. Recovery documentation covers bootstrap migration, state restore, force-unlock, secret rotation, failed applies, application rollback, and infrastructure roll-forward.

## Reversal criteria

Supersede if the official provider lacks a PRD-required resource, OSS and TableStore locking proves unreliable, OpenTofu compatibility blocks delivery, or managed Alibaba IaC Service or ROS measurably reduces operational risk without weakening review, state custody, identity, secret, portability, or promotion gates. A cloud-provider switch also requires provider-specific replacement modules and, while M-006 remains, a PRD revision.
