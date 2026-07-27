import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";
import test from "node:test";
import assert from "node:assert/strict";

import { PostgresAssessmentRepository } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  attempt: "10000000-0000-4000-8000-000000000001",
  bundle: "10000000-0000-4000-8000-000000000002",
  chapter: "00000000-0000-4000-8000-000000000501",
  conceptA: "00000000-0000-4000-8000-000000000601",
  conceptB: "00000000-0000-4000-8000-000000000602",
  course: "00000000-0000-4000-8000-000000000401",
  document: "00000000-0000-4000-8000-000000000301",
  fallbackA: "00000000-0000-4000-8000-000000000702",
  fallbackB: "00000000-0000-4000-8000-000000000703",
  itemA: "10000000-0000-4000-8000-000000000003",
  itemB: "10000000-0000-4000-8000-000000000004",
  member: "00000000-0000-4000-8000-000000000201",
  replacementAttempt: "10000000-0000-4000-8000-000000000005",
  scope: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000801",
  shortAnswer: "00000000-0000-4000-8000-000000000701",
  spanA: "00000000-0000-4000-8000-000000000901",
  spanB: "00000000-0000-4000-8000-000000000902",
  user: "00000000-0000-4000-8000-000000000001",
};

const authorization = {
  actorId: ids.user,
  authorizationId: "assessment-db-test-authorization",
  ownerScopeId: ids.scope,
};

