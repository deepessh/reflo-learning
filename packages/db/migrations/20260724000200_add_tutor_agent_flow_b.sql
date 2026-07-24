-- migrate:up

ALTER TABLE asset
  DROP CONSTRAINT asset_ready_text_metadata_check,
  ADD COLUMN reteach_session_id uuid,
  ADD COLUMN reteach_replacement_ordinal smallint,
  ADD COLUMN reteach_baseline_mastery numeric(6, 5),
  ADD COLUMN reteach_semantic_similarity numeric(6, 5),
  ADD COLUMN reteach_generation_id uuid,
  ADD COLUMN reteach_served_at timestamptz,
  ADD CONSTRAINT asset_reteach_session_scope_fk
    FOREIGN KEY (owner_scope_id, reteach_session_id)
    REFERENCES study_session(owner_scope_id, id),
  ADD CONSTRAINT asset_reteach_identity
    UNIQUE (
      owner_scope_id,
      reteach_session_id,
      concept_id,
      reteach_replacement_ordinal
    ),
  ADD CONSTRAINT asset_reteach_shape
    CHECK (
      (
        reteach_session_id IS NULL
        AND reteach_replacement_ordinal IS NULL
        AND reteach_baseline_mastery IS NULL
        AND reteach_semantic_similarity IS NULL
        AND reteach_generation_id IS NULL
        AND reteach_served_at IS NULL
      )
      OR (
        reteach_session_id IS NOT NULL
        AND reteach_replacement_ordinal BETWEEN 1 AND 2
        AND reteach_baseline_mastery BETWEEN 0 AND 1
        AND reteach_semantic_similarity >= -1
        AND reteach_semantic_similarity < 0.85
        AND reteach_generation_id IS NOT NULL
        AND reteach_served_at IS NOT NULL
        AND asset_type = 'text'
        AND status = 'ready'
        AND chapter_id IS NOT NULL
        AND concept_id IS NOT NULL
        AND generation_operation_id IS NULL
        AND audio_generation_operation_id IS NULL
        AND generation_version = 'reteach-generation-v1'
        AND model_provenance->>'task' = 'lesson.reteach.v1'
        AND model_provenance->>'validationOutcome' = 'passed'
      )
    ),
  ADD CONSTRAINT asset_ready_text_metadata_check
    CHECK (
      asset_type <> 'text'
      OR status <> 'ready'
      OR (
        model_provenance IS NOT NULL
        AND content_hash IS NOT NULL
        AND content_type IS NOT NULL
        AND byte_size IS NOT NULL
        AND etag IS NOT NULL
        AND (
          (
            generation_operation_id IS NOT NULL
            AND reteach_session_id IS NULL
          )
          OR (
            generation_operation_id IS NULL
            AND reteach_session_id IS NOT NULL
          )
        )
      )
    );

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
