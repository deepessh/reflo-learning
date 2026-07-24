-- migrate:up

ALTER TABLE attempt_concept_evidence
  ADD COLUMN attempt_created_at timestamptz,
  ADD COLUMN attempt_user_id uuid,
  ADD COLUMN attempt_outcome text;

UPDATE attempt_concept_evidence AS evidence
SET attempt_created_at = attempt.created_at,
    attempt_user_id = attempt.user_id,
    attempt_outcome = attempt.outcome
FROM attempt
WHERE attempt.owner_scope_id = evidence.owner_scope_id
  AND attempt.id = evidence.attempt_id;

ALTER TABLE attempt_concept_evidence
  ALTER COLUMN attempt_created_at SET NOT NULL,
  ALTER COLUMN attempt_user_id SET NOT NULL,
  ALTER COLUMN attempt_outcome SET NOT NULL,
  ADD CONSTRAINT evidence_attempt_outcome_closed
    CHECK (attempt_outcome IN ('graded', 'abstained', 'superseded')),
  ADD CONSTRAINT evidence_eligible_attempt_outcome
    CHECK (eligible_for_mastery = false OR attempt_outcome = 'graded'),
  ADD CONSTRAINT evidence_attempt_user_scope_fk
    FOREIGN KEY (owner_scope_id, attempt_user_id)
    REFERENCES scope_membership(owner_scope_id, user_id);

ALTER TABLE attempt
  ADD CONSTRAINT attempt_evidence_provenance_key
    UNIQUE (owner_scope_id, id, user_id, created_at, outcome);

ALTER TABLE attempt_concept_evidence
  ADD CONSTRAINT evidence_attempt_provenance_fk
    FOREIGN KEY (
      owner_scope_id,
      attempt_id,
      attempt_user_id,
      attempt_created_at,
      attempt_outcome
    )
    REFERENCES attempt(
      owner_scope_id,
      id,
      user_id,
      created_at,
      outcome
    );

CREATE INDEX attempt_concept_evidence_replay_idx
  ON attempt_concept_evidence (
    owner_scope_id,
    attempt_user_id,
    concept_id,
    attempt_created_at,
    attempt_id
  );

CREATE FUNCTION reflo_protect_attempt_evidence_provenance() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attempt.created_at is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM attempt_concept_evidence
    WHERE owner_scope_id = OLD.owner_scope_id
      AND attempt_id = OLD.id
  ) AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.quiz_item_id IS DISTINCT FROM OLD.quiz_item_id
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
  ) THEN
    RAISE EXCEPTION 'evidenced attempt provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER attempt_evidence_provenance_is_immutable
BEFORE UPDATE ON attempt
FOR EACH ROW EXECUTE FUNCTION reflo_protect_attempt_evidence_provenance();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM review_schedule) THEN
    RAISE EXCEPTION
      'review_schedule must be empty before fsrs-profile-v1 migration'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP INDEX review_schedule_due_idx;

ALTER TABLE review_schedule
  RENAME COLUMN due_at TO fsrs_due_at;

ALTER TABLE review_schedule
  RENAME COLUMN fsrs_version TO fsrs_profile_id;

