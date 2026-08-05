-- migrate:up

ALTER TABLE activation_generation_operation
  ADD COLUMN regeneration_ordinal smallint NOT NULL DEFAULT 0,
  ADD COLUMN parent_operation_id uuid,
  ADD COLUMN request_idempotency_key text,
  ADD COLUMN requested_session_id uuid,
  ADD CONSTRAINT activation_generation_operation_regeneration_ordinal_check
    CHECK (regeneration_ordinal >= 0),
  ADD CONSTRAINT activation_generation_operation_regeneration_shape_check
    CHECK (
      (regeneration_ordinal = 0
       AND parent_operation_id IS NULL
       AND request_idempotency_key IS NULL
       AND requested_session_id IS NULL)
      OR
      (regeneration_ordinal > 0
       AND artifact_kind = 'first_text_lesson'
       AND parent_operation_id IS NOT NULL
       AND request_idempotency_key IS NOT NULL
       AND requested_session_id IS NOT NULL)
    ),
  ADD CONSTRAINT activation_generation_operation_parent_operation_id_fkey
    FOREIGN KEY (parent_operation_id)
    REFERENCES activation_generation_operation(id),
  ADD CONSTRAINT activation_generation_operation_request_key_check
    CHECK (
      request_idempotency_key IS NULL
      OR request_idempotency_key ~
        '^(dev|staging|pilot)/content[.]activation[.]regenerate/v1/[a-f0-9-]{36}$'
    );

CREATE UNIQUE INDEX activation_generation_operation_regeneration_request_key
  ON activation_generation_operation (owner_scope_id, request_idempotency_key)
  WHERE request_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX activation_generation_operation_regeneration_ordinal
  ON activation_generation_operation (
    owner_scope_id,
    course_id,
    curriculum_generation_id,
    artifact_kind,
    regeneration_ordinal
  )
  WHERE artifact_kind = 'first_text_lesson'
    AND generation_version = 'activation-generation-v2';

-- migrate:down
-- Forward-only. Restore through a reviewed compensating migration.
