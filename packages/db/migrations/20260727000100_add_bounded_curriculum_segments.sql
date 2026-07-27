-- migrate:up

ALTER TABLE curriculum_generation
  DROP CONSTRAINT curriculum_generation_generation_version_check,
  ADD CONSTRAINT curriculum_generation_generation_version_check
    CHECK (generation_version IN ('curriculum-v1', 'curriculum-v2'));

CREATE TABLE curriculum_partition_manifest (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  embedding_generation_id uuid NOT NULL,
  partition_version text NOT NULL
    CHECK (partition_version = 'curriculum-partition-v1'),
  composition_version text NOT NULL
    CHECK (composition_version = 'curriculum-compose-v1'),
  generation_version text NOT NULL
    CHECK (generation_version = 'curriculum-v2'),
  tokenizer_version text NOT NULL
    CHECK (tokenizer_version = 'reflo-unicode-tokenizer-v1'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, course_id, id),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_document_id)
    REFERENCES source_document(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, embedding_generation_id)
    REFERENCES source_embedding_generation(owner_scope_id, id)
);

CREATE TABLE curriculum_segment_operation (
  owner_scope_id uuid NOT NULL,
  parent_generation_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  segment_ordinal integer NOT NULL CHECK (segment_ordinal >= 0),
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[a-z]+/curriculum[.]segment/v1/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  task_version text NOT NULL CHECK (task_version = 'curriculum.segment.v1'),
  input_schema_version text NOT NULL
    CHECK (input_schema_version = 'curriculum-segment-input-v1'),
  result_schema_version text NOT NULL
    CHECK (result_schema_version = 'curriculum-segment-result-v1'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  ordered_source_span_ids jsonb NOT NULL,
  ordered_source_input_hashes jsonb NOT NULL,
  state text NOT NULL
    CHECK (state IN (
      'queued', 'processing', 'retry_scheduled', 'succeeded',
      'failed_permanent', 'cancelled', 'expired'
    )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  result_hash text CHECK (
    result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'
  ),
  result jsonb,
  model_provenance jsonb,
  sanitized_failure jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (owner_scope_id, parent_generation_id, segment_id),
  UNIQUE (owner_scope_id, parent_generation_id, segment_ordinal),
  UNIQUE (owner_scope_id, idempotency_key),
  FOREIGN KEY (owner_scope_id, parent_generation_id)
    REFERENCES curriculum_partition_manifest(owner_scope_id, id),
  CHECK (
    (state = 'processing') =
      (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state = 'succeeded') =
      (result_hash IS NOT NULL AND result IS NOT NULL
       AND model_provenance IS NOT NULL)
  ),
  CHECK (
    (state IN ('succeeded', 'failed_permanent', 'cancelled', 'expired')) =
      (completed_at IS NOT NULL)
  )
);

CREATE INDEX curriculum_segment_operation_state_idx
  ON curriculum_segment_operation
    (owner_scope_id, parent_generation_id, state, segment_ordinal);

ALTER TABLE curriculum_partition_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE curriculum_partition_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY curriculum_partition_manifest_active_membership
  ON curriculum_partition_manifest
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE curriculum_segment_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE curriculum_segment_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY curriculum_segment_operation_active_membership
  ON curriculum_segment_operation
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
