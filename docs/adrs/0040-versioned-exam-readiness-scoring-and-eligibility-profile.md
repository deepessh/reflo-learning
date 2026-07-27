---
id: "0040"
title: "Versioned exam-readiness scoring and eligibility profile"
status: Accepted
date: "2026-07-27"
aliases: [D-GH-174]
prd_references: "`prds/reflo-prd.md` §6 F4, §10, §11, §12, and §13"
ownership:
  proposer: "@deepessh through issue #174"
  decision_dri: "@deepessh"
  implementation_owner: "Owner of issue #54 for implementation; agent:wt-71fc734b67931a75ae25 through issue #174 for this record"
authorization:
  decider: "@deepessh, repository owner and founding-team authorized decider"
  approval_basis: "explicit owner approval recorded on July 27, 2026, directing the agent to proceed with the recommended profile and record the decision."
provenance:
  kind: github-decision
  issue: https://github.com/deepessh/reflo-learning/issues/174
  verdict_comment: https://github.com/deepessh/reflo-learning/issues/174#issuecomment-5095742874
  record_pr: https://github.com/deepessh/reflo-learning/pull/193
supersedes: []
superseded_by: null
deprecation: null
maintenance: []
---

# ADR 0040: Versioned exam-readiness scoring and eligibility profile

## Context

The PRD permits an overall Exam Readiness Score only for a course mapped to a
versioned target-exam blueprint with reviewed, provenance-carrying concept
mappings. Unmapped concepts must be excluded and disclosed; insufficient
objective mapping or assessment coverage must block the score; concept
regeneration must invalidate affected mappings; and the product must not claim
exam calibration without adequate evidence. Otherwise, the aggregate remains a
Course Mastery Estimate.

ADR 0016 authorizes reproducible per-concept mastery under
`knowledge-model-v1`, including an unassessed Bayesian prior that must never be
surfaced as measured mastery. ADR 0030 authorizes which versioned per-concept
assessment outcomes are eligible to update that state. Neither decision
authorizes exam blueprints, objective mappings, an overall readiness formula,
numeric eligibility thresholds, mapping invalidation behavior, or calibration
labeling. The existing `course.target_exam_blueprint_id` reference alone does
not define those semantics.

This decision controls the independently reversible
`exam-readiness-profile-v1`: immutable blueprint and mapping versions, weight
normalization, evidence coverage, readiness scoring, regeneration invalidation,
reproducibility metadata, and honest learner-visible labeling. It does not
change the PRD, reinterpret historical knowledge evidence, authorize a
certification prediction, or assert that the sprint thresholds are
psychometrically fitted.

## Options

Adopt one strict repository-wide weighted profile with explicit mapping and
evidence gates; place configurable thresholds in each blueprint; relabel a
course-mastery average as readiness; or defer all readiness scoring until
representative external calibration exists.

## Decision

### Authorized verdict

Adopt `exam-readiness-profile-v1`.

Persist immutable versioned target-exam blueprints and objectives. Objective
weights are non-negative and sum exactly to `1.0` within a blueprint version.
Persist one immutable versioned mapping set whose reviewed mappings bind each
exam objective to course concepts with source and reviewer provenance. Mapping
weights are non-negative and sum exactly to `1.0` within each objective. Every
blueprint objective must have at least one reviewed active mapping; course
concepts not mapped to an objective are excluded from readiness and disclosed
as unmapped.

An active mapping records the mapped concept generation version and remains
active only while it exactly matches the current active concept generation. A
concept regeneration invalidates every mapping to the replaced generation.
Invalidated mappings cannot contribute to mapping coverage, evidence coverage,
or readiness until a reviewed mapping set binds the new active generation.
Historical blueprint, mapping, and score artifacts retain their original
versions and interpretation.

For objective `o`, let immutable blueprint weight `w_o` be its share of the
blueprint and let immutable mapping weight `m_oc` be concept `c`'s share within
that objective. A mapping is evidence-eligible only when it is active and its
concept has at least two eligible per-concept assessment outcomes under the
accepted grading policy. Let `E_o` be the evidence-eligible mappings for
objective `o`. Evidence coverage is:

`coverage = sum_o(w_o * sum_(c in E_o)(m_oc))`.

