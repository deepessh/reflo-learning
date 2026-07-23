---
id: "0030"
title: "Versioned grading, abstention, fallback, and FSRS rating contract"
status: Accepted
date: "2026-07-23"
aliases: [D-GH-17]
prd_references: "`prds/reflo-prd.md` §6 F3–F6, §8 Flow B–C, §10, §11, and §13; issue #17 proposal P-015; ADR 0010; ADR 0012; ADR 0015; ADR 0016; ADR 0025"
ownership:
  proposer: "codex-root through issue #17"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of issues #39, #40, and #48 for the separately claimed implementation and gate work"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in issue #17"
  approval_basis: |
    ** Direct owner approval in the Codex task on 2026-07-23 after
    reviewing proposal v3 in
    [comment 5061879384](https://github.com/deepessh/reflo-learning/issues/17#issuecomment-5061879384),
    the two independent agent reviews, and the revisions they required. The owner
    then instructed Codex to proceed with the matching ADR and repository workflow.
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/17
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/17#issuecomment-5062022111
  record_pr: https://github.com/deepessh/reflo-learning/pull/148
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0030: Versioned grading, abstention, fallback, and FSRS rating contract

## Context

Short-answer grading must turn model-produced judgments into immutable
per-concept evidence without letting low confidence, malformed output, retries,
or an overall item grade corrupt mastery or review state. The PRD requires a
frozen confidence threshold, attempt-level abstention with a multiple-choice
replacement, confident per-concept evidence, and a pre-pilot grading gate. ADR
0016 consumes only an eligible normalized score and leaves rubric bands,
eligibility, fallback, and FSRS rating production to this decision.

The existing grading input provides one unversioned rubric string for a
multi-concept item, the result contract accepts arbitrary band strings and
scores, and the database cannot distinguish semantic inability to grade from
keyed evidence without fabricated confidence. Existing contracts also lack
normalized policy, rubric, rating, and replacement identities. This verdict
controls the v1 grading-policy identity and threshold selection; versioned
per-concept rubrics and judgments; attempt-level abstention; MC replacement;
result, retry, persistence, privacy, and evaluation consequences; and
evidence-to-FSRS rating mapping. It does not choose an FSRS generation,
implementation, parameters, retention target, fuzz behavior, or
learning/relearning profile, and rating emission does not authorize a schedule
transition.

## Options

One global evidence-selected and frozen threshold with closed rubric bands,
whole-attempt abstention, replay-safe per-concept fallback, and a conservative
two-rating FSRS mapping; item-, band-, concept-, course-, or learner-specific
thresholds before representative calibration data exists; unconstrained model
confidence; partial admission from a mixed-confidence attempt; schema retries
that reinvoke the grader; or a single overall replacement key copied across
concepts.

## Decision

### Authorized verdict

Adopt `grading-policy-v1`.

Use one global per-concept short-answer confidence threshold `tau`. V1 has no
item-, band-, concept-, course-, learner-, or environment-specific thresholds.
The immutable grading-policy identity binds the exact grading prompt, route
policy, resolved model, input/result schemas, rubric schema, score mapping,
`tau`, and FSRS rating mapping. A change to a bound identity creates a new
grading-policy version and invalidates dependent gate evidence.

Do not assign a production numeric threshold before calibration evidence
exists. Before labels or outputs are inspected, the ADR 0015 dataset and gate
manifests freeze a finite candidate grid; disjoint calibration and held-out
membership; grouping by question/rubric/source cluster; human-label, reviewer,
adjudication, scoring, exclusion, and threshold-selection protocols; one frozen
expected-concept set and adjudicated judgment per expected concept for every
submitted response; and response-level gate metrics with diagnostic
per-concept metrics.

Choose the lowest candidate `tau` that achieves at least 95 percent
response-level precision across at least 20 auto-graded calibration attempts.
Freeze it to five decimal places, then run a separate held-out set of at least
100 human-labeled submitted responses.

One evaluation unit is one submitted response with its frozen expected-concept
set. Response-level exact agreement requires every expected concept to match
adjudication exactly. Response-level within-one-band agreement requires every
expected gradable concept to be within ordinal distance one across
`incorrect < partially_correct < correct`. Semantic `unanswerable` has no
ordinal distance and matches only adjudicated `unanswerable`. A scored judgment
on adjudicated `unanswerable`, semantic `unanswerable` on a gradable concept, or
any missing, duplicate, extra, structurally invalid, low-confidence, or absent
judgment makes the response a miss. Per-concept metrics are diagnostic only.

An attempt enters the response-level precision denominator only when every
expected concept has a structurally valid scored judgment at or above `tau`.
It is correct only when every expected band exactly matches adjudication.
Calibration and held-out precision each require at least 20 auto-graded
attempts; a smaller denominator is `indeterminate`, never passing. The
held-out run uses all responses for exact and within-one-band denominators and
must meet the PRD thresholds: at least 90 percent exact, at least 95 percent
within one band, and at least 95 percent precision among auto-graded attempts.
Publish response-level and diagnostic per-concept numerators and denominators,
abstention counts, auto-graded `n/N` coverage, and a two-sided 95 percent Wilson
binomial interval for precision as a diagnostic. Do not tune on the held-out
set. If no threshold qualifies, a minimum denominator is not met, or the
held-out gate fails, production remains fallback-only and the gate is failed or
indeterminate, blocking pilots.

The grading input carries exactly one versioned rubric entry for each expected
concept: concept ID, immutable rubric ID and version, required criteria,
material contradictions, and authorized source-span IDs sufficient to apply
the rubric. The caller validates exact coverage, rubric structure, and
authorized span resolution before model invocation. Missing, duplicate, extra,
malformed, unauthorized, or unresolved input is a pre-invocation
caller-contract failure, not `unanswerable`; it cannot update mastery or emit a
rating. A learner-safe failure is shown, and replacement is offered only
through a valid source-backed keyed path.

Use these closed judgments:

- `incorrect`: score `0.00000`; no required criterion is correctly
  demonstrated or a material contradiction defeats the core concept; failing
  band; eligible rating `Again` (`1`).
- `partially_correct`: score `0.50000`; at least one but not all required
  criteria are correctly demonstrated without a defeating material
  contradiction; failing band; eligible rating `Again` (`1`).
- `correct`: score `1.00000`; every required criterion is demonstrated with no
  material contradiction; the sole passing band; eligible rating `Good` (`3`).
- `unanswerable`: no score and no rating; structurally valid authorized inputs
  exist but their content is contradictory or insufficient. Its closed reason
  is `source_insufficient`, `source_conflict`, `rubric_insufficient`, or
  `rubric_conflict`.

`Unanswerable` does not mean the learner wrote “I don't know,” submitted blank
text, or gave an obviously wrong answer; those are `incorrect` when valid
source and rubric inputs support that judgment. Automatic grading emits no
`Hard` or `Easy`. Generated item difficulty and item type do not alter the
rating.

Use a versioned discriminated result with exactly one expected-concept entry:
either a scored LLM judgment with the closed band, exact fixed score, and
unit-range grader confidence normalized to five decimals; or semantic
`unanswerable` with one closed reason, no score, no confidence, and no rating.
The result covers every expected concept exactly once and contains no extras.
Trusted router provenance binds policy, prompt, route, model, schema, and
generation identities; model output cannot assert trusted provenance.

A missing, duplicate, extra, malformed, band/score-inconsistent, or otherwise
schema-invalid model result terminates the logical grading call under ADR 0010
and normalizes to non-retryable `invalid_result` under ADR 0012. It receives no
immediate schema retry. Finalization atomically marks or reuses the original
abstained attempt and creates or reuses its fallback bundle. Queue retry,
redrive, or duplicate delivery may replay finalization but must not invoke the
grader again. Corrected intent uses a new causally linked operation and
idempotency key. Eligible transient provider failures retain their separately
authorized handling.

The original short-answer attempt is `graded` only when every expected concept
has a structurally valid scored LLM judgment, confidence `>= tau`, and a unique
non-superseded retrieval response eligible under this policy. The threshold is
inclusive. Confidence gates admission only and never weights ADR 0016's unit
evidence mass.

If any expected concept is semantic `unanswerable` or below `tau`, persist the
original attempt as `abstained`. None of its candidates may update mastery or
supply a scheduler rating. Retain candidates only as immutable, explicitly
ineligible diagnostic records. Tell the learner the response could not be
graded reliably and offer replay-safe MC fallback for every expected concept.
A partially correct multi-concept attempt may update only its own per-concept
scores when every expected concept has a structurally valid scored judgment
meeting `tau`. Leave `attempt.overall_grade` null in v1; the per-concept ledger
is authoritative.

The original abstained attempt and diagnostic candidates remain immutable.
Create one replacement bundle linked to the original attempt and policy
version. It contains one source-backed, single-concept keyed MC item per
expected concept unless a separately versioned item contract supplies
independent per-concept keys. Never copy one overall keyed result across
concepts. Every replacement differs from the original and other questions
served in the session.

The logical replacement identity derives from the original attempt, policy
version, and sorted expected-concept set; each item identity also binds its
concept. Retries and provider replays reuse those identities. Each replacement
answer creates its own attempt and deterministic per-concept evidence with
`grading_method = keyed_mc`. Keyed correctness, not fabricated confidence,
establishes eligibility; `grader_confidence` is null. Correct replacement
evidence records `1.00000` and supplies `Good`; incorrect evidence records
`0.00000` and supplies `Again`. Only replacement evidence may update mastery
and supply a rating after the original abstains.

Add a new versioned grading input/result contract and pre-pilot normalized,
constrained evidence storage for judgment kind; grading method
(`llm_short_answer` or `keyed_mc`); rubric ID and version; grading-policy and
rating-mapping versions; eligibility and closed ineligibility reason; nullable
grader confidence required only for scored LLM judgments; nullable rating
present only for eligible scored evidence; immutable replacement lineage; and
logical-flow uniqueness. `grader_provenance` JSON alone is insufficient. This
does not authorize changing `KnowledgeState` or `Attempt` after pilots are
live.

Learner answers and low-confidence diagnostic judgments are sensitive
assessment data. Keep them out of traces, DLQ diagnostics, issues, and
production evaluation exports. Traces retain only deny-by-default sanitized
policy/model/version/timing/outcome metadata. ADR 0015 evaluation remains
rights-cleared and non-learner-PII. Attempts, diagnostics, replacement lineage,
and derived evidence follow F7 deletion, withdrawal, retention, and export
handling.

Eligible per-concept outcomes record the policy version, rating-mapping
version, and supplied rating: `incorrect` or `partially_correct` maps to
`Again` (`1`); `correct` maps to `Good` (`3`); semantic `unanswerable`,
abstained, superseded, duplicate, exposure, or engagement emits no rating. This
verdict authorizes only evidence-to-rating mapping. A future separately
authorized scheduler profile chooses FSRS generation, implementation,
parameters, retention target, fuzzing, and learning/relearning behavior.
Storing or supplying a rating is not an authorized schedule transition.

### Rationale

A single threshold selected on frozen calibration data and verified against a
separate held-out set avoids treating a model's self-reported confidence as a
probability. Response-level denominators preserve the PRD's attempt-level gate,
and the 20-attempt floor prevents zero- or single-case precision from passing
without inventing a statistical-significance claim. Whole-attempt abstention
when any expected concept is low-confidence follows the PRD directly; the
replacement still produces independent per-concept evidence.

Closed operational rubric anchors make adjudication, the F5 pass band, and
ADR 0016's normalized input reproducible. Mapping both failing bands to
`Again` and the sole passing band to `Good` follows FSRS's failure/pass
semantics without pretending that correctness reveals hesitation or ease. A
two-rating mapping is sufficient for the sprint and leaves the independently
reversible scheduler profile undecided.

Discriminated contracts, normalized integrity fields, non-retryable invalid
results, and stable fallback identities close the replay and ambiguity gaps in
the current generic result and schema. Keeping learner answers and diagnostic
judgments out of traces and production evaluation exports preserves the
existing privacy boundary instead of turning reproducibility into a shadow
retention path.

## Verification

Fixtures and tests cover versioned per-concept rubrics and spans;
pre-invocation caller rejection; operational bands, scores, and closed
`unanswerable` reasons; exact threshold boundaries; complete concept coverage;
invalid-result non-retry and non-reinvocation across retry, redrive, and
duplicates; whole-attempt abstention for any low or unanswerable concept;
confident partial evidence only when all concepts meet `tau`; immutable
replacement lineage; single-concept MC keys; no repeated session question;
learner reliability messaging; null MC confidence; original-abstention versus
replacement-only mastery and rating effects; exact failing-band-to-`Again` and
`correct`-to-`Good` mapping, no `Hard` or `Easy`, and no schedule mutation;
null `overall_grade`; normalized integrity constraints and version-pinned
replay; deletion and export coverage with privacy exclusions;
calibration/held-out cluster isolation; frozen response-level scoring;
all-response agreement denominators; at least 20 auto-graded attempts in each
precision denominator; diagnostic per-concept metrics, `n/N` coverage, Wilson
interval reporting, and below-minimum `indeterminate`; and evidence
invalidation after any bound prompt, model, schema, rubric, threshold, or
rating change.

## Reversal criteria

Supersede when rights-authorized representative evidence supports safer,
higher-coverage band- or item-specific thresholds; a richer score model
improves held-out accuracy without weakening reproducibility; reliable effort
or latency evidence justifies `Hard` or `Easy`; the PRD permits partial
admission from a mixed-confidence attempt; the minimum precision denominator
is materially too weak or infeasible; or the fallback cannot meet learner
experience, precision, privacy, or replay requirements. Any successor preserves
fail-closed attempt-level abstention, immutable per-concept evidence,
replay-safe fallback, historical interpretation, privacy and deletion
handling, and the rule that exposure and low-confidence results cannot update
mastery or emit ratings.
