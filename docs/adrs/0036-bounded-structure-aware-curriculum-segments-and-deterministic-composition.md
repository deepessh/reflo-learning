---
id: "0036"
title: "Bounded structure-aware curriculum segments and deterministic composition"
status: Superseded
date: "2026-07-26"
aliases: [D-GH-181]
prd_references: "`prds/reflo-prd.md` §6 F1, §8 Flow A, §9, §11, §12, and §13; ADR 0009; ADR 0010; ADR 0012; ADR 0024; ADR 0034"
ownership:
  proposer: "@deepessh through issue #181"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #182"
authorization:
  decider: "@deepessh, repository owner and founding-team product and architecture authority"
  approval_basis: "This preserves PRD v2.2 F1’s unchanged standard-profile 120-second target while replacing the demonstrated non-compliant monolithic curriculum call. It preserves ADRs 0009, 0012, 0024, and 0034 and authorizes ADR 0010 to be extended or partially superseded only for curriculum orchestration."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/181
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/181#issuecomment-5087796292
  record_pr: https://github.com/deepessh/reflo-learning/pull/185
supersedes: []
superseded_by: "0037"
deprecation: null
maintenance: []
---

# ADR 0036: Bounded structure-aware curriculum segments and deterministic composition

## Context

The PRD requires a usable source-backed outline for a standard-profile upload at
p95 no later than 120 seconds after upload completion. The implemented path
creates and embeds stable ADR 0009 source spans, then submits every selected
span to one `curriculum.structure.v1` structured-model call before atomically
activating the result. That single-call orchestration is reproducible and
strictly validated under ADR 0010, but it does not meet the unchanged product
target with the approved seeded source.

Three controlled browser runs persisted and activated all 148 source-span
embeddings in 28.813–31.457 seconds, then ended honestly as
`failed_permanent` / `generation_deadline_exceeded` at approximately 120.03
seconds. A human-directed diagnostic submitted 28 evenly distributed whole
spans totaling 65,373 source characters and completed only after 206.712
seconds, producing nine chapters and 30 concepts. The diagnostic proved
eventual model completion but not the product SLO. The full evidence and the
authorized split from the completed upload-hardening work are preserved in
issue #55 and carried into issue #181.

Parser structure cannot be the only partition mechanism. The approved
133-page PDF currently normalizes to 133 ordered blocks and 363,315 source
characters with an empty PDF `sectionPath` on every block. Other valid sources
can expose useful section paths, while a valid section can itself exceed a safe
model input. A curriculum partition must therefore prefer genuine persisted
structure without depending on it, and it must retain every stable source-span
identity and source order across deterministic fallbacks.

This decision controls the standard-profile curriculum partition, typed child
model task, bounded orchestration, durable child identity, deterministic
composition, completeness and failure rules, deadline allocation, provenance,
and sanitized observability. It extends ADR 0010 with a new curriculum task
rather than changing `curriculum.structure.v1`; ADR 0010 remains active for
that task and every other typed route. It does not change the PRD target or
profile, the approved source, provider/model selection, capacity or spending,
`chunk-v1`, owner authorization, vector storage, the connected-online
boundary, or the product evaluation protocol.

## Options

Retain one monolithic `curriculum.structure.v1` call and pursue a smaller
prompt or separately authorized model/capacity change; generate bounded
section or fallback segments concurrently and compose them deterministically;
derive the complete outline from parser headings and use the model only for
enrichment; or relax the product target or standard-profile limits.

## Decision

### Authorized verdict

Select amended option 2: bounded, structure-aware segment generation with
deterministic composition. Partitioning must prefer genuine parser sections
but deterministically split oversized sections and sectionless sources into
contiguous, versioned source-span windows. Every child call uses a new typed
versioned task through the shared traced router, preserves stable source-span
provenance, and operates under bounded concurrency and the single unchanged
120-second global deadline. Composition is deterministic and fails closed
unless every required segment has a valid grounded or explicitly
non-instructional result. `curriculum.structure.v1` remains unchanged. A
global relationship model pass is not required for v1 and may be introduced
only as a separately versioned, budget-safe extension.

The approval basis is that this preserves PRD v2.2 F1's unchanged
standard-profile 120-second target while replacing the demonstrated
non-compliant monolithic curriculum call. It preserves ADRs 0009, 0012, 0024,
and 0034 and extends ADR 0010 only for curriculum orchestration.

Adopt `curriculum-partition-v1`, `curriculum.segment.v1`,
`curriculum-compose-v1`, and `curriculum-v2`.

#### Partition contract

`curriculum-partition-v1` receives the complete ordered set of persisted
`chunk-v1` spans for one authorized owner, course, source document, and active
embedding generation. It rejects mixed owner, source, generation, contract,
tokenizer, missing-order, duplicate-order, duplicate-ID, or non-contiguous
input before any child call.

The partitioner groups consecutive spans under the same non-empty section path
when the complete child input remains within both 12 whole source spans and
8,000 source-material tokens under the named versioned tokenizer. It never
merges spans from different non-empty section paths. It splits an oversized
section at a source-span boundary using the same two ceilings. Empty section
paths use the identical contiguous-window rule. One source span remains
indivisible for this contract; a span that alone violates the complete child
input ceiling fails closed because changing `chunk-v1` is outside this
decision.

