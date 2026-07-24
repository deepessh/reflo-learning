import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  replayKnowledgeState,
  type AssessmentEvidenceWrite,
  type ExactKnowledgeState,
  type KnowledgeAuthorizationContext,
  type LearningEventV1,
  type PerConceptEvidence,
} from "@reflo/knowledge-model";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;
const learningEventNames = new Set<LearningEventV1["name"]>([
  "assessment_graded",
  "assessment_submitted",
  "course_opened",
  "delivery_received",
  "lesson_abandoned",
  "lesson_completed",
  "lesson_started",
  "question_asked",
  "question_presented",
  "reteach_served",
  "review_rescheduled",
  "review_scheduled",
  "session_abandoned",
  "session_completed",
  "session_started",
]);

export type KnowledgePersistenceErrorCode =
  | "authorization_denied"
  | "conflicting_duplicate"
  | "invalid_configuration"
  | "invalid_evidence"
  | "invalid_event";

export class KnowledgePersistenceError extends Error {
  constructor(readonly code: KnowledgePersistenceErrorCode) {
    super(code);
    this.name = "KnowledgePersistenceError";
  }
}

export interface LearningEventAppendResult {
  readonly event: LearningEventV1;
  readonly status: "appended" | "replayed";
}

interface EvidenceRow extends Record<string, unknown> {
  attempt_created_at: Date;
  attempt_id: string;
  concept_id: string;
  eligible_for_mastery: boolean;
  knowledge_algorithm_version: string;
  knowledge_configuration_id: string;
  owner_scope_id: string;
  score: string | null;
  user_id: string;
}

interface EventRow extends Record<string, unknown> {
  attempt_id: string | null;
  causation_id: string | null;
  correlation_id: string;
  delivery_id: string | null;
  event_type: LearningEventV1["name"];
  event_version: number;
  id: string;
  idempotency_key: string;
  occurred_at: Date;
  owner_scope_id: string;
  payload: LearningEventV1["payload"];
  producer: string;
  session_id: string | null;
  user_id: string;
}

