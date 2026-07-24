# `@reflo/assessment`

This package owns the adaptive assessment domain boundary for PRD F3.

- `selectAdaptiveQuestions` deterministically prioritizes due and weak concepts,
  fits item difficulty, and excludes every normalized prompt already seen in
  the session.
- Before model invocation, the repository atomically claims the logical
  grading operation and resolves the question, rubrics, source spans, and
  fallback candidates from the authorized active session. Concurrent
  duplicates wait for and replay that claim.
- A frozen policy binds static prompt/model/schema identities and the calibrated
  threshold. Per-invocation prompt digests remain request provenance; the
  package does not invent a production threshold.
- Any low-confidence or semantic-unanswerable concept abstains the whole
  short-answer attempt. Diagnostic candidates remain ineligible.
- Abstention creates one deterministic, source-backed, single-concept
  multiple-choice replacement per expected concept. Only keyed replacement
  evidence can update mastery after abstention. Learner-visible replacement
  DTOs never contain the keyed answer.
- Repository finalization uses request digests and stable lineage so replay
  does not duplicate attempts, evidence, or fallback bundles. Served questions
  and immutable replacement snapshots enforce session no-repeat behavior
  independently of caller input.

The PostgreSQL adapter and normalized append-only persistence live in
`packages/db`.
