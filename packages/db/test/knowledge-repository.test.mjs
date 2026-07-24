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
  course: "00000000-0000-4000-8000-000000000401",
  document: "00000000-0000-4000-8000-000000000301",
  event: "00000000-0000-4000-8000-000000000901",
  member: "00000000-0000-4000-8000-000000000201",
  quiz: "00000000-0000-4000-8000-000000000701",
  scope: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000801",
  user: "00000000-0000-4000-8000-000000000001",
};

test(
  "PostgresKnowledgeRepository keeps events and evidence append-only and replays exact mastery",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const databaseName = `reflo_knowledge_${suffix}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let client;
    let repository;

    await admin.connect();
    try {
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
      );
      assert.equal(afterOutOfOrderIncorrect.mastery, "0.33333");
      assert.equal(afterOutOfOrderIncorrect.confidence, "0.33333");
      assert.equal(afterOutOfOrderIncorrect.evidenceCount, 2);
      assert.equal(
        afterOutOfOrderIncorrect.lastReviewedAt,
        "2026-07-23T17:00:02.000Z",
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
      );
      assert.deepEqual(afterAbstention, afterOutOfOrderIncorrect);

      const replay = await repository.recordEvidenceAndReplay(
        authorization,
        scoredEvidence(attemptId(2), ids.conceptA, "1.00000", "correct", 3),
      );
      assert.deepEqual(replay, afterOutOfOrderIncorrect);
      await assert.rejects(
        repository.recordEvidenceAndReplay(
          authorization,
          scoredEvidence(attemptId(2), ids.conceptA, "0.00000", "incorrect", 1),
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
        repository.recordEvidenceAndReplay(authorization, concurrentEvidence),
        repository.recordEvidenceAndReplay(authorization, concurrentEvidence),
      ]);
      assert.deepEqual(duplicateAdmission, independent);
      assert.equal(independent.mastery, "0.20000");
      assert.equal(independent.evidenceCount, 1);

      await assert.rejects(
        client.query(
          "UPDATE learning_event SET event_type = 'lesson_started' WHERE id = $1",
          [ids.event],
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
    } finally {
      await repository?.close().catch(() => undefined);
      await client?.end().catch(() => undefined);
      await admin
        .query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
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
            ($4, $2, $3, 'Concept B', 'fixture-v1')`,
    [ids.conceptA, ids.scope, ids.chapter, ids.conceptB],
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
     VALUES ($1, $2, $3), ($1, $2, $4)`,
    [ids.scope, ids.quiz, ids.conceptA, ids.conceptB],
  );
  await client.query(
    `INSERT INTO study_session
       (id, owner_scope_id, user_id, course_id, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [ids.session, ids.scope, ids.user, ids.course],
  );
  for (let index = 0; index < 4; index += 1) {
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
        index === 1 ? "abstained" : "graded",
        `2026-07-23T17:00:0${index}.000Z`,
      ],
    );
  }
}

function attemptId(index) {
  return `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`;
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