Every source span belongs to exactly one segment: there are no omissions,
overlaps, samples, or reorderings. A segment records its ordinal, stable
segment ID, optional section path, first and last source order, ordered
source-span IDs and input hashes, source-token count, partition-policy version,
and parent operation/generation identity. The stable segment ID is derived
from those immutable values. The complete partition manifest is hashed and
persisted before child execution, so replay reconstructs the same child set or
fails rather than silently repartitioning.

#### Typed child task

`curriculum.segment.v1` is a new ADR 0010 structured task routed through ADR
0024's shared traced router to the approved structured selector, with no
fallback, hedging, shadow sending, provider choice, or direct provider call.
It has independent versioned input, result, prompt, schema, and generation
parameter identities. `curriculum.structure.v1` and its existing input,
result, prompt, route, retry, and validation semantics remain unchanged and
are not a fallback for a failed segment.

The child input carries the course title, stable segment identity and ordinal,
optional section path, source-order bounds, and only that segment's authorized
source spans. Its strict result is a closed union:

- `instructional`, containing one or more local chapters with one or more
  local concepts, unique local keys, prerequisites that reference only earlier
  concepts in that result, and chapter/concept source-span IDs drawn only from
  the child input; or
- `non_instructional`, containing the complete ordered segment span-ID set and
  one closed reason such as front matter, navigation, attribution/license, or
  other non-instructional material.

An empty response, mixed union, unknown reason, unauthorized or missing
provenance, foreign segment identity, duplicate key, forward/unknown
prerequisite, invalid source order, schema-invalid result, or result that
claims only part of a non-instructional segment is non-retryable
`invalid_result`. Uploaded text remains untrusted data and cannot alter the
task instructions, tools, schema, authorization, deadline, or composition
rules.

#### Bounded orchestration and deadline

The parent operation's persisted absolute deadline remains the single
authority and is never reset by queue delivery, worker recovery, router
attempt, child retry, or composition. At most four child logical calls for one
parent execute concurrently. Each child receives no more than 30 seconds and
never more than the remaining parent budget before the finalization reserve.
The orchestrator reserves the final 12 seconds of the parent deadline for
result-set validation, deterministic composition, atomic persistence,
terminal finalization, and UI observability. It launches no new child, router
attempt, or retry after that reserve would be consumed and actively cancels
work that cannot commit before the parent deadline.

ADR 0010's eligible immediate attempt policy remains inside one child logical
call and its 30-second ceiling. ADR 0012's outer delivery budget cannot reset a
child or parent deadline. A transient failed child may be retried only with
the same immutable child identity and only when its complete ceiling plus the
finalization reserve remains. Schema, authorization, policy, safety,
cancellation, expiry, and known non-idempotent ambiguity failures never retry
blindly. Capacity may lower effective concurrency through route policy or
admission control; increasing the per-parent maximum above four or weakening
the deadline reserve requires a successor decision backed by connected
evidence.

#### Durable identity and recovery

Each child uses the namespaced idempotency key
`environment/curriculum.segment/v1/<parent-generation-id>/<segment-id>`.
The ADR 0012 store persists the child contract versions, input and result
hashes, ordered provenance, state, lease, attempt records, sanitized failure,
and terminal result before the parent consumes it. Redelivery and lease
recovery reuse a completed matching result, exclude active duplicate
execution, and reject any version, input, authorization, or hash mismatch.
Late, duplicate, stale-lease, and out-of-order completions cannot overwrite the
first committed terminal child result or produce a second logical effect.

The parent succeeds only when every manifest segment has exactly one matching
terminal `instructional` or `non_instructional` result. Missing, active,
failed, expired, cancelled, foreign, duplicated, or inconsistent children
prevent composition and finalize the parent honestly under ADR 0012. Partial
child progress remains internal operation state and never creates visible
chapters, concepts, or `outline_ready`.

#### Deterministic composition

`curriculum-compose-v1` is trusted application code with a versioned input and
result contract; it is not a model task. It orders children by manifest
ordinal, preserves each child's local order, and derives globally unique
chapter and concept keys and stable IDs from the parent generation,
composition version, segment identity, local identity, normalized name, and
ordered source-span IDs. Worker completion order, retry count, timestamps, and
provider request IDs never affect the composed outline.

The composer may coalesce adjacent chapters only when their normalized titles
are exactly equal. Within such a chapter it may coalesce concepts only when
their normalized names and local keys are exactly equal; it unions and
source-orders their authorized span IDs and deterministically remaps local
prerequisites. It performs no fuzzy semantic merge. It preserves valid local
prerequisite edges, rejects missing or cyclic edges, and adds no semantic
cross-segment prerequisite edge. The ordered curriculum itself therefore
retains source progression without inventing unsupported relationships.

