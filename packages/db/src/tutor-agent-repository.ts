import type { ModelCallProvenance } from "@reflo/model-router";
import { stableUuid, type ScopeAuthorizationContext } from "@reflo/retrieval";
import {
  RETEACH_GENERATION_VERSION,
  TutorAgentError,
  type LaterReviewRequest,
  type LoopSuccessRecord,
  type PersistedReteachLesson,
  type ReteachPersistenceRequest,
  type TutorAgentRepositoryPort,
  type TutorAttemptEvidence,
  type TutorLessonReference,
  type TutorLoopResult,
  type TutorQuestionRecord,
  type TutorRetestQuestion,
  type TutorReviewSchedulerPort,
  type TutorSessionSnapshot,
} from "@reflo/tutor-agent";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

interface SessionRow extends Record<string, unknown> {
  course_id: string;
  owner_scope_id: string;
  session_id: string;
  source_document_id: string;
  status: string;
  summary: Record<string, unknown> | null;
  user_id: string;
}

interface ConceptRow extends Record<string, unknown> {
  chapter_id: string;
  concept_id: string;
  concept_name: string;
  due_for_review: boolean;
  eligible_attempt_count: number;
  latest_attempt_created_at: Date | null;
  latest_attempt_id: string | null;
  latest_attempt_quiz_item_id: string | null;
  latest_attempt_rubric_band:
    "correct" | "incorrect" | "partially_correct" | null;
  latest_attempt_score: string | null;
  latest_lesson_exposure_at: Date | null;
  lesson_asset_id: string | null;
  lesson_content_hash: string | null;
  lesson_modality: "audio" | "text" | "video" | null;
  lesson_object_key: string | null;
  lesson_served_at: Date | null;
  lesson_strategy_tag: string | null;
  loop_result: TutorLoopResult | null;
  mastery: string;
}

interface SourceSpanRow extends Record<string, unknown> {
  concept_id: string;
  source_span_id: string;
  source_text: string;
}

interface ReteachRow extends Record<string, unknown> {
  asset_id: string;
  baseline_mastery: string;
  chapter_id: string;
  concept_id: string;
  content_hash: string;
  generation_id: string;
  model_provenance: ModelCallProvenance;
  object_key: string;
  replacement_ordinal: 1 | 2;
  semantic_similarity: string;
  served_at: Date;
  source_span_ids: string[];
  strategy_tag: string;
}

interface QuestionRow extends Record<string, unknown> {
  concept_id: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  item_id: string;
  item_type: TutorRetestQuestion["itemType"];
  prompt: string;
  response_options: string[] | null;
  source_span_ids: string[];
}

interface PersistedAssetRow extends Record<string, unknown> {
  id: string;
  reteach_served_at: Date;
}

