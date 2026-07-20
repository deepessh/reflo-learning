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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
    CONSTRAINT asset_asset_type_check CHECK ((asset_type = ANY (ARRAY['audio'::text, 'video'::text, 'text'::text]))),
    CONSTRAINT asset_check CHECK (((status <> 'ready'::text) OR (object_key IS NOT NULL))),
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
    score numeric(6,5) NOT NULL,
    rubric_band text NOT NULL,
    confidence numeric(6,5) NOT NULL,
    rationale_ref text,
    knowledge_algorithm_version text NOT NULL,
    eligible_for_mastery boolean NOT NULL,
    CONSTRAINT attempt_concept_evidence_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT attempt_concept_evidence_score_check CHECK (((score >= (0)::numeric) AND (score <= (1)::numeric)))
);

ALTER TABLE ONLY public.attempt_concept_evidence FORCE ROW LEVEL SECURITY;


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
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    CONSTRAINT course_status_check CHECK ((status = ANY (ARRAY['generating'::text, 'ready'::text, 'failed'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.course FORCE ROW LEVEL SECURITY;


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
-- Name: knowledge_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_state (
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    mastery numeric(6,5) NOT NULL,
    confidence numeric(6,5) NOT NULL,
    half_life interval NOT NULL,
    last_reviewed_at timestamp with time zone,
    review_count integer DEFAULT 0 NOT NULL,
    algorithm_version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_state_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
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
    idempotency_key text,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
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
    CONSTRAINT outbox_message_check CHECK (((deadline_at IS NULL) OR (deadline_at > occurred_at))),
    CONSTRAINT outbox_message_environment_check CHECK ((environment = ANY (ARRAY['dev'::text, 'staging'::text, 'pilot'::text]))),
    CONSTRAINT outbox_message_message_kind_check CHECK ((message_kind = ANY (ARRAY['command'::text, 'event'::text]))),
    CONSTRAINT outbox_message_message_version_check CHECK ((message_version > 0))
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
    CONSTRAINT quiz_item_difficulty_check CHECK (((difficulty >= 1) AND (difficulty <= 5))),
    CONSTRAINT quiz_item_item_type_check CHECK ((item_type = ANY (ARRAY['multiple_choice'::text, 'short_answer'::text, 'concept_linking'::text])))
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
-- Name: review_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_schedule (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    due_at timestamp with time zone NOT NULL,
    time_zone text NOT NULL,
    fsrs_version text NOT NULL,
    state jsonb NOT NULL,
    reschedule_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.review_schedule FORCE ROW LEVEL SECURITY;


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
    CONSTRAINT source_span_canonical_start_check CHECK ((canonical_start >= 0)),
    CONSTRAINT source_span_check CHECK ((canonical_end > canonical_start)),
    CONSTRAINT source_span_check1 CHECK (((page_start IS NULL) = (page_end IS NULL))),
    CONSTRAINT source_span_check2 CHECK (((page_end IS NULL) OR (page_end >= page_start))),
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
-- Name: chapter chapter_owner_scope_id_course_id_chapter_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter
    ADD CONSTRAINT chapter_owner_scope_id_course_id_chapter_order_key UNIQUE (owner_scope_id, course_id, chapter_order);


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
-- Name: attempt_provider_submission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX attempt_provider_submission_idx ON public.attempt USING btree (provider, provider_submission_id) WHERE (provider_submission_id IS NOT NULL);


--
-- Name: attempt_submission_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX attempt_submission_idempotency_idx ON public.attempt USING btree (submission_idempotency_key) WHERE (submission_idempotency_key IS NOT NULL);


--
-- Name: auth_login_token_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_token_identity_idx ON public.auth_login_token USING btree (email_lookup_digest, purpose, issued_at DESC);


--
-- Name: auth_session_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_user_active_idx ON public.auth_session USING btree (user_id, absolute_expires_at) WHERE (revoked_at IS NULL);


--
-- Name: learning_event_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX learning_event_idempotency_idx ON public.learning_event USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: outbox_message_unpublished_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_message_unpublished_idx ON public.outbox_message USING btree (created_at, message_id) WHERE (published_at IS NULL);


--
-- Name: quiz_delivery_provider_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quiz_delivery_provider_idempotency_idx ON public.quiz_delivery USING btree (provider, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: quiz_delivery_provider_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quiz_delivery_provider_message_idx ON public.quiz_delivery USING btree (provider, provider_message_id) WHERE (provider_message_id IS NOT NULL);


--
-- Name: review_schedule_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_schedule_due_idx ON public.review_schedule USING btree (due_at, owner_scope_id) WHERE (reschedule_reason IS NULL);


--
-- Name: scope_membership_one_active_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scope_membership_one_active_owner_idx ON public.scope_membership USING btree (owner_scope_id) WHERE ((role = 'owner'::text) AND (revoked_at IS NULL));


--
-- Name: async_operation async_operation_terminal_is_final; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER async_operation_terminal_is_final BEFORE UPDATE ON public.async_operation FOR EACH ROW EXECUTE FUNCTION public.reflo_preserve_terminal_row();


--
-- Name: inbox_claim inbox_claim_terminal_is_final; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inbox_claim_terminal_is_final BEFORE UPDATE ON public.inbox_claim FOR EACH ROW EXECUTE FUNCTION public.reflo_preserve_terminal_row();


--
-- Name: scope_membership membership_preserves_scope_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER membership_preserves_scope_owner AFTER INSERT OR DELETE OR UPDATE ON public.scope_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_check_scope_owner_from_membership();


--
-- Name: owner_scope owner_scope_requires_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER owner_scope_requires_owner AFTER INSERT OR UPDATE OF status, retired_at ON public.owner_scope DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_check_scope_owner_from_scope();


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
-- Name: auth_login_token auth_login_token_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_token
    ADD CONSTRAINT auth_login_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_user(id);


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
-- Name: course course_owner_scope_id_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course
    ADD CONSTRAINT course_owner_scope_id_source_document_id_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


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
-- Name: inbox_claim inbox_claim_owner_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_claim
    ADD CONSTRAINT inbox_claim_owner_scope_id_fkey FOREIGN KEY (owner_scope_id) REFERENCES public.owner_scope(id);


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
-- Name: outbox_message outbox_message_owner_scope_id_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_message
    ADD CONSTRAINT outbox_message_owner_scope_id_operation_id_fkey FOREIGN KEY (owner_scope_id, operation_id) REFERENCES public.async_operation(owner_scope_id, id);


--
-- Name: quiz_delivery quiz_delivery_owner_scope_id_channel_identity_id_provider_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_delivery
    ADD CONSTRAINT quiz_delivery_owner_scope_id_channel_identity_id_provider_fkey FOREIGN KEY (owner_scope_id, channel_identity_id, provider) REFERENCES public.channel_identity(owner_scope_id, id, provider);


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
-- Name: source_document source_document_owner_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_document
    ADD CONSTRAINT source_document_owner_scope_id_fkey FOREIGN KEY (owner_scope_id) REFERENCES public.owner_scope(id);


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
-- Name: delivery_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_item ENABLE ROW LEVEL SECURITY;

--
-- Name: inbox_claim; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inbox_claim ENABLE ROW LEVEL SECURITY;

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
    ('20260719000100');
