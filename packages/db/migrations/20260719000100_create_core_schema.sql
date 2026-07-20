-- migrate:up

CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  email_lookup_digest bytea NOT NULL UNIQUE,
  email_ciphertext bytea NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deletion_pending')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_login_token (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES app_user(id),
  email_lookup_digest bytea NOT NULL,
  token_digest bytea NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('login', 'step_up')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '10 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= issued_at)
);

CREATE INDEX auth_login_token_identity_idx
  ON auth_login_token (email_lookup_digest, purpose, issued_at DESC);

CREATE TABLE auth_session (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id),
  session_digest bytea NOT NULL UNIQUE,
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (idle_expires_at <= last_seen_at + interval '7 days'),
  CHECK (absolute_expires_at <= created_at + interval '30 days'),
  CHECK (last_seen_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX auth_session_user_active_idx
  ON auth_session (user_id, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE owner_scope (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL DEFAULT 'user' CHECK (scope_type = 'user'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (id, scope_type),
  CHECK ((status = 'active' AND retired_at IS NULL) OR (status = 'retired' AND retired_at IS NOT NULL))
);

CREATE TABLE scope_membership (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL REFERENCES owner_scope(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  role text NOT NULL DEFAULT 'owner' CHECK (role = 'owner'),
  active_from timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, user_id),
  CHECK (revoked_at IS NULL OR revoked_at >= active_from)
);

CREATE UNIQUE INDEX scope_membership_one_active_owner_idx
  ON scope_membership (owner_scope_id)
  WHERE role = 'owner' AND revoked_at IS NULL;

CREATE FUNCTION reflo_context_actor_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('reflo.actor_id', true), '')::uuid
$$;

CREATE FUNCTION reflo_context_owner_scope_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('reflo.owner_scope_id', true), '')::uuid
$$;

CREATE FUNCTION reflo_has_active_membership(candidate_scope_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
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

CREATE FUNCTION reflo_assert_personal_scope_owner(candidate_scope_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
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

CREATE FUNCTION reflo_check_scope_owner_from_scope() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM reflo_assert_personal_scope_owner(NEW.id);
  RETURN NULL;
END
$$;

CREATE FUNCTION reflo_check_scope_owner_from_membership() RETURNS trigger
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

CREATE CONSTRAINT TRIGGER owner_scope_requires_owner
AFTER INSERT OR UPDATE OF status, retired_at ON owner_scope
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reflo_check_scope_owner_from_scope();

CREATE CONSTRAINT TRIGGER membership_preserves_scope_owner
AFTER INSERT OR UPDATE OR DELETE ON scope_membership
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reflo_check_scope_owner_from_membership();

CREATE FUNCTION reflo_create_personal_scope(new_scope_id uuid, new_membership_id uuid, owner_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_create_personal_scope(uuid, uuid, uuid) FROM PUBLIC;

CREATE TABLE source_document (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL REFERENCES owner_scope(id),
  object_key text NOT NULL,
  checksum text NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  page_count integer CHECK (page_count IS NULL OR page_count >= 0),
  parse_status text NOT NULL CHECK (parse_status IN ('quarantined', 'validating', 'queued', 'parsing', 'parsed', 'ocr_required', 'failed')),
  retention_status text NOT NULL DEFAULT 'active' CHECK (retention_status IN ('active', 'tombstoned', 'purged')),
  active_embedding_generation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, object_key)
);

CREATE TABLE source_span (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  canonical_text text NOT NULL,
  text_hash text NOT NULL,
  page_start integer,
  page_end integer,
  section_path text[] NOT NULL DEFAULT '{}',
  canonical_start integer NOT NULL CHECK (canonical_start >= 0),
  canonical_end integer NOT NULL CHECK (canonical_end > canonical_start),
  parser_version text NOT NULL,
  chunker_version text NOT NULL,
  tokenizer_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, source_document_id, text_hash, canonical_start, canonical_end),
  FOREIGN KEY (owner_scope_id, source_document_id)
    REFERENCES source_document(owner_scope_id, id),
  CHECK (page_start IS NULL OR page_start > 0),
  CHECK ((page_start IS NULL) = (page_end IS NULL)),
  CHECK (page_end IS NULL OR page_end >= page_start)
);

CREATE TABLE course (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('generating', 'ready', 'failed', 'archived')),
  target_exam_blueprint_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_document_id)
    REFERENCES source_document(owner_scope_id, id)
);

