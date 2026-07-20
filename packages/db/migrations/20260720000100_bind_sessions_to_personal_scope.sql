-- migrate:up

CREATE UNIQUE INDEX scope_membership_one_active_personal_scope_per_user_idx
  ON scope_membership (user_id)
  WHERE role = 'owner' AND revoked_at IS NULL;

ALTER TABLE auth_session
  ADD COLUMN owner_scope_id uuid NOT NULL;

ALTER TABLE auth_session
  ADD CONSTRAINT auth_session_personal_membership_fkey
  FOREIGN KEY (owner_scope_id, user_id)
  REFERENCES scope_membership(owner_scope_id, user_id);

CREATE FUNCTION reflo_bootstrap_personal_scope(
  new_scope_id uuid,
  new_membership_id uuid,
  owner_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_scope_id uuid;
  owner_status text;
BEGIN
  SELECT status INTO owner_status
  FROM app_user
  WHERE id = owner_user_id
  FOR UPDATE;

  IF owner_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'personal scope requires an active authenticated account'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner_scope_id INTO existing_scope_id
  FROM scope_membership
  WHERE user_id = owner_user_id
    AND role = 'owner'
    AND revoked_at IS NULL
  FOR UPDATE;

  IF existing_scope_id IS NOT NULL THEN
    RETURN existing_scope_id;
  END IF;

  PERFORM set_config('reflo.actor_id', owner_user_id::text, true);
  PERFORM reflo_create_personal_scope(
    new_scope_id,
    new_membership_id,
    owner_user_id
  );
  RETURN new_scope_id;
END
$$;

REVOKE ALL ON FUNCTION reflo_bootstrap_personal_scope(uuid, uuid, uuid)
  FROM PUBLIC;

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
