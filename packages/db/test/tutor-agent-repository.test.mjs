import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";
import test from "node:test";
import assert from "node:assert/strict";

import { PostgresTutorAgentRepository } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  asset: "10000000-0000-4000-8000-000000000001",
  attempt: "10000000-0000-4000-8000-000000000002",
  chapter: "00000000-0000-4000-8000-000000000501",
  concept: "00000000-0000-4000-8000-000000000601",
  course: "00000000-0000-4000-8000-000000000401",
  document: "00000000-0000-4000-8000-000000000301",
  foreignCourse: "00000000-0000-4000-8000-000000000402",
  foreignDocument: "00000000-0000-4000-8000-000000000302",
  foreignQuiz: "00000000-0000-4000-8000-000000000702",
  foreignSpan: "00000000-0000-4000-8000-000000000902",
  generation: "10000000-0000-4000-8000-000000000003",
  member: "00000000-0000-4000-8000-000000000201",
  quiz: "00000000-0000-4000-8000-000000000701",
  sameCourseQuiz: "00000000-0000-4000-8000-000000000703",
  sameCourseSpan: "00000000-0000-4000-8000-000000000903",
  scope: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000801",
  span: "00000000-0000-4000-8000-000000000901",
  user: "00000000-0000-4000-8000-000000000001",
};

const authorization = {
  actorId: ids.user,
  authorizationId: "tutor-agent-db-test-authorization",
  ownerScopeId: ids.scope,
};

test(
  "PostgresTutorAgentRepository persists the evidence-backed Flow B loop and sanitized tutor events",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_tutor_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let client;
    let repository;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const databaseUrl = new URL(baseDatabaseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      await execFileAsync(
        process.execPath,
        [path.join(packageRoot, "scripts/strict-migrate.mjs")],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
        },
      );
      client = new pg.Client({ connectionString: databaseUrl.toString() });
      await client.connect();
      await seedFixture(client);
      repository = new PostgresTutorAgentRepository(databaseUrl.toString());

      const session = sessionFixture();
      const first = await repository.saveReteach(authorization, {
        concept: session.concepts[0],
        generated: generatedLesson(),
        session,
      });
      const replay = await repository.saveReteach(authorization, {
        concept: session.concepts[0],
        generated: generatedLesson(),
        session,
      });
      assert.equal(first.assetId, ids.asset);
      assert.equal(replay.assetId, ids.asset);
      assert.equal(first.replacementOrdinal, 1);
      assert.equal(first.semanticSimilarity, "0.00000");

      const loaded = await repository.loadSession(authorization, ids.session);
      assert.equal(loaded.concepts[0].reteachLessons.length, 1);
      assert.equal(
        loaded.concepts[0].reteachLessons[0].strategyTag,
        "analogy-v1",
      );
      assert.equal(loaded.concepts[0].nextRetestQuestion.itemId, ids.quiz);
      assert.deepEqual(loaded.concepts[0].sourceSpans, [
        { id: ids.span, text: "A VPC is an isolated virtual network." },
      ]);
      assert.deepEqual(
        await repository.resolveAuthorizedQuestionSourceSpanIds(authorization, {
          courseId: ids.course,
          currentQuestionId: ids.quiz,
          questionId: ids.quiz,
          sessionId: ids.session,
          sourceDocumentId: ids.document,
        }),
        [ids.span],
      );
      assert.deepEqual(
        await repository.resolveAuthorizedQuestionSourceSpanIds(authorization, {
          courseId: ids.course,
          questionId: ids.foreignQuiz,
          sessionId: ids.session,
          sourceDocumentId: ids.document,
        }),
        [],
      );
      assert.deepEqual(
        await repository.resolveAuthorizedQuestionSourceSpanIds(authorization, {
          courseId: ids.course,
          currentQuestionId: ids.quiz,
          questionId: ids.sameCourseQuiz,
          sessionId: ids.session,
          sourceDocumentId: ids.document,
        }),
        [],
      );

      await seedCorrectRetest(client);
      assert.deepEqual(
        await repository.resolveAuthorizedQuestionSourceSpanIds(authorization, {
          courseId: ids.course,
          questionId: ids.quiz,
          sessionId: ids.session,
          sourceDocumentId: ids.document,
        }),
        [ids.span],
      );
      const result = await repository.recordLoopSuccess(authorization, {
        conceptId: ids.concept,
        finalMastery: "0.28571",
        initialMastery: "0.16667",
        latestAttemptId: ids.attempt,
        replacementCount: 1,
        sessionId: ids.session,
      });
      assert.equal(result.masteryDelta, "0.11904");
      assert.equal(result.outcome, "retest_succeeded");
      assert.deepEqual(
        await repository.recordLoopSuccess(authorization, {
          conceptId: ids.concept,
          finalMastery: "0.28571",
          initialMastery: "0.16667",
          latestAttemptId: ids.attempt,
          replacementCount: 1,
          sessionId: ids.session,
        }),
        result,
      );
      const completed = await repository.loadSession(
        authorization,
        ids.session,
      );
      assert.equal(
        completed.concepts[0].loopResult.evidenceAttemptId,
        ids.attempt,
      );

      await repository.recordTutorQuestion(authorization, {
        idempotencyKey: "test/tutor-question/v1/one",
        resultKind: "answer",
        sessionId: ids.session,
        sourceSpanIds: [ids.span],
      });
      await repository.recordTutorQuestion(authorization, {
        idempotencyKey: "test/tutor-question/v1/one",
        resultKind: "answer",
        sessionId: ids.session,
        sourceSpanIds: [ids.span],
      });
      const question = await client.query(
        `SELECT payload
         FROM learning_event
         WHERE owner_scope_id = $1 AND event_type = 'question_asked'`,
        [ids.scope],
      );
      assert.equal(question.rows.length, 1);
      assert.deepEqual(question.rows[0].payload, {
        resultKind: "answer",
        sourceSpanIds: [ids.span],
      });
      assert.equal(
        JSON.stringify(question.rows[0].payload).includes(
          "A VPC is an isolated virtual network.",
        ),
        false,
      );
    } finally {
      await repository?.close().catch(() => undefined);
      await client?.end().catch(() => undefined);
      await admin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  },
);