CREATE TABLE chapter (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  chapter_order integer NOT NULL CHECK (chapter_order > 0),
  title text NOT NULL,
  generation_status text NOT NULL DEFAULT 'pending' CHECK (generation_status IN ('pending', 'generating', 'ready', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, course_id, chapter_order),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id)
);

CREATE TABLE concept (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  chapter_id uuid NOT NULL,
  name text NOT NULL,
  generation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, chapter_id, name),
  FOREIGN KEY (owner_scope_id, chapter_id)
    REFERENCES chapter(owner_scope_id, id)
);

CREATE TABLE concept_prerequisite (
  owner_scope_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  prerequisite_concept_id uuid NOT NULL,
  PRIMARY KEY (owner_scope_id, concept_id, prerequisite_concept_id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, prerequisite_concept_id)
    REFERENCES concept(owner_scope_id, id),
  CHECK (concept_id <> prerequisite_concept_id)
);

CREATE TABLE chapter_source_span (
  owner_scope_id uuid NOT NULL,
  chapter_id uuid NOT NULL,
  source_span_id uuid NOT NULL,
  span_order integer NOT NULL CHECK (span_order >= 0),
  PRIMARY KEY (owner_scope_id, chapter_id, source_span_id),
  UNIQUE (owner_scope_id, chapter_id, span_order),
  FOREIGN KEY (owner_scope_id, chapter_id)
    REFERENCES chapter(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_span_id)
    REFERENCES source_span(owner_scope_id, id)
);

CREATE TABLE concept_source_span (
  owner_scope_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  source_span_id uuid NOT NULL,
  PRIMARY KEY (owner_scope_id, concept_id, source_span_id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_span_id)
    REFERENCES source_span(owner_scope_id, id)
);

CREATE TABLE asset (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  chapter_id uuid,
  concept_id uuid,
  asset_type text NOT NULL CHECK (asset_type IN ('audio', 'video', 'text')),
  object_key text,
  model_id text,
  prompt_id text,
  generation_version text NOT NULL,
  strategy_tag text,
  status text NOT NULL CHECK (status IN ('pending', 'generating', 'ready', 'failed', 'tombstoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, object_key),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, chapter_id)
    REFERENCES chapter(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id),
  CHECK (status <> 'ready' OR object_key IS NOT NULL)
);

CREATE TABLE asset_source_span (
  owner_scope_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  source_span_id uuid NOT NULL,
  PRIMARY KEY (owner_scope_id, asset_id, source_span_id),
  FOREIGN KEY (owner_scope_id, asset_id)
    REFERENCES asset(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_span_id)
    REFERENCES source_span(owner_scope_id, id)
);

CREATE TABLE quiz_item (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  course_id uuid NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('multiple_choice', 'short_answer', 'concept_linking')),
  difficulty smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  prompt text NOT NULL,
  keyed_answer jsonb NOT NULL,
  rubric jsonb,
  version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id)
);

CREATE TABLE quiz_item_concept (
  owner_scope_id uuid NOT NULL,
  quiz_item_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  PRIMARY KEY (owner_scope_id, quiz_item_id, concept_id),
  FOREIGN KEY (owner_scope_id, quiz_item_id)
    REFERENCES quiz_item(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id)
);

CREATE TABLE quiz_item_source_span (
  owner_scope_id uuid NOT NULL,
  quiz_item_id uuid NOT NULL,
  source_span_id uuid NOT NULL,
  PRIMARY KEY (owner_scope_id, quiz_item_id, source_span_id),
  FOREIGN KEY (owner_scope_id, quiz_item_id)
    REFERENCES quiz_item(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, source_span_id)
    REFERENCES source_span(owner_scope_id, id)
);

CREATE TABLE study_session (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  course_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
  plan jsonb NOT NULL DEFAULT '{}',
  summary jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, course_id)
    REFERENCES course(owner_scope_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE review_schedule (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  time_zone text NOT NULL,
  fsrs_version text NOT NULL,
  state jsonb NOT NULL,
  reschedule_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id)
);

CREATE INDEX review_schedule_due_idx
  ON review_schedule (due_at, owner_scope_id)
  WHERE reschedule_reason IS NULL;

CREATE TABLE channel_identity (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('telegram', 'email', 'whatsapp')),
  encrypted_external_id bytea NOT NULL,
  external_id_lookup_digest bytea NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, id, provider),
  UNIQUE (provider, external_id_lookup_digest),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  CHECK (revoked_at IS NULL OR verified_at IS NULL OR revoked_at >= verified_at)
);