ALTER TABLE review_schedule
  DROP COLUMN state,
  DROP COLUMN reschedule_reason,
  ADD COLUMN base_next_delivery_at timestamptz NOT NULL,
  ADD COLUMN next_delivery_at timestamptz NOT NULL,
  ADD COLUMN chosen_local_time time(0) NOT NULL,
  ADD COLUMN delivery_profile_id text NOT NULL,
  ADD COLUMN tzdb_version text NOT NULL,
  ADD COLUMN delivery_disambiguation text NOT NULL
    CHECK (
      delivery_disambiguation IN (
        'exact', 'fold_earlier', 'fold_later', 'gap_forward'
      )
    ),
  ADD COLUMN current_replay_run_id text NOT NULL,
  ADD COLUMN current_delivery_resolution_id text NOT NULL,
  ADD COLUMN current_card_digest text NOT NULL
    CHECK (current_card_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN card_last_reviewed_at timestamptz NOT NULL,
  ADD COLUMN stability numeric(13, 8) NOT NULL CHECK (stability > 0),
  ADD COLUMN difficulty numeric(10, 8) NOT NULL
    CHECK (difficulty >= 1 AND difficulty <= 10),
  ADD COLUMN card_state smallint NOT NULL CHECK (card_state = 2),
  ADD COLUMN elapsed_days integer NOT NULL CHECK (elapsed_days >= 0),
  ADD COLUMN scheduled_days integer NOT NULL CHECK (scheduled_days >= 0),
  ADD COLUMN reps integer NOT NULL CHECK (reps > 0),
  ADD COLUMN lapses integer NOT NULL CHECK (lapses >= 0),
  ADD COLUMN learning_steps integer NOT NULL CHECK (learning_steps = 0),
  ADD CONSTRAINT review_schedule_profile_v1
    CHECK (
      fsrs_profile_id = 'fsrs-profile-v1'
      AND delivery_profile_id = 'delivery-time-profile-v1'
      AND tzdb_version = '2026b'
    ),
  ADD CONSTRAINT review_schedule_delivery_not_before_fsrs
    CHECK (
      base_next_delivery_at >= fsrs_due_at
      AND next_delivery_at >= base_next_delivery_at
    ),
  ADD CONSTRAINT review_schedule_unique_profile
    UNIQUE (owner_scope_id, user_id, concept_id, fsrs_profile_id);

CREATE TABLE fsrs_card_payload (
  owner_scope_id uuid NOT NULL,
  card_digest text NOT NULL CHECK (card_digest ~ '^[0-9a-f]{64}$'),
  fsrs_profile_id text NOT NULL CHECK (fsrs_profile_id = 'fsrs-profile-v1'),
  canonical_card text NOT NULL,
  due_at timestamptz NOT NULL,
  last_reviewed_at timestamptz,
  stability numeric(13, 8) NOT NULL CHECK (stability >= 0),
  difficulty numeric(10, 8) NOT NULL
    CHECK (difficulty >= 0 AND difficulty <= 10),
  card_state smallint NOT NULL CHECK (card_state IN (0, 2)),
  elapsed_days integer NOT NULL CHECK (elapsed_days >= 0),
  scheduled_days integer NOT NULL CHECK (scheduled_days >= 0),
  reps integer NOT NULL CHECK (reps >= 0),
  lapses integer NOT NULL CHECK (lapses >= 0),
  learning_steps integer NOT NULL CHECK (learning_steps = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, card_digest),
  UNIQUE (owner_scope_id, card_digest, fsrs_profile_id),
  FOREIGN KEY (owner_scope_id)
    REFERENCES owner_scope(id) ON DELETE CASCADE,
  CHECK (
    (
      card_state = 0
      AND last_reviewed_at IS NULL
      AND stability = 0
      AND difficulty = 0
      AND reps = 0
      AND lapses = 0
    )
    OR (
      card_state = 2
      AND last_reviewed_at IS NOT NULL
      AND stability > 0
      AND difficulty >= 1
    )
  )
);

CREATE TABLE fsrs_transition_payload (
  owner_scope_id uuid NOT NULL,
  transition_digest text NOT NULL
    CHECK (transition_digest ~ '^[0-9a-f]{64}$'),
  evidence_identity text NOT NULL,
  attempt_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  rating smallint NOT NULL CHECK (rating IN (1, 3)),
  reviewed_at timestamptz NOT NULL,
  fsrs_profile_id text NOT NULL CHECK (fsrs_profile_id = 'fsrs-profile-v1'),
  prior_card_digest text NOT NULL CHECK (prior_card_digest ~ '^[0-9a-f]{64}$'),
  next_card_digest text NOT NULL CHECK (next_card_digest ~ '^[0-9a-f]{64}$'),
  canonical_transition text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, transition_digest),
  UNIQUE (
    owner_scope_id,
    transition_digest,
    concept_id,
    fsrs_profile_id
  ),
  FOREIGN KEY (owner_scope_id, attempt_id, concept_id)
    REFERENCES attempt_concept_evidence(owner_scope_id, attempt_id, concept_id)
    ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, prior_card_digest, fsrs_profile_id)
    REFERENCES fsrs_card_payload(
      owner_scope_id,
      card_digest,
      fsrs_profile_id
    )
    ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, next_card_digest, fsrs_profile_id)
    REFERENCES fsrs_card_payload(
      owner_scope_id,
      card_digest,
      fsrs_profile_id
    )
    ON DELETE CASCADE,
  CHECK (
    evidence_identity =
      owner_scope_id::text || '/' || attempt_id::text || '/' || concept_id::text
  )
);

