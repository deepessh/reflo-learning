-- migrate:up

CREATE TABLE narration_script (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  chapter_id uuid NOT NULL,
  script_text text NOT NULL CHECK (length(script_text) BETWEEN 1 AND 100000),
  script_sha256 text NOT NULL CHECK (script_sha256 ~ '^[a-f0-9]{64}$'),
  generation_version text NOT NULL,
  model_provenance jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, course_id, chapter_id, generation_version),
  FOREIGN KEY (owner_scope_id, course_id, chapter_id)
    REFERENCES chapter(owner_scope_id, course_id, id),
  CHECK (model_provenance->>'task' = 'lesson.audio-script.v1'),
  CHECK (model_provenance->>'validationOutcome' = 'passed')
);

CREATE UNIQUE INDEX narration_script_active_chapter_idx
  ON narration_script (owner_scope_id, course_id, chapter_id)
  WHERE status = 'active';

CREATE TABLE narration_script_source_span (
  owner_scope_id uuid NOT NULL,
  narration_script_id uuid NOT NULL,
  source_span_id uuid NOT NULL,
  span_order integer NOT NULL CHECK (span_order >= 0),
  PRIMARY KEY (owner_scope_id, narration_script_id, source_span_id),
  UNIQUE (owner_scope_id, narration_script_id, span_order),
  FOREIGN KEY (owner_scope_id, narration_script_id)
    REFERENCES narration_script(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_span_id)
    REFERENCES source_span(owner_scope_id, id)
);

CREATE TABLE audio_generation_operation (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  chapter_id uuid NOT NULL,
  narration_script_id uuid NOT NULL,
  generation_version text NOT NULL CHECK (
    generation_version = 'audio-generation-v1'
  ),
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 800),
  asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (
    owner_scope_id, course_id, chapter_id, narration_script_id,
    generation_version
  ),
  FOREIGN KEY (owner_scope_id, id)
    REFERENCES async_operation(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, course_id, chapter_id)
    REFERENCES chapter(owner_scope_id, course_id, id),
  FOREIGN KEY (owner_scope_id, narration_script_id)
    REFERENCES narration_script(owner_scope_id, id)
);

CREATE INDEX audio_generation_operation_priority_idx
  ON audio_generation_operation (priority, created_at, id);

ALTER TABLE outbox_message
  ADD COLUMN priority integer NOT NULL DEFAULT 800 CHECK (
    priority BETWEEN 1 AND 800
  );

DROP INDEX outbox_message_unpublished_idx;
CREATE INDEX outbox_message_unpublished_idx
  ON outbox_message (priority, created_at, message_id)
  WHERE published_at IS NULL;

ALTER TABLE asset
  ADD COLUMN audio_generation_operation_id uuid,
  ADD COLUMN narration_script_id uuid,
  ADD COLUMN narration_script_sha256 text CHECK (
    narration_script_sha256 IS NULL
    OR narration_script_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN audio_payload_metadata jsonb,
  ADD CONSTRAINT asset_audio_generation_operation_fk
  FOREIGN KEY (owner_scope_id, audio_generation_operation_id)
  REFERENCES audio_generation_operation(owner_scope_id, id),
  ADD CONSTRAINT asset_audio_narration_script_fk
  FOREIGN KEY (owner_scope_id, narration_script_id)
  REFERENCES narration_script(owner_scope_id, id),
  ADD CONSTRAINT asset_ready_audio_metadata_check CHECK (
    asset_type <> 'audio' OR status <> 'ready' OR (
      audio_generation_operation_id IS NOT NULL
      AND generation_operation_id IS NULL
      AND narration_script_id IS NOT NULL
      AND narration_script_sha256 IS NOT NULL
      AND model_provenance IS NOT NULL
      AND content_hash IS NOT NULL
      AND content_type = 'audio/wav'
      AND byte_size IS NOT NULL
      AND byte_size > 44
      AND etag IS NOT NULL
      AND audio_payload_metadata->>'contractVersion' = 'audio-payload-v1'
      AND audio_payload_metadata->>'container' = 'wav'
      AND audio_payload_metadata->>'codec' = 'pcm_s16le'
      AND (audio_payload_metadata->>'channels')::integer = 1
      AND (audio_payload_metadata->>'sampleRateHz')::integer IN (22050, 24000)
      AND audio_payload_metadata->>'headerValidated' = 'true'
      AND audio_payload_metadata->>'payloadSha256' = content_hash
    )
  );

CREATE UNIQUE INDEX asset_audio_generation_operation_idx
  ON asset (owner_scope_id, audio_generation_operation_id)
  WHERE audio_generation_operation_id IS NOT NULL;

ALTER TABLE narration_script ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_script FORCE ROW LEVEL SECURITY;
CREATE POLICY narration_script_active_membership ON narration_script
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE narration_script_source_span ENABLE ROW LEVEL SECURITY;
ALTER TABLE narration_script_source_span FORCE ROW LEVEL SECURITY;
CREATE POLICY narration_script_source_span_active_membership
  ON narration_script_source_span
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE audio_generation_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE audio_generation_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY audio_generation_operation_active_membership
  ON audio_generation_operation
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
