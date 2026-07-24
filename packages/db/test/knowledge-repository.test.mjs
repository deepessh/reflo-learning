import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";
import test from "node:test";
import assert from "node:assert/strict";

import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
} from "@reflo/knowledge-model";

import {
  KnowledgePersistenceError,
  PostgresKnowledgeRepository,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  chapter: "00000000-0000-4000-8000-000000000501",
  conceptA: "00000000-0000-4000-8000-000000000601",
  conceptB: "00000000-0000-4000-8000-000000000602",
  conceptBound: "00000000-0000-4000-8000-000000000603",
  conceptRace: "00000000-0000-4000-8000-000000000604",
  course: "00000000-0000-4000-8000-000000000401",
  document: "00000000-0000-4000-8000-000000000301",
  event: "00000000-0000-4000-8000-000000000901",
  overrideA: "00000000-0000-4000-8000-000000000911",
  overrideB: "00000000-0000-4000-8000-000000000912",
  overrideCancellationA: "00000000-0000-4000-8000-000000000913",
  overrideCancellationB: "00000000-0000-4000-8000-000000000914",
  overrideCancellationForged: "00000000-0000-4000-8000-000000000915",
  member: "00000000-0000-4000-8000-000000000201",
  quiz: "00000000-0000-4000-8000-000000000701",
  scope: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000801",
  user: "00000000-0000-4000-8000-000000000001",
};
const deliveryPreference = {
  chosenLocalTime: "09:00",
  timeZone: "UTC",
};

