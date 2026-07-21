-- migrate:up

ALTER TABLE source_span
  ADD COLUMN contract_version text,
  ADD COLUMN chunk_order integer CHECK (chunk_order >= 0),
  ADD COLUMN native_mappings jsonb,
  ADD COLUMN embedding_input text,
  ADD COLUMN embedding_input_hash text CHECK (
    embedding_input_hash IS NULL OR embedding_input_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN embedding_input_profile_version text;

CREATE UNIQUE INDEX source_span_chunk_order_idx
  ON source_span (owner_scope_id, source_document_id, chunker_version, tokenizer_version, chunk_order)
  WHERE chunk_order IS NOT NULL;

CREATE TABLE source_embedding_generation (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  profile_version text NOT NULL CHECK (profile_version = 'embedding-v1'),
  dimensions integer NOT NULL CHECK (dimensions = 1024),
  input_mode text NOT NULL CHECK (input_mode = 'document'),
  adapter_version text NOT NULL,
  effective_model text NOT NULL,
  effective_model_version text NOT NULL,
  provider_identifier text NOT NULL,
  provider_request_ids jsonb NOT NULL,
  region text NOT NULL,
  endpoint text NOT NULL,
  span_count integer NOT NULL CHECK (span_count > 0),
  status text NOT NULL CHECK (status IN ('building', 'active', 'retired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, source_document_id, id),
  FOREIGN KEY (owner_scope_id, source_document_id)
    REFERENCES source_document(owner_scope_id, id),
  CHECK ((status IN ('active', 'retired')) = (activated_at IS NOT NULL))
);

CREATE TABLE source_embedding_generation_span (
  owner_scope_id uuid NOT NULL,
  embedding_generation_id uuid NOT NULL,
  source_span_id uuid NOT NULL,
  span_order integer NOT NULL CHECK (span_order >= 0),
  embedding_input_hash text NOT NULL CHECK (embedding_input_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (owner_scope_id, embedding_generation_id, source_span_id),
  UNIQUE (owner_scope_id, embedding_generation_id, span_order),
  FOREIGN KEY (owner_scope_id, embedding_generation_id)
    REFERENCES source_embedding_generation(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_span_id)
    REFERENCES source_span(owner_scope_id, id)
);

ALTER TABLE source_document
  ADD CONSTRAINT source_document_active_embedding_generation_fk
  FOREIGN KEY (owner_scope_id, active_embedding_generation_id)
  REFERENCES source_embedding_generation(owner_scope_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE curriculum_generation (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  embedding_generation_id uuid NOT NULL,
  generation_version text NOT NULL CHECK (generation_version = 'curriculum-v1'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  model_provenance jsonb NOT NULL,
  structure jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('building', 'active', 'retired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, course_id, id),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_document_id)
    REFERENCES source_document(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, embedding_generation_id)
    REFERENCES source_embedding_generation(owner_scope_id, id),
  CHECK ((status IN ('active', 'retired')) = (activated_at IS NOT NULL))
);

ALTER TABLE course
  ADD COLUMN active_curriculum_generation_id uuid,
  ADD CONSTRAINT course_active_curriculum_generation_fk
  FOREIGN KEY (owner_scope_id, active_curriculum_generation_id)
  REFERENCES curriculum_generation(owner_scope_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE chapter
  ADD COLUMN curriculum_generation_id uuid,
  ADD CONSTRAINT chapter_curriculum_generation_fk
  FOREIGN KEY (owner_scope_id, curriculum_generation_id)
  REFERENCES curriculum_generation(owner_scope_id, id);

ALTER TABLE chapter
  DROP CONSTRAINT chapter_owner_scope_id_course_id_chapter_order_key;

CREATE UNIQUE INDEX chapter_generation_order_idx
  ON chapter (owner_scope_id, curriculum_generation_id, chapter_order)
  WHERE curriculum_generation_id IS NOT NULL;

ALTER TABLE concept
  ADD COLUMN curriculum_generation_id uuid,
  ADD COLUMN concept_key text,
  ADD COLUMN concept_order integer CHECK (concept_order IS NULL OR concept_order >= 0),
  ADD CONSTRAINT concept_curriculum_generation_fk
  FOREIGN KEY (owner_scope_id, curriculum_generation_id)
  REFERENCES curriculum_generation(owner_scope_id, id);

CREATE UNIQUE INDEX concept_generation_key_idx
  ON concept (owner_scope_id, curriculum_generation_id, concept_key)
  WHERE curriculum_generation_id IS NOT NULL;

CREATE UNIQUE INDEX concept_chapter_order_idx
  ON concept (owner_scope_id, chapter_id, concept_order)
  WHERE concept_order IS NOT NULL;

ALTER TABLE source_embedding_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_embedding_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY source_embedding_generation_active_membership
  ON source_embedding_generation
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE source_embedding_generation_span ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_embedding_generation_span FORCE ROW LEVEL SECURITY;
CREATE POLICY source_embedding_generation_span_active_membership
  ON source_embedding_generation_span
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE curriculum_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE curriculum_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY curriculum_generation_active_membership
  ON curriculum_generation
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