export class PostgresKnowledgeRepository {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new KnowledgePersistenceError("invalid_configuration");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async appendLearningEvent(
    authorization: KnowledgeAuthorizationContext,
    event: LearningEventV1,
  ): Promise<LearningEventAppendResult> {
    validateLearningEvent(authorization, event);
    const conceptIds = [...new Set(event.conceptIds)].sort(compareAscii);

    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO learning_event
           (id, owner_scope_id, user_id, session_id, delivery_id, attempt_id,
            event_type, event_version, producer, correlation_id, causation_id,
            idempotency_key, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13::jsonb, $14)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          event.id,
          event.ownerScopeId,
          event.userId,
          event.sessionId,
          event.deliveryId,
          event.attemptId,
          event.name,
          event.eventVersion,
          event.producer,
          event.correlationId,
          event.causationId,
          event.idempotencyKey,
          JSON.stringify(event.payload),
          event.occurredAt,
        ],
      );

      if (inserted.rows[0] === undefined) {
        const current = await loadEventByIdentity(
          client,
          event.id,
          event.idempotencyKey,
        );
        if (current === null) {
          throw new KnowledgePersistenceError("conflicting_duplicate");
        }
        const currentConceptIds = await loadEventConceptIds(
          client,
          current.owner_scope_id,
          current.id,
        );
        if (!sameLearningEvent(current, currentConceptIds, event, conceptIds)) {
          throw new KnowledgePersistenceError("conflicting_duplicate");
        }
        return { event, status: "replayed" };
      }

      for (const conceptId of conceptIds) {
        const linked = await client.query<{ concept_id: string }>(
          `INSERT INTO learning_event_concept
             (owner_scope_id, learning_event_id, concept_id)
           SELECT $1, $2, concept.id
           FROM concept
           WHERE concept.owner_scope_id = $1 AND concept.id = $3
           ON CONFLICT DO NOTHING
           RETURNING concept_id`,
          [event.ownerScopeId, event.id, conceptId],
        );
        if (linked.rows[0]?.concept_id !== conceptId) {
          throw new KnowledgePersistenceError("authorization_denied");
        }
      }
      return { event, status: "appended" };
    });
  }

  async recordEvidenceAndReplay(
    authorization: KnowledgeAuthorizationContext,
    evidence: AssessmentEvidenceWrite,
  ): Promise<ExactKnowledgeState> {
    validateEvidenceWrite(evidence);

    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const attempt = await client.query<{ created_at: Date }>(
        `SELECT attempt.created_at
         FROM attempt
         JOIN quiz_item_concept
           ON quiz_item_concept.owner_scope_id = attempt.owner_scope_id
          AND quiz_item_concept.quiz_item_id = attempt.quiz_item_id
          AND quiz_item_concept.concept_id = $4
         WHERE attempt.owner_scope_id = $1
           AND attempt.user_id = $2
           AND attempt.id = $3`,
        [
          authorization.ownerScopeId,
          authorization.actorId,
          evidence.attemptId,
          evidence.conceptId,
        ],
      );
      if (attempt.rows[0] === undefined) {
        throw new KnowledgePersistenceError("authorization_denied");
      }

      const empty = replayKnowledgeState([]);
      await client.query(
        `INSERT INTO knowledge_state
           (owner_scope_id, user_id, concept_id, mastery, confidence, half_life,
            last_reviewed_at, review_count, algorithm_version, alpha_quanta,
            beta_quanta, evidence_count, assessment_status,
            knowledge_configuration_id)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, 0, $6, $7, $8, 0, $9, $10)
         ON CONFLICT (owner_scope_id, user_id, concept_id) DO NOTHING`,
        [
          authorization.ownerScopeId,
          authorization.actorId,
          evidence.conceptId,
          empty.mastery,
          empty.confidence,
          empty.algorithmVersion,
          empty.alphaQuanta,
          empty.betaQuanta,
          empty.assessmentStatus,
          empty.configurationId,
        ],
      );
      await client.query(
        `SELECT 1
         FROM knowledge_state
         WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3
         FOR UPDATE`,
        [authorization.ownerScopeId, authorization.actorId, evidence.conceptId],
      );

      const inserted = await client.query<{ attempt_id: string }>(
        `INSERT INTO attempt_concept_evidence
           (owner_scope_id, attempt_id, concept_id, score, rubric_band,
            grader_confidence, rationale_ref, knowledge_algorithm_version,
            eligible_for_mastery, judgment_kind, grading_method, rubric_id,
            rubric_version, grading_policy_version, rating_mapping_version,
            knowledge_configuration_id, ineligibility_reason, fsrs_rating,
            replacement_for_attempt_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19)
         ON CONFLICT DO NOTHING
         RETURNING attempt_id`,
        [
          authorization.ownerScopeId,
          evidence.attemptId,
          evidence.conceptId,
          evidence.score,
          evidence.rubricBand,
          evidence.graderConfidence,
          evidence.rationaleRef,
          evidence.knowledgeAlgorithmVersion,
          evidence.eligibleForMastery,
          evidence.judgmentKind,
          evidence.gradingMethod,
          evidence.rubricId,
          evidence.rubricVersion,
          evidence.gradingPolicyVersion,
          evidence.ratingMappingVersion,
          evidence.knowledgeConfigurationId,
          evidence.ineligibilityReason,
          evidence.fsrsRating,
          evidence.replacementForAttemptId,
        ],
      );
      if (inserted.rows[0] === undefined) {
        const same = await client.query<{ matches: boolean }>(
          `SELECT (
             score IS NOT DISTINCT FROM $4::numeric
             AND rubric_band IS NOT DISTINCT FROM $5
             AND grader_confidence IS NOT DISTINCT FROM $6::numeric
             AND rationale_ref IS NOT DISTINCT FROM $7
             AND knowledge_algorithm_version = $8
             AND eligible_for_mastery = $9
             AND judgment_kind = $10
             AND grading_method = $11
             AND rubric_id = $12
             AND rubric_version = $13
             AND grading_policy_version = $14
             AND rating_mapping_version = $15
             AND knowledge_configuration_id = $16
             AND ineligibility_reason IS NOT DISTINCT FROM $17
             AND fsrs_rating IS NOT DISTINCT FROM $18::smallint
             AND replacement_for_attempt_id IS NOT DISTINCT FROM $19::uuid
           ) AS matches
           FROM attempt_concept_evidence
           WHERE owner_scope_id = $1 AND attempt_id = $2 AND concept_id = $3`,
          [
            authorization.ownerScopeId,
            evidence.attemptId,
            evidence.conceptId,
            evidence.score,
            evidence.rubricBand,
            evidence.graderConfidence,
            evidence.rationaleRef,
            evidence.knowledgeAlgorithmVersion,
            evidence.eligibleForMastery,
            evidence.judgmentKind,
            evidence.gradingMethod,
            evidence.rubricId,
            evidence.rubricVersion,
            evidence.gradingPolicyVersion,
            evidence.ratingMappingVersion,
            evidence.knowledgeConfigurationId,
            evidence.ineligibilityReason,
            evidence.fsrsRating,
            evidence.replacementForAttemptId,
          ],
        );
        if (same.rows[0]?.matches !== true) {
          throw new KnowledgePersistenceError("conflicting_duplicate");
        }
      }

      const ledger = await client.query<EvidenceRow>(
        `SELECT evidence.owner_scope_id, attempt.user_id, evidence.attempt_id,
                attempt.created_at AS attempt_created_at, evidence.concept_id,
                evidence.score::text, evidence.eligible_for_mastery,
                evidence.knowledge_algorithm_version,
                evidence.knowledge_configuration_id
         FROM attempt_concept_evidence AS evidence
         JOIN attempt
           ON attempt.owner_scope_id = evidence.owner_scope_id
          AND attempt.id = evidence.attempt_id
         WHERE evidence.owner_scope_id = $1
           AND attempt.user_id = $2
           AND evidence.concept_id = $3
         ORDER BY attempt.created_at, attempt.id, evidence.concept_id`,
        [authorization.ownerScopeId, authorization.actorId, evidence.conceptId],
      );
      const state = replayKnowledgeState(ledger.rows.map(toDomainEvidence));
      await client.query(
        `UPDATE knowledge_state
         SET mastery = $4,
             confidence = $5,
             last_reviewed_at = $6,
             review_count = $7,
             algorithm_version = $8,
             updated_at = now(),
             alpha_quanta = $9,
             beta_quanta = $10,
             evidence_count = $7,
             assessment_status = $11,
             knowledge_configuration_id = $12
         WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3`,
        [
          authorization.ownerScopeId,
          authorization.actorId,
          evidence.conceptId,
          state.mastery,
          state.confidence,
          state.lastReviewedAt,
          state.evidenceCount,
          state.algorithmVersion,
          state.alphaQuanta,
          state.betaQuanta,
          state.assessmentStatus,
          state.configurationId,
        ],
      );
      return state;
    });
  }

  async #transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
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

