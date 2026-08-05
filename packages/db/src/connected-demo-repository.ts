import { randomUUID } from "node:crypto";

import { ACTIVATION_GENERATION_VERSION } from "@reflo/activation";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";
import { stableUuid } from "@reflo/retrieval";
import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  type AssessmentEvidenceWrite,
} from "@reflo/knowledge-model";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

export interface ConnectedDemoSessionSummary {
  readonly courseId: string;
  readonly sessionId: string;
  readonly status: "active" | "completed" | "abandoned";
  readonly summary: Readonly<Record<string, unknown>> | null;
}

export interface ConnectedDemoSeedResult {
  readonly conceptId: string;
  readonly courseId: string;
  readonly evidence: readonly AssessmentEvidenceWrite[];
  readonly sessionId: string;
}

export interface ConnectedStudySessionStartResult {
  readonly courseId: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly resumed: boolean;
  readonly sessionId: string;
  readonly status: "active";
}

export const ACTIVATION_PROGRESS_CONTRACT_VERSION =
  "activation-progress-v1" as const;

export interface ConnectedActivationProgress {
  readonly activationStatus: "failed" | "pending" | "ready" | "retrying";
  readonly artifact:
    "chapter_quiz" | "first_text_lesson" | "placement_quiz" | null;
  readonly assessmentStatus: "failed" | "pending" | "ready" | "retrying";
  readonly assessmentArtifact: {
    readonly artifactKind: "chapter_quiz" | "placement_quiz";
    readonly attemptCount: number;
    readonly failure: ConnectedActivationProgress["failure"];
    readonly maxAttempts: 5;
    readonly regenerationOrdinal: number;
    readonly stage: ConnectedActivationProgress["stage"];
    readonly status: "failed" | "pending" | "ready" | "retrying";
    readonly updatedAt: string;
  } | null;
  readonly attemptCount: number;
  readonly contractVersion: typeof ACTIVATION_PROGRESS_CONTRACT_VERSION;
  readonly failure: {
    readonly code:
      "generation_failed" | "generation_timed_out" | "generation_unavailable";
    readonly message: string;
  } | null;
  readonly maxAttempts: 5;
  readonly nextAction: "activation_failed" | "open_lesson" | "wait";
  readonly stage:
    | "awaiting_generation"
    | "failed"
    | "generating"
    | "ready"
    | "retry_scheduled";
  readonly updatedAt: string;
}

export interface ConnectedStudyLessonCompletion {
  readonly assetId: string;
  readonly conceptId: string;
  readonly idempotencyKey: string;
}

export interface ConnectedStudyLessonAssets {
  readonly media: {
    readonly assetId: string;
    readonly modality: "audio" | "video";
    readonly status: "preparing" | "ready" | "unavailable";
  } | null;
  readonly text: {
    readonly assetId: string;
    readonly contentHash: string;
    readonly objectKey: string;
    readonly servedAt: string;
    readonly strategyTag: string;
  } | null;
}

export interface ConnectedPrivateAsset {
  readonly assetId: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly contentType: string;
  readonly courseId: string;
  readonly etag: string;
  readonly objectKey: string;
  readonly ownerScopeId: string;
}