Readiness is eligible only when every objective has at least one
evidence-eligible active mapping and total evidence coverage is at least
`0.80`. These evidence requirements are additional to complete objective
mapping coverage.

For an eligible profile evaluation, compute each objective score by
renormalizing only its evidence-eligible active mapping weights:

`objective_score_o = sum_(c in E_o)(m_oc * mastery_c) / sum_(c in E_o)(m_oc)`.

Combine every objective score using the immutable blueprint weights:

`readiness = sum_o(w_o * objective_score_o)`.

`mastery_c` is the reproducible current mastery projection for the active
mapped concept under the declared knowledge-algorithm version. An
insufficient-evidence or invalidated mapping reduces disclosed coverage but
does not enter an objective numerator or denominator. In particular, the
unassessed `knowledge-model-v1` Bayesian prior never contributes as measured
readiness. Missing evidence is neither mastery nor failure.

Every computed readiness score records the readiness-profile, blueprint,
mapping-set, and knowledge-algorithm versions plus the objective, mapping,
evidence, and coverage counts needed to reproduce its eligibility and value.
Historical results are never silently recomputed under a new profile,
blueprint, mapping set, concept generation, or knowledge algorithm.

When every eligibility gate passes, display the score as
`Exam Readiness — Experimental`. When any gate fails, do not display an Exam
Readiness Score; display Course Mastery Estimate and disclose the missing,
unmapped, invalidated, or insufficient-evidence coverage that blocked
readiness.

External calibration metadata is optional for experimental-score eligibility
when no rights-authorized representative practice-score comparison exists. In
that case disclose `sample size: unavailable; error: unavailable`. When
calibration evidence exists but is inadequate, disclose its sample size and
error and retain the Experimental label. Remove that label only for a frozen
calibration version with at least 100 representative paired practice-score
observations and mean absolute error no greater than `0.10`. This criterion
does not turn the score into a certification-outcome guarantee.

### Rationale

A strict repository-wide profile makes scores comparable and prevents
per-blueprint thresholds from being tuned after results are observed. Complete
objective mapping plus per-objective evidence prevents a high score from
silently omitting an exam domain. Weighted evidence coverage permits an
experimental score before every mapped concept has been assessed while the
`0.80` threshold, two-outcome minimum, and honest disclosure favor omission
over false precision.

Renormalizing only evidence-eligible mappings avoids treating missing evidence
as failure. Excluding the Bayesian prior also preserves ADR 0016's distinction
between unassessed state and measured mastery. Immutable versions and explicit
generation invalidation make historical values reproducible, while separate
eligibility and calibration gates allow a clearly experimental demo score
without claiming fitted psychometric validity.

## Verification

Schema, repository, and service tests prove immutable blueprint, objective,
mapping-set, and score versions; exact objective and mapping normalization;
review and source provenance; complete objective mapping; generation-version
invalidation; unmapped-course-concept disclosure; and historical
interpretation after regeneration.

Golden scoring fixtures cover exact `0.80` eligibility, just-below-threshold
failure, at least one evidence-eligible mapping in every objective, the
two-outcome boundary, objective-local renormalization, weighted final
composition, exclusion of invalidated and insufficient-evidence mappings, and
the prohibition on using an unassessed Bayesian prior. Fixtures also prove
that every score binds the profile, blueprint, mapping-set, and
knowledge-algorithm versions and carries reproducible coverage counts.

UI and contract tests prove that every failed gate hides Exam Readiness and
shows Course Mastery Estimate with the applicable disclosure; eligible but
uncalibrated or inadequately calibrated scores remain Experimental; absent
calibration reports unavailable sample size and error; and the Experimental
label remains until a frozen representative calibration has at least 100
paired observations and mean absolute error no greater than `0.10`.

## Reversal criteria

Supersede when rights-authorized representative evidence supports materially
better mapping, coverage, evidence, or calibration thresholds; when a
validated psychometric model materially improves external prediction without
weakening reproducibility or honest labeling; when the strict profile prevents
legitimate blueprint representation; or when the formula cannot satisfy the
PRD's mapping, invalidation, evidence, calibration, and disclosure
requirements. Any successor must preserve historical versions, reviewed
provenance, regeneration invalidation, evidence-only mastery, explicit missing
coverage, and the rule that an unassessed prior cannot become measured
readiness.
