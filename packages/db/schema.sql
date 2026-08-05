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
-- Name: reflo_claim_audio_redrive(uuid, uuid, text, text, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_claim_audio_redrive(candidate_message_id uuid, candidate_request_key uuid, candidate_reason_code text, candidate_lease_owner text, candidate_lease_expires_at timestamp with time zone, candidate_now timestamp with time zone) RETURNS TABLE(claim_outcome text, message_id uuid, message_kind text, message_name text, message_version integer, producer text, environment text, correlation_id uuid, causation_id uuid, idempotency_key text, payload jsonb, occurred_at timestamp with time zone, deadline_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  existing rocketmq_redrive_request%ROWTYPE;
  safe_message record;
BEGIN
  IF candidate_reason_code NOT IN (
       'configuration_repaired',
       'provider_recovered',
       'transient_dependency_recovered'
     )
     OR candidate_lease_owner !~ '^[a-zA-Z0-9_-]{8,128}$'
     OR candidate_lease_expires_at <= candidate_now
     OR candidate_lease_expires_at > candidate_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid audio redrive claim'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    queued.*,
    operation.state AS operation_state
  INTO safe_message
  FROM public.outbox_message AS queued
  JOIN public.async_operation AS operation
    ON operation.owner_scope_id = queued.owner_scope_id
   AND operation.id = queued.operation_id
  JOIN public.audio_generation_operation AS audio
    ON audio.owner_scope_id = queued.owner_scope_id
   AND audio.id = queued.operation_id
  JOIN public.course
    ON course.owner_scope_id = audio.owner_scope_id
   AND course.id = audio.course_id
  JOIN public.source_document AS source
    ON source.owner_scope_id = course.owner_scope_id
   AND source.id = course.source_document_id
  JOIN public.owner_scope AS scope
    ON scope.id = queued.owner_scope_id
  JOIN public.scope_membership AS membership
    ON membership.owner_scope_id = queued.owner_scope_id
   AND membership.role = 'owner'
   AND membership.revoked_at IS NULL
  JOIN public.app_user AS actor
    ON actor.id = membership.user_id
  WHERE queued.message_id = candidate_message_id
    AND queued.message_kind = 'command'
    AND queued.message_name = 'media.audio.generate'
    AND queued.message_version = 1
    AND queued.producer = 'audio-generation'
    AND queued.environment = 'dev'
    AND queued.published_at IS NOT NULL
    AND queued.payload = jsonb_build_object(
      'courseId', audio.course_id::text,
      'operationId', audio.id::text,
      'ownerScopeId', audio.owner_scope_id::text
    )
    AND operation.operation_name = 'media.audio.generate'
    AND operation.operation_version = 1
    AND operation.attempt_count < 5
    AND (
      (
        operation.state = 'queued'
        AND operation.attempt_count = 0
        AND operation.sanitized_failure IS NULL
        AND candidate_reason_code IN (
          'configuration_repaired', 'provider_recovered'
        )
      )
      OR (
        operation.state = 'retry_scheduled'
        AND operation.sanitized_failure->>'policyVersion' = 'audio-retry-v1'
        AND (
          (
            candidate_reason_code = 'configuration_repaired'
            AND operation.sanitized_failure->>'failureClass' =
              'infrastructure_unavailable'
          )
          OR (
            candidate_reason_code = 'provider_recovered'
            AND operation.sanitized_failure->>'failureClass' IN (
              'provider_throttled', 'provider_unavailable'
            )
          )
          OR (
            candidate_reason_code = 'transient_dependency_recovered'
            AND operation.sanitized_failure->>'failureClass' =
              'dependency_timeout'
          )
        )
      )
    )
    AND operation.deadline_at > candidate_now
    AND course.status = 'ready'
    AND source.parse_status = 'parsed'
    AND source.retention_status = 'active'
    AND scope.status = 'active'
    AND actor.status = 'active'
  FOR UPDATE OF operation;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'ineligible'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::integer,
      NULL::text,
      NULL::text,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::jsonb,
      NULL::timestamptz,
      NULL::timestamptz;
    RETURN;
  END IF;

  SELECT *
  INTO existing
  FROM public.rocketmq_redrive_request
  WHERE rocketmq_redrive_request.message_id = candidate_message_id
  FOR UPDATE;

  IF FOUND THEN
    IF existing.request_key <> candidate_request_key
       OR existing.reason_code <> candidate_reason_code THEN
      RETURN QUERY SELECT
        'conflict'::text,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::integer,
        NULL::text,
        NULL::text,
        NULL::uuid,
        NULL::uuid,
        NULL::text,
        NULL::jsonb,
        NULL::timestamptz,
        NULL::timestamptz;
      RETURN;
    END IF;
    IF existing.state = 'published' THEN
      RETURN QUERY SELECT
        'published'::text,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::integer,
        NULL::text,
        NULL::text,
        NULL::uuid,
        NULL::uuid,
        NULL::text,
        NULL::jsonb,
        NULL::timestamptz,
        NULL::timestamptz;
      RETURN;
    END IF;
    IF existing.state = 'rejected' THEN
      RETURN QUERY SELECT
        'rejected'::text,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::integer,
        NULL::text,
        NULL::text,
        NULL::uuid,
        NULL::uuid,
        NULL::text,
        NULL::jsonb,
        NULL::timestamptz,
        NULL::timestamptz;
      RETURN;
    END IF;
    IF existing.lease_expires_at IS NOT NULL
       AND existing.lease_expires_at > candidate_now THEN
      RETURN QUERY SELECT
        'active'::text,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::integer,
        NULL::text,
        NULL::text,
        NULL::uuid,
        NULL::uuid,
        NULL::text,
        NULL::jsonb,
        NULL::timestamptz,
        NULL::timestamptz;
      RETURN;
    END IF;

    UPDATE public.rocketmq_redrive_request
    SET lease_owner = candidate_lease_owner,
        lease_expires_at = candidate_lease_expires_at,
        updated_at = candidate_now
    WHERE rocketmq_redrive_request.message_id = candidate_message_id;
  ELSE
    INSERT INTO public.rocketmq_redrive_request (
      message_id,
      request_key,
      reason_code,
      state,
      lease_owner,
      lease_expires_at,
      created_at,
      updated_at
    )
    VALUES (
      candidate_message_id,
      candidate_request_key,
      candidate_reason_code,
      'authorized',
      candidate_lease_owner,
      candidate_lease_expires_at,
      candidate_now,
      candidate_now
    );

    INSERT INTO public.rocketmq_redrive_audit (
      message_id,
      request_key,
      event_kind,
      reason_code,
      attempt_number,
      occurred_at
    )
    VALUES (
      candidate_message_id,
      candidate_request_key,
      'authorized',
      candidate_reason_code,
      0,
      candidate_now
    );
  END IF;

  UPDATE public.rocketmq_redrive_request
  SET publication_attempt_count = publication_attempt_count + 1,
      normalized_failure_class = NULL,
      updated_at = candidate_now
  WHERE rocketmq_redrive_request.message_id = candidate_message_id
  RETURNING * INTO existing;

  INSERT INTO public.rocketmq_redrive_audit (
    message_id,
    request_key,
    event_kind,
    reason_code,
    attempt_number,
    occurred_at
  )
  VALUES (
    candidate_message_id,
    candidate_request_key,
    'publication_attempted',
    candidate_reason_code,
    existing.publication_attempt_count,
    candidate_now
  );

  RETURN QUERY SELECT
    'claimed'::text,
    safe_message.message_id,
    safe_message.message_kind,
    safe_message.message_name,
    safe_message.message_version,
    safe_message.producer,
    safe_message.environment,
    safe_message.correlation_id,
    safe_message.causation_id,
    safe_message.idempotency_key,
    safe_message.payload,
    safe_message.occurred_at,
    safe_message.deadline_at;
END
$_$;


--
-- Name: reflo_claim_outbox_messages(text, timestamp with time zone, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_claim_outbox_messages(candidate_lease_owner text, candidate_lease_expires_at timestamp with time zone, candidate_batch_size integer, candidate_now timestamp with time zone) RETURNS TABLE(message_id uuid, message_kind text, message_name text, message_version integer, producer text, environment text, correlation_id uuid, causation_id uuid, idempotency_key text, payload jsonb, occurred_at timestamp with time zone, deadline_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
  IF candidate_lease_owner !~ '^[a-zA-Z0-9_-]{8,128}$'
     OR candidate_batch_size < 1
     OR candidate_batch_size > 25
     OR candidate_lease_expires_at <= candidate_now
     OR candidate_lease_expires_at > candidate_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid outbox relay claim'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT queued.message_id
    FROM public.outbox_message AS queued
    WHERE queued.published_at IS NULL
      AND queued.message_kind = 'command'
      AND queued.message_name = 'media.audio.generate'
      AND queued.message_version = 1
      AND queued.producer = 'audio-generation'
      AND queued.environment = 'dev'
      AND (queued.deadline_at IS NULL OR queued.deadline_at > candidate_now)
      AND (
        queued.relay_lease_owner IS NULL
        OR queued.relay_lease_expires_at <= candidate_now
      )
    ORDER BY queued.priority, queued.created_at, queued.message_id
    FOR UPDATE SKIP LOCKED
    LIMIT candidate_batch_size
  ),
  claimed AS (
    UPDATE public.outbox_message AS queued
    SET relay_lease_owner = candidate_lease_owner,
        relay_lease_expires_at = candidate_lease_expires_at,
        publish_attempt_count = queued.publish_attempt_count + 1,
        last_publish_failure_class = NULL
    FROM candidates
    WHERE queued.message_id = candidates.message_id
    RETURNING queued.*
  )
  SELECT
    claimed.message_id,
    claimed.message_kind,
    claimed.message_name,
    claimed.message_version,
    claimed.producer,
    claimed.environment,
    claimed.correlation_id,
    claimed.causation_id,
    claimed.idempotency_key,
    claimed.payload,
    claimed.occurred_at,
    claimed.deadline_at
  FROM claimed
  ORDER BY claimed.priority, claimed.created_at, claimed.message_id;
END
$_$;


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
-- Name: reflo_inspect_audio_redrive(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_inspect_audio_redrive(candidate_message_id uuid, candidate_now timestamp with time zone) RETURNS TABLE(message_id uuid, message_kind text, message_name text, message_version integer, producer text, environment text, correlation_id uuid, causation_id uuid, idempotency_key text, payload jsonb, occurred_at timestamp with time zone, deadline_at timestamp with time zone, operation_state text, rejection_class text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT
    queued.message_id,
    queued.message_kind,
    queued.message_name,
    queued.message_version,
    queued.producer,
    queued.environment,
    queued.correlation_id,
    queued.causation_id,
    queued.idempotency_key,
    queued.payload,
    queued.occurred_at,
    queued.deadline_at,
    operation.state,
    CASE
      WHEN queued.message_kind <> 'command'
        OR queued.message_name <> 'media.audio.generate'
        OR queued.message_version <> 1
        OR queued.producer <> 'audio-generation'
        OR queued.environment <> 'dev'
        OR operation.operation_name <> 'media.audio.generate'
        OR operation.operation_version <> 1
        OR queued.payload <> jsonb_build_object(
          'courseId', audio.course_id::text,
          'operationId', audio.id::text,
          'ownerScopeId', audio.owner_scope_id::text
        )
        THEN 'unsupported_contract'
      WHEN operation.deadline_at <= candidate_now
        OR queued.deadline_at <= candidate_now
        THEN 'expired'
      WHEN source.retention_status <> 'active'
        OR scope.status <> 'active'
        THEN 'deleted_scope'
      WHEN course.status <> 'ready'
        OR source.parse_status <> 'parsed'
        OR membership.id IS NULL
        OR actor.status <> 'active'
        THEN 'authorization_denied'
      WHEN queued.published_at IS NULL
        OR operation.attempt_count >= 5
        OR (
          operation.state = 'queued'
          AND (
            operation.attempt_count <> 0
            OR operation.sanitized_failure IS NOT NULL
          )
        )
        OR (
          operation.state = 'retry_scheduled'
          AND (
            operation.sanitized_failure->>'policyVersion' IS DISTINCT FROM
              'audio-retry-v1'
            OR operation.sanitized_failure->>'failureClass' IS NULL
            OR operation.sanitized_failure->>'failureClass' NOT IN (
              'dependency_timeout',
              'infrastructure_unavailable',
              'provider_throttled',
              'provider_unavailable'
            )
          )
        )
        OR operation.state NOT IN ('queued', 'retry_scheduled')
        THEN 'state_conflict'
      ELSE NULL
    END
  FROM outbox_message AS queued
  JOIN async_operation AS operation
    ON operation.owner_scope_id = queued.owner_scope_id
   AND operation.id = queued.operation_id
  JOIN audio_generation_operation AS audio
    ON audio.owner_scope_id = queued.owner_scope_id
   AND audio.id = queued.operation_id
  JOIN course
    ON course.owner_scope_id = audio.owner_scope_id
   AND course.id = audio.course_id
  JOIN source_document AS source
    ON source.owner_scope_id = course.owner_scope_id
   AND source.id = course.source_document_id
  JOIN owner_scope AS scope
    ON scope.id = queued.owner_scope_id
  LEFT JOIN scope_membership AS membership
    ON membership.owner_scope_id = queued.owner_scope_id
   AND membership.role = 'owner'
   AND membership.revoked_at IS NULL
  LEFT JOIN app_user AS actor
    ON actor.id = membership.user_id
  WHERE queued.message_id = candidate_message_id
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
-- Name: reflo_mark_audio_redrive_published(uuid, uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_mark_audio_redrive_published(candidate_message_id uuid, candidate_request_key uuid, candidate_lease_owner text, candidate_now timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  next_attempt integer;
BEGIN
  UPDATE public.rocketmq_redrive_request
  SET state = 'published',
      lease_owner = NULL,
      lease_expires_at = NULL,
      normalized_failure_class = NULL,
      updated_at = candidate_now,
      finalized_at = candidate_now
  WHERE message_id = candidate_message_id
    AND request_key = candidate_request_key
    AND state = 'authorized'
    AND lease_owner = candidate_lease_owner
    AND lease_expires_at > candidate_now
  RETURNING publication_attempt_count INTO next_attempt;

  IF next_attempt IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.rocketmq_redrive_audit (
    message_id,
    request_key,
    event_kind,
    reason_code,
    attempt_number,
    occurred_at
  )
  SELECT
    message_id,
    request_key,
    'published',
    reason_code,
    next_attempt,
    candidate_now
  FROM public.rocketmq_redrive_request
  WHERE message_id = candidate_message_id;
  RETURN true;
END
$$;


--
-- Name: reflo_mark_outbox_published(uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_mark_outbox_published(candidate_message_id uuid, candidate_lease_owner text, candidate_now timestamp with time zone) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  WITH marked AS (
    UPDATE outbox_message
    SET published_at = candidate_now,
        relay_lease_owner = NULL,
        relay_lease_expires_at = NULL,
        last_publish_failure_class = NULL
    WHERE message_id = candidate_message_id
      AND published_at IS NULL
      AND relay_lease_owner = candidate_lease_owner
      AND relay_lease_expires_at > candidate_now
    RETURNING message_id
  )
  SELECT EXISTS (SELECT 1 FROM marked)
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
  ) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'finalized attempt is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reflo_protect_exam_readiness_scoped_record(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_protect_exam_readiness_scoped_record() RETURNS trigger
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


--
-- Name: reflo_protect_grading_operation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_protect_grading_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.reflo_learning_scope_delete_is_authorized(OLD.owner_scope_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'assessment grading operation is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.owner_scope_id,
    NEW.idempotency_key,
    NEW.user_id,
    NEW.session_id,
    NEW.question_id,
    NEW.request_digest,
    NEW.grading_policy_version,
    NEW.policy_binding_digest,
    NEW.authorized_snapshot,
    NEW.created_at
  ) IS DISTINCT FROM (
    OLD.owner_scope_id,
    OLD.idempotency_key,
    OLD.user_id,
    OLD.session_id,
    OLD.question_id,
    OLD.request_digest,
    OLD.grading_policy_version,
    OLD.policy_binding_digest,
    OLD.authorized_snapshot,
    OLD.created_at
  ) OR OLD.status = 'finalized' THEN
    RAISE EXCEPTION 'assessment grading operation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reflo_protect_session_question(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_protect_session_question() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.presented_at IS NOT NULL
       AND public.reflo_learning_scope_delete_is_authorized(OLD.owner_scope_id)
         IS NOT TRUE
    THEN
      RAISE EXCEPTION 'presented assessment question is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.presented_at IS NOT NULL
     OR NEW.presented_at IS NULL
     OR (
       NEW.owner_scope_id,
       NEW.session_id,
       NEW.normalized_prompt_hash,
       NEW.quiz_item_id,
       NEW.operation_idempotency_key,
       NEW.presentation_kind,
       NEW.created_at
     ) IS DISTINCT FROM (
       OLD.owner_scope_id,
       OLD.session_id,
       OLD.normalized_prompt_hash,
       OLD.quiz_item_id,
       OLD.operation_idempotency_key,
       OLD.presentation_kind,
       OLD.created_at
     )
  THEN
    RAISE EXCEPTION 'assessment session question identity is immutable'
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
-- Name: reflo_reject_audio_redrive(uuid, uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_reject_audio_redrive(candidate_message_id uuid, candidate_request_key uuid, candidate_reason_code text, candidate_failure_class text, candidate_now timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  rejected boolean;
BEGIN
  IF candidate_reason_code NOT IN (
       'configuration_repaired',
       'provider_recovered',
       'transient_dependency_recovered'
     )
     OR candidate_failure_class NOT IN (
       'authorization_denied',
       'changed_intent',
       'deleted_scope',
       'expired',
       'invalid_wrapper',
       'state_conflict',
       'unsupported_contract'
     ) THEN
    RAISE EXCEPTION 'invalid redrive rejection'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rocketmq_redrive_request (
    message_id,
    request_key,
    reason_code,
    state,
    publication_attempt_count,
    normalized_failure_class,
    created_at,
    updated_at,
    finalized_at
  )
  SELECT
    queued.message_id,
    candidate_request_key,
    candidate_reason_code,
    'rejected',
    0,
    candidate_failure_class,
    candidate_now,
    candidate_now,
    candidate_now
  FROM public.outbox_message AS queued
  WHERE queued.message_id = candidate_message_id
  ON CONFLICT (message_id) DO UPDATE
  SET state = CASE
        WHEN rocketmq_redrive_request.request_key = EXCLUDED.request_key
          THEN 'rejected'
        ELSE rocketmq_redrive_request.state
      END,
      lease_owner = CASE
        WHEN rocketmq_redrive_request.request_key = EXCLUDED.request_key
          THEN NULL
        ELSE rocketmq_redrive_request.lease_owner
      END,
      lease_expires_at = CASE
        WHEN rocketmq_redrive_request.request_key = EXCLUDED.request_key
          THEN NULL
        ELSE rocketmq_redrive_request.lease_expires_at
      END,
      normalized_failure_class = CASE
        WHEN rocketmq_redrive_request.request_key = EXCLUDED.request_key
          THEN EXCLUDED.normalized_failure_class
        ELSE rocketmq_redrive_request.normalized_failure_class
      END,
      updated_at = CASE
        WHEN rocketmq_redrive_request.request_key = EXCLUDED.request_key
          THEN EXCLUDED.updated_at
        ELSE rocketmq_redrive_request.updated_at
      END,
      finalized_at = CASE
        WHEN rocketmq_redrive_request.request_key = EXCLUDED.request_key
          THEN EXCLUDED.finalized_at
        ELSE rocketmq_redrive_request.finalized_at
      END
  RETURNING (
    rocketmq_redrive_request.request_key = candidate_request_key
    AND rocketmq_redrive_request.state = 'rejected'
  ) INTO rejected;

  IF rejected THEN
    INSERT INTO public.rocketmq_redrive_audit (
      message_id,
      request_key,
      event_kind,
      reason_code,
      attempt_number,
      normalized_failure_class,
      occurred_at
    )
    SELECT
      candidate_message_id,
      candidate_request_key,
      'rejected',
      candidate_reason_code,
      publication_attempt_count,
      candidate_failure_class,
      candidate_now
    FROM public.rocketmq_redrive_request
    WHERE message_id = candidate_message_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.rocketmq_redrive_audit AS audit
        WHERE audit.message_id = candidate_message_id
          AND audit.request_key = candidate_request_key
          AND audit.event_kind = 'rejected'
      );
  END IF;
  RETURN COALESCE(rejected, false);
END
$$;


--
-- Name: reflo_reject_configuration_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_reject_configuration_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is immutable configuration', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;


--
-- Name: reflo_release_audio_redrive(uuid, uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_release_audio_redrive(candidate_message_id uuid, candidate_request_key uuid, candidate_lease_owner text, candidate_failure_class text, candidate_now timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  next_attempt integer;
BEGIN
  IF candidate_failure_class NOT IN (
    'broker_unavailable',
    'invalid_receipt',
    'publication_timeout',
    'publisher_shutdown'
  ) THEN
    RAISE EXCEPTION 'invalid redrive transient failure class'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.rocketmq_redrive_request
  SET lease_owner = NULL,
      lease_expires_at = NULL,
      normalized_failure_class = candidate_failure_class,
      updated_at = candidate_now
  WHERE message_id = candidate_message_id
    AND request_key = candidate_request_key
    AND state = 'authorized'
    AND lease_owner = candidate_lease_owner
  RETURNING publication_attempt_count INTO next_attempt;

  IF next_attempt IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.rocketmq_redrive_audit (
    message_id,
    request_key,
    event_kind,
    reason_code,
    attempt_number,
    normalized_failure_class,
    occurred_at
  )
  SELECT
    message_id,
    request_key,
    'publication_failed',
    reason_code,
    next_attempt,
    candidate_failure_class,
    candidate_now
  FROM public.rocketmq_redrive_request
  WHERE message_id = candidate_message_id;
  RETURN true;
END
$$;


--
-- Name: reflo_release_outbox_message(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_release_outbox_message(candidate_message_id uuid, candidate_lease_owner text, candidate_failure_class text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  released_count integer;
BEGIN
  IF candidate_failure_class NOT IN (
    'broker_unavailable',
    'invalid_receipt',
    'publication_timeout',
    'publisher_shutdown',
    'throttled',
    'unknown_transient'
  ) THEN
    RAISE EXCEPTION 'invalid outbox failure class'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.outbox_message
  SET relay_lease_owner = NULL,
      relay_lease_expires_at = NULL,
      last_publish_failure_class = candidate_failure_class
  WHERE message_id = candidate_message_id
    AND published_at IS NULL
    AND relay_lease_owner = candidate_lease_owner;
  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN released_count = 1;
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


--
-- Name: reflo_resolve_audio_authorization(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_resolve_audio_authorization(candidate_course_id uuid, candidate_operation_id uuid) RETURNS TABLE(actor_id uuid, authorization_id uuid, owner_scope_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT
    membership.user_id,
    membership.id,
    audio.owner_scope_id
  FROM audio_generation_operation AS audio
  JOIN async_operation AS operation
    ON operation.owner_scope_id = audio.owner_scope_id
   AND operation.id = audio.id
  JOIN course
    ON course.owner_scope_id = audio.owner_scope_id
   AND course.id = audio.course_id
  JOIN source_document AS source
    ON source.owner_scope_id = course.owner_scope_id
   AND source.id = course.source_document_id
  JOIN owner_scope AS scope
    ON scope.id = audio.owner_scope_id
  JOIN scope_membership AS membership
    ON membership.owner_scope_id = audio.owner_scope_id
   AND membership.role = 'owner'
   AND membership.revoked_at IS NULL
  JOIN app_user AS actor
    ON actor.id = membership.user_id
  WHERE audio.course_id = candidate_course_id
    AND audio.id = candidate_operation_id
    AND operation.operation_name = 'media.audio.generate'
    AND operation.operation_version = 1
    AND course.status = 'ready'
    AND source.parse_status = 'parsed'
    AND source.retention_status = 'active'
    AND scope.status = 'active'
    AND actor.status = 'active'
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


--
-- Name: reflo_validate_exam_blueprint_objective_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_validate_exam_blueprint_objective_count() RETURNS trigger
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


--
-- Name: reflo_validate_exam_mapping_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_validate_exam_mapping_count() RETURNS trigger
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


--
-- Name: reflo_validate_exam_mapping_set_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_validate_exam_mapping_set_count() RETURNS trigger
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


--
-- Name: reflo_validate_exam_mapping_weights(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_validate_exam_mapping_weights() RETURNS trigger
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


--
-- Name: reflo_validate_exam_objective_weights(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reflo_validate_exam_objective_weights() RETURNS trigger
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
    regeneration_ordinal smallint DEFAULT 0 NOT NULL,
    parent_operation_id uuid,
    request_idempotency_key text,
    requested_session_id uuid,
    CONSTRAINT activation_generation_operation_artifact_kind_check CHECK ((artifact_kind = ANY (ARRAY['first_text_lesson'::text, 'placement_quiz'::text, 'chapter_quiz'::text]))),
    CONSTRAINT activation_generation_operation_attempt_count_check CHECK (((attempt_count >= 0) AND (attempt_count <= 5))),
    CONSTRAINT activation_generation_operation_check CHECK ((((artifact_kind = 'first_text_lesson'::text) AND (chapter_id IS NOT NULL) AND (concept_id IS NOT NULL)) OR ((artifact_kind = 'placement_quiz'::text) AND (chapter_id IS NULL) AND (concept_id IS NULL)) OR ((artifact_kind = 'chapter_quiz'::text) AND (chapter_id IS NOT NULL) AND (concept_id IS NULL)))),
    CONSTRAINT activation_generation_operation_check1 CHECK (((status = 'retry_scheduled'::text) = retryable)),
    CONSTRAINT activation_generation_operation_check2 CHECK (((failure_class IS NOT NULL) = (status = ANY (ARRAY['retry_scheduled'::text, 'failed_permanent'::text])))),
    CONSTRAINT activation_generation_operation_check3 CHECK (((artifact_id IS NOT NULL) = (status = 'succeeded'::text))),
    CONSTRAINT activation_generation_operation_check4 CHECK (((completed_at IS NOT NULL) = (status = ANY (ARRAY['succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])))),
    CONSTRAINT activation_generation_operation_check5 CHECK (((status <> 'queued'::text) OR (attempt_count = 0))),
    CONSTRAINT activation_generation_operation_generation_version_check CHECK ((generation_version = ANY (ARRAY['activation-generation-v1'::text, 'activation-generation-v2'::text]))),
    CONSTRAINT activation_generation_operation_idempotency_key_check CHECK ((idempotency_key ~ '^(dev|staging|pilot)/content[.]activation[.]generate/v1/[a-f0-9-]{36}$'::text)),
    CONSTRAINT activation_generation_operation_priority_check CHECK (((priority >= 1) AND (priority <= 3))),
    CONSTRAINT activation_generation_operation_regeneration_ordinal_check CHECK ((regeneration_ordinal >= 0)),
    CONSTRAINT activation_generation_operation_regeneration_shape_check CHECK ((((regeneration_ordinal = 0) AND (parent_operation_id IS NULL) AND (request_idempotency_key IS NULL) AND (requested_session_id IS NULL)) OR ((regeneration_ordinal > 0) AND (artifact_kind = ANY (ARRAY['first_text_lesson'::text, 'placement_quiz'::text, 'chapter_quiz'::text])) AND (parent_operation_id IS NOT NULL) AND (request_idempotency_key IS NOT NULL) AND (requested_session_id IS NOT NULL)))),
    CONSTRAINT activation_generation_operation_request_key_check CHECK (((request_idempotency_key IS NULL) OR (request_idempotency_key ~ '^(dev|staging|pilot)/content[.]activation[.]regenerate/v1/[a-f0-9-]{36}$'::text))),
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
-- Name: assessment_finalization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_finalization (
    owner_scope_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    attempt_id uuid NOT NULL,
    user_id uuid NOT NULL,
    attempt_outcome text NOT NULL,
    finalization_kind text NOT NULL,
    grading_policy_version text NOT NULL,
    rating_mapping_version text NOT NULL,
    confidence_threshold numeric(6,5) NOT NULL,
    calibration_evidence_id text NOT NULL,
    policy_binding jsonb NOT NULL,
    policy_binding_digest text NOT NULL,
    learner_message text NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assessment_finalization_attempt_outcome_check CHECK ((attempt_outcome = ANY (ARRAY['graded'::text, 'abstained'::text]))),
    CONSTRAINT assessment_finalization_calibration_evidence_id_check CHECK (((length(calibration_evidence_id) >= 1) AND (length(calibration_evidence_id) <= 240))),
    CONSTRAINT assessment_finalization_confidence_threshold_check CHECK (((confidence_threshold >= (0)::numeric) AND (confidence_threshold <= (1)::numeric))),
    CONSTRAINT assessment_finalization_finalization_kind_check CHECK ((finalization_kind = ANY (ARRAY['short_answer'::text, 'keyed_mc_replacement'::text]))),
    CONSTRAINT assessment_finalization_grading_policy_version_check CHECK ((grading_policy_version = 'grading-policy-v1'::text)),
    CONSTRAINT assessment_finalization_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 240))),
    CONSTRAINT assessment_finalization_learner_message_check CHECK (((length(learner_message) >= 1) AND (length(learner_message) <= 500))),
    CONSTRAINT assessment_finalization_policy_binding_check CHECK ((jsonb_typeof(policy_binding) = 'object'::text)),
    CONSTRAINT assessment_finalization_policy_binding_digest_check CHECK ((policy_binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_finalization_rating_mapping_version_check CHECK ((rating_mapping_version = 'rating-mapping-v1'::text)),
    CONSTRAINT assessment_finalization_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.assessment_finalization FORCE ROW LEVEL SECURITY;


--
-- Name: assessment_grading_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_grading_operation (
    owner_scope_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    question_id uuid NOT NULL,
    request_digest text NOT NULL,
    grading_policy_version text NOT NULL,
    policy_binding_digest text NOT NULL,
    authorized_snapshot jsonb NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    claim_token uuid,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    CONSTRAINT assessment_grading_operation_authorized_snapshot_check CHECK ((jsonb_typeof(authorized_snapshot) = 'object'::text)),
    CONSTRAINT assessment_grading_operation_check CHECK ((((status = 'processing'::text) AND (finalized_at IS NULL)) OR ((status = 'finalized'::text) AND (claim_token IS NULL) AND (lease_expires_at IS NULL) AND (finalized_at IS NOT NULL)))),
    CONSTRAINT assessment_grading_operation_check1 CHECK ((((claim_token IS NULL) = (lease_expires_at IS NULL)) OR (status = 'finalized'::text))),
    CONSTRAINT assessment_grading_operation_grading_policy_version_check CHECK ((grading_policy_version = 'grading-policy-v1'::text)),
    CONSTRAINT assessment_grading_operation_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 240))),
    CONSTRAINT assessment_grading_operation_policy_binding_digest_check CHECK ((policy_binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_grading_operation_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_grading_operation_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'finalized'::text])))
);

ALTER TABLE ONLY public.assessment_grading_operation FORCE ROW LEVEL SECURITY;


--
-- Name: assessment_replacement_bundle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_replacement_bundle (
    owner_scope_id uuid NOT NULL,
    id uuid NOT NULL,
    original_attempt_id uuid NOT NULL,
    grading_policy_version text NOT NULL,
    bundle_version text NOT NULL,
    concept_set_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assessment_replacement_bundle_bundle_version_check CHECK ((bundle_version = 'mc-replacement-bundle-v1'::text)),
    CONSTRAINT assessment_replacement_bundle_concept_set_digest_check CHECK ((concept_set_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_replacement_bundle_grading_policy_version_check CHECK ((grading_policy_version = 'grading-policy-v1'::text))
);

ALTER TABLE ONLY public.assessment_replacement_bundle FORCE ROW LEVEL SECURITY;


--
-- Name: assessment_replacement_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_replacement_item (
    owner_scope_id uuid NOT NULL,
    id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    quiz_item_id uuid NOT NULL,
    rubric_id text NOT NULL,
    rubric_version text NOT NULL,
    normalized_prompt_hash text NOT NULL,
    course_id uuid NOT NULL,
    difficulty smallint NOT NULL,
    prompt text NOT NULL,
    response_options jsonb NOT NULL,
    keyed_answer jsonb NOT NULL,
    source_spans jsonb NOT NULL,
    snapshot_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assessment_replacement_item_difficulty_check CHECK (((difficulty >= 1) AND (difficulty <= 5))),
    CONSTRAINT assessment_replacement_item_keyed_answer_check CHECK ((jsonb_typeof(keyed_answer) = 'string'::text)),
    CONSTRAINT assessment_replacement_item_normalized_prompt_hash_check CHECK ((normalized_prompt_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_replacement_item_prompt_check CHECK (((length(prompt) >= 1) AND (length(prompt) <= 10000))),
    CONSTRAINT assessment_replacement_item_response_options_check CHECK (((jsonb_typeof(response_options) = 'array'::text) AND (jsonb_array_length(response_options) >= 2))),
    CONSTRAINT assessment_replacement_item_rubric_id_check CHECK (((length(rubric_id) >= 1) AND (length(rubric_id) <= 240))),
    CONSTRAINT assessment_replacement_item_rubric_version_check CHECK (((length(rubric_version) >= 1) AND (length(rubric_version) <= 120))),
    CONSTRAINT assessment_replacement_item_snapshot_digest_check CHECK ((snapshot_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_replacement_item_source_spans_check CHECK (((jsonb_typeof(source_spans) = 'array'::text) AND (jsonb_array_length(source_spans) >= 1)))
);

ALTER TABLE ONLY public.assessment_replacement_item FORCE ROW LEVEL SECURITY;


--
-- Name: assessment_session_question; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_session_question (
    owner_scope_id uuid NOT NULL,
    session_id uuid NOT NULL,
    normalized_prompt_hash text NOT NULL,
    quiz_item_id uuid NOT NULL,
    operation_idempotency_key text NOT NULL,
    presentation_kind text NOT NULL,
    presented_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assessment_session_question_check CHECK ((((presentation_kind = 'original'::text) AND (presented_at IS NOT NULL)) OR (presentation_kind = 'fallback'::text))),
    CONSTRAINT assessment_session_question_normalized_prompt_hash_check CHECK ((normalized_prompt_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_session_question_presentation_kind_check CHECK ((presentation_kind = ANY (ARRAY['original'::text, 'fallback'::text])))
);

ALTER TABLE ONLY public.assessment_session_question FORCE ROW LEVEL SECURITY;


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
    reteach_session_id uuid,
    reteach_replacement_ordinal smallint,
    reteach_baseline_mastery numeric(6,5),
    reteach_semantic_similarity numeric(6,5),
    reteach_generation_id uuid,
    reteach_served_at timestamp with time zone,
    CONSTRAINT asset_asset_type_check CHECK ((asset_type = ANY (ARRAY['audio'::text, 'video'::text, 'text'::text]))),
    CONSTRAINT asset_byte_size_check CHECK (((byte_size IS NULL) OR (byte_size >= 0))),
    CONSTRAINT asset_check CHECK (((status <> 'ready'::text) OR (object_key IS NOT NULL))),
    CONSTRAINT asset_content_hash_check CHECK (((content_hash IS NULL) OR (content_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT asset_narration_script_sha256_check CHECK (((narration_script_sha256 IS NULL) OR (narration_script_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT asset_ready_audio_metadata_check CHECK (((asset_type <> 'audio'::text) OR (status <> 'ready'::text) OR ((audio_generation_operation_id IS NOT NULL) AND (generation_operation_id IS NULL) AND (narration_script_id IS NOT NULL) AND (narration_script_sha256 IS NOT NULL) AND (model_provenance IS NOT NULL) AND (content_hash IS NOT NULL) AND (content_type = 'audio/wav'::text) AND (byte_size IS NOT NULL) AND (byte_size > 44) AND (etag IS NOT NULL) AND ((audio_payload_metadata ->> 'contractVersion'::text) = 'audio-payload-v1'::text) AND ((audio_payload_metadata ->> 'container'::text) = 'wav'::text) AND ((audio_payload_metadata ->> 'codec'::text) = 'pcm_s16le'::text) AND (((audio_payload_metadata ->> 'channels'::text))::integer = 1) AND (((audio_payload_metadata ->> 'sampleRateHz'::text))::integer = ANY (ARRAY[22050, 24000])) AND ((audio_payload_metadata ->> 'headerValidated'::text) = 'true'::text) AND ((audio_payload_metadata ->> 'payloadSha256'::text) = content_hash)))),
    CONSTRAINT asset_ready_text_metadata_check CHECK (((asset_type <> 'text'::text) OR (status <> 'ready'::text) OR ((model_provenance IS NOT NULL) AND (content_hash IS NOT NULL) AND (content_type IS NOT NULL) AND (byte_size IS NOT NULL) AND (etag IS NOT NULL) AND (((generation_operation_id IS NOT NULL) AND (reteach_session_id IS NULL)) OR ((generation_operation_id IS NULL) AND (reteach_session_id IS NOT NULL)))))),
    CONSTRAINT asset_reteach_shape CHECK ((((reteach_session_id IS NULL) AND (reteach_replacement_ordinal IS NULL) AND (reteach_baseline_mastery IS NULL) AND (reteach_semantic_similarity IS NULL) AND (reteach_generation_id IS NULL) AND (reteach_served_at IS NULL)) OR ((reteach_session_id IS NOT NULL) AND ((reteach_replacement_ordinal >= 1) AND (reteach_replacement_ordinal <= 2)) AND ((reteach_baseline_mastery >= (0)::numeric) AND (reteach_baseline_mastery <= (1)::numeric)) AND (reteach_semantic_similarity >= ('-1'::integer)::numeric) AND (reteach_semantic_similarity < 0.85) AND (reteach_generation_id IS NOT NULL) AND (reteach_served_at IS NOT NULL) AND (asset_type = 'text'::text) AND (status = 'ready'::text) AND (chapter_id IS NOT NULL) AND (concept_id IS NOT NULL) AND (generation_operation_id IS NULL) AND (audio_generation_operation_id IS NULL) AND (generation_version = 'reteach-generation-v1'::text) AND ((model_provenance ->> 'task'::text) = 'lesson.reteach.v1'::text) AND ((model_provenance ->> 'validationOutcome'::text) = 'passed'::text)))),
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
    grading_policy_version text,
    rating_mapping_version text,
    replacement_for_attempt_id uuid,
    CONSTRAINT attempt_check CHECK (((session_id IS NOT NULL) OR (delivery_item_id IS NOT NULL))),
    CONSTRAINT attempt_check1 CHECK (((provider IS NULL) = (provider_submission_id IS NULL))),
    CONSTRAINT attempt_grading_confidence_check CHECK (((grading_confidence IS NULL) OR ((grading_confidence >= (0)::numeric) AND (grading_confidence <= (1)::numeric)))),
    CONSTRAINT attempt_grading_policy_shape CHECK ((((grading_policy_version IS NULL) AND (rating_mapping_version IS NULL) AND (replacement_for_attempt_id IS NULL)) OR ((grading_policy_version = 'grading-policy-v1'::text) AND (rating_mapping_version = 'rating-mapping-v1'::text) AND (overall_grade IS NULL) AND (grading_confidence IS NULL) AND (replacement_for_attempt_id IS DISTINCT FROM id)))),
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
    unanswerable_reason text,
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
    CONSTRAINT evidence_rubric_band_closed CHECK (((rubric_band IS NULL) OR (rubric_band = ANY (ARRAY['incorrect'::text, 'partially_correct'::text, 'correct'::text])))),
    CONSTRAINT evidence_unanswerable_reason_closed CHECK (((unanswerable_reason IS NULL) OR (unanswerable_reason = ANY (ARRAY['source_insufficient'::text, 'source_conflict'::text, 'rubric_insufficient'::text, 'rubric_conflict'::text]))))
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
    identity_class text NOT NULL,
    CONSTRAINT channel_identity_check CHECK (((revoked_at IS NULL) OR (verified_at IS NULL) OR (revoked_at >= verified_at))),
    CONSTRAINT channel_identity_identity_class_check CHECK ((identity_class = 'demo_staff'::text)),
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
    CONSTRAINT curriculum_generation_generation_version_check CHECK ((generation_version = ANY (ARRAY['curriculum-v1'::text, 'curriculum-v2'::text]))),
    CONSTRAINT curriculum_generation_result_hash_check CHECK ((result_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT curriculum_generation_status_check CHECK ((status = ANY (ARRAY['building'::text, 'active'::text, 'retired'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.curriculum_generation FORCE ROW LEVEL SECURITY;


--
-- Name: curriculum_partition_manifest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum_partition_manifest (
    id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    course_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    embedding_generation_id uuid NOT NULL,
    partition_version text NOT NULL,
    composition_version text NOT NULL,
    generation_version text NOT NULL,
    tokenizer_version text NOT NULL,
    manifest_hash text NOT NULL,
    manifest jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT curriculum_partition_manifest_composition_version_check CHECK ((composition_version = 'curriculum-compose-v1'::text)),
    CONSTRAINT curriculum_partition_manifest_generation_version_check CHECK ((generation_version = 'curriculum-v2'::text)),
    CONSTRAINT curriculum_partition_manifest_manifest_hash_check CHECK ((manifest_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT curriculum_partition_manifest_partition_version_check CHECK ((partition_version = 'curriculum-partition-v1'::text)),
    CONSTRAINT curriculum_partition_manifest_tokenizer_version_check CHECK ((tokenizer_version = 'reflo-unicode-tokenizer-v1'::text))
);

ALTER TABLE ONLY public.curriculum_partition_manifest FORCE ROW LEVEL SECURITY;


--
-- Name: curriculum_segment_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum_segment_operation (
    owner_scope_id uuid NOT NULL,
    parent_generation_id uuid NOT NULL,
    segment_id uuid NOT NULL,
    segment_ordinal integer NOT NULL,
    idempotency_key text NOT NULL,
    task_version text NOT NULL,
    input_schema_version text NOT NULL,
    result_schema_version text NOT NULL,
    input_hash text NOT NULL,
    ordered_source_span_ids jsonb NOT NULL,
    ordered_source_input_hashes jsonb NOT NULL,
    state text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    result_hash text,
    result jsonb,
    model_provenance jsonb,
    sanitized_failure jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT curriculum_segment_operation_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT curriculum_segment_operation_check CHECK (((state = 'processing'::text) = ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT curriculum_segment_operation_check1 CHECK (((state = 'succeeded'::text) = ((result_hash IS NOT NULL) AND (result IS NOT NULL) AND (model_provenance IS NOT NULL)))),
    CONSTRAINT curriculum_segment_operation_check2 CHECK (((state = ANY (ARRAY['succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT curriculum_segment_operation_idempotency_key_check CHECK ((idempotency_key ~ '^[a-z]+/curriculum[.]segment/v1/[0-9a-f-]{36}/[0-9a-f-]{36}$'::text)),
    CONSTRAINT curriculum_segment_operation_input_hash_check CHECK ((input_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT curriculum_segment_operation_input_schema_version_check CHECK ((input_schema_version = 'curriculum-segment-input-v1'::text)),
    CONSTRAINT curriculum_segment_operation_result_hash_check CHECK (((result_hash IS NULL) OR (result_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT curriculum_segment_operation_result_schema_version_check CHECK ((result_schema_version = 'curriculum-segment-result-v1'::text)),
    CONSTRAINT curriculum_segment_operation_segment_ordinal_check CHECK ((segment_ordinal >= 0)),
    CONSTRAINT curriculum_segment_operation_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_scheduled'::text, 'succeeded'::text, 'failed_permanent'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT curriculum_segment_operation_task_version_check CHECK ((task_version = 'curriculum.segment.v1'::text))
);

ALTER TABLE ONLY public.curriculum_segment_operation FORCE ROW LEVEL SECURITY;


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
-- Name: delivery_preference; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_preference (
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    chosen_local_time time(0) without time zone NOT NULL,
    time_zone text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT delivery_preference_provider_check CHECK ((provider = ANY (ARRAY['telegram'::text, 'email'::text]))),
    CONSTRAINT delivery_preference_time_zone_check CHECK (((length(time_zone) >= 1) AND (length(time_zone) <= 100)))
);

ALTER TABLE ONLY public.delivery_preference FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_streak; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_streak (
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    current_streak integer NOT NULL,
    longest_streak integer NOT NULL,
    last_answered_on date NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT delivery_streak_check CHECK ((longest_streak >= current_streak)),
    CONSTRAINT delivery_streak_current_streak_check CHECK ((current_streak > 0))
);

ALTER TABLE ONLY public.delivery_streak FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_streak_day; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_streak_day (
    owner_scope_id uuid NOT NULL,
    user_id uuid NOT NULL,
    local_date date NOT NULL,
    time_zone text NOT NULL,
    delivery_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.delivery_streak_day FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_submission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_submission (
    owner_scope_id uuid NOT NULL,
    provider text NOT NULL,
    provider_submission_id text NOT NULL,
    delivery_id uuid NOT NULL,
    user_id uuid NOT NULL,
    request_digest text NOT NULL,
    submitted_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT delivery_submission_provider_check CHECK ((provider = ANY (ARRAY['telegram'::text, 'email'::text]))),
    CONSTRAINT delivery_submission_provider_submission_id_check CHECK (((length(provider_submission_id) >= 1) AND (length(provider_submission_id) <= 240))),
    CONSTRAINT delivery_submission_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.delivery_submission FORCE ROW LEVEL SECURITY;


--
-- Name: demo_upload_generation_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demo_upload_generation_operation (
    operation_id uuid NOT NULL,
    owner_scope_id uuid NOT NULL,
    requested_by_user_id uuid NOT NULL,
    course_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    input_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT demo_upload_generation_operation_input_sha256_check CHECK ((input_sha256 ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY public.demo_upload_generation_operation FORCE ROW LEVEL SECURITY;


--
-- Name: exam_blueprint; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_blueprint (
    id uuid NOT NULL,
    version text NOT NULL,
    name text NOT NULL,
    objective_count integer NOT NULL,
    source_provenance jsonb NOT NULL,
    published_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exam_blueprint_name_check CHECK (((length(name) >= 1) AND (length(name) <= 240))),
    CONSTRAINT exam_blueprint_objective_count_check CHECK ((objective_count > 0)),
    CONSTRAINT exam_blueprint_source_provenance_check CHECK (((jsonb_typeof(source_provenance) = 'object'::text) AND (source_provenance <> '{}'::jsonb))),
    CONSTRAINT exam_blueprint_version_check CHECK (((length(version) >= 1) AND (length(version) <= 120)))
);


--
-- Name: exam_blueprint_objective; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_blueprint_objective (
    blueprint_id uuid NOT NULL,
    blueprint_version text NOT NULL,
    id uuid NOT NULL,
    objective_key text NOT NULL,
    title text NOT NULL,
    weight numeric(6,5) NOT NULL,
    source_provenance jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exam_blueprint_objective_objective_key_check CHECK (((length(objective_key) >= 1) AND (length(objective_key) <= 120))),
    CONSTRAINT exam_blueprint_objective_source_provenance_check CHECK (((jsonb_typeof(source_provenance) = 'object'::text) AND (source_provenance <> '{}'::jsonb))),
    CONSTRAINT exam_blueprint_objective_title_check CHECK (((length(title) >= 1) AND (length(title) <= 500))),
    CONSTRAINT exam_blueprint_objective_weight_check CHECK (((weight >= (0)::numeric) AND (weight <= (1)::numeric)))
);


--
-- Name: exam_readiness_calibration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_readiness_calibration (
    id uuid NOT NULL,
    blueprint_id uuid NOT NULL,
    blueprint_version text NOT NULL,
    version text NOT NULL,
    sample_size integer NOT NULL,
    mean_absolute_error numeric(6,5) NOT NULL,
    representative boolean NOT NULL,
    evidence_provenance jsonb NOT NULL,
    frozen_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exam_readiness_calibration_evidence_provenance_check CHECK (((jsonb_typeof(evidence_provenance) = 'object'::text) AND (evidence_provenance <> '{}'::jsonb))),
    CONSTRAINT exam_readiness_calibration_mean_absolute_error_check CHECK (((mean_absolute_error >= (0)::numeric) AND (mean_absolute_error <= (1)::numeric))),
    CONSTRAINT exam_readiness_calibration_sample_size_check CHECK ((sample_size > 0)),
    CONSTRAINT exam_readiness_calibration_version_check CHECK (((length(version) >= 1) AND (length(version) <= 120)))
);


--
-- Name: exam_readiness_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_readiness_mapping (
    owner_scope_id uuid NOT NULL,
    mapping_set_id uuid NOT NULL,
    course_id uuid NOT NULL,
    blueprint_id uuid NOT NULL,
    objective_id uuid NOT NULL,
    concept_id uuid NOT NULL,
    concept_generation_id uuid NOT NULL,
    concept_generation_version text NOT NULL,
    mapping_weight numeric(6,5) NOT NULL,
    source_provenance jsonb NOT NULL,
    reviewer_provenance jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exam_readiness_mapping_mapping_weight_check CHECK (((mapping_weight >= (0)::numeric) AND (mapping_weight <= (1)::numeric))),
    CONSTRAINT exam_readiness_mapping_reviewer_provenance_check CHECK (((jsonb_typeof(reviewer_provenance) = 'object'::text) AND (reviewer_provenance <> '{}'::jsonb))),
    CONSTRAINT exam_readiness_mapping_source_provenance_check CHECK (((jsonb_typeof(source_provenance) = 'object'::text) AND (source_provenance <> '{}'::jsonb)))
);

ALTER TABLE ONLY public.exam_readiness_mapping FORCE ROW LEVEL SECURITY;


--
-- Name: exam_readiness_mapping_set; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_readiness_mapping_set (
    owner_scope_id uuid NOT NULL,
    id uuid NOT NULL,
    course_id uuid NOT NULL,
    blueprint_id uuid NOT NULL,
    blueprint_version text NOT NULL,
    mapping_set_version text NOT NULL,
    mapping_count integer NOT NULL,
    readiness_profile_version text NOT NULL,
    knowledge_algorithm_version text NOT NULL,
    reviewer_provenance jsonb NOT NULL,
    reviewed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exam_readiness_mapping_set_knowledge_algorithm_version_check CHECK ((knowledge_algorithm_version = 'knowledge-model-v1'::text)),
    CONSTRAINT exam_readiness_mapping_set_mapping_count_check CHECK ((mapping_count > 0)),
    CONSTRAINT exam_readiness_mapping_set_mapping_set_version_check CHECK (((length(mapping_set_version) >= 1) AND (length(mapping_set_version) <= 120))),
    CONSTRAINT exam_readiness_mapping_set_readiness_profile_version_check CHECK ((readiness_profile_version = 'exam-readiness-profile-v1'::text)),
    CONSTRAINT exam_readiness_mapping_set_reviewer_provenance_check CHECK (((jsonb_typeof(reviewer_provenance) = 'object'::text) AND (reviewer_provenance <> '{}'::jsonb)))
);

ALTER TABLE ONLY public.exam_readiness_mapping_set FORCE ROW LEVEL SECURITY;


--
-- Name: exam_readiness_score; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_readiness_score (
    owner_scope_id uuid NOT NULL,
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    course_id uuid NOT NULL,
    readiness_profile_version text NOT NULL,
    blueprint_id uuid NOT NULL,
    blueprint_version text NOT NULL,
    mapping_set_id uuid NOT NULL,
    mapping_set_version text NOT NULL,
    knowledge_algorithm_version text NOT NULL,
    calibration_id uuid,
    calibration_version text,
    calibration_status text NOT NULL,
    calibration_sample_size integer,
    calibration_mean_absolute_error numeric(6,5),
    calibration_representative boolean,
    score numeric(6,5) NOT NULL,
    evidence_coverage numeric(6,5) NOT NULL,
    objective_count integer NOT NULL,
    objective_mapped_count integer NOT NULL,
    objective_evidence_count integer NOT NULL,
    mapped_concept_count integer NOT NULL,
    invalidated_concept_count integer NOT NULL,
    unmapped_concept_count integer NOT NULL,
    evidence_eligible_concept_count integer NOT NULL,
    experimental boolean NOT NULL,
    snapshot_digest text NOT NULL,
    input_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exam_readiness_score_calibration_status_check CHECK ((calibration_status = ANY (ARRAY['unavailable'::text, 'inadequate'::text, 'adequate'::text]))),
    CONSTRAINT exam_readiness_score_check CHECK ((((objective_mapped_count >= 0) AND (objective_mapped_count <= objective_count)) AND ((objective_evidence_count >= 0) AND (objective_evidence_count <= objective_count)) AND (mapped_concept_count >= 0) AND (invalidated_concept_count >= 0) AND (unmapped_concept_count >= 0) AND (evidence_eligible_concept_count >= 0))),
    CONSTRAINT exam_readiness_score_check1 CHECK ((((calibration_status = 'unavailable'::text) AND (calibration_id IS NULL) AND (calibration_version IS NULL) AND (calibration_sample_size IS NULL) AND (calibration_mean_absolute_error IS NULL) AND (calibration_representative IS NULL) AND experimental) OR ((calibration_status = 'inadequate'::text) AND (calibration_id IS NOT NULL) AND (calibration_version IS NOT NULL) AND (calibration_sample_size IS NOT NULL) AND (calibration_sample_size > 0) AND (calibration_mean_absolute_error IS NOT NULL) AND (calibration_representative IS NOT NULL) AND experimental) OR ((calibration_status = 'adequate'::text) AND (calibration_id IS NOT NULL) AND (calibration_version IS NOT NULL) AND (calibration_sample_size >= 100) AND (calibration_mean_absolute_error <= 0.10000) AND calibration_representative AND (experimental = false)))),
    CONSTRAINT exam_readiness_score_evidence_coverage_check CHECK (((evidence_coverage >= 0.80000) AND (evidence_coverage <= (1)::numeric))),
    CONSTRAINT exam_readiness_score_input_snapshot_check CHECK (((jsonb_typeof(input_snapshot) = 'object'::text) AND (input_snapshot <> '{}'::jsonb))),
    CONSTRAINT exam_readiness_score_mapping_set_version_check CHECK (((length(mapping_set_version) >= 1) AND (length(mapping_set_version) <= 120))),
    CONSTRAINT exam_readiness_score_objective_count_check CHECK ((objective_count > 0)),
    CONSTRAINT exam_readiness_score_readiness_profile_version_check CHECK ((readiness_profile_version = 'exam-readiness-profile-v1'::text)),
    CONSTRAINT exam_readiness_score_score_check CHECK (((score >= (0)::numeric) AND (score <= (1)::numeric))),
    CONSTRAINT exam_readiness_score_snapshot_digest_check CHECK ((snapshot_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.exam_readiness_score FORCE ROW LEVEL SECURITY;


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
-- Name: grading_policy_binding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grading_policy_binding (
    grading_policy_version text NOT NULL,
    rating_mapping_version text NOT NULL,
    confidence_threshold numeric(6,5) NOT NULL,
    calibration_evidence_id text NOT NULL,
    expected_model_provenance jsonb NOT NULL,
    binding_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grading_policy_binding_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT grading_policy_binding_calibration_evidence_id_check CHECK (((length(calibration_evidence_id) >= 1) AND (length(calibration_evidence_id) <= 240))),
    CONSTRAINT grading_policy_binding_confidence_threshold_check CHECK (((confidence_threshold >= (0)::numeric) AND (confidence_threshold <= (1)::numeric))),
    CONSTRAINT grading_policy_binding_expected_model_provenance_check CHECK ((jsonb_typeof(expected_model_provenance) = 'object'::text)),
    CONSTRAINT grading_policy_binding_grading_policy_version_check CHECK ((grading_policy_version = 'grading-policy-v1'::text)),
    CONSTRAINT grading_policy_binding_rating_mapping_version_check CHECK ((rating_mapping_version = 'rating-mapping-v1'::text))
);


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
    relay_lease_owner text,
    relay_lease_expires_at timestamp with time zone,
    publish_attempt_count integer DEFAULT 0 NOT NULL,
    last_publish_failure_class text,
    CONSTRAINT outbox_message_check CHECK (((deadline_at IS NULL) OR (deadline_at > occurred_at))),
    CONSTRAINT outbox_message_environment_check CHECK ((environment = ANY (ARRAY['dev'::text, 'staging'::text, 'pilot'::text]))),
    CONSTRAINT outbox_message_message_kind_check CHECK ((message_kind = ANY (ARRAY['command'::text, 'event'::text]))),
    CONSTRAINT outbox_message_message_version_check CHECK ((message_version > 0)),
    CONSTRAINT outbox_message_priority_check CHECK (((priority >= 1) AND (priority <= 800))),
    CONSTRAINT outbox_message_publish_attempt_count_check CHECK ((publish_attempt_count >= 0)),
    CONSTRAINT outbox_message_publish_failure_shape CHECK (((last_publish_failure_class IS NULL) OR (last_publish_failure_class = ANY (ARRAY['broker_unavailable'::text, 'invalid_receipt'::text, 'publication_timeout'::text, 'publisher_shutdown'::text, 'throttled'::text, 'unknown_transient'::text])))),
    CONSTRAINT outbox_message_published_relay_shape CHECK (((published_at IS NULL) OR ((relay_lease_owner IS NULL) AND (relay_lease_expires_at IS NULL)))),
    CONSTRAINT outbox_message_relay_lease_shape CHECK (((relay_lease_owner IS NULL) = (relay_lease_expires_at IS NULL)))
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
    CONSTRAINT quiz_bank_generation_version_check CHECK ((generation_version = ANY (ARRAY['activation-generation-v1'::text, 'activation-generation-v2'::text]))),
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
    idempotency_key text NOT NULL,
    status text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    sanitized_error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    request_digest text NOT NULL,
    email_token_digest text,
    email_token_expires_at timestamp with time zone,
    email_token_redeemed_at timestamp with time zone,
    claim_token uuid,
    lease_expires_at timestamp with time zone,
    CONSTRAINT quiz_delivery_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT quiz_delivery_claim_shape CHECK ((((claim_token IS NULL) AND (lease_expires_at IS NULL)) OR ((status = 'processing'::text) AND (claim_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT quiz_delivery_email_token_digest_check CHECK (((email_token_digest IS NULL) OR (email_token_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT quiz_delivery_email_token_shape CHECK ((((provider = 'email'::text) AND ((email_token_digest IS NULL) OR ((email_token_expires_at = expires_at) AND ((email_token_redeemed_at IS NULL) OR (email_token_redeemed_at <= expires_at))))) OR ((provider <> 'email'::text) AND (email_token_digest IS NULL) AND (email_token_expires_at IS NULL) AND (email_token_redeemed_at IS NULL)))),
    CONSTRAINT quiz_delivery_provider_check CHECK ((provider = ANY (ARRAY['telegram'::text, 'email'::text, 'whatsapp'::text]))),
    CONSTRAINT quiz_delivery_request_digest_shape CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT quiz_delivery_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'submitted'::text, 'delivered'::text, 'failed'::text, 'expired'::text, 'cancelled'::text])))
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
    CONSTRAINT release_gate_attestation_check CHECK (((superseded_at IS NULL) OR (superseded_at >= published_at))),
    CONSTRAINT release_gate_attestation_contract_pair_check CHECK ((((attestation_version = 'gate-attestation-v1'::text) AND (contract_version = 'evaluation-contract-v1'::text) AND (superseded_at IS NOT NULL)) OR ((attestation_version = 'gate-attestation-v2'::text) AND (contract_version = 'evaluation-contract-v2'::text)))),
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
-- Name: rocketmq_redrive_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rocketmq_redrive_audit (
    id bigint NOT NULL,
    message_id uuid NOT NULL,
    request_key uuid NOT NULL,
    event_kind text NOT NULL,
    reason_code text NOT NULL,
    attempt_number integer NOT NULL,
    normalized_failure_class text,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT rocketmq_redrive_audit_attempt_number_check CHECK ((attempt_number >= 0)),
    CONSTRAINT rocketmq_redrive_audit_event_kind_check CHECK ((event_kind = ANY (ARRAY['authorized'::text, 'publication_attempted'::text, 'publication_failed'::text, 'published'::text, 'rejected'::text]))),
    CONSTRAINT rocketmq_redrive_audit_normalized_failure_class_check CHECK (((normalized_failure_class IS NULL) OR (normalized_failure_class = ANY (ARRAY['authorization_denied'::text, 'broker_unavailable'::text, 'changed_intent'::text, 'deleted_scope'::text, 'expired'::text, 'invalid_receipt'::text, 'invalid_wrapper'::text, 'publication_timeout'::text, 'publisher_shutdown'::text, 'state_conflict'::text, 'unsupported_contract'::text])))),
    CONSTRAINT rocketmq_redrive_audit_reason_code_check CHECK ((reason_code = ANY (ARRAY['configuration_repaired'::text, 'provider_recovered'::text, 'transient_dependency_recovered'::text])))
);


--
-- Name: rocketmq_redrive_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.rocketmq_redrive_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.rocketmq_redrive_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: rocketmq_redrive_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rocketmq_redrive_request (
    message_id uuid NOT NULL,
    request_key uuid NOT NULL,
    reason_code text NOT NULL,
    state text NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    publication_attempt_count integer DEFAULT 0 NOT NULL,
    normalized_failure_class text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    CONSTRAINT rocketmq_redrive_request_check CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT rocketmq_redrive_request_check1 CHECK ((((state = 'authorized'::text) AND (finalized_at IS NULL)) OR ((state = ANY (ARRAY['published'::text, 'rejected'::text])) AND (finalized_at IS NOT NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT rocketmq_redrive_request_normalized_failure_class_check CHECK (((normalized_failure_class IS NULL) OR (normalized_failure_class = ANY (ARRAY['authorization_denied'::text, 'broker_unavailable'::text, 'changed_intent'::text, 'deleted_scope'::text, 'expired'::text, 'invalid_receipt'::text, 'invalid_wrapper'::text, 'publication_timeout'::text, 'publisher_shutdown'::text, 'state_conflict'::text, 'unsupported_contract'::text])))),
    CONSTRAINT rocketmq_redrive_request_publication_attempt_count_check CHECK ((publication_attempt_count >= 0)),
    CONSTRAINT rocketmq_redrive_request_reason_code_check CHECK ((reason_code = ANY (ARRAY['configuration_repaired'::text, 'provider_recovered'::text, 'transient_dependency_recovered'::text]))),
    CONSTRAINT rocketmq_redrive_request_state_check CHECK ((state = ANY (ARRAY['authorized'::text, 'published'::text, 'rejected'::text])))
);


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
-- Name: assessment_finalization assessment_finalization_owner_scope_id_attempt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_finalization
    ADD CONSTRAINT assessment_finalization_owner_scope_id_attempt_id_key UNIQUE (owner_scope_id, attempt_id);


--
-- Name: assessment_finalization assessment_finalization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_finalization
    ADD CONSTRAINT assessment_finalization_pkey PRIMARY KEY (owner_scope_id, idempotency_key);


--
-- Name: assessment_grading_operation assessment_grading_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_grading_operation
    ADD CONSTRAINT assessment_grading_operation_pkey PRIMARY KEY (owner_scope_id, idempotency_key);


--
-- Name: assessment_replacement_bundle assessment_replacement_bundle_owner_scope_id_original_attem_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_bundle
    ADD CONSTRAINT assessment_replacement_bundle_owner_scope_id_original_attem_key UNIQUE (owner_scope_id, original_attempt_id, grading_policy_version);


--
-- Name: assessment_replacement_bundle assessment_replacement_bundle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_bundle
    ADD CONSTRAINT assessment_replacement_bundle_pkey PRIMARY KEY (owner_scope_id, id);


--
-- Name: assessment_replacement_item assessment_replacement_item_owner_scope_id_bundle_id_concep_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_item
    ADD CONSTRAINT assessment_replacement_item_owner_scope_id_bundle_id_concep_key UNIQUE (owner_scope_id, bundle_id, concept_id);


--
-- Name: assessment_replacement_item assessment_replacement_item_owner_scope_id_bundle_id_normal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_item
    ADD CONSTRAINT assessment_replacement_item_owner_scope_id_bundle_id_normal_key UNIQUE (owner_scope_id, bundle_id, normalized_prompt_hash);


--
-- Name: assessment_replacement_item assessment_replacement_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_item
    ADD CONSTRAINT assessment_replacement_item_pkey PRIMARY KEY (owner_scope_id, id);


--
-- Name: assessment_session_question assessment_session_question_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_session_question
    ADD CONSTRAINT assessment_session_question_pkey PRIMARY KEY (owner_scope_id, session_id, normalized_prompt_hash);


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
-- Name: asset asset_reteach_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_reteach_identity UNIQUE (owner_scope_id, reteach_session_id, concept_id, reteach_replacement_ordinal);


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
-- Name: attempt attempt_finalization_provenance_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_finalization_provenance_key UNIQUE (owner_scope_id, id, user_id, outcome);


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
-- Name: concept concept_readiness_generation_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concept
    ADD CONSTRAINT concept_readiness_generation_key UNIQUE (owner_scope_id, id, curriculum_generation_id, generation_version);


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
-- Name: course course_readiness_target_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course
    ADD CONSTRAINT course_readiness_target_key UNIQUE (owner_scope_id, id, target_exam_blueprint_id);


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
-- Name: curriculum_partition_manifest curriculum_partition_manifest_owner_scope_id_course_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_partition_manifest
    ADD CONSTRAINT curriculum_partition_manifest_owner_scope_id_course_id_id_key UNIQUE (owner_scope_id, course_id, id);


--
-- Name: curriculum_partition_manifest curriculum_partition_manifest_owner_scope_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_partition_manifest
    ADD CONSTRAINT curriculum_partition_manifest_owner_scope_id_id_key UNIQUE (owner_scope_id, id);


--
-- Name: curriculum_partition_manifest curriculum_partition_manifest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_partition_manifest
    ADD CONSTRAINT curriculum_partition_manifest_pkey PRIMARY KEY (id);


--
-- Name: curriculum_segment_operation curriculum_segment_operation_owner_scope_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_segment_operation
    ADD CONSTRAINT curriculum_segment_operation_owner_scope_id_idempotency_key_key UNIQUE (owner_scope_id, idempotency_key);


--
-- Name: curriculum_segment_operation curriculum_segment_operation_owner_scope_id_parent_generati_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_segment_operation
    ADD CONSTRAINT curriculum_segment_operation_owner_scope_id_parent_generati_key UNIQUE (owner_scope_id, parent_generation_id, segment_ordinal);


--
-- Name: curriculum_segment_operation curriculum_segment_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_segment_operation
    ADD CONSTRAINT curriculum_segment_operation_pkey PRIMARY KEY (owner_scope_id, parent_generation_id, segment_id);


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
-- Name: delivery_preference delivery_preference_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_preference
    ADD CONSTRAINT delivery_preference_pkey PRIMARY KEY (owner_scope_id, user_id);


--
-- Name: delivery_streak_day delivery_streak_day_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_streak_day
    ADD CONSTRAINT delivery_streak_day_pkey PRIMARY KEY (owner_scope_id, user_id, local_date);


--
-- Name: delivery_streak delivery_streak_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_streak
    ADD CONSTRAINT delivery_streak_pkey PRIMARY KEY (owner_scope_id, user_id);


--
-- Name: delivery_submission delivery_submission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_submission
    ADD CONSTRAINT delivery_submission_pkey PRIMARY KEY (owner_scope_id, provider, provider_submission_id);


--
-- Name: delivery_submission delivery_submission_provider_provider_submission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_submission
    ADD CONSTRAINT delivery_submission_provider_provider_submission_id_key UNIQUE (provider, provider_submission_id);


--
-- Name: demo_upload_generation_operation demo_upload_generation_operatio_owner_scope_id_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_upload_generation_operation
    ADD CONSTRAINT demo_upload_generation_operatio_owner_scope_id_operation_id_key UNIQUE (owner_scope_id, operation_id);


--
-- Name: demo_upload_generation_operation demo_upload_generation_operation_owner_scope_id_course_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_upload_generation_operation
    ADD CONSTRAINT demo_upload_generation_operation_owner_scope_id_course_id_key UNIQUE (owner_scope_id, course_id);


--
-- Name: demo_upload_generation_operation demo_upload_generation_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_upload_generation_operation
    ADD CONSTRAINT demo_upload_generation_operation_pkey PRIMARY KEY (operation_id);


--
-- Name: attempt_concept_evidence evidence_unanswerable_reason_shape; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.attempt_concept_evidence
    ADD CONSTRAINT evidence_unanswerable_reason_shape CHECK ((((judgment_kind = 'unanswerable'::text) AND (unanswerable_reason IS NOT NULL)) OR ((judgment_kind = 'scored'::text) AND (unanswerable_reason IS NULL)))) NOT VALID;


--
-- Name: exam_blueprint exam_blueprint_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_blueprint
    ADD CONSTRAINT exam_blueprint_id_version_key UNIQUE (id, version);


--
-- Name: exam_blueprint_objective exam_blueprint_objective_blueprint_id_objective_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_blueprint_objective
    ADD CONSTRAINT exam_blueprint_objective_blueprint_id_objective_key_key UNIQUE (blueprint_id, objective_key);


--
-- Name: exam_blueprint_objective exam_blueprint_objective_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_blueprint_objective
    ADD CONSTRAINT exam_blueprint_objective_pkey PRIMARY KEY (blueprint_id, id);


--
-- Name: exam_blueprint exam_blueprint_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_blueprint
    ADD CONSTRAINT exam_blueprint_pkey PRIMARY KEY (id);


--
-- Name: exam_readiness_calibration exam_readiness_calibration_blueprint_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_calibration
    ADD CONSTRAINT exam_readiness_calibration_blueprint_id_version_key UNIQUE (blueprint_id, version);


--
-- Name: exam_readiness_calibration exam_readiness_calibration_id_blueprint_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_calibration
    ADD CONSTRAINT exam_readiness_calibration_id_blueprint_id_version_key UNIQUE (id, blueprint_id, version);


--
-- Name: exam_readiness_calibration exam_readiness_calibration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_calibration
    ADD CONSTRAINT exam_readiness_calibration_pkey PRIMARY KEY (id);


--
-- Name: exam_readiness_mapping exam_readiness_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping
    ADD CONSTRAINT exam_readiness_mapping_pkey PRIMARY KEY (owner_scope_id, mapping_set_id, objective_id, concept_id);


--
-- Name: exam_readiness_mapping_set exam_readiness_mapping_set_owner_scope_id_course_id_bluepri_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping_set
    ADD CONSTRAINT exam_readiness_mapping_set_owner_scope_id_course_id_bluepri_key UNIQUE (owner_scope_id, course_id, blueprint_id, mapping_set_version);


--
-- Name: exam_readiness_mapping_set exam_readiness_mapping_set_owner_scope_id_id_course_id_blue_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping_set
    ADD CONSTRAINT exam_readiness_mapping_set_owner_scope_id_id_course_id_blue_key UNIQUE (owner_scope_id, id, course_id, blueprint_id);


--
-- Name: exam_readiness_mapping_set exam_readiness_mapping_set_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping_set
    ADD CONSTRAINT exam_readiness_mapping_set_pkey PRIMARY KEY (owner_scope_id, id);


--
-- Name: exam_readiness_score exam_readiness_score_owner_scope_id_snapshot_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_score
    ADD CONSTRAINT exam_readiness_score_owner_scope_id_snapshot_digest_key UNIQUE (owner_scope_id, snapshot_digest);


--
-- Name: exam_readiness_score exam_readiness_score_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_score
    ADD CONSTRAINT exam_readiness_score_pkey PRIMARY KEY (owner_scope_id, id);


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
-- Name: grading_policy_binding grading_policy_binding_grading_policy_version_binding_diges_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_policy_binding
    ADD CONSTRAINT grading_policy_binding_grading_policy_version_binding_diges_key UNIQUE (grading_policy_version, binding_digest);


--
-- Name: grading_policy_binding grading_policy_binding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_policy_binding
    ADD CONSTRAINT grading_policy_binding_pkey PRIMARY KEY (grading_policy_version);


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
-- Name: rocketmq_redrive_audit rocketmq_redrive_audit_message_id_request_key_event_kind_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rocketmq_redrive_audit
    ADD CONSTRAINT rocketmq_redrive_audit_message_id_request_key_event_kind_at_key UNIQUE (message_id, request_key, event_kind, attempt_number);


--
-- Name: rocketmq_redrive_audit rocketmq_redrive_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rocketmq_redrive_audit
    ADD CONSTRAINT rocketmq_redrive_audit_pkey PRIMARY KEY (id);


--
-- Name: rocketmq_redrive_request rocketmq_redrive_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rocketmq_redrive_request
    ADD CONSTRAINT rocketmq_redrive_request_pkey PRIMARY KEY (message_id);


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
-- Name: activation_generation_operation_regeneration_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX activation_generation_operation_regeneration_ordinal ON public.activation_generation_operation USING btree (owner_scope_id, course_id, curriculum_generation_id, artifact_kind, chapter_id, concept_id, regeneration_ordinal) NULLS NOT DISTINCT WHERE (generation_version = 'activation-generation-v2'::text);


--
-- Name: activation_generation_operation_regeneration_request_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX activation_generation_operation_regeneration_request_key ON public.activation_generation_operation USING btree (owner_scope_id, request_idempotency_key) WHERE (request_idempotency_key IS NOT NULL);


--
-- Name: activation_generation_operation_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX activation_generation_operation_target_idx ON public.activation_generation_operation USING btree (owner_scope_id, course_id, curriculum_generation_id, artifact_kind, chapter_id, concept_id, generation_version, regeneration_ordinal) NULLS NOT DISTINCT;


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
-- Name: attempt_delivery_item_once_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX attempt_delivery_item_once_idx ON public.attempt USING btree (owner_scope_id, delivery_item_id) WHERE (delivery_item_id IS NOT NULL);


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
-- Name: curriculum_segment_operation_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_segment_operation_state_idx ON public.curriculum_segment_operation USING btree (owner_scope_id, parent_generation_id, state, segment_ordinal);


--
-- Name: delivery_override_projection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_override_projection_idx ON public.delivery_override USING btree (owner_scope_id, user_id, concept_id, created_at, id);


--
-- Name: demo_upload_generation_operation_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demo_upload_generation_operation_source_idx ON public.demo_upload_generation_operation USING btree (owner_scope_id, source_document_id);


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
-- Name: quiz_delivery_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quiz_delivery_expiry_idx ON public.quiz_delivery USING btree (expires_at, owner_scope_id) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text, 'submitted'::text]));


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
-- Name: rocketmq_redrive_audit_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rocketmq_redrive_audit_message_idx ON public.rocketmq_redrive_audit USING btree (message_id, occurred_at, id);


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
-- Name: assessment_finalization assessment_finalization_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assessment_finalization_is_append_only BEFORE DELETE OR UPDATE ON public.assessment_finalization FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: assessment_grading_operation assessment_grading_operation_identity_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assessment_grading_operation_identity_is_immutable BEFORE DELETE OR UPDATE ON public.assessment_grading_operation FOR EACH ROW EXECUTE FUNCTION public.reflo_protect_grading_operation();


--
-- Name: assessment_replacement_bundle assessment_replacement_bundle_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assessment_replacement_bundle_is_append_only BEFORE DELETE OR UPDATE ON public.assessment_replacement_bundle FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: assessment_replacement_item assessment_replacement_item_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assessment_replacement_item_is_append_only BEFORE DELETE OR UPDATE ON public.assessment_replacement_item FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: assessment_session_question assessment_session_question_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assessment_session_question_is_immutable BEFORE DELETE OR UPDATE ON public.assessment_session_question FOR EACH ROW EXECUTE FUNCTION public.reflo_protect_session_question();


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
-- Name: delivery_streak_day delivery_streak_day_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_streak_day_is_append_only BEFORE DELETE OR UPDATE ON public.delivery_streak_day FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: delivery_submission delivery_submission_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_submission_is_append_only BEFORE DELETE OR UPDATE ON public.delivery_submission FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


--
-- Name: exam_blueprint exam_blueprint_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exam_blueprint_is_immutable BEFORE DELETE OR UPDATE ON public.exam_blueprint FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_configuration_mutation();


--
-- Name: exam_blueprint exam_blueprint_objective_count_normalized; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER exam_blueprint_objective_count_normalized AFTER INSERT ON public.exam_blueprint DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_validate_exam_blueprint_objective_count();


--
-- Name: exam_blueprint_objective exam_blueprint_objective_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exam_blueprint_objective_is_immutable BEFORE DELETE OR UPDATE ON public.exam_blueprint_objective FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_configuration_mutation();


--
-- Name: exam_blueprint_objective exam_blueprint_objective_weights_normalized; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER exam_blueprint_objective_weights_normalized AFTER INSERT OR DELETE OR UPDATE ON public.exam_blueprint_objective DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_validate_exam_objective_weights();


--
-- Name: exam_readiness_calibration exam_readiness_calibration_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exam_readiness_calibration_is_immutable BEFORE DELETE OR UPDATE ON public.exam_readiness_calibration FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_configuration_mutation();


--
-- Name: exam_readiness_mapping exam_readiness_mapping_count_normalized; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER exam_readiness_mapping_count_normalized AFTER INSERT ON public.exam_readiness_mapping DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_validate_exam_mapping_count();


--
-- Name: exam_readiness_mapping exam_readiness_mapping_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exam_readiness_mapping_is_immutable BEFORE DELETE OR UPDATE ON public.exam_readiness_mapping FOR EACH ROW EXECUTE FUNCTION public.reflo_protect_exam_readiness_scoped_record();


--
-- Name: exam_readiness_mapping_set exam_readiness_mapping_set_count_normalized; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER exam_readiness_mapping_set_count_normalized AFTER INSERT ON public.exam_readiness_mapping_set DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_validate_exam_mapping_set_count();


--
-- Name: exam_readiness_mapping_set exam_readiness_mapping_set_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exam_readiness_mapping_set_is_immutable BEFORE DELETE OR UPDATE ON public.exam_readiness_mapping_set FOR EACH ROW EXECUTE FUNCTION public.reflo_protect_exam_readiness_scoped_record();


--
-- Name: exam_readiness_mapping exam_readiness_mapping_weights_normalized; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER exam_readiness_mapping_weights_normalized AFTER INSERT OR DELETE OR UPDATE ON public.exam_readiness_mapping DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reflo_validate_exam_mapping_weights();


--
-- Name: exam_readiness_score exam_readiness_score_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exam_readiness_score_is_append_only BEFORE DELETE OR UPDATE ON public.exam_readiness_score FOR EACH ROW EXECUTE FUNCTION public.reflo_protect_exam_readiness_scoped_record();


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
-- Name: grading_policy_binding grading_policy_binding_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grading_policy_binding_is_immutable BEFORE DELETE OR UPDATE ON public.grading_policy_binding FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_configuration_mutation();


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
-- Name: rocketmq_redrive_audit rocketmq_redrive_audit_is_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rocketmq_redrive_audit_is_append_only BEFORE DELETE OR UPDATE ON public.rocketmq_redrive_audit FOR EACH ROW EXECUTE FUNCTION public.reflo_reject_append_only_mutation();


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
-- Name: activation_generation_operation activation_generation_operation_parent_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_generation_operation
    ADD CONSTRAINT activation_generation_operation_parent_operation_id_fkey FOREIGN KEY (parent_operation_id) REFERENCES public.activation_generation_operation(id);


--
-- Name: assessment_finalization assessment_finalization_grading_policy_version_policy_bind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_finalization
    ADD CONSTRAINT assessment_finalization_grading_policy_version_policy_bind_fkey FOREIGN KEY (grading_policy_version, policy_binding_digest) REFERENCES public.grading_policy_binding(grading_policy_version, binding_digest);


--
-- Name: assessment_finalization assessment_finalization_owner_scope_id_attempt_id_user_id__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_finalization
    ADD CONSTRAINT assessment_finalization_owner_scope_id_attempt_id_user_id__fkey FOREIGN KEY (owner_scope_id, attempt_id, user_id, attempt_outcome) REFERENCES public.attempt(owner_scope_id, id, user_id, outcome);


--
-- Name: assessment_finalization assessment_finalization_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_finalization
    ADD CONSTRAINT assessment_finalization_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: assessment_grading_operation assessment_grading_operation_grading_policy_version_policy_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_grading_operation
    ADD CONSTRAINT assessment_grading_operation_grading_policy_version_policy_fkey FOREIGN KEY (grading_policy_version, policy_binding_digest) REFERENCES public.grading_policy_binding(grading_policy_version, binding_digest);


--
-- Name: assessment_grading_operation assessment_grading_operation_owner_scope_id_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_grading_operation
    ADD CONSTRAINT assessment_grading_operation_owner_scope_id_question_id_fkey FOREIGN KEY (owner_scope_id, question_id) REFERENCES public.quiz_item(owner_scope_id, id);


--
-- Name: assessment_grading_operation assessment_grading_operation_owner_scope_id_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_grading_operation
    ADD CONSTRAINT assessment_grading_operation_owner_scope_id_session_id_fkey FOREIGN KEY (owner_scope_id, session_id) REFERENCES public.study_session(owner_scope_id, id);


--
-- Name: assessment_grading_operation assessment_grading_operation_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_grading_operation
    ADD CONSTRAINT assessment_grading_operation_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: assessment_replacement_bundle assessment_replacement_bundle_owner_scope_id_original_atte_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_bundle
    ADD CONSTRAINT assessment_replacement_bundle_owner_scope_id_original_atte_fkey FOREIGN KEY (owner_scope_id, original_attempt_id) REFERENCES public.attempt(owner_scope_id, id);


--
-- Name: assessment_replacement_item assessment_replacement_item_owner_scope_id_bundle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_item
    ADD CONSTRAINT assessment_replacement_item_owner_scope_id_bundle_id_fkey FOREIGN KEY (owner_scope_id, bundle_id) REFERENCES public.assessment_replacement_bundle(owner_scope_id, id);


--
-- Name: assessment_replacement_item assessment_replacement_item_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_item
    ADD CONSTRAINT assessment_replacement_item_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: assessment_replacement_item assessment_replacement_item_owner_scope_id_quiz_item_id_co_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_replacement_item
    ADD CONSTRAINT assessment_replacement_item_owner_scope_id_quiz_item_id_co_fkey FOREIGN KEY (owner_scope_id, quiz_item_id, concept_id) REFERENCES public.quiz_item_concept(owner_scope_id, quiz_item_id, concept_id);


--
-- Name: assessment_session_question assessment_session_question_owner_scope_id_operation_idemp_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_session_question
    ADD CONSTRAINT assessment_session_question_owner_scope_id_operation_idemp_fkey FOREIGN KEY (owner_scope_id, operation_idempotency_key) REFERENCES public.assessment_grading_operation(owner_scope_id, idempotency_key);


--
-- Name: assessment_session_question assessment_session_question_owner_scope_id_quiz_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_session_question
    ADD CONSTRAINT assessment_session_question_owner_scope_id_quiz_item_id_fkey FOREIGN KEY (owner_scope_id, quiz_item_id) REFERENCES public.quiz_item(owner_scope_id, id);


--
-- Name: assessment_session_question assessment_session_question_owner_scope_id_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_session_question
    ADD CONSTRAINT assessment_session_question_owner_scope_id_session_id_fkey FOREIGN KEY (owner_scope_id, session_id) REFERENCES public.study_session(owner_scope_id, id);


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
-- Name: asset asset_reteach_session_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_reteach_session_scope_fk FOREIGN KEY (owner_scope_id, reteach_session_id) REFERENCES public.study_session(owner_scope_id, id);


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
-- Name: attempt attempt_replacement_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt
    ADD CONSTRAINT attempt_replacement_scope_fk FOREIGN KEY (owner_scope_id, replacement_for_attempt_id) REFERENCES public.attempt(owner_scope_id, id);


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
-- Name: course course_target_exam_blueprint_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course
    ADD CONSTRAINT course_target_exam_blueprint_fk FOREIGN KEY (target_exam_blueprint_id) REFERENCES public.exam_blueprint(id);


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
-- Name: curriculum_partition_manifest curriculum_partition_manifest_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_partition_manifest
    ADD CONSTRAINT curriculum_partition_manifest_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: curriculum_partition_manifest curriculum_partition_manifest_owner_scope_id_embedding_gen_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_partition_manifest
    ADD CONSTRAINT curriculum_partition_manifest_owner_scope_id_embedding_gen_fkey FOREIGN KEY (owner_scope_id, embedding_generation_id) REFERENCES public.source_embedding_generation(owner_scope_id, id);


--
-- Name: curriculum_partition_manifest curriculum_partition_manifest_owner_scope_id_source_docume_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_partition_manifest
    ADD CONSTRAINT curriculum_partition_manifest_owner_scope_id_source_docume_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


--
-- Name: curriculum_segment_operation curriculum_segment_operation_owner_scope_id_parent_generat_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_segment_operation
    ADD CONSTRAINT curriculum_segment_operation_owner_scope_id_parent_generat_fkey FOREIGN KEY (owner_scope_id, parent_generation_id) REFERENCES public.curriculum_partition_manifest(owner_scope_id, id);


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
-- Name: delivery_preference delivery_preference_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_preference
    ADD CONSTRAINT delivery_preference_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id) ON DELETE CASCADE;


--
-- Name: delivery_streak_day delivery_streak_day_owner_scope_id_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_streak_day
    ADD CONSTRAINT delivery_streak_day_owner_scope_id_delivery_id_fkey FOREIGN KEY (owner_scope_id, delivery_id) REFERENCES public.quiz_delivery(owner_scope_id, id);


--
-- Name: delivery_streak_day delivery_streak_day_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_streak_day
    ADD CONSTRAINT delivery_streak_day_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: delivery_streak delivery_streak_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_streak
    ADD CONSTRAINT delivery_streak_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: delivery_submission delivery_submission_owner_scope_id_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_submission
    ADD CONSTRAINT delivery_submission_owner_scope_id_delivery_id_fkey FOREIGN KEY (owner_scope_id, delivery_id) REFERENCES public.quiz_delivery(owner_scope_id, id);


--
-- Name: delivery_submission delivery_submission_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_submission
    ADD CONSTRAINT delivery_submission_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: demo_upload_generation_operation demo_upload_generation_operat_owner_scope_id_requested_by__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_upload_generation_operation
    ADD CONSTRAINT demo_upload_generation_operat_owner_scope_id_requested_by__fkey FOREIGN KEY (owner_scope_id, requested_by_user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


--
-- Name: demo_upload_generation_operation demo_upload_generation_operat_owner_scope_id_source_docume_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_upload_generation_operation
    ADD CONSTRAINT demo_upload_generation_operat_owner_scope_id_source_docume_fkey FOREIGN KEY (owner_scope_id, source_document_id) REFERENCES public.source_document(owner_scope_id, id);


--
-- Name: demo_upload_generation_operation demo_upload_generation_operati_owner_scope_id_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_upload_generation_operation
    ADD CONSTRAINT demo_upload_generation_operati_owner_scope_id_operation_id_fkey FOREIGN KEY (owner_scope_id, operation_id) REFERENCES public.async_operation(owner_scope_id, id);


--
-- Name: demo_upload_generation_operation demo_upload_generation_operation_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_upload_generation_operation
    ADD CONSTRAINT demo_upload_generation_operation_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


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
-- Name: exam_blueprint_objective exam_blueprint_objective_blueprint_id_blueprint_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_blueprint_objective
    ADD CONSTRAINT exam_blueprint_objective_blueprint_id_blueprint_version_fkey FOREIGN KEY (blueprint_id, blueprint_version) REFERENCES public.exam_blueprint(id, version);


--
-- Name: exam_readiness_calibration exam_readiness_calibration_blueprint_id_blueprint_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_calibration
    ADD CONSTRAINT exam_readiness_calibration_blueprint_id_blueprint_version_fkey FOREIGN KEY (blueprint_id, blueprint_version) REFERENCES public.exam_blueprint(id, version);


--
-- Name: exam_readiness_mapping exam_readiness_mapping_blueprint_id_objective_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping
    ADD CONSTRAINT exam_readiness_mapping_blueprint_id_objective_id_fkey FOREIGN KEY (blueprint_id, objective_id) REFERENCES public.exam_blueprint_objective(blueprint_id, id);


--
-- Name: exam_readiness_mapping exam_readiness_mapping_owner_scope_id_concept_id_concept_g_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping
    ADD CONSTRAINT exam_readiness_mapping_owner_scope_id_concept_id_concept_g_fkey FOREIGN KEY (owner_scope_id, concept_id, concept_generation_id, concept_generation_version) REFERENCES public.concept(owner_scope_id, id, curriculum_generation_id, generation_version);


--
-- Name: exam_readiness_mapping exam_readiness_mapping_owner_scope_id_course_id_concept_ge_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping
    ADD CONSTRAINT exam_readiness_mapping_owner_scope_id_course_id_concept_ge_fkey FOREIGN KEY (owner_scope_id, course_id, concept_generation_id) REFERENCES public.curriculum_generation(owner_scope_id, course_id, id);


--
-- Name: exam_readiness_mapping exam_readiness_mapping_owner_scope_id_mapping_set_id_cours_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping
    ADD CONSTRAINT exam_readiness_mapping_owner_scope_id_mapping_set_id_cours_fkey FOREIGN KEY (owner_scope_id, mapping_set_id, course_id, blueprint_id) REFERENCES public.exam_readiness_mapping_set(owner_scope_id, id, course_id, blueprint_id);


--
-- Name: exam_readiness_mapping_set exam_readiness_mapping_set_blueprint_id_blueprint_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping_set
    ADD CONSTRAINT exam_readiness_mapping_set_blueprint_id_blueprint_version_fkey FOREIGN KEY (blueprint_id, blueprint_version) REFERENCES public.exam_blueprint(id, version);


--
-- Name: exam_readiness_mapping_set exam_readiness_mapping_set_owner_scope_id_course_id_bluepr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_mapping_set
    ADD CONSTRAINT exam_readiness_mapping_set_owner_scope_id_course_id_bluepr_fkey FOREIGN KEY (owner_scope_id, course_id, blueprint_id) REFERENCES public.course(owner_scope_id, id, target_exam_blueprint_id);


--
-- Name: exam_readiness_score exam_readiness_score_blueprint_id_blueprint_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_score
    ADD CONSTRAINT exam_readiness_score_blueprint_id_blueprint_version_fkey FOREIGN KEY (blueprint_id, blueprint_version) REFERENCES public.exam_blueprint(id, version);


--
-- Name: exam_readiness_score exam_readiness_score_calibration_id_blueprint_id_calibrati_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_score
    ADD CONSTRAINT exam_readiness_score_calibration_id_blueprint_id_calibrati_fkey FOREIGN KEY (calibration_id, blueprint_id, calibration_version) REFERENCES public.exam_readiness_calibration(id, blueprint_id, version);


--
-- Name: exam_readiness_score exam_readiness_score_owner_scope_id_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_score
    ADD CONSTRAINT exam_readiness_score_owner_scope_id_course_id_fkey FOREIGN KEY (owner_scope_id, course_id) REFERENCES public.course(owner_scope_id, id);


--
-- Name: exam_readiness_score exam_readiness_score_owner_scope_id_mapping_set_id_course__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_score
    ADD CONSTRAINT exam_readiness_score_owner_scope_id_mapping_set_id_course__fkey FOREIGN KEY (owner_scope_id, mapping_set_id, course_id, blueprint_id) REFERENCES public.exam_readiness_mapping_set(owner_scope_id, id, course_id, blueprint_id);


--
-- Name: exam_readiness_score exam_readiness_score_owner_scope_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_readiness_score
    ADD CONSTRAINT exam_readiness_score_owner_scope_id_user_id_fkey FOREIGN KEY (owner_scope_id, user_id) REFERENCES public.scope_membership(owner_scope_id, user_id);


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
-- Name: rocketmq_redrive_audit rocketmq_redrive_audit_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rocketmq_redrive_audit
    ADD CONSTRAINT rocketmq_redrive_audit_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.outbox_message(message_id);


--
-- Name: rocketmq_redrive_request rocketmq_redrive_request_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rocketmq_redrive_request
    ADD CONSTRAINT rocketmq_redrive_request_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.outbox_message(message_id);


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
-- Name: assessment_finalization; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assessment_finalization ENABLE ROW LEVEL SECURITY;

--
-- Name: assessment_grading_operation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assessment_grading_operation ENABLE ROW LEVEL SECURITY;

--
-- Name: assessment_replacement_bundle; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assessment_replacement_bundle ENABLE ROW LEVEL SECURITY;

--
-- Name: assessment_replacement_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assessment_replacement_item ENABLE ROW LEVEL SECURITY;

--
-- Name: assessment_session_question; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assessment_session_question ENABLE ROW LEVEL SECURITY;

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
-- Name: assessment_finalization authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.assessment_finalization FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: assessment_grading_operation authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.assessment_grading_operation FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: assessment_replacement_bundle authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.assessment_replacement_bundle FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: assessment_replacement_item authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.assessment_replacement_item FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: assessment_session_question authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.assessment_session_question FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


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
-- Name: delivery_streak authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.delivery_streak FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: delivery_streak_day authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.delivery_streak_day FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: delivery_submission authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.delivery_submission FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: exam_readiness_mapping authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.exam_readiness_mapping FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: exam_readiness_mapping_set authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.exam_readiness_mapping_set FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


--
-- Name: exam_readiness_score authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.exam_readiness_score FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


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
-- Name: quiz_delivery authorized_learning_scope_reset; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorized_learning_scope_reset ON public.quiz_delivery FOR DELETE USING (public.reflo_learning_scope_delete_is_authorized(owner_scope_id));


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
-- Name: curriculum_partition_manifest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.curriculum_partition_manifest ENABLE ROW LEVEL SECURITY;

--
-- Name: curriculum_partition_manifest curriculum_partition_manifest_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY curriculum_partition_manifest_active_membership ON public.curriculum_partition_manifest USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: curriculum_segment_operation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.curriculum_segment_operation ENABLE ROW LEVEL SECURITY;

--
-- Name: curriculum_segment_operation curriculum_segment_operation_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY curriculum_segment_operation_active_membership ON public.curriculum_segment_operation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


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
-- Name: delivery_preference; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_preference ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_streak; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_streak ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_streak_day; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_streak_day ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_submission; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_submission ENABLE ROW LEVEL SECURITY;

--
-- Name: demo_upload_generation_operation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.demo_upload_generation_operation ENABLE ROW LEVEL SECURITY;

--
-- Name: demo_upload_generation_operation demo_upload_generation_operation_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY demo_upload_generation_operation_active_membership ON public.demo_upload_generation_operation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: exam_readiness_mapping; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exam_readiness_mapping ENABLE ROW LEVEL SECURITY;

--
-- Name: exam_readiness_mapping_set; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exam_readiness_mapping_set ENABLE ROW LEVEL SECURITY;

--
-- Name: exam_readiness_score; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exam_readiness_score ENABLE ROW LEVEL SECURITY;

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
-- Name: assessment_finalization scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.assessment_finalization USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: assessment_grading_operation scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.assessment_grading_operation USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: assessment_replacement_bundle scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.assessment_replacement_bundle USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: assessment_replacement_item scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.assessment_replacement_item USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: assessment_session_question scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.assessment_session_question USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


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
-- Name: delivery_preference scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.delivery_preference USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: delivery_streak scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.delivery_streak USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: delivery_streak_day scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.delivery_streak_day USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: delivery_submission scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.delivery_submission USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: exam_readiness_mapping scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.exam_readiness_mapping USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: exam_readiness_mapping_set scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.exam_readiness_mapping_set USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


--
-- Name: exam_readiness_score scoped_active_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scoped_active_membership ON public.exam_readiness_score USING (public.reflo_has_active_membership(owner_scope_id)) WITH CHECK (public.reflo_has_active_membership(owner_scope_id));


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
    ('20260723000200'),
    ('20260724000100'),
    ('20260724000200'),
    ('20260724000300'),
    ('20260726000100'),
    ('20260727000100'),
    ('20260727000200'),
    ('20260727000300'),
    ('20260728000100'),
    ('20260730000100'),
    ('20260731000100'),
    ('20260801000100'),
    ('20260801000200'),
    ('20260801000300'),
    ('20260803000100');
