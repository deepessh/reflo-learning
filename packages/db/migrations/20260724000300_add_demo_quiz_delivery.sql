-- migrate:up

ALTER TABLE channel_identity
  ADD COLUMN identity_class text NOT NULL DEFAULT 'demo_staff'
    CHECK (identity_class = 'demo_staff');

ALTER TABLE channel_identity
  ALTER COLUMN identity_class DROP DEFAULT;

ALTER TABLE quiz_delivery
  DROP CONSTRAINT quiz_delivery_status_check,
  ADD COLUMN request_digest text,
  ADD COLUMN email_token_digest text
    CHECK (email_token_digest IS NULL OR email_token_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN email_token_expires_at timestamptz,
  ADD COLUMN email_token_redeemed_at timestamptz,
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD CONSTRAINT quiz_delivery_status_check
    CHECK (
      status IN (
        'pending',
        'processing',
        'submitted',
        'delivered',
        'failed',
        'expired',
        'cancelled'
      )
    ),
  ADD CONSTRAINT quiz_delivery_email_token_shape
    CHECK (
      (
        provider = 'email'
        AND (
          email_token_digest IS NULL
          OR (
            email_token_expires_at = expires_at
            AND (
              email_token_redeemed_at IS NULL
              OR email_token_redeemed_at <= expires_at
            )
          )
        )
      )
      OR (
        provider <> 'email'
        AND email_token_digest IS NULL
        AND email_token_expires_at IS NULL
        AND email_token_redeemed_at IS NULL
      )
    ),
  ADD CONSTRAINT quiz_delivery_claim_shape
    CHECK (
      (claim_token IS NULL AND lease_expires_at IS NULL)
      OR (
        status = 'processing'
        AND claim_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
    );

UPDATE quiz_delivery
SET idempotency_key =
      'legacy/demo-delivery/v1/' || id::text,
    request_digest =
      replace(id::text, '-', '') || replace(id::text, '-', '')
WHERE idempotency_key IS NULL OR request_digest IS NULL;

ALTER TABLE quiz_delivery
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_digest SET NOT NULL,
  ADD CONSTRAINT quiz_delivery_request_digest_shape
    CHECK (request_digest ~ '^[0-9a-f]{64}$');

CREATE TABLE delivery_submission (
  owner_scope_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('telegram', 'email')),
  provider_submission_id text NOT NULL,
  delivery_id uuid NOT NULL,
  user_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, provider, provider_submission_id),
  UNIQUE (provider, provider_submission_id),
  FOREIGN KEY (owner_scope_id, delivery_id)
    REFERENCES quiz_delivery(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  CHECK (length(provider_submission_id) BETWEEN 1 AND 240)
);

CREATE TABLE delivery_streak_day (
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  local_date date NOT NULL,
  time_zone text NOT NULL,
  delivery_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, user_id, local_date),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, delivery_id)
    REFERENCES quiz_delivery(owner_scope_id, id)
);

CREATE TABLE delivery_streak (
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  current_streak integer NOT NULL CHECK (current_streak > 0),
  longest_streak integer NOT NULL CHECK (longest_streak >= current_streak),
  last_answered_on date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id)
);

CREATE INDEX quiz_delivery_expiry_idx
  ON quiz_delivery (expires_at, owner_scope_id)
  WHERE status IN ('pending', 'processing', 'submitted');

CREATE UNIQUE INDEX attempt_delivery_item_once_idx
  ON attempt (owner_scope_id, delivery_item_id)
  WHERE delivery_item_id IS NOT NULL;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'delivery_submission',
    'delivery_streak_day',
    'delivery_streak'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY scoped_active_membership ON %I USING (reflo_has_active_membership(owner_scope_id)) WITH CHECK (reflo_has_active_membership(owner_scope_id))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY authorized_learning_scope_reset ON %I FOR DELETE USING (reflo_learning_scope_delete_is_authorized(owner_scope_id))',
      table_name
    );
  END LOOP;
END
$$;

CREATE POLICY authorized_learning_scope_reset ON quiz_delivery
  FOR DELETE
  USING (reflo_learning_scope_delete_is_authorized(owner_scope_id));

CREATE TRIGGER delivery_submission_is_append_only
BEFORE UPDATE OR DELETE ON delivery_submission
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER delivery_streak_day_is_append_only
BEFORE UPDATE OR DELETE ON delivery_streak_day
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE OR REPLACE FUNCTION reflo_reset_learning_scope(p_owner_scope_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config(
    'reflo.authorized_learning_scope_delete',
    p_owner_scope_id::text,
    true
  );

  DELETE FROM public.fsrs_replay_manifest
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.fsrs_transition_payload
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.delivery_submission
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.delivery_streak_day
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.delivery_streak
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.assessment_replacement_item
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.assessment_replacement_bundle
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.assessment_finalization
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.assessment_session_question
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.assessment_grading_operation
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.attempt_concept_evidence
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.learning_event_concept
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.learning_event
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.attempt
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.delivery_item
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.quiz_delivery
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.review_schedule
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.scheduler_delivery_resolution
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.fsrs_replay_run
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.fsrs_card_payload
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.delivery_override_cancellation
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.delivery_override
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.knowledge_state
  WHERE owner_scope_id = p_owner_scope_id;

  PERFORM set_config(
    'reflo.authorized_learning_scope_delete',
    '',
    true
  );
END
$$;

REVOKE ALL ON FUNCTION reflo_reset_learning_scope(uuid) FROM PUBLIC;

-- migrate:down
-- Forward-only by ADR 0003. Restore through a reviewed compensating migration.
