-- migrate:up

CREATE TABLE demo_upload_generation_operation (
  operation_id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  course_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, operation_id),
  UNIQUE (owner_scope_id, course_id),
  FOREIGN KEY (owner_scope_id, operation_id)
    REFERENCES async_operation(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, requested_by_user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_document_id)
    REFERENCES source_document(owner_scope_id, id)
);

CREATE INDEX demo_upload_generation_operation_source_idx
  ON demo_upload_generation_operation (owner_scope_id, source_document_id);

ALTER TABLE demo_upload_generation_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_upload_generation_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY demo_upload_generation_operation_active_membership
  ON demo_upload_generation_operation
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
