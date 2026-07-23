---
id: "0016"
title: "Provisional Bayesian mastery and reproducibility contract"
status: Accepted
date: "2026-07-20"
aliases: [D-GH-16]
prd_references: "`prds/reflo-prd.md` §6 F3–F6, §10, §11, §12, and §13; mandate M-003; pending issue #17"
ownership:
  proposer: "codex-root"
  decision_dri: "@deepessh"
  implementation_owner: "Owners of the knowledge-model, per-concept evidence, canonical replay, Knowledge Map, and Flow B implementation issues"
authorization:
  decider: "@deepessh, repository owner and founding-team decider named in the originating issue"
  approval_basis: "Owner-authored authorization and approval basis are preserved by the exact verdict comment linked in provenance."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/16
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/16#issuecomment-5028189570
  record_pr: https://github.com/deepessh/reflo-learning/pull/93
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0016: Provisional Bayesian mastery and reproducibility contract

## Context

Reflo needs one conservative, evidence-only mastery update that is deterministic enough for the seeded Flow B and honest enough not to present an unassessed or weakly evidenced concept as known. The sprint has no representative Reflo history from which to fit course, item, or learner parameters. This verdict controls the provisional Bayesian prior, normalized per-concept evidence consumption, mastery and confidence projections, sufficient statistics, arithmetic, replay ordering, versioning, and golden fixtures. It does not authorize a calibrated psychometric or exam-readiness claim; change the PRD `0.60` re-teach trigger; select an FSRS generation, library, parameter vector, retention target, fuzz rule, or learning/relearning profile; or decide rubric bands, grader-confidence and abstention thresholds, multiple-choice replacement, per-concept score construction, eligibility, or score-to-FSRS rating mapping. Issue #17 owns those assessment choices, and a separately authorized scheduler profile owns FSRS implementation semantics.

## Options

Fixed, documented, versioned sprint priors and mappings; course-specific configured priors before representative calibration data exists; unversioned heuristic tuning. Classic four-parameter Bayesian Knowledge Tracing and item-difficulty weighting were reviewed as future calibrated models, not adopted as unfit parameters for this sprint.

## Decision

### Authorized verdict

Adopt provisional `knowledge-model-v1`. For every learner/concept, initialize exact sufficient statistics with `alpha = 1` and `beta = 3`. The resulting prior mean is `0.25`, but zero eligible evidence is always surfaced as `unassessed`, never as measured 25 percent mastery. For each unique immutable per-concept outcome that #17 marks eligible, consume its normalized score `s` in `[0,1]` with unit evidence mass and apply `alpha := alpha + s` and `beta := beta + (1 - s)`. Project mastery as `alpha / (alpha + beta)`. This is a generalized-Bayes soft-evidence accumulator, not ordinary binary Beta-Bernoulli conjugacy, a fitted BKT model, or evidence that the learner occupies a binary mastered state. Apply no separate learning transition: lesson exposure, question presentation, retrieval practice, and time passing do not raise or lower mastery without an eligible scored outcome.

Apply no course, declared item-difficulty, modality, item-type, or grader-confidence weight in v1. A multi-concept item updates each concept only from its own immutable outcome; never copy or divide an overall grade across concepts. `graded` alone is insufficient. Abstained, superseded, ineligible, exposure, completion, engagement, duplicate, or replayed evidence produces no update. Define `KnowledgeState.confidence` for this version as evidence strength `n / (n + 4)`, where `n = alpha + beta - 4` is total eligible evidence mass. It measures how much posterior mass came from accepted evidence rather than the fixed prior; it is not posterior correctness probability, calibration, or agreement. Contradictory evidence may therefore yield high evidence strength and mastery near `0.5`, which the UI and downstream policy must not mislabel as confident mastery.

