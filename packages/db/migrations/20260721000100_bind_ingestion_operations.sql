-- migrate:up

CREATE TABLE ingestion_operation (
  operation_id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, operation_id),
  FOREIGN KEY (owner_scope_id, operation_id)
    REFERENCES async_operation(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, requested_by_user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, source_document_id)
    REFERENCES source_document(owner_scope_id, id)
);

CREATE INDEX ingestion_operation_source_idx
  ON ingestion_operation (owner_scope_id, source_document_id);

ALTER TABLE ingestion_operation ENABLE ROW LEVEL SECURITY;

CREATE POLICY ingestion_operation_active_membership ON ingestion_operation
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

CREATE FUNCTION reflo_resolve_ingestion_authorization(candidate_operation_id uuid)
RETURNS TABLE (actor_id uuid, owner_scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ingestion.requested_by_user_id, ingestion.owner_scope_id
  FROM ingestion_operation AS ingestion
  JOIN async_operation AS operation
    ON operation.owner_scope_id = ingestion.owner_scope_id
   AND operation.id = ingestion.operation_id
  JOIN source_document AS source
    ON source.owner_scope_id = ingestion.owner_scope_id
   AND source.id = ingestion.source_document_id
  JOIN owner_scope AS scope ON scope.id = ingestion.owner_scope_id
  JOIN app_user AS actor ON actor.id = ingestion.requested_by_user_id
  JOIN scope_membership AS membership
    ON membership.owner_scope_id = ingestion.owner_scope_id
   AND membership.user_id = ingestion.requested_by_user_id
  WHERE ingestion.operation_id = candidate_operation_id
    AND operation.operation_name = 'ingestion.parse'
    AND operation.operation_version = 1
    AND scope.status = 'active'
    AND actor.status = 'active'
    AND membership.role = 'owner'
    AND membership.revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION reflo_resolve_ingestion_authorization(uuid) FROM PUBLIC;

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
