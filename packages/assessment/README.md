# `@reflo/assessment`

This package owns the adaptive assessment domain boundary for PRD F3.

- `selectAdaptiveQuestions` deterministically prioritizes due and weak concepts,
  fits item difficulty, and excludes every normalized prompt already seen in
  the session.
- `AssessmentService` validates complete, versioned per-concept rubrics before
  using the shared model router. A frozen policy supplies the calibrated
  threshold; the package does not invent a production threshold.
- Any low-confidence or semantic-unanswerable concept abstains the whole
  short-answer attempt. Diagnostic candidates remain ineligible.
- Abstention creates one deterministic, source-backed, single-concept
  multiple-choice replacement per expected concept. Only keyed replacement
  evidence can update mastery after abstention.
- Repository finalization uses request digests and stable lineage so replay
  does not duplicate attempts, evidence, or fallback bundles.

The PostgreSQL adapter and normalized append-only persistence live in
`packages/db`.
