-- migrate:up

CREATE TABLE delivery_preference (
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('telegram', 'email')),
  chosen_local_time time(0) NOT NULL,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id)
    ON DELETE CASCADE
);

ALTER TABLE delivery_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_preference FORCE ROW LEVEL SECURITY;

CREATE POLICY scoped_active_membership ON delivery_preference
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
