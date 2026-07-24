import { createHash } from "node:crypto";

import {
  canonicalCardBytes,
  canonicalTransitionBytes,
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  replayFsrsSchedule,
  replayKnowledgeState,
  type AssessmentEvidenceWrite,
  type CanonicalFsrsCard,
  type DeliveryOverrideCancellationWrite,
  type DeliveryOverrideWrite,
  type DeliveryPreference,
  type ExactKnowledgeState,
  type FsrsReplayRun,
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
  | "invalid_event"
  | "invalid_override";

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

export interface DeliveryOverrideProjection {
  readonly nextDeliveryAt: string;
}

interface EvidenceRow extends Record<string, unknown> {
  attempt_created_at: Date;
  attempt_created_at_order: string;
  attempt_id: string;
  attempt_outcome: "abstained" | "graded" | "superseded";
  concept_id: string;
  eligible_for_mastery: boolean;
  fsrs_rating: 1 | 3 | null;
  grading_policy_version: string;
  knowledge_algorithm_version: string;
  knowledge_configuration_id: string;
  owner_scope_id: string;
  rating_mapping_version: string;
  score: string | null;
  user_id: string;
}

interface AttemptEvidenceProvenanceRow extends Record<string, unknown> {
  created_at_order: string;
  outcome: "abstained" | "graded" | "superseded";
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
    deliveryPreference: DeliveryPreference,
  ): Promise<ExactKnowledgeState> {
    validateEvidenceWrite(evidence);

    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const attempt = await client.query<AttemptEvidenceProvenanceRow>(
        `SELECT
           to_char(
             attempt.created_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS created_at_order,
           attempt.outcome,
           attempt.user_id
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
      const attemptProvenance = attempt.rows[0];
      if (attemptProvenance === undefined) {
        throw new KnowledgePersistenceError("authorization_denied");
      }
      if (
        evidence.eligibleForMastery &&
        attemptProvenance.outcome !== "graded"
      ) {
        throw new KnowledgePersistenceError("invalid_evidence");
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
            replacement_for_attempt_id, attempt_created_at, attempt_user_id,
            attempt_outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
          attemptProvenance.created_at_order,
          attemptProvenance.user_id,
          attemptProvenance.outcome,
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
             AND attempt_created_at = $20::timestamptz
             AND attempt_user_id = $21::uuid
             AND attempt_outcome = $22
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
            attemptProvenance.created_at_order,
            attemptProvenance.user_id,
            attemptProvenance.outcome,
          ],
        );
        if (same.rows[0]?.matches !== true) {
          throw new KnowledgePersistenceError("conflicting_duplicate");
        }
      }

      const ledger = await client.query<EvidenceRow>(
        `SELECT evidence.owner_scope_id,
                evidence.attempt_user_id AS user_id, evidence.attempt_id,
                evidence.attempt_created_at, evidence.attempt_outcome,
                evidence.concept_id,
                evidence.score::text, evidence.eligible_for_mastery,
                to_char(
                  evidence.attempt_created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS attempt_created_at_order,
                evidence.fsrs_rating, evidence.grading_policy_version,
                evidence.rating_mapping_version,
                evidence.knowledge_algorithm_version,
                evidence.knowledge_configuration_id
         FROM attempt_concept_evidence AS evidence
         WHERE evidence.owner_scope_id = $1
           AND evidence.attempt_user_id = $2
           AND evidence.concept_id = $3
           AND evidence.eligible_for_mastery
         ORDER BY evidence.attempt_created_at, evidence.attempt_id,
                  evidence.concept_id
         LIMIT 513`,
        [authorization.ownerScopeId, authorization.actorId, evidence.conceptId],
      );
      const domainEvidence = ledger.rows.map(toDomainEvidence);
      const state = replayKnowledgeState(domainEvidence);
      const schedule = await replayFsrsSchedule(
        domainEvidence,
        deliveryPreference,
      );
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
      if (schedule !== null) {
        await persistScheduleReplay(client, schedule);
      }
      return state;
    });
  }

  async appendDeliveryOverride(
    authorization: KnowledgeAuthorizationContext,
    override: DeliveryOverrideWrite,
  ): Promise<DeliveryOverrideProjection> {
    validateOverrideAuthorization(authorization);
    validateDeliveryOverride(override);
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await lockSchedule(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        override.conceptId,
      );
      await client.query(
        `INSERT INTO delivery_override
           (owner_scope_id, id, user_id, concept_id, reason,
            deliver_not_before_at, actor_id, authorization_id, causation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $3, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          authorization.ownerScopeId,
          override.id,
          authorization.actorId,
          override.conceptId,
          override.reason,
          override.deliverNotBeforeAt,
          authorization.authorizationId,
          override.causationId,
        ],
      );
      const persisted = await client.query<{ matches: boolean }>(
        `SELECT (
           user_id = $3
           AND concept_id = $4
           AND reason = $5
           AND deliver_not_before_at = $6::timestamptz
           AND actor_id = $3
           AND authorization_id = $7
           AND causation_id IS NOT DISTINCT FROM $8::uuid
         ) AS matches
         FROM delivery_override
         WHERE owner_scope_id = $1 AND id = $2`,
        [
          authorization.ownerScopeId,
          override.id,
          authorization.actorId,
          override.conceptId,
          override.reason,
          override.deliverNotBeforeAt,
          authorization.authorizationId,
          override.causationId,
        ],
      );
      if (persisted.rows[0]?.matches !== true) {
        throw new KnowledgePersistenceError("conflicting_duplicate");
      }
      return recomputeNextDeliveryAt(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        override.conceptId,
      );
    });
  }

  async cancelDeliveryOverride(
    authorization: KnowledgeAuthorizationContext,
    cancellation: DeliveryOverrideCancellationWrite,
  ): Promise<DeliveryOverrideProjection> {
    validateOverrideAuthorization(authorization);
    validateDeliveryOverrideCancellation(cancellation);
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      await lockSchedule(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        cancellation.conceptId,
      );
      const inserted = await client.query(
        `INSERT INTO delivery_override_cancellation
           (owner_scope_id, id, user_id, concept_id, target_override_id,
            actor_id, authorization_id, causation_id)
         SELECT $1, $2, $3, $4, delivery_override.id, $3, $6, $7
         FROM delivery_override
         WHERE delivery_override.owner_scope_id = $1
           AND delivery_override.id = $5
           AND delivery_override.user_id = $3
           AND delivery_override.concept_id = $4
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          authorization.ownerScopeId,
          cancellation.id,
          authorization.actorId,
          cancellation.conceptId,
          cancellation.targetOverrideId,
          authorization.authorizationId,
          cancellation.causationId,
        ],
      );
      if (inserted.rows[0] === undefined) {
        const persisted = await client.query<{ matches: boolean }>(
          `SELECT (
             id = $2
             AND user_id = $3
             AND concept_id = $4
             AND target_override_id = $5
             AND actor_id = $3
             AND authorization_id = $6
             AND causation_id IS NOT DISTINCT FROM $7::uuid
           ) AS matches
           FROM delivery_override_cancellation
           WHERE owner_scope_id = $1
             AND (id = $2 OR target_override_id = $5)`,
          [
            authorization.ownerScopeId,
            cancellation.id,
            authorization.actorId,
            cancellation.conceptId,
            cancellation.targetOverrideId,
            authorization.authorizationId,
            cancellation.causationId,
          ],
        );
        if (
          persisted.rows.length !== 1 ||
          persisted.rows[0]?.matches !== true
        ) {
          throw new KnowledgePersistenceError("conflicting_duplicate");
        }
      }
      return recomputeNextDeliveryAt(
        client,
        authorization.ownerScopeId,
        authorization.actorId,
        cancellation.conceptId,
      );
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

async function persistScheduleReplay(
  client: PoolClient,
  run: FsrsReplayRun,
): Promise<void> {
  await persistCards(client, run);
  await persistTransitions(client, run);

  await client.query(
    `INSERT INTO fsrs_replay_run
       (owner_scope_id, run_id, user_id, concept_id, fsrs_profile_id,
        profile_digest, evidence_digest, manifest_digest, current_card_digest,
        transition_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT DO NOTHING`,
    [
      run.ownerScopeId,
      run.runId,
      run.userId,
      run.conceptId,
      run.profileId,
      run.profileDigest,
      run.evidenceDigest,
      run.manifestDigest,
      run.currentCardDigest,
      run.transitions.length,
    ],
  );
  const persistedRun = await client.query<{
    matches: boolean;
  }>(
    `SELECT (
       user_id = $3
       AND concept_id = $4
       AND fsrs_profile_id = $5
       AND profile_digest = $6
       AND evidence_digest = $7
       AND manifest_digest = $8
       AND current_card_digest = $9
       AND transition_count = $10
     ) AS matches
     FROM fsrs_replay_run
     WHERE owner_scope_id = $1 AND run_id = $2`,
    [
      run.ownerScopeId,
      run.runId,
      run.userId,
      run.conceptId,
      run.profileId,
      run.profileDigest,
      run.evidenceDigest,
      run.manifestDigest,
      run.currentCardDigest,
      run.transitions.length,
    ],
  );
  if (persistedRun.rows[0]?.matches !== true) {
    throw new KnowledgePersistenceError("conflicting_duplicate");
  }

  await client.query(
    `INSERT INTO fsrs_replay_manifest
       (owner_scope_id, run_id, sequence, concept_id, fsrs_profile_id,
        transition_digest)
     SELECT $1, $2, input.sequence, $3, $4, input.transition_digest
     FROM jsonb_to_recordset($5::jsonb)
       AS input(sequence integer, transition_digest text)
     ON CONFLICT DO NOTHING`,
    [
      run.ownerScopeId,
      run.runId,
      run.conceptId,
      run.profileId,
      JSON.stringify(
        run.transitions.map((transition) => ({
          sequence: transition.sequence,
          transition_digest: transition.transitionDigest,
        })),
      ),
    ],
  );
  const manifest = await client.query<{
    sequence: number;
    transition_digest: string;
  }>(
    `SELECT sequence, transition_digest
     FROM fsrs_replay_manifest
     WHERE owner_scope_id = $1 AND run_id = $2
     ORDER BY sequence`,
    [run.ownerScopeId, run.runId],
  );
  if (
    JSON.stringify(manifest.rows) !==
    JSON.stringify(
      run.transitions.map((transition) => ({
        sequence: transition.sequence,
        transition_digest: transition.transitionDigest,
      })),
    )
  ) {
    throw new KnowledgePersistenceError("conflicting_duplicate");
  }

  await client.query(
    `INSERT INTO scheduler_delivery_resolution
       (owner_scope_id, resolution_id, run_id, time_zone, chosen_local_time,
        delivery_profile_id, tzdb_version, disambiguation, fsrs_due_at,
        base_next_delivery_at)
     VALUES ($1, $2, $3, $4, $5::time, $6, $7, $8, $9, $10)
     ON CONFLICT DO NOTHING`,
    [
      run.ownerScopeId,
      run.deliveryResolutionId,
      run.runId,
      run.delivery.timeZone,
      run.delivery.chosenLocalTime,
      run.delivery.profileId,
      run.delivery.tzdbVersion,
      run.delivery.disambiguation,
      run.fsrsDueAt,
      run.delivery.nextDeliveryAt,
    ],
  );
  const persistedResolution = await client.query<{ matches: boolean }>(
    `SELECT (
       run_id = $3
       AND time_zone = $4
       AND chosen_local_time = $5::time
       AND delivery_profile_id = $6
       AND tzdb_version = $7
       AND disambiguation = $8
       AND fsrs_due_at = $9::timestamptz
       AND base_next_delivery_at = $10::timestamptz
     ) AS matches
     FROM scheduler_delivery_resolution
     WHERE owner_scope_id = $1 AND resolution_id = $2`,
    [
      run.ownerScopeId,
      run.deliveryResolutionId,
      run.runId,
      run.delivery.timeZone,
      run.delivery.chosenLocalTime,
      run.delivery.profileId,
      run.delivery.tzdbVersion,
      run.delivery.disambiguation,
      run.fsrsDueAt,
      run.delivery.nextDeliveryAt,
    ],
  );
  if (persistedResolution.rows[0]?.matches !== true) {
    throw new KnowledgePersistenceError("conflicting_duplicate");
  }

  const effectiveDelivery = await client.query<{ next_delivery_at: Date }>(
    `SELECT GREATEST(
       $4::timestamptz,
       COALESCE(
         max(delivery_override.deliver_not_before_at)
           FILTER (WHERE cancellation.id IS NULL),
         $4::timestamptz
       )
     ) AS next_delivery_at
     FROM delivery_override
     LEFT JOIN delivery_override_cancellation AS cancellation
       ON cancellation.owner_scope_id = delivery_override.owner_scope_id
      AND cancellation.target_override_id = delivery_override.id
     WHERE delivery_override.owner_scope_id = $1
       AND delivery_override.user_id = $2
       AND delivery_override.concept_id = $3`,
    [run.ownerScopeId, run.userId, run.conceptId, run.delivery.nextDeliveryAt],
  );
  const card = run.currentCard;
  const scheduleId = hashToUuid(
    `${run.ownerScopeId}/${run.userId}/${run.conceptId}/${run.profileId}`,
  );
  await client.query(
    `INSERT INTO review_schedule
       (id, owner_scope_id, user_id, concept_id, fsrs_due_at, time_zone,
        fsrs_profile_id, base_next_delivery_at, next_delivery_at,
        chosen_local_time, delivery_profile_id, tzdb_version,
        delivery_disambiguation, current_replay_run_id,
        current_delivery_resolution_id, current_card_digest,
        card_last_reviewed_at, stability, difficulty, card_state,
        elapsed_days, scheduled_days, reps, lapses, learning_steps)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::time, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
             $24, $25)
     ON CONFLICT (owner_scope_id, user_id, concept_id, fsrs_profile_id)
     DO UPDATE SET
       fsrs_due_at = EXCLUDED.fsrs_due_at,
       time_zone = EXCLUDED.time_zone,
       base_next_delivery_at = EXCLUDED.base_next_delivery_at,
       next_delivery_at = EXCLUDED.next_delivery_at,
       chosen_local_time = EXCLUDED.chosen_local_time,
       delivery_profile_id = EXCLUDED.delivery_profile_id,
       tzdb_version = EXCLUDED.tzdb_version,
       delivery_disambiguation = EXCLUDED.delivery_disambiguation,
       current_replay_run_id = EXCLUDED.current_replay_run_id,
       current_delivery_resolution_id = EXCLUDED.current_delivery_resolution_id,
       current_card_digest = EXCLUDED.current_card_digest,
       card_last_reviewed_at = EXCLUDED.card_last_reviewed_at,
       stability = EXCLUDED.stability,
       difficulty = EXCLUDED.difficulty,
       card_state = EXCLUDED.card_state,
       elapsed_days = EXCLUDED.elapsed_days,
       scheduled_days = EXCLUDED.scheduled_days,
       reps = EXCLUDED.reps,
       lapses = EXCLUDED.lapses,
       learning_steps = EXCLUDED.learning_steps,
       updated_at = now()`,
    [
      scheduleId,
      run.ownerScopeId,
      run.userId,
      run.conceptId,
      run.fsrsDueAt,
      run.delivery.timeZone,
      run.profileId,
      run.delivery.nextDeliveryAt,
      effectiveDelivery.rows[0]?.next_delivery_at ??
        run.delivery.nextDeliveryAt,
      run.delivery.chosenLocalTime,
      run.delivery.profileId,
      run.delivery.tzdbVersion,
      run.delivery.disambiguation,
      run.runId,
      run.deliveryResolutionId,
      run.currentCardDigest,
      card.lastReview,
      card.stability,
      card.difficulty,
      card.state,
      card.elapsedDays,
      card.scheduledDays,
      card.reps,
      card.lapses,
      card.learningSteps,
    ],
  );
}

async function persistCards(
  client: PoolClient,
  run: FsrsReplayRun,
): Promise<void> {
  const expected = new Map<
    string,
    {
      card: CanonicalFsrsCard;
      canonical: string;
    }
  >();
  for (const transition of run.transitions) {
    expected.set(transition.priorCardDigest, {
      canonical: canonicalCardBytes(transition.priorCard),
      card: transition.priorCard,
    });
    expected.set(transition.nextCardDigest, {
      canonical: canonicalCardBytes(transition.nextCard),
      card: transition.nextCard,
    });
  }
  const payload = [...expected].map(([cardDigest, item]) => ({
    canonical_card: item.canonical,
    card_digest: cardDigest,
    card_state: item.card.state,
    difficulty: item.card.difficulty,
    due_at: item.card.due,
    elapsed_days: item.card.elapsedDays,
    lapses: item.card.lapses,
    last_reviewed_at: item.card.lastReview,
    learning_steps: item.card.learningSteps,
    reps: item.card.reps,
    scheduled_days: item.card.scheduledDays,
    stability: item.card.stability,
  }));
  await client.query(
    `INSERT INTO fsrs_card_payload
       (owner_scope_id, card_digest, fsrs_profile_id, canonical_card, due_at,
        last_reviewed_at, stability, difficulty, card_state, elapsed_days,
        scheduled_days, reps, lapses, learning_steps)
     SELECT $1, input.card_digest, 'fsrs-profile-v1',
            input.canonical_card, input.due_at, input.last_reviewed_at,
            input.stability, input.difficulty, input.card_state,
            input.elapsed_days, input.scheduled_days, input.reps,
            input.lapses, input.learning_steps
     FROM jsonb_to_recordset($2::jsonb) AS input(
       card_digest text,
       canonical_card text,
       due_at timestamptz,
       last_reviewed_at timestamptz,
       stability numeric,
       difficulty numeric,
       card_state smallint,
       elapsed_days integer,
       scheduled_days integer,
       reps integer,
       lapses integer,
       learning_steps integer
     )
     ON CONFLICT DO NOTHING`,
    [run.ownerScopeId, JSON.stringify(payload)],
  );
  const persisted = await client.query<{
    canonical_card: string;
    card_digest: string;
    card_state: 0 | 2;
    difficulty: string;
    due_at: Date;
    elapsed_days: number;
    lapses: number;
    last_reviewed_at: Date | null;
    learning_steps: number;
    reps: number;
    scheduled_days: number;
    stability: string;
  }>(
    `SELECT card_digest, canonical_card, due_at, last_reviewed_at,
            stability::text, difficulty::text, card_state, elapsed_days,
            scheduled_days, reps, lapses, learning_steps
     FROM fsrs_card_payload
     WHERE owner_scope_id = $1 AND card_digest = ANY($2::text[])
     ORDER BY card_digest`,
    [run.ownerScopeId, [...expected.keys()]],
  );
  if (
    persisted.rows.length !== expected.size ||
    persisted.rows.some((row) => {
      const item = expected.get(row.card_digest);
      return (
        item === undefined ||
        row.canonical_card !== item.canonical ||
        row.due_at.toISOString() !== item.card.due ||
        row.last_reviewed_at?.toISOString() !==
          (item.card.lastReview ?? undefined) ||
        row.stability !== item.card.stability ||
        row.difficulty !== item.card.difficulty ||
        row.card_state !== item.card.state ||
        row.elapsed_days !== item.card.elapsedDays ||
        row.scheduled_days !== item.card.scheduledDays ||
        row.reps !== item.card.reps ||
        row.lapses !== item.card.lapses ||
        row.learning_steps !== item.card.learningSteps
      );
    })
  ) {
    throw new KnowledgePersistenceError("conflicting_duplicate");
  }
}

async function persistTransitions(
  client: PoolClient,
  run: FsrsReplayRun,
): Promise<void> {
  const payload = run.transitions.map((transition) => ({
    attempt_id: transition.evidenceIdentity.split("/")[1],
    canonical_transition: canonicalTransitionPayload(transition),
    concept_id: run.conceptId,
    evidence_identity: transition.evidenceIdentity,
    fsrs_profile_id: transition.profileId,
    next_card_digest: transition.nextCardDigest,
    prior_card_digest: transition.priorCardDigest,
    rating: transition.rating,
    reviewed_at: transition.reviewedAt,
    transition_digest: transition.transitionDigest,
  }));
  await client.query(
    `INSERT INTO fsrs_transition_payload
       (owner_scope_id, transition_digest, evidence_identity, attempt_id,
        concept_id, rating, reviewed_at, fsrs_profile_id, prior_card_digest,
        next_card_digest, canonical_transition)
     SELECT $1, input.transition_digest, input.evidence_identity,
            input.attempt_id, input.concept_id, input.rating,
            input.reviewed_at, input.fsrs_profile_id,
            input.prior_card_digest, input.next_card_digest,
            input.canonical_transition
     FROM jsonb_to_recordset($2::jsonb) AS input(
       transition_digest text,
       evidence_identity text,
       attempt_id uuid,
       concept_id uuid,
       rating smallint,
       reviewed_at timestamptz,
       fsrs_profile_id text,
       prior_card_digest text,
       next_card_digest text,
       canonical_transition text
     )
     ON CONFLICT DO NOTHING`,
    [run.ownerScopeId, JSON.stringify(payload)],
  );
  const persisted = await client.query<{
    attempt_id: string;
    canonical_transition: string;
    concept_id: string;
    evidence_identity: string;
    fsrs_profile_id: string;
    next_card_digest: string;
    prior_card_digest: string;
    rating: 1 | 3;
    reviewed_at: Date;
    transition_digest: string;
  }>(
    `SELECT transition_digest, evidence_identity, attempt_id, concept_id,
            rating, reviewed_at, fsrs_profile_id, prior_card_digest,
            next_card_digest, canonical_transition
     FROM fsrs_transition_payload
     WHERE owner_scope_id = $1
       AND transition_digest = ANY($2::text[])
     ORDER BY transition_digest`,
    [run.ownerScopeId, payload.map((item) => item.transition_digest)],
  );
  const expected = new Map(
    payload.map((item) => [item.transition_digest, item]),
  );
  if (
    persisted.rows.length !== expected.size ||
    persisted.rows.some((row) => {
      const item = expected.get(row.transition_digest);
      return (
        item === undefined ||
        row.evidence_identity !== item.evidence_identity ||
        row.attempt_id !== item.attempt_id ||
        row.concept_id !== item.concept_id ||
        row.rating !== item.rating ||
        row.reviewed_at.toISOString() !== item.reviewed_at ||
        row.fsrs_profile_id !== item.fsrs_profile_id ||
        row.prior_card_digest !== item.prior_card_digest ||
        row.next_card_digest !== item.next_card_digest ||
        row.canonical_transition !== item.canonical_transition
      );
    })
  ) {
    throw new KnowledgePersistenceError("conflicting_duplicate");
  }
}

function canonicalTransitionPayload(
  transition: FsrsReplayRun["transitions"][number],
): string {
  return canonicalTransitionBytes({
    evidenceIdentity: transition.evidenceIdentity,
    nextCard: transition.nextCard,
    nextCardDigest: transition.nextCardDigest,
    priorCard: transition.priorCard,
    priorCardDigest: transition.priorCardDigest,
    profileId: transition.profileId,
    rating: transition.rating,
    reviewedAt: transition.reviewedAt,
    sequence: transition.sequence,
  });
}

function hashToUuid(input: string): string {
  const hex = createHash("sha256").update(input, "utf8").digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function validateOverrideAuthorization(
  authorization: KnowledgeAuthorizationContext,
): void {
  if (
    !isUuid(authorization.ownerScopeId) ||
    !isUuid(authorization.actorId) ||
    !/^[\x21-\x7e]{1,240}$/.test(authorization.authorizationId)
  ) {
    throw new KnowledgePersistenceError("invalid_override");
  }
}

function validateDeliveryOverride(override: DeliveryOverrideWrite): void {
  if (
    !isUuid(override.id) ||
    !isUuid(override.conceptId) ||
    !optionalUuid(override.causationId) ||
    !isCanonicalTimestamp(override.deliverNotBeforeAt) ||
    !new Set([
      "channel_unavailable",
      "operator_demo_control",
      "reteach_follow_up",
      "user_snooze",
    ]).has(override.reason)
  ) {
    throw new KnowledgePersistenceError("invalid_override");
  }
}

function validateDeliveryOverrideCancellation(
  cancellation: DeliveryOverrideCancellationWrite,
): void {
  if (
    !isUuid(cancellation.id) ||
    !isUuid(cancellation.conceptId) ||
    !isUuid(cancellation.targetOverrideId) ||
    !optionalUuid(cancellation.causationId)
  ) {
    throw new KnowledgePersistenceError("invalid_override");
  }
}

async function lockSchedule(
  client: PoolClient,
  ownerScopeId: string,
  userId: string,
  conceptId: string,
): Promise<void> {
  const schedule = await client.query(
    `SELECT 1
     FROM review_schedule
     WHERE owner_scope_id = $1
       AND user_id = $2
       AND concept_id = $3
       AND fsrs_profile_id = 'fsrs-profile-v1'
     FOR UPDATE`,
    [ownerScopeId, userId, conceptId],
  );
  if (schedule.rows[0] === undefined) {
    throw new KnowledgePersistenceError("invalid_override");
  }
}

async function recomputeNextDeliveryAt(
  client: PoolClient,
  ownerScopeId: string,
  userId: string,
  conceptId: string,
): Promise<DeliveryOverrideProjection> {
  const updated = await client.query<{ next_delivery_at: Date }>(
    `UPDATE review_schedule
     SET next_delivery_at = GREATEST(
       review_schedule.base_next_delivery_at,
       COALESCE(
         (
           SELECT max(delivery_override.deliver_not_before_at)
           FROM delivery_override
           LEFT JOIN delivery_override_cancellation AS cancellation
             ON cancellation.owner_scope_id = delivery_override.owner_scope_id
            AND cancellation.target_override_id = delivery_override.id
           WHERE delivery_override.owner_scope_id = review_schedule.owner_scope_id
             AND delivery_override.user_id = review_schedule.user_id
             AND delivery_override.concept_id = review_schedule.concept_id
             AND cancellation.id IS NULL
         ),
         review_schedule.base_next_delivery_at
       )
     ),
     updated_at = now()
     WHERE owner_scope_id = $1
       AND user_id = $2
       AND concept_id = $3
       AND fsrs_profile_id = 'fsrs-profile-v1'
     RETURNING next_delivery_at`,
    [ownerScopeId, userId, conceptId],
  );
  const nextDeliveryAt = updated.rows[0]?.next_delivery_at;
  if (nextDeliveryAt === undefined) {
    throw new KnowledgePersistenceError("invalid_override");
  }
  return { nextDeliveryAt: nextDeliveryAt.toISOString() };
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

function isCanonicalTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
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
    attemptCreatedAtOrder: row.attempt_created_at_order,
    attemptId: row.attempt_id,
    attemptOutcome: row.attempt_outcome,
    conceptId: row.concept_id,
    eligibleForMastery: row.eligible_for_mastery,
    fsrsRating: row.fsrs_rating,
    gradingPolicyVersion: row.grading_policy_version,
    knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
    knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
    ownerScopeId: row.owner_scope_id,
    ratingMappingVersion: row.rating_mapping_version,
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