export class PostgresTutorAgentRepository
  implements TutorAgentRepositoryPort, TutorReviewSchedulerPort
{
  readonly #pool: InstanceType<typeof Pool>;
  readonly #retestItemTypes: readonly TutorRetestQuestion["itemType"][];

  constructor(
    connectionString: string,
    options: {
      readonly retestItemTypes?: readonly TutorRetestQuestion["itemType"][];
    } = {},
  ) {
    if (connectionString.length === 0) {
      throw new TutorAgentError("invalid_configuration");
    }
    const retestItemTypes = options.retestItemTypes ?? [
      "concept_linking",
      "multiple_choice",
      "short_answer",
    ];
    if (
      retestItemTypes.length === 0 ||
      new Set(retestItemTypes).size !== retestItemTypes.length
    ) {
      throw new TutorAgentError("invalid_configuration");
    }
    this.#retestItemTypes = retestItemTypes;
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async loadSession(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<TutorSessionSnapshot | null> {
    validateAuthorization(authorization);
    validateUuid(sessionId);
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const session = await loadAuthorizedSession(
        client,
        authorization,
        sessionId,
        false,
      );
      if (session === null) {
        return null;
      }
      const [concepts, spans, reteaches, questions] = await Promise.all([
        loadConceptRows(client, session),
        loadSourceSpans(client, session),
        loadReteaches(client, session),
        loadRetestQuestions(client, session, this.#retestItemTypes),
      ]);
      return materializeSession(
        authorization,
        session,
        concepts,
        spans,
        reteaches,
        questions,
      );
    });
  }

  async saveReteach(
    authorization: ScopeAuthorizationContext,
    request: ReteachPersistenceRequest,
  ): Promise<PersistedReteachLesson> {
    validateGeneratedReteach(authorization, request);
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const session = await loadAuthorizedSession(
        client,
        authorization,
        request.session.sessionId,
        true,
      );
      if (
        session === null ||
        session.course_id !== request.session.courseId ||
        session.source_document_id !== request.session.sourceDocumentId
      ) {
        throw new TutorAgentError("authorization_denied");
      }
      await assertReteachState(client, session, request);
      await assertAuthorizedSpans(
        client,
        session,
        request.generated.conceptId,
        request.generated.sourceSpanIds,
      );
      const persisted = await client.query<PersistedAssetRow>(
        `INSERT INTO asset
           (id, owner_scope_id, course_id, chapter_id, concept_id, asset_type,
            object_key, model_id, prompt_id, generation_version, strategy_tag,
            status, model_provenance, content_hash, content_type, byte_size,
            etag, reteach_session_id, reteach_replacement_ordinal,
            reteach_baseline_mastery, reteach_semantic_similarity,
            reteach_generation_id, reteach_served_at)
         VALUES (
           $1, $2, $3, $4, $5, 'text', $6, $7, $8, $9, $10, 'ready',
           $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, now()
         )
         ON CONFLICT (
           owner_scope_id, reteach_session_id, concept_id,
           reteach_replacement_ordinal
         ) DO UPDATE SET id = asset.id
         WHERE asset.id = EXCLUDED.id
           AND asset.object_key = EXCLUDED.object_key
           AND asset.model_provenance = EXCLUDED.model_provenance
           AND asset.content_hash = EXCLUDED.content_hash
           AND asset.reteach_baseline_mastery =
               EXCLUDED.reteach_baseline_mastery
           AND asset.reteach_semantic_similarity =
               EXCLUDED.reteach_semantic_similarity
           AND asset.reteach_generation_id = EXCLUDED.reteach_generation_id
         RETURNING id, reteach_served_at`,
        [
          request.generated.assetId,
          session.owner_scope_id,
          session.course_id,
          request.generated.chapterId,
          request.generated.conceptId,
          request.generated.objectKey,
          request.generated.modelProvenance.effectiveModel,
          request.generated.modelProvenance.promptId ?? null,
          RETEACH_GENERATION_VERSION,
          request.generated.strategyTag,
          JSON.stringify(request.generated.modelProvenance),
          request.generated.contentHash,
          request.generated.storage.contentType,
          request.generated.storage.byteSize,
          request.generated.storage.etag,
          session.session_id,
          request.generated.replacementOrdinal,
          request.generated.baselineMastery,
          request.generated.semanticSimilarity,
          request.generated.generationId,
        ],
      );
      const asset = persisted.rows[0];
      if (asset === undefined || asset.id !== request.generated.assetId) {
        throw new TutorAgentError("invalid_result");
      }
      await insertAssetSourceSpans(
        client,
        session.owner_scope_id,
        asset.id,
        request.generated.sourceSpanIds,
      );
      await appendReteachEvent(
        client,
        session,
        request,
        asset.reteach_served_at,
      );
      return {
        assetId: asset.id,
        baselineMastery: request.generated.baselineMastery,
        chapterId: request.generated.chapterId,
        conceptId: request.generated.conceptId,
        contentHash: request.generated.contentHash,
        generationId: request.generated.generationId,
        generationVersion: RETEACH_GENERATION_VERSION,
        modality: "text",
        modelProvenance: request.generated.modelProvenance,
        objectKey: request.generated.objectKey,
        ownerScopeId: session.owner_scope_id,
        replacementOrdinal: request.generated.replacementOrdinal,
        semanticSimilarity: request.generated.semanticSimilarity,
        servedAt: asset.reteach_served_at.toISOString(),
        sessionId: session.session_id,
        sourceSpanIds: request.generated.sourceSpanIds,
        strategyTag: request.generated.strategyTag,
      };
    });
  }

  async recordLoopSuccess(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
  ): Promise<TutorLoopResult> {
    return this.#recordLoopResult(authorization, record, "retest_succeeded");
  }

  async recordLoopStopped(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
  ): Promise<TutorLoopResult> {
    return this.#recordLoopResult(
      authorization,
      record,
      "stopped_after_two_replacements",
    );
  }

  async recordTutorQuestion(
    authorization: ScopeAuthorizationContext,
    record: TutorQuestionRecord,
  ): Promise<void> {
    validateAuthorization(authorization);
    validateUuid(record.sessionId);
    validateIdempotencyKey(record.idempotencyKey);
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const session = await loadAuthorizedSession(
        client,
        authorization,
        record.sessionId,
        false,
      );
      if (session === null) {
        throw new TutorAgentError("authorization_denied");
      }
      if (record.sourceSpanIds.length > 0) {
        const spans = await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM source_span
           WHERE owner_scope_id = $1 AND source_document_id = $2
             AND id = ANY($3::uuid[])`,
          [
            session.owner_scope_id,
            session.source_document_id,
            record.sourceSpanIds,
          ],
        );
        if (
          new Set(record.sourceSpanIds).size !== record.sourceSpanIds.length ||
          spans.rows[0]?.count !== record.sourceSpanIds.length
        ) {
          throw new TutorAgentError("authorization_denied");
        }
      }
      const id = stableUuid({
        idempotencyKey: record.idempotencyKey,
        ownerScopeId: session.owner_scope_id,
        type: "question_asked",
      });
      const payload = {
        resultKind: record.resultKind,
        sourceSpanIds: [...record.sourceSpanIds].sort(compareAscii),
      };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO learning_event
           (id, owner_scope_id, user_id, session_id, event_type,
            idempotency_key, payload, occurred_at, event_version, producer,
            correlation_id)
         VALUES (
           $1, $2, $3, $4, 'question_asked', $5, $6::jsonb, now(), 1,
           'tutor-agent-v1', $4
         )
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          id,
          session.owner_scope_id,
          session.user_id,
          session.session_id,
          record.idempotencyKey,
          JSON.stringify(payload),
        ],
      );
      if (inserted.rows[0]?.id === id) {
        return;
      }
      const existing = await client.query<{ matches: boolean }>(
        `SELECT (
           id = $1
           AND owner_scope_id = $2
           AND user_id = $3
           AND session_id = $4
           AND event_type = 'question_asked'
           AND payload = $6::jsonb
           AND event_version = 1
           AND producer = 'tutor-agent-v1'
           AND correlation_id = $4
         ) AS matches
         FROM learning_event
         WHERE owner_scope_id = $2
           AND (id = $1 OR idempotency_key = $5)`,
        [
          id,
          session.owner_scope_id,
          session.user_id,
          session.session_id,
          record.idempotencyKey,
          JSON.stringify(payload),
        ],
      );
      if (existing.rows[0]?.matches !== true) {
        throw new TutorAgentError("invalid_result");
      }
    });
  }

  async scheduleLaterReview(
    authorization: ScopeAuthorizationContext,
    request: LaterReviewRequest,
  ): Promise<{ readonly nextDeliveryAt: string }> {
    validateAuthorization(authorization);
    validateUuid(request.sessionId);
    validateUuid(request.conceptId);
    validateUuid(request.causationId);
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const session = await loadAuthorizedSession(
        client,
        authorization,
        request.sessionId,
        true,
      );
      if (session === null) {
        throw new TutorAgentError("authorization_denied");
      }
      const schedule = await client.query<{ next_delivery_at: Date }>(
        `SELECT schedule.next_delivery_at
         FROM review_schedule AS schedule
         WHERE schedule.owner_scope_id = $1
           AND schedule.user_id = $2
           AND schedule.concept_id = $3
           AND EXISTS (
             SELECT 1
             FROM attempt_concept_evidence AS evidence
             JOIN attempt
               ON attempt.owner_scope_id = evidence.owner_scope_id
              AND attempt.id = evidence.attempt_id
             WHERE evidence.owner_scope_id = schedule.owner_scope_id
               AND evidence.attempt_id = $4
               AND evidence.concept_id = schedule.concept_id
               AND evidence.attempt_user_id = schedule.user_id
               AND evidence.eligible_for_mastery
               AND evidence.rubric_band <> 'correct'
               AND attempt.session_id = $5
           )
         FOR SHARE`,
        [
          session.owner_scope_id,
          session.user_id,
          request.conceptId,
          request.causationId,
          session.session_id,
        ],
      );
      const nextDeliveryAt = schedule.rows[0]?.next_delivery_at;
      if (nextDeliveryAt === undefined) {
        throw new TutorAgentError("invalid_session");
      }
      const eventId = stableUuid({
        attemptId: request.causationId,
        conceptId: request.conceptId,
        event: "review_scheduled",
        sessionId: request.sessionId,
      });
      const idempotencyKey = `tutor-agent-v1/review-scheduled/${eventId}`;
      const payload = {
        courseId: session.course_id,
        nextDeliveryAt: nextDeliveryAt.toISOString(),
        reason: "reteach_follow_up",
      };
      await client.query(
        `INSERT INTO learning_event
           (id, owner_scope_id, user_id, session_id, attempt_id, event_type,
            idempotency_key, payload, occurred_at, event_version, producer,
            correlation_id, causation_id)
         VALUES (
           $1, $2, $3, $4, $5, 'review_scheduled', $6, $7::jsonb, now(), 1,
           'tutor-agent-v1', $4, $5
         )
         ON CONFLICT DO NOTHING`,
        [
          eventId,
          session.owner_scope_id,
          session.user_id,
          session.session_id,
          request.causationId,
          idempotencyKey,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `INSERT INTO learning_event_concept
           (owner_scope_id, learning_event_id, concept_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [session.owner_scope_id, eventId, request.conceptId],
      );
      return { nextDeliveryAt: nextDeliveryAt.toISOString() };
    });
  }

  async #recordLoopResult(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
    outcome: TutorLoopResult["outcome"],
  ): Promise<TutorLoopResult> {
    validateAuthorization(authorization);
    validateUuid(record.sessionId);
    validateUuid(record.conceptId);
    validateUuid(record.latestAttemptId);
    validateMastery(record.initialMastery);
    validateMastery(record.finalMastery);
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const session = await loadAuthorizedSession(
        client,
        authorization,
        record.sessionId,
        true,
      );
      if (session === null) {
        throw new TutorAgentError("authorization_denied");
      }
      const existing = loopResultFromSummary(session.summary, record.conceptId);
      if (existing !== null) {
        if (
          existing.outcome !== outcome ||
          existing.initialMastery !== record.initialMastery ||
          existing.finalMastery !== record.finalMastery ||
          existing.evidenceAttemptId !== record.latestAttemptId ||
          existing.replacementCount !== record.replacementCount
        ) {
          throw new TutorAgentError("invalid_result");
        }
        return existing;
      }
      await assertLoopResultEvidence(client, session, record, outcome);
      const timestamp = await client.query<{ completed_at: Date }>(
        "SELECT now() AS completed_at",
      );
      const result: TutorLoopResult = {
        completedAt: timestamp.rows[0]!.completed_at.toISOString(),
        conceptId: record.conceptId,
        evidenceAttemptId: record.latestAttemptId,
        finalMastery: record.finalMastery,
        initialMastery: record.initialMastery,
        masteryDelta: masteryDelta(record.finalMastery, record.initialMastery),
        outcome,
        replacementCount: record.replacementCount,
      };
      const updated = await client.query<{ session_id: string }>(
        `UPDATE study_session
         SET summary =
           coalesce(summary, '{}'::jsonb)
           || jsonb_build_object(
             'flowB',
             coalesce(summary->'flowB', '{}'::jsonb)
             || jsonb_build_object($3::text, $4::jsonb)
           )
         WHERE owner_scope_id = $1 AND id = $2
         RETURNING id AS session_id`,
        [
          session.owner_scope_id,
          session.session_id,
          record.conceptId,
          JSON.stringify(result),
        ],
      );
      if (updated.rows[0]?.session_id !== session.session_id) {
        throw new TutorAgentError("invalid_result");
      }
      return result;
    });
  }

  async #transaction<Result>(
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadAuthorizedSession(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
  sessionId: string,
  forUpdate: boolean,
): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT study.id AS session_id, study.owner_scope_id, study.user_id,
            study.course_id, study.status, study.summary,
            course.source_document_id
     FROM study_session AS study
     JOIN course
       ON course.owner_scope_id = study.owner_scope_id
      AND course.id = study.course_id
     JOIN source_document AS source
       ON source.owner_scope_id = course.owner_scope_id
      AND source.id = course.source_document_id
     JOIN owner_scope AS scope ON scope.id = study.owner_scope_id
     JOIN app_user AS actor ON actor.id = $1
     JOIN scope_membership AS membership
       ON membership.owner_scope_id = study.owner_scope_id
      AND membership.user_id = actor.id
     WHERE study.owner_scope_id = $2 AND study.id = $3
       AND study.user_id = $1 AND study.status = 'active'
       AND course.status IN ('generating', 'ready')
       AND source.parse_status = 'parsed'
       AND source.retention_status = 'active'
       AND scope.status = 'active' AND actor.status = 'active'
       AND membership.role = 'owner' AND membership.revoked_at IS NULL
     ${forUpdate ? "FOR UPDATE OF study" : "FOR SHARE OF study"}`,
    [authorization.actorId, authorization.ownerScopeId, sessionId],
  );
  return result.rows[0] ?? null;
}

async function loadConceptRows(
  client: PoolClient,
  session: SessionRow,
): Promise<readonly ConceptRow[]> {
  const result = await client.query<ConceptRow>(
    `SELECT
       concept.id AS concept_id,
       concept.name AS concept_name,
       concept.chapter_id,
       coalesce(state.mastery, 0.25000)::text AS mastery,
       coalesce(evidence_count.count, 0)::integer AS eligible_attempt_count,
       latest.attempt_id AS latest_attempt_id,
       latest.created_at AS latest_attempt_created_at,
       latest.quiz_item_id AS latest_attempt_quiz_item_id,
       latest.rubric_band AS latest_attempt_rubric_band,
       latest.score::text AS latest_attempt_score,
       exposure.occurred_at AS latest_lesson_exposure_at,
       coalesce(exposure.asset_id, initial_asset.id) AS lesson_asset_id,
       coalesce(exposure.content_hash, initial_asset.content_hash)
         AS lesson_content_hash,
       coalesce(exposure.asset_type, initial_asset.asset_type)
         AS lesson_modality,
       coalesce(exposure.object_key, initial_asset.object_key)
         AS lesson_object_key,
       coalesce(exposure.occurred_at, initial_asset.created_at)
         AS lesson_served_at,
       coalesce(exposure.strategy_tag, initial_asset.strategy_tag)
         AS lesson_strategy_tag,
       (session.summary->'flowB'->concept.id::text) AS loop_result,
       coalesce(schedule.next_delivery_at <= now(), false) AS due_for_review
     FROM concept
     JOIN chapter
       ON chapter.owner_scope_id = concept.owner_scope_id
      AND chapter.id = concept.chapter_id
      AND chapter.course_id = $3
     CROSS JOIN study_session AS session
     LEFT JOIN knowledge_state AS state
       ON state.owner_scope_id = concept.owner_scope_id
      AND state.user_id = $2
      AND state.concept_id = concept.id
     LEFT JOIN review_schedule AS schedule
       ON schedule.owner_scope_id = concept.owner_scope_id
      AND schedule.user_id = $2
      AND schedule.concept_id = concept.id
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS count
       FROM attempt_concept_evidence
       WHERE owner_scope_id = concept.owner_scope_id
         AND attempt_user_id = $2
         AND concept_id = concept.id
         AND eligible_for_mastery
     ) AS evidence_count ON true
     LEFT JOIN LATERAL (
       SELECT evidence.attempt_id, evidence.attempt_created_at AS created_at,
              attempt.quiz_item_id, evidence.rubric_band,
              evidence.score
       FROM attempt_concept_evidence AS evidence
       JOIN attempt
         ON attempt.owner_scope_id = evidence.owner_scope_id
        AND attempt.id = evidence.attempt_id
       WHERE evidence.owner_scope_id = concept.owner_scope_id
         AND evidence.attempt_user_id = $2
         AND evidence.concept_id = concept.id
         AND evidence.eligible_for_mastery
       ORDER BY evidence.attempt_created_at DESC, evidence.attempt_id DESC
       LIMIT 1
     ) AS latest ON true
     LEFT JOIN LATERAL (
       SELECT event.occurred_at, asset.id AS asset_id, asset.content_hash,
              asset.asset_type, asset.object_key, asset.strategy_tag
       FROM learning_event_concept AS event_concept
       JOIN learning_event AS event
         ON event.owner_scope_id = event_concept.owner_scope_id
        AND event.id = event_concept.learning_event_id
       LEFT JOIN asset
         ON asset.owner_scope_id = event.owner_scope_id
        AND asset.id::text = event.payload->>'assetId'
       WHERE event_concept.owner_scope_id = concept.owner_scope_id
         AND event_concept.concept_id = concept.id
         AND event.user_id = $2
         AND event.session_id = $4
         AND event.event_type = 'lesson_completed'
       ORDER BY event.occurred_at DESC, event.id DESC
       LIMIT 1
     ) AS exposure ON true
     LEFT JOIN LATERAL (
       SELECT asset.id, asset.content_hash, asset.asset_type, asset.object_key,
              asset.strategy_tag, asset.created_at
       FROM asset
       WHERE asset.owner_scope_id = concept.owner_scope_id
         AND asset.course_id = $3 AND asset.concept_id = concept.id
         AND asset.asset_type = 'text' AND asset.status = 'ready'
         AND asset.reteach_session_id IS NULL
       ORDER BY asset.created_at DESC, asset.id DESC
       LIMIT 1
     ) AS initial_asset ON true
     WHERE concept.owner_scope_id = $1
       AND session.owner_scope_id = $1 AND session.id = $4
     ORDER BY chapter.chapter_order, concept.concept_order, concept.id`,
    [
      session.owner_scope_id,
      session.user_id,
      session.course_id,
      session.session_id,
    ],
  );
  return result.rows;
}

async function loadSourceSpans(
  client: PoolClient,
  session: SessionRow,
): Promise<readonly SourceSpanRow[]> {
  const result = await client.query<SourceSpanRow>(
    `SELECT link.concept_id, span.id AS source_span_id,
            span.canonical_text AS source_text
     FROM concept_source_span AS link
     JOIN concept
       ON concept.owner_scope_id = link.owner_scope_id
      AND concept.id = link.concept_id
     JOIN chapter
       ON chapter.owner_scope_id = concept.owner_scope_id
      AND chapter.id = concept.chapter_id
      AND chapter.course_id = $2
     JOIN source_span AS span
       ON span.owner_scope_id = link.owner_scope_id
      AND span.id = link.source_span_id
      AND span.source_document_id = $3
     WHERE link.owner_scope_id = $1
     ORDER BY concept.concept_order, span.chunk_order, span.id`,
    [session.owner_scope_id, session.course_id, session.source_document_id],
  );
  return result.rows;
}

async function loadReteaches(
  client: PoolClient,
  session: SessionRow,
): Promise<readonly ReteachRow[]> {
  const result = await client.query<ReteachRow>(
    `SELECT asset.id AS asset_id, asset.chapter_id, asset.concept_id,
            asset.object_key, asset.content_hash, asset.strategy_tag,
            asset.reteach_replacement_ordinal AS replacement_ordinal,
            asset.reteach_baseline_mastery::text AS baseline_mastery,
            asset.reteach_semantic_similarity::text AS semantic_similarity,
            asset.reteach_generation_id AS generation_id,
            asset.reteach_served_at AS served_at, asset.model_provenance,
            array_agg(link.source_span_id ORDER BY link.source_span_id)
              AS source_span_ids
     FROM asset
     JOIN asset_source_span AS link
       ON link.owner_scope_id = asset.owner_scope_id
      AND link.asset_id = asset.id
     WHERE asset.owner_scope_id = $1 AND asset.reteach_session_id = $2
     GROUP BY asset.owner_scope_id, asset.id
     ORDER BY asset.concept_id, asset.reteach_replacement_ordinal`,
    [session.owner_scope_id, session.session_id],
  );
  return result.rows;
}

async function loadRetestQuestions(
  client: PoolClient,
  session: SessionRow,
  itemTypes: readonly TutorRetestQuestion["itemType"][],
): Promise<readonly QuestionRow[]> {
  const result = await client.query<QuestionRow>(
    `SELECT link.concept_id, item.id AS item_id, item.item_type,
            item.difficulty, item.prompt, item.response_options,
            array_agg(source.source_span_id ORDER BY source.source_span_id)
              AS source_span_ids
     FROM quiz_item AS item
     JOIN quiz_item_concept AS link
       ON link.owner_scope_id = item.owner_scope_id
      AND link.quiz_item_id = item.id
     JOIN quiz_item_source_span AS source
       ON source.owner_scope_id = item.owner_scope_id
      AND source.quiz_item_id = item.id
     WHERE item.owner_scope_id = $1 AND item.course_id = $2
       AND item.normalized_prompt_hash IS NOT NULL
       AND item.item_type::text = ANY($4::text[])
       AND (
         SELECT count(*)
         FROM quiz_item_concept AS all_concepts
         WHERE all_concepts.owner_scope_id = item.owner_scope_id
           AND all_concepts.quiz_item_id = item.id
       ) = 1
       AND NOT EXISTS (
         SELECT 1
         FROM assessment_session_question AS presented
         WHERE presented.owner_scope_id = item.owner_scope_id
           AND presented.session_id = $3
           AND presented.normalized_prompt_hash = item.normalized_prompt_hash
       )
       AND NOT EXISTS (
         SELECT 1
         FROM attempt
         WHERE attempt.owner_scope_id = item.owner_scope_id
           AND attempt.session_id = $3
           AND attempt.quiz_item_id = item.id
       )
     GROUP BY link.concept_id, item.id
     ORDER BY link.concept_id, item.difficulty, item.item_order, item.id`,
    [session.owner_scope_id, session.course_id, session.session_id, itemTypes],
  );
  return result.rows;
}

function materializeSession(
  authorization: ScopeAuthorizationContext,
  session: SessionRow,
  conceptRows: readonly ConceptRow[],
  spanRows: readonly SourceSpanRow[],
  reteachRows: readonly ReteachRow[],
  questionRows: readonly QuestionRow[],
): TutorSessionSnapshot {
  const spans = groupBy(spanRows, (row) => row.concept_id);
  const reteaches = groupBy(reteachRows, (row) => row.concept_id);
  const questions = groupBy(questionRows, (row) => row.concept_id);
  return {
    actorId: authorization.actorId,
    authorizationId: authorization.authorizationId,
    concepts: conceptRows.map((row) => ({
      chapterId: row.chapter_id,
      conceptId: row.concept_id,
      conceptName: row.concept_name,
      dueForReview: row.due_for_review,
      eligibleAttemptCount: row.eligible_attempt_count,
      latestEligibleAttempt: materializeAttempt(row),
      latestLessonExposureAt:
        row.latest_lesson_exposure_at?.toISOString() ?? null,
      lesson: materializeLesson(row),
      loopResult: row.loop_result,
      mastery: row.mastery,
      nextRetestQuestion: materializeQuestion(
        questions.get(row.concept_id)?.[0],
      ),
      reteachLessons: (reteaches.get(row.concept_id) ?? []).map((reteach) => ({
        assetId: reteach.asset_id,
        baselineMastery: reteach.baseline_mastery,
        chapterId: reteach.chapter_id,
        conceptId: reteach.concept_id,
        contentHash: reteach.content_hash,
        generationId: reteach.generation_id,
        generationVersion: RETEACH_GENERATION_VERSION,
        modality: "text",
        modelProvenance: reteach.model_provenance,
        objectKey: reteach.object_key,
        ownerScopeId: session.owner_scope_id,
        replacementOrdinal: reteach.replacement_ordinal,
        semanticSimilarity: reteach.semantic_similarity,
        servedAt: reteach.served_at.toISOString(),
        sessionId: session.session_id,
        sourceSpanIds: reteach.source_span_ids,
        strategyTag: reteach.strategy_tag,
      })),
      sourceSpans: (spans.get(row.concept_id) ?? []).map((span) => ({
        id: span.source_span_id,
        text: span.source_text,
      })),
    })),
    courseId: session.course_id,
    ownerScopeId: session.owner_scope_id,
    sessionId: session.session_id,
    sourceDocumentId: session.source_document_id,
    status: "active",
    userId: session.user_id,
  };
}

function materializeAttempt(row: ConceptRow): TutorAttemptEvidence | null {
  if (
    row.latest_attempt_id === null ||
    row.latest_attempt_created_at === null ||
    row.latest_attempt_quiz_item_id === null ||
    row.latest_attempt_rubric_band === null ||
    !isEvidenceScore(row.latest_attempt_score)
  ) {
    return null;
  }
  return {
    attemptId: row.latest_attempt_id,
    createdAt: row.latest_attempt_created_at.toISOString(),
    eligibleForMastery: true,
    quizItemId: row.latest_attempt_quiz_item_id,
    rubricBand: row.latest_attempt_rubric_band,
    score: row.latest_attempt_score,
  };
}

function materializeLesson(row: ConceptRow): TutorLessonReference | null {
  if (
    row.lesson_asset_id === null ||
    row.lesson_content_hash === null ||
    row.lesson_modality === null ||
    row.lesson_object_key === null ||
    row.lesson_served_at === null ||
    row.lesson_strategy_tag === null
  ) {
    return null;
  }
  return {
    assetId: row.lesson_asset_id,
    contentHash: row.lesson_content_hash,
    modality: row.lesson_modality,
    objectKey: row.lesson_object_key,
    servedAt: row.lesson_served_at.toISOString(),
    strategyTag: row.lesson_strategy_tag,
  };
}

function materializeQuestion(
  row: QuestionRow | undefined,
): TutorRetestQuestion | null {
  return row === undefined
    ? null
    : {
        conceptId: row.concept_id,
        difficulty: row.difficulty,
        itemId: row.item_id,
        itemType: row.item_type,
        prompt: row.prompt,
        ...(row.response_options === null
          ? {}
          : { responseOptions: row.response_options }),
        sourceSpanIds: row.source_span_ids,
      };
}

async function assertReteachState(
  client: PoolClient,
  session: SessionRow,
  request: ReteachPersistenceRequest,
): Promise<void> {
  const state = await client.query<{
    baseline_mastery: string | null;
    current_mastery: string;
    replacement_count: number;
  }>(
    `SELECT state.mastery::text AS current_mastery,
            min(asset.reteach_baseline_mastery)::text AS baseline_mastery,
            count(asset.id)::integer AS replacement_count
     FROM knowledge_state AS state
     LEFT JOIN asset
       ON asset.owner_scope_id = state.owner_scope_id
      AND asset.concept_id = state.concept_id
      AND asset.reteach_session_id = $4
     WHERE state.owner_scope_id = $1 AND state.user_id = $2
       AND state.concept_id = $3
     GROUP BY state.mastery`,
    [
      session.owner_scope_id,
      session.user_id,
      request.generated.conceptId,
      session.session_id,
    ],
  );
  const row = state.rows[0];
  const expectedBaseline =
    row?.replacement_count === 0 ? row.current_mastery : row?.baseline_mastery;
  const expectedNewCount = request.generated.replacementOrdinal - 1;
  const expectedReplayCount = request.generated.replacementOrdinal;
  if (
    row === undefined ||
    (row.replacement_count !== expectedNewCount &&
      row.replacement_count !== expectedReplayCount) ||
    expectedBaseline !== request.generated.baselineMastery
  ) {
    throw new TutorAgentError("invalid_session");
  }
}

async function assertAuthorizedSpans(
  client: PoolClient,
  session: SessionRow,
  conceptId: string,
  sourceSpanIds: readonly string[],
): Promise<void> {
  if (
    sourceSpanIds.length === 0 ||
    new Set(sourceSpanIds).size !== sourceSpanIds.length
  ) {
    throw new TutorAgentError("invalid_result");
  }
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM concept_source_span AS link
     JOIN source_span AS span
       ON span.owner_scope_id = link.owner_scope_id
      AND span.id = link.source_span_id
     WHERE link.owner_scope_id = $1 AND link.concept_id = $2
       AND span.source_document_id = $3
       AND span.id = ANY($4::uuid[])`,
    [
      session.owner_scope_id,
      conceptId,
      session.source_document_id,
      sourceSpanIds,
    ],
  );
  if (result.rows[0]?.count !== sourceSpanIds.length) {
    throw new TutorAgentError("authorization_denied");
  }
}