CREATE TABLE fsrs_replay_run (
  owner_scope_id uuid NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  fsrs_profile_id text NOT NULL CHECK (fsrs_profile_id = 'fsrs-profile-v1'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  current_card_digest text NOT NULL
    CHECK (current_card_digest ~ '^[0-9a-f]{64}$'),
  -- 512 admitted reviews bound cumulative prefix manifests to 131,328 rows
  -- per concept/profile while retaining independently verifiable runs.
  transition_count integer NOT NULL
    CHECK (transition_count > 0 AND transition_count <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, run_id),
  UNIQUE (
    owner_scope_id,
    run_id,
    user_id,
    concept_id,
    fsrs_profile_id,
    current_card_digest
  ),
  UNIQUE (
    owner_scope_id,
    run_id,
    concept_id,
    fsrs_profile_id
  ),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, current_card_digest, fsrs_profile_id)
    REFERENCES fsrs_card_payload(
      owner_scope_id,
      card_digest,
      fsrs_profile_id
    )
    ON DELETE CASCADE
);

CREATE TABLE fsrs_replay_manifest (
  owner_scope_id uuid NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^[0-9a-f]{64}$'),
  sequence integer NOT NULL CHECK (sequence >= 0 AND sequence < 512),
  concept_id uuid NOT NULL,
  fsrs_profile_id text NOT NULL CHECK (fsrs_profile_id = 'fsrs-profile-v1'),
  transition_digest text NOT NULL
    CHECK (transition_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (owner_scope_id, run_id, sequence),
  UNIQUE (owner_scope_id, run_id, transition_digest),
  FOREIGN KEY (owner_scope_id, run_id, concept_id, fsrs_profile_id)
    REFERENCES fsrs_replay_run(
      owner_scope_id,
      run_id,
      concept_id,
      fsrs_profile_id
    ) ON DELETE CASCADE,
  FOREIGN KEY (
    owner_scope_id,
    transition_digest,
    concept_id,
    fsrs_profile_id
  )
    REFERENCES fsrs_transition_payload(
      owner_scope_id,
      transition_digest,
      concept_id,
      fsrs_profile_id
    )
    ON DELETE CASCADE
);

CREATE TABLE scheduler_delivery_resolution (
  owner_scope_id uuid NOT NULL,
  resolution_id text NOT NULL CHECK (resolution_id ~ '^[0-9a-f]{64}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[0-9a-f]{64}$'),
  time_zone text NOT NULL,
  chosen_local_time time(0) NOT NULL,
  delivery_profile_id text NOT NULL
    CHECK (delivery_profile_id = 'delivery-time-profile-v1'),
  tzdb_version text NOT NULL CHECK (tzdb_version = '2026b'),
  disambiguation text NOT NULL
    CHECK (
      disambiguation IN (
        'exact', 'fold_earlier', 'fold_later', 'gap_forward'
      )
    ),
  fsrs_due_at timestamptz NOT NULL,
  base_next_delivery_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, resolution_id),
  UNIQUE (owner_scope_id, resolution_id, run_id),
  FOREIGN KEY (owner_scope_id, run_id)
    REFERENCES fsrs_replay_run(owner_scope_id, run_id) ON DELETE CASCADE,
  CHECK (base_next_delivery_at >= fsrs_due_at)
);

CREATE TABLE delivery_override (
  owner_scope_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  reason text NOT NULL
    CHECK (
      reason IN (
        'user_snooze',
        'reteach_follow_up',
        'channel_unavailable',
        'operator_demo_control'
      )
    ),
  deliver_not_before_at timestamptz NOT NULL,
  actor_id uuid NOT NULL,
  authorization_id text NOT NULL,
  causation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, id),
  UNIQUE (owner_scope_id, id, user_id, concept_id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, actor_id)
    REFERENCES scope_membership(owner_scope_id, user_id) ON DELETE CASCADE
);

CREATE TABLE delivery_override_cancellation (
  owner_scope_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  target_override_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  authorization_id text NOT NULL,
  causation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, id),
  UNIQUE (owner_scope_id, target_override_id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_scope_id, actor_id)
    REFERENCES scope_membership(owner_scope_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (
    owner_scope_id,
    target_override_id,
    user_id,
    concept_id
  )
    REFERENCES delivery_override(
      owner_scope_id,
      id,
      user_id,
      concept_id
    ) ON DELETE CASCADE
);