function validateLearningEvent(
  authorization: KnowledgeAuthorizationContext,
  event: LearningEventV1,
): void {
  if (
    event.eventVersion !== 1 ||
    !learningEventNames.has(event.name) ||
    event.ownerScopeId !== authorization.ownerScopeId ||
    event.userId !== authorization.actorId ||
    !nonEmpty([
      event.id,
      event.name,
      event.producer,
      event.correlationId,
      event.idempotencyKey,
    ]) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    !isUuid(event.id) ||
    !isUuid(event.ownerScopeId) ||
    !isUuid(event.userId) ||
    !isUuid(event.correlationId) ||
    !optionalUuid(event.causationId) ||
    !optionalUuid(event.sessionId) ||
    !optionalUuid(event.deliveryId) ||
    !optionalUuid(event.attemptId) ||
    event.conceptIds.some((conceptId) => !isUuid(conceptId)) ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(event.producer) ||
    !/^[\x21-\x7e]{1,240}$/.test(event.idempotencyKey)
  ) {
    throw new KnowledgePersistenceError("invalid_event");
  }
  const allowedPayloadKeys = new Set([
    "assetId",
    "chapterId",
    "courseId",
    "modality",
    "quizItemId",
    "strategyTag",
  ]);
  if (Object.keys(event.payload).some((key) => !allowedPayloadKeys.has(key))) {
    throw new KnowledgePersistenceError("invalid_event");
  }
  for (const key of ["assetId", "chapterId", "courseId", "quizItemId"]) {
    const value = event.payload[key as keyof LearningEventV1["payload"]];
    if (value !== undefined && (typeof value !== "string" || !isUuid(value))) {
      throw new KnowledgePersistenceError("invalid_event");
    }
  }
  if (
    event.payload.strategyTag !== undefined &&
    !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(event.payload.strategyTag)
  ) {
    throw new KnowledgePersistenceError("invalid_event");
  }
}

function validateEvidenceWrite(evidence: AssessmentEvidenceWrite): void {
  if (
    !nonEmpty([
      evidence.attemptId,
      evidence.conceptId,
      evidence.rubricId,
      evidence.rubricVersion,
      evidence.gradingPolicyVersion,
      evidence.ratingMappingVersion,
    ]) ||
    evidence.knowledgeAlgorithmVersion !== KNOWLEDGE_ALGORITHM_VERSION ||
    evidence.knowledgeConfigurationId !== KNOWLEDGE_CONFIGURATION_ID ||
    (evidence.score !== null && !isFiveDecimalScore(evidence.score)) ||
    (evidence.graderConfidence !== null &&
      !isFiveDecimalScore(evidence.graderConfidence)) ||
    !isUuid(evidence.attemptId) ||
    !isUuid(evidence.conceptId) ||
    !optionalUuid(evidence.replacementForAttemptId) ||
    !validEvidenceShape(evidence)
  ) {
    throw new KnowledgePersistenceError("invalid_evidence");
  }
}

