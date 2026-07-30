-- migrate:up

ALTER TABLE outbox_message
  ADD COLUMN relay_lease_owner text,
  ADD COLUMN relay_lease_expires_at timestamptz,
  ADD COLUMN publish_attempt_count integer NOT NULL DEFAULT 0 CHECK (
    publish_attempt_count >= 0
  ),
  ADD COLUMN last_publish_failure_class text,
  ADD CONSTRAINT outbox_message_relay_lease_shape CHECK (
    (relay_lease_owner IS NULL) = (relay_lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT outbox_message_published_relay_shape CHECK (
    published_at IS NULL
    OR (relay_lease_owner IS NULL AND relay_lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT outbox_message_publish_failure_shape CHECK (
    last_publish_failure_class IS NULL
    OR last_publish_failure_class IN (
      'broker_unavailable',
      'invalid_receipt',
      'publication_timeout',
      'publisher_shutdown',
      'throttled',
      'unknown_transient'
    )
  );

DROP INDEX outbox_message_unpublished_idx;
CREATE INDEX outbox_message_unpublished_idx
  ON outbox_message (priority, created_at, message_id)
  WHERE published_at IS NULL;

CREATE TABLE rocketmq_redrive_request (
  message_id uuid PRIMARY KEY REFERENCES outbox_message(message_id),
  request_key uuid NOT NULL,
  reason_code text NOT NULL CHECK (
    reason_code IN (
      'configuration_repaired',
      'provider_recovered',
      'transient_dependency_recovered'
    )
  ),
  state text NOT NULL CHECK (
    state IN ('authorized', 'published', 'rejected')
  ),
  lease_owner text,
  lease_expires_at timestamptz,
  publication_attempt_count integer NOT NULL DEFAULT 0 CHECK (
    publication_attempt_count >= 0
  ),
  normalized_failure_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (state = 'authorized' AND finalized_at IS NULL)
    OR (
      state IN ('published', 'rejected')
      AND finalized_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK (
    normalized_failure_class IS NULL
    OR normalized_failure_class IN (
      'authorization_denied',
      'broker_unavailable',
      'changed_intent',
      'deleted_scope',
      'expired',
      'invalid_receipt',
      'invalid_wrapper',
      'publication_timeout',
      'publisher_shutdown',
      'state_conflict',
      'unsupported_contract'
    )
  )
);

CREATE TABLE rocketmq_redrive_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES outbox_message(message_id),
  request_key uuid NOT NULL,
  event_kind text NOT NULL CHECK (
    event_kind IN (
      'authorized',
      'publication_attempted',
      'publication_failed',
      'published',
      'rejected'
    )
  ),
  reason_code text NOT NULL CHECK (
    reason_code IN (
      'configuration_repaired',
      'provider_recovered',
      'transient_dependency_recovered'
    )
  ),
  attempt_number integer NOT NULL CHECK (attempt_number >= 0),
  normalized_failure_class text,
  occurred_at timestamptz NOT NULL,
  UNIQUE (message_id, request_key, event_kind, attempt_number),
  CHECK (
    normalized_failure_class IS NULL
    OR normalized_failure_class IN (
      'authorization_denied',
      'broker_unavailable',
      'changed_intent',
      'deleted_scope',
      'expired',
      'invalid_receipt',
      'invalid_wrapper',
      'publication_timeout',
      'publisher_shutdown',
      'state_conflict',
      'unsupported_contract'
    )
  )
);

CREATE INDEX rocketmq_redrive_audit_message_idx
  ON rocketmq_redrive_audit (message_id, occurred_at, id);

CREATE TRIGGER rocketmq_redrive_audit_is_append_only
BEFORE UPDATE OR DELETE ON rocketmq_redrive_audit
FOR EACH ROW EXECUTE FUNCTION reflo_reject_append_only_mutation();

CREATE FUNCTION reflo_claim_outbox_messages(
  candidate_lease_owner text,
  candidate_lease_expires_at timestamptz,
  candidate_batch_size integer,
  candidate_now timestamptz
)
RETURNS TABLE (
  message_id uuid,
  message_kind text,
  message_name text,
  message_version integer,
  producer text,
  environment text,
  correlation_id uuid,
  causation_id uuid,
  idempotency_key text,
  payload jsonb,
  occurred_at timestamptz,
  deadline_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
$$;

REVOKE ALL ON FUNCTION reflo_claim_outbox_messages(
  text, timestamptz, integer, timestamptz
) FROM PUBLIC;

CREATE FUNCTION reflo_mark_outbox_published(
  candidate_message_id uuid,
  candidate_lease_owner text,
  candidate_now timestamptz
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_mark_outbox_published(
  uuid, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION reflo_release_outbox_message(
  candidate_message_id uuid,
  candidate_lease_owner text,
  candidate_failure_class text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_release_outbox_message(
  uuid, text, text
) FROM PUBLIC;

CREATE FUNCTION reflo_inspect_audio_redrive(
  candidate_message_id uuid,
  candidate_now timestamptz
)
RETURNS TABLE (
  message_id uuid,
  message_kind text,
  message_name text,
  message_version integer,
  producer text,
  environment text,
  correlation_id uuid,
  causation_id uuid,
  idempotency_key text,
  payload jsonb,
  occurred_at timestamptz,
  deadline_at timestamptz,
  operation_state text,
  rejection_class text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_inspect_audio_redrive(
  uuid, timestamptz
) FROM PUBLIC;

CREATE FUNCTION reflo_claim_audio_redrive(
  candidate_message_id uuid,
  candidate_request_key uuid,
  candidate_reason_code text,
  candidate_lease_owner text,
  candidate_lease_expires_at timestamptz,
  candidate_now timestamptz
)
RETURNS TABLE (
  claim_outcome text,
  message_id uuid,
  message_kind text,
  message_name text,
  message_version integer,
  producer text,
  environment text,
  correlation_id uuid,
  causation_id uuid,
  idempotency_key text,
  payload jsonb,
  occurred_at timestamptz,
  deadline_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
$$;

REVOKE ALL ON FUNCTION reflo_claim_audio_redrive(
  uuid, uuid, text, text, timestamptz, timestamptz
) FROM PUBLIC;

CREATE FUNCTION reflo_mark_audio_redrive_published(
  candidate_message_id uuid,
  candidate_request_key uuid,
  candidate_lease_owner text,
  candidate_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_mark_audio_redrive_published(
  uuid, uuid, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION reflo_release_audio_redrive(
  candidate_message_id uuid,
  candidate_request_key uuid,
  candidate_lease_owner text,
  candidate_failure_class text,
  candidate_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_release_audio_redrive(
  uuid, uuid, text, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION reflo_reject_audio_redrive(
  candidate_message_id uuid,
  candidate_request_key uuid,
  candidate_reason_code text,
  candidate_failure_class text,
  candidate_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_reject_audio_redrive(
  uuid, uuid, text, text, timestamptz
) FROM PUBLIC;

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
