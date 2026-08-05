import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";
import test from "node:test";
import assert from "node:assert/strict";

import {
  PostgresConnectedDemoRepository,
  PostgresKnowledgeRepository,
  PostgresTutorAgentRepository,
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
  asset: "16200000-0000-4000-8000-000000000001",
  chapter: "16200000-0000-4000-8000-000000000002",
  concept: "16200000-0000-4000-8000-000000000003",
  course: "16200000-0000-4000-8000-000000000004",
  curriculum: "16200000-0000-4000-8000-000000000005",
  document: "16200000-0000-4000-8000-000000000006",
  embedding: "16200000-0000-4000-8000-000000000007",
  fallbackQuiz: "16200000-0000-4000-8000-000000000023",
  lessonOperation: "16200000-0000-4000-8000-000000000008",
  member: "16200000-0000-4000-8000-000000000009",
  otherConcept: "16200000-0000-4000-8000-000000000020",
  otherScope: "16200000-0000-4000-8000-000000000010",
  placementBank: "16200000-0000-4000-8000-000000000021",
  placementOperation: "16200000-0000-4000-8000-000000000022",
  quizA: "16200000-0000-4000-8000-000000000011",
  quizB: "16200000-0000-4000-8000-000000000012",
  quizC: "16200000-0000-4000-8000-000000000013",
  quizD: "16200000-0000-4000-8000-000000000017",
  quizE: "16200000-0000-4000-8000-000000000018",
  quizF: "16200000-0000-4000-8000-000000000019",
  scope: "16200000-0000-4000-8000-000000000014",
  span: "16200000-0000-4000-8000-000000000015",
  user: "16200000-0000-4000-8000-000000000016",
};
const placementItemIds = Array.from(
  { length: 10 },
  (_, index) =>
    `16300000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

const authorization = {
  actorId: ids.user,
  authorizationId: "connected-demo-db-test-authorization",
  ownerScopeId: ids.scope,
};
const deliveryPreference = {
  chosenLocalTime: "09:00",
  timeZone: "UTC",
};

test(
  "connected demo reset reauthorizes, replays weak evidence, and cleans prior state",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_connected_demo_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let client;
    let connected;
    let knowledge;
    let tutor;

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
      await seedConnectedFixture(client);

      connected = new PostgresConnectedDemoRepository(databaseUrl.toString());
      knowledge = new PostgresKnowledgeRepository(databaseUrl.toString());
      tutor = new PostgresTutorAgentRepository(databaseUrl.toString(), {
        retestItemTypes: ["short_answer"],
      });

      await assert.rejects(
        connected.resetWeakState(
          { ...authorization, ownerScopeId: ids.otherScope },
          ids.course,
        ),
        /seed content is unavailable/,
      );

      const first = await resetAndReplay(connected, knowledge);
      assert.equal(first.courseId, ids.course);
      assert.equal(first.conceptId, ids.concept);
      assert.equal(first.evidence.length, 2);

      const state = await loadState(client);
      assert.deepEqual(state, {
        confidence: "0.33333",
        evidence_count: 2,
        mastery: "0.16667",
      });

      const session = await connected.loadSessionSummary(
        authorization,
        first.sessionId,
      );
      assert.deepEqual(session, {
        courseId: ids.course,
        sessionId: first.sessionId,
        status: "active",
        summary: null,
      });
      assert.equal(
        await connected.loadSessionSummary(
          { ...authorization, ownerScopeId: ids.otherScope },
          first.sessionId,
        ),
        null,
      );

      const tutorSession = await tutor.loadSession(
        authorization,
        first.sessionId,
      );
      assert.equal(
        tutorSession.concepts[0].nextRetestQuestion.itemId,
        ids.quizC,
      );
      assert.equal(
        tutorSession.concepts[0].nextRetestQuestion.itemType,
        "short_answer",
      );

      assert.deepEqual(
        await connected.loadPlacement(authorization, first.sessionId),
        {
          answered: 10,
          failure: null,
          question: null,
          status: "complete",
          total: 10,
        },
      );
      const refreshedSeed = await connected.startOrResumeStudySession(
        authorization,
        ids.course,
      );
      assert.equal(refreshedSeed.plan.demoFlowBPlacementComplete, true);
      assert.equal(refreshedSeed.plan.nextAction, "review");
      await client.query(
        `UPDATE study_session
         SET status = 'completed', ended_at = clock_timestamp()
         WHERE id = $1`,
        [first.sessionId],
      );
      const placementStudy = await connected.startOrResumeStudySession(
        authorization,
        ids.course,
      );
      assert.equal(placementStudy.plan.nextAction, "placement");

      const initialPlacement = await connected.loadPlacement(
        authorization,
        placementStudy.sessionId,
      );
      assert.deepEqual(initialPlacement, {
        answered: 0,
        failure: null,
        question: {
          difficulty: 1,
          id: placementItemIds[0],
          itemType: "multiple_choice",
          position: 1,
          prompt: "Placement question 1",
          responseOptions: ["Correct 1", "Distractor 1"],
        },
        status: "question",
        total: 10,
      });
      assert.equal(JSON.stringify(initialPlacement).includes("keyed"), false);
      await assert.rejects(
        connected.submitPlacementChoice(
          authorization,
          placementStudy.sessionId,
          {
            answer: "Correct 2",
            idempotencyKey: "placement-db-test/out-of-order-item-2",
            questionId: placementItemIds[1],
          },
        ),
        (error) => error?.code === "question_unavailable",
      );

      const firstChoice = await connected.submitPlacementChoice(
        authorization,
        placementStudy.sessionId,
        {
          answer: "Correct 1",
          idempotencyKey: "placement-db-test/item-1",
          questionId: placementItemIds[0],
        },
      );
      assert.equal(firstChoice.correct, true);
      assert.equal(firstChoice.status, "created");
      assert.equal(firstChoice.evidence.length, 1);
      const beforeProjection = await connected.loadPlacement(
        authorization,
        placementStudy.sessionId,
      );
      assert.equal(beforeProjection.answered, 0);
      assert.equal(beforeProjection.question.id, placementItemIds[0]);
      const replayedChoice = await connected.submitPlacementChoice(
        authorization,
        placementStudy.sessionId,
        {
          answer: "Correct 1",
          idempotencyKey: "placement-db-test/item-1",
          questionId: placementItemIds[0],
        },
      );
      assert.equal(replayedChoice.attemptId, firstChoice.attemptId);
      assert.equal(replayedChoice.status, "replayed");
      for (const evidence of replayedChoice.evidence) {
        await knowledge.recordEvidenceAndReplay(
          authorization,
          evidence,
          deliveryPreference,
        );
      }
      await assert.rejects(
        connected.submitPlacementChoice(
          authorization,
          placementStudy.sessionId,
          {
            answer: "Distractor 1",
            idempotencyKey: "placement-db-test/item-1",
            questionId: placementItemIds[0],
          },
        ),
        (error) => error?.code === "conflicting_duplicate",
      );

      await client.query(
        `INSERT INTO attempt
           (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
            outcome, grader_provenance, submission_idempotency_key,
            grading_policy_version, rating_mapping_version)
         VALUES ('16400000-0000-4000-8000-000000000001', $1, $2, $3, $4,
                 '{"text":"uncertain"}'::jsonb, 'abstained', '{}'::jsonb,
                 'placement-db-test/fallback-original',
                 'grading-policy-v1', 'rating-mapping-v1')`,
        [ids.scope, ids.user, placementStudy.sessionId, placementItemIds[1]],
      );
      const pendingFallbackPlacement = await connected.loadPlacement(
        authorization,
        placementStudy.sessionId,
      );
      assert.equal(pendingFallbackPlacement.answered, 1);
      assert.equal(pendingFallbackPlacement.question.id, placementItemIds[1]);
      await client.query(
        `INSERT INTO attempt
           (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
            outcome, grader_provenance, submission_idempotency_key,
            grading_policy_version, rating_mapping_version,
            replacement_for_attempt_id)
         VALUES ('16400000-0000-4000-8000-000000000002', $1, $2, $3, $4,
                 '{"option":"Fallback correct"}'::jsonb, 'graded',
                 '{"gradingMethod":"keyed_mc"}'::jsonb,
                 'placement-db-test/fallback-replacement',
                 'grading-policy-v1', 'rating-mapping-v1',
                 '16400000-0000-4000-8000-000000000001')`,
        [ids.scope, ids.user, placementStudy.sessionId, ids.fallbackQuiz],
      );
      assert.equal(
        (await connected.loadPlacement(authorization, placementStudy.sessionId))
          .answered,
        1,
      );
      await knowledge.recordEvidenceAndReplay(
        authorization,
        {
          attemptId: "16400000-0000-4000-8000-000000000002",
          conceptId: ids.otherConcept,
          eligibleForMastery: true,
          fsrsRating: 3,
          graderConfidence: null,
          gradingMethod: "keyed_mc",
          gradingPolicyVersion: "grading-policy-v1",
          ineligibilityReason: null,
          judgmentKind: "scored",
          knowledgeAlgorithmVersion: "knowledge-model-v1",
          knowledgeConfigurationId: "beta-1-3-unit-mass-score-5dp-v1",
          rationaleRef: `placement-keyed/${ids.fallbackQuiz}`,
          ratingMappingVersion: "rating-mapping-v1",
          replacementForAttemptId: "16400000-0000-4000-8000-000000000001",
          rubricBand: "correct",
          rubricId: "placement-fallback-rubric",
          rubricVersion: "placement-keyed-v1",
          score: "1.00000",
          unanswerableReason: null,
        },
        deliveryPreference,
      );

      await client.query(
        `INSERT INTO quiz_item_concept
           (owner_scope_id, quiz_item_id, concept_id)
         VALUES ($1, $2, $3)`,
        [ids.scope, placementItemIds[2], ids.concept],
      );
      await assert.rejects(
        connected.submitPlacementChoice(
          authorization,
          placementStudy.sessionId,
          {
            answer: "Correct 3",
            idempotencyKey: "placement-db-test/item-3-multiconcept",
            questionId: placementItemIds[2],
          },
        ),
        (error) => error?.code === "invalid_input",
      );
      await client.query(
        `DELETE FROM quiz_item_concept
         WHERE owner_scope_id = $1 AND quiz_item_id = $2 AND concept_id = $3`,
        [ids.scope, placementItemIds[2], ids.concept],
      );
      const afterFirstChoice = await connected.loadPlacement(
        authorization,
        placementStudy.sessionId,
      );
      assert.equal(afterFirstChoice.answered, 2);
      assert.equal(afterFirstChoice.question.id, placementItemIds[2]);
      assert.equal(afterFirstChoice.question.position, 3);

      for (let index = 2; index < placementItemIds.length; index += 1) {
        const choice = await connected.submitPlacementChoice(
          authorization,
          placementStudy.sessionId,
          {
            answer: `Correct ${index + 1}`,
            idempotencyKey: `placement-db-test/item-${index + 1}`,
            questionId: placementItemIds[index],
          },
        );
        assert.equal(choice.status, "created");
        for (const evidence of choice.evidence) {
          await knowledge.recordEvidenceAndReplay(
            authorization,
            evidence,
            deliveryPreference,
          );
        }
      }
      assert.deepEqual(
        await connected.loadPlacement(authorization, placementStudy.sessionId),
        {
          answered: 10,
          failure: null,
          question: null,
          status: "complete",
          total: 10,
        },
      );

      const resumed = await connected.startOrResumeStudySession(
        authorization,
        ids.course,
      );
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.sessionId, placementStudy.sessionId);
      await client.query(
        `UPDATE study_session
         SET status = 'completed', ended_at = clock_timestamp()
         WHERE id = $1`,
        [placementStudy.sessionId],
      );
      const started = await connected.startOrResumeStudySession(
        authorization,
        ids.course,
      );
      assert.equal(started.resumed, false);
      assert.notEqual(started.sessionId, placementStudy.sessionId);
      assert.equal(started.plan.activationStatus, "ready");
      assert.equal(started.plan.assessmentStatus, "ready");
      assert.equal(started.plan.activationRequired, false);
      assert.equal(started.plan.generationRequired, false);
      assert.equal(started.plan.nextAction, "review");
      assert.deepEqual(started.plan.placement, {
        answered: 10,
        status: "complete",
        total: 10,
      });
      assert.deepEqual(
        await connected.loadPlacement(authorization, started.sessionId),
        {
          answered: 10,
          failure: null,
          question: null,
          status: "complete",
          total: 10,
        },
      );
      const activationProgress = await connected.loadActivationProgress(
        authorization,
        started.sessionId,
      );
      assert.deepEqual(
        { ...activationProgress, updatedAt: undefined },
        {
          activationStatus: "ready",
          artifact: "first_text_lesson",
          assessmentArtifact: {
            artifactKind: "placement_quiz",
            attemptCount: 1,
            failure: null,
            maxAttempts: 5,
            regenerationOrdinal: 0,
            stage: "ready",
            status: "ready",
            updatedAt: activationProgress.assessmentArtifact.updatedAt,
          },
          assessmentStatus: "ready",
          attemptCount: 0,
          contractVersion: "activation-progress-v1",
          failure: null,
          maxAttempts: 5,
          nextAction: "open_lesson",
          stage: "ready",
          updatedAt: undefined,
        },
      );
      assert.match(activationProgress.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(
        await connected.loadActivationProgress(
          { ...authorization, ownerScopeId: ids.otherScope },
          started.sessionId,
        ),
        null,
      );
      const preserved = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM study_session) AS sessions,
           (SELECT count(*)::integer FROM attempt) AS attempts`,
      );
      assert.deepEqual(preserved.rows[0], { attempts: 13, sessions: 3 });

      const replay = await resetAndReplay(connected, knowledge);
      assert.equal(replay.sessionId, first.sessionId);
      assert.deepEqual(await loadState(client), state);
      const counts = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM study_session) AS sessions,
           (SELECT count(*)::integer FROM attempt) AS attempts,
           (SELECT count(*)::integer FROM attempt_concept_evidence) AS evidence,
           (SELECT count(*)::integer FROM learning_event) AS events`,
      );
      assert.deepEqual(counts.rows[0], {
        attempts: 2,
        events: 1,
        evidence: 2,
        sessions: 1,
      });
    } finally {
      await tutor?.close().catch(() => undefined);
      await knowledge?.close().catch(() => undefined);
      await connected?.close().catch(() => undefined);
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

async function resetAndReplay(connected, knowledge) {
  const result = await connected.resetWeakState(authorization, ids.course);
  for (const evidence of result.evidence) {
    await knowledge.recordEvidenceAndReplay(
      authorization,
      evidence,
      deliveryPreference,
    );
  }
  return result;
}

async function loadState(client) {
  const result = await client.query(
    `SELECT mastery::text, confidence::text, evidence_count
     FROM knowledge_state
     WHERE owner_scope_id = $1 AND user_id = $2 AND concept_id = $3`,
    [ids.scope, ids.user, ids.concept],
  );
  return result.rows[0];
}

async function seedConnectedFixture(client) {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
     VALUES ($1, decode('1620', 'hex'), decode('1621', 'hex'))`,
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
     VALUES ($1, $2, $3, $4, 'application/pdf', 100, 'parsed')`,
    [
      ids.document,
      ids.scope,
      `owners/${ids.scope}/sources/${ids.document}.pdf`,
      "sha256:connected-demo-fixture",
    ],
  );
  await client.query(
    `INSERT INTO source_span
       (id, owner_scope_id, source_document_id, canonical_text, text_hash,
        canonical_start, canonical_end, parser_version, chunker_version,
        tokenizer_version, chunk_order)
     VALUES ($1, $2, $3, 'A VPC is an isolated virtual network.',
             'connected-demo-span', 0, 37, 'parser-v1', 'chunker-v1',
             'tokenizer-v1', 0)`,
    [ids.span, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Connected demo fixture', 'ready')`,
    [ids.course, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO source_embedding_generation
       (id, owner_scope_id, source_document_id, profile_version, dimensions,
        input_mode, adapter_version, effective_model, effective_model_version,
        provider_identifier, provider_request_ids, region, endpoint,
        span_count, status, activated_at)
     VALUES ($1, $2, $3, 'embedding-v1', 1024, 'document', 'adapter-v1',
             'text-embedding-v4', 'fixture-v1', 'fixture',
             '[]'::jsonb, 'local', 'http://127.0.0.1', 1, 'active', now())`,
    [ids.embedding, ids.scope, ids.document],
  );
  await client.query(
    `UPDATE source_document
     SET active_embedding_generation_id = $1
     WHERE owner_scope_id = $2 AND id = $3`,
    [ids.embedding, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO curriculum_generation
       (id, owner_scope_id, course_id, source_document_id,
        embedding_generation_id, generation_version, result_hash,
        model_provenance, structure, status, activated_at)
     VALUES ($1, $2, $3, $4, $5, 'curriculum-v1', $6,
             '{"fixture":true}'::jsonb, '{"chapters":[]}'::jsonb,
             'active', now())`,
    [
      ids.curriculum,
      ids.scope,
      ids.course,
      ids.document,
      ids.embedding,
      "c".repeat(64),
    ],
  );
  await client.query(
    `UPDATE course
     SET active_curriculum_generation_id = $1
     WHERE owner_scope_id = $2 AND id = $3`,
    [ids.curriculum, ids.scope, ids.course],
  );
  await client.query(
    `INSERT INTO chapter
       (id, owner_scope_id, course_id, chapter_order, title,
        generation_status, curriculum_generation_id)
     VALUES ($1, $2, $3, 1, 'Networking', 'ready', $4)`,
    [ids.chapter, ids.scope, ids.course, ids.curriculum],
  );
  await client.query(
    `INSERT INTO concept
       (id, owner_scope_id, chapter_id, name, generation_version,
        curriculum_generation_id, concept_key, concept_order)
     VALUES ($1, $2, $3, 'Virtual Private Cloud', 'curriculum-v1', $4,
             'virtual-private-cloud', 0)`,
    [ids.concept, ids.scope, ids.chapter, ids.curriculum],
  );
  await client.query(
    `INSERT INTO concept
       (id, owner_scope_id, chapter_id, name, generation_version,
        curriculum_generation_id, concept_key, concept_order)
     VALUES ($1, $2, $3, 'Routing Tables', 'curriculum-v1', $4,
             'routing-tables', 1)`,
    [ids.otherConcept, ids.scope, ids.chapter, ids.curriculum],
  );
  await client.query(
    `INSERT INTO concept_source_span
       (owner_scope_id, concept_id, source_span_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.concept, ids.span],
  );
  await client.query(
    `INSERT INTO activation_generation_operation
       (id, owner_scope_id, course_id, curriculum_generation_id,
        artifact_kind, chapter_id, concept_id, generation_version,
        idempotency_key, priority, status, attempt_count, artifact_id,
        completed_at)
     VALUES ($1, $2, $3, $4, 'first_text_lesson', $5, $6,
             'activation-generation-v1', $7, 1, 'succeeded', 1, $8, now())`,
    [
      ids.lessonOperation,
      ids.scope,
      ids.course,
      ids.curriculum,
      ids.chapter,
      ids.concept,
      `dev/content.activation.generate/v1/${ids.lessonOperation}`,
      ids.asset,
    ],
  );
  await client.query(
    `INSERT INTO asset
       (id, owner_scope_id, course_id, chapter_id, concept_id, asset_type,
        object_key, model_id, prompt_id, generation_version, strategy_tag,
        status, generation_operation_id, model_provenance, content_hash,
        content_type, byte_size, etag)
     VALUES ($1, $2, $3, $4, $5, 'text', $6, 'qwen-plus', 'lesson-text',
             'activation-generation-v1', 'example-v1', 'ready', $7,
             '{"task":"lesson.text.v1"}'::jsonb, $8,
             'text/markdown; charset=utf-8', 400, 'etag-connected-demo')`,
    [
      ids.asset,
      ids.scope,
      ids.course,
      ids.chapter,
      ids.concept,
      `owners/${ids.scope}/courses/${ids.course}/assets/${ids.asset}/payload.md`,
      ids.lessonOperation,
      "d".repeat(64),
    ],
  );
  await client.query(
    `INSERT INTO asset_source_span
       (owner_scope_id, asset_id, source_span_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.asset, ids.span],
  );
  await client.query(
    `INSERT INTO activation_generation_operation
       (id, owner_scope_id, course_id, curriculum_generation_id,
        artifact_kind, generation_version, idempotency_key, priority,
        status, attempt_count, artifact_id, completed_at)
     VALUES ($1, $2, $3, $4, 'placement_quiz',
             'activation-generation-v2', $5, 2, 'succeeded', 1, $6, now())`,
    [
      ids.placementOperation,
      ids.scope,
      ids.course,
      ids.curriculum,
      `dev/content.activation.generate/v1/${ids.placementOperation}`,
      ids.placementBank,
    ],
  );
  await client.query(
    `INSERT INTO quiz_bank
       (id, owner_scope_id, course_id, generation_operation_id, bank_kind,
        generation_version, model_provenance, result_hash, item_count)
     VALUES ($1, $2, $3, $4, 'placement', 'activation-generation-v2',
             '{"fixture":true}'::jsonb, $5, 10)`,
    [
      ids.placementBank,
      ids.scope,
      ids.course,
      ids.placementOperation,
      "e".repeat(64),
    ],
  );
  for (const [index, itemId] of placementItemIds.entries()) {
    await client.query(
      `INSERT INTO quiz_item
         (id, owner_scope_id, course_id, item_type, difficulty, prompt,
          keyed_answer, version, quiz_bank_id, item_order,
          normalized_prompt_hash, response_options)
       VALUES ($1, $2, $3, 'multiple_choice', $4, $5, to_jsonb($6::text),
               'activation-generation-v2', $7, $8, $9,
               jsonb_build_array($6::text, $10::text))`,
      [
        itemId,
        ids.scope,
        ids.course,
        (index % 5) + 1,
        `Placement question ${index + 1}`,
        `Correct ${index + 1}`,
        ids.placementBank,
        index,
        (index + 1).toString(16).repeat(64),
        `Distractor ${index + 1}`,
      ],
    );
    await client.query(
      `INSERT INTO quiz_item_concept
         (owner_scope_id, quiz_item_id, concept_id)
       VALUES ($1, $2, $3)`,
      [ids.scope, itemId, ids.otherConcept],
    );
    await client.query(
      `INSERT INTO quiz_item_source_span
         (owner_scope_id, quiz_item_id, source_span_id)
       VALUES ($1, $2, $3)`,
      [ids.scope, itemId, ids.span],
    );
  }
  await client.query(
    `UPDATE quiz_item
     SET item_type = 'short_answer', keyed_answer = 'null'::jsonb,
         response_options = NULL,
         rubric = jsonb_build_array(jsonb_build_object(
           'conceptId', $2::text,
           'rubricId', 'placement-short-answer-rubric',
           'rubricVersion', '1',
           'requiredCriteria', jsonb_build_array('Explains the source concept'),
           'materialContradictions', '[]'::jsonb,
           'sourceSpanIds', jsonb_build_array($3::text)
         ))
     WHERE owner_scope_id = $1 AND id = $4`,
    [ids.scope, ids.otherConcept, ids.span, placementItemIds[1]],
  );
  await client.query(
    `INSERT INTO quiz_item
       (id, owner_scope_id, course_id, item_type, difficulty, prompt,
        keyed_answer, version, item_order, normalized_prompt_hash,
        response_options)
     VALUES ($1, $2, $3, 'multiple_choice', 2,
             'Placement fallback question', to_jsonb('Fallback correct'::text),
             'fixture-v1', 100, $4,
             '["Fallback correct","Fallback distractor"]'::jsonb)`,
    [ids.fallbackQuiz, ids.scope, ids.course, "f".repeat(64)],
  );
  await client.query(
    `INSERT INTO quiz_item_concept
       (owner_scope_id, quiz_item_id, concept_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.fallbackQuiz, ids.otherConcept],
  );

  const questions = [
    { id: ids.quizA, itemType: "multiple_choice" },
    { id: ids.quizB, itemType: "multiple_choice" },
    { id: ids.quizC, itemType: "short_answer" },
    { id: ids.quizD, itemType: "multiple_choice" },
    { id: ids.quizE, itemType: "short_answer" },
    { id: ids.quizF, itemType: "multiple_choice" },
  ];
  for (const [index, question] of questions.entries()) {
    await client.query(
      `INSERT INTO quiz_item
         (id, owner_scope_id, course_id, item_type, difficulty, prompt,
          keyed_answer, version, item_order, normalized_prompt_hash,
          response_options, rubric)
       VALUES (
         $1, $2, $3, $4, $5, $6,
         CASE WHEN $4 = 'multiple_choice'
           THEN to_jsonb('An isolated network'::text)
           ELSE 'null'::jsonb
         END,
         'fixture-v1', $7, $8,
         CASE WHEN $4 = 'multiple_choice'
           THEN '["An isolated network","A public bucket"]'::jsonb
           ELSE NULL
         END,
         CASE WHEN $4 = 'short_answer'
           THEN jsonb_build_array(jsonb_build_object(
             'conceptId', $9::text,
             'rubricId', 'connected-demo-rubric',
             'rubricVersion', '1',
             'requiredCriteria', jsonb_build_array('Explains isolation'),
             'materialContradictions', '[]'::jsonb,
             'sourceSpanIds', jsonb_build_array($10::text)
           ))
           ELSE NULL
         END
       )`,
      [
        question.id,
        ids.scope,
        ids.course,
        question.itemType,
        (index % 5) + 1,
        `Connected demo question ${index + 1}`,
        index,
        String(index + 1).repeat(64),
        ids.concept,
        ids.span,
      ],
    );
    await client.query(
      `INSERT INTO quiz_item_concept
         (owner_scope_id, quiz_item_id, concept_id)
       VALUES ($1, $2, $3)`,
      [ids.scope, question.id, ids.concept],
    );
    await client.query(
      `INSERT INTO quiz_item_source_span
         (owner_scope_id, quiz_item_id, source_span_id)
       VALUES ($1, $2, $3)`,
      [ids.scope, question.id, ids.span],
    );
  }
}