test(
  "PostgresAssessmentRepository atomically replays abstention and keyed fallback lineage",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_assessment_${process.pid}_${Date.now()}`;
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
      await seedAssessmentFixture(client);
      repository = new PostgresAssessmentRepository(databaseUrl.toString());

      const claimRequest = {
        idempotencyKey: "assessment-db/original/v1",
        leaseMs: 5_000,
        policy: policy(),
        questionId: ids.shortAnswer,
        requestDigest: "d".repeat(64),
        sessionId: ids.session,
      };
      const [claim, duplicateClaim] = await Promise.all([
        repository.claimShortAnswer(authorization, claimRequest),
        repository.claimShortAnswer(authorization, claimRequest),
      ]);
      const claimed =
        claim.kind === "claimed"
          ? claim
          : duplicateClaim.kind === "claimed"
            ? duplicateClaim
            : null;
      assert.notEqual(claimed, null);
      assert.deepEqual([claim.kind, duplicateClaim.kind].sort(), [
        "claimed",
        "pending",
      ]);
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('reflo.actor_id', $1, true),
                set_config('reflo.owner_scope_id', $2, true)`,
        [ids.user, ids.scope],
      );
      const presentedRows = await client.query(
        `SELECT count(*)::integer AS count
         FROM assessment_session_question
         WHERE owner_scope_id = $1
           AND session_id = $2
           AND presentation_kind = 'original'`,
        [ids.scope, ids.session],
      );
      assert.equal(presentedRows.rows[0].count, 1);
      await assert.rejects(
        client.query(
          `DELETE FROM assessment_session_question
           WHERE owner_scope_id = $1
             AND session_id = $2
             AND presentation_kind = 'original'`,
          [ids.scope, ids.session],
        ),
      );
      await client.query("ROLLBACK");
      const original = shortAnswerFinalization(claimed);
      const first = await repository.finalizeShortAnswer(
        authorization,
        original,
      );
      const replay = await repository.finalizeShortAnswer(
        authorization,
        original,
      );

      assert.equal(first.status, "created");
      assert.equal(first.outcome, "abstained");
      assert.equal(first.replacementForAttemptId, null);
      assert.equal(first.fallback.items.length, 2);
      assert.equal("keyedAnswer" in first.fallback.items[0].question, false);
      assert.equal(replay.status, "replayed");
      assert.equal(replay.attemptId, first.attemptId);
      assert.equal(replay.replacementForAttemptId, null);
      await assert.rejects(
        repository.claimShortAnswer(authorization, {
          ...claimRequest,
          idempotencyKey: "assessment-db/repeated-question/v1",
          requestDigest: "9".repeat(64),
        }),
        (error) => error?.code === "question_unavailable",
      );
      assert.equal(
        first.evidence.every((entry) => !entry.eligibleForMastery),
        true,
      );
      const policyBindings = await client.query(
        `SELECT grading_policy_version, confidence_threshold::text
         FROM grading_policy_binding`,
      );
      assert.deepEqual(policyBindings.rows, [
        {
          confidence_threshold: "0.95000",
          grading_policy_version: "grading-policy-v1",
        },
      ]);
      await assert.rejects(
        repository.claimShortAnswer(authorization, {
          idempotencyKey: "assessment-db/policy-conflict/v1",
          leaseMs: 5_000,
          policy: {
            ...original.policy,
            confidenceThreshold: "0.90000",
          },
          questionId: ids.shortAnswer,
          requestDigest: "f".repeat(64),
          sessionId: ids.session,
        }),
        (error) => error?.code === "invalid_configuration",
      );
      const originalRows = await client.query(
        `SELECT attempt.overall_grade, attempt.grading_confidence,
                count(evidence.concept_id)::integer AS evidence_count,
                count(evidence.concept_id)
                  FILTER (WHERE evidence.eligible_for_mastery)::integer
                  AS eligible_count
         FROM attempt
         LEFT JOIN attempt_concept_evidence AS evidence
           ON evidence.owner_scope_id = attempt.owner_scope_id
          AND evidence.attempt_id = attempt.id
         WHERE attempt.owner_scope_id = $1 AND attempt.id = $2
         GROUP BY attempt.id`,
        [ids.scope, ids.attempt],
      );
      assert.deepEqual(originalRows.rows, [
        {
          eligible_count: 0,
          evidence_count: 2,
          grading_confidence: null,
          overall_grade: null,
        },
      ]);
      await assert.rejects(
        client.query(
          `UPDATE attempt
           SET answer = '{"text":"rewritten"}'::jsonb
           WHERE owner_scope_id = $1 AND id = $2`,
          [ids.scope, ids.attempt],
        ),
      );

      await client.query(
        `UPDATE quiz_item
         SET prompt = 'Mutated live fallback',
             keyed_answer = to_jsonb('Wrong live key'::text),
             response_options = '["Wrong live key","Other"]'::jsonb
         WHERE owner_scope_id = $1 AND id = $2`,
        [ids.scope, ids.fallbackA],
      );
      const immutableBundle = await repository.loadReplacementBundle(
        authorization,
        ids.bundle,
      );
      assert.equal(immutableBundle.items[0].question.prompt, "Fallback A");
      const immutableResolution = await repository.resolveReplacementAnswer(
        authorization,
        {
          answer: "VPC isolation",
          bundleId: ids.bundle,
          itemId: ids.itemA,
        },
      );
      assert.equal(immutableResolution.correct, true);

      const replacement = replacementFinalization();
      const replacementFirst = await repository.finalizeReplacement(
        authorization,
        replacement,
      );
      const replacementReplay = await repository.finalizeReplacement(
        authorization,
        replacement,
      );
      assert.equal(replacementFirst.status, "created");
      assert.equal(replacementReplay.status, "replayed");
      assert.equal(replacementFirst.replacementForAttemptId, ids.attempt);
      assert.equal(replacementReplay.replacementForAttemptId, ids.attempt);
      assert.equal(replacementFirst.evidence.length, 1);
      assert.deepEqual(
        {
          conceptId: replacementFirst.evidence[0].conceptId,
          eligibleForMastery: replacementFirst.evidence[0].eligibleForMastery,
          fsrsRating: replacementFirst.evidence[0].fsrsRating,
          graderConfidence: replacementFirst.evidence[0].graderConfidence,
          gradingMethod: replacementFirst.evidence[0].gradingMethod,
          score: replacementFirst.evidence[0].score,
        },
        {
          conceptId: ids.conceptA,
          eligibleForMastery: true,
          fsrsRating: 3,
          graderConfidence: null,
          gradingMethod: "keyed_mc",
          score: "1.00000",
        },
      );
      const lineage = await client.query(
        `SELECT attempt.replacement_for_attempt_id
                  AS attempt_replacement_for_attempt_id,
                evidence.replacement_for_attempt_id
                  AS evidence_replacement_for_attempt_id,
                evidence.grader_confidence,
                evidence.fsrs_rating
         FROM attempt
         JOIN attempt_concept_evidence AS evidence
           ON evidence.owner_scope_id = attempt.owner_scope_id
          AND evidence.attempt_id = attempt.id
         WHERE attempt.owner_scope_id = $1 AND attempt.id = $2`,
        [ids.scope, ids.replacementAttempt],
      );
      assert.deepEqual(lineage.rows, [
        {
          attempt_replacement_for_attempt_id: ids.attempt,
          evidence_replacement_for_attempt_id: ids.attempt,
          fsrs_rating: 3,
          grader_confidence: null,
        },
      ]);

      await client.query("SELECT reflo_reset_learning_scope($1)", [ids.scope]);
      const reset = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM assessment_finalization
            WHERE owner_scope_id = $1) AS finalization_count,
           (SELECT count(*)::integer FROM assessment_replacement_bundle
            WHERE owner_scope_id = $1) AS bundle_count,
           (SELECT count(*)::integer FROM assessment_replacement_item
            WHERE owner_scope_id = $1) AS item_count,
           (SELECT count(*)::integer FROM assessment_session_question
            WHERE owner_scope_id = $1) AS session_question_count,
           (SELECT count(*)::integer FROM assessment_grading_operation
            WHERE owner_scope_id = $1) AS operation_count,
           (SELECT count(*)::integer FROM attempt
            WHERE owner_scope_id = $1) AS attempt_count`,
        [ids.scope],
      );
      assert.deepEqual(reset.rows, [
        {
          attempt_count: 0,
          bundle_count: 0,
          finalization_count: 0,
          item_count: 0,
          operation_count: 0,
          session_question_count: 0,
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

function shortAnswerFinalization(claim) {
  return {
    answer: "Synthetic low-confidence answer",
    attemptId: ids.attempt,
    claimToken: claim.claimToken,
    evidence: [
      llmEvidence(ids.conceptA, "correct", "attempt_abstained", "0.97000"),
      llmEvidence(ids.conceptB, "incorrect", "below_threshold", "0.20000"),
    ],
    fallback: {
      id: ids.bundle,
      items: [
        replacementItem(
          ids.itemA,
          claim.snapshot.fallbackCandidates.find(
            (candidate) => candidate.conceptIds[0] === ids.conceptA,
          ),
        ),
        replacementItem(
          ids.itemB,
          claim.snapshot.fallbackCandidates.find(
            (candidate) => candidate.conceptIds[0] === ids.conceptB,
          ),
        ),
      ],
      originalAttemptId: ids.attempt,
      policyVersion: "grading-policy-v1",
      version: "mc-replacement-bundle-v1",
    },
    idempotencyKey: "assessment-db/original/v1",
    learnerMessage:
      "We could not grade that response reliably. Try the source-backed multiple-choice replacements.",
    modelProvenance: policy().expectedModelProvenance,
    outcome: "abstained",
    ownerScopeId: ids.scope,
    policy: policy(),
    questionId: ids.shortAnswer,
    requestDigest: "d".repeat(64),
    sessionId: ids.session,
    userId: ids.user,
  };
}

function replacementFinalization() {
  return {
    answer: "VPC isolation",
    attemptId: ids.replacementAttempt,
    bundleId: ids.bundle,
    evidence: {
      conceptId: ids.conceptA,
      eligibleForMastery: true,
      fsrsRating: 3,
      graderConfidence: null,
      gradingMethod: "keyed_mc",
      ineligibilityReason: null,
      judgmentKind: "scored",
      rationaleRef: `keyed-mc/${ids.fallbackA}`,
      rubricBand: "correct",
      rubricId: "rubric-a",
      rubricVersion: "1",
      score: "1.00000",
    },
    idempotencyKey: "assessment-db/replacement-a/v1",
    itemId: ids.itemA,
    ownerScopeId: ids.scope,
    policy: policy(),
    requestDigest: "e".repeat(64),
    sessionId: ids.session,
    userId: ids.user,
  };
}

function llmEvidence(conceptId, band, reason, confidence) {
  return {
    conceptId,
    eligibleForMastery: false,
    fsrsRating: null,
    graderConfidence: confidence,
    gradingMethod: "llm_short_answer",
    ineligibilityReason: reason,
    judgmentKind: "scored",
    rationaleRef: `model-call/${conceptId}`,
    rubricBand: band,
    rubricId: conceptId === ids.conceptA ? "rubric-a" : "rubric-b",
    rubricVersion: "1",
    score: band === "correct" ? "1.00000" : "0.00000",
  };
}

function policy() {
  return {
    calibrationEvidenceId: "rights-cleared-calibration-fixture-v1",
    confidenceThreshold: "0.95000",
    expectedModelProvenance: {
      effectiveModel: "qwen-plus",
      effectiveModelVersion: "fixture-v1",
      generationParametersVersion: "grading-generation-parameters-v2",
      inputSchemaVersion: "short-answer-grading-input-v2",
      promptDefinitionDigest: "c".repeat(64),
      promptId: "assessment-grade-short-answer",
      promptVersion: "2",
      resultSchemaVersion: "short-answer-judgment-result-v2",
      routePolicyVersion: "route-policy-v6",
    },
    gradingPolicyVersion: "grading-policy-v1",
    ratingMappingVersion: "rating-mapping-v1",
  };
}

function replacementItem(id, question) {
  return {
    conceptId: question.conceptIds[0],
    id,
    question,
  };
}

async function seedAssessmentFixture(client) {
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
     VALUES ($1, $2, 'owners/assessment/source', 'sha256:assessment',
             'application/pdf', 10, 'parsed')`,
    [ids.document, ids.scope],
  );
  await client.query(
    `INSERT INTO source_span
       (id, owner_scope_id, source_document_id, canonical_text, text_hash,
        canonical_start, canonical_end, parser_version, chunker_version,
        tokenizer_version)
     VALUES
       ($3, $2, $1, 'A VPC is isolated.', 'hash-a', 0, 18, 'p1', 'c1', 't1'),
       ($4, $2, $1, 'A subnet partitions.', 'hash-b', 19, 39, 'p1', 'c1', 't1')`,
    [ids.document, ids.scope, ids.spanA, ids.spanB],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Assessment fixture', 'ready')`,
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
        keyed_answer, rubric, version, normalized_prompt_hash,
        response_options)
     VALUES
       ($1, $2, $3, 'short_answer', 3, 'Explain both concepts',
        'null'::jsonb, $9::jsonb, 'fixture-v1', $4, NULL),
       ($5, $2, $3, 'multiple_choice', 2, 'Fallback A',
        to_jsonb('VPC isolation'::text), NULL, 'fixture-v1', $6,
        '["VPC isolation","Not isolated"]'::jsonb),
       ($7, $2, $3, 'multiple_choice', 2, 'Fallback B',
        to_jsonb('Partitions an address space'::text), NULL, 'fixture-v1', $8,
        '["Partitions an address space","Creates an account"]'::jsonb)`,
    [
      ids.shortAnswer,
      ids.scope,
      ids.course,
      "c".repeat(64),
      ids.fallbackA,
      "a".repeat(64),
      ids.fallbackB,
      "b".repeat(64),
      JSON.stringify([
        {
          conceptId: ids.conceptA,
          materialContradictions: ["A VPC is public by default."],
          requiredCriteria: ["States that a VPC provides isolation."],
          rubricId: "rubric-a",
          rubricVersion: "1",
          sourceSpanIds: [ids.spanA],
        },
        {
          conceptId: ids.conceptB,
          materialContradictions: ["Subnets are separate accounts."],
          requiredCriteria: ["States that subnets partition an address space."],
          rubricId: "rubric-b",
          rubricVersion: "1",
          sourceSpanIds: [ids.spanB],
        },
      ]),
    ],
  );
  await client.query(
    `INSERT INTO quiz_item_concept
       (owner_scope_id, quiz_item_id, concept_id)
     VALUES ($1, $2, $3), ($1, $2, $4), ($1, $5, $3), ($1, $6, $4)`,
    [
      ids.scope,
      ids.shortAnswer,
      ids.conceptA,
      ids.conceptB,
      ids.fallbackA,
      ids.fallbackB,
    ],
  );
  await client.query(
    `INSERT INTO quiz_item_source_span
       (owner_scope_id, quiz_item_id, source_span_id)
     VALUES ($1, $2, $3), ($1, $2, $4), ($1, $5, $3), ($1, $6, $4)`,
    [
      ids.scope,
      ids.shortAnswer,
      ids.spanA,
      ids.spanB,
      ids.fallbackA,
      ids.fallbackB,
    ],
  );
  await client.query(
    `INSERT INTO study_session
       (id, owner_scope_id, user_id, course_id, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [ids.session, ids.scope, ids.user, ids.course],
  );
}
