---
id: "0006"
title: "Passwordless email authentication and revocable server sessions"
status: Accepted
date: "2026-07-19"
aliases: [D-GH-6]
prd_references: "`prds/reflo-prd.md` §6 F7, §9, §10, and §11"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of authentication, session, transactional-email adapter, account-deletion, and authenticated-export implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/6
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/6#issuecomment-5017555040
  record_pr: https://github.com/deepessh/reflo-learning/pull/78
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0006: Passwordless email authentication and revocable server sessions

## Context

P0 requires email authentication, secure revocable sessions, self-serve deletion, and authenticated export requests without making P1 OAuth a dependency. Authentication email must use the effective provider-adapter boundary, minimize contact-data disclosure, and avoid silently authorizing paid service. This verdict controls the P0 email authentication mechanism, login-token lifecycle, session authority and expiry, browser credential transport, authentication-email capability boundary and initial provider, free-quota boundary, and security-sensitive revocation and step-up behavior. It does not replace D-GH-3's schema and write ownership, D-GH-4's general adapter rules, D-GH-7's owner-scope authorization, D-GH-14's P1 OAuth gate, issue #18's final consent, retention, deletion, export, and telemetry policy, or a separate named-human approval for paid usage.

## Options

Managed passwordless identity service; application-managed passwordless magic links with server-side sessions; passwords with email verification.

## Decision

### Authorized verdict

Adopt `auth-v1`. Use application-managed passwordless email magic links and RDS-authoritative opaque server sessions for P0; do not add password authentication or a managed identity provider, and keep OAuth P1 default-off under D-GH-14. Authentication/domain code creates and validates login tokens and calls a narrow provider-neutral transactional-email capability port conforming to D-GH-4; it never imports or names Alibaba DirectMail. Only the DirectMail adapter may import the provider SDK and translate the capability to `SingleSendMail`; the composition root selects it from an explicit allowlist after applicable conformance, security, privacy, sender-domain, environment, and quota checks, deterministic fakes cover tests and local development, and failures and diagnostics are sanitized and provider-neutral outside the adapter. Do not build a universal provider wrapper. Use Alibaba DirectMail as the initial P0 production transactional-email adapter only within its free quota. This verdict does not approve paid usage; any capacity that can incur charges requires separate named-human spending approval and fail-closed budget enforcement. Magic-link requests return the same response regardless of account existence, apply per-destination and per-origin abuse controls, construct HTTPS links only from an exact callback-origin allowlist rather than request host headers, and never log or trace contact addresses, links, or tokens. Tokens use cryptographically secure randomness, expire after 10 minutes, are stored only as keyed digests, and are consumed atomically once; issuing or consuming a newer token invalidates older outstanding tokens for the same purpose and identity. Sessions use at least 256 bits of random bearer secret, store only a keyed digest in RDS, and travel in a host-only `Secure`, `HttpOnly`, `SameSite=Lax` cookie with `Path=/` and no `Domain` attribute. RDS is authoritative on protected requests; do not use JWT or stateless sessions or browser storage for credentials. Enforce a 7-day idle timeout and 30-day absolute timeout. Logout revokes the current session. Account deletion, account disablement, security-sensitive identity changes, and consent withdrawal when account access must stop revoke all sessions before further protected access. Deletion and authenticated export require authentication no older than 15 minutes or a fresh single-use email step-up. Unsafe cookie-authenticated requests require trusted-origin and CSRF enforcement. Session identity never substitutes for D-GH-7 membership and owner-scope checks. Store and disclose only the minimum email data required for authentication and delivery, include provider data in deletion and retention verification, and keep contact data and credentials out of logs, traces, and issues. The explicitly local offline-demo identity cannot authenticate to production.

### Rationale

Application-managed magic links avoid password storage and recovery risk and keep P0 independent of OAuth or an additional identity platform while remaining small enough for the sprint. RDS-authoritative opaque sessions provide immediate revocation for deletion and security events and avoid long-lived stateless credentials. A narrow transactional-email port preserves authentication semantics when providers change and complies with D-GH-4 without inventing a universal wrapper. DirectMail keeps the initial production path on Alibaba infrastructure, while the free-quota boundary prevents this decision from becoming an implicit spending approval.

## Verification

Contract and integration tests cover indistinguishable account-existence responses, rate limits and abuse controls, exact callback-origin validation, host-header injection, token entropy and keyed storage, ten-minute expiry, atomic single use under concurrent redemption, superseded-token rejection, cookie attributes, CSRF and origin enforcement, seven-day idle and thirty-day absolute expiry, current/all-session revocation, deletion and export step-up, immediate access denial after account state changes, and separation of session identity from owner-scope authorization. Adapter conformance and import checks prove authentication/domain code is provider-neutral, only adapters import vendor SDKs, DirectMail translates `SingleSendMail`, deterministic fakes work offline, diagnostics are redacted, unknown or ineligible adapters fail closed, and sends stop before paid capacity without recorded approval. Privacy and offline tests prove contact data and credentials stay out of telemetry and issues, provider data participates in deletion and retention, and demo identity cannot reach production. Migrations and repositories follow D-GH-3 through `packages/db` and dbmate.

## Reversal criteria

Supersede if magic-link delivery or usability cannot meet pilot activation needs, DirectMail cannot satisfy sender-domain, privacy, deletion, deliverability, or free-quota controls, RDS-authoritative session checks cannot meet measured latency, the browser deployment cannot safely support the cookie contract, or a managed identity service measurably reduces security or operational risk without weakening deletion, revocation, privacy, owner-scope, P1, portability, or spending controls. Any replacement must preserve email-only P0 access, immediate server-side revocation, short-lived single-use authentication proof, provider isolation, fail-closed spending, and the PRD's privacy and deletion requirements.
