-- migrate:up

CREATE TABLE exam_blueprint (
  id uuid PRIMARY KEY,
  version text NOT NULL,
  name text NOT NULL,
  objective_count integer NOT NULL CHECK (objective_count > 0),
  source_provenance jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, version),
  CHECK (length(version) BETWEEN 1 AND 120),
  CHECK (length(name) BETWEEN 1 AND 240),
  CHECK (
    jsonb_typeof(source_provenance) = 'object'
    AND source_provenance <> '{}'::jsonb
  )
);

CREATE TABLE exam_blueprint_objective (
  blueprint_id uuid NOT NULL,
  blueprint_version text NOT NULL,
  id uuid NOT NULL,
  objective_key text NOT NULL,
  title text NOT NULL,
  weight numeric(6, 5) NOT NULL CHECK (weight BETWEEN 0 AND 1),
  source_provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blueprint_id, id),
  UNIQUE (blueprint_id, objective_key),
  FOREIGN KEY (blueprint_id, blueprint_version)
    REFERENCES exam_blueprint(id, version),
  CHECK (length(objective_key) BETWEEN 1 AND 120),
  CHECK (length(title) BETWEEN 1 AND 500),
  CHECK (
    jsonb_typeof(source_provenance) = 'object'
    AND source_provenance <> '{}'::jsonb
  )
);

CREATE FUNCTION reflo_validate_exam_objective_weights() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_blueprint_id uuid;
  expected_objective_count integer;
  objective_count integer;
  total_weight numeric;
BEGIN
  affected_blueprint_id :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.blueprint_id ELSE NEW.blueprint_id END;
  SELECT blueprint.objective_count
  INTO expected_objective_count
  FROM exam_blueprint AS blueprint
  WHERE blueprint.id = affected_blueprint_id;
  SELECT count(*), COALESCE(sum(weight), 0)
  INTO objective_count, total_weight
  FROM exam_blueprint_objective
  WHERE blueprint_id = affected_blueprint_id;

  IF objective_count <> expected_objective_count
     OR total_weight <> 1.00000
  THEN
    RAISE EXCEPTION
      'exam blueprint objectives must match their immutable count and sum exactly to 1.00000'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION reflo_validate_exam_blueprint_objective_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_objective_count integer;
  total_weight numeric;
BEGIN
  SELECT count(*), COALESCE(sum(weight), 0)
  INTO actual_objective_count, total_weight
  FROM exam_blueprint_objective
  WHERE blueprint_id = NEW.id;

  IF actual_objective_count <> NEW.objective_count
     OR total_weight <> 1.00000
  THEN
    RAISE EXCEPTION
      'exam blueprint objectives must match their immutable count and sum exactly to 1.00000'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER exam_blueprint_objective_count_normalized
AFTER INSERT ON exam_blueprint
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reflo_validate_exam_blueprint_objective_count();

CREATE CONSTRAINT TRIGGER exam_blueprint_objective_weights_normalized
AFTER INSERT OR UPDATE OR DELETE ON exam_blueprint_objective
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reflo_validate_exam_objective_weights();

CREATE TRIGGER exam_blueprint_is_immutable
BEFORE UPDATE OR DELETE ON exam_blueprint
FOR EACH ROW EXECUTE FUNCTION reflo_reject_configuration_mutation();

CREATE TRIGGER exam_blueprint_objective_is_immutable
BEFORE UPDATE OR DELETE ON exam_blueprint_objective
FOR EACH ROW EXECUTE FUNCTION reflo_reject_configuration_mutation();

ALTER TABLE course
  ADD CONSTRAINT course_readiness_target_key
    UNIQUE (owner_scope_id, id, target_exam_blueprint_id),
  ADD CONSTRAINT course_target_exam_blueprint_fk
    FOREIGN KEY (target_exam_blueprint_id)
    REFERENCES exam_blueprint(id);