export class PostgresConnectedDemoRepository {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new Error("connected demo database configuration is unavailable");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async ping(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<{ ready: number }>(
        "SELECT 1::integer AS ready",
      );
      if (result.rows[0]?.ready !== 1) {
        throw new Error("connected demo database is unavailable");
      }
    } finally {
      client.release();
    }
  }

  async loadSessionSummary(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<ConnectedDemoSessionSummary | null> {
    validateAuthorization(authorization);
    if (!isUuid(sessionId)) {
      return null;
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query<{
        course_id: string;
        session_id: string;
        status: ConnectedDemoSessionSummary["status"];
        summary: Record<string, unknown> | null;
      }>(
        `SELECT session.id AS session_id, session.course_id, session.status,
                session.summary
         FROM study_session AS session
         JOIN app_user AS actor ON actor.id = $1
         JOIN owner_scope AS scope ON scope.id = session.owner_scope_id
         JOIN scope_membership AS membership
           ON membership.owner_scope_id = session.owner_scope_id
          AND membership.user_id = actor.id
         WHERE session.owner_scope_id = $2
           AND session.id = $3
           AND session.user_id = $1
           AND actor.status = 'active'
           AND scope.status = 'active'
           AND membership.role = 'owner'
           AND membership.revoked_at IS NULL`,
        [authorization.actorId, authorization.ownerScopeId, sessionId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const summary = await enrichSummaryConceptNames(
        client,
        authorization.ownerScopeId,
        row.course_id,
        row.summary,
      );
      return {
        courseId: row.course_id,
        sessionId: row.session_id,
        status: row.status,
        summary,
      };
    });
  }

  async loadActivationProgress(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<ConnectedActivationProgress | null> {
    validateAuthorization(authorization);
    if (!isUuid(sessionId)) {
      return null;
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const session = await client.query<{
        course_id: string;
        plan: Record<string, unknown>;
        started_at: Date;
      }>(
        `SELECT session.course_id, session.plan, session.started_at
         FROM study_session AS session
         JOIN course
           ON course.owner_scope_id = session.owner_scope_id
          AND course.id = session.course_id
         JOIN source_document AS source
           ON source.owner_scope_id = course.owner_scope_id
          AND source.id = course.source_document_id
         JOIN app_user AS actor ON actor.id = $1
         JOIN owner_scope AS scope ON scope.id = session.owner_scope_id
         JOIN scope_membership AS membership
           ON membership.owner_scope_id = session.owner_scope_id
          AND membership.user_id = actor.id
         WHERE session.owner_scope_id = $2
           AND session.id = $3
           AND session.user_id = $1
           AND session.status = 'active'
           AND source.retention_status = 'active'
           AND actor.status = 'active'
           AND scope.status = 'active'
           AND membership.role = 'owner'
           AND membership.revoked_at IS NULL`,
        [authorization.actorId, authorization.ownerScopeId, sessionId],
      );
      const authorizedSession = session.rows[0];
      if (authorizedSession === undefined) {
        return null;
      }

      const readiness = await loadAuthorizedStudyCourse(
        client,
        authorization,
        authorizedSession.course_id,
      );
      if (readiness === null) {
        return null;
      }
      const operations = await client.query<ActivationProgressOperationRow>(
        `SELECT artifact_kind, attempt_count, failure_class,
                regeneration_ordinal, status, updated_at
         FROM activation_generation_operation
         WHERE owner_scope_id = $1 AND course_id = $2
           AND generation_version = $3
         ORDER BY priority, regeneration_ordinal DESC, id`,
        [
          authorization.ownerScopeId,
          authorizedSession.course_id,
          ACTIVATION_GENERATION_VERSION,
        ],
      );
      return activationProgressView(
        readiness,
        authorizedSession.plan,
        authorizedSession.started_at,
        operations.rows,
      );
    });
  }

  async loadStudyLessonAssets(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
    conceptId: string,
  ): Promise<ConnectedStudyLessonAssets | null> {
    validateAuthorization(authorization);
    if (!isUuid(sessionId) || !isUuid(conceptId)) {
      return null;
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query<{
        media_asset_id: string | null;
        media_modality: "audio" | "video" | null;
        media_status:
          "failed" | "generating" | "pending" | "ready" | "tombstoned" | null;
        text_asset_id: string | null;
        text_content_hash: string | null;
        text_object_key: string | null;
        text_served_at: Date | null;
        text_strategy_tag: string | null;
      }>(
        `SELECT text_asset.id AS text_asset_id,
                text_asset.content_hash AS text_content_hash,
                text_asset.object_key AS text_object_key,
                text_asset.created_at AS text_served_at,
                coalesce(text_asset.strategy_tag, 'micro-lesson-v1')
                  AS text_strategy_tag,
                media_asset.id AS media_asset_id,
                media_asset.asset_type AS media_modality,
                media_asset.status AS media_status
         FROM study_session AS session
         JOIN course
           ON course.owner_scope_id = session.owner_scope_id
          AND course.id = session.course_id
         JOIN source_document AS source
           ON source.owner_scope_id = course.owner_scope_id
          AND source.id = course.source_document_id
         JOIN concept
           ON concept.owner_scope_id = course.owner_scope_id
          AND concept.id = $4
         JOIN chapter
           ON chapter.owner_scope_id = concept.owner_scope_id
          AND chapter.id = concept.chapter_id
          AND chapter.course_id = course.id
         JOIN app_user AS actor ON actor.id = $1
         JOIN owner_scope AS scope ON scope.id = session.owner_scope_id
         JOIN scope_membership AS membership
           ON membership.owner_scope_id = session.owner_scope_id
          AND membership.user_id = actor.id
         LEFT JOIN LATERAL (
           SELECT asset.*
           FROM asset
           WHERE asset.owner_scope_id = session.owner_scope_id
             AND asset.course_id = session.course_id
             AND asset.concept_id = concept.id
             AND asset.asset_type = 'text'
             AND asset.status = 'ready'
             AND (asset.reteach_session_id IS NULL
                  OR asset.reteach_session_id = session.id)
           ORDER BY (asset.reteach_session_id = session.id) DESC,
                    asset.created_at DESC, asset.id DESC
           LIMIT 1
         ) AS text_asset ON true
         LEFT JOIN LATERAL (
           SELECT asset.*
           FROM asset
           WHERE asset.owner_scope_id = session.owner_scope_id
             AND asset.course_id = session.course_id
             AND (asset.concept_id = concept.id
                  OR (asset.concept_id IS NULL
                      AND asset.chapter_id = concept.chapter_id))
             AND asset.asset_type IN ('audio', 'video')
             AND (asset.reteach_session_id IS NULL
                  OR asset.reteach_session_id = session.id)
           ORDER BY CASE asset.status
                      WHEN 'ready' THEN 1
                      WHEN 'generating' THEN 2
                      WHEN 'pending' THEN 3
                      ELSE 4
                    END,
                    CASE asset.asset_type WHEN 'audio' THEN 1 ELSE 2 END,
                    asset.created_at DESC, asset.id DESC
           LIMIT 1
         ) AS media_asset ON true
         WHERE session.owner_scope_id = $2
           AND session.id = $3
           AND session.user_id = $1
           AND session.status = 'active'
           AND source.retention_status = 'active'
           AND actor.status = 'active'
           AND scope.status = 'active'
           AND membership.role = 'owner'
           AND membership.revoked_at IS NULL`,
        [
          authorization.actorId,
          authorization.ownerScopeId,
          sessionId,
          conceptId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        media:
          row.media_asset_id === null ||
          row.media_modality === null ||
          row.media_status === null
            ? null
            : {
                assetId: row.media_asset_id,
                modality: row.media_modality,
                status:
                  row.media_status === "ready"
                    ? "ready"
                    : row.media_status === "pending" ||
                        row.media_status === "generating"
                      ? "preparing"
                      : "unavailable",
              },
        text:
          row.text_asset_id === null ||
          row.text_content_hash === null ||
          row.text_object_key === null ||
          row.text_served_at === null ||
          row.text_strategy_tag === null
            ? null
            : {
                assetId: row.text_asset_id,
                contentHash: row.text_content_hash,
                objectKey: row.text_object_key,
                servedAt: row.text_served_at.toISOString(),
                strategyTag: row.text_strategy_tag,
              },
      };
    });
  }

  async resolvePrivateAsset(
    authorization: ScopeAuthorizationContext,
    assetId: string,
  ): Promise<ConnectedPrivateAsset | null> {
    validateAuthorization(authorization);
    if (!isUuid(assetId)) {
      return null;
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query<{
        asset_id: string;
        byte_size: string;
        content_hash: string;
        content_type: string;
        course_id: string;
        etag: string;
        object_key: string;
        owner_scope_id: string;
      }>(
        `SELECT asset.id AS asset_id, asset.owner_scope_id, asset.course_id,
                asset.object_key, asset.content_hash, asset.content_type,
                asset.byte_size::text, asset.etag
         FROM asset
         JOIN course
           ON course.owner_scope_id = asset.owner_scope_id
          AND course.id = asset.course_id
         JOIN source_document AS source
           ON source.owner_scope_id = course.owner_scope_id
          AND source.id = course.source_document_id
         JOIN app_user AS actor ON actor.id = $1
         JOIN owner_scope AS scope ON scope.id = asset.owner_scope_id
         JOIN scope_membership AS membership
           ON membership.owner_scope_id = asset.owner_scope_id
          AND membership.user_id = actor.id
         WHERE asset.owner_scope_id = $2
           AND asset.id = $3
           AND asset.asset_type IN ('audio', 'video')
           AND asset.status = 'ready'
           AND asset.object_key IS NOT NULL
           AND asset.content_hash IS NOT NULL
           AND asset.content_type IS NOT NULL
           AND asset.byte_size IS NOT NULL
           AND asset.etag IS NOT NULL
           AND source.retention_status = 'active'
           AND actor.status = 'active'
           AND scope.status = 'active'
           AND membership.role = 'owner'
           AND membership.revoked_at IS NULL`,
        [authorization.actorId, authorization.ownerScopeId, assetId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const byteSize = Number(row.byte_size);
      if (!Number.isSafeInteger(byteSize) || byteSize < 1) {
        return null;
      }
      return {
        assetId: row.asset_id,
        byteSize,
        contentHash: row.content_hash,
        contentType: row.content_type,
        courseId: row.course_id,
        etag: row.etag,
        objectKey: row.object_key,
        ownerScopeId: row.owner_scope_id,
      };
    });
  }

  async startOrResumeStudySession(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<ConnectedStudySessionStartResult | null> {
    validateAuthorization(authorization);
    if (!isUuid(courseId)) {
      return null;
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      // Course/session creation is rare and this bounded lock prevents two
      // browser tabs from opening duplicate active sessions for one learner.
      await client.query("SELECT pg_advisory_xact_lock(214765003, 163)");
      const course = await loadAuthorizedStudyCourse(
        client,
        authorization,
        courseId,
      );
      if (course === null) {
        return null;
      }
      const existing = await client.query<{ session_id: string }>(
        `SELECT id AS session_id
         FROM study_session
         WHERE owner_scope_id = $1 AND user_id = $2 AND course_id = $3
           AND status = 'active'
         ORDER BY started_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [authorization.ownerScopeId, authorization.actorId, courseId],
      );
      const active = existing.rows[0];
      if (active !== undefined) {
        const refreshedPlan = await deriveStudyPlan(
          client,
          authorization,
          courseId,
          course,
        );
        await client.query(
          `UPDATE study_session SET plan = $4::jsonb
           WHERE owner_scope_id = $1 AND user_id = $2 AND id = $3
             AND status = 'active'`,
          [
            authorization.ownerScopeId,
            authorization.actorId,
            active.session_id,
            JSON.stringify(refreshedPlan),
          ],
        );
        return {
          courseId,
          plan: refreshedPlan,
          resumed: true,
          sessionId: active.session_id,
          status: "active" as const,
        };
      }

      const plan = await deriveStudyPlan(
        client,
        authorization,
        courseId,
        course,
      );
      const sessionId = randomUUID();
      await client.query(
        `INSERT INTO study_session
           (id, owner_scope_id, user_id, course_id, status, plan)
         VALUES ($1, $2, $3, $4, 'active', $5::jsonb)`,
        [
          sessionId,
          authorization.ownerScopeId,
          authorization.actorId,
          courseId,
          JSON.stringify(plan),
        ],
      );
      return {
        courseId,
        plan,
        resumed: false,
        sessionId,
        status: "active" as const,
      };
    });
  }

  async completeStudyLesson(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
    completion: ConnectedStudyLessonCompletion,
  ): Promise<boolean> {
    validateAuthorization(authorization);
    if (
      !isUuid(sessionId) ||
      !isUuid(completion.assetId) ||
      !isUuid(completion.conceptId) ||
      completion.idempotencyKey.length < 1 ||
      completion.idempotencyKey.length > 240
    ) {
      return false;
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const authorized = await client.query<{
        asset_id: string;
        chapter_id: string;
        course_id: string;
        modality: "audio" | "text" | "video";
        strategy_tag: string;
      }>(
        `SELECT asset.id AS asset_id, asset.chapter_id, session.course_id,
                asset.asset_type AS modality,
                coalesce(asset.strategy_tag, 'course-lesson-v1') AS strategy_tag
         FROM study_session AS session
         JOIN app_user AS actor ON actor.id = $1
         JOIN owner_scope AS scope ON scope.id = session.owner_scope_id
         JOIN scope_membership AS membership
          ON membership.owner_scope_id = session.owner_scope_id
          AND membership.user_id = actor.id
         JOIN concept
           ON concept.owner_scope_id = session.owner_scope_id
          AND concept.id = $5
         JOIN chapter
           ON chapter.owner_scope_id = concept.owner_scope_id
          AND chapter.id = concept.chapter_id
          AND chapter.course_id = session.course_id
         JOIN asset
           ON asset.owner_scope_id = session.owner_scope_id
          AND asset.course_id = session.course_id
          AND asset.id = $4
          AND (asset.concept_id = concept.id
               OR (asset.concept_id IS NULL
                   AND asset.chapter_id = chapter.id
                   AND asset.asset_type IN ('audio', 'video')))
          AND asset.status = 'ready'
          AND asset.asset_type IN ('audio', 'text', 'video')
          AND (asset.reteach_session_id IS NULL OR asset.reteach_session_id = session.id)
         WHERE session.owner_scope_id = $2 AND session.user_id = $1
           AND session.id = $3 AND session.status = 'active'
           AND actor.status = 'active' AND scope.status = 'active'
           AND membership.role = 'owner' AND membership.revoked_at IS NULL`,
        [
          authorization.actorId,
          authorization.ownerScopeId,
          sessionId,
          completion.assetId,
          completion.conceptId,
        ],
      );
      const row = authorized.rows[0];
      if (row === undefined) {
        return false;
      }
      const eventId = stableUuid({
        idempotencyKey: completion.idempotencyKey,
        ownerScopeId: authorization.ownerScopeId,
        type: "lesson_completed",
      });
      const payload = {
        assetId: row.asset_id,
        chapterId: row.chapter_id,
        courseId: row.course_id,
        modality: row.modality,
        strategyTag: row.strategy_tag,
      };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO learning_event
           (id, owner_scope_id, user_id, session_id, event_type,
            idempotency_key, payload, occurred_at, event_version, producer,
            correlation_id)
         VALUES ($1, $2, $3, $4, 'lesson_completed', $5, $6::jsonb, now(),
                 1, 'course-study-v1', $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          eventId,
          authorization.ownerScopeId,
          authorization.actorId,
          sessionId,
          completion.idempotencyKey,
          JSON.stringify(payload),
        ],
      );
      if (inserted.rows[0]?.id !== eventId) {
        const existing = await client.query<{ matches: boolean }>(
          `SELECT (
             id = $1 AND user_id = $3 AND session_id = $4
             AND event_type = 'lesson_completed' AND payload = $6::jsonb
             AND event_version = 1 AND producer = 'course-study-v1'
             AND correlation_id = $4
           ) AS matches
           FROM learning_event
           WHERE owner_scope_id = $2
             AND (id = $1 OR idempotency_key = $5)`,
          [
            eventId,
            authorization.ownerScopeId,
            authorization.actorId,
            sessionId,
            completion.idempotencyKey,
            JSON.stringify(payload),
          ],
        );
        if (existing.rows[0]?.matches !== true) {
          return false;
        }
      }
      await client.query(
        `INSERT INTO learning_event_concept
           (owner_scope_id, learning_event_id, concept_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [authorization.ownerScopeId, eventId, completion.conceptId],
      );
      return true;
    });
  }

  async resetWeakState(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<ConnectedDemoSeedResult> {
    validateAuthorization(authorization);
    if (!isUuid(courseId)) {
      throw new Error("connected demo seed course is invalid");
    }
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await client.query("SELECT pg_advisory_xact_lock(214765003, 162)");
      const seed = await client.query<{
        asset_id: string;
        chapter_id: string;
        concept_id: string;
        quiz_item_ids: string[];
        strategy_tag: string;
      }>(
        `SELECT concept.id AS concept_id, chapter.id AS chapter_id,
                lesson.id AS asset_id,
                coalesce(lesson.strategy_tag, 'micro-lesson-v1')
                  AS strategy_tag,
                array_agg(
                  question.id ORDER BY question.item_order, question.id
                ) FILTER (
                  WHERE question.item_type = 'multiple_choice'
                )
                  AS quiz_item_ids
         FROM course
         JOIN chapter
           ON chapter.owner_scope_id = course.owner_scope_id
          AND chapter.course_id = course.id
         JOIN concept
           ON concept.owner_scope_id = chapter.owner_scope_id
          AND concept.chapter_id = chapter.id
         JOIN asset AS lesson
           ON lesson.owner_scope_id = concept.owner_scope_id
          AND lesson.course_id = course.id
          AND lesson.concept_id = concept.id
          AND lesson.asset_type = 'text'
          AND lesson.status = 'ready'
          AND lesson.reteach_session_id IS NULL
         JOIN quiz_item_concept AS question_link
           ON question_link.owner_scope_id = concept.owner_scope_id
          AND question_link.concept_id = concept.id
         JOIN quiz_item AS question
           ON question.owner_scope_id = question_link.owner_scope_id
          AND question.id = question_link.quiz_item_id
          AND question.course_id = course.id
          AND question.normalized_prompt_hash IS NOT NULL
         JOIN app_user AS actor ON actor.id = $1
         JOIN owner_scope AS scope ON scope.id = course.owner_scope_id
         JOIN scope_membership AS membership
           ON membership.owner_scope_id = course.owner_scope_id
          AND membership.user_id = actor.id
         WHERE course.owner_scope_id = $2
           AND course.id = $3
           AND course.status = 'ready'
           AND actor.status = 'active'
           AND scope.status = 'active'
           AND membership.role = 'owner'
           AND membership.revoked_at IS NULL
           AND (
             SELECT count(*)
             FROM quiz_item_concept AS all_links
             WHERE all_links.owner_scope_id = question.owner_scope_id
               AND all_links.quiz_item_id = question.id
           ) = 1
         GROUP BY concept.id, chapter.id, lesson.id
         HAVING count(question.id) FILTER (
                  WHERE question.item_type = 'multiple_choice'
                ) >= 4
            AND count(question.id) FILTER (
                  WHERE question.item_type = 'short_answer'
                ) >= 2
         ORDER BY chapter.chapter_order, concept.concept_order, concept.id
         LIMIT 1`,
        [authorization.actorId, authorization.ownerScopeId, courseId],
      );
      const row = seed.rows[0];
      if (row === undefined || row.quiz_item_ids.length < 2) {
        throw new Error("connected demo seed content is unavailable");
      }

      await client.query("SELECT reflo_reset_learning_scope($1)", [
        authorization.ownerScopeId,
      ]);
      await client.query(
        `DELETE FROM asset_source_span
         WHERE owner_scope_id = $1
           AND asset_id IN (
             SELECT id FROM asset
             WHERE owner_scope_id = $1
               AND reteach_session_id IN (
                 SELECT id FROM study_session
                 WHERE owner_scope_id = $1 AND user_id = $2
               )
           )`,
        [authorization.ownerScopeId, authorization.actorId],
      );
      await client.query(
        `DELETE FROM asset
         WHERE owner_scope_id = $1
           AND reteach_session_id IN (
             SELECT id FROM study_session
             WHERE owner_scope_id = $1 AND user_id = $2
           )`,
        [authorization.ownerScopeId, authorization.actorId],
      );
      await client.query(
        `DELETE FROM study_session
         WHERE owner_scope_id = $1 AND user_id = $2`,
        [authorization.ownerScopeId, authorization.actorId],
      );

      const sessionId = seededId(authorization, courseId, "session");
      const lessonEventId = seededId(
        authorization,
        courseId,
        "lesson-completed",
      );
      const correlationId = seededId(authorization, courseId, "correlation");
      const attemptIds = [
        seededId(authorization, courseId, "weak-attempt-1"),
        seededId(authorization, courseId, "weak-attempt-2"),
      ] as const;
      const now = new Date();
      const lessonAt = new Date(now.getTime() - 3 * 60_000);
      const attemptTimes = [
        new Date(now.getTime() - 2 * 60_000),
        new Date(now.getTime() - 60_000),
      ] as const;

      await client.query(
        `INSERT INTO study_session
           (id, owner_scope_id, user_id, course_id, status, plan)
         VALUES ($1, $2, $3, $4, 'active',
                 '{"contractVersion":"connected-demo-plan-v1","demoOnly":true}'::jsonb)`,
        [
          sessionId,
          authorization.ownerScopeId,
          authorization.actorId,
          courseId,
        ],
      );
      await client.query(
        `INSERT INTO learning_event
           (id, owner_scope_id, user_id, session_id, event_type,
            idempotency_key, payload, occurred_at, event_version, producer,
            correlation_id)
         VALUES ($1, $2, $3, $4, 'lesson_completed', $5, $6::jsonb, $7,
                 1, 'connected-demo-seed', $8)`,
        [
          lessonEventId,
          authorization.ownerScopeId,
          authorization.actorId,
          sessionId,
          `dev/demo.seed.lesson-completed/v1/${lessonEventId}`,
          JSON.stringify({
            assetId: row.asset_id,
            chapterId: row.chapter_id,
            courseId,
            modality: "text",
            strategyTag: row.strategy_tag,
          }),
          lessonAt,
          correlationId,
        ],
      );
      await client.query(
        `INSERT INTO learning_event_concept
           (owner_scope_id, learning_event_id, concept_id)
         VALUES ($1, $2, $3)`,
        [authorization.ownerScopeId, lessonEventId, row.concept_id],
      );

      const evidence: AssessmentEvidenceWrite[] = [];
      for (const [index, attemptId] of attemptIds.entries()) {
        const quizItemId = row.quiz_item_ids[index]!;
        const idempotencyKey = `dev/demo.seed.attempt/v1/${attemptId}`;
        await client.query(
          `INSERT INTO attempt
             (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
              outcome, grader_provenance, submission_idempotency_key,
              grading_policy_version, rating_mapping_version, created_at)
           VALUES ($1, $2, $3, $4, $5,
                   '{"fixture":"synthetic-incorrect-v1"}'::jsonb, 'graded',
                   '{"evidenceClassification":"development_only","seeded":true}'::jsonb,
                   $6, 'grading-policy-v1', 'rating-mapping-v1', $7)`,
          [
            attemptId,
            authorization.ownerScopeId,
            authorization.actorId,
            sessionId,
            quizItemId,
            idempotencyKey,
            attemptTimes[index],
          ],
        );
        evidence.push({
          attemptId,
          conceptId: row.concept_id,
          eligibleForMastery: true,
          fsrsRating: 1,
          graderConfidence: null,
          gradingMethod: "keyed_mc",
          gradingPolicyVersion: "grading-policy-v1",
          ineligibilityReason: null,
          judgmentKind: "scored",
          knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
          knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
          rationaleRef: `connected-demo-seed/${quizItemId}`,
          ratingMappingVersion: "rating-mapping-v1",
          replacementForAttemptId: null,
          rubricBand: "incorrect",
          rubricId: "connected-demo-seed-rubric",
          rubricVersion: "1",
          score: "0.00000",
          unanswerableReason: null,
        });
      }
      return {
        conceptId: row.concept_id,
        courseId,
        evidence,
        sessionId,
      };
    });
  }

  async #transaction<Value>(
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface AuthorizedStudyCourse {
  readonly hasChapterQuestion: boolean;
  readonly hasLesson: boolean;
  readonly hasPlacementQuestion: boolean;
  readonly hasQuestion: boolean;
}

interface ActivationProgressOperationRow extends Record<string, unknown> {
  readonly artifact_kind:
    "chapter_quiz" | "first_text_lesson" | "placement_quiz";
  readonly attempt_count: number;
  readonly failure_class: string | null;
  readonly regeneration_ordinal: number;
  readonly status:
    | "cancelled"
    | "expired"
    | "failed_permanent"
    | "processing"
    | "queued"
    | "retry_scheduled"
    | "succeeded";
  readonly updated_at: Date;
}

function activationProgressView(
  readiness: AuthorizedStudyCourse,
  persistedPlan: Record<string, unknown>,
  startedAt: Date,
  operations: readonly ActivationProgressOperationRow[],
): ConnectedActivationProgress {
  const lessonOperation = operations.find(
    (operation) => operation.artifact_kind === "first_text_lesson",
  );
  const quizOperations = operations.filter(
    (operation) => operation.artifact_kind !== "first_text_lesson",
  );
  const chapterOperation = quizOperations.find(
    (operation) => operation.artifact_kind === "chapter_quiz",
  );
  const placementOperation = quizOperations.find(
    (operation) => operation.artifact_kind === "placement_quiz",
  );
  const planReportsFailure = persistedPlan.activationStatus === "lesson_failed";
  const activationStatus = readiness.hasLesson
    ? "ready"
    : lessonOperation?.status === "retry_scheduled"
      ? "retrying"
      : lessonOperation !== undefined &&
          isTerminalActivationStatus(lessonOperation.status)
        ? "failed"
        : planReportsFailure
          ? "failed"
          : "pending";
  const assessmentStatus = readiness.hasChapterQuestion
    ? "ready"
    : chapterOperation?.status === "retry_scheduled"
      ? "retrying"
      : chapterOperation === undefined ||
          !isTerminalActivationStatus(chapterOperation.status)
        ? "pending"
        : "failed";
  const selectedAssessmentOperation =
    [chapterOperation, placementOperation].find(
      (operation) =>
        operation?.status === "processing" ||
        operation?.status === "queued" ||
        operation?.status === "retry_scheduled",
    ) ??
    chapterOperation ??
    placementOperation;
  const failureClass =
    activationStatus === "failed"
      ? (lessonOperation?.failure_class ?? planFailureClass(persistedPlan))
      : null;

  return {
    activationStatus,
    artifact: "first_text_lesson",
    assessmentArtifact:
      selectedAssessmentOperation === undefined
        ? null
        : assessmentOperationProgress(
            selectedAssessmentOperation,
            selectedAssessmentOperation.artifact_kind === "chapter_quiz"
              ? readiness.hasChapterQuestion
              : readiness.hasPlacementQuestion,
          ),
    assessmentStatus,
    attemptCount: lessonOperation?.attempt_count ?? 0,
    contractVersion: ACTIVATION_PROGRESS_CONTRACT_VERSION,
    failure:
      activationStatus === "failed"
        ? sanitizedActivationFailure(failureClass)
        : null,
    maxAttempts: 5,
    nextAction:
      activationStatus === "ready"
        ? "open_lesson"
        : activationStatus === "failed"
          ? "activation_failed"
          : "wait",
    stage: readiness.hasLesson
      ? "ready"
      : activationStage(lessonOperation?.status),
    updatedAt: (lessonOperation?.updated_at ?? startedAt).toISOString(),
  };
}

function assessmentOperationProgress(
  operation: ActivationProgressOperationRow,
  ready: boolean,
): NonNullable<ConnectedActivationProgress["assessmentArtifact"]> {
  const status = ready
    ? "ready"
    : operation.status === "retry_scheduled"
      ? "retrying"
      : isTerminalActivationStatus(operation.status)
        ? "failed"
        : "pending";
  return {
    artifactKind: operation.artifact_kind as "chapter_quiz" | "placement_quiz",
    attemptCount: operation.attempt_count,
    failure:
      status === "failed"
        ? sanitizedActivationFailure(operation.failure_class, "questions")
        : null,
    maxAttempts: 5,
    regenerationOrdinal: operation.regeneration_ordinal,
    stage: ready ? "ready" : activationStage(operation.status),
    status,
    updatedAt: operation.updated_at.toISOString(),
  };
}

function activationStage(
  status: ActivationProgressOperationRow["status"] | undefined,
): ConnectedActivationProgress["stage"] {
  switch (status) {
    case "processing":
      return "generating";
    case "retry_scheduled":
      return "retry_scheduled";
    case "succeeded":
      // A succeeded operation without a ready asset is an integrity-safe
      // terminal state from the learner's perspective.
      return "failed";
    case "cancelled":
    case "expired":
    case "failed_permanent":
      return "failed";
    case "queued":
    case undefined:
      return "awaiting_generation";
  }
}

function isTerminalActivationStatus(
  status: ActivationProgressOperationRow["status"],
): boolean {
  return ["cancelled", "expired", "failed_permanent", "succeeded"].includes(
    status,
  );
}

function planFailureClass(plan: Record<string, unknown>): string | null {
  const failure = plan.activationFailure;
  if (failure === null || typeof failure !== "object") {
    return null;
  }
  const failureClass = (failure as Record<string, unknown>).failureClass;
  return typeof failureClass === "string" ? failureClass : null;
}

function sanitizedActivationFailure(
  failureClass: string | null,
  subject: "lesson" | "questions" = "lesson",
): NonNullable<ConnectedActivationProgress["failure"]> {
  const label =
    subject === "lesson" ? "Lesson preparation" : "Question preparation";
  const normalized = failureClass?.toLowerCase() ?? "";
  if (normalized.includes("timeout") || normalized.includes("deadline")) {
    return {
      code: "generation_timed_out",
      message: `${label} took too long to finish.`,
    };
  }
  if (
    normalized.includes("capacity") ||
    normalized.includes("dependency") ||
    normalized.includes("unavailable")
  ) {
    return {
      code: "generation_unavailable",
      message: `${label} is temporarily unavailable.`,
    };
  }
  return {
    code: "generation_failed",
    message: `${label} could not be completed.`,
  };
}

async function loadAuthorizedStudyCourse(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
  courseId: string,
): Promise<AuthorizedStudyCourse | null> {
  const result = await client.query<{
    has_chapter_question: boolean;
    has_lesson: boolean;
    has_placement_question: boolean;
    has_question: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1
         FROM asset
         JOIN chapter ON chapter.owner_scope_id = asset.owner_scope_id
                     AND chapter.id = asset.chapter_id
         JOIN concept ON concept.owner_scope_id = asset.owner_scope_id
                     AND concept.id = asset.concept_id
         WHERE asset.owner_scope_id = course.owner_scope_id
           AND asset.course_id = course.id
           AND asset.asset_type = 'text' AND asset.status = 'ready'
           AND asset.reteach_session_id IS NULL
           AND chapter.course_id = course.id
       ) AS has_lesson,
       EXISTS (
         SELECT 1
         FROM quiz_item
         JOIN quiz_item_concept AS link
           ON link.owner_scope_id = quiz_item.owner_scope_id
          AND link.quiz_item_id = quiz_item.id
         JOIN concept ON concept.owner_scope_id = link.owner_scope_id
                     AND concept.id = link.concept_id
         JOIN chapter ON chapter.owner_scope_id = concept.owner_scope_id
                     AND chapter.id = concept.chapter_id
         WHERE quiz_item.owner_scope_id = course.owner_scope_id
           AND quiz_item.course_id = course.id
           AND quiz_item.normalized_prompt_hash IS NOT NULL
           AND chapter.course_id = course.id
       ) AS has_question,
       EXISTS (
         SELECT 1 FROM quiz_bank
         WHERE quiz_bank.owner_scope_id = course.owner_scope_id
           AND quiz_bank.course_id = course.id
           AND quiz_bank.bank_kind = 'chapter'
       ) AS has_chapter_question,
       EXISTS (
         SELECT 1 FROM quiz_bank
         WHERE quiz_bank.owner_scope_id = course.owner_scope_id
           AND quiz_bank.course_id = course.id
           AND quiz_bank.bank_kind = 'placement'
       ) AS has_placement_question
     FROM course
     JOIN source_document AS source
       ON source.owner_scope_id = course.owner_scope_id
      AND source.id = course.source_document_id
     JOIN app_user AS actor ON actor.id = $1
     JOIN owner_scope AS scope ON scope.id = course.owner_scope_id
     JOIN scope_membership AS membership
       ON membership.owner_scope_id = course.owner_scope_id
      AND membership.user_id = actor.id
     WHERE course.owner_scope_id = $2 AND course.id = $3
       AND course.status IN ('generating', 'ready')
       AND source.parse_status = 'parsed'
       AND source.retention_status = 'active'
       AND actor.status = 'active' AND scope.status = 'active'
       AND membership.role = 'owner' AND membership.revoked_at IS NULL`,
    [authorization.actorId, authorization.ownerScopeId, courseId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        hasChapterQuestion: row.has_chapter_question || row.has_question,
        hasLesson: row.has_lesson,
        hasPlacementQuestion: row.has_placement_question,
        hasQuestion: row.has_question,
      };
}

async function deriveStudyPlan(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
  courseId: string,
  course: AuthorizedStudyCourse,
): Promise<Readonly<Record<string, unknown>>> {
  const activation = await client.query<{
    artifact_kind: "chapter_quiz" | "first_text_lesson" | "placement_quiz";
    attempt_count: number;
    failure_class: string | null;
    regeneration_ordinal: number;
    status:
      | "cancelled"
      | "expired"
      | "failed_permanent"
      | "processing"
      | "queued"
      | "retry_scheduled"
      | "succeeded";
    updated_at: Date;
  }>(
    `SELECT artifact_kind, attempt_count, failure_class,
            regeneration_ordinal, status, updated_at
     FROM activation_generation_operation
     WHERE owner_scope_id = $1 AND course_id = $2
       AND generation_version = $3
     ORDER BY priority, regeneration_ordinal DESC, id`,
    [authorization.ownerScopeId, courseId, ACTIVATION_GENERATION_VERSION],
  );
  const focus = await client.query<{
    concept_id: string;
    kind: "advance" | "review";
  }>(
    `SELECT candidate.concept_id, candidate.kind
     FROM (
       SELECT concept.id AS concept_id,
              CASE
                WHEN coalesce(schedule.next_delivery_at <= now(), false)
                  THEN 'review'
                WHEN coalesce(state.mastery, 0.25000) < 0.60000
                  AND coalesce(evidence.count, 0) >= 2
                  AND latest.rubric_band IS DISTINCT FROM 'correct'
                  THEN 'review'
                ELSE 'advance'
              END AS kind,
              CASE
                WHEN coalesce(schedule.next_delivery_at <= now(), false) THEN 1
                WHEN coalesce(state.mastery, 0.25000) < 0.60000
                  AND coalesce(evidence.count, 0) >= 2
                  AND latest.rubric_band IS DISTINCT FROM 'correct' THEN 2
                ELSE 3
              END AS priority,
              chapter.chapter_order, concept.concept_order
       FROM concept
       JOIN chapter
         ON chapter.owner_scope_id = concept.owner_scope_id
        AND chapter.id = concept.chapter_id AND chapter.course_id = $3
       LEFT JOIN knowledge_state AS state
         ON state.owner_scope_id = concept.owner_scope_id
        AND state.user_id = $2 AND state.concept_id = concept.id
       LEFT JOIN review_schedule AS schedule
         ON schedule.owner_scope_id = concept.owner_scope_id
        AND schedule.user_id = $2 AND schedule.concept_id = concept.id
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS count
         FROM attempt_concept_evidence
         WHERE owner_scope_id = concept.owner_scope_id
           AND attempt_user_id = $2 AND concept_id = concept.id
           AND eligible_for_mastery
       ) AS evidence ON true
       LEFT JOIN LATERAL (
         SELECT rubric_band
         FROM attempt_concept_evidence
         WHERE owner_scope_id = concept.owner_scope_id
           AND attempt_user_id = $2 AND concept_id = concept.id
           AND eligible_for_mastery
         ORDER BY attempt_created_at DESC, attempt_id DESC LIMIT 1
       ) AS latest ON true
       WHERE concept.owner_scope_id = $1
     ) AS candidate
     ORDER BY candidate.priority, candidate.chapter_order,
              candidate.concept_order, candidate.concept_id
     LIMIT 1`,
    [authorization.ownerScopeId, authorization.actorId, courseId],
  );
  const selected = focus.rows[0];
  const lessonOperation = activation.rows.find(
    (operation) => operation.artifact_kind === "first_text_lesson",
  );
  const quizOperations = activation.rows.filter(
    (operation) => operation.artifact_kind !== "first_text_lesson",
  );
  const chapterQuizOperation = quizOperations.find(
    (operation) => operation.artifact_kind === "chapter_quiz",
  );
  const placementQuizOperation = quizOperations.find(
    (operation) => operation.artifact_kind === "placement_quiz",
  );
  const lessonFailure =
    !course.hasLesson &&
    lessonOperation !== undefined &&
    ["cancelled", "expired", "failed_permanent"].includes(
      lessonOperation.status,
    )
      ? lessonOperation
      : null;
  const regenerationEligible =
    lessonFailure !== null &&
    lessonFailure.failure_class !== null &&
    [
      "content_out_of_bounds",
      "deadline_exceeded",
      "infrastructure_unavailable",
      "invalid_result",
      "provider_failure",
    ].includes(lessonFailure.failure_class);
  const activationStatus = course.hasLesson
    ? "ready"
    : lessonFailure === null
      ? "lesson_pending"
      : "lesson_failed";
  const assessmentStatus = course.hasChapterQuestion
    ? "ready"
    : chapterQuizOperation?.status === "failed_permanent"
      ? "failed"
      : "pending";
  return {
    activationFailure:
      lessonFailure === null
        ? null
        : {
            artifactKind: lessonFailure.artifact_kind,
            attemptCount: lessonFailure.attempt_count,
            failureClass: lessonFailure.failure_class,
            retryable: false,
            updatedAt: lessonFailure.updated_at.toISOString(),
          },
    activationStatus,
    ...(quizOperations.length === 0
      ? {}
      : {
          assessments: {
            chapterQuiz: assessmentArtifactPlan(
              chapterQuizOperation,
              course.hasChapterQuestion,
            ),
            placementQuiz: assessmentArtifactPlan(
              placementQuizOperation,
              course.hasPlacementQuestion,
            ),
          },
        }),
    assessmentStatus,
    contractVersion: "course-study-plan-v1",
    focusConceptId: selected?.concept_id ?? null,
    regeneration:
      !regenerationEligible || lessonFailure === null
        ? null
        : {
            availableAt: new Date(
              lessonFailure.updated_at.getTime() + 60_000,
            ).toISOString(),
            eligible: true,
          },
    nextAction:
      activationStatus === "ready"
        ? (selected?.kind ?? "session_complete")
        : activationStatus === "lesson_failed"
          ? "activation_failed"
          : "prepare_activation",
    timeBudgetMinutes: 10,
  };
}

function assessmentArtifactPlan(
  operation:
    | {
        readonly artifact_kind:
          "chapter_quiz" | "first_text_lesson" | "placement_quiz";
        readonly attempt_count: number;
        readonly failure_class: string | null;
        readonly regeneration_ordinal: number;
        readonly status: ActivationProgressOperationRow["status"];
        readonly updated_at: Date;
      }
    | undefined,
  ready: boolean,
) {
  if (operation === undefined) {
    return {
      attemptCount: 0,
      failureClass: null,
      regeneration: null,
      regenerationOrdinal: 0,
      status: ready ? "ready" : "pending",
      updatedAt: null,
    } as const;
  }
  const failed =
    !ready &&
    ["cancelled", "expired", "failed_permanent"].includes(operation.status);
  const eligible =
    failed &&
    operation.failure_class !== null &&
    [
      "content_out_of_bounds",
      "deadline_exceeded",
      "infrastructure_unavailable",
      "invalid_result",
      "provider_failure",
    ].includes(operation.failure_class);
  return {
    attemptCount: operation.attempt_count,
    failureClass: operation.failure_class,
    regeneration: eligible
      ? {
          availableAt: new Date(
            operation.updated_at.getTime() + 60_000,
          ).toISOString(),
          eligible: true as const,
        }
      : null,
    regenerationOrdinal: operation.regeneration_ordinal,
    status: ready
      ? ("ready" as const)
      : failed
        ? ("failed" as const)
        : operation.status === "retry_scheduled"
          ? ("retrying" as const)
          : ("pending" as const),
    updatedAt: operation.updated_at.toISOString(),
  };
}

async function enrichSummaryConceptNames(
  client: PoolClient,
  ownerScopeId: string,
  courseId: string,
  summary: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (summary === null) {
    return null;
  }
  const flowB =
    typeof summary.flowB === "object" && summary.flowB !== null
      ? (summary.flowB as Record<string, unknown>)
      : null;
  if (flowB === null) {
    return summary;
  }
  const conceptIds = Object.keys(flowB).filter(isUuid);
  if (conceptIds.length === 0) {
    return summary;
  }
  const names = await client.query<{
    concept_id: string;
    concept_name: string;
  }>(
    `SELECT concept.id AS concept_id, concept.name AS concept_name
     FROM concept
     JOIN chapter
       ON chapter.owner_scope_id = concept.owner_scope_id
      AND chapter.id = concept.chapter_id
      AND chapter.course_id = $2
     WHERE concept.owner_scope_id = $1
       AND concept.id = ANY($3::uuid[])`,
    [ownerScopeId, courseId, conceptIds],
  );
  const byId = new Map(
    names.rows.map((row) => [row.concept_id, row.concept_name]),
  );
  return {
    ...summary,
    flowB: Object.fromEntries(
      Object.entries(flowB).map(([conceptId, entry]) => {
        const conceptName = byId.get(conceptId);
        return [
          conceptId,
          conceptName === undefined ||
          typeof entry !== "object" ||
          entry === null
            ? entry
            : { ...(entry as Record<string, unknown>), conceptName },
        ];
      }),
    ),
  };
}

async function setScopeContext(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
): Promise<void> {
  await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
    authorization.actorId,
  ]);
  await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
    authorization.ownerScopeId,
  ]);
}

function validateAuthorization(authorization: ScopeAuthorizationContext): void {
  if (
    !isUuid(authorization.actorId) ||
    !isUuid(authorization.ownerScopeId) ||
    authorization.authorizationId.length < 1 ||
    authorization.authorizationId.length > 240
  ) {
    throw new Error("connected demo authorization is invalid");
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
}

function seededId(
  authorization: ScopeAuthorizationContext,
  courseId: string,
  kind: string,
): string {
  return stableUuid({
    kind,
    ownerScopeId: authorization.ownerScopeId,
    courseId,
    userId: authorization.actorId,
    version: "connected-demo-seed-v1",
  });
}
