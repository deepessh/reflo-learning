---
id: "0032"
title: "Demo-only hackathon scope and post-hackathon pilot deferral"
status: Accepted
date: "2026-07-23"
aliases: [D-GH-21]
prd_references: "`prds/reflo-prd.md` §§3, 6–7, and 11–15; ADR 0028; ADR 0031"
ownership:
  proposer: "@deepessh through issue #21"
  decision_dri: "@deepessh"
  implementation_owner: "agent:wt-71fc734b67931a75ae25 through issue #21"
authorization:
  decider: "@deepessh, repository owner and named human decider for issue #21"
  approval_basis: >-
    I approve changing the hackathon through Demo Day to demo-only, with no
    external pilot learners or pilot activation gates; all real-pilot consent,
    privacy lifecycle, content-rights attestation, real-user authorization,
    learner opt-out, deletion/export, provider verification, rollout, and
    pilot-metrics work moves post-hackathon. Demo work uses synthetic, seeded,
    or staff-controlled test identities and human-approved rights-cleared
    sources.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/21
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/21#issuecomment-5065684061
  record_pr: https://github.com/deepessh/reflo-learning/pull/151
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0032: Demo-only hackathon scope and post-hackathon pilot deferral

## Context

The current PRD requires 10–20 real pilot learners before Demo Day and
therefore pulls consent, privacy lifecycle, content-rights attestation,
real-user authorization, learner opt-out, deletion and export, provider
verification, rollout controls, and pilot metrics onto the hackathon critical
path. The repository owner determined that this is disproportionate to a demo
build.

This decision controls the sprint boundary through Demo Day on August 15,
2026. It does not waive protections for any future real-user pilot or authorize
use of learner PII, unapproved sources, or external recipients during the
demo-only period. The PRD remains authoritative for the resulting product
scope. Existing accepted architecture, including ADR 0031, remains a future
target where it applies and is not represented as implemented or required for
the hackathon demo.

## Options

Keep the existing 10–20-person pilot and its activation gates; run a smaller
unpaid pilot with reduced operational controls; or use only seeded, synthetic,
or staff-controlled demo identities through Demo Day and defer the real-user
pilot program.

## Decision

### Authorized verdict

Use only seeded, synthetic, or staff-controlled test identities through Demo
Day. Do not recruit or activate external learners, enable public signup or
external uploads, send messages to real users, run learner research or a
randomized learner experiment, or publish pilot retention or causal-learning
claims during the hackathon. Live and offline demonstrations use dedicated
test messaging destinations and human-approved rights-cleared source
material.

Move the real-user pilot and its consent, privacy lifecycle, content-rights
attestation, real-user authorization, learner opt-out, deletion and export,
provider verification, operational rollout controls, activation and D7
definitions, cohort reporting, and retention experiment to the post-hackathon
roadmap. Existing reusable implementation may remain, but none of this work is
a sprint gate or evidence that Reflo is ready for external learners.

Revise the PRD to make this demo-only boundary authoritative, align contributor
instructions, and close or defer pilot-only backlog items. Retain demo-source
rights approval, non-learner data minimization, honest labeling, and the seeded
online/offline Flow B assertion.

### Rationale

The demo proves Reflo's adaptive learning loop, progressive generation, source
grounding, and failure recovery without taking responsibility for real learner
data or external communications. Deferring the pilot as one complete program
avoids building fragmented compliance and rollout machinery under hackathon
time pressure while making the absence of real-user evidence explicit.

## Verification

PRD v2.0 contains no pre-Demo Day pilot target, activation gate, cohort metric,
or learner experiment. It disables public signup, external learner uploads,
and real-user messaging through Demo Day; limits data to seeded, synthetic, or
staff-controlled test identities; requires rights-cleared demo sources; and
places the complete real-user pilot lifecycle in the post-hackathon roadmap.

`AGENTS.md` states the same boundary. Open sprint issues no longer require or
depend on pilot activation, rollout controls, D7 reporting, or real-user
consent/privacy implementation. Demo evidence and descriptive architecture
never claim production or pilot readiness.

## Reversal criteria

Reconsider after Demo Day when a named human authorizes a real-user pilot
scope, eligible sources, cohort and commercial terms, and activation date.
Before any external learner participates, a successor PRD revision must restore
the applicable consent, privacy, rights, authorization, opt-out, deletion,
export, provider, messaging, rollout, and measurement requirements. No
successor may treat this demo-only period as real-user evidence.