async function insertAssetSourceSpans(
  client: PoolClient,
  ownerScopeId: string,
  assetId: string,
  sourceSpanIds: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO asset_source_span (owner_scope_id, asset_id, source_span_id)
     SELECT $1, $2, span.id
     FROM source_span AS span
     WHERE span.owner_scope_id = $1 AND span.id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING`,
    [ownerScopeId, assetId, sourceSpanIds],
  );
  const persisted = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM asset_source_span
     WHERE owner_scope_id = $1 AND asset_id = $2
       AND source_span_id = ANY($3::uuid[])`,
    [ownerScopeId, assetId, sourceSpanIds],
  );
  if (persisted.rows[0]?.count !== sourceSpanIds.length) {
    throw new TutorAgentError("invalid_result");
  }
}

async function appendReteachEvent(
  client: PoolClient,
  session: SessionRow,
  request: ReteachPersistenceRequest,
  servedAt: Date,
): Promise<void> {
  const eventId = stableUuid({
    assetId: request.generated.assetId,
    event: "reteach_served",
    sessionId: session.session_id,
  });
  const idempotencyKey = `tutor-agent-v1/reteach-served/${request.generated.assetId}`;
  const payload = {
    assetId: request.generated.assetId,
    chapterId: request.generated.chapterId,
    courseId: session.course_id,
    modality: "text",
    strategyTag: request.generated.strategyTag,
  };
  await client.query(
    `INSERT INTO learning_event
       (id, owner_scope_id, user_id, session_id, attempt_id, event_type,
        idempotency_key, payload, occurred_at, event_version, producer,
        correlation_id, causation_id)
     VALUES (
       $1, $2, $3, $4, NULL, 'reteach_served', $5, $6::jsonb, $7, 1,
       'tutor-agent-v1', $4, $8
     )
     ON CONFLICT DO NOTHING`,
    [
      eventId,
      session.owner_scope_id,
      session.user_id,
      session.session_id,
      idempotencyKey,
      JSON.stringify(payload),
      servedAt,
      request.concept.latestEligibleAttempt?.attemptId ?? null,
    ],
  );
  const event = await client.query<{ matches: boolean }>(
    `SELECT (
       owner_scope_id = $2 AND user_id = $3 AND session_id = $4
       AND event_type = 'reteach_served' AND idempotency_key = $5
       AND payload = $6::jsonb AND occurred_at = $7::timestamptz
       AND event_version = 1 AND producer = 'tutor-agent-v1'
       AND correlation_id = $4
       AND causation_id IS NOT DISTINCT FROM $8::uuid
     ) AS matches
     FROM learning_event
     WHERE owner_scope_id = $2 AND id = $1`,
    [
      eventId,
      session.owner_scope_id,
      session.user_id,
      session.session_id,
      idempotencyKey,
      JSON.stringify(payload),
      servedAt,
      request.concept.latestEligibleAttempt?.attemptId ?? null,
    ],
  );
  if (event.rows[0]?.matches !== true) {
    throw new TutorAgentError("invalid_result");
  }
  await client.query(
    `INSERT INTO learning_event_concept
       (owner_scope_id, learning_event_id, concept_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [session.owner_scope_id, eventId, request.generated.conceptId],
  );
}

async function assertLoopResultEvidence(
  client: PoolClient,
  session: SessionRow,
  record: LoopSuccessRecord,
  outcome: TutorLoopResult["outcome"],
): Promise<void> {
  const state = await client.query<{
    baseline_mastery: string;
    mastery: string;
    replacement_count: number;
  }>(
    `SELECT state.mastery::text AS mastery,
            min(asset.reteach_baseline_mastery)::text AS baseline_mastery,
            count(asset.id)::integer AS replacement_count
     FROM knowledge_state AS state
     JOIN asset
       ON asset.owner_scope_id = state.owner_scope_id
      AND asset.concept_id = state.concept_id
      AND asset.reteach_session_id = $4
     WHERE state.owner_scope_id = $1 AND state.user_id = $2
       AND state.concept_id = $3
     GROUP BY state.mastery`,
    [
      session.owner_scope_id,
      session.user_id,
      record.conceptId,
      session.session_id,
    ],
  );
  const row = state.rows[0];
  if (
    row === undefined ||
    row.mastery !== record.finalMastery ||
    row.baseline_mastery !== record.initialMastery ||
    row.replacement_count !== record.replacementCount
  ) {
    throw new TutorAgentError("invalid_result");
  }
  if (outcome === "retest_succeeded") {
    const attemptId = record.latestAttemptId;
    validateUuid(attemptId);
    const evidence = await client.query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM attempt_concept_evidence AS evidence
         JOIN attempt
           ON attempt.owner_scope_id = evidence.owner_scope_id
          AND attempt.id = evidence.attempt_id
         WHERE evidence.owner_scope_id = $1
           AND evidence.concept_id = $2
           AND evidence.attempt_id = $3
           AND evidence.attempt_user_id = $4
           AND evidence.eligible_for_mastery
           AND evidence.rubric_band = 'correct'
           AND evidence.score = 1.00000
           AND attempt.session_id = $5
           AND evidence.attempt_created_at > (
             SELECT max(reteach_served_at)
             FROM asset
             WHERE owner_scope_id = $1 AND concept_id = $2
               AND reteach_session_id = $5
           )
       ) AS eligible`,
      [
        session.owner_scope_id,
        record.conceptId,
        attemptId,
        session.user_id,
        session.session_id,
      ],
    );
    if (
      evidence.rows[0]?.eligible !== true ||
      compareMastery(record.finalMastery, record.initialMastery) <= 0
    ) {
      throw new TutorAgentError("invalid_result");
    }
    return;
  }
  const failed = await client.query<{ eligible: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM attempt_concept_evidence AS evidence
       JOIN attempt
         ON attempt.owner_scope_id = evidence.owner_scope_id
        AND attempt.id = evidence.attempt_id
       WHERE evidence.owner_scope_id = $1
         AND evidence.concept_id = $2
         AND evidence.attempt_user_id = $3
         AND evidence.attempt_id = $5
         AND evidence.eligible_for_mastery
         AND evidence.rubric_band <> 'correct'
         AND attempt.session_id = $4
         AND evidence.attempt_created_at > (
           SELECT max(reteach_served_at)
           FROM asset
           WHERE owner_scope_id = $1 AND concept_id = $2
             AND reteach_session_id = $4
         )
     ) AS eligible`,
    [
      session.owner_scope_id,
      record.conceptId,
      session.user_id,
      session.session_id,
      record.latestAttemptId,
    ],
  );
  if (record.replacementCount !== 2 || failed.rows[0]?.eligible !== true) {
    throw new TutorAgentError("invalid_result");
  }
}

function validateGeneratedReteach(
  authorization: ScopeAuthorizationContext,
  request: ReteachPersistenceRequest,
): void {
  validateAuthorization(authorization);
  for (const id of [
    request.generated.assetId,
    request.generated.chapterId,
    request.generated.conceptId,
    request.generated.generationId,
    request.generated.sessionId,
  ]) {
    validateUuid(id);
  }
  validateMastery(request.generated.baselineMastery);
  if (
    request.generated.ownerScopeId !== authorization.ownerScopeId ||
    request.generated.sessionId !== request.session.sessionId ||
    request.generated.conceptId !== request.concept.conceptId ||
    request.generated.chapterId !== request.concept.chapterId ||
    request.generated.generationVersion !== RETEACH_GENERATION_VERSION ||
    !/^[0-9a-f]{64}$/.test(request.generated.contentHash) ||
    request.generated.storage.objectKey !== request.generated.objectKey ||
    request.generated.storage.contentType !== "text/markdown; charset=utf-8" ||
    request.generated.storage.byteSize < 1 ||
    request.generated.storage.etag.length === 0 ||
    request.generated.modelProvenance.task !== "lesson.reteach.v1" ||
    request.generated.modelProvenance.validationOutcome !== "passed" ||
    !/^-?(?:0|1)(?:\.\d{5})$/.test(request.generated.semanticSimilarity) ||
    Number(request.generated.semanticSimilarity) >= 0.85
  ) {
    throw new TutorAgentError("invalid_result");
  }
}

function loopResultFromSummary(
  summary: Record<string, unknown> | null,
  conceptId: string,
): TutorLoopResult | null {
  const flowB =
    summary?.flowB !== null && typeof summary?.flowB === "object"
      ? (summary.flowB as Record<string, unknown>)
      : null;
  const value = flowB?.[conceptId];
  return value !== null && typeof value === "object"
    ? (value as TutorLoopResult)
    : null;
}

function masteryDelta(finalMastery: string, initialMastery: string): string {
  return (
    (masteryUnits(finalMastery) - masteryUnits(initialMastery)) /
    100_000
  ).toFixed(5);
}

function compareMastery(left: string, right: string): number {
  return masteryUnits(left) - masteryUnits(right);
}

function masteryUnits(value: string): number {
  validateMastery(value);
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100_000 + Number(fraction.padEnd(5, "0"));
}

function validateMastery(value: string): void {
  if (!/^(?:0(?:\.\d{1,5})?|1(?:\.0{1,5})?)$/.test(value)) {
    throw new TutorAgentError("invalid_result");
  }
}

function validateAuthorization(authorization: ScopeAuthorizationContext): void {
  if (
    !isUuid(authorization.actorId) ||
    authorization.authorizationId.length === 0 ||
    authorization.authorizationId.length > 240 ||
    !isUuid(authorization.ownerScopeId)
  ) {
    throw new TutorAgentError("authorization_denied");
  }
}

function validateUuid(value: string): void {
  if (!isUuid(value)) {
    throw new TutorAgentError("invalid_result");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function validateIdempotencyKey(value: string): void {
  if (value.length < 1 || value.length > 240) {
    throw new TutorAgentError("invalid_result");
  }
}

function isEvidenceScore(
  value: string | null,
): value is TutorAttemptEvidence["score"] {
  return value === "0.00000" || value === "0.50000" || value === "1.00000";
}

function groupBy<Row>(
  rows: readonly Row[],
  key: (row: Row) => string,
): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function setScopeContext(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
): Promise<void> {
  await client.query(
    `SELECT set_config('reflo.actor_id', $1, true),
            set_config('reflo.owner_scope_id', $2, true)`,
    [authorization.actorId, authorization.ownerScopeId],
  );
}
