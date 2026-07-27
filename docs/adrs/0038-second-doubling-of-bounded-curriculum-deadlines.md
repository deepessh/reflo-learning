---
id: "0038"
title: "Second doubling of bounded curriculum deadlines"
status: Superseded
date: "2026-07-27"
aliases: [D-GH-189]
prd_references: "`prds/reflo-prd.md` v2.4 §3 G1, §6 F1, §8 Flow A, §11, §12, and §13; ADR 0010; ADR 0012; ADR 0024; ADR 0037"
ownership:
  proposer: "@deepessh through issue #189"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #182"
authorization:
  decider: "@deepessh"
  approval_basis: "after reviewing the #182 evidence that the structural invalid_result defect remains eliminated while all four first-wave configured Qwen children exhausted the 60-second ceiling, the owner explicitly directed in the active Codex task on 2026-07-27: “Let’s double the limits again.” This verdict records that instruction as 120-second children, a 480-second parent target, and a 48-second finalization reserve, with coupled leases and recovery polling doubled proportionally and concurrency, partitioning, provider/model, capacity, grounding, persistence semantics, and spending unchanged."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/189
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/189#issuecomment-5094644086
  record_pr: https://github.com/deepessh/reflo-learning/pull/190
supersedes: ["0037"]
superseded_by: "0039"
deprecation: null
maintenance: []
---

# ADR 0038: Second doubling of bounded curriculum deadlines

## Context

ADR 0037 doubled the bounded curriculum policy to a 240-second parent,
60-second child ceiling, and 24-second finalization reserve after issue #182
removed the model's responsibility for copying segment identity and ordinal.
The implementation also extended the parent generation lease, recovery polling
window, and child persistence lease so they covered the longer model work.

The next approved-source connected run continued to produce zero
`invalid_result` children. Its persisted parent deadline was 240.011 seconds,
but each of the four first-wave configured Qwen children exhausted the
60-second ceiling in 60.066–60.085 seconds. The remaining nine children stayed
queued and the parent finalized honestly as `generation_deadline_exceeded`.
The route therefore met ADR 0037's reversal criterion. This is development
route evidence, not production p95 evidence.

## Options

Double the parent, child, reserve, and coupled operational windows again while
retaining the bounded orchestration shape; increase only the child ceiling
while keeping the 240-second parent; or retain the deadlines and separately
authorize a model, provider, capacity, spending, or partition change.

## Decision

### Authorized verdict

Adopt `curriculum-deadline-policy-v3`. The standard-profile
upload-to-outline SLO is p95 no later than 480 seconds after upload completion.
The persisted parent deadline is 480 seconds, each
`curriculum.segment.v1` logical call receives no more than 120 seconds and
never more than the remaining parent budget, and the orchestrator reserves the
final 48 seconds for validation, deterministic composition, atomic
persistence, terminal finalization, and UI observability.

The parent generation lease becomes 600 seconds, recovery polling covers 620
one-second polls, and a claimed child receives a 140-second persistence lease.
These coupled windows preserve their existing proportional safety margins and
do not authorize extra retries or late commits.

At most four children execute concurrently. Partition ceilings remain 12
whole source spans and 8,000 source-material tokens. Provider, model route,
prompt/result contracts, grounding and completeness rules, idempotency,
retries, deterministic composition, fail-closed terminal behavior, and
spending remain unchanged.

This ADR supersedes ADR 0037 and incorporates all ADR 0037 decisions except
its 240-second parent target, 60-second child ceiling, 24-second reserve,
300-second parent lease, 310-poll recovery window, 70-second child lease, and
`curriculum-deadline-policy-v2` identity. Only those values are replaced by
the doubled values and v3 identity above.

### Rationale

The connected evidence isolates the configured route's latency: structure
validation remains fixed, and every active child reached the exact model
deadline. A second proportional doubling follows the owner's direction while
preserving bounded execution, deterministic composition, and the unchanged
route and partition policy.

## Verification

Contract and deterministic-clock tests prove the exact 480-second parent,
120-second child, and 48-second reserve. Live repository tests prove the
600-second parent lease, 620-poll recovery window, and 140-second child lease.
Existing tests continue to prove four-way concurrency, reserve enforcement,
and that retries never reset either deadline.

The approved-source connected API run must produce all 13 valid grounded or
explicitly non-instructional child results, activate one complete outline, and
finish within 480 seconds before issue #182 closes. Evidence records bounded,
sanitized counts, timings, states, and terminal reasons. Failure remains
failure and may not be presented as meeting the SLO.

PRD v2.4, ADR governance, architecture validation, model-router, retrieval,
database, API, worker, and Flow B suites remain green.

## Reversal criteria

Supersede this policy if connected p95 evidence cannot meet 480 seconds, the
eight-minute wait materially harms activation, or a separately authorized
partition, routing, provider, or capacity policy achieves a lower product
SLO. Any further relaxation requires another PRD revision and authorized
decision; paid capacity remains a human spending decision.