The composed result records the partition manifest hash, ordered child result
hashes and complete model-call provenance, composition version and result
hash, embedding generation, generation version, owner/course/source identity,
and every chapter/concept source-span link. The existing atomic activation
boundary persists the complete `curriculum-v2` generation and all derived
rows, retires the prior active generation, and changes the course's active
pointer only after every validation succeeds. Failure leaves the previous
active generation unchanged and never exposes a partial outline.

No global relationship model pass exists in the v1 path. A future pass
requires a new typed versioned task and result, explicit deadline sub-budget,
deterministic admission and absence semantics, provenance, validation,
connected latency and quality evidence, and separate authorization; it cannot
silently become required or consume the finalization reserve.

#### Observability and evaluation

Emit one parent orchestration trace plus ADR 0010 logical child traces.
Allowlisted metadata includes contract/policy versions, segment ordinals and
opaque IDs, span and token counts, queue wait, model latency, attempt count,
remaining budget, composition/finalization latency, model usage, normalized
outcome, and sanitized terminal reason. Raw source text, prompts, generated
content, learner/contact data, credentials, provider payloads, and raw
diagnostics remain prohibited.

The connected implementation run records total latency, segment count,
per-segment latency distribution, composition/finalization latency, generated
chapter/concept counts, retry count, and terminal reason without presenting one
source run as the PRD p95 gate. ADR 0015 and PRD §11 continue to own the full
rights-cleared 40-document, five-concurrent-ingestion, three-runs-per-document
evaluation and honest reporting.

### Rationale

The measured failure is concentrated in one large structured-model critical
section after stable spans and embeddings already exist. Smaller independent
typed calls shorten that critical section through bounded parallelism while
preserving the existing provider, route, authorization, and source-provenance
boundaries. Deterministic composition avoids adding another variable-latency
model call and makes replay, idempotency, and exact result identity testable.

Preferring real section boundaries retains document intent when the parser
provides it. Applying the same bounded contiguous fallback to missing and
oversized sections makes the contract work for the approved source and for
ordinary PDFs without pretending that every document has reliable headings.
Complete partition coverage is stronger than the diagnostic's sampled input
and prevents latency optimization from silently discarding source regions.

The monolithic option has already missed the unchanged deadline under both
full and bounded prompts. A heading-only skeleton cannot cover the approved
sectionless normalized artifact without separate parser work and would remain
weak for documents whose headings do not encode instructional structure. A
target or profile relaxation changes the PRD and was explicitly rejected.

## Verification

Partition fixtures cover multiple genuine sections, one section, no sections,
oversized sections, a maximal individual span, mixed section paths, stable
replay, every ceiling boundary, and rejection of gaps, overlaps, duplicates,
reordering, profile mismatches, and cross-owner/source/generation
contamination. The approved seeded normalized artifact proves that the
sectionless fallback emits multiple bounded segments and assigns all 148
source spans exactly once.

Model-router contract tests register `curriculum.segment.v1`, freeze its
prompt/input/result/schema/parameter/route identities, accept both closed
result variants, and reject every malformed, foreign, partially
non-instructional, unauthorized-source, duplicate-key, and invalid-prerequisite
result. Import and composition tests reject provider/model branching or direct
provider calls outside the shared router and prove traces contain only
allowlisted metadata.

Concurrency and deterministic-clock tests prove no more than four child calls
run for one parent, every child respects its 30-second and parent ceilings, the
12-second reserve is never consumed by new model work, router and outer
retries do not reset budgets, and no work starts or commits late. Fault
injection covers crash and recovery before/after manifest persistence, child
claim, model return, child finalization, composition, parent finalization, and
broker acknowledgement without duplicate calls, chapters, concepts, effects,
or false success.

Composition fixtures shuffle completion order and vary retry metadata while
producing byte-identical results and IDs. They cover exact adjacent
coalescence, non-adjacent and fuzzy non-coalescence, local prerequisite
remapping, cycle and missing-edge rejection, source ordering, every
non-instructional reason, complete child-set enforcement, owner isolation,
atomic activation, rollback, and late-result rejection.

The connected approved-source run must reach a grounded `outline_ready` under
the shipped policy before implementation issue #182 closes, or record a new
evidence-backed blocker without claiming success. Controlled browser
verification remains with issue #183. Repository governance, architecture,
problem-document, model-router, retrieval, database, worker-recovery,
ingestion, and Flow B suites remain green.

## Reversal criteria

Supersede if bounded segment calls still cannot meet the unchanged connected
deadline; the fixed partition ceilings materially reduce curriculum coverage
or quality; provider throttling makes four-way orchestration less reliable than
another bounded design; deterministic composition cannot produce a usable
prerequisite-ordered outline without a required global pass; durable child
state creates unacceptable contention or storage cost; or the full PRD
evaluation shows worse grounding, completeness, latency, or failure behavior
than an authorized alternative.

Any successor must preserve the PRD target unless the PRD itself changes,
stable source-span and owner provenance, ADR 0010/0024 traced routing,
ADR 0012 replay safety and first-terminal-state-wins behavior, one absolute
deadline, bounded work, strict validation, atomic activation, honest failure,
privacy-safe observability, and the unchanged semantics of
`curriculum.structure.v1`.