ALTER TABLE concept
  ADD CONSTRAINT concept_readiness_generation_key
    UNIQUE (
      owner_scope_id,
      id,
      curriculum_generation_id,
      generation_version
    );

CREATE TABLE exam_readiness_mapping_set (
  owner_scope_id uuid NOT NULL,
  id uuid NOT NULL,
  course_id uuid NOT NULL,
  blueprint_id uuid NOT NULL,
  blueprint_version text NOT NULL,
  mapping_set_version text NOT NULL,
  mapping_count integer NOT NULL CHECK (mapping_count > 0),
  readiness_profile_version text NOT NULL
    CHECK (readiness_profile_version = 'exam-readiness-profile-v1'),
  knowledge_algorithm_version text NOT NULL
    CHECK (knowledge_algorithm_version = 'knowledge-model-v1'),
  reviewer_provenance jsonb NOT NULL,
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, id),
  UNIQUE (
    owner_scope_id,
    course_id,
    blueprint_id,
    mapping_set_version
  ),
  UNIQUE (owner_scope_id, id, course_id, blueprint_id),
  FOREIGN KEY (owner_scope_id, course_id, blueprint_id)
    REFERENCES course(owner_scope_id, id, target_exam_blueprint_id),
  FOREIGN KEY (blueprint_id, blueprint_version)
    REFERENCES exam_blueprint(id, version),
  CHECK (length(mapping_set_version) BETWEEN 1 AND 120),
  CHECK (
    jsonb_typeof(reviewer_provenance) = 'object'
    AND reviewer_provenance <> '{}'::jsonb
  )
);

CREATE TABLE exam_readiness_mapping (
  owner_scope_id uuid NOT NULL,
  mapping_set_id uuid NOT NULL,
  course_id uuid NOT NULL,
  blueprint_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  concept_generation_id uuid NOT NULL,
  concept_generation_version text NOT NULL,
  mapping_weight numeric(6, 5) NOT NULL
    CHECK (mapping_weight BETWEEN 0 AND 1),
  source_provenance jsonb NOT NULL,
  reviewer_provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    owner_scope_id,
    mapping_set_id,
    objective_id,
    concept_id
  ),
  FOREIGN KEY (
    owner_scope_id,
    mapping_set_id,
    course_id,
    blueprint_id
  ) REFERENCES exam_readiness_mapping_set(
    owner_scope_id,
    id,
    course_id,
    blueprint_id
  ),
  FOREIGN KEY (blueprint_id, objective_id)
    REFERENCES exam_blueprint_objective(blueprint_id, id),
  FOREIGN KEY (
    owner_scope_id,
    concept_id,
    concept_generation_id,
    concept_generation_version
  ) REFERENCES concept(
    owner_scope_id,
    id,
    curriculum_generation_id,
    generation_version
  ),
  FOREIGN KEY (owner_scope_id, course_id, concept_generation_id)
    REFERENCES curriculum_generation(owner_scope_id, course_id, id),
  CHECK (
    jsonb_typeof(source_provenance) = 'object'
    AND source_provenance <> '{}'::jsonb
  ),
  CHECK (
    jsonb_typeof(reviewer_provenance) = 'object'
    AND reviewer_provenance <> '{}'::jsonb
  )
);

CREATE FUNCTION reflo_validate_exam_mapping_weights() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_owner_scope_id uuid;
  affected_mapping_set_id uuid;
  affected_objective_id uuid;
  mapping_count integer;
  total_weight numeric;
BEGIN
  affected_owner_scope_id :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.owner_scope_id ELSE NEW.owner_scope_id END;
  affected_mapping_set_id :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.mapping_set_id ELSE NEW.mapping_set_id END;
  affected_objective_id :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.objective_id ELSE NEW.objective_id END;

  SELECT count(*), COALESCE(sum(mapping_weight), 0)
  INTO mapping_count, total_weight
  FROM exam_readiness_mapping
  WHERE owner_scope_id = affected_owner_scope_id
    AND mapping_set_id = affected_mapping_set_id
    AND objective_id = affected_objective_id;

  IF mapping_count = 0 OR total_weight <> 1.00000 THEN
    RAISE EXCEPTION
      'exam objective mapping weights must sum exactly to 1.00000'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER exam_readiness_mapping_weights_normalized