CREATE TABLE quiz_delivery (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  channel_identity_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('telegram', 'email', 'whatsapp')),
  provider_message_id text,
  idempotency_key text,
  status text NOT NULL CHECK (status IN ('pending', 'submitted', 'delivered', 'failed', 'expired', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  expires_at timestamptz NOT NULL,
  sanitized_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, channel_identity_id, provider)
    REFERENCES channel_identity(owner_scope_id, id, provider)
);

CREATE UNIQUE INDEX quiz_delivery_provider_message_idx
  ON quiz_delivery (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX quiz_delivery_provider_idempotency_idx
  ON quiz_delivery (provider, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE delivery_item (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  review_schedule_id uuid NOT NULL,
  quiz_item_id uuid NOT NULL,
  item_order smallint NOT NULL CHECK (item_order BETWEEN 1 AND 3),
  UNIQUE (owner_scope_id, id),
  UNIQUE (owner_scope_id, delivery_id, review_schedule_id),
  UNIQUE (owner_scope_id, delivery_id, item_order),
  FOREIGN KEY (owner_scope_id, delivery_id)
    REFERENCES quiz_delivery(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, review_schedule_id)
    REFERENCES review_schedule(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, quiz_item_id)
    REFERENCES quiz_item(owner_scope_id, id)
);

CREATE TABLE attempt (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid,
  delivery_item_id uuid,
  provider text CHECK (provider IN ('telegram', 'email', 'whatsapp')),
  provider_submission_id text,
  submission_idempotency_key text,
  quiz_item_id uuid NOT NULL,
  answer jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('graded', 'abstained', 'superseded')),
  overall_grade numeric(6, 5),
  grading_confidence numeric(6, 5),
  grader_provenance jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, session_id)
    REFERENCES study_session(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, delivery_item_id)
    REFERENCES delivery_item(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, quiz_item_id)
    REFERENCES quiz_item(owner_scope_id, id),
  CHECK (session_id IS NOT NULL OR delivery_item_id IS NOT NULL),
  CHECK ((provider IS NULL) = (provider_submission_id IS NULL)),
  CHECK (overall_grade IS NULL OR overall_grade BETWEEN 0 AND 1),
  CHECK (grading_confidence IS NULL OR grading_confidence BETWEEN 0 AND 1)
);

CREATE UNIQUE INDEX attempt_provider_submission_idx
  ON attempt (provider, provider_submission_id)
  WHERE provider_submission_id IS NOT NULL;

CREATE UNIQUE INDEX attempt_submission_idempotency_idx
  ON attempt (submission_idempotency_key)
  WHERE submission_idempotency_key IS NOT NULL;

CREATE TABLE attempt_concept_evidence (
  owner_scope_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  score numeric(6, 5) NOT NULL CHECK (score BETWEEN 0 AND 1),
  rubric_band text NOT NULL,
  confidence numeric(6, 5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale_ref text,
  knowledge_algorithm_version text NOT NULL,
  eligible_for_mastery boolean NOT NULL,
  PRIMARY KEY (owner_scope_id, attempt_id, concept_id),
  FOREIGN KEY (owner_scope_id, attempt_id)
    REFERENCES attempt(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id)
);

CREATE TABLE learning_event (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid,
  delivery_id uuid,
  event_type text NOT NULL,
  idempotency_key text,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, session_id)
    REFERENCES study_session(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, delivery_id)
    REFERENCES quiz_delivery(owner_scope_id, id)
);

CREATE UNIQUE INDEX learning_event_idempotency_idx
  ON learning_event (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE learning_event_concept (
  owner_scope_id uuid NOT NULL,
  learning_event_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  PRIMARY KEY (owner_scope_id, learning_event_id, concept_id),
  FOREIGN KEY (owner_scope_id, learning_event_id)
    REFERENCES learning_event(owner_scope_id, id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id)
);

CREATE TABLE knowledge_state (
  owner_scope_id uuid NOT NULL,
  user_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  mastery numeric(6, 5) NOT NULL CHECK (mastery BETWEEN 0 AND 1),
  confidence numeric(6, 5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  half_life interval NOT NULL CHECK (half_life > interval '0 seconds'),
  last_reviewed_at timestamptz,
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  algorithm_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, user_id, concept_id),
  FOREIGN KEY (owner_scope_id, user_id)
    REFERENCES scope_membership(owner_scope_id, user_id),
  FOREIGN KEY (owner_scope_id, concept_id)
    REFERENCES concept(owner_scope_id, id)
);

CREATE TABLE async_operation (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL REFERENCES owner_scope(id),
  operation_name text NOT NULL,
  operation_version integer NOT NULL CHECK (operation_version > 0),
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('queued', 'processing', 'retry_scheduled', 'succeeded', 'failed_permanent', 'cancelled', 'expired')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sanitized_failure jsonb,
  result_ref jsonb,
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_scope_id, id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state IN ('succeeded', 'failed_permanent', 'cancelled', 'expired')) = (completed_at IS NOT NULL))
);

