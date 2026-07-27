---
id: "0037"
title: "Doubled bounded curriculum deadline policy"
status: Accepted
date: "2026-07-27"
aliases: [D-GH-187]
prd_references: "`prds/reflo-prd.md` v2.3 §3 G1, §6 F1, §8 Flow A, §11, §12, and §13; ADR 0010; ADR 0012; ADR 0024; ADR 0036"
ownership:
  proposer: "@deepessh through issue #187"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #182"
authorization:
  decider: "@deepessh"
  approval_basis: "after reviewing the #182 evidence that structural invalid_result was eliminated while the configured Qwen children still exhausted the 30-second ceiling, the owner explicitly directed in the active Codex task on 2026-07-27: “Let’s relax the limits - increase them to double.” This verdict records that instruction as 60-second children, a 240-second parent target, and a 24-second finalization reserve, with concurrency, partitioning, provider/model, capacity, grounding, persistence, and spending unchanged."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/187
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/187#issuecomment-5094256554
  record_pr: https://github.com/deepessh/reflo-learning/pull/188
supersedes: ["0036"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0037: Doubled bounded curriculum deadline policy

## Context

ADR 0036 introduced deterministic, structure-aware curriculum segments under
the PRD v2.2 standard-profile 120-second upload-to-outline SLO. It bounded each
child model call to 30 seconds, reserved the final 12 seconds for composition
and atomic activation, and allowed no more than four children to execute
concurrently.

Issue #182 proved that the partition, persistence, orchestration, deterministic
composition, and grounding path works. A deterministic connected fixture
processed the approved 478,301-byte source into 13 complete segments and an
activated grounded outline in 23.314 seconds. Commit `5491608` then removed the
model's responsibility for copying segment identity and ordinal. A sanitized
configured-route call returned a structurally valid segment in 25.947 seconds,
and the full approved-source path produced no `invalid_result` children.

The full configured-route run still failed: its first four concurrent Qwen
children each exhausted the 30-second ceiling, later children never launched,
and the parent terminated honestly as `generation_deadline_exceeded` after
63.620 seconds. This meets ADR 0036's reversal criterion for a bounded route
that remains unable to meet the unchanged deadline. It is evidence about the
current development route, not production p95 evidence.

## Options

Double the parent, child, and reserve budgets proportionally while retaining
the bounded orchestration shape; increase only the child ceiling while keeping
the 120-second parent; or retain the deadlines and authorize a separate model,
provider, capacity, spending, or partition change.

## Decision

### Authorized verdict

Adopt `curriculum-deadline-policy-v2`. The standard-profile
upload-to-outline SLO is p95 no later than 240 seconds after upload completion.
The single persisted parent deadline is 240 seconds, each
`curriculum.segment.v1` logical call receives no more than 60 seconds and
never more than the remaining parent budget, and the orchestrator reserves the
final 24 seconds for result-set validation, deterministic composition, atomic
persistence, terminal finalization, and UI observability.

At most four children execute concurrently. The partition ceilings remain 12
whole source spans and 8,000 source-material tokens. The approved provider,
model route, prompt/result contracts, grounding and completeness rules,
idempotency, retries, persistence, deterministic composition, and fail-closed
terminal behavior remain unchanged. No capacity purchase or spending is
authorized.

This ADR supersedes ADR 0036 and incorporates every ADR 0036 decision except
its 120-second parent target, 30-second child ceiling, 12-second finalization
reserve, and `curriculum-deadline-policy-v1` identity. Those values are
replaced only by the doubled values and v2 identity above.

### Rationale

The connected route has already demonstrated that a valid segment can require
almost the entire former 30-second ceiling, while deterministic fixture
evidence shows that partitioning and composition are not the bottleneck.
Doubling all three time budgets preserves the bounded design and its
proportional finalization reserve without changing capacity, concurrency, or
the amount of source material assigned to each child.

## Verification

Contract and deterministic-clock tests prove the exact 240-second parent,
60-second child, and 24-second reserve; at most four concurrent children;
no work starts or commits after the reserve boundary; and router or outer
retries never reset either deadline.

The approved-source connected API run must produce all 13 valid grounded or
explicitly non-instructional child results, activate one complete outline, and
finish within 240 seconds before issue #182 closes. Evidence records the
observed total, child, queue, composition, retry, count, and terminal metrics
without source text, learner data, credentials, or provider payloads. A
failure remains a failure and may not be presented as meeting the SLO.

PRD v2.3, ADR governance, architecture validation, model-router, retrieval,
database, API, worker, and Flow B suites remain green.

## Reversal criteria

Supersede this policy if connected p95 evidence cannot meet 240 seconds, the
doubled wait materially harms the activation flow, provider or capacity
authorization changes, or a separately authorized partition or routing policy
achieves a lower product SLO. Any further SLO relaxation requires a new PRD
revision and authorized decision; any paid capacity remains a human spending
decision.