function nonEmpty(values: readonly string[]): boolean {
  return values.every((value) => value.length > 0);
}

function isFiveDecimalScore(value: string): boolean {
  return /^(?:0(?:\.\d{1,5})?|1(?:\.0{1,5})?)$/.test(value);
}

function validEvidenceShape(evidence: AssessmentEvidenceWrite): boolean {
  if (evidence.judgmentKind === "unanswerable") {
    return (
      evidence.gradingMethod === "llm_short_answer" &&
      evidence.score === null &&
      evidence.rubricBand === null &&
      evidence.graderConfidence === null &&
      !evidence.eligibleForMastery &&
      evidence.fsrsRating === null &&
      evidence.ineligibilityReason !== null
    );
  }
  if (
    evidence.score === null ||
    evidence.rubricBand === null ||
    (evidence.gradingMethod === "llm_short_answer" &&
      evidence.graderConfidence === null) ||
    (evidence.gradingMethod === "keyed_mc" &&
      evidence.graderConfidence !== null)
  ) {
    return false;
  }
  if (
    evidence.eligibleForMastery !== (evidence.ineligibilityReason === null) ||
    evidence.eligibleForMastery !== (evidence.fsrsRating !== null)
  ) {
    return false;
  }
  const expected = {
    correct: { rating: 3, score: "1.00000" },
    incorrect: { rating: 1, score: "0.00000" },
    partially_correct: { rating: 1, score: "0.50000" },
  }[evidence.rubricBand];
  return (
    evidence.score === expected.score &&
    (!evidence.eligibleForMastery || evidence.fsrsRating === expected.rating)
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function optionalUuid(value: string | null): boolean {
  return value === null || isUuid(value);
}

async function setScopeContext(
  client: PoolClient,
  authorization: KnowledgeAuthorizationContext,
): Promise<void> {
  await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
    authorization.actorId,
  ]);
  await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
    authorization.ownerScopeId,
  ]);
}

async function loadEventByIdentity(
  client: PoolClient,
  id: string,
  idempotencyKey: string,
): Promise<EventRow | null> {
  const result = await client.query<EventRow>(
    `SELECT id, owner_scope_id, user_id, session_id, delivery_id, attempt_id,
            event_type, event_version, producer, correlation_id, causation_id,
            idempotency_key, payload, occurred_at
     FROM learning_event
     WHERE id = $1 OR idempotency_key = $2`,
    [id, idempotencyKey],
  );
  return result.rows.length === 1 ? (result.rows[0] ?? null) : null;
}

async function loadEventConceptIds(
  client: PoolClient,
  ownerScopeId: string,
  eventId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ concept_id: string }>(
    `SELECT concept_id
     FROM learning_event_concept
     WHERE owner_scope_id = $1 AND learning_event_id = $2
     ORDER BY concept_id`,
    [ownerScopeId, eventId],
  );
  return result.rows.map((row) => row.concept_id);
}

function sameLearningEvent(
  current: EventRow,
  currentConceptIds: readonly string[],
  expected: LearningEventV1,
  expectedConceptIds: readonly string[],
): boolean {
  return (
    current.id === expected.id &&
    current.owner_scope_id === expected.ownerScopeId &&
    current.user_id === expected.userId &&
    current.session_id === expected.sessionId &&
    current.delivery_id === expected.deliveryId &&
    current.attempt_id === expected.attemptId &&
    current.event_type === expected.name &&
    current.event_version === expected.eventVersion &&
    current.producer === expected.producer &&
    current.correlation_id === expected.correlationId &&
    current.causation_id === expected.causationId &&
    current.idempotency_key === expected.idempotencyKey &&
    current.occurred_at.toISOString() ===
      new Date(expected.occurredAt).toISOString() &&
    stableJson(current.payload) === stableJson(expected.payload) &&
    JSON.stringify(currentConceptIds) === JSON.stringify(expectedConceptIds)
  );
}

function toDomainEvidence(row: EvidenceRow): PerConceptEvidence {
  if (
    row.knowledge_algorithm_version !== KNOWLEDGE_ALGORITHM_VERSION ||
    row.knowledge_configuration_id !== KNOWLEDGE_CONFIGURATION_ID
  ) {
    throw new KnowledgePersistenceError("invalid_evidence");
  }
  return {
    attemptCreatedAt: row.attempt_created_at.toISOString(),
    attemptId: row.attempt_id,
    conceptId: row.concept_id,
    eligibleForMastery: row.eligible_for_mastery,
    knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
    knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
    ownerScopeId: row.owner_scope_id,
    score: row.score,
    userId: row.user_id,
  };
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareAscii(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