CREATE TABLE async_operation_attempt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  delivery_number integer NOT NULL CHECK (delivery_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('started', 'retry_scheduled', 'succeeded', 'failed_permanent', 'cancelled', 'expired')),
  normalized_failure_class text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (owner_scope_id, operation_id, delivery_number),
  FOREIGN KEY (owner_scope_id, operation_id)
    REFERENCES async_operation(owner_scope_id, id),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE outbox_message (
  message_id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL,
  operation_id uuid,
  message_kind text NOT NULL CHECK (message_kind IN ('command', 'event')),
  message_name text NOT NULL,
  message_version integer NOT NULL CHECK (message_version > 0),
  producer text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'pilot')),
  correlation_id uuid NOT NULL,
  causation_id uuid,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  deadline_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_scope_id, message_id),
  FOREIGN KEY (owner_scope_id, operation_id)
    REFERENCES async_operation(owner_scope_id, id),
  CHECK (deadline_at IS NULL OR deadline_at > occurred_at)
);

CREATE INDEX outbox_message_unpublished_idx
  ON outbox_message (created_at, message_id)
  WHERE published_at IS NULL;

CREATE TABLE inbox_claim (
  idempotency_key text PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE,
  owner_scope_id uuid NOT NULL REFERENCES owner_scope(id),
  state text NOT NULL CHECK (state IN ('processing', 'succeeded', 'failed_permanent', 'cancelled', 'expired')),
  lease_owner text,
  lease_expires_at timestamptz,
  stored_outcome jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state IN ('succeeded', 'failed_permanent', 'cancelled', 'expired')) = (finalized_at IS NOT NULL))
);

CREATE FUNCTION reflo_preserve_terminal_row() RETURNS trigger
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

CREATE TRIGGER async_operation_terminal_is_final
BEFORE UPDATE ON async_operation
FOR EACH ROW EXECUTE FUNCTION reflo_preserve_terminal_row();

CREATE TRIGGER inbox_claim_terminal_is_final
BEFORE UPDATE ON inbox_claim
FOR EACH ROW EXECUTE FUNCTION reflo_preserve_terminal_row();

ALTER TABLE owner_scope ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_scope_active_membership ON owner_scope
  USING (reflo_has_active_membership(id))
  WITH CHECK (reflo_has_active_membership(id));

ALTER TABLE scope_membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope_membership_active_membership ON scope_membership
  USING (reflo_has_active_membership(owner_scope_id))
  WITH CHECK (reflo_has_active_membership(owner_scope_id));

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'source_document', 'source_span', 'course', 'chapter', 'concept',
    'concept_prerequisite', 'chapter_source_span', 'concept_source_span',
    'asset', 'asset_source_span', 'quiz_item', 'quiz_item_concept',
    'quiz_item_source_span', 'study_session', 'review_schedule',
    'channel_identity', 'quiz_delivery', 'delivery_item', 'attempt',
    'knowledge_state',
    'async_operation', 'async_operation_attempt', 'outbox_message', 'inbox_claim'
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

ALTER TABLE learning_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_event FORCE ROW LEVEL SECURITY;
CREATE POLICY learning_event_select ON learning_event
  FOR SELECT USING (reflo_has_active_membership(owner_scope_id));
CREATE POLICY learning_event_insert ON learning_event
  FOR INSERT WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE learning_event_concept ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_event_concept FORCE ROW LEVEL SECURITY;
CREATE POLICY learning_event_concept_select ON learning_event_concept
  FOR SELECT USING (reflo_has_active_membership(owner_scope_id));
CREATE POLICY learning_event_concept_insert ON learning_event_concept
  FOR INSERT WITH CHECK (reflo_has_active_membership(owner_scope_id));

ALTER TABLE attempt_concept_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempt_concept_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY attempt_concept_evidence_select ON attempt_concept_evidence
  FOR SELECT USING (reflo_has_active_membership(owner_scope_id));
CREATE POLICY attempt_concept_evidence_insert ON attempt_concept_evidence
  FOR INSERT WITH CHECK (reflo_has_active_membership(owner_scope_id));

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