test(
  "PostgresKnowledgeRepository keeps events and evidence append-only and replays exact mastery",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const databaseName = `reflo_knowledge_${suffix}`;
    const lifecycleRole = `reflo_learning_reset_${suffix}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let client;
    let raceClient;
    let repository;

    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${lifecycleRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
      );
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const databaseUrl = new URL(baseDatabaseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      const strictMigrationScript = path.join(
        packageRoot,
        "scripts/strict-migrate.mjs",
      );
      await execFileAsync(process.execPath, [strictMigrationScript], {
        env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
      });

      client = new pg.Client({ connectionString: databaseUrl.toString() });
      await client.connect();
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${lifecycleRole}`);
      await assert.rejects(
        client.query("SELECT reflo_reset_learning_scope($1)", [ids.scope]),
        (error) => error.code === "42501",
      );
      await client.query("ROLLBACK");
      await seedKnowledgeFixture(client);
      repository = new PostgresKnowledgeRepository(databaseUrl.toString());

      const authorization = {
        actorId: ids.user,
        authorizationId: "knowledge-test-authorization",
        ownerScopeId: ids.scope,
      };
      const event = {
        attemptId: null,
        causationId: null,
        conceptIds: [ids.conceptA],
        correlationId: "00000000-0000-4000-8000-000000000999",
        deliveryId: null,
        eventVersion: 1,
        id: ids.event,
        idempotencyKey: "test/learning.lesson-completed/v1/knowledge-event-901",
        name: "lesson_completed",
        occurredAt: "2026-07-23T17:00:00.000Z",
        ownerScopeId: ids.scope,
        payload: {
          chapterId: ids.chapter,
          courseId: ids.course,
          modality: "text",
        },
        producer: "knowledge-repository-test",
        sessionId: ids.session,
        userId: ids.user,
      };

      assert.equal(
        (await repository.appendLearningEvent(authorization, event)).status,
        "appended",
      );
      assert.equal(
        (await repository.appendLearningEvent(authorization, event)).status,
        "replayed",
      );
      await assert.rejects(
        repository.appendLearningEvent(authorization, {
          ...event,
          payload: { ...event.payload, modality: "audio" },
        }),
        (error) =>
          error instanceof KnowledgePersistenceError &&
          error.code === "conflicting_duplicate",
      );
      await assert.rejects(
        repository.appendLearningEvent(authorization, {
          ...event,
          id: "00000000-0000-4000-8000-000000000902",
          idempotencyKey: "test/learning.question-asked/v1/knowledge-event-902",
          name: "question_asked",
          payload: { answer: "sensitive free-form text" },
        }),
        (error) =>
          error instanceof KnowledgePersistenceError &&
          error.code === "invalid_event",
      );

      const afterCorrect = await repository.recordEvidenceAndReplay(
        authorization,
        scoredEvidence(attemptId(2), ids.conceptA, "1.00000", "correct", 3),
        deliveryPreference,
      );
      assert.deepEqual(afterCorrect, {
        algorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
        alphaQuanta: "200000",
        assessmentStatus: "assessed",
        betaQuanta: "300000",
        confidence: "0.20000",
        configurationId: KNOWLEDGE_CONFIGURATION_ID,
        evidenceCount: 1,
        lastReviewedAt: "2026-07-23T17:00:02.000Z",
        mastery: "0.40000",
      });

      const afterOutOfOrderIncorrect = await repository.recordEvidenceAndReplay(
        authorization,
        scoredEvidence(attemptId(0), ids.conceptA, "0.00000", "incorrect", 1),
        deliveryPreference,
      );
      assert.equal(afterOutOfOrderIncorrect.mastery, "0.33333");
      assert.equal(afterOutOfOrderIncorrect.confidence, "0.33333");
      assert.equal(afterOutOfOrderIncorrect.evidenceCount, 2);
      assert.equal(
        afterOutOfOrderIncorrect.lastReviewedAt,
        "2026-07-23T17:00:02.000Z",
      );
      const trustedSnapshot = await client.query(
        `SELECT to_char(
           attempt_created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS attempt_created_at_order
         FROM attempt_concept_evidence
         WHERE owner_scope_id = $1 AND attempt_id = $2 AND concept_id = $3`,
        [ids.scope, attemptId(2), ids.conceptA],
      );
      assert.equal(
        trustedSnapshot.rows[0].attempt_created_at_order,
        "2026-07-23T17:00:02.000002Z",
      );
      await assert.rejects(
        repository.recordEvidenceAndReplay(
          authorization,
          scoredEvidence(attemptId(1), ids.conceptA, "1.00000", "correct", 3),
          deliveryPreference,
        ),
        (error) =>
          error instanceof KnowledgePersistenceError &&
          error.code === "invalid_evidence",
      );
      await assert.rejects(
        repository.recordEvidenceAndReplay(
          authorization,
          scoredEvidence(attemptId(5), ids.conceptA, "1.00000", "correct", 3),
          deliveryPreference,
        ),
        (error) =>
          error instanceof KnowledgePersistenceError &&
          error.code === "invalid_evidence",
      );
      await assert.rejects(
        insertRawEligibleEvidence(
          client,
          attemptId(1),
          ids.conceptRace,
          "graded",
        ),
        (error) => error.code === "23503",
      );

      const racedAttemptId = attemptId(6);
      await client.query(
        `INSERT INTO attempt
           (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
            outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, '{"option":"a"}', 'graded',
                 '2026-07-23T17:00:06.000006Z')`,
        [racedAttemptId, ids.scope, ids.user, ids.session, ids.quiz],
      );
      raceClient = new pg.Client({ connectionString: databaseUrl.toString() });
      await raceClient.connect();
      await client.query("BEGIN");
      await insertRawEligibleEvidence(
        client,
        racedAttemptId,
        ids.conceptRace,
        "graded",
      );
      await raceClient.query("BEGIN");
      await raceClient.query("SET LOCAL lock_timeout = '250ms'");
      await assert.rejects(
        raceClient.query(
          `UPDATE attempt
           SET outcome = 'superseded'
           WHERE owner_scope_id = $1 AND id = $2`,
          [ids.scope, racedAttemptId],
        ),
        (error) => error.code === "55P03",
      );
      await raceClient.query("ROLLBACK");
      await client.query("COMMIT");
      await assert.rejects(
        client.query(
          `UPDATE attempt
           SET outcome = 'superseded'
           WHERE owner_scope_id = $1 AND id = $2`,
          [ids.scope, racedAttemptId],
        ),
        (error) => error.code === "55000",
      );
      const replayHistory = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM fsrs_replay_run) AS run_count,
           (SELECT count(*)::integer FROM fsrs_replay_manifest) AS manifest_count,
           (SELECT count(*)::integer FROM fsrs_transition_payload) AS transition_count`,
      );
      assert.deepEqual(replayHistory.rows, [
        {
          manifest_count: 3,
          run_count: 2,
          transition_count: 3,
        },
      ]);
      const scheduleBeforeOverride = await client.query(
        `SELECT fsrs_profile_id, delivery_profile_id, tzdb_version,
                time_zone, chosen_local_time::text,
                fsrs_due_at, base_next_delivery_at, next_delivery_at,
                stability::text, difficulty::text, card_state, reps,
                learning_steps, current_replay_run_id
         FROM review_schedule
         WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3`,
        [ids.scope, ids.user, ids.conceptA],
      );
      assert.equal(scheduleBeforeOverride.rows.length, 1);
      assert.equal(
        scheduleBeforeOverride.rows[0].fsrs_profile_id,
        "fsrs-profile-v1",
      );
      assert.equal(
        scheduleBeforeOverride.rows[0].delivery_profile_id,
        "delivery-time-profile-v1",
      );
      assert.equal(scheduleBeforeOverride.rows[0].tzdb_version, "2026b");
      assert.equal(scheduleBeforeOverride.rows[0].time_zone, "UTC");
      assert.equal(
        scheduleBeforeOverride.rows[0].chosen_local_time,
        "09:00:00",
      );
      assert.equal(scheduleBeforeOverride.rows[0].card_state, 2);
      assert.equal(scheduleBeforeOverride.rows[0].reps, 2);
      assert.equal(scheduleBeforeOverride.rows[0].learning_steps, 0);
      assert.equal(
        scheduleBeforeOverride.rows[0].base_next_delivery_at.toISOString(),
        scheduleBeforeOverride.rows[0].next_delivery_at.toISOString(),
      );
      const unrelatedCard = await client.query(
        `SELECT card_digest
         FROM fsrs_card_payload
         WHERE owner_scope_id = $1
           AND card_digest <> (
             SELECT current_card_digest
             FROM review_schedule
             WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3
           )
         LIMIT 1`,
        [ids.scope, ids.user, ids.conceptA],
      );
      assert.equal(unrelatedCard.rows.length, 1);
      await assert.rejects(
        client.query(
          `UPDATE review_schedule
           SET current_card_digest = $4
           WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3`,
          [
            ids.scope,
            ids.user,
            ids.conceptA,
            unrelatedCard.rows[0].card_digest,
          ],
        ),
        (error) => error.code === "23503",
      );

      const afterAbstention = await repository.recordEvidenceAndReplay(
        authorization,
        {
          ...evidenceBase(attemptId(1), ids.conceptA),
          eligibleForMastery: false,
          fsrsRating: null,
          graderConfidence: null,
          ineligibilityReason: "semantic_unanswerable",
          judgmentKind: "unanswerable",
          rubricBand: null,
          score: null,
        },
        deliveryPreference,
      );
      assert.deepEqual(afterAbstention, afterOutOfOrderIncorrect);
      const afterSuperseded = await repository.recordEvidenceAndReplay(
        authorization,
        {
          ...scoredEvidence(
            attemptId(5),
            ids.conceptA,
            "1.00000",
            "correct",
            3,
          ),
          eligibleForMastery: false,
          fsrsRating: null,
          ineligibilityReason: "superseded",
        },
        deliveryPreference,
      );
      assert.deepEqual(afterSuperseded, afterOutOfOrderIncorrect);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM fsrs_replay_run",
          )
        ).rows[0].count,
        2,
      );

      const replay = await repository.recordEvidenceAndReplay(
        authorization,
        scoredEvidence(attemptId(2), ids.conceptA, "1.00000", "correct", 3),
        deliveryPreference,
      );
      assert.deepEqual(replay, afterOutOfOrderIncorrect);
      await assert.rejects(
        repository.recordEvidenceAndReplay(
          authorization,
          scoredEvidence(attemptId(2), ids.conceptA, "0.00000", "incorrect", 1),
          deliveryPreference,
        ),
        (error) =>
          error instanceof KnowledgePersistenceError &&
          error.code === "conflicting_duplicate",
      );

      const concurrentEvidence = scoredEvidence(
        attemptId(3),
        ids.conceptB,
        "0.00000",
        "incorrect",
        1,
      );
      const [independent, duplicateAdmission] = await Promise.all([
        repository.recordEvidenceAndReplay(
          authorization,
          concurrentEvidence,
          deliveryPreference,
        ),
        repository.recordEvidenceAndReplay(
          authorization,
          concurrentEvidence,
          deliveryPreference,
        ),
      ]);
      assert.deepEqual(duplicateAdmission, independent);
      assert.equal(independent.mastery, "0.20000");
      assert.equal(independent.evidenceCount, 1);
      const appendedTail = await repository.recordEvidenceAndReplay(
        authorization,
        scoredEvidence(attemptId(4), ids.conceptB, "1.00000", "correct", 3),
        deliveryPreference,
      );
      assert.equal(appendedTail.evidenceCount, 2);
      const reusedPrefix = await client.query(
        `SELECT manifest.transition_digest, count(*)::integer AS reference_count
         FROM fsrs_replay_manifest AS manifest
         JOIN fsrs_transition_payload AS transition
           ON transition.owner_scope_id = manifest.owner_scope_id
          AND transition.transition_digest = manifest.transition_digest
         WHERE transition.owner_scope_id = $1
           AND transition.concept_id = $2
           AND manifest.sequence = 0
         GROUP BY manifest.transition_digest`,
        [ids.scope, ids.conceptB],
      );
      assert.equal(reusedPrefix.rows.length, 1);
      assert.equal(reusedPrefix.rows[0].reference_count, 2);
      assert.match(reusedPrefix.rows[0].transition_digest, /^[0-9a-f]{64}$/);
      const conceptBStorage = await client.query(
        `SELECT
           (SELECT count(*)::integer
            FROM fsrs_replay_run
            WHERE owner_scope_id = $1 AND concept_id = $2) AS run_count,
           (SELECT count(*)::integer
            FROM fsrs_transition_payload
            WHERE owner_scope_id = $1 AND concept_id = $2) AS transition_count`,
        [ids.scope, ids.conceptB],
      );
      assert.deepEqual(conceptBStorage.rows, [
        { run_count: 2, transition_count: 2 },
      ]);

      const later = await repository.appendDeliveryOverride(authorization, {
        causationId: null,
        conceptId: ids.conceptA,
        deliverNotBeforeAt: "2026-08-01T12:00:00.000Z",
        id: ids.overrideA,
        reason: "user_snooze",
      });
      assert.equal(later.nextDeliveryAt, "2026-08-01T12:00:00.000Z");
      const unchanged = await repository.appendDeliveryOverride(authorization, {
        causationId: null,
        conceptId: ids.conceptA,
        deliverNotBeforeAt: "2026-07-30T12:00:00.000Z",
        id: ids.overrideB,
        reason: "reteach_follow_up",
      });
      assert.equal(unchanged.nextDeliveryAt, later.nextDeliveryAt);
      await assert.rejects(
        client.query(
          `INSERT INTO delivery_override_cancellation
             (owner_scope_id, id, user_id, concept_id, target_override_id,
              actor_id, authorization_id)
           VALUES ($1, $2, $3, $4, $5, $3, 'forged-cross-concept')`,
          [
            ids.scope,
            ids.overrideCancellationForged,
            ids.user,
            ids.conceptB,
            ids.overrideA,
          ],
        ),
        (error) => error.code === "23503",
      );
      const afterFirstCancellation = await repository.cancelDeliveryOverride(
        authorization,
        {
          causationId: null,
          conceptId: ids.conceptA,
          id: ids.overrideCancellationA,
          targetOverrideId: ids.overrideA,
        },
      );
      assert.equal(
        afterFirstCancellation.nextDeliveryAt,
        "2026-07-30T12:00:00.000Z",
      );
      const afterSecondCancellation = await repository.cancelDeliveryOverride(
        authorization,
        {
          causationId: null,
          conceptId: ids.conceptA,
          id: ids.overrideCancellationB,
          targetOverrideId: ids.overrideB,
        },
      );
      assert.equal(
        afterSecondCancellation.nextDeliveryAt,
        scheduleBeforeOverride.rows[0].base_next_delivery_at.toISOString(),
      );
      assert.deepEqual(
        await repository.cancelDeliveryOverride(authorization, {
          causationId: null,
          conceptId: ids.conceptA,
          id: ids.overrideCancellationB,
          targetOverrideId: ids.overrideB,
        }),
        afterSecondCancellation,
      );

      await assert.rejects(
        client.query(
          "UPDATE learning_event SET event_type = 'lesson_started' WHERE id = $1",
          [ids.event],
        ),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        client.query(
          `UPDATE attempt
           SET created_at = created_at + interval '1 microsecond'
           WHERE owner_scope_id = $1 AND id = $2`,
          [ids.scope, attemptId(2)],
        ),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        client.query(
          `UPDATE attempt
           SET outcome = 'superseded'
           WHERE owner_scope_id = $1 AND id = $2`,
          [ids.scope, attemptId(2)],
        ),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        client.query(
          `UPDATE delivery_override
           SET reason = 'channel_unavailable'
           WHERE owner_scope_id = $1 AND id = $2`,
          [ids.scope, ids.overrideA],
        ),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        client.query(
          `DELETE FROM fsrs_replay_run
           WHERE owner_scope_id = $1`,
          [ids.scope],
        ),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        client.query(
          `UPDATE attempt_concept_evidence
           SET score = 0.50000
           WHERE owner_scope_id = $1 AND attempt_id = $2 AND concept_id = $3`,
          [ids.scope, attemptId(2), ids.conceptA],
        ),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        client.query(
          `DELETE FROM learning_event_concept
           WHERE owner_scope_id = $1 AND learning_event_id = $2`,
          [ids.scope, ids.event],
        ),
        (error) => error.code === "55000",
      );

      await client.query(
        `INSERT INTO attempt
           (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
            outcome, created_at)
         SELECT
           (
             '10000000-0000-4000-8000-' ||
             lpad((ordinal + 1)::text, 12, '0')
           )::uuid,
           $1, $2, $3, $4, '{"option":"a"}', 'graded',
           '2026-07-24T00:00:00Z'::timestamptz +
             ordinal * interval '1 microsecond'
         FROM generate_series(0, 512) AS ordinal`,
        [ids.scope, ids.user, ids.session, ids.quiz],
      );
      await client.query(
        `INSERT INTO attempt_concept_evidence
           (owner_scope_id, attempt_id, concept_id, score, rubric_band,
            grader_confidence, rationale_ref, knowledge_algorithm_version,
            eligible_for_mastery, judgment_kind, grading_method, rubric_id,
            rubric_version, grading_policy_version, rating_mapping_version,
            knowledge_configuration_id, ineligibility_reason, fsrs_rating,
            replacement_for_attempt_id, attempt_created_at, attempt_user_id,
            attempt_outcome)
         SELECT
           attempt.owner_scope_id, attempt.id, $2, 1.00000, 'correct',
           0.95000, NULL, $3, true, 'scored', 'llm_short_answer',
           'rubric-fixture', '1', 'grading-policy-v1',
           'grading-policy-v1-rating-map', $4, NULL, 3, NULL,
           attempt.created_at, attempt.user_id, attempt.outcome
         FROM generate_series(0, 510) AS ordinal
         JOIN attempt
           ON attempt.owner_scope_id = $1
          AND attempt.id = (
            '10000000-0000-4000-8000-' ||
            lpad((ordinal + 1)::text, 12, '0')
          )::uuid`,
        [
          ids.scope,
          ids.conceptBound,
          KNOWLEDGE_ALGORITHM_VERSION,
          KNOWLEDGE_CONFIGURATION_ID,
        ],
      );
      const atReplayBound = await repository.recordEvidenceAndReplay(
        authorization,
        scoredEvidence(
          boundAttemptId(511),
          ids.conceptBound,
          "1.00000",
          "correct",
          3,
        ),
        deliveryPreference,
      );
      assert.equal(atReplayBound.evidenceCount, 512);
      const storageAtBound = await client.query(
        `SELECT
           (SELECT count(*)::integer
            FROM attempt_concept_evidence
            WHERE owner_scope_id = $1 AND concept_id = $2
              AND eligible_for_mastery) AS evidence_count,
           (SELECT count(*)::integer
            FROM fsrs_replay_run
            WHERE owner_scope_id = $1 AND concept_id = $2) AS run_count,
           (SELECT count(*)::integer
            FROM fsrs_replay_manifest AS manifest
            JOIN fsrs_replay_run AS replay
              ON replay.owner_scope_id = manifest.owner_scope_id
             AND replay.run_id = manifest.run_id
            WHERE replay.owner_scope_id = $1
              AND replay.concept_id = $2) AS manifest_count,
           (SELECT count(*)::integer
            FROM fsrs_transition_payload
            WHERE owner_scope_id = $1 AND concept_id = $2) AS transition_count`,
        [ids.scope, ids.conceptBound],
      );
      assert.deepEqual(storageAtBound.rows, [
        {
          evidence_count: 512,
          manifest_count: 512,
          run_count: 1,
          transition_count: 512,
        },
      ]);
      await assert.rejects(
        repository.recordEvidenceAndReplay(
          authorization,
          scoredEvidence(
            boundAttemptId(512),
            ids.conceptBound,
            "1.00000",
            "correct",
            3,
          ),
          deliveryPreference,
        ),
        (error) => error.code === "replay_limit_exceeded",
      );
      const afterRejectedAdmission = await client.query(
        `SELECT
           (SELECT count(*)::integer
            FROM attempt_concept_evidence
            WHERE owner_scope_id = $1 AND concept_id = $2
              AND eligible_for_mastery) AS evidence_count,
           (SELECT count(*)::integer
            FROM fsrs_replay_run
            WHERE owner_scope_id = $1 AND concept_id = $2) AS run_count`,
        [ids.scope, ids.conceptBound],
      );
      assert.deepEqual(afterRejectedAdmission.rows, [
        { evidence_count: 512, run_count: 1 },
      ]);

      const persisted = await client.query(
        `SELECT mastery::text, confidence::text, alpha_quanta::text,
                beta_quanta::text, evidence_count, assessment_status,
                half_life
         FROM knowledge_state
         WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3`,
        [ids.scope, ids.user, ids.conceptA],
      );
      assert.deepEqual(persisted.rows, [
        {
          alpha_quanta: "200000",
          assessment_status: "assessed",
          beta_quanta: "400000",
          confidence: "0.33333",
          evidence_count: 2,
          half_life: null,
          mastery: "0.33333",
        },
      ]);

      await client.query(`GRANT USAGE ON SCHEMA public TO ${lifecycleRole}`);
      await client.query(
        `GRANT EXECUTE ON FUNCTION reflo_reset_learning_scope(uuid) TO ${lifecycleRole}`,
      );
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${lifecycleRole}`);
      await client.query("SELECT reflo_reset_learning_scope($1)", [ids.scope]);
      await client.query("COMMIT");
      const reset = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM attempt
            WHERE owner_scope_id = $1) AS attempt_count,
           (SELECT count(*)::integer FROM attempt_concept_evidence
            WHERE owner_scope_id = $1) AS evidence_count,
           (SELECT count(*)::integer FROM fsrs_card_payload
            WHERE owner_scope_id = $1) AS card_count,
           (SELECT count(*)::integer FROM fsrs_replay_manifest
            WHERE owner_scope_id = $1) AS manifest_count,
           (SELECT count(*)::integer FROM fsrs_replay_run
            WHERE owner_scope_id = $1) AS run_count,
           (SELECT count(*)::integer FROM fsrs_transition_payload
            WHERE owner_scope_id = $1) AS transition_count,
           (SELECT count(*)::integer FROM scheduler_delivery_resolution
            WHERE owner_scope_id = $1) AS resolution_count,
           (SELECT count(*)::integer FROM review_schedule
            WHERE owner_scope_id = $1) AS schedule_count,
           (SELECT count(*)::integer FROM delivery_override
            WHERE owner_scope_id = $1) AS override_count,
           (SELECT count(*)::integer FROM delivery_override_cancellation
            WHERE owner_scope_id = $1) AS cancellation_count,
           (SELECT count(*)::integer FROM knowledge_state
            WHERE owner_scope_id = $1) AS knowledge_state_count,
           (SELECT count(*)::integer FROM learning_event
            WHERE owner_scope_id = $1) AS learning_event_count,
           (SELECT count(*)::integer FROM course
            WHERE owner_scope_id = $1) AS retained_course_count`,
        [ids.scope],
      );
      assert.deepEqual(reset.rows, [
        {
          attempt_count: 0,
          cancellation_count: 0,
          card_count: 0,
          evidence_count: 0,
          knowledge_state_count: 0,
          learning_event_count: 0,
          manifest_count: 0,
          override_count: 0,
          resolution_count: 0,
          retained_course_count: 1,
          run_count: 0,
          schedule_count: 0,
          transition_count: 0,
        },
      ]);
    } finally {
      await repository?.close().catch(() => undefined);
      await raceClient?.end().catch(() => undefined);
      await client?.end().catch(() => undefined);
      await admin
        .query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
        .catch(() => undefined);
      await admin
        .query(`DROP ROLE IF EXISTS ${lifecycleRole}`)
        .catch(() => undefined);
      await admin.end();
    }
  },
);

async function seedKnowledgeFixture(client) {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
     VALUES ($1, decode('01', 'hex'), decode('11', 'hex'))`,
    [ids.user],
  );
  await client.query("INSERT INTO owner_scope (id) VALUES ($1)", [ids.scope]);
  await client.query(
    `INSERT INTO scope_membership (id, owner_scope_id, user_id)
     VALUES ($1, $2, $3)`,
    [ids.member, ids.scope, ids.user],
  );
  await client.query("COMMIT");
  await client.query(
    `INSERT INTO source_document
       (id, owner_scope_id, object_key, checksum, media_type, byte_size,
        parse_status)
     VALUES ($1, $2, 'owners/knowledge/source', 'sha256:knowledge',
             'application/pdf', 10, 'parsed')`,
    [ids.document, ids.scope],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Knowledge fixture', 'ready')`,
    [ids.course, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO chapter
       (id, owner_scope_id, course_id, chapter_order, title)
     VALUES ($1, $2, $3, 1, 'Chapter one')`,
    [ids.chapter, ids.scope, ids.course],
  );
  await client.query(
    `INSERT INTO concept
       (id, owner_scope_id, chapter_id, name, generation_version)
     VALUES ($1, $2, $3, 'Concept A', 'fixture-v1'),
            ($4, $2, $3, 'Concept B', 'fixture-v1'),
            ($5, $2, $3, 'Concept Bound', 'fixture-v1'),
            ($6, $2, $3, 'Concept Race', 'fixture-v1')`,
    [
      ids.conceptA,
      ids.scope,
      ids.chapter,
      ids.conceptB,
      ids.conceptBound,
      ids.conceptRace,
    ],
  );
  await client.query(
    `INSERT INTO quiz_item
       (id, owner_scope_id, course_id, item_type, difficulty, prompt,
        keyed_answer, version)
     VALUES ($1, $2, $3, 'multiple_choice', 1, 'Fixture question',
             '{"correctOption":"a"}', 'fixture-v1')`,
    [ids.quiz, ids.scope, ids.course],
  );
  await client.query(
    `INSERT INTO quiz_item_concept
       (owner_scope_id, quiz_item_id, concept_id)
     VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5), ($1, $2, $6)`,
    [
      ids.scope,
      ids.quiz,
      ids.conceptA,
      ids.conceptB,
      ids.conceptBound,
      ids.conceptRace,
    ],
  );
  await client.query(
    `INSERT INTO study_session
       (id, owner_scope_id, user_id, course_id, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [ids.session, ids.scope, ids.user, ids.course],
  );
  for (let index = 0; index < 6; index += 1) {
    await client.query(
      `INSERT INTO attempt
         (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
          outcome, created_at)
       VALUES ($1, $2, $3, $4, $5, '{"option":"a"}', $6, $7)`,
      [
        attemptId(index),
        ids.scope,
        ids.user,
        ids.session,
        ids.quiz,
        index === 1 ? "abstained" : index === 5 ? "superseded" : "graded",
        index === 2
          ? "2026-07-23T17:00:02.000002Z"
          : `2026-07-23T17:00:0${index}.000Z`,
      ],
    );
  }
}

