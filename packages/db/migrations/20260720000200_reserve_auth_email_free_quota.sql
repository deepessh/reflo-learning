-- migrate:up

CREATE TABLE auth_email_delivery_reservation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reserved_at timestamptz NOT NULL
);

CREATE INDEX auth_email_delivery_reservation_reserved_at_idx
  ON auth_email_delivery_reservation (reserved_at);

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
