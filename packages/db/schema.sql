SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: reflo_assert_personal_scope_owner(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_assert_personal_scope_owner(candidate_scope_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  active_owner_count integer;
  active_scope boolean;
BEGIN
  SELECT status = 'active' INTO active_scope
  FROM owner_scope
  WHERE id = candidate_scope_id;

  IF active_scope IS DISTINCT FROM true THEN
    RETURN;
  END IF;

  SELECT count(*) INTO active_owner_count
  FROM scope_membership
  WHERE owner_scope_id = candidate_scope_id
    AND role = 'owner'
    AND revoked_at IS NULL;

  IF active_owner_count <> 1 THEN
    RAISE EXCEPTION 'active personal scope % must have exactly one active owner', candidate_scope_id
      USING ERRCODE = '23514';
  END IF;
END
$$;


--
-- Name: reflo_bootstrap_personal_scope(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_bootstrap_personal_scope(new_scope_id uuid, new_membership_id uuid, owner_user_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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


--
-- Name: reflo_check_scope_owner_from_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_check_scope_owner_from_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM reflo_assert_personal_scope_owner(OLD.owner_scope_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.owner_scope_id IS DISTINCT FROM OLD.owner_scope_id) THEN
    PERFORM reflo_assert_personal_scope_owner(NEW.owner_scope_id);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: reflo_check_scope_owner_from_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_check_scope_owner_from_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM reflo_assert_personal_scope_owner(NEW.id);
  RETURN NULL;
END
$$;


--
-- Name: reflo_context_actor_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_context_actor_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT NULLIF(current_setting('reflo.actor_id', true), '')::uuid
$$;


--
-- Name: reflo_context_owner_scope_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_context_owner_scope_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT NULLIF(current_setting('reflo.owner_scope_id', true), '')::uuid
$$;


--
-- Name: reflo_create_personal_scope(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_create_personal_scope(new_scope_id uuid, new_membership_id uuid, owner_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF reflo_context_actor_id() IS DISTINCT FROM owner_user_id THEN
    RAISE EXCEPTION 'personal scope owner must match the authenticated actor'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO owner_scope (id, scope_type, status)
  VALUES (new_scope_id, 'user', 'active');

  INSERT INTO scope_membership (id, owner_scope_id, user_id, role)
  VALUES (new_membership_id, new_scope_id, owner_user_id, 'owner');
END
$$;


--
-- Name: reflo_has_active_membership(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_has_active_membership(candidate_scope_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT candidate_scope_id = reflo_context_owner_scope_id()
    AND EXISTS (
      SELECT 1
      FROM scope_membership
      WHERE owner_scope_id = candidate_scope_id
        AND user_id = reflo_context_actor_id()
        AND role = 'owner'
        AND revoked_at IS NULL
    )
$$;


--
-- Name: reflo_learning_scope_delete_is_authorized(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_learning_scope_delete_is_authorized(p_owner_scope_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
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


--
-- Name: reflo_preserve_terminal_activation_operation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_preserve_terminal_activation_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed_permanent', 'cancelled', 'expired')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal state on % is immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reflo_preserve_terminal_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_preserve_terminal_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.state IN ('succeeded', 'failed_permanent', 'cancelled', 'expired')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal state on % is immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reflo_protect_attempt_evidence_provenance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_protect_attempt_evidence_provenance() RETURNS trigger
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


--
-- Name: reflo_reject_append_only_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_reject_append_only_mutation() RETURNS trigger
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


--
-- Name: reflo_reset_learning_scope(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_reset_learning_scope(p_owner_scope_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
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


--
-- Name: reflo_resolve_ingestion_authorization(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_resolve_ingestion_authorization(candidate_operation_id uuid) RETURNS TABLE(actor_id uuid, owner_scope_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activation_generation_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activation_generation_operation (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    curriculum_generation_id uuid NOT NULL,
    artifact_kind text NOT NULL,
    chapter_id uuid,
    concept_id uuid,
    generation_version text NOT NULL,
    idempotency_key text NOT NULL,
    priority smallint NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    retryable boolean DEFAULT false NOT NULL,
    failure_class text,
    artifact_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT activation_generation_operation_artifact_kind_check CHECK ((artifact_kind = ANY (ARRAY['first_text_lesson'::text, 'placement_quiz'::text, 'chapter_quiz'::text]))),
    CONSTRAINT activation_generation_operation_attempt_count_check CHECK (((attempt_count >= 0) AND (attempt_count <= 5))),
    CONSTRAINT activation_generation_operation_check CHECK ((((artifact_kind = 'first_text_lesson'::text) AND (chapter_id IS NOT NULL) AND (concept_id IS NOT NULL)) OR ((artifact_kind = 'placement_quiz'::text) AND (chapter_id IS NULL) AND (concept_id IS NULL)) OR ((artifact_kind = 'chapter_quiz'::text) AND (chapter_id IS NOT NULL) AND (concept_id IS NULL)))),
    CONSTRAINT activation_generation_operation_check1 CHECK (((status = 'retry_scheduled'::text) = retryable)),
    CONSTRAINT activation_generation_operation_check2 CHECK (((failure_class IS NOT NULL) = (status = ANY (ARRAY['retry_scheduled'::text, 'failed_permanent'::text])))),
    CONSTRAINT activation_generation_operation_check3 CHECK (((artifact_id IS NOT NULL) = (status = 'succeeded'::text))),
    CONSTRAINT activation_generation_operation_check4 CHECK (((completed_at IS NOT NULL) = (status = ANY (ARRAY['succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])))),
    CONSTRAINT activation_generation_operation_check5 CHECK (((status <> 'queued'::text) OR (attempt_count = 0))),
    CONSTRAINT activation_generation_operation_generation_version_check CHECK ((generation_version = 'activation-generation-v1'::text)),
    CONSTRAINT activation_generation_operation_idempotency_key_check CHECK ((idempotency_key ~ '^(dev|staging|pilot)/content[.]activation[.]generate/v1/[a-f0-9-]{36}$'::text)),
    CONSTRAINT activation_generation_operation_priority_check CHECK (((priority >= 1) AND (priority <= 3))),
    CONSTRAINT activation_generation_operation_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text, 'succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.activation_generation_operation FORCE ROW LEVEL SECURITY;


--
-- Name: app_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_user (
    id uuid NOT NULL,
    email_lookup_digest bytea NOT NULL,
    email_ciphertext bytea NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_user_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'deletion_pending'::text])))
);


--
-- Name: asset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    chapter_id uuid,
    concept_id uuid,
    asset_type text NOT NULL,
    object_key text,
    model_id text,
    prompt_id text,
    generation_version text NOT NULL,
    strategy_tag text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    generation_operation_id uuid,
    model_provenance jsonb,
    content_hash text,
    content_type text,
    byte_size bigint,
    etag text,
    audio_generation_operation_id uuid,
    narration_script_id uuid,
    narration_script_sha256 text,
    audio_payload_metadata jsonb,
    CONSTRAINT asset_asset_type_check CHECK ((asset_type = ANY (ARRAY['audio'::text, 'video'::text, 'text'::text]))),
    CONSTRAINT asset_byte_size_check CHECK (((byte_size IS NULL) OR (byte_size >= 0))),
    CONSTRAINT asset_check CHECK (((status <> 'ready'::text) OR (object_key IS NOT NULL))),
    CONSTRAINT asset_content_hash_check CHECK (((content_hash IS NULL) OR (content_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT asset_narration_script_sha256_check CHECK (((narration_script_sha256 IS NULL) OR (narration_script_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT asset_ready_audio_metadata_check CHECK (((asset_type <> 'audio'::text) OR (status <> 'ready'::text) OR ((audio_generation_operation_id IS NOT NULL) AND (generation_operation_id IS NULL) AND (narration_script_id IS NOT NULL) AND (narration_script_sha256 IS NOT NULL) AND (model_provenance IS NOT NULL) AND (content_hash IS NOT NULL) AND (content_type = 'audio/wav'::text) AND (byte_size IS NOT NULL) AND (byte_size > 44) AND (etag IS NOT NULL) AND ((audio_payload_metadata ->> 'contractVersion'::text) = 'audio-payload-v1'::text) AND ((audio_payload_metadata ->> 'container'::text) = 'wav'::text) AND ((audio_payload_metadata ->> 'codec'::text) = 'pcm_s16le'::text) AND (((audio_payload_metadata ->> 'channels'::text))::integer = 1) AND (((audio_payload_metadata ->> 'sampleRateHz'::text))::integer = ANY (ARRAY[22050, 24000])) AND ((audio_payload_metadata ->> 'headerValidated'::text) = 'true'::text) AND ((audio_payload_metadata ->> 'payloadSha256'::text) = content_hash)))),
    CONSTRAINT asset_ready_text_metadata_check CHECK (((asset_type <> 'text'::text) OR (status <> 'ready'::text) OR ((generation_operation_id IS NOT NULL) AND (model_provenance IS NOT NULL) AND (content_hash IS NOT NULL) AND (content_type IS NOT NULL) AND (byte_size IS NOT NULL) AND (etag IS NOT NULL)))),
    CONSTRAINT asset_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'generating'::text, 'ready'::text, 'failed'::text, 'tombstoned'::text])))
);

ALTER TABLE ONLY public.asset FORCE ROW LEVEL SECURITY;


--
-- Name: asset_source_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_source_span (
    owner_scope_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    source_span_id uuid NOT NULL
);

ALTER TABLE ONLY public.asset_source_span FORCE ROW LEVEL SECURITY;


--
-- Name: async_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.async_operation (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    operation_name text NOT NULL,
    operation_version integer NOT NULL,
    idempotency_key text NOT NULL,
    state text NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    sanitized_failure jsonb,
    result_ref jsonb,
    deadline_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT async_operation_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT async_operation_check CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT async_operation_check1 CHECK (((state = ANY (ARRAY['succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT async_operation_operation_version_check CHECK ((operation_version > 0)),
    CONSTRAINT async_operation_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text, 'succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.async_operation FORCE ROW LEVEL SECURITY;


--
-- Name: async_operation_attempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.async_operation_attempt (
    id bigint NOT NULL,
    owner_scope_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    delivery_number integer NOT NULL,
    outcome text NOT NULL,
    normalized_failure_class text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT async_operation_attempt_check CHECK (((finished_at IS NULL) OR (finished_at >= started_at))),
    CONSTRAINT async_operation_attempt_delivery_number_check CHECK ((delivery_number > 0)),
    CONSTRAINT async_operation_attempt_outcome_check CHECK ((outcome = ANY (ARRAY['started'::text, 'retry_scheduled'::text, 'succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.async_operation_attempt FORCE ROW LEVEL SECURITY;


--
-- Name: async_operation_attempt_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.async_operation_attempt ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.async_operation_attempt_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: attempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attempt (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid,
    delivery_item_id uuid,
    provider text,
    provider_submission_id text,
    submission_idempotency_key text,
    quiz_item_id uuid NOT NULL,
    answer jsonb NOT NULL,
    outcome text NOT NULL,
    overall_grade numeric(6,5),
    grading_confidence numeric(6,5),
    grader_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attempt_check CHECK (((session_id IS NOT NULL) OR (delivery_item_id IS NOT NULL))),
    CONSTRAINT attempt_check1 CHECK (((provider IS NULL) = (provider_submission_id IS NULL))),
    CONSTRAINT attempt_grading_confidence_check CHECK (((grading_confidence IS NULL) OR ((grading_confidence >= (0)::numeric) AND (grading_confidence <= (1)::numeric)))),
    CONSTRAINT attempt_outcome_check CHECK ((outcome = ANY (ARRAY['graded'::text, 'abstained'::text, 'superseded'::text]))),
    CONSTRAINT attempt_overall_grade_check CHECK (((overall_grade IS NULL) OR ((overall_grade >= (0)::numeric) AND (overall_grade <= (1)::numeric)))),
    CONSTRAINT attempt_provider_check CHECK ((provider = ANY (ARRAY['telegram'::text, 'email'::text, 'whatsapp'::text])))
);

ALTER TABLE ONLY public.attempt FORCE ROW LEVEL SECURITY;


--
-- Name: attempt_concept_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attempt_concept_evidence (
    owner_scope_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    score numeric(6,5),
    rubric_band text,
    grader_confidence numeric(6,5),
    rationale_ref text,
    knowledge_algorithm_version text NOT NULL,
    eligible_for_mastery boolean NOT NULL,
    judgment_kind text NOT NULL,
    grading_method text NOT NULL,
    rubric_id text NOT NULL,
    rubric_version text NOT NULL,
    grading_policy_version text NOT NULL,
    rating_mapping_version text NOT NULL,
    knowledge_configuration_id text NOT NULL,
    ineligibility_reason text,
    fsrs_rating smallint,
    replacement_for_attempt_id uuid,
    attempt_created_at timestamp with time zone NOT NULL,
    attempt_user_id uuid NOT NULL,
    attempt_outcome text NOT NULL,
    CONSTRAINT attempt_concept_evidence_confidence_check CHECK (((grader_confidence >= (0)::numeric) AND (grader_confidence <= (1)::numeric))),
    CONSTRAINT attempt_concept_evidence_score_check CHECK (((score >= (0)::numeric) AND (score <= (1)::numeric))),
    CONSTRAINT evidence_attempt_outcome_closed CHECK ((attempt_outcome = ANY (ARRAY['graded'::text, 'abstained'::text, 'superseded'::text]))),
    CONSTRAINT evidence_band_score_rating_shape CHECK ((((rubric_band = 'incorrect'::text) AND (score = 0.00000) AND ((eligible_for_mastery = false) OR (fsrs_rating = 1))) OR ((rubric_band = 'partially_correct'::text) AND (score = 0.50000) AND ((eligible_for_mastery = false) OR (fsrs_rating = 1))) OR ((rubric_band = 'correct'::text) AND (score = 1.00000) AND ((eligible_for_mastery = false) OR (fsrs_rating = 3))) OR (judgment_kind = 'unanswerable'::text))),
    CONSTRAINT evidence_eligibility_shape CHECK (((eligible_for_mastery AND (judgment_kind = 'scored'::text) AND (ineligibility_reason IS NULL) AND (fsrs_rating IS NOT NULL)) OR ((eligible_for_mastery = false) AND (ineligibility_reason IS NOT NULL) AND (fsrs_rating IS NULL)))),
    CONSTRAINT evidence_eligible_attempt_outcome CHECK (((eligible_for_mastery = false) OR (attempt_outcome = 'graded'::text))),
    CONSTRAINT evidence_fsrs_rating_closed CHECK (((fsrs_rating IS NULL) OR (fsrs_rating = ANY (ARRAY[1, 3])))),
    CONSTRAINT evidence_grading_method_closed CHECK ((grading_method = ANY (ARRAY['llm_short_answer'::text, 'keyed_mc'::text]))),
    CONSTRAINT evidence_grading_method_shape CHECK ((((grading_method = 'llm_short_answer'::text) AND ((judgment_kind = 'unanswerable'::text) OR (grader_confidence IS NOT NULL))) OR ((grading_method = 'keyed_mc'::text) AND (judgment_kind = 'scored'::text) AND (grader_confidence IS NULL)))),
    CONSTRAINT evidence_ineligibility_reason_closed CHECK (((ineligibility_reason IS NULL) OR (ineligibility_reason = ANY (ARRAY['attempt_abstained'::text, 'below_threshold'::text, 'legacy_unversioned'::text, 'policy_ineligible'::text, 'semantic_unanswerable'::text, 'superseded'::text])))),
    CONSTRAINT evidence_judgment_kind_closed CHECK ((judgment_kind = ANY (ARRAY['scored'::text, 'unanswerable'::text]))),
    CONSTRAINT evidence_judgment_shape CHECK ((((judgment_kind = 'scored'::text) AND (score IS NOT NULL) AND (rubric_band IS NOT NULL)) OR ((judgment_kind = 'unanswerable'::text) AND (score IS NULL) AND (rubric_band IS NULL) AND (grader_confidence IS NULL) AND (eligible_for_mastery = false) AND (fsrs_rating IS NULL)))),
    CONSTRAINT evidence_rubric_band_closed CHECK (((rubric_band IS NULL) OR (rubric_band = ANY (ARRAY['incorrect'::text, 'partially_correct'::text, 'correct'::text]))))
);

ALTER TABLE ONLY public.attempt_concept_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: audio_generation_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audio_generation_operation (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    chapter_id uuid NOT NULL,
    narration_script_id uuid NOT NULL,
    generation_version text NOT NULL,
    priority integer NOT NULL,
    asset_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audio_generation_operation_generation_version_check CHECK ((generation_version = 'audio-generation-v1'::text)),
    CONSTRAINT audio_generation_operation_priority_check CHECK (((priority >= 1) AND (priority <= 800)))
);

ALTER TABLE ONLY public.audio_generation_operation FORCE ROW LEVEL SECURITY;


--
-- Name: auth_email_delivery_reservation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_email_delivery_reservation (
    id bigint NOT NULL,
    reserved_at timestamp with time zone NOT NULL
);


--
-- Name: auth_email_delivery_reservation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_email_delivery_reservation ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.auth_email_delivery_reservation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_login_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_token (
    id uuid NOT NULL,
    user_id uuid,
    email_lookup_digest bytea NOT NULL,
    token_digest bytea NOT NULL,
    purpose text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    invalidated_at timestamp with time zone,
    CONSTRAINT auth_login_token_check CHECK ((expires_at > issued_at)),
    CONSTRAINT auth_login_token_check1 CHECK ((expires_at <= (issued_at + '00:10:00'::interval))),
    CONSTRAINT auth_login_token_check2 CHECK (((consumed_at IS NULL) OR (consumed_at >= issued_at))),
    CONSTRAINT auth_login_token_check3 CHECK (((invalidated_at IS NULL) OR (invalidated_at >= issued_at))),
    CONSTRAINT auth_login_token_purpose_check CHECK ((purpose = ANY (ARRAY['login'::text, 'step_up'::text])))
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_digest bytea NOT NULL,
    authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    idle_expires_at timestamp with time zone NOT NULL,
    absolute_expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    owner_scope_id uuid NOT NULL,
    CONSTRAINT auth_session_check CHECK ((idle_expires_at > created_at)),
    CONSTRAINT auth_session_check1 CHECK ((absolute_expires_at > created_at)),
    CONSTRAINT auth_session_check2 CHECK ((idle_expires_at <= absolute_expires_at)),
    CONSTRAINT auth_session_check3 CHECK ((idle_expires_at <= (last_seen_at + '7 days'::interval))),
    CONSTRAINT auth_session_check4 CHECK ((absolute_expires_at <= (created_at + '30 days'::interval))),
    CONSTRAINT auth_session_check5 CHECK ((last_seen_at >= created_at)),
    CONSTRAINT auth_session_check6 CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at)))
);


--
-- Name: channel_identity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_identity (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    encrypted_external_id bytea NOT NULL,
    external_id_lookup_digest bytea NOT NULL,
    verified_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_identity_check CHECK (((revoked_at IS NULL) OR (verified_at IS NULL) OR (revoked_at >= verified_at))),
    CONSTRAINT channel_identity_provider_check CHECK ((provider = ANY (ARRAY['telegram'::text, 'email'::text, 'whatsapp'::text])))
);

ALTER TABLE ONLY public.channel_identity FORCE ROW LEVEL SECURITY;


--
-- Name: chapter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chapter (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    chapter_order integer NOT NULL,
    title text NOT NULL,
    generation_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    curriculum_generation_id uuid,
    CONSTRAINT chapter_chapter_order_check CHECK ((chapter_order > 0)),
    CONSTRAINT chapter_generation_status_check CHECK ((generation_status = ANY (ARRAY['pending'::text, 'generating'::text, 'ready'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.chapter FORCE ROW LEVEL SECURITY;


--
-- Name: chapter_source_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chapter_source_span (
    owner_scope_id uuid NOT NULL,
    chapter_id uuid NOT NULL,
    source_span_id uuid NOT NULL,
    span_order integer NOT NULL,
    CONSTRAINT chapter_source_span_span_order_check CHECK ((span_order >= 0))
);

ALTER TABLE ONLY public.chapter_source_span FORCE ROW LEVEL SECURITY;


--
-- Name: concept; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.concept (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    chapter_id uuid NOT NULL,
    name text NOT NULL,
    generation_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    curriculum_generation_id uuid,
    concept_key text,
    concept_order integer,
    CONSTRAINT concept_concept_order_check CHECK (((concept_order IS NULL) OR (concept_order >= 0)))
);

ALTER TABLE ONLY public.concept FORCE ROW LEVEL SECURITY;


--
-- Name: concept_prerequisite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.concept_prerequisite (
    owner_scope_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    prerequisite_concept_id uuid NOT NULL,
    CONSTRAINT concept_prerequisite_check CHECK ((concept_id <> prerequisite_concept_id))
);

ALTER TABLE ONLY public.concept_prerequisite FORCE ROW LEVEL SECURITY;


--
-- Name: concept_source_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.concept_source_span (
    owner_scope_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    source_span_id uuid NOT NULL
);

ALTER TABLE ONLY public.concept_source_span FORCE ROW LEVEL SECURITY;


--
-- Name: course; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    target_exam_blueprint_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_curriculum_generation_id uuid,
    CONSTRAINT course_status_check CHECK ((status = ANY (ARRAY['generating'::text, 'ready'::text, 'failed'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.course FORCE ROW LEVEL SECURITY;


--
-- Name: curriculum_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum_generation (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    embedding_generation_id uuid NOT NULL,
    generation_version text NOT NULL,
    result_hash text NOT NULL,
    model_provenance jsonb NOT NULL,
    structure jsonb NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT curriculum_generation_check CHECK (((status = ANY (ARRAY['active'::text, 'retired'::text])) = (activated_at IS NOT NULL))),
    CONSTRAINT curriculum_generation_generation_version_check CHECK ((generation_version = 'curriculum-v1'::text)),
    CONSTRAINT curriculum_generation_result_hash_check CHECK ((result_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT curriculum_generation_status_check CHECK ((status = ANY (ARRAY['building'::text, 'active'::text, 'retired'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.curriculum_generation FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_item (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    review_schedule_id uuid NOT NULL,
    quiz_item_id uuid NOT NULL,
    item_order smallint NOT NULL,
    CONSTRAINT delivery_item_item_order_check CHECK (((item_order >= 1) AND (item_order <= 3)))
);

ALTER TABLE ONLY public.delivery_item FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_override; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_override (
    owner_scope_id uuid NOT NULL,
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    reason text NOT NULL,
    deliver_not_before_at timestamp with time zone NOT NULL,
    actor_id uuid NOT NULL,
    authorization_id text NOT NULL,
    causation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT delivery_override_reason_check CHECK ((reason = ANY (ARRAY['user_snooze'::text, 'reteach_follow_up'::text, 'channel_unavailable'::text, 'operator_demo_control'::text])))
);

ALTER TABLE ONLY public.delivery_override FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_override_cancellation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_override_cancellation (
    owner_scope_id uuid NOT NULL,
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    target_override_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    authorization_id text NOT NULL,
    causation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.delivery_override_cancellation FORCE ROW LEVEL SECURITY;


--
-- Name: fsrs_card_payload; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsrs_card_payload (
    owner_scope_id uuid NOT NULL,
    card_digest text NOT NULL,
    fsrs_profile_id text NOT NULL,
    canonical_card text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    last_reviewed_at timestamp with time zone,
    stability numeric(13,8) NOT NULL,
    difficulty numeric(10,8) NOT NULL,
    card_state smallint NOT NULL,
    elapsed_days integer NOT NULL,
    scheduled_days integer NOT NULL,
    reps integer NOT NULL,
    lapses integer NOT NULL,
    learning_steps integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fsrs_card_payload_card_digest_check CHECK ((card_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_card_payload_card_state_check CHECK ((card_state = ANY (ARRAY[0, 2]))),
    CONSTRAINT fsrs_card_payload_check CHECK ((((card_state = 0) AND (last_reviewed_at IS NULL) AND (stability = (0)::numeric) AND (difficulty = (0)::numeric) AND (reps = 0) AND (lapses = 0)) OR ((card_state = 2) AND (last_reviewed_at IS NOT NULL) AND (stability > (0)::numeric) AND (difficulty >= (1)::numeric)))),
    CONSTRAINT fsrs_card_payload_difficulty_check CHECK (((difficulty >= (0)::numeric) AND (difficulty <= (10)::numeric))),
    CONSTRAINT fsrs_card_payload_elapsed_days_check CHECK ((elapsed_days >= 0)),
    CONSTRAINT fsrs_card_payload_fsrs_profile_id_check CHECK ((fsrs_profile_id = 'fsrs-profile-v1'::text)),
    CONSTRAINT fsrs_card_payload_lapses_check CHECK ((lapses >= 0)),
    CONSTRAINT fsrs_card_payload_learning_steps_check CHECK ((learning_steps = 0)),
    CONSTRAINT fsrs_card_payload_reps_check CHECK ((reps >= 0)),
    CONSTRAINT fsrs_card_payload_scheduled_days_check CHECK ((scheduled_days >= 0)),
    CONSTRAINT fsrs_card_payload_stability_check CHECK ((stability >= (0)::numeric))
);

ALTER TABLE ONLY public.fsrs_card_payload FORCE ROW LEVEL SECURITY;


--
-- Name: fsrs_replay_manifest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsrs_replay_manifest (
    owner_scope_id uuid NOT NULL,
    run_id text NOT NULL,
    sequence integer NOT NULL,
    concept_id uuid NOT NULL,
    fsrs_profile_id text NOT NULL,
    transition_digest text NOT NULL,
    CONSTRAINT fsrs_replay_manifest_fsrs_profile_id_check CHECK ((fsrs_profile_id = 'fsrs-profile-v1'::text)),
    CONSTRAINT fsrs_replay_manifest_run_id_check CHECK ((run_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_replay_manifest_sequence_check CHECK (((sequence >= 0) AND (sequence < 512))),
    CONSTRAINT fsrs_replay_manifest_transition_digest_check CHECK ((transition_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.fsrs_replay_manifest FORCE ROW LEVEL SECURITY;


--
-- Name: fsrs_replay_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsrs_replay_run (
    owner_scope_id uuid NOT NULL,
    run_id text NOT NULL,
    user_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    fsrs_profile_id text NOT NULL,
    profile_digest text NOT NULL,
    evidence_digest text NOT NULL,
    manifest_digest text NOT NULL,
    current_card_digest text NOT NULL,
    transition_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fsrs_replay_run_current_card_digest_check CHECK ((current_card_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_replay_run_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_replay_run_fsrs_profile_id_check CHECK ((fsrs_profile_id = 'fsrs-profile-v1'::text)),
    CONSTRAINT fsrs_replay_run_manifest_digest_check CHECK ((manifest_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_replay_run_profile_digest_check CHECK ((profile_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_replay_run_run_id_check CHECK ((run_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_replay_run_transition_count_check CHECK (((transition_count > 0) AND (transition_count <= 512)))
);

ALTER TABLE ONLY public.fsrs_replay_run FORCE ROW LEVEL SECURITY;


--
-- Name: fsrs_transition_payload; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsrs_transition_payload (
    owner_scope_id uuid NOT NULL,
    transition_digest text NOT NULL,
    evidence_identity text NOT NULL,
    attempt_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    rating smallint NOT NULL,
    reviewed_at timestamp with time zone NOT NULL,
    fsrs_profile_id text NOT NULL,
    prior_card_digest text NOT NULL,
    next_card_digest text NOT NULL,
    canonical_transition text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fsrs_transition_payload_check CHECK ((evidence_identity = (((((owner_scope_id)::text || '/'::text) || (attempt_id)::text) || '/'::text) || (concept_id)::text))),
    CONSTRAINT fsrs_transition_payload_fsrs_profile_id_check CHECK ((fsrs_profile_id = 'fsrs-profile-v1'::text)),
    CONSTRAINT fsrs_transition_payload_next_card_digest_check CHECK ((next_card_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_transition_payload_prior_card_digest_check CHECK ((prior_card_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT fsrs_transition_payload_rating_check CHECK ((rating = ANY (ARRAY[1, 3]))),
    CONSTRAINT fsrs_transition_payload_transition_digest_check CHECK ((transition_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.fsrs_transition_payload FORCE ROW LEVEL SECURITY;


--
-- Name: inbox_claim; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_claim (
    idempotency_key text NOT NULL,
    message_id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    state text NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    stored_outcome jsonb,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    CONSTRAINT inbox_claim_check CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT inbox_claim_check1 CHECK (((state = ANY (ARRAY['succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])) = (finalized_at IS NOT NULL))),
    CONSTRAINT inbox_claim_state_check CHECK ((state = ANY (ARRAY['processing'::text, 'succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.inbox_claim FORCE ROW LEVEL SECURITY;


--
-- Name: ingestion_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingestion_operation (
    operation_id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    requested_by_user_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    input_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingestion_operation_input_sha256_check CHECK ((input_sha256 ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: knowledge_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_state (
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    mastery numeric(6,5) NOT NULL,
    confidence numeric(6,5) NOT NULL,
    half_life interval,
    last_reviewed_at timestamp with time zone,
    review_count integer DEFAULT 0 NOT NULL,
    algorithm_version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    alpha_quanta bigint NOT NULL,
    beta_quanta bigint NOT NULL,
    evidence_count integer NOT NULL,
    assessment_status text NOT NULL,
    knowledge_configuration_id text NOT NULL,
    CONSTRAINT knowledge_state_alpha_quanta_check CHECK ((alpha_quanta >= 100000)),
    CONSTRAINT knowledge_state_assessment_status_check CHECK ((assessment_status = ANY (ARRAY['unassessed'::text, 'assessed'::text]))),
    CONSTRAINT knowledge_state_beta_quanta_check CHECK ((beta_quanta >= 300000)),
    CONSTRAINT knowledge_state_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT knowledge_state_evidence_count_check CHECK ((evidence_count >= 0)),
    CONSTRAINT knowledge_state_exact_shape CHECK ((((evidence_count = 0) AND (assessment_status = 'unassessed'::text) AND (alpha_quanta = 100000) AND (beta_quanta = 300000) AND (mastery = 0.25000) AND (confidence = 0.00000) AND (last_reviewed_at IS NULL) AND (review_count = 0)) OR ((evidence_count > 0) AND (assessment_status = 'assessed'::text) AND (last_reviewed_at IS NOT NULL) AND (review_count = evidence_count)))),
    CONSTRAINT knowledge_state_half_life_check CHECK ((half_life > '00:00:00'::interval)),
    CONSTRAINT knowledge_state_mastery_check CHECK (((mastery >= (0)::numeric) AND (mastery <= (1)::numeric))),
    CONSTRAINT knowledge_state_review_count_check CHECK ((review_count >= 0))
);

ALTER TABLE ONLY public.knowledge_state FORCE ROW LEVEL SECURITY;


--
-- Name: learning_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learning_event (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid,
    delivery_id uuid,
    event_type text NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    event_version integer NOT NULL,
    producer text NOT NULL,
    correlation_id uuid NOT NULL,
    causation_id uuid,
    attempt_id uuid,
    CONSTRAINT learning_event_event_version_check CHECK ((event_version > 0)),
    CONSTRAINT learning_event_type_v1_closed CHECK ((event_type = ANY (ARRAY['assessment_graded'::text, 'assessment_submitted'::text, 'course_opened'::text, 'delivery_received'::text, 'lesson_abandoned'::text, 'lesson_completed'::text, 'lesson_started'::text, 'question_asked'::text, 'question_presented'::text, 'reteach_served'::text, 'review_rescheduled'::text, 'review_scheduled'::text, 'session_abandoned'::text, 'session_completed'::text, 'session_started'::text])))
);

ALTER TABLE ONLY public.learning_event FORCE ROW LEVEL SECURITY;


--
-- Name: learning_event_concept; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learning_event_concept (
    owner_scope_id uuid NOT NULL,
    learning_event_id uuid NOT NULL,
    concept_id uuid NOT NULL
);

ALTER TABLE ONLY public.learning_event_concept FORCE ROW LEVEL SECURITY;


--
-- Name: narration_script; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narration_script (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    chapter_id uuid NOT NULL,
    script_text text NOT NULL,
    script_sha256 text NOT NULL,
    generation_version text NOT NULL,
    model_provenance jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT narration_script_model_provenance_check CHECK (((model_provenance ->> 'task'::text) = 'lesson.audio-script.v1'::text)),
    CONSTRAINT narration_script_model_provenance_check1 CHECK (((model_provenance ->> 'validationOutcome'::text) = 'passed'::text)),
    CONSTRAINT narration_script_script_sha256_check CHECK ((script_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT narration_script_script_text_check CHECK (((length(script_text) >= 1) AND (length(script_text) <= 100000))),
    CONSTRAINT narration_script_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text])))
);

ALTER TABLE ONLY public.narration_script FORCE ROW LEVEL SECURITY;


--
-- Name: narration_script_source_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narration_script_source_span (
    owner_scope_id uuid NOT NULL,
    narration_script_id uuid NOT NULL,
    source_span_id uuid NOT NULL,
    span_order integer NOT NULL,
    CONSTRAINT narration_script_source_span_span_order_check CHECK ((span_order >= 0))
);

ALTER TABLE ONLY public.narration_script_source_span FORCE ROW LEVEL SECURITY;


--
-- Name: outbox_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_message (
    message_id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    operation_id uuid,
    message_kind text NOT NULL,
    message_name text NOT NULL,
    message_version integer NOT NULL,
    producer text NOT NULL,
    environment text NOT NULL,
    correlation_id uuid NOT NULL,
    causation_id uuid,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    deadline_at timestamp with time zone,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    priority integer DEFAULT 800 NOT NULL,
    CONSTRAINT outbox_message_check CHECK (((deadline_at IS NULL) OR (deadline_at > occurred_at))),
    CONSTRAINT outbox_message_environment_check CHECK ((environment = ANY (ARRAY['dev'::text, 'staging'::text, 'pilot'::text]))),
    CONSTRAINT outbox_message_message_kind_check CHECK ((message_kind = ANY (ARRAY['command'::text, 'event'::text]))),
    CONSTRAINT outbox_message_message_version_check CHECK ((message_version > 0)),
    CONSTRAINT outbox_message_priority_check CHECK (((priority >= 1) AND (priority <= 800)))
);

ALTER TABLE ONLY public.outbox_message FORCE ROW LEVEL SECURITY;


--
-- Name: owner_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owner_scope (
    id uuid NOT NULL,
    scope_type text DEFAULT 'user'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT owner_scope_check CHECK ((((status = 'active'::text) AND (retired_at IS NULL)) OR ((status = 'retired'::text) AND (retired_at IS NOT NULL)))),
    CONSTRAINT owner_scope_scope_type_check CHECK ((scope_type = 'user'::text)),
    CONSTRAINT owner_scope_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])))
);


--
-- Name: quiz_bank; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quiz_bank (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    chapter_id uuid,
    generation_operation_id uuid NOT NULL,
    bank_kind text NOT NULL,
    generation_version text NOT NULL,
    model_provenance jsonb NOT NULL,
    result_hash text NOT NULL,
    item_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quiz_bank_bank_kind_check CHECK ((bank_kind = ANY (ARRAY['placement'::text, 'chapter'::text]))),
    CONSTRAINT quiz_bank_check CHECK ((((bank_kind = 'placement'::text) AND (chapter_id IS NULL) AND (item_count = 10)) OR ((bank_kind = 'chapter'::text) AND (chapter_id IS NOT NULL) AND (item_count = 5)))),
    CONSTRAINT quiz_bank_generation_version_check CHECK ((generation_version = 'activation-generation-v1'::text)),
    CONSTRAINT quiz_bank_item_count_check CHECK ((item_count = ANY (ARRAY[5, 10]))),
    CONSTRAINT quiz_bank_result_hash_check CHECK ((result_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY public.quiz_bank FORCE ROW LEVEL SECURITY;


--
-- Name: quiz_delivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quiz_delivery (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    channel_identity_id uuid NOT NULL,
    provider text NOT NULL,
    provider_message_id text,
    idempotency_key text,
    status text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    sanitized_error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quiz_delivery_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT quiz_delivery_provider_check CHECK ((provider = ANY (ARRAY['telegram'::text, 'email'::text, 'whatsapp'::text]))),
    CONSTRAINT quiz_delivery_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text, 'delivered'::text, 'failed'::text, 'expired'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.quiz_delivery FORCE ROW LEVEL SECURITY;


--
-- Name: quiz_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quiz_item (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    item_type text NOT NULL,
    difficulty smallint NOT NULL,
    prompt text NOT NULL,
    keyed_answer jsonb NOT NULL,
    rubric jsonb,
    version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    quiz_bank_id uuid,
    item_order integer,
    normalized_prompt_hash text,
    response_options jsonb,
    CONSTRAINT quiz_item_difficulty_check CHECK (((difficulty >= 1) AND (difficulty <= 5))),
    CONSTRAINT quiz_item_generated_shape_check CHECK (((quiz_bank_id IS NULL) OR ((item_order IS NOT NULL) AND (normalized_prompt_hash IS NOT NULL) AND (((item_type = 'short_answer'::text) AND (rubric IS NOT NULL) AND (response_options IS NULL)) OR ((item_type = ANY (ARRAY['multiple_choice'::text, 'concept_linking'::text])) AND (rubric IS NULL) AND (jsonb_typeof(response_options) = 'array'::text) AND (jsonb_array_length(response_options) >= 2)))))),
    CONSTRAINT quiz_item_item_order_check CHECK (((item_order IS NULL) OR (item_order >= 0))),
    CONSTRAINT quiz_item_item_type_check CHECK ((item_type = ANY (ARRAY['multiple_choice'::text, 'short_answer'::text, 'concept_linking'::text]))),
    CONSTRAINT quiz_item_normalized_prompt_hash_check CHECK (((normalized_prompt_hash IS NULL) OR (normalized_prompt_hash ~ '^[a-f0-9]{64}$'::text)))
);

ALTER TABLE ONLY public.quiz_item FORCE ROW LEVEL SECURITY;


--
-- Name: quiz_item_concept; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quiz_item_concept (
    owner_scope_id uuid NOT NULL,
    quiz_item_id uuid NOT NULL,
    concept_id uuid NOT NULL
);

ALTER TABLE ONLY public.quiz_item_concept FORCE ROW LEVEL SECURITY;


--
-- Name: quiz_item_source_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quiz_item_source_span (
    owner_scope_id uuid NOT NULL,
    quiz_item_id uuid NOT NULL,
    source_span_id uuid NOT NULL
);

ALTER TABLE ONLY public.quiz_item_source_span FORCE ROW LEVEL SECURITY;


--
-- Name: release_gate_attestation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.release_gate_attestation (
    environment text NOT NULL,
    gate_id text NOT NULL,
    evidence_bundle_digest text NOT NULL,
    evidence_bundle_reference text NOT NULL,
    deployable_artifact_digest text NOT NULL,
    attestation_version text NOT NULL,
    contract_version text NOT NULL,
    status text NOT NULL,
    dependency_fingerprints jsonb NOT NULL,
    mutable_evidence jsonb NOT NULL,
    publisher_id text NOT NULL,
    publisher_authorization_reference text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    superseded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT release_gate_attestation_attestation_version_check CHECK ((attestation_version = 'gate-attestation-v1'::text)),
    CONSTRAINT release_gate_attestation_check CHECK (((superseded_at IS NULL) OR (superseded_at >= published_at))),
    CONSTRAINT release_gate_attestation_contract_version_check CHECK ((contract_version = 'evaluation-contract-v1'::text)),
    CONSTRAINT release_gate_attestation_dependency_fingerprints_check CHECK (((jsonb_typeof(dependency_fingerprints) = 'object'::text) AND (dependency_fingerprints <> '{}'::jsonb))),
    CONSTRAINT release_gate_attestation_deployable_artifact_digest_check CHECK ((deployable_artifact_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT release_gate_attestation_environment_check CHECK ((environment = ANY (ARRAY['staging'::text, 'pilot'::text]))),
    CONSTRAINT release_gate_attestation_evidence_bundle_digest_check CHECK ((evidence_bundle_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT release_gate_attestation_evidence_bundle_reference_check CHECK (((length(evidence_bundle_reference) >= 5) AND (length(evidence_bundle_reference) <= 300))),
    CONSTRAINT release_gate_attestation_gate_id_check CHECK ((gate_id = ANY (ARRAY['week1.performance'::text, 'week1.audio'::text, 'week1.upload-security'::text, 'week1.adversarial'::text]))),
    CONSTRAINT release_gate_attestation_mutable_evidence_check CHECK ((jsonb_typeof(mutable_evidence) = 'array'::text)),
    CONSTRAINT release_gate_attestation_publisher_authorization_referenc_check CHECK (((length(publisher_authorization_reference) >= 5) AND (length(publisher_authorization_reference) <= 300))),
    CONSTRAINT release_gate_attestation_publisher_id_check CHECK ((publisher_id ~ '^[a-zA-Z0-9_-]{8,128}$'::text)),
    CONSTRAINT release_gate_attestation_status_check CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text, 'indeterminate'::text])))
);


--
-- Name: review_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_schedule (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    fsrs_due_at timestamp with time zone NOT NULL,
    time_zone text NOT NULL,
    fsrs_profile_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    base_next_delivery_at timestamp with time zone NOT NULL,
    next_delivery_at timestamp with time zone NOT NULL,
    chosen_local_time time(0) without time zone NOT NULL,
    delivery_profile_id text NOT NULL,
    tzdb_version text NOT NULL,
    delivery_disambiguation text NOT NULL,
    current_replay_run_id text NOT NULL,
    current_delivery_resolution_id text NOT NULL,
    current_card_digest text NOT NULL,
    card_last_reviewed_at timestamp with time zone NOT NULL,
    stability numeric(13,8) NOT NULL,
    difficulty numeric(10,8) NOT NULL,
    card_state smallint NOT NULL,
    elapsed_days integer NOT NULL,
    scheduled_days integer NOT NULL,
    reps integer NOT NULL,
    lapses integer NOT NULL,
    learning_steps integer NOT NULL,
    CONSTRAINT review_schedule_card_state_check CHECK ((card_state = 2)),
    CONSTRAINT review_schedule_current_card_digest_check CHECK ((current_card_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT review_schedule_delivery_disambiguation_check CHECK ((delivery_disambiguation = ANY (ARRAY['exact'::text, 'fold_earlier'::text, 'fold_later'::text, 'gap_forward'::text]))),
    CONSTRAINT review_schedule_delivery_not_before_fsrs CHECK (((base_next_delivery_at >= fsrs_due_at) AND (next_delivery_at >= base_next_delivery_at))),
    CONSTRAINT review_schedule_difficulty_check CHECK (((difficulty >= (1)::numeric) AND (difficulty <= (10)::numeric))),
    CONSTRAINT review_schedule_elapsed_days_check CHECK ((elapsed_days >= 0)),
    CONSTRAINT review_schedule_lapses_check CHECK ((lapses >= 0)),
    CONSTRAINT review_schedule_learning_steps_check CHECK ((learning_steps = 0)),
    CONSTRAINT review_schedule_profile_v1 CHECK (((fsrs_profile_id = 'fsrs-profile-v1'::text) AND (delivery_profile_id = 'delivery-time-profile-v1'::text) AND (tzdb_version = '2026b'::text))),
    CONSTRAINT review_schedule_reps_check CHECK ((reps > 0)),
    CONSTRAINT review_schedule_scheduled_days_check CHECK ((scheduled_days >= 0)),
    CONSTRAINT review_schedule_stability_check CHECK ((stability > (0)::numeric))
);

ALTER TABLE ONLY public.review_schedule FORCE ROW LEVEL SECURITY;


--
-- Name: scheduler_delivery_resolution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduler_delivery_resolution (
    owner_scope_id uuid NOT NULL,
    resolution_id text NOT NULL,
    run_id text NOT NULL,
    time_zone text NOT NULL,
    chosen_local_time time(0) without time zone NOT NULL,
    delivery_profile_id text NOT NULL,
    tzdb_version text NOT NULL,
    disambiguation text NOT NULL,
    fsrs_due_at timestamp with time zone NOT NULL,
    base_next_delivery_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduler_delivery_resolution_check CHECK ((base_next_delivery_at >= fsrs_due_at)),
    CONSTRAINT scheduler_delivery_resolution_delivery_profile_id_check CHECK ((delivery_profile_id = 'delivery-time-profile-v1'::text)),
    CONSTRAINT scheduler_delivery_resolution_disambiguation_check CHECK ((disambiguation = ANY (ARRAY['exact'::text, 'fold_earlier'::text, 'fold_later'::text, 'gap_forward'::text]))),
    CONSTRAINT scheduler_delivery_resolution_resolution_id_check CHECK ((resolution_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scheduler_delivery_resolution_run_id_check CHECK ((run_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scheduler_delivery_resolution_tzdb_version_check CHECK ((tzdb_version = '2026b'::text))
);

ALTER TABLE ONLY public.scheduler_delivery_resolution FORCE ROW LEVEL SECURITY;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: scope_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_membership (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL,
    active_from timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT scope_membership_check CHECK (((revoked_at IS NULL) OR (revoked_at >= active_from))),
    CONSTRAINT scope_membership_role_check CHECK ((role = 'owner'::text))
);


--
-- Name: source_document; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_document (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    object_key text NOT NULL,
    checksum text NOT NULL,
    media_type text NOT NULL,
    byte_size bigint NOT NULL,
    page_count integer,
    parse_status text NOT NULL,
    retention_status text DEFAULT 'active'::text NOT NULL,
    active_embedding_generation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_document_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT source_document_page_count_check CHECK (((page_count IS NULL) OR (page_count >= 0))),
    CONSTRAINT source_document_parse_status_check CHECK ((parse_status = ANY (ARRAY['quarantined'::text, 'validating'::text, 'queued'::text, 'parsing'::text, 'parsed'::text, 'ocr_required'::text, 'failed'::text]))),
    CONSTRAINT source_document_retention_status_check CHECK ((retention_status = ANY (ARRAY['active'::text, 'tombstoned'::text, 'purged'::text])))
);

ALTER TABLE ONLY public.source_document FORCE ROW LEVEL SECURITY;


--
-- Name: source_embedding_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_embedding_generation (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    profile_version text NOT NULL,
    dimensions integer NOT NULL,
    input_mode text NOT NULL,
    adapter_version text NOT NULL,
    effective_model text NOT NULL,
    effective_model_version text NOT NULL,
    provider_identifier text NOT NULL,
    provider_request_ids jsonb NOT NULL,
    region text NOT NULL,
    endpoint text NOT NULL,
    span_count integer NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT source_embedding_generation_check CHECK (((status = ANY (ARRAY['active'::text, 'retired'::text])) = (activated_at IS NOT NULL))),
    CONSTRAINT source_embedding_generation_dimensions_check CHECK ((dimensions = 1024)),
    CONSTRAINT source_embedding_generation_input_mode_check CHECK ((input_mode = 'document'::text)),
    CONSTRAINT source_embedding_generation_profile_version_check CHECK ((profile_version = 'embedding-v1'::text)),
    CONSTRAINT source_embedding_generation_span_count_check CHECK ((span_count > 0)),
    CONSTRAINT source_embedding_generation_status_check CHECK ((status = ANY (ARRAY['building'::text, 'active'::text, 'retired'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.source_embedding_generation FORCE ROW LEVEL SECURITY;


--
-- Name: source_embedding_generation_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_embedding_generation_span (
    owner_scope_id uuid NOT NULL,
    embedding_generation_id uuid NOT NULL,
    source_span_id uuid NOT NULL,
    span_order integer NOT NULL,
    embedding_input_hash text NOT NULL,
    CONSTRAINT source_embedding_generation_span_embedding_input_hash_check CHECK ((embedding_input_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT source_embedding_generation_span_span_order_check CHECK ((span_order >= 0))
);

ALTER TABLE ONLY public.source_embedding_generation_span FORCE ROW LEVEL SECURITY;


--
-- Name: source_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_span (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    canonical_text text NOT NULL,
    text_hash text NOT NULL,
    page_start integer,
    page_end integer,
    section_path text[] DEFAULT '{}'::text[] NOT NULL,
    canonical_start integer NOT NULL,
    canonical_end integer NOT NULL,
    parser_version text NOT NULL,
    chunker_version text NOT NULL,
    tokenizer_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    contract_version text,
    chunk_order integer,
    native_mappings jsonb,
    embedding_input text,
    embedding_input_hash text,
    embedding_input_profile_version text,
    CONSTRAINT source_span_canonical_start_check CHECK ((canonical_start >= 0)),
    CONSTRAINT source_span_check CHECK ((canonical_end > canonical_start)),
    CONSTRAINT source_span_check1 CHECK (((page_start IS NULL) = (page_end IS NULL))),
    CONSTRAINT source_span_check2 CHECK (((page_end IS NULL) OR (page_end >= page_start))),
    CONSTRAINT source_span_chunk_order_check CHECK ((chunk_order >= 0)),
    CONSTRAINT source_span_embedding_input_hash_check CHECK (((embedding_input_hash IS NULL) OR (embedding_input_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT source_span_page_start_check CHECK (((page_start IS NULL) OR (page_start > 0)))
);

ALTER TABLE ONLY public.source_span FORCE ROW LEVEL SECURITY;


--
-- Name: study_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_session (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    course_id uuid NOT NULL,
    status text NOT NULL,
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT study_session_check CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT study_session_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text])))
);

ALTER TABLE ONLY public.study_session FORCE ROW LEVEL SECURITY;


--
-- Name: activation_generation_operation activation_generation_operation_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_generation_operation
    ADD CONSTRAINT activation_generation_operation_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: activation_generation_operation activation_generation_operation_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_generation_operation
    ADD CONSTRAINT activation_generation_operation_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: activation_generation_operation activation_generation_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_generation_operation
    ADD CONSTRAINT activation_generation_operation_pkey PRIMARY KEY (id);


--
-- Name: app_user app_user_email_lookup_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_email_lookup_digest_key UNIQUE (email_lookup_digest);


--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (id);


--
-- Name: asset asset_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: asset asset_owner_scope_id_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_owner_scope_id_object_key_key UNIQUE (owner_scope_id, object_key);


--
-- Name: asset asset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (id);


--
-- Name: asset_source_span asset_source_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_source_span
    ADD CONSTRAINT asset_source_span_pkey PRIMARY KEY (owner_scope_id, asset_id, source_span_id);


--
-- Name: async_operation_attempt async_operation_attempt_owner_scope_id_operation_id_deliver_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_operation_attempt
    ADD CONSTRAINT async_operation_attempt_owner_scope_id_operation_id_deliver_key UNIQUE (owner_scope_id, operation_id, delivery_number);


--
-- Name: async_operation_attempt async_operation_attempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_operation_attempt
    ADD CONSTRAINT async_operation_attempt_pkey PRIMARY KEY (id);


--
-- Name: async_operation async_operation_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_operation
    ADD CONSTRAINT async_operation_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: async_operation async_operation_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_operation
    ADD CONSTRAINT async_operation_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: async_operation async_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_operation
    ADD CONSTRAINT async_operation_pkey PRIMARY KEY (id);


--
-- Name: attempt_concept_evidence attempt_concept_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_concept_evidence
    ADD CONSTRAINT attempt_concept_evidence_pkey PRIMARY KEY (owner_scope_id, attempt_id, concept_id);


--
-- Name: attempt attempt_evidence_provenance_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_evidence_provenance_key UNIQUE (owner_scope_id, id, user_id, created_at, outcome);


--
-- Name: attempt attempt_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: attempt attempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_pkey PRIMARY KEY (id);


--
-- Name: audio_generation_operation audio_generation_operation_owner_scope_id_course_id_chapter_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_generation_operation
    ADD CONSTRAINT audio_generation_operation_owner_scope_id_course_id_chapter_key UNIQUE (owner_scope_id, course_id, chapter_id, narration_script_id, generation_version);


--
-- Name: audio_generation_operation audio_generation_operation_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_generation_operation
    ADD CONSTRAINT audio_generation_operation_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: audio_generation_operation audio_generation_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_generation_operation
    ADD CONSTRAINT audio_generation_operation_pkey PRIMARY KEY (id);


--
-- Name: auth_email_delivery_reservation auth_email_delivery_reservation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_email_delivery_reservation
    ADD CONSTRAINT auth_email_delivery_reservation_pkey PRIMARY KEY (id);


--
-- Name: auth_login_token auth_login_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_token
    ADD CONSTRAINT auth_login_token_pkey PRIMARY KEY (id);


--
-- Name: auth_login_token auth_login_token_token_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_token
    ADD CONSTRAINT auth_login_token_token_digest_key UNIQUE (token_digest);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_session_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_session_digest_key UNIQUE (session_digest);


--
-- Name: channel_identity channel_identity_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identity
    ADD CONSTRAINT channel_identity_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: channel_identity channel_identity_owner_scope_id_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identity
    ADD CONSTRAINT channel_identity_owner_scope_id_id_provider_key UNIQUE (owner_scope_id, id, provider);


--
-- Name: channel_identity channel_identity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identity
    ADD CONSTRAINT channel_identity_pkey PRIMARY KEY (id);


--
-- Name: channel_identity channel_identity_provider_external_id_lookup_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identity
    ADD CONSTRAINT channel_identity_provider_external_id_lookup_digest_key UNIQUE (provider, external_id_lookup_digest);


--
-- Name: chapter chapter_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter
    ADD CONSTRAINT chapter_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: chapter chapter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter
    ADD CONSTRAINT chapter_pkey PRIMARY KEY (id);


--
-- Name: chapter chapter_scope_course_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter
    ADD CONSTRAINT chapter_scope_course_id_unique UNIQUE (owner_scope_id, course_id, id);


--
-- Name: chapter_source_span chapter_source_span_owner_scope_id_chapter_id_span_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_source_span
    ADD CONSTRAINT chapter_source_span_owner_scope_id_chapter_id_span_order_key UNIQUE (owner_scope_id, chapter_id, span_order);


--
-- Name: chapter_source_span chapter_source_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_source_span
    ADD CONSTRAINT chapter_source_span_pkey PRIMARY KEY (owner_scope_id, chapter_id, source_span_id);


--
-- Name: concept concept_owner_scope_id_chapter_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept
    ADD CONSTRAINT concept_owner_scope_id_chapter_id_name_key UNIQUE (owner_scope_id, chapter_id, name);


--
-- Name: concept concept_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept
    ADD CONSTRAINT concept_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: concept concept_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept
    ADD CONSTRAINT concept_pkey PRIMARY KEY (id);


--
-- Name: concept_prerequisite concept_prerequisite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept_prerequisite
    ADD CONSTRAINT concept_prerequisite_pkey PRIMARY KEY (owner_scope_id, concept_id, prerequisite_concept_id);


--
-- Name: concept concept_scope_chapter_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept
    ADD CONSTRAINT concept_scope_chapter_id_unique UNIQUE (owner_scope_id, chapter_id, id);


--
-- Name: concept_source_span concept_source_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept_source_span
    ADD CONSTRAINT concept_source_span_pkey PRIMARY KEY (owner_scope_id, concept_id, source_span_id);


--
-- Name: course course_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course
    ADD CONSTRAINT course_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: course course_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course
    ADD CONSTRAINT course_pkey PRIMARY KEY (id);


--
-- Name: curriculum_generation curriculum_generation_owner_scope_id_course_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_generation
    ADD CONSTRAINT curriculum_generation_owner_scope_id_course_id_id_key UNIQUE (owner_scope_id, course_id, id);


--
-- Name: curriculum_generation curriculum_generation_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_generation
    ADD CONSTRAINT curriculum_generation_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: curriculum_generation curriculum_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_generation
    ADD CONSTRAINT curriculum_generation_pkey PRIMARY KEY (id);


--
-- Name: delivery_item delivery_item_owner_scope_id_delivery_id_item_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_item
    ADD CONSTRAINT delivery_item_owner_scope_id_delivery_id_item_order_key UNIQUE (owner_scope_id, delivery_id, item_order);


--
-- Name: delivery_item delivery_item_owner_scope_id_delivery_id_review_schedule_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_item
    ADD CONSTRAINT delivery_item_owner_scope_id_delivery_id_review_schedule_id_key UNIQUE (owner_scope_id, delivery_id, review_schedule_id);


--
-- Name: delivery_item delivery_item_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_item
    ADD CONSTRAINT delivery_item_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: delivery_item delivery_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_item
    ADD CONSTRAINT delivery_item_pkey PRIMARY KEY (id);


--
-- Name: delivery_override_cancellation delivery_override_cancellatio_owner_scope_id_target_overrid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override_cancellation
    ADD CONSTRAINT delivery_override_cancellatio_owner_scope_id_target_overrid_key UNIQUE (owner_scope_id, target_override_id);


--
-- Name: delivery_override_cancellation delivery_override_cancellation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override_cancellation
    ADD CONSTRAINT delivery_override_cancellation_pkey PRIMARY KEY (owner_scope_id, id);


--
-- Name: delivery_override delivery_override_owner_scope_id_id_user_id_concept_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override
    ADD CONSTRAINT delivery_override_owner_scope_id_id_user_id_concept_id_key UNIQUE (owner_scope_id, id, user_id, concept_id);


--
-- Name: delivery_override delivery_override_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override
    ADD CONSTRAINT delivery_override_pkey PRIMARY KEY (owner_scope_id, id);


--
-- Name: fsrs_card_payload fsrs_card_payload_owner_scope_id_card_digest_fsrs_profile_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_card_payload
    ADD CONSTRAINT fsrs_card_payload_owner_scope_id_card_digest_fsrs_profile_i_key UNIQUE (owner_scope_id, card_digest, fsrs_profile_id);


--
-- Name: fsrs_card_payload fsrs_card_payload_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_card_payload
    ADD CONSTRAINT fsrs_card_payload_pkey PRIMARY KEY (owner_scope_id, card_digest);


--
-- Name: fsrs_replay_manifest fsrs_replay_manifest_owner_scope_id_run_id_transition_diges_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_manifest
    ADD CONSTRAINT fsrs_replay_manifest_owner_scope_id_run_id_transition_diges_key UNIQUE (owner_scope_id, run_id, transition_digest);


--
-- Name: fsrs_replay_manifest fsrs_replay_manifest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_manifest
    ADD CONSTRAINT fsrs_replay_manifest_pkey PRIMARY KEY (owner_scope_id, run_id, sequence);


--
-- Name: fsrs_replay_run fsrs_replay_run_owner_scope_id_run_id_concept_id_fsrs_profi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_run
    ADD CONSTRAINT fsrs_replay_run_owner_scope_id_run_id_concept_id_fsrs_profi_key UNIQUE (owner_scope_id, run_id, concept_id, fsrs_profile_id);


--
-- Name: fsrs_replay_run fsrs_replay_run_owner_scope_id_run_id_user_id_concept_id_fs_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_run
    ADD CONSTRAINT fsrs_replay_run_owner_scope_id_run_id_user_id_concept_id_fs_key UNIQUE (owner_scope_id, run_id, user_id, concept_id, fsrs_profile_id, current_card_digest);


--
-- Name: fsrs_replay_run fsrs_replay_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_run
    ADD CONSTRAINT fsrs_replay_run_pkey PRIMARY KEY (owner_scope_id, run_id);


--
-- Name: fsrs_transition_payload fsrs_transition_payload_owner_scope_id_transition_digest_co_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_transition_payload
    ADD CONSTRAINT fsrs_transition_payload_owner_scope_id_transition_digest_co_key UNIQUE (owner_scope_id, transition_digest, concept_id, fsrs_profile_id);


--
-- Name: fsrs_transition_payload fsrs_transition_payload_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_transition_payload
    ADD CONSTRAINT fsrs_transition_payload_pkey PRIMARY KEY (owner_scope_id, transition_digest);


--
-- Name: inbox_claim inbox_claim_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_claim
    ADD CONSTRAINT inbox_claim_message_id_key UNIQUE (message_id);


--
-- Name: inbox_claim inbox_claim_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_claim
    ADD CONSTRAINT inbox_claim_pkey PRIMARY KEY (idempotency_key);


--
-- Name: ingestion_operation ingestion_operation_owner_scope_id_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_operation
    ADD CONSTRAINT ingestion_operation_owner_scope_id_operation_id_key UNIQUE (owner_scope_id, operation_id);


--
-- Name: ingestion_operation ingestion_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_operation
    ADD CONSTRAINT ingestion_operation_pkey PRIMARY KEY (operation_id);


--
-- Name: knowledge_state knowledge_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_state
    ADD CONSTRAINT knowledge_state_pkey PRIMARY KEY (owner_scope_id, user_id, concept_id);


--
-- Name: learning_event_concept learning_event_concept_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event_concept
    ADD CONSTRAINT learning_event_concept_pkey PRIMARY KEY (owner_scope_id, learning_event_id, concept_id);


--
-- Name: learning_event learning_event_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event
    ADD CONSTRAINT learning_event_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: learning_event learning_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event
    ADD CONSTRAINT learning_event_pkey PRIMARY KEY (id);


--
-- Name: narration_script narration_script_owner_scope_id_course_id_chapter_id_genera_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script
    ADD CONSTRAINT narration_script_owner_scope_id_course_id_chapter_id_genera_key UNIQUE (owner_scope_id, course_id, chapter_id, generation_version);


--
-- Name: narration_script narration_script_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script
    ADD CONSTRAINT narration_script_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: narration_script narration_script_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script
    ADD CONSTRAINT narration_script_pkey PRIMARY KEY (id);


--
-- Name: narration_script_source_span narration_script_source_span_owner_scope_id_narration_scrip_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script_source_span
    ADD CONSTRAINT narration_script_source_span_owner_scope_id_narration_scrip_key UNIQUE (owner_scope_id, narration_script_id, span_order);


--
-- Name: narration_script_source_span narration_script_source_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script_source_span
    ADD CONSTRAINT narration_script_source_span_pkey PRIMARY KEY (owner_scope_id, narration_script_id, source_span_id);


--
-- Name: outbox_message outbox_message_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_message
    ADD CONSTRAINT outbox_message_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: outbox_message outbox_message_owner_scope_id_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_message
    ADD CONSTRAINT outbox_message_owner_scope_id_message_id_key UNIQUE (owner_scope_id, message_id);


--
-- Name: outbox_message outbox_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_message
    ADD CONSTRAINT outbox_message_pkey PRIMARY KEY (message_id);


--
-- Name: owner_scope owner_scope_id_scope_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_scope
    ADD CONSTRAINT owner_scope_id_scope_type_key UNIQUE (id, scope_type);


--
-- Name: owner_scope owner_scope_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_scope
    ADD CONSTRAINT owner_scope_pkey PRIMARY KEY (id);


--
-- Name: quiz_bank quiz_bank_owner_scope_id_generation_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_bank
    ADD CONSTRAINT quiz_bank_owner_scope_id_generation_operation_id_key UNIQUE (owner_scope_id, generation_operation_id);


--
-- Name: quiz_bank quiz_bank_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_bank
    ADD CONSTRAINT quiz_bank_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: quiz_bank quiz_bank_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_bank
    ADD CONSTRAINT quiz_bank_pkey PRIMARY KEY (id);


--
-- Name: quiz_delivery quiz_delivery_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_delivery
    ADD CONSTRAINT quiz_delivery_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: quiz_delivery quiz_delivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_delivery
    ADD CONSTRAINT quiz_delivery_pkey PRIMARY KEY (id);


--
-- Name: quiz_item_concept quiz_item_concept_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item_concept
    ADD CONSTRAINT quiz_item_concept_pkey PRIMARY KEY (owner_scope_id, quiz_item_id, concept_id);


--
-- Name: quiz_item quiz_item_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item
    ADD CONSTRAINT quiz_item_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: quiz_item quiz_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item
    ADD CONSTRAINT quiz_item_pkey PRIMARY KEY (id);


--
-- Name: quiz_item_source_span quiz_item_source_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item_source_span
    ADD CONSTRAINT quiz_item_source_span_pkey PRIMARY KEY (owner_scope_id, quiz_item_id, source_span_id);


--
-- Name: release_gate_attestation release_gate_attestation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_gate_attestation
    ADD CONSTRAINT release_gate_attestation_pkey PRIMARY KEY (environment, gate_id, evidence_bundle_digest);


--
-- Name: review_schedule review_schedule_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: review_schedule review_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_pkey PRIMARY KEY (id);


--
-- Name: review_schedule review_schedule_unique_profile; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_unique_profile UNIQUE (owner_scope_id, user_id, concept_id, fsrs_profile_id);


--
-- Name: scheduler_delivery_resolution scheduler_delivery_resolution_owner_scope_id_resolution_id__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_delivery_resolution
    ADD CONSTRAINT scheduler_delivery_resolution_owner_scope_id_resolution_id__key UNIQUE (owner_scope_id, resolution_id, run_id);


--
-- Name: scheduler_delivery_resolution scheduler_delivery_resolution_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_delivery_resolution
    ADD CONSTRAINT scheduler_delivery_resolution_pkey PRIMARY KEY (owner_scope_id, resolution_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: scope_membership scope_membership_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_membership
    ADD CONSTRAINT scope_membership_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: scope_membership scope_membership_owner_scope_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_membership
    ADD CONSTRAINT scope_membership_owner_scope_id_user_id_key UNIQUE (owner_scope_id, user_id);


--
-- Name: scope_membership scope_membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_membership
    ADD CONSTRAINT scope_membership_pkey PRIMARY KEY (id);


--
-- Name: source_document source_document_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_document
    ADD CONSTRAINT source_document_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: source_document source_document_owner_scope_id_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_document
    ADD CONSTRAINT source_document_owner_scope_id_object_key_key UNIQUE (owner_scope_id, object_key);


--
-- Name: source_document source_document_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_document
    ADD CONSTRAINT source_document_pkey PRIMARY KEY (id);


--
-- Name: source_embedding_generation source_embedding_generation_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation
    ADD CONSTRAINT source_embedding_generation_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: source_embedding_generation source_embedding_generation_owner_scope_id_source_document__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation
    ADD CONSTRAINT source_embedding_generation_owner_scope_id_source_document__key UNIQUE (owner_scope_id, source_document_id, id);


--
-- Name: source_embedding_generation source_embedding_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation
    ADD CONSTRAINT source_embedding_generation_pkey PRIMARY KEY (id);


--
-- Name: source_embedding_generation_span source_embedding_generation_s_owner_scope_id_embedding_gene_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation_span
    ADD CONSTRAINT source_embedding_generation_s_owner_scope_id_embedding_gene_key UNIQUE (owner_scope_id, embedding_generation_id, span_order);


--
-- Name: source_embedding_generation_span source_embedding_generation_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation_span
    ADD CONSTRAINT source_embedding_generation_span_pkey PRIMARY KEY (owner_scope_id, embedding_generation_id, source_span_id);


--
-- Name: source_span source_span_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_span
    ADD CONSTRAINT source_span_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: source_span source_span_owner_scope_id_source_document_id_text_hash_can_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_span
    ADD CONSTRAINT source_span_owner_scope_id_source_document_id_text_hash_can_key UNIQUE (owner_scope_id, source_document_id, text_hash, canonical_start, canonical_end);


--
-- Name: source_span source_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_span
    ADD CONSTRAINT source_span_pkey PRIMARY KEY (id);


--
-- Name: study_session study_session_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_session
    ADD CONSTRAINT study_session_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: study_session study_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_session
    ADD CONSTRAINT study_session_pkey PRIMARY KEY (id);


--
-- Name: activation_generation_operation_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activation_generation_operation_pending_idx ON public.activation_generation_operation USING btree (status, priority, updated_at) WHERE (status = ANY (ARRAY['queued'::text, 'retry_scheduled'::text]));


--
-- Name: activation_generation_operation_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX activation_generation_operation_target_idx ON public.activation_generation_operation USING btree (owner_scope_id, course_id, curriculum_generation_id, artifact_kind, chapter_id, concept_id, generation_version) NULLS NOT DISTINCT;


--
-- Name: asset_audio_generation_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_audio_generation_operation_idx ON public.asset USING btree (owner_scope_id, audio_generation_operation_id) WHERE (audio_generation_operation_id IS NOT NULL);


--
-- Name: asset_generation_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_generation_operation_idx ON public.asset USING btree (owner_scope_id, generation_operation_id) WHERE (generation_operation_id IS NOT NULL);


--
-- Name: attempt_concept_evidence_replay_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attempt_concept_evidence_replay_idx ON public.attempt_concept_evidence USING btree (owner_scope_id, attempt_user_id, concept_id, attempt_created_at, attempt_id);


--
-- Name: attempt_provider_submission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX attempt_provider_submission_idx ON public.attempt USING btree (provider, provider_submission_id) WHERE (provider_submission_id IS NOT NULL);


--
-- Name: attempt_submission_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX attempt_submission_idempotency_idx ON public.attempt USING btree (submission_idempotency_key) WHERE (submission_idempotency_key IS NOT NULL);


--
-- Name: audio_generation_operation_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audio_generation_operation_priority_idx ON public.audio_generation_operation USING btree (priority, created_at, id);


--
-- Name: auth_email_delivery_reservation_reserved_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_email_delivery_reservation_reserved_at_idx ON public.auth_email_delivery_reservation USING btree (reserved_at);


--
-- Name: auth_login_token_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_token_identity_idx ON public.auth_login_token USING btree (email_lookup_digest, purpose, issued_at DESC);


--
-- Name: auth_session_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_user_active_idx ON public.auth_session USING btree (user_id, absolute_expires_at) WHERE (revoked_at IS NULL);


--
-- Name: chapter_generation_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chapter_generation_order_idx ON public.chapter USING btree (owner_scope_id, curriculum_generation_id, chapter_order) WHERE (curriculum_generation_id IS NOT NULL);


--
-- Name: concept_chapter_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX concept_chapter_order_idx ON public.concept USING btree (owner_scope_id, chapter_id, concept_order) WHERE (concept_order IS NOT NULL);


--
-- Name: concept_generation_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX concept_generation_key_idx ON public.concept USING btree (owner_scope_id, curriculum_generation_id, concept_key) WHERE (curriculum_generation_id IS NOT NULL);


--
-- Name: delivery_override_projection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_override_projection_idx ON public.delivery_override USING btree (owner_scope_id, user_id, concept_id, created_at, id);


--
-- Name: ingestion_operation_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingestion_operation_source_idx ON public.ingestion_operation USING btree (owner_scope_id, source_document_id);


--
-- Name: learning_event_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX learning_event_idempotency_idx ON public.learning_event USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: narration_script_active_chapter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX narration_script_active_chapter_idx ON public.narration_script USING btree (owner_scope_id, course_id, chapter_id) WHERE (status = 'active'::text);


--
-- Name: outbox_message_unpublished_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_message_unpublished_idx ON public.outbox_message USING btree (priority, created_at, message_id) WHERE (published_at IS NULL);


--
-- Name: quiz_delivery_provider_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quiz_delivery_provider_idempotency_idx ON public.quiz_delivery USING btree (provider, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: quiz_delivery_provider_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quiz_delivery_provider_message_idx ON public.quiz_delivery USING btree (provider, provider_message_id) WHERE (provider_message_id IS NOT NULL);


--
-- Name: quiz_item_bank_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quiz_item_bank_order_idx ON public.quiz_item USING btree (owner_scope_id, quiz_bank_id, item_order) WHERE (quiz_bank_id IS NOT NULL);


--
-- Name: quiz_item_bank_prompt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quiz_item_bank_prompt_idx ON public.quiz_item USING btree (owner_scope_id, quiz_bank_id, normalized_prompt_hash) WHERE (quiz_bank_id IS NOT NULL);


--
-- Name: release_gate_attestation_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX release_gate_attestation_current_idx ON public.release_gate_attestation USING btree (environment, gate_id) WHERE (superseded_at IS NULL);


--
-- Name: review_schedule_delivery_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_schedule_delivery_due_idx ON public.review_schedule USING btree (next_delivery_at, owner_scope_id);


--
-- Name: scope_membership_one_active_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scope_membership_one_active_owner_idx ON public.scope_membership USING btree (owner_scope_id) WHERE ((role = 'owner'::text) AND (revoked_at IS NULL));


--
-- Name: scope_membership_one_active_personal_scope_per_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scope_membership_one_active_personal_scope_per_user_idx ON public.scope_membership USING btree (user_id) WHERE ((role = 'owner'::text) AND (revoked_at IS NULL));


--
-- Name: source_span_chunk_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_span_chunk_order_idx ON public.source_span USING btree (owner_scope_id, source_document_id, chunker_version, tokenizer_version, chunk_order) WHERE (chunk_order IS NOT NULL);


--
-- Name: activation_generation_operation activation_generation_operation_terminal_is_final; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER activation_generation_operation_terminal_is_final BEFORE UPDATE ON public.activation_generation_operation FOR EACH ROW EXECUTE FUNCTION public.reflo_preserve_terminal_activation_operation();


--
-- Name: async_operation async_operation_terminal_is_final; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER async_operation_terminal_is_final BEFORE UPDATE ON public.async_operation FOR EACH ROW EXECUTE FUNCTION public.reflo_preserve_terminal_row();


--
-- Name: attempt_concept_evidence attempt_concept_evidence_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attempt_concept_evidence_is_append_only BEFORE DELETE OR UPDATE ON public.attempt_concept_evidence FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: attempt attempt_evidence_provenance_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attempt_evidence_provenance_is_immutable BEFORE UPDATE ON public.attempt FOR EACH ROW EXECUTE FUNCTION public.reflo_protect_attempt_evidence_provenance();


--
-- Name: delivery_override_cancellation delivery_override_cancellation_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_override_cancellation_is_append_only BEFORE DELETE OR UPDATE ON public.delivery_override_cancellation FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: delivery_override delivery_override_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_override_is_append_only BEFORE DELETE OR UPDATE ON public.delivery_override FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: fsrs_card_payload fsrs_card_payload_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fsrs_card_payload_is_append_only BEFORE DELETE OR UPDATE ON public.fsrs_card_payload FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: fsrs_replay_manifest fsrs_replay_manifest_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fsrs_replay_manifest_is_append_only BEFORE DELETE OR UPDATE ON public.fsrs_replay_manifest FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: fsrs_replay_run fsrs_replay_run_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fsrs_replay_run_is_append_only BEFORE DELETE OR UPDATE ON public.fsrs_replay_run FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: fsrs_transition_payload fsrs_transition_payload_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fsrs_transition_payload_is_append_only BEFORE DELETE OR UPDATE ON public.fsrs_transition_payload FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: inbox_claim inbox_claim_terminal_is_final; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inbox_claim_terminal_is_final BEFORE UPDATE ON public.inbox_claim FOR EACH ROW EXECUTE FUNCTION public.reflo_preserve_terminal_row();


--
-- Name: learning_event_concept learning_event_concept_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER learning_event_concept_is_append_only BEFORE DELETE OR UPDATE ON public.learning_event_concept FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: learning_event learning_event_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER learning_event_is_append_only BEFORE DELETE OR UPDATE ON public.learning_event FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: scope_membership membership_preserves_scope_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER membership_preserves_scope_owner AFTER INSERT OR DELETE OR UPDATE ON public.scope_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_check_scope_owner_from_membership();


--
-- Name: owner_scope owner_scope_requires_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER owner_scope_requires_owner AFTER INSERT OR UPDATE OF status, retired_at ON public.owner_scope DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_check_scope_owner_from_scope();


--
-- Name: scheduler_delivery_resolution scheduler_delivery_resolution_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scheduler_delivery_resolution_is_append_only BEFORE DELETE OR UPDATE ON public.scheduler_delivery_resolution FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: activation_generation_operation activation_generation_operati_owner_scope_id_chapter_id_co_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_generation_operation
    ADD CONSTRAINT activation_generation_operati_owner_scope_id_chapter_id_co_fkey FOREIGN KEY (owner_scope_id, chapter_id, concept_id) REFERENCES public.concept(owner_scope_id, chapter_id, id);


--
-- Name: activation_generation_operation activation_generation_operati_owner_scope_id_course_id_cha_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_generation_operation
    ADD CONSTRAINT activation_generation_operati_owner_scope_id_course_id_cha_fkey FOREIGN KEY (owner_scope_id, course_id, chapter_id) REFERENCES public.chapter(owner_scope_id, course_id, id);


--
-- Name: activation_generation_operation activation_generation_operati_owner_scope_id_course_id_cur_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_generation_operation
    ADD CONSTRAINT activation_generation_operati_owner_scope_id_course_id_cur_fkey FOREIGN KEY (owner_scope_id, course_id, curriculum_generation_id) REFERENCES public.curriculum_generation(owner_scope_id, course_id, id);


--
-- Name: asset asset_audio_generation_operation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_audio_generation_operation_fk FOREIGN KEY (owner_scope_id, audio_generation_operation_id) REFERENCES public.audio_generation_operation(owner_scope_id, id);


--
-- Name: asset asset_audio_narration_script_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_audio_narration_script_fk FOREIGN KEY (owner_scope_id, narration_script_id) REFERENCES public.narration_script(owner_scope_id, id);


--
-- Name: asset asset_generation_operation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_generation_operation_fk FOREIGN KEY (owner_scope_id, generation_operation_id) REFERENCES public.activation_generation_operation(owner_scope_id, id);


--
-- Name: asset asset_owner_scope_id_chapter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_owner_scope_id_chapter_id_fkey FOREIGN KEY (owner_scope_id, chapter_id) REFERENCES public.chapter(owner_scope_id, id);


--
-- Name: asset asset_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: asset asset_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: asset_source_span asset_source_span_owner_scope_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_source_span
    ADD CONSTRAINT asset_source_span_owner_scope_id_asset_id_fkey FOREIGN KEY (owner_scope_id, asset_id) REFERENCES public.asset(owner_scope_id, id);


--
-- Name: asset_source_span asset_source_span_owner_scope_id_source_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_source_span
    ADD CONSTRAINT asset_source_span_owner_scope_id_source_span_id_fkey FOREIGN KEY (owner_scope_id, source_span_id) REFERENCES public.source_span(owner_scope_id, id);


--
-- Name: async_operation_attempt async_operation_attempt_owner_scope_id_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_operation_attempt
    ADD CONSTRAINT async_operation_attempt_owner_scope_id_operation_id_fkey FOREIGN KEY (owner_scope_id, operation_id) REFERENCES public.async_operation(owner_scope_id, id);


--
-- Name: async_operation async_operation_owner_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_operation
    ADD CONSTRAINT async_operation_owner_scope_id_fkey FOREIGN KEY (owner_scope_id) REFERENCES public.owner_scope(id);


--
-- Name: attempt_concept_evidence attempt_concept_evidence_owner_scope_id_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_concept_evidence
    ADD CONSTRAINT attempt_concept_evidence_owner_scope_id_attempt_id_fkey FOREIGN KEY (owner_scope_id, attempt_id) REFERENCES public.attempt(owner_scope_id, id);


--
-- Name: attempt_concept_evidence attempt_concept_evidence_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_concept_evidence
    ADD CONSTRAINT attempt_concept_evidence_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: attempt attempt_owner_scope_id_delivery_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_owner_scope_id_delivery_item_id_fkey FOREIGN KEY (owner_scope_id, delivery_item_id) REFERENCES public.delivery_item(owner_scope_id, id);


--
-- Name: attempt attempt_owner_scope_id_quiz_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_owner_scope_id_quiz_item_id_fkey FOREIGN KEY (owner_scope_id, quiz_item_id) REFERENCES public.quiz_item(owner_scope_id, id);


--
-- Name: attempt attempt_owner_scope_id_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_owner_scope_id_session_id_fkey FOREIGN KEY (owner_scope_id, session_id) REFERENCES public.study_session(owner_scope_id, id);


--
-- Name: attempt attempt_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: audio_generation_operation audio_generation_operation_owner_scope_id_course_id_chapte_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_generation_operation
    ADD CONSTRAINT audio_generation_operation_owner_scope_id_course_id_chapte_fkey FOREIGN KEY (owner_scope_id, course_id, chapter_id) REFERENCES public.chapter(owner_scope_id, course_id, id);


--
-- Name: audio_generation_operation audio_generation_operation_owner_scope_id_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_generation_operation
    ADD CONSTRAINT audio_generation_operation_owner_scope_id_id_fkey FOREIGN KEY (owner_scope_id, id) REFERENCES public.async_operation(owner_scope_id, id);


--
-- Name: audio_generation_operation audio_generation_operation_owner_scope_id_narration_script_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_generation_operation
    ADD CONSTRAINT audio_generation_operation_owner_scope_id_narration_script_fkey FOREIGN KEY (owner_scope_id, narration_script_id) REFERENCES public.narration_script(owner_scope_id, id);


--
-- Name: auth_login_token auth_login_token_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_token
    ADD CONSTRAINT auth_login_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_user(id);


--
-- Name: auth_session auth_session_personal_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_personal_membership_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: auth_session auth_session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_user(id);


--
-- Name: channel_identity channel_identity_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identity
    ADD CONSTRAINT channel_identity_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: chapter chapter_curriculum_generation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter
    ADD CONSTRAINT chapter_curriculum_generation_fk FOREIGN KEY (owner_scope_id, curriculum_generation_id) REFERENCES public.curriculum_generation(owner_scope_id, id);


--
-- Name: chapter chapter_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter
    ADD CONSTRAINT chapter_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: chapter_source_span chapter_source_span_owner_scope_id_chapter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_source_span
    ADD CONSTRAINT chapter_source_span_owner_scope_id_chapter_id_fkey FOREIGN KEY (owner_scope_id, chapter_id) REFERENCES public.chapter(owner_scope_id, id);


--
-- Name: chapter_source_span chapter_source_span_owner_scope_id_source_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_source_span
    ADD CONSTRAINT chapter_source_span_owner_scope_id_source_span_id_fkey FOREIGN KEY (owner_scope_id, source_span_id) REFERENCES public.source_span(owner_scope_id, id);


--
-- Name: concept concept_curriculum_generation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept
    ADD CONSTRAINT concept_curriculum_generation_fk FOREIGN KEY (owner_scope_id, curriculum_generation_id) REFERENCES public.curriculum_generation(owner_scope_id, id);


--
-- Name: concept concept_owner_scope_id_chapter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept
    ADD CONSTRAINT concept_owner_scope_id_chapter_id_fkey FOREIGN KEY (owner_scope_id, chapter_id) REFERENCES public.chapter(owner_scope_id, id);


--
-- Name: concept_prerequisite concept_prerequisite_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept_prerequisite
    ADD CONSTRAINT concept_prerequisite_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: concept_prerequisite concept_prerequisite_owner_scope_id_prerequisite_concept_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept_prerequisite
    ADD CONSTRAINT concept_prerequisite_owner_scope_id_prerequisite_concept_i_fkey FOREIGN KEY (owner_scope_id, prerequisite_concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: concept_source_span concept_source_span_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept_source_span
    ADD CONSTRAINT concept_source_span_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: concept_source_span concept_source_span_owner_scope_id_source_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept_source_span
    ADD CONSTRAINT concept_source_span_owner_scope_id_source_span_id_fkey FOREIGN KEY (owner_scope_id, source_span_id) REFERENCES public.source_span(owner_scope_id, id);


--
-- Name: course course_active_curriculum_generation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course
    ADD CONSTRAINT course_active_curriculum_generation_fk FOREIGN KEY (owner_scope_id, active_curriculum_generation_id) REFERENCES public.curriculum_generation(owner_scope_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: course course_owner_scope_id_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course
    ADD CONSTRAINT course_owner_scope_id_source_document_id_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


--
-- Name: curriculum_generation curriculum_generation_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_generation
    ADD CONSTRAINT curriculum_generation_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: curriculum_generation curriculum_generation_owner_scope_id_embedding_generation__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_generation
    ADD CONSTRAINT curriculum_generation_owner_scope_id_embedding_generation__fkey FOREIGN KEY (owner_scope_id, embedding_generation_id) REFERENCES public.source_embedding_generation(owner_scope_id, id);


--
-- Name: curriculum_generation curriculum_generation_owner_scope_id_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_generation
    ADD CONSTRAINT curriculum_generation_owner_scope_id_source_document_id_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


--
-- Name: delivery_item delivery_item_owner_scope_id_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_item
    ADD CONSTRAINT delivery_item_owner_scope_id_delivery_id_fkey FOREIGN KEY (owner_scope_id, delivery_id) REFERENCES public.quiz_delivery(owner_scope_id, id);


--
-- Name: delivery_item delivery_item_owner_scope_id_quiz_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_item
    ADD CONSTRAINT delivery_item_owner_scope_id_quiz_item_id_fkey FOREIGN KEY (owner_scope_id, quiz_item_id) REFERENCES public.quiz_item(owner_scope_id, id);


--
-- Name: delivery_item delivery_item_owner_scope_id_review_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_item
    ADD CONSTRAINT delivery_item_owner_scope_id_review_schedule_id_fkey FOREIGN KEY (owner_scope_id, review_schedule_id) REFERENCES public.review_schedule(owner_scope_id, id);


--
-- Name: delivery_override_cancellation delivery_override_cancellatio_owner_scope_id_target_overri_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override_cancellation
    ADD CONSTRAINT delivery_override_cancellatio_owner_scope_id_target_overri_fkey FOREIGN KEY (owner_scope_id, target_override_id, user_id, concept_id) REFERENCES public.delivery_override(owner_scope_id, id, user_id, concept_id) ON DELETE CASCADE;


--
-- Name: delivery_override_cancellation delivery_override_cancellation_owner_scope_id_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override_cancellation
    ADD CONSTRAINT delivery_override_cancellation_owner_scope_id_actor_id_fkey FOREIGN KEY (owner_scope_id, actor_id) REFERENCES public.scope_membership(owner_scope_id, user_id) ON DELETE CASCADE;


--
-- Name: delivery_override_cancellation delivery_override_cancellation_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override_cancellation
    ADD CONSTRAINT delivery_override_cancellation_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id) ON DELETE CASCADE;


--
-- Name: delivery_override_cancellation delivery_override_cancellation_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override_cancellation
    ADD CONSTRAINT delivery_override_cancellation_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id) ON DELETE CASCADE;


--
-- Name: delivery_override delivery_override_owner_scope_id_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override
    ADD CONSTRAINT delivery_override_owner_scope_id_actor_id_fkey FOREIGN KEY (owner_scope_id, actor_id) REFERENCES public.scope_membership(owner_scope_id, user_id) ON DELETE CASCADE;


--
-- Name: delivery_override delivery_override_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override
    ADD CONSTRAINT delivery_override_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id) ON DELETE CASCADE;


--
-- Name: delivery_override delivery_override_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_override
    ADD CONSTRAINT delivery_override_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id) ON DELETE CASCADE;


--
-- Name: attempt_concept_evidence evidence_attempt_provenance_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_concept_evidence
    ADD CONSTRAINT evidence_attempt_provenance_fk FOREIGN KEY (owner_scope_id, attempt_id, attempt_user_id, attempt_created_at, attempt_outcome) REFERENCES public.attempt(owner_scope_id, id, user_id, created_at, outcome);


--
-- Name: attempt_concept_evidence evidence_attempt_user_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_concept_evidence
    ADD CONSTRAINT evidence_attempt_user_scope_fk FOREIGN KEY (owner_scope_id, attempt_user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: attempt_concept_evidence evidence_replacement_attempt_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_concept_evidence
    ADD CONSTRAINT evidence_replacement_attempt_scope_fk FOREIGN KEY (owner_scope_id, replacement_for_attempt_id) REFERENCES public.attempt(owner_scope_id, id);


--
-- Name: fsrs_card_payload fsrs_card_payload_owner_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_card_payload
    ADD CONSTRAINT fsrs_card_payload_owner_scope_id_fkey FOREIGN KEY (owner_scope_id) REFERENCES public.owner_scope(id) ON DELETE CASCADE;


--
-- Name: fsrs_replay_manifest fsrs_replay_manifest_owner_scope_id_run_id_concept_id_fsrs_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_manifest
    ADD CONSTRAINT fsrs_replay_manifest_owner_scope_id_run_id_concept_id_fsrs_fkey FOREIGN KEY (owner_scope_id, run_id, concept_id, fsrs_profile_id) REFERENCES public.fsrs_replay_run(owner_scope_id, run_id, concept_id, fsrs_profile_id) ON DELETE CASCADE;


--
-- Name: fsrs_replay_manifest fsrs_replay_manifest_owner_scope_id_transition_digest_conc_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_manifest
    ADD CONSTRAINT fsrs_replay_manifest_owner_scope_id_transition_digest_conc_fkey FOREIGN KEY (owner_scope_id, transition_digest, concept_id, fsrs_profile_id) REFERENCES public.fsrs_transition_payload(owner_scope_id, transition_digest, concept_id, fsrs_profile_id) ON DELETE CASCADE;


--
-- Name: fsrs_replay_run fsrs_replay_run_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_run
    ADD CONSTRAINT fsrs_replay_run_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id) ON DELETE CASCADE;


--
-- Name: fsrs_replay_run fsrs_replay_run_owner_scope_id_current_card_digest_fsrs_pr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_run
    ADD CONSTRAINT fsrs_replay_run_owner_scope_id_current_card_digest_fsrs_pr_fkey FOREIGN KEY (owner_scope_id, current_card_digest, fsrs_profile_id) REFERENCES public.fsrs_card_payload(owner_scope_id, card_digest, fsrs_profile_id) ON DELETE CASCADE;


--
-- Name: fsrs_replay_run fsrs_replay_run_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_replay_run
    ADD CONSTRAINT fsrs_replay_run_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id) ON DELETE CASCADE;


--
-- Name: fsrs_transition_payload fsrs_transition_payload_owner_scope_id_attempt_id_concept__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_transition_payload
    ADD CONSTRAINT fsrs_transition_payload_owner_scope_id_attempt_id_concept__fkey FOREIGN KEY (owner_scope_id, attempt_id, concept_id) REFERENCES public.attempt_concept_evidence(owner_scope_id, attempt_id, concept_id) ON DELETE CASCADE;


--
-- Name: fsrs_transition_payload fsrs_transition_payload_owner_scope_id_next_card_digest_fs_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_transition_payload
    ADD CONSTRAINT fsrs_transition_payload_owner_scope_id_next_card_digest_fs_fkey FOREIGN KEY (owner_scope_id, next_card_digest, fsrs_profile_id) REFERENCES public.fsrs_card_payload(owner_scope_id, card_digest, fsrs_profile_id) ON DELETE CASCADE;


--
-- Name: fsrs_transition_payload fsrs_transition_payload_owner_scope_id_prior_card_digest_f_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsrs_transition_payload
    ADD CONSTRAINT fsrs_transition_payload_owner_scope_id_prior_card_digest_f_fkey FOREIGN KEY (owner_scope_id, prior_card_digest, fsrs_profile_id) REFERENCES public.fsrs_card_payload(owner_scope_id, card_digest, fsrs_profile_id) ON DELETE CASCADE;


--
-- Name: inbox_claim inbox_claim_owner_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_claim
    ADD CONSTRAINT inbox_claim_owner_scope_id_fkey FOREIGN KEY (owner_scope_id) REFERENCES public.owner_scope(id);


--
-- Name: ingestion_operation ingestion_operation_owner_scope_id_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_operation
    ADD CONSTRAINT ingestion_operation_owner_scope_id_operation_id_fkey FOREIGN KEY (owner_scope_id, operation_id) REFERENCES public.async_operation(owner_scope_id, id);


--
-- Name: ingestion_operation ingestion_operation_owner_scope_id_requested_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_operation
    ADD CONSTRAINT ingestion_operation_owner_scope_id_requested_by_user_id_fkey FOREIGN KEY (owner_scope_id, requested_by_user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: ingestion_operation ingestion_operation_owner_scope_id_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_operation
    ADD CONSTRAINT ingestion_operation_owner_scope_id_source_document_id_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


--
-- Name: knowledge_state knowledge_state_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_state
    ADD CONSTRAINT knowledge_state_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: knowledge_state knowledge_state_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_state
    ADD CONSTRAINT knowledge_state_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: learning_event learning_event_attempt_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event
    ADD CONSTRAINT learning_event_attempt_scope_fk FOREIGN KEY (owner_scope_id, attempt_id) REFERENCES public.attempt(owner_scope_id, id);


--
-- Name: learning_event_concept learning_event_concept_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event_concept
    ADD CONSTRAINT learning_event_concept_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: learning_event_concept learning_event_concept_owner_scope_id_learning_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event_concept
    ADD CONSTRAINT learning_event_concept_owner_scope_id_learning_event_id_fkey FOREIGN KEY (owner_scope_id, learning_event_id) REFERENCES public.learning_event(owner_scope_id, id);


--
-- Name: learning_event learning_event_owner_scope_id_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event
    ADD CONSTRAINT learning_event_owner_scope_id_delivery_id_fkey FOREIGN KEY (owner_scope_id, delivery_id) REFERENCES public.quiz_delivery(owner_scope_id, id);


--
-- Name: learning_event learning_event_owner_scope_id_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event
    ADD CONSTRAINT learning_event_owner_scope_id_session_id_fkey FOREIGN KEY (owner_scope_id, session_id) REFERENCES public.study_session(owner_scope_id, id);


--
-- Name: learning_event learning_event_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_event
    ADD CONSTRAINT learning_event_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: narration_script narration_script_owner_scope_id_course_id_chapter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script
    ADD CONSTRAINT narration_script_owner_scope_id_course_id_chapter_id_fkey FOREIGN KEY (owner_scope_id, course_id, chapter_id) REFERENCES public.chapter(owner_scope_id, course_id, id);


--
-- Name: narration_script_source_span narration_script_source_span_owner_scope_id_narration_scri_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script_source_span
    ADD CONSTRAINT narration_script_source_span_owner_scope_id_narration_scri_fkey FOREIGN KEY (owner_scope_id, narration_script_id) REFERENCES public.narration_script(owner_scope_id, id);


--
-- Name: narration_script_source_span narration_script_source_span_owner_scope_id_source_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narration_script_source_span
    ADD CONSTRAINT narration_script_source_span_owner_scope_id_source_span_id_fkey FOREIGN KEY (owner_scope_id, source_span_id) REFERENCES public.source_span(owner_scope_id, id);


--
-- Name: outbox_message outbox_message_owner_scope_id_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_message
    ADD CONSTRAINT outbox_message_owner_scope_id_operation_id_fkey FOREIGN KEY (owner_scope_id, operation_id) REFERENCES public.async_operation(owner_scope_id, id);


--
-- Name: quiz_bank quiz_bank_owner_scope_id_course_id_chapter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_bank
    ADD CONSTRAINT quiz_bank_owner_scope_id_course_id_chapter_id_fkey FOREIGN KEY (owner_scope_id, course_id, chapter_id) REFERENCES public.chapter(owner_scope_id, course_id, id);


--
-- Name: quiz_bank quiz_bank_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_bank
    ADD CONSTRAINT quiz_bank_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: quiz_bank quiz_bank_owner_scope_id_generation_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_bank
    ADD CONSTRAINT quiz_bank_owner_scope_id_generation_operation_id_fkey FOREIGN KEY (owner_scope_id, generation_operation_id) REFERENCES public.activation_generation_operation(owner_scope_id, id);


--
-- Name: quiz_delivery quiz_delivery_owner_scope_id_channel_identity_id_provider_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_delivery
    ADD CONSTRAINT quiz_delivery_owner_scope_id_channel_identity_id_provider_fkey FOREIGN KEY (owner_scope_id, channel_identity_id, provider) REFERENCES public.channel_identity(owner_scope_id, id, provider);


--
-- Name: quiz_item quiz_item_bank_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item
    ADD CONSTRAINT quiz_item_bank_fk FOREIGN KEY (owner_scope_id, quiz_bank_id) REFERENCES public.quiz_bank(owner_scope_id, id);


--
-- Name: quiz_item_concept quiz_item_concept_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item_concept
    ADD CONSTRAINT quiz_item_concept_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: quiz_item_concept quiz_item_concept_owner_scope_id_quiz_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item_concept
    ADD CONSTRAINT quiz_item_concept_owner_scope_id_quiz_item_id_fkey FOREIGN KEY (owner_scope_id, quiz_item_id) REFERENCES public.quiz_item(owner_scope_id, id);


--
-- Name: quiz_item quiz_item_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item
    ADD CONSTRAINT quiz_item_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: quiz_item_source_span quiz_item_source_span_owner_scope_id_quiz_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item_source_span
    ADD CONSTRAINT quiz_item_source_span_owner_scope_id_quiz_item_id_fkey FOREIGN KEY (owner_scope_id, quiz_item_id) REFERENCES public.quiz_item(owner_scope_id, id);


--
-- Name: quiz_item_source_span quiz_item_source_span_owner_scope_id_source_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_item_source_span
    ADD CONSTRAINT quiz_item_source_span_owner_scope_id_source_span_id_fkey FOREIGN KEY (owner_scope_id, source_span_id) REFERENCES public.source_span(owner_scope_id, id);


--
-- Name: review_schedule review_schedule_current_card_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_current_card_fk FOREIGN KEY (owner_scope_id, current_card_digest, fsrs_profile_id) REFERENCES public.fsrs_card_payload(owner_scope_id, card_digest, fsrs_profile_id);


--
-- Name: review_schedule review_schedule_current_resolution_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_current_resolution_fk FOREIGN KEY (owner_scope_id, current_delivery_resolution_id, current_replay_run_id) REFERENCES public.scheduler_delivery_resolution(owner_scope_id, resolution_id, run_id);


--
-- Name: review_schedule review_schedule_current_run_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_current_run_fk FOREIGN KEY (owner_scope_id, current_replay_run_id, user_id, concept_id, fsrs_profile_id, current_card_digest) REFERENCES public.fsrs_replay_run(owner_scope_id, run_id, user_id, concept_id, fsrs_profile_id, current_card_digest);


--
-- Name: review_schedule review_schedule_owner_scope_id_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_owner_scope_id_concept_id_fkey FOREIGN KEY (owner_scope_id, concept_id) REFERENCES public.concept(owner_scope_id, id);


--
-- Name: review_schedule review_schedule_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_schedule
    ADD CONSTRAINT review_schedule_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: scheduler_delivery_resolution scheduler_delivery_resolution_owner_scope_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_delivery_resolution
    ADD CONSTRAINT scheduler_delivery_resolution_owner_scope_id_run_id_fkey FOREIGN KEY (owner_scope_id, run_id) REFERENCES public.fsrs_replay_run(owner_scope_id, run_id) ON DELETE CASCADE;


--
-- Name: scope_membership scope_membership_owner_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_membership
    ADD CONSTRAINT scope_membership_owner_scope_id_fkey FOREIGN KEY (owner_scope_id) REFERENCES public.owner_scope(id);


--
-- Name: scope_membership scope_membership_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_membership
    ADD CONSTRAINT scope_membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_user(id);


--
-- Name: source_document source_document_active_embedding_generation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_document
    ADD CONSTRAINT source_document_active_embedding_generation_fk FOREIGN KEY (owner_scope_id, active_embedding_generation_id) REFERENCES public.source_embedding_generation(owner_scope_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: source_document source_document_owner_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_document
    ADD CONSTRAINT source_document_owner_scope_id_fkey FOREIGN KEY (owner_scope_id) REFERENCES public.owner_scope(id);


--
-- Name: source_embedding_generation source_embedding_generation_owner_scope_id_source_document_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation
    ADD CONSTRAINT source_embedding_generation_owner_scope_id_source_document_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


--
-- Name: source_embedding_generation_span source_embedding_generation_s_owner_scope_id_embedding_gen_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation_span
    ADD CONSTRAINT source_embedding_generation_s_owner_scope_id_embedding_gen_fkey FOREIGN KEY (owner_scope_id, embedding_generation_id) REFERENCES public.source_embedding_generation(owner_scope_id, id);


--
-- Name: source_embedding_generation_span source_embedding_generation_s_owner_scope_id_source_span_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_embedding_generation_span
    ADD CONSTRAINT source_embedding_generation_s_owner_scope_id_source_span_i_fkey FOREIGN KEY (owner_scope_id, source_span_id) REFERENCES public.source_span(owner_scope_id, id);


--
-- Name: source_span source_span_owner_scope_id_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_span
    ADD CONSTRAINT source_span_owner_scope_id_source_document_id_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


--
-- Name: study_session study_session_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_session
    ADD CONSTRAINT study_session_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: study_session study_session_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_session
    ADD CONSTRAINT study_session_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: activation_generation_operation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activation_generation_operation ENABLE ROW LEVEL SECURITY;

--
-- Name: activation_generation_operation activation_generation_operation_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activation_generation_operation_active_membership ON public.activation_generation_operation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: asset; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_source_span; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_source_span ENABLE ROW LEVEL SECURITY;

--
-- Name: async_operation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.async_operation ENABLE ROW LEVEL SECURITY;

--
-- Name: async_operation_attempt; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.async_operation_attempt ENABLE ROW LEVEL SECURITY;

--
-- Name: attempt; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attempt ENABLE ROW LEVEL SECURITY;

--
-- Name: attempt_concept_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attempt_concept_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: attempt_concept_evidence attempt_concept_evidence_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attempt_concept_evidence_insert ON public.attempt_concept_evidence FOR INSERT WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: attempt_concept_evidence attempt_concept_evidence_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attempt_concept_evidence_select ON public.attempt_concept_evidence FOR SELECT USING (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: audio_generation_operation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audio_generation_operation ENABLE ROW LEVEL SECURITY;

--
-- Name: audio_generation_operation audio_generation_operation_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audio_generation_operation_active_membership ON public.audio_generation_operation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: attempt authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.attempt FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: attempt_concept_evidence authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.attempt_concept_evidence FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: delivery_item authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.delivery_item FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: delivery_override authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.delivery_override FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: delivery_override_cancellation authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.delivery_override_cancellation FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: fsrs_card_payload authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.fsrs_card_payload FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: fsrs_replay_manifest authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.fsrs_replay_manifest FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: fsrs_replay_run authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.fsrs_replay_run FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: fsrs_transition_payload authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.fsrs_transition_payload FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: knowledge_state authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.knowledge_state FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: learning_event authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.learning_event FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: learning_event_concept authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.learning_event_concept FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: review_schedule authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.review_schedule FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: scheduler_delivery_resolution authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.scheduler_delivery_resolution FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: channel_identity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_identity ENABLE ROW LEVEL SECURITY;

--
-- Name: chapter; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chapter ENABLE ROW LEVEL SECURITY;

--
-- Name: chapter_source_span; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chapter_source_span ENABLE ROW LEVEL SECURITY;

--
-- Name: concept; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.concept ENABLE ROW LEVEL SECURITY;

--
-- Name: concept_prerequisite; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.concept_prerequisite ENABLE ROW LEVEL SECURITY;

--
-- Name: concept_source_span; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.concept_source_span ENABLE ROW LEVEL SECURITY;

--
-- Name: course; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.course ENABLE ROW LEVEL SECURITY;

--
-- Name: curriculum_generation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.curriculum_generation ENABLE ROW LEVEL SECURITY;

--
-- Name: curriculum_generation curriculum_generation_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY curriculum_generation_active_membership ON public.curriculum_generation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: delivery_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_item ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_override; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_override ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_override_cancellation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_override_cancellation ENABLE ROW LEVEL SECURITY;

--
-- Name: fsrs_card_payload; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fsrs_card_payload ENABLE ROW LEVEL SECURITY;

--
-- Name: fsrs_replay_manifest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fsrs_replay_manifest ENABLE ROW LEVEL SECURITY;

--
-- Name: fsrs_replay_run; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fsrs_replay_run ENABLE ROW LEVEL SECURITY;

--
-- Name: fsrs_transition_payload; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fsrs_transition_payload ENABLE ROW LEVEL SECURITY;

--
-- Name: inbox_claim; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inbox_claim ENABLE ROW LEVEL SECURITY;

--
-- Name: ingestion_operation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingestion_operation ENABLE ROW LEVEL SECURITY;

--
-- Name: ingestion_operation ingestion_operation_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingestion_operation_active_membership ON public.ingestion_operation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: knowledge_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_state ENABLE ROW LEVEL SECURITY;

--
-- Name: learning_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.learning_event ENABLE ROW LEVEL SECURITY;

--
-- Name: learning_event_concept; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.learning_event_concept ENABLE ROW LEVEL SECURITY;

--
-- Name: learning_event_concept learning_event_concept_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY learning_event_concept_insert ON public.learning_event_concept FOR INSERT WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: learning_event_concept learning_event_concept_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY learning_event_concept_select ON public.learning_event_concept FOR SELECT USING (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: learning_event learning_event_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY learning_event_insert ON public.learning_event FOR INSERT WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: learning_event learning_event_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY learning_event_select ON public.learning_event FOR SELECT USING (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: narration_script; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.narration_script ENABLE ROW LEVEL SECURITY;

--
-- Name: narration_script narration_script_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY narration_script_active_membership ON public.narration_script USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: narration_script_source_span; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.narration_script_source_span ENABLE ROW LEVEL SECURITY;

--
-- Name: narration_script_source_span narration_script_source_span_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY narration_script_source_span_active_membership ON public.narration_script_source_span USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: outbox_message; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbox_message ENABLE ROW LEVEL SECURITY;

--
-- Name: owner_scope; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.owner_scope ENABLE ROW LEVEL SECURITY;

--
-- Name: owner_scope owner_scope_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_scope_active_membership ON public.owner_scope USING (public.reflo_has_active_membership(id)) WITH CHECK (public.reflo_has_active_membership(id));


--
-- Name: quiz_bank; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quiz_bank ENABLE ROW LEVEL SECURITY;

--
-- Name: quiz_bank quiz_bank_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY quiz_bank_active_membership ON public.quiz_bank USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: quiz_delivery; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quiz_delivery ENABLE ROW LEVEL SECURITY;

--
-- Name: quiz_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quiz_item ENABLE ROW LEVEL SECURITY;

--
-- Name: quiz_item_concept; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quiz_item_concept ENABLE ROW LEVEL SECURITY;

--
-- Name: quiz_item_source_span; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quiz_item_source_span ENABLE ROW LEVEL SECURITY;

--
-- Name: review_schedule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.review_schedule ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduler_delivery_resolution; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduler_delivery_resolution ENABLE ROW LEVEL SECURITY;

--
-- Name: scope_membership; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scope_membership ENABLE ROW LEVEL SECURITY;

--
-- Name: scope_membership scope_membership_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scope_membership_active_membership ON public.scope_membership USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: asset scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.asset USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: asset_source_span scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.asset_source_span USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: async_operation scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.async_operation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: async_operation_attempt scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.async_operation_attempt USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: attempt scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.attempt USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: channel_identity scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.channel_identity USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: chapter scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.chapter USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: chapter_source_span scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.chapter_source_span USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: concept scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.concept USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: concept_prerequisite scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.concept_prerequisite USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: concept_source_span scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.concept_source_span USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: course scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.course USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: delivery_item scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.delivery_item USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: delivery_override scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.delivery_override USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: delivery_override_cancellation scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.delivery_override_cancellation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: fsrs_card_payload scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.fsrs_card_payload USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: fsrs_replay_manifest scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.fsrs_replay_manifest USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: fsrs_replay_run scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.fsrs_replay_run USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: fsrs_transition_payload scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.fsrs_transition_payload USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: inbox_claim scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.inbox_claim USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: knowledge_state scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.knowledge_state USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: outbox_message scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.outbox_message USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: quiz_delivery scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.quiz_delivery USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: quiz_item scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.quiz_item USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: quiz_item_concept scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.quiz_item_concept USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: quiz_item_source_span scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.quiz_item_source_span USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: review_schedule scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.review_schedule USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: scheduler_delivery_resolution scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.scheduler_delivery_resolution USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: source_document scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.source_document USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: source_span scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.source_span USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: study_session scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.study_session USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: source_document; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_document ENABLE ROW LEVEL SECURITY;

--
-- Name: source_embedding_generation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_embedding_generation ENABLE ROW LEVEL SECURITY;

--
-- Name: source_embedding_generation source_embedding_generation_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_embedding_generation_active_membership ON public.source_embedding_generation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: source_embedding_generation_span; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_embedding_generation_span ENABLE ROW LEVEL SECURITY;

--
-- Name: source_embedding_generation_span source_embedding_generation_span_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_embedding_generation_span_active_membership ON public.source_embedding_generation_span USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: source_span; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_span ENABLE ROW LEVEL SECURITY;

--
-- Name: study_session; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.study_session ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260719000100'),
    ('20260720000100'),
    ('20260720000200'),
    ('20260721000100'),
    ('20260721000200'),
    ('20260721000300'),
    ('20260721000400'),
    ('20260721000500'),
    ('20260723000100'),
    ('20260723000200');