AFTER INSERT OR UPDATE OR DELETE ON exam_readiness_mapping
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reflo_validate_exam_mapping_weights();

CREATE FUNCTION reflo_validate_exam_mapping_count() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_mapping_count integer;
  actual_mapping_count integer;
BEGIN
  SELECT mapping_set.mapping_count
  INTO expected_mapping_count
  FROM exam_readiness_mapping_set AS mapping_set
  WHERE mapping_set.owner_scope_id = NEW.owner_scope_id
    AND mapping_set.id = NEW.mapping_set_id;

  SELECT count(*)
  INTO actual_mapping_count
  FROM exam_readiness_mapping
  WHERE owner_scope_id = NEW.owner_scope_id
    AND mapping_set_id = NEW.mapping_set_id;

  IF actual_mapping_count <> expected_mapping_count THEN
    RAISE EXCEPTION
      'exam readiness mappings must match their immutable mapping-set count'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION reflo_validate_exam_mapping_set_count() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_mapping_count integer;
BEGIN
  SELECT count(*)
  INTO actual_mapping_count
  FROM exam_readiness_mapping
  WHERE owner_scope_id = NEW.owner_scope_id
    AND mapping_set_id = NEW.id;

  IF actual_mapping_count <> NEW.mapping_count THEN
    RAISE EXCEPTION
      'exam readiness mappings must match their immutable mapping-set count'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER exam_readiness_mapping_set_count_normalized
AFTER INSERT ON exam_readiness_mapping_set
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reflo_validate_exam_mapping_set_count();

CREATE CONSTRAINT TRIGGER exam_readiness_mapping_count_normalized
AFTER INSERT ON exam_readiness_mapping
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reflo_validate_exam_mapping_count();

CREATE TABLE exam_readiness_calibration (
  id uuid PRIMARY KEY,
  blueprint_id uuid NOT NULL,
  blueprint_version text NOT NULL,
  version text NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size > 0),
  mean_absolute_error numeric(6, 5) NOT NULL
    CHECK (mean_absolute_error BETWEEN 0 AND 1),
  representative boolean NOT NULL,
  evidence_provenance jsonb NOT NULL,
  frozen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blueprint_id, version),
  UNIQUE (id, blueprint_id, version),
  FOREIGN KEY (blueprint_id, blueprint_version)
    REFERENCES exam_blueprint(id, version),
  CHECK (length(version) BETWEEN 1 AND 120),
  CHECK (
    jsonb_typeof(evidence_provenance) = 'object'
    AND evidence_provenance <> '{}'::jsonb
  )
);

CREATE TRIGGER exam_readiness_calibration_is_immutable
BEFORE UPDATE OR DELETE ON exam_readiness_calibration
FOR EACH ROW EXECUTE FUNCTION reflo_reject_configuration_mutation();