ALTER TABLE review_schedule
  ADD CONSTRAINT review_schedule_current_run_fk
    FOREIGN KEY (
      owner_scope_id,
      current_replay_run_id,
      user_id,
      concept_id,
      fsrs_profile_id,
      current_card_digest
    )
    REFERENCES fsrs_replay_run(
      owner_scope_id,
      run_id,
      user_id,
      concept_id,
      fsrs_profile_id,
      current_card_digest
    ),
  ADD CONSTRAINT review_schedule_current_resolution_fk
    FOREIGN KEY (
      owner_scope_id,
      current_delivery_resolution_id,
      current_replay_run_id
    )
    REFERENCES scheduler_delivery_resolution(
      owner_scope_id,
      resolution_id,
      run_id
    ),
  ADD CONSTRAINT review_schedule_current_card_fk
    FOREIGN KEY (
      owner_scope_id,
      current_card_digest,
      fsrs_profile_id
    )
    REFERENCES fsrs_card_payload(
      owner_scope_id,
      card_digest,
      fsrs_profile_id
    );

CREATE INDEX review_schedule_delivery_due_idx
  ON review_schedule (next_delivery_at, owner_scope_id);

CREATE INDEX delivery_override_projection_idx
  ON delivery_override (owner_scope_id, user_id, concept_id, created_at, id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'fsrs_card_payload',
    'fsrs_transition_payload',
    'fsrs_replay_run',
    'fsrs_replay_manifest',
    'scheduler_delivery_resolution',
    'delivery_override',
    'delivery_override_cancellation'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY scoped_active_membership ON %I USING (reflo_has_active_membership(owner_scope_id)) WITH CHECK (reflo_has_active_membership(owner_scope_id))',
      table_name
    );
  END LOOP;
END
$$;

CREATE TRIGGER fsrs_card_payload_is_append_only
BEFORE UPDATE OR DELETE ON fsrs_card_payload
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER fsrs_transition_payload_is_append_only
BEFORE UPDATE OR DELETE ON fsrs_transition_payload
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER fsrs_replay_run_is_append_only
BEFORE UPDATE OR DELETE ON fsrs_replay_run
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER fsrs_replay_manifest_is_append_only
BEFORE UPDATE OR DELETE ON fsrs_replay_manifest
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER scheduler_delivery_resolution_is_append_only
BEFORE UPDATE OR DELETE ON scheduler_delivery_resolution
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER delivery_override_is_append_only
BEFORE UPDATE OR DELETE ON delivery_override
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER delivery_override_cancellation_is_append_only
BEFORE UPDATE OR DELETE ON delivery_override_cancellation
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE OR REPLACE FUNCTION reflo_reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  table_owner name;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT pg_get_userbyid(relowner)
    INTO table_owner
    FROM pg_class
    WHERE oid = TG_RELID;

    IF current_user = table_owner
       AND current_setting(
         'reflo.authorized_learning_scope_delete',
         true
       ) = OLD.owner_scope_id::text THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE FUNCTION reflo_reset_learning_scope(p_owner_scope_id uuid)
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

CREATE FUNCTION reflo_learning_scope_delete_is_authorized(
  p_owner_scope_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    current_user = pg_get_userbyid((
      SELECT proowner
      FROM pg_proc
      WHERE oid = 'public.reflo_reset_learning_scope(uuid)'::regprocedure
    ))
    AND current_setting(
      'reflo.authorized_learning_scope_delete',
      true
    ) = p_owner_scope_id::text
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'attempt',
    'attempt_concept_evidence',
    'delivery_item',
    'delivery_override',
    'delivery_override_cancellation',
    'fsrs_card_payload',
    'fsrs_replay_manifest',
    'fsrs_replay_run',
    'fsrs_transition_payload',
    'knowledge_state',
    'learning_event',
    'learning_event_concept',
    'review_schedule',
    'scheduler_delivery_resolution'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY authorized_learning_scope_reset ON %I FOR DELETE USING (reflo_learning_scope_delete_is_authorized(owner_scope_id))',
      table_name
    );
  END LOOP;
END
$$;

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
