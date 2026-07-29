-- migrate:up

CREATE FUNCTION reflo_resolve_audio_authorization(
  candidate_course_id uuid,
  candidate_operation_id uuid
)
RETURNS TABLE (
  actor_id uuid,
  authorization_id uuid,
  owner_scope_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION reflo_resolve_audio_authorization(uuid, uuid)
FROM PUBLIC;

-- migrate:down
-- Forward-only by D-GH-3. Restore through a reviewed compensating migration.
