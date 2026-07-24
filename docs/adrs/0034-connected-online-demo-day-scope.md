---
id: "0034"
title: "Connected online Demo Day scope"
status: Accepted
date: "2026-07-24"
aliases: [D-GH-19]
prd_references: "`prds/reflo-prd.md` §§6, 9, and 12–14; `AGENTS.md` §6; ADR 0032"
ownership:
  proposer: "@deepessh through issue #19"
  decision_dri: "@deepessh"
  implementation_owner: "agent:wt-71fc734b67931a75ae25 through issue #19"
authorization:
  decider: "@deepessh, repository owner and founding-team product decision authority"
  approval_basis: >-
    On 2026-07-24 the owner explicitly directed that Reflo should not do
    anything offline, should be exercised online, and that issues #19 and #46
    should be closed.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/19
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/19#issuecomment-5074825051
  record_pr: https://github.com/deepessh/reflo-learning/pull/0
supersedes: ["0032"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0034: Connected online Demo Day scope

## Context

PRD v2.0 and ADR 0032 require both an online seeded Flow B and an offline
service-worker bundle with behavioral parity. The repository owner has decided
to focus the sprint and Demo Day on a connected online application that can be
used directly, rather than spending sprint capacity on a separate offline
runtime, local identity, cache, and parity-evidence path.

This decision changes only the offline fallback and parity portions of the
Demo Day boundary. It preserves the demo-only restriction through August 15,
the online adaptive loop, the separate standard-profile upload demonstration,
staff-only test identities and messaging destinations, rights-cleared sources,
honest labeling, resettable demo data, and the prohibition on external learner
activation.

## Options

Retain the offline bundle and online/offline parity requirement; remove the
offline requirement and harden the connected online seeded flow; or defer the
choice while leaving the current P0 requirement in force.

## Decision

### Authorized verdict

Use the connected online application as the only Demo Day product surface.
Remove the offline bundle, route-scoped service worker, local demo identity,
pre-generated offline fallback, and online/offline Flow B parity assertion from
sprint and Demo Day scope.

Keep the seeded online Flow B: a failed question triggers a qualifying
different lesson, a correct re-test supplies the only mastery-changing
evidence, the Knowledge Map displays the delta, and the session completes
within six minutes. Demonstrate standard-profile upload to outline separately
against its existing SLO.

The online demo preflights its required application, model, storage, and
delivery dependencies. Transient failures use bounded retries and explicit
learner-visible states; an unavailable dependency never becomes a fabricated
success. Rehearsals cover failure detection and recovery. Seeded or
pre-generated behavior is labeled honestly and is never presented as live
generation.

Carry forward the remainder of ADR 0032: use only seeded, synthetic, or
staff-controlled test identities; use dedicated test messaging destinations
and human-approved rights-cleared sources; do not enable public signup,
external uploads, real-user messaging, learner research, pilot experiments, or
external learner activation through Demo Day. The complete real-user pilot and
privacy lifecycle remain post-hackathon scope.

Close the offline implementation issue #46 as no longer planned and remove it
from the online demo-hardening issue #55.

### Rationale

One connected product surface concentrates sprint effort on an experience the
owner can run and evaluate directly. It avoids maintaining a second state,
identity, asset-distribution, service-worker, and parity-evidence system while
preserving the core learning loop and honest failure behavior. Explicit online
preflight and recovery rehearsal make the dependency boundary visible without
pretending that unavailable services succeeded.

## Verification

The PRD and contributor instructions contain no active offline bundle,
service-worker fallback, local demo identity, or online/offline parity
requirement. The seeded online Flow B and separate upload demonstration remain
P0. Demo rehearsals record dependency failures and recovery without duplicate
effects or false success.

Issue #46 closes as no longer planned. Issue #55 depends on the implemented
online Tutor Agent and Knowledge Map only and describes connected online demo
hardening. Repository governance, architecture, problem-document, and
workspace checks pass.

## Reversal criteria

Reintroducing an offline product surface requires a new human-approved PRD
revision and successor ADR defining its runtime, identity, asset, state,
security, labeling, and evidence boundaries. No future offline fallback may
reuse production credentials or learner data or weaken the demo-only safety
boundary.
