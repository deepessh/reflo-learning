# Learning evidence integrity

> **Non-authoritative:** This document explores a durable architectural problem. It does not authorize architecture, record a decision, or track delivery work. Product requirements remain in the [PRD](../../prds/reflo-prd.md), and accepted architecture decisions remain in the [ADR collection](../adrs/README.md).

## Problem

Reflo makes learner-facing claims about mastery, forgetting, review timing, and
the value of a re-teach intervention. Those claims depend on a chain that begins
with authorized source material, passes through generated questions and
versioned grading, and ends in reproducible per-concept evidence and aggregate
learner state.

The durable problem is keeping that chain honest and explainable when one
interaction can touch several concepts, graders may abstain, generated
artifacts can change versions, and engagement signals must remain distinct from
assessment evidence.

## Forces and constraints

- Lessons, questions, tutoring responses, and curriculum concepts need durable
  source-span provenance, while only tutoring responses expose inline
  citations in the learner experience.
- Multiple-choice keys and short-answer judgments have different failure
  modes. Low-confidence grading becomes an abstention and cannot affect
  mastery.
- One answer can supply different evidence for several concepts. An overall
  grade is not enough to reproduce or justify those updates.
- Exposure, completion, and modality signals inform recommendations but cannot
  raise or lower mastery. Confident retrieval evidence is the boundary.
- Knowledge updates and spaced-repetition scheduling are versioned so that an
  observed state can be reconstructed from the evidence and algorithm in
  effect.
- A replacement lesson must be materially different, bounded within a session,
  and followed by a re-test; merely viewing it does not improve mastery.
- Exam readiness has stronger mapping, coverage, and calibration requirements
  than a course mastery estimate.

## Risks

- An unsupported generated claim acquires plausible-looking provenance that
  does not entail it.
- A grading retry, webhook replay, or replacement question creates duplicate or
  conflicting evidence.
- Low-confidence, superseded, engagement-only, or partially correct outcomes
  leak into mastery as if they were confident retrieval evidence.
- Regenerated concepts or changed objective mappings leave historical
  readiness calculations looking comparable when their evidence basis changed.
- A re-teach loop optimizes for a visible score increase by repeating surface
  form, updating on lesson exposure, or retrying until success.
- Tracing or evaluation captures learner answers or uploaded passages while
  trying to make the evidence chain observable.

## Evidence to preserve

- Immutable links among source spans, artifact versions, quiz items, attempts,
  per-concept outcomes, grading thresholds, and knowledge-algorithm versions.
- Fixtures that reproduce a knowledge-state transition from stored evidence,
  including abstention, partial-credit, supersession, and replay cases.
- Grounding and grading evaluations that retain dataset version, counts,
  reviewer basis, misses, and threshold behavior without retaining unnecessary
  learner data.
- Flow evidence showing that a weak-concept trigger uses stored assessment
  state, the replacement differs materially, and only the re-test changes
  mastery.
- Readiness calculations that expose blueprint and mapping versions, evidence
  coverage, excluded concepts, calibration sample size, and uncertainty.

## Open questions

- How can the evidence graph remain understandable to a learner while retaining
  the version detail needed for audit and reproduction?
- Which artifact changes invalidate future use only, and which make an existing
  aggregate incomparable or ineligible for display?
- How should conflicting confident evidence be surfaced without hiding
  uncertainty behind a single mastery number?
- What privacy-preserving evaluation record is sufficient to diagnose
  grounding or grading regressions after learner-linked data is deleted?

## Related authoritative sources

- [PRD §5; §6, F3–F5; §8; §10–§12](../../prds/reflo-prd.md)
- [ADR 0009 — versioned source-span embedding and vector namespace contract](../adrs/0009-versioned-source-span-embedding-and-vector-namespace-contract.md)
- [ADR 0010 — typed model routing, prompt provenance, retry, and trace contract](../adrs/0010-typed-model-routing-prompt-provenance-retry-and-trace-contract.md)
- [ADR 0015 — repository-owned release-gate evaluation evidence](../adrs/0015-repository-owned-release-gate-evaluation-evidence.md)
- [ADR 0016 — provisional Bayesian mastery and reproducibility contract](../adrs/0016-provisional-bayesian-mastery-and-reproducibility-contract.md)
- [ADR 0025 — versioned Bayesian mastery and FSRS-style scheduling](../adrs/0025-versioned-bayesian-mastery-and-fsrs-scheduling.md)
