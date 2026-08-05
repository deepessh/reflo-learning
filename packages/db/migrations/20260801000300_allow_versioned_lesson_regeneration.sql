-- migrate:up

DROP INDEX activation_generation_operation_target_idx;

CREATE UNIQUE INDEX activation_generation_operation_target_idx
  ON activation_generation_operation (
    owner_scope_id,
    course_id,
    curriculum_generation_id,
    artifact_kind,
    chapter_id,
    concept_id,
    generation_version,
    regeneration_ordinal
  ) NULLS NOT DISTINCT;

-- migrate:down
-- Forward-only. Restore through a reviewed compensating migration.