Treat each stored score as an exact integer multiple of `0.00001`: initialize `alpha` and `beta` as `100000` and `300000` quanta, add `score * 100000` and `100000 - score * 100000`, and retain those lossless sufficient statistics or an equivalent exact representation. Compute projections from the exact integers and round non-negative halfway cases away from zero to five decimal places only when persisting the existing `numeric(6,5)` mastery and confidence projections. Canonical replay deduplicates by the per-concept evidence primary identity and orders accepted inputs by `attempt.created_at`, then `attempt.id`, then `concept.id`; the commutative v1 accumulator must nevertheless produce the same result under arrival-order permutations. Incremental updates and full ledger replay must be byte-equivalent at the canonical persisted projection and exact-state levels. Store the algorithm version and immutable configuration identity with evidence and state. A new algorithm or parameter set creates a new version and never silently reinterprets historical outputs.

Elapsed time does not mutate mastery or evidence strength. Forgetting, current retrievability, and due-review urgency remain separate versioned FSRS state consumed under M-003. FSRS stability is the interval at its versioned reference retrievability and must not be relabeled as literal half-life; `KnowledgeState.half_life` may contain only a mathematically derived, versioned true half-life from the separately authorized forgetting curve. Issue #17 exclusively produces eligible normalized scores and FSRS ratings; this updater only consumes its score and eligibility result.

### Rationale

Per-concept Bayesian knowledge tracing is an established learner-modeling pattern, while generalized Bayesian updating provides a coherent basis for accumulating soft scored evidence when a literal binary likelihood is not claimed. The exact `Beta(1,3)` prior and evidence-strength projection are deliberately transparent sprint policy choices, not research-fitted Reflo parameters. The asymmetric four-unit prior starts below the PRD re-teach threshold, resists a single lucky result, and still produces a visible evidence-only delta after a correct re-test. Refusing uncalibrated difficulty, guess, slip, learning, course, and grader-confidence weights avoids false precision during a three-week sprint. Separating mastery evidence from FSRS forgetting honors the PRD rule that time and exposure alone cannot change mastery. Research reviewed includes Corbett and Anderson, “Knowledge tracing: Modeling the acquisition of procedural knowledge” (`https://doi.org/10.1007/BF01099821`), and Bissiri, Holmes, and Walker, “A General Framework for Updating Belief Distributions” (`https://doi.org/10.1111/rssb.12158`).

## Verification

Golden fixtures assert the exact empty prior and `unassessed` presentation; one partial score of `0.5` yields mastery `0.30000` and evidence strength `0.20000`; two incorrect outcomes yield `0.16667` and `0.33333`; a following correct re-test yields `0.28571` and `0.42857`; three consecutive correct outcomes remain below the PRD trigger boundary at `0.57143`, while four yield `0.62500`; and contradictory sequences preserve exact sufficient statistics. Fixtures also cover lower and upper score bounds, halfway rounding, long-sequence capacity, abstained, superseded, ineligible, duplicate and replayed evidence, independent multi-concept outcomes, same-timestamp tie-breaking, out-of-order arrival, concurrent duplicate admission, incremental-versus-full canonical replay, algorithm-version replay, and forbidden mastery changes from exposure, time, or FSRS-only transitions. The seeded Flow B fixture proves the failed evidence leaves mastery below `0.60`, the different lesson alone causes no change, the eligible correct re-test alone raises mastery by the exact expected delta, and the UI displays that delta without calling the concept mastered. Static and contract tests keep #17-owned score, eligibility, threshold, rubric and rating logic out of the mastery updater and keep scheduler package or parameter defaults out of `knowledge-model-v1`.

## Reversal criteria

Supersede when consented, rights-authorized, representative evidence supports a materially better prior or update through held-out calibration, Brier score or log loss, PRD-threshold sensitivity, and Flow B behavior; when a calibrated BKT, item-response, hierarchical, or other established model materially improves prediction without violating sprint or privacy constraints; or when this accumulator cannot satisfy the PRD evidence-only, reproducibility, grading-precision, deletion, or pilot gates. Any successor must remain versioned, deterministic, replayable, per-concept and evidence-only, preserve historical interpretation, and distinguish epistemic evidence strength from mastery and time-dependent retrievability.
