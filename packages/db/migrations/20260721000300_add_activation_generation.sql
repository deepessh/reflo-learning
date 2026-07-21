-- migrate:up

ALTER TABLE chapter
  ADD CONSTRAINT chapter_scope_course_id_unique
  UNIQUE (owner_scope_id, course_id, id);

ALTER TABLE concept
  ADD CONSTRAINT concept_scope_chapter_id_unique
  UNIQUE (owner_scope_id, chapter_id, id);

CREATE TABLE activation_generation_operation (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  curriculum_generation_id uuid NOT NULL,
  artifact_kind text NOT NULL CHECK (
    artifact_kind IN ('first_text_lesson', 'placement_quiz', 'chapter_quiz')
  ),
  chapter_id uuid,
  concept_id uuid,
  generation_version text NOT NULL CHECK (
    generation_version = 'activation-generation-v1'
  ),
  idempotency_key text NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^(dev|staging|pilot)/content[.]activation[.]generate/v1/[a-f0-9-]{36}$'
  ),
  priority smallint NOT NULL CHECK (priority BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued', 'processing', 'retry_scheduled', 'succeeded',
      'failed_permanent', 'cancelled', 'expired'
    )
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  retryable boolean NOT NULL DEFAULT false,
  failure_class text,
  artifact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, course_id, curriculum_generation_id)
    REFERENCES curriculum_generation(owner_scope_id, course_id, id),
  FOREIGN KEY (owner_scope_id, course_id, chapter_id)
    REFERENCES chapter(owner_scope_id, course_id, id),
  FOREIGN KEY (owner_scope_id, chapter_id, concept_id)
    REFERENCES concept(owner_scope_id, chapter_id, id),
  CHECK (
    (artifact_kind = 'first_text_lesson' AND chapter_id IS NOT NULL AND concept_id IS NOT NULL)
    OR (artifact_kind = 'placement_quiz' AND chapter_id IS NULL AND concept_id IS NULL)
    OR (artifact_kind = 'chapter_quiz' AND chapter_id IS NOT NULL AND concept_id IS NULL)
  ),
  CHECK ((status = 'retry_scheduled') = retryable),
  CHECK (
    (failure_class IS NOT NULL) =
    (status IN ('retry_scheduled', 'failed_permanent'))
  ),
  CHECK ((artifact_id IS NOT NULL) = (status = 'succeeded')),
  CHECK (
    (completed_at IS NOT NULL) =
    (status IN ('succeeded', 'failed_permanent', 'cancelled', 'expired'))
  ),
  CHECK (status <> 'queued' OR attempt_count = 0)
);

CREATE UNIQUE INDEX activation_generation_operation_target_idx
  ON activation_generation_operation
  (owner_scope_id, course_id, curriculum_generation_id, artifact_kind,
   chapter_id, concept_id, generation_version) NULLS NOT DISTINCT;

CREATE INDEX activation_generation_operation_pending_idx
  ON activation_generation_operation (status, priority, updated_at)
  WHERE status IN ('queued', 'retry_scheduled');

CREATE FUNCTION reflo_preserve_terminal_activation_operation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed_permanent', 'cancelled', 'expired')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal state on % is immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER activation_generation_operation_terminal_is_final
BEFORE UPDATE ON activation_generation_operation
FOR EACH ROW EXECUTE FUNCTION reflo_preserve_terminal_activation_operation();

ALTER TABLE asset
  ADD COLUMN generation_operation_id uuid,
  ADD COLUMN model_provenance jsonb,
  ADD COLUMN content_hash text CHECK (
    content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN content_type text,
  ADD COLUMN byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  ADD COLUMN etag text,
  ADD CONSTRAINT asset_generation_operation_fk
  FOREIGN KEY (owner_scope_id, generation_operation_id)
  REFERENCES activation_generation_operation(owner_scope_id, id),
  ADD CONSTRAINT asset_ready_text_metadata_check CHECK (
    asset_type <> 'text' OR status <> 'ready' OR (
      generation_operation_id IS NOT NULL
      AND model_provenance IS NOT NULL
      AND content_hash IS NOT NULL
      AND content_type IS NOT NULL
      AND byte_size IS NOT NULL
      AND etag IS NOT NULL
    )
  );

CREATE UNIQUE INDEX asset_generation_operation_idx
  ON asset (owner_scope_id, generation_operation_id)
  WHERE generation_operation_id IS NOT NULL;

CREATE TABLE quiz_bank (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  chapter_id uuid,
  generation_operation_id uuid NOT NULL,
  bank_kind text NOT NULL CHECK (bank_kind IN ('placement', 'chapter')),
  generation_version text NOT NULL CHECK (
    generation_version = 'activation-generation-v1'
  ),
  model_provenance jsonb NOT NULL,
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  item_count integer NOT NULL CHECK (item_count IN (5, 10)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, generation_operation_id),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, course_id, chapter_id)
    REFERENCES chapter(owner_scope_id, course_id, id),
  FOREIGN KEY (owner_scope_id, generation_operation_id)
    REFERENCES activation_generation_operation(owner_scope_id, id),
  CHECK (
    (bank_kind = 'placement' AND chapter_id IS NULL AND item_count = 10)
    OR (bank_kind = 'chapter' AND chapter_id IS NOT NULL AND item_count = 5)
  )
);

ALTER TABLE quiz_item
  ADD COLUMN quiz_bank_id uuid,
  ADD COLUMN item_order integer CHECK (item_order IS NULL OR item_order >= 0),
  ADD COLUMN normalized_prompt_hash text CHECK (
    normalized_prompt_hash IS NULL OR normalized_prompt_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN response_options jsonb,
  ADD CONSTRAINT quiz_item_bank_fk
  FOREIGN KEY (owner_scope_id, quiz_bank_id)
  REFERENCES quiz_bank(owner_scope_id, id),
  ADD CONSTRAINT quiz_item_generated_shape_check CHECK (
    quiz_bank_id IS NULL OR (
      item_order IS NOT NULL
      AND normalized_prompt_hash IS NOT NULL
      AND (
        (item_type = 'short_answer' AND rubric IS NOT NULL AND response_options IS NULL)
        OR (
          item_type IN ('multiple_choice', 'concept_linking')
          AND rubric IS NULL
          AND jsonb_typeof(response_options) = 'array'
          AND jsonb_array_length(response_options) >= 2
        )
      )
    )
  );

CREATE UNIQUE INDEX quiz_item_bank_order_idx
  ON quiz_item (owner_scope_id, quiz_bank_id, item_order)
  WHERE quiz_bank_id IS NOT NULL;

CREATE UNIQUE INDEX quiz_item_bank_prompt_idx
  ON quiz_item (owner_scope_id, quiz_bank_id, normalized_prompt_hash)
  WHERE quiz_bank_id IS NOT NULL;

ALTER TABLE activation_generation_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_generation_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY activation_generation_operation_active_membership
  ON activation_generation_operation
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE quiz_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_bank FORCE ROW LEVEL SECURITY;
CREATE POLICY quiz_bank_active_membership
  ON quiz_bank
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
