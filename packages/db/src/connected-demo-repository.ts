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
      return row === undefined
        ? null
        : {
            courseId: row.course_id,
            sessionId: row.session_id,
            status: row.status,
            summary: row.summary,
          };
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
