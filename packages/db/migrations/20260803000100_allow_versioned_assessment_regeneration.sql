-- migrate:up

ALTER TABLE activation_generation_operation
  DROP CONSTRAINT activation_generation_operation_regeneration_shape_check,
  ADD CONSTRAINT activation_generation_operation_regeneration_shape_check
    CHECK (
      (regeneration_ordinal = 0
       AND parent_operation_id IS NULL
       AND request_idempotency_key IS NULL
       AND requested_session_id IS NULL)
      OR
      (regeneration_ordinal > 0
       AND artifact_kind IN (
         'first_text_lesson',
         'placement_quiz',
         'chapter_quiz'
       )
       AND parent_operation_id IS NOT NULL
       AND request_idempotency_key IS NOT NULL
       AND requested_session_id IS NOT NULL)
    );

DROP INDEX activation_generation_operation_regeneration_ordinal;

CREATE UNIQUE INDEX activation_generation_operation_regeneration_ordinal
  ON activation_generation_operation (
    owner_scope_id,
    course_id,
    curriculum_generation_id,
    artifact_kind,
    chapter_id,
    concept_id,
    regeneration_ordinal
  ) NULLS NOT DISTINCT
  WHERE generation_version = 'activation-generation-v2';

-- migrate:down
-- Forward-only. Restore through a reviewed compensating migration.
