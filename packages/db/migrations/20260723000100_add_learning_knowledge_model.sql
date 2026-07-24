-- migrate:up

ALTER TABLE learning_event
  ADD COLUMN event_version integer NOT NULL DEFAULT 1
    CHECK (event_version > 0),
  ADD COLUMN producer text NOT NULL DEFAULT 'legacy-core-schema',
  ADD COLUMN correlation_id uuid,
  ADD COLUMN causation_id uuid,
  ADD COLUMN attempt_id uuid,
  ADD CONSTRAINT learning_event_attempt_scope_fk
    FOREIGN KEY (owner_scope_id, attempt_id)
    REFERENCES attempt(owner_scope_id, id);

UPDATE learning_event
SET idempotency_key = 'legacy/learning.event/v1/' || id::text
WHERE idempotency_key IS NULL;

UPDATE learning_event
SET correlation_id = id
WHERE correlation_id IS NULL;

ALTER TABLE learning_event
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL,
  ALTER COLUMN event_version DROP DEFAULT,
  ALTER COLUMN producer DROP DEFAULT,
  ADD CONSTRAINT learning_event_type_v1_closed
    CHECK (event_type IN (
      'assessment_graded',
      'assessment_submitted',
      'course_opened',
      'delivery_received',
      'lesson_abandoned',
      'lesson_completed',
      'lesson_started',
      'question_asked',
      'question_presented',
      'reteach_served',
      'review_rescheduled',
      'review_scheduled',
      'session_abandoned',
      'session_completed',
      'session_started'
    ));

ALTER TABLE attempt_concept_evidence
  RENAME COLUMN confidence TO grader_confidence;

ALTER TABLE attempt_concept_evidence
  ALTER COLUMN score DROP NOT NULL,
  ALTER COLUMN rubric_band DROP NOT NULL,
  ALTER COLUMN grader_confidence DROP NOT NULL,
  ADD COLUMN judgment_kind text,
  ADD COLUMN grading_method text,
  ADD COLUMN rubric_id text,
  ADD COLUMN rubric_version text,
  ADD COLUMN grading_policy_version text,
  ADD COLUMN rating_mapping_version text,
  ADD COLUMN knowledge_configuration_id text,
  ADD COLUMN ineligibility_reason text,
  ADD COLUMN fsrs_rating smallint,
  ADD COLUMN replacement_for_attempt_id uuid,
  ADD CONSTRAINT evidence_replacement_attempt_scope_fk
    FOREIGN KEY (owner_scope_id, replacement_for_attempt_id)
    REFERENCES attempt(owner_scope_id, id);

UPDATE attempt_concept_evidence
SET judgment_kind = 'scored',
    grading_method = 'llm_short_answer',
    rubric_id = 'legacy-unversioned',
    rubric_version = '0',
    grading_policy_version = 'pre-grading-policy-v1',
    rating_mapping_version = 'pre-rating-mapping-v1',
    knowledge_configuration_id = 'legacy-unversioned',
    eligible_for_mastery = false,
    ineligibility_reason = 'legacy_unversioned';

