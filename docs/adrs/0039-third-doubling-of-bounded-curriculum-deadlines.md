---
id: "0039"
title: "Third doubling of bounded curriculum deadlines"
status: Accepted
date: "2026-07-27"
aliases: [D-GH-191]
prd_references: "`prds/reflo-prd.md` v2.5 §3 G1, §6 F1, §8 Flow A, §11, §12, and §13; ADR 0010; ADR 0012; ADR 0024; ADR 0038"
ownership:
  proposer: "@deepessh through issue #191"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #182"
authorization:
  decider: "@deepessh"
  approval_basis: "after reviewing the #182 evidence that four configured Qwen partitions succeeded under the 120-second ceiling while three still exhausted it, one returned a provider failure, and structural invalid_result remained eliminated, the owner explicitly directed in the active Codex task on 2026-07-27: “Let’s double it further.” This verdict records that instruction as 240-second children, a 960-second parent target, and a 96-second finalization reserve, with coupled leases and recovery polling doubled proportionally and concurrency, partitioning, provider/model, capacity, grounding, persistence semantics, and spending unchanged."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/191
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/191#issuecomment-5094937218
  record_pr: https://github.com/deepessh/reflo-learning/pull/192
supersedes: ["0038"]
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0039: Third doubling of bounded curriculum deadlines

## Context

ADR 0038 doubled the bounded curriculum policy to a 480-second parent,
120-second child ceiling, and 48-second finalization reserve. Its connected
approved-source run continued to produce zero `invalid_result` children and
materially improved from zero completed partitions to four.

The run still did not activate an outline. Of 13 partitions, eight launched:
ordinals 1, 3, 4, and 6 succeeded; ordinals 0, 2, and 5 exhausted the model
deadline; ordinal 7 returned `model_provider_failure`; and ordinals 8–12
remained queued. The parent finalized honestly after 327.069 seconds against a
persisted 480.010-second deadline. This meets ADR 0038's reversal criterion
and remains development-route evidence rather than production p95 evidence.

## Options

Double the parent, child, reserve, and coupled operational windows again while
retaining the bounded orchestration shape; increase only the child ceiling;
or retain the deadlines and separately authorize a route, provider, capacity,
spending, concurrency, or partition change.

## Decision

### Authorized verdict

Adopt `curriculum-deadline-policy-v4`. The standard-profile
upload-to-outline SLO is p95 no later than 960 seconds after upload completion.
The persisted parent deadline is 960 seconds, each
`curriculum.segment.v1` logical call receives no more than 240 seconds and
never more than the remaining parent budget, and the orchestrator reserves the
final 96 seconds for validation, deterministic composition, atomic
persistence, terminal finalization, and UI observability.

The parent generation lease becomes 1,200 seconds, recovery polling covers
1,240 one-second polls, and a claimed child receives a 280-second persistence
lease. These coupled windows preserve their proportional safety margins and
do not authorize extra retries or late commits.

At most four children execute concurrently. Partition ceilings remain 12
whole source spans and 8,000 source-material tokens. Provider, model route,
prompt/result contracts, grounding and completeness rules, idempotency,
retries, deterministic composition, fail-closed behavior, and spending remain
unchanged.

This ADR supersedes ADR 0038 and incorporates all ADR 0038 decisions except
its 480-second parent target, 120-second child ceiling, 48-second reserve,
600-second parent lease, 620-poll recovery window, 140-second child lease, and
`curriculum-deadline-policy-v3` identity. Only those values are replaced by
the doubled values and v4 identity above.

### Rationale

The latest evidence shows that the longer envelope allows some unchanged
partitions to finish while other configured Qwen calls still reach the exact
model ceiling. A third proportional doubling follows the owner's direction
without changing partitioning, concurrency, routing, capacity, or spending.

## Verification

Contract and deterministic-clock tests prove the exact 960-second parent,
240-second child, and 96-second reserve. Live repository tests prove the
1,200-second parent lease, 1,240-poll recovery window, and 280-second child
lease. Existing tests continue to prove four-way concurrency, reserve
enforcement, and that retries never reset either deadline.

The approved-source connected API run must produce all 13 valid grounded or
explicitly non-instructional child results, activate one complete outline, and
finish within 960 seconds before issue #182 closes. Evidence records bounded,
sanitized counts, timings, states, and terminal reasons. Failure remains
failure and may not be presented as meeting the SLO.

PRD v2.5, ADR governance, architecture validation, model-router, retrieval,
database, API, worker, and Flow B suites remain green.

## Reversal criteria

Supersede this policy if connected evidence cannot meet 960 seconds, the
sixteen-minute wait materially harms activation, or a separately authorized
partition, routing, provider, capacity, or concurrency policy achieves a lower
product SLO. Any further relaxation requires another PRD revision and
authorized decision; paid capacity remains a human spending decision.