function attemptId(index) {
  return `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`;
}

function boundAttemptId(index) {
  return `10000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`;
}

function evidenceBase(attemptIdValue, conceptId) {
  return {
    attemptId: attemptIdValue,
    conceptId,
    gradingMethod: "llm_short_answer",
    gradingPolicyVersion: "grading-policy-v1",
    knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
    knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
    rationaleRef: null,
    ratingMappingVersion: "grading-policy-v1-rating-map",
    replacementForAttemptId: null,
    rubricId: "rubric-fixture",
    rubricVersion: "1",
  };
}

function scoredEvidence(
  attemptIdValue,
  conceptId,
  score,
  rubricBand,
  fsrsRating,
) {
  return {
    ...evidenceBase(attemptIdValue, conceptId),
    eligibleForMastery: true,
    fsrsRating,
    graderConfidence: "0.95000",
    ineligibilityReason: null,
    judgmentKind: "scored",
    rubricBand,
    score,
  };
}

async function insertRawEligibleEvidence(
  client,
  attemptIdValue,
  conceptId,
  snapshottedOutcome,
) {
  return client.query(
    `INSERT INTO attempt_concept_evidence
       (owner_scope_id, attempt_id, concept_id, score, rubric_band,
        grader_confidence, rationale_ref, knowledge_algorithm_version,
        eligible_for_mastery, judgment_kind, grading_method, rubric_id,
        rubric_version, grading_policy_version, rating_mapping_version,
        knowledge_configuration_id, ineligibility_reason, fsrs_rating,
        replacement_for_attempt_id, attempt_created_at, attempt_user_id,
        attempt_outcome)
     SELECT
       attempt.owner_scope_id, attempt.id, $2, 1.00000, 'correct', 0.95000,
       NULL, $3, true, 'scored', 'llm_short_answer', 'rubric-fixture', '1',
       'grading-policy-v1', 'grading-policy-v1-rating-map', $4, NULL, 3,
       NULL, attempt.created_at, attempt.user_id, $5
     FROM attempt
     WHERE attempt.owner_scope_id = $1 AND attempt.id = $6`,
    [
      ids.scope,
      conceptId,
      KNOWLEDGE_ALGORITHM_VERSION,
      KNOWLEDGE_CONFIGURATION_ID,
      snapshottedOutcome,
      attemptIdValue,
    ],
  );
}