CREATE TABLE exam_readiness_score (
  owner_scope_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  course_id uuid NOT NULL,
  readiness_profile_version text NOT NULL
    CHECK (readiness_profile_version = 'exam-readiness-profile-v1'),
  blueprint_id uuid NOT NULL,
  blueprint_version text NOT NULL,
  mapping_set_id uuid NOT NULL,
  mapping_set_version text NOT NULL,
  knowledge_algorithm_version text NOT NULL,
  calibration_id uuid,
  calibration_version text,
  calibration_status text NOT NULL
    CHECK (
      calibration_status IN ('unavailable', 'inadequate', 'adequate')
    ),
  calibration_sample_size integer,
  calibration_mean_absolute_error numeric(6, 5),
  calibration_representative boolean,
  score numeric(6, 5) NOT NULL CHECK (score BETWEEN 0 AND 1),
  evidence_coverage numeric(6, 5) NOT NULL
    CHECK (evidence_coverage BETWEEN 0.80000 AND 1),
  objective_count integer NOT NULL CHECK (objective_count > 0),
  objective_mapped_count integer NOT NULL,
  objective_evidence_count integer NOT NULL,
  mapped_concept_count integer NOT NULL,
  invalidated_concept_count integer NOT NULL,
  unmapped_concept_count integer NOT NULL,
  evidence_eligible_concept_count integer NOT NULL,
  experimental boolean NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, id),
  UNIQUE (owner_scope_id, snapshot_digest),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id),
  FOREIGN KEY (blueprint_id, blueprint_version)
    REFERENCES exam_blueprint(id, version),
  FOREIGN KEY (
    owner_scope_id,
    mapping_set_id,
    course_id,
    blueprint_id
  ) REFERENCES exam_readiness_mapping_set(
    owner_scope_id,
    id,
    course_id,
    blueprint_id
  ),
  FOREIGN KEY (calibration_id, blueprint_id, calibration_version)
    REFERENCES exam_readiness_calibration(id, blueprint_id, version),
  CHECK (length(mapping_set_version) BETWEEN 1 AND 120),
  CHECK (
    jsonb_typeof(input_snapshot) = 'object'
    AND input_snapshot <> '{}'::jsonb
  ),
  CHECK (
    objective_mapped_count BETWEEN 0 AND objective_count
    AND objective_evidence_count BETWEEN 0 AND objective_count
    AND mapped_concept_count >= 0
    AND invalidated_concept_count >= 0
    AND unmapped_concept_count >= 0
    AND evidence_eligible_concept_count >= 0
  ),
  CHECK (
    (
      calibration_status = 'unavailable'
      AND calibration_id IS NULL
      AND calibration_version IS NULL
      AND calibration_sample_size IS NULL
      AND calibration_mean_absolute_error IS NULL
      AND calibration_representative IS NULL
      AND experimental
    )
    OR (
      calibration_status = 'inadequate'
      AND calibration_id IS NOT NULL
      AND calibration_version IS NOT NULL
      AND calibration_sample_size IS NOT NULL
      AND calibration_sample_size > 0
      AND calibration_mean_absolute_error IS NOT NULL
      AND calibration_representative IS NOT NULL
      AND experimental
    )
    OR (
      calibration_status = 'adequate'
      AND calibration_id IS NOT NULL
      AND calibration_version IS NOT NULL
      AND calibration_sample_size >= 100
      AND calibration_mean_absolute_error <= 0.10000
      AND calibration_representative
      AND experimental = false
    )
  )
);

CREATE FUNCTION reflo_protect_exam_readiness_scoped_record() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND reflo_learning_scope_delete_is_authorized(OLD.owner_scope_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER exam_readiness_mapping_set_is_immutable
BEFORE UPDATE OR DELETE ON exam_readiness_mapping_set
FOR EACH ROW EXECUTE FUNCTION reflo_protect_exam_readiness_scoped_record();

CREATE TRIGGER exam_readiness_mapping_is_immutable
BEFORE UPDATE OR DELETE ON exam_readiness_mapping
FOR EACH ROW EXECUTE FUNCTION reflo_protect_exam_readiness_scoped_record();

CREATE TRIGGER exam_readiness_score_is_append_only
BEFORE UPDATE OR DELETE ON exam_readiness_score
FOR EACH ROW EXECUTE FUNCTION reflo_protect_exam_readiness_scoped_record();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'exam_readiness_mapping_set',
    'exam_readiness_mapping',
    'exam_readiness_score'
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

  DELETE FROM public.exam_readiness_score
  WHERE owner_scope_id = p_owner_scope_id;
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