async function seedFixture(client) {
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
     VALUES ($1, $2, 'owners/tutor/source', 'sha256:tutor',
             'application/pdf', 10, 'parsed')`,
    [ids.document, ids.scope],
  );
  await client.query(
    `INSERT INTO source_span
       (id, owner_scope_id, source_document_id, canonical_text, text_hash,
        canonical_start, canonical_end, parser_version, chunker_version,
        tokenizer_version, chunk_order)
     VALUES ($1, $2, $3, 'A VPC is an isolated virtual network.',
             'hash-vpc', 0, 37, 'p1', 'c1', 't1', 0)`,
    [ids.span, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Tutor fixture', 'ready')`,
    [ids.course, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO chapter
       (id, owner_scope_id, course_id, chapter_order, title)
     VALUES ($1, $2, $3, 1, 'Networking')`,
    [ids.chapter, ids.scope, ids.course],
  );
  await client.query(
    `INSERT INTO concept
       (id, owner_scope_id, chapter_id, name, generation_version,
        concept_order)
     VALUES ($1, $2, $3, 'Virtual Private Cloud', 'fixture-v1', 0)`,
    [ids.concept, ids.scope, ids.chapter],
  );
  await client.query(
    `INSERT INTO concept_source_span
       (owner_scope_id, concept_id, source_span_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.concept, ids.span],
  );
  await client.query(
    `INSERT INTO study_session
       (id, owner_scope_id, user_id, course_id, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [ids.session, ids.scope, ids.user, ids.course],
  );
  await client.query(
    `INSERT INTO knowledge_state
       (owner_scope_id, user_id, concept_id, mastery, confidence,
        last_reviewed_at, review_count, algorithm_version, alpha_quanta,
        beta_quanta, evidence_count, assessment_status,
        knowledge_configuration_id)
     VALUES (
       $1, $2, $3, 0.16667, 0.33333, now() - interval '1 minute', 2,
       'knowledge-model-v1', 100000, 500000, 2, 'assessed',
       'beta-1-3-unit-mass-score-5dp-v1'
     )`,
    [ids.scope, ids.user, ids.concept],
  );
  await client.query(
    `INSERT INTO quiz_item
       (id, owner_scope_id, course_id, item_type, difficulty, prompt,
        keyed_answer, version, normalized_prompt_hash, response_options)
     VALUES (
       $1, $2, $3, 'multiple_choice', 2, 'Which statement defines a VPC?',
       to_jsonb('An isolated network'::text), 'fixture-v1', $4,
       '["An isolated network","A storage bucket"]'::jsonb
     )`,
    [ids.quiz, ids.scope, ids.course, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO quiz_item_concept
       (owner_scope_id, quiz_item_id, concept_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.quiz, ids.concept],
  );
  await client.query(
    `INSERT INTO quiz_item_source_span
       (owner_scope_id, quiz_item_id, source_span_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.quiz, ids.span],
  );
  await client.query(
    `INSERT INTO source_span
       (id, owner_scope_id, source_document_id, canonical_text, text_hash,
        canonical_start, canonical_end, parser_version, chunker_version,
        tokenizer_version, chunk_order)
     VALUES ($1, $2, $3, 'Unrelated same-course material.', 'hash-same-course',
             30, 61, 'p1', 'c1', 't1', 1)`,
    [ids.sameCourseSpan, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO quiz_item
       (id, owner_scope_id, course_id, item_type, difficulty, prompt,
        keyed_answer, version, normalized_prompt_hash, response_options)
     VALUES (
       $1, $2, $3, 'multiple_choice', 2, 'Unrelated same-course question?',
       to_jsonb('Different answer'::text), 'fixture-v1', $4,
       '["Different answer","Other"]'::jsonb
     )`,
    [ids.sameCourseQuiz, ids.scope, ids.course, "c".repeat(64)],
  );
  await client.query(
    `INSERT INTO quiz_item_source_span
       (owner_scope_id, quiz_item_id, source_span_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.sameCourseQuiz, ids.sameCourseSpan],
  );
  await client.query(
    `INSERT INTO source_document
       (id, owner_scope_id, object_key, checksum, media_type, byte_size,
        parse_status)
     VALUES ($1, $2, 'owners/tutor/foreign-source', 'sha256:foreign-tutor',
             'application/pdf', 10, 'parsed')`,
    [ids.foreignDocument, ids.scope],
  );
  await client.query(
    `INSERT INTO source_span
       (id, owner_scope_id, source_document_id, canonical_text, text_hash,
        canonical_start, canonical_end, parser_version, chunker_version,
        tokenizer_version, chunk_order)
     VALUES ($1, $2, $3, 'Foreign course material.', 'hash-foreign', 0, 24,
             'p1', 'c1', 't1', 0)`,
    [ids.foreignSpan, ids.scope, ids.foreignDocument],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Foreign tutor fixture', 'ready')`,
    [ids.foreignCourse, ids.scope, ids.foreignDocument],
  );
  await client.query(
    `INSERT INTO quiz_item
       (id, owner_scope_id, course_id, item_type, difficulty, prompt,
        keyed_answer, version, normalized_prompt_hash, response_options)
     VALUES (
       $1, $2, $3, 'multiple_choice', 2, 'Foreign question?',
       to_jsonb('Foreign answer'::text), 'fixture-v1', $4,
       '["Foreign answer","Other"]'::jsonb
     )`,
    [ids.foreignQuiz, ids.scope, ids.foreignCourse, "b".repeat(64)],
  );
  await client.query(
    `INSERT INTO quiz_item_source_span
       (owner_scope_id, quiz_item_id, source_span_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.foreignQuiz, ids.foreignSpan],
  );
}

async function seedCorrectRetest(client) {
  await client.query(
    `INSERT INTO attempt
       (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
        outcome, grading_policy_version, rating_mapping_version, created_at)
     VALUES (
       $1, $2, $3, $4, $5, to_jsonb('An isolated network'::text),
       'graded', 'grading-policy-v1', 'rating-mapping-v1',
       now() + interval '1 second'
     )`,
    [ids.attempt, ids.scope, ids.user, ids.session, ids.quiz],
  );
  await client.query(
    `INSERT INTO attempt_concept_evidence
       (owner_scope_id, attempt_id, concept_id, score, rubric_band,
        grader_confidence, knowledge_algorithm_version,
        eligible_for_mastery, judgment_kind, grading_method, rubric_id,
        rubric_version, grading_policy_version, rating_mapping_version,
        knowledge_configuration_id, fsrs_rating, attempt_created_at,
        attempt_user_id, attempt_outcome)
     SELECT
       $1, $2, $3, 1.00000, 'correct', NULL, 'knowledge-model-v1',
       true, 'scored', 'keyed_mc', 'rubric-vpc', '1',
       'grading-policy-v1', 'rating-mapping-v1',
       'beta-1-3-unit-mass-score-5dp-v1', 3, attempt.created_at,
       $4, 'graded'
     FROM attempt
     WHERE owner_scope_id = $1 AND id = $2`,
    [ids.scope, ids.attempt, ids.concept, ids.user],
  );
  await client.query(
    `UPDATE knowledge_state
     SET mastery = 0.28571, confidence = 0.42857, alpha_quanta = 200000,
         beta_quanta = 500000, evidence_count = 3, review_count = 3,
         last_reviewed_at = now() + interval '1 second'
     WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3`,
    [ids.scope, ids.user, ids.concept],
  );
}

function sessionFixture() {
  return {
    actorId: ids.user,
    authorizationId: authorization.authorizationId,
    concepts: [
      {
        chapterId: ids.chapter,
        conceptId: ids.concept,
        conceptName: "Virtual Private Cloud",
        dueForReview: false,
        eligibleAttemptCount: 2,
        latestEligibleAttempt: {
          attemptId: "20000000-0000-4000-8000-000000000001",
          createdAt: "2026-07-24T12:02:00.000Z",
          eligibleForMastery: true,
          quizItemId: ids.quiz,
          rubricBand: "incorrect",
          score: "0.00000",
        },
        latestLessonExposureAt: "2026-07-24T12:00:00.000Z",
        lesson: null,
        loopResult: null,
        mastery: "0.16667",
        nextRetestQuestion: null,
        reteachLessons: [],
        sourceSpans: [
          { id: ids.span, text: "A VPC is an isolated virtual network." },
        ],
      },
    ],
    courseId: ids.course,
    ownerScopeId: ids.scope,
    sessionId: ids.session,
    sourceDocumentId: ids.document,
    status: "active",
    userId: ids.user,
  };
}

function generatedLesson() {
  return {
    assetId: ids.asset,
    baselineMastery: "0.16667",
    chapterId: ids.chapter,
    conceptId: ids.concept,
    contentHash: "b".repeat(64),
    generationId: ids.generation,
    generationVersion: "reteach-generation-v1",
    modelProvenance: {
      adapterVersion: "fixture-adapter-v1",
      evidenceClassification: "authoritative",
      effectiveModel: "qwen-plus",
      effectiveModelVersion: "fixture-v1",
      generationParametersVersion: "lesson-generation-parameters-v1",
      inputSchemaVersion: "lesson-input-v1",
      promptDefinitionDigest: "c".repeat(64),
      promptDigest: "d".repeat(64),
      promptId: "lesson-reteach",
      promptVersion: "1",
      requestedSelector: "qwen.grounded-generation",
      resultSchemaVersion: "lesson-result-v1",
      routePolicyVersion: "route-policy-v6",
      task: "lesson.reteach.v1",
      validationOutcome: "passed",
    },
    objectKey: "owners/tutor/reteach.md",
    ownerScopeId: ids.scope,
    replacementOrdinal: 1,
    semanticSimilarity: "0.00000",
    sessionId: ids.session,
    sourceSpanIds: [ids.span],
    storage: {
      byteSize: 50,
      contentType: "text/markdown; charset=utf-8",
      etag: "etag-reteach",
      objectKey: "owners/tutor/reteach.md",
    },
    strategyTag: "analogy-v1",
  };
}
