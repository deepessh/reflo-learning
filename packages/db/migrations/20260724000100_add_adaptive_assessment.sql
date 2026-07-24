-- migrate:up

ALTER TABLE attempt
  ADD COLUMN grading_policy_version text,
  ADD COLUMN rating_mapping_version text,
  ADD COLUMN replacement_for_attempt_id uuid,
  ADD CONSTRAINT attempt_replacement_scope_fk
    FOREIGN KEY (owner_scope_id, replacement_for_attempt_id)
    REFERENCES attempt(owner_scope_id, id),
  ADD CONSTRAINT attempt_finalization_provenance_key
    UNIQUE (owner_scope_id, id, user_id, outcome),
  ADD CONSTRAINT attempt_grading_policy_shape
    CHECK (
      (
        grading_policy_version IS NULL
        AND rating_mapping_version IS NULL
        AND replacement_for_attempt_id IS NULL
      )
      OR (
        grading_policy_version = 'grading-policy-v1'
        AND rating_mapping_version = 'rating-mapping-v1'
        AND overall_grade IS NULL
        AND grading_confidence IS NULL
        AND replacement_for_attempt_id IS DISTINCT FROM id
      )
    );

ALTER TABLE attempt_concept_evidence
  ADD COLUMN unanswerable_reason text,
  ADD CONSTRAINT evidence_unanswerable_reason_closed
    CHECK (
      unanswerable_reason IS NULL
      OR unanswerable_reason IN (
        'source_insufficient',
        'source_conflict',
        'rubric_insufficient',
        'rubric_conflict'
      )
    ),
  ADD CONSTRAINT evidence_unanswerable_reason_shape
    CHECK (
      (
        judgment_kind = 'unanswerable'
        AND unanswerable_reason IS NOT NULL
      )
      OR (
        judgment_kind = 'scored'
        AND unanswerable_reason IS NULL
      )
    ) NOT VALID;

CREATE TABLE grading_policy_binding (
  grading_policy_version text PRIMARY KEY
    CHECK (grading_policy_version = 'grading-policy-v1'),
  rating_mapping_version text NOT NULL
    CHECK (rating_mapping_version = 'rating-mapping-v1'),
  confidence_threshold numeric(6, 5) NOT NULL
    CHECK (confidence_threshold BETWEEN 0 AND 1),
  calibration_evidence_id text NOT NULL,
  expected_model_provenance jsonb NOT NULL,
  binding_digest text NOT NULL
    CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grading_policy_version, binding_digest),
  CHECK (length(calibration_evidence_id) BETWEEN 1 AND 240),
  CHECK (jsonb_typeof(expected_model_provenance) = 'object')
);

CREATE FUNCTION reflo_reject_configuration_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable configuration', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER grading_policy_binding_is_immutable
BEFORE UPDATE OR DELETE ON grading_policy_binding
FOR EACH ROW EXECUTE FUNCTION reflo_reject_configuration_mutation();

CREATE TABLE assessment_finalization (
  owner_scope_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  attempt_id uuid NOT NULL,
  user_id uuid NOT NULL,
  attempt_outcome text NOT NULL
    CHECK (attempt_outcome IN ('graded', 'abstained')),
  finalization_kind text NOT NULL
    CHECK (finalization_kind IN ('short_answer', 'keyed_mc_replacement')),
  grading_policy_version text NOT NULL
    CHECK (grading_policy_version = 'grading-policy-v1'),
  rating_mapping_version text NOT NULL
    CHECK (rating_mapping_version = 'rating-mapping-v1'),
  confidence_threshold numeric(6, 5) NOT NULL
    CHECK (confidence_threshold BETWEEN 0 AND 1),
  calibration_evidence_id text NOT NULL,
  policy_binding jsonb NOT NULL,
  policy_binding_digest text NOT NULL
    CHECK (policy_binding_digest ~ '^[0-9a-f]{64}$'),
  learner_message text NOT NULL,
  request_digest text NOT NULL
    CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, idempotency_key),
  UNIQUE (owner_scope_id, attempt_id),
  FOREIGN KEY (
    owner_scope_id,
    attempt_id,
    user_id,
    attempt_outcome
  ) REFERENCES attempt(
    owner_scope_id,
    id,
    user_id,
    outcome
  ),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (grading_policy_version, policy_binding_digest)
    REFERENCES grading_policy_binding(
      grading_policy_version,
      binding_digest
    ),
  CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  CHECK (length(calibration_evidence_id) BETWEEN 1 AND 240),
  CHECK (length(learner_message) BETWEEN 1 AND 500),
  CHECK (jsonb_typeof(policy_binding) = 'object')
);

CREATE TABLE assessment_replacement_bundle (
  owner_scope_id uuid NOT NULL,
  id uuid NOT NULL,
  original_attempt_id uuid NOT NULL,
  grading_policy_version text NOT NULL
    CHECK (grading_policy_version = 'grading-policy-v1'),
  bundle_version text NOT NULL
    CHECK (bundle_version = 'mc-replacement-bundle-v1'),
  concept_set_digest text NOT NULL
    CHECK (concept_set_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, id),
  UNIQUE (
    owner_scope_id,
    original_attempt_id,
    grading_policy_version
  ),
  FOREIGN KEY (owner_scope_id, original_attempt_id)
    REFERENCES attempt(owner_scope_id, id)
);

CREATE TABLE assessment_replacement_item (
  owner_scope_id uuid NOT NULL,
  id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  quiz_item_id uuid NOT NULL,
  rubric_id text NOT NULL,
  rubric_version text NOT NULL,
  normalized_prompt_hash text NOT NULL
    CHECK (normalized_prompt_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, id),
  UNIQUE (owner_scope_id, bundle_id, concept_id),
  UNIQUE (owner_scope_id, bundle_id, normalized_prompt_hash),
  FOREIGN KEY (owner_scope_id, bundle_id)
    REFERENCES assessment_replacement_bundle(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, quiz_item_id, concept_id)
    REFERENCES quiz_item_concept(owner_scope_id, quiz_item_id, concept_id),
  CHECK (length(rubric_id) BETWEEN 1 AND 240),
  CHECK (length(rubric_version) BETWEEN 1 AND 120)
);

CREATE OR REPLACE FUNCTION reflo_protect_attempt_evidence_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attempt.created_at is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (
    EXISTS (
      SELECT 1
      FROM attempt_concept_evidence
      WHERE owner_scope_id = OLD.owner_scope_id
        AND attempt_id = OLD.id
    )
    OR EXISTS (
      SELECT 1
      FROM assessment_finalization
      WHERE owner_scope_id = OLD.owner_scope_id
        AND attempt_id = OLD.id
    )
  ) AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.quiz_item_id IS DISTINCT FROM OLD.quiz_item_id
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
  ) THEN
    RAISE EXCEPTION 'finalized attempt provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'assessment_finalization',
    'assessment_replacement_bundle',
    'assessment_replacement_item'
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

CREATE TRIGGER assessment_finalization_is_append_only
BEFORE UPDATE OR DELETE ON assessment_finalization
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER assessment_replacement_bundle_is_append_only
BEFORE UPDATE OR DELETE ON assessment_replacement_bundle
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER assessment_replacement_item_is_append_only
BEFORE UPDATE OR DELETE ON assessment_replacement_item
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
  DELETE FROM public.assessment_replacement_item
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.assessment_replacement_bundle
  WHERE owner_scope_id = p_owner_scope_id;
  DELETE FROM public.assessment_finalization
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

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
