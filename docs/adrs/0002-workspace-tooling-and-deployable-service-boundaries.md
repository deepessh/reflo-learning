---
id: "0002"
title: "Workspace tooling and deployable service boundaries"
status: Accepted
date: "2026-07-18"
aliases: [D-GH-2]
prd_references: "`prds/reflo-prd.md` §9 and §13"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #26"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/2
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/2#issuecomment-5013334405
  record_pr: https://github.com/deepessh/reflo-learning/pull/63
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0002: Workspace tooling and deployable service boundaries

## Context

The documentation-only repository needs one collaboration surface while preserving the PRD-mandated CDN, ECS, and Function Compute deployment targets. This verdict controls repository/package tooling and source/deployment boundaries only; adjacent database, framework, infrastructure, parser, authentication, and model-routing choices remain independently reversible decisions.

## Options

Separate repositories for each deployable; one combined deployable with later extraction; one monorepo with explicit deployable applications and shared packages.

## Decision

### Authorized verdict

Use a single monorepo with pnpm 10.x workspaces and Turborepo 2.x, pinning exact tool versions in the scaffold. Establish independently buildable and deployable `apps/web` for the Next.js PWA, `apps/api` for the ECS API plus learner/session orchestrator, and `apps/jobs` for Function Compute handlers, alongside non-deployable shared packages. Applications may consume shared packages but may not import another application; shared packages expose deliberate public entry points and contain no deployment startup code. Keep the API and orchestrator in one ECS deployable for the sprint, permit independent handler packaging from `apps/jobs`, require no paid or remote Turborepo cache, and preserve the option to add independently deployed non-Node workers later.

### Rationale

A monorepo gives the three-person sprint one review surface, one lockfile, direct typed-contract sharing, and dependency-aware root commands without collapsing runtime boundaries. Separate repositories add contract-publishing and coordination overhead, while one combined deployable conflicts with independent CDN, ECS, and Function Compute build and release needs.

## Verification

The scaffold has one pinned pnpm lockfile and pinned local Turborepo dependency; root install, dev, test, lint/format, and build commands cover all participating workspaces; `apps/web`, `apps/api`, and `apps/jobs` each build and package without importing another application; deployment artifacts can be produced independently; package-boundary checks reject app-to-app imports; governance tests remain green.

## Reversal criteria

Supersede this decision if measured workspace or CI overhead exceeds its coordination benefit, if deployable coupling prevents independent release, or if a required runtime cannot be supported without splitting repositories. Reversal requires a new authorized decision and merged record.