ALTER TABLE attempt_concept_evidence
  ALTER COLUMN judgment_kind SET NOT NULL,
  ALTER COLUMN grading_method SET NOT NULL,
  ALTER COLUMN rubric_id SET NOT NULL,
  ALTER COLUMN rubric_version SET NOT NULL,
  ALTER COLUMN grading_policy_version SET NOT NULL,
  ALTER COLUMN rating_mapping_version SET NOT NULL,
  ALTER COLUMN knowledge_configuration_id SET NOT NULL,
  ADD CONSTRAINT evidence_judgment_kind_closed
    CHECK (judgment_kind IN ('scored', 'unanswerable')),
  ADD CONSTRAINT evidence_grading_method_closed
    CHECK (grading_method IN ('llm_short_answer', 'keyed_mc')),
  ADD CONSTRAINT evidence_rubric_band_closed
    CHECK (
      rubric_band IS NULL
      OR rubric_band IN ('incorrect', 'partially_correct', 'correct')
    ),
  ADD CONSTRAINT evidence_ineligibility_reason_closed
    CHECK (
      ineligibility_reason IS NULL
      OR ineligibility_reason IN (
        'attempt_abstained',
        'below_threshold',
        'legacy_unversioned',
        'policy_ineligible',
        'semantic_unanswerable',
        'superseded'
      )
    ),
  ADD CONSTRAINT evidence_fsrs_rating_closed
    CHECK (fsrs_rating IS NULL OR fsrs_rating IN (1, 3)),
  ADD CONSTRAINT evidence_judgment_shape
    CHECK (
      (
        judgment_kind = 'scored'
        AND score IS NOT NULL
        AND rubric_band IS NOT NULL
      )
      OR (
        judgment_kind = 'unanswerable'
        AND score IS NULL
        AND rubric_band IS NULL
        AND grader_confidence IS NULL
        AND eligible_for_mastery = false
        AND fsrs_rating IS NULL
      )
    ),
  ADD CONSTRAINT evidence_grading_method_shape
    CHECK (
      (
        grading_method = 'llm_short_answer'
        AND (
          judgment_kind = 'unanswerable'
          OR grader_confidence IS NOT NULL
        )
      )
      OR (
        grading_method = 'keyed_mc'
        AND judgment_kind = 'scored'
        AND grader_confidence IS NULL
      )
    ),
  ADD CONSTRAINT evidence_eligibility_shape
    CHECK (
      (
        eligible_for_mastery
        AND judgment_kind = 'scored'
        AND ineligibility_reason IS NULL
        AND fsrs_rating IS NOT NULL
      )
      OR (
        eligible_for_mastery = false
        AND ineligibility_reason IS NOT NULL
        AND fsrs_rating IS NULL
      )
    ),
  ADD CONSTRAINT evidence_band_score_rating_shape
    CHECK (
      (
        rubric_band = 'incorrect'
        AND score = 0.00000
        AND (eligible_for_mastery = false OR fsrs_rating = 1)
      )
      OR (
        rubric_band = 'partially_correct'
        AND score = 0.50000
        AND (eligible_for_mastery = false OR fsrs_rating = 1)
      )
      OR (
        rubric_band = 'correct'
        AND score = 1.00000
        AND (eligible_for_mastery = false OR fsrs_rating = 3)
      )
      OR judgment_kind = 'unanswerable'
    );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM knowledge_state) THEN
    RAISE EXCEPTION
      'knowledge_state must be empty before knowledge-model-v1 exact-state migration'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE knowledge_state
  ALTER COLUMN half_life DROP NOT NULL,
  ADD COLUMN alpha_quanta bigint NOT NULL DEFAULT 100000
    CHECK (alpha_quanta >= 100000),
  ADD COLUMN beta_quanta bigint NOT NULL DEFAULT 300000
    CHECK (beta_quanta >= 300000),
  ADD COLUMN evidence_count integer NOT NULL DEFAULT 0
    CHECK (evidence_count >= 0),
  ADD COLUMN assessment_status text NOT NULL DEFAULT 'unassessed'
    CHECK (assessment_status IN ('unassessed', 'assessed')),
  ADD COLUMN knowledge_configuration_id text NOT NULL
    DEFAULT 'beta-1-3-unit-mass-score-5dp-v1',
  ADD CONSTRAINT knowledge_state_exact_shape
    CHECK (
      (
        evidence_count = 0
        AND assessment_status = 'unassessed'
        AND alpha_quanta = 100000
        AND beta_quanta = 300000
        AND mastery = 0.25000
        AND confidence = 0.00000
        AND last_reviewed_at IS NULL
        AND review_count = 0
      )
      OR (
        evidence_count > 0
        AND assessment_status = 'assessed'
        AND last_reviewed_at IS NOT NULL
        AND review_count = evidence_count
      )
    );

ALTER TABLE knowledge_state
  ALTER COLUMN alpha_quanta DROP DEFAULT,
  ALTER COLUMN beta_quanta DROP DEFAULT,
  ALTER COLUMN evidence_count DROP DEFAULT,
  ALTER COLUMN assessment_status DROP DEFAULT,
  ALTER COLUMN knowledge_configuration_id DROP DEFAULT;

CREATE FUNCTION reflo_reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER learning_event_is_append_only
BEFORE UPDATE OR DELETE ON learning_event
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER learning_event_concept_is_append_only
BEFORE UPDATE OR DELETE ON learning_event_concept
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE TRIGGER attempt_concept_evidence_is_append_only
BEFORE UPDATE OR DELETE ON attempt_concept_evidence
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
