import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
} from "@reflo/knowledge-model";
import pg from "pg";
import test from "node:test";
import assert from "node:assert/strict";

import {
  PostgresDemoDeliveryRepository,
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
  channel: "10000000-0000-4000-8000-000000000001",
  chapter: "20000000-0000-4000-8000-000000000001",
  concept: "30000000-0000-4000-8000-000000000001",
  course: "40000000-0000-4000-8000-000000000001",
  document: "50000000-0000-4000-8000-000000000001",
  member: "60000000-0000-4000-8000-000000000001",
  priorAttempt: "70000000-0000-4000-8000-000000000001",
  quiz: "80000000-0000-4000-8000-000000000001",
  scope: "90000000-0000-4000-8000-000000000001",
  session: "a0000000-0000-4000-8000-000000000001",
  user: "b0000000-0000-4000-8000-000000000001",
};
const authorization = {
  actorId: ids.user,
  authorizationId: "staff-demo-config-v1",
  ownerScopeId: ids.scope,
};
const recipient = "staff-demo@example.test";
const destination = {
  authorization,
  channelIdentityId: ids.channel,
  provider: "email",
  recipient,
  recipientLookupDigest: createHash("sha256").update(recipient).digest("hex"),
};
const deliveryPreference = {
  chosenLocalTime: "09:00",
  timeZone: "UTC",
};

test(
  "PostgresDemoDeliveryRepository batches due reviews and finalizes one replay-safe ambient attempt",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_delivery_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let client;
    let deliveryRepository;
    let knowledgeRepository;
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
      knowledgeRepository = new PostgresKnowledgeRepository(
        databaseUrl.toString(),
      );
      await knowledgeRepository.recordEvidenceAndReplay(
        authorization,
        evidence(ids.priorAttempt),
        deliveryPreference,
      );
      deliveryRepository = new PostgresDemoDeliveryRepository(
        databaseUrl.toString(),
      );
      assert.equal(
        await deliveryRepository.loadPreference(authorization),
        null,
      );
      assert.deepEqual(
        await deliveryRepository.savePreference(authorization, {
          chosenLocalTime: "18:45",
          provider: "email",
          timeZone: "America/Los_Angeles",
        }),
        {
          chosenLocalTime: "18:45",
          provider: "email",
          timeZone: "America/Los_Angeles",
        },
      );
      assert.deepEqual(await deliveryRepository.loadPreference(authorization), {
        chosenLocalTime: "18:45",
        provider: "email",
        timeZone: "America/Los_Angeles",
      });

      const reserveRequest = {
        expiresAt: "2026-08-02T09:00:00.000Z",
        idempotencyKey: "demo-delivery-v1/email/2026-08-01",
        now: "2026-08-01T09:00:00.000Z",
      };
      const reserved = await deliveryRepository.reserveDueBatch(
        authorization,
        destination,
        reserveRequest,
      );
      assert.equal(reserved.items.length, 1);
      assert.equal(reserved.items[0].keyedAnswer, "B");
      assert.deepEqual(
        await deliveryRepository.reserveDueBatch(
          authorization,
          destination,
          reserveRequest,
        ),
        reserved,
      );

      const tokenDigest = "c".repeat(64);
      await deliveryRepository.bindEmailToken(
        authorization,
        reserved.deliveryId,
        tokenDigest,
        reserved.expiresAt,
      );
      const claimToken = "d0000000-0000-4000-8000-000000000001";
      assert.equal(
        await deliveryRepository.claimDispatch(
          authorization,
          reserved.deliveryId,
          {
            leaseExpiresAt: "2026-08-01T09:10:00.000Z",
            token: claimToken,
          },
        ),
        true,
      );
      await deliveryRepository.markSubmitted(
        authorization,
        reserved.deliveryId,
        claimToken,
        "directmail-message-1",
      );
      const preview = await deliveryRepository.loadEmailPreview(
        authorization,
        reserved.deliveryId,
        tokenDigest,
        "2026-08-01T09:01:00.000Z",
      );
      assert.equal("demoOnly" in preview, false);
      assert.equal(preview.questions[0].prompt, "Choose B");
      assert.equal("keyedAnswer" in preview.questions[0], false);

      const request = {
        answers: [
          {
            answer: "B",
            deliveryItemId: reserved.items[0].deliveryItemId,
          },
        ],
        deliveryId: reserved.deliveryId,
        providerSubmissionId: "email-token-1",
        submittedAt: "2026-08-01T09:02:00.000Z",
        tokenDigest,
      };
      const finalized = await deliveryRepository.finalizeAnswers(
        authorization,
        destination,
        request,
      );
      assert.equal(finalized[0].correct, true);
      assert.equal(finalized[0].status, "created");
      assert.deepEqual(finalized[0].streak, { current: 1, longest: 1 });
      const replayed = await deliveryRepository.finalizeAnswers(
        authorization,
        destination,
        request,
      );
      assert.equal(replayed[0].attemptId, finalized[0].attemptId);
      assert.equal(replayed[0].status, "replayed");

      const state = await knowledgeRepository.recordEvidenceAndReplay(
        authorization,
        finalized[0].evidence,
        finalized[0].deliveryPreference,
      );
      const replayState = await knowledgeRepository.recordEvidenceAndReplay(
        authorization,
        replayed[0].evidence,
        replayed[0].deliveryPreference,
      );
      assert.equal(state.evidenceCount, 2);
      assert.deepEqual(replayState, state);
      assert.equal(
        (
          await client.query(
            `SELECT count(*)::integer AS count
             FROM attempt
             WHERE owner_scope_id = $1 AND delivery_item_id IS NOT NULL`,
            [ids.scope],
          )
        ).rows[0].count,
        1,
      );
      await client.query("SELECT reflo_reset_learning_scope($1)", [ids.scope]);
      assert.deepEqual(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::integer FROM quiz_delivery
                WHERE owner_scope_id = $1) AS delivery_count,
               (SELECT count(*)::integer FROM delivery_submission
                WHERE owner_scope_id = $1) AS submission_count,
               (SELECT count(*)::integer FROM delivery_streak_day
                WHERE owner_scope_id = $1) AS streak_day_count,
               (SELECT count(*)::integer FROM delivery_streak
                WHERE owner_scope_id = $1) AS streak_count,
               (SELECT count(*)::integer FROM attempt
                WHERE owner_scope_id = $1) AS attempt_count`,
            [ids.scope],
          )
        ).rows[0],
        {
          attempt_count: 0,
          delivery_count: 0,
          streak_count: 0,
          streak_day_count: 0,
          submission_count: 0,
        },
      );
    } finally {
      await deliveryRepository?.close().catch(() => undefined);
      await knowledgeRepository?.close().catch(() => undefined);
      await client?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
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
     VALUES ($1, $2, 'owners/delivery/source', 'sha256:delivery',
             'application/pdf', 10, 'parsed')`,
    [ids.document, ids.scope],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Delivery fixture', 'ready')`,
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
     VALUES ($1, $2, $3, 'Concept one', 'fixture-v1')`,
    [ids.concept, ids.scope, ids.chapter],
  );
  await client.query(
    `INSERT INTO quiz_item
       (id, owner_scope_id, course_id, item_type, difficulty, prompt,
        keyed_answer, version, normalized_prompt_hash, response_options)
     VALUES (
       $1, $2, $3, 'multiple_choice', 1, 'Choose B',
       to_jsonb('B'::text), 'fixture-v1', $4,
       '["A","B","C"]'::jsonb
     )`,
    [ids.quiz, ids.scope, ids.course, "d".repeat(64)],
  );
  await client.query(
    `INSERT INTO quiz_item_concept
       (owner_scope_id, quiz_item_id, concept_id)
     VALUES ($1, $2, $3)`,
    [ids.scope, ids.quiz, ids.concept],
  );
  await client.query(
    `INSERT INTO study_session
       (id, owner_scope_id, user_id, course_id, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [ids.session, ids.scope, ids.user, ids.course],
  );
  await client.query(
    `INSERT INTO attempt
       (id, owner_scope_id, user_id, session_id, quiz_item_id, answer,
        outcome, created_at)
     VALUES (
       $1, $2, $3, $4, $5, '{"selectedAnswer":"A"}', 'graded',
       '2026-07-23T17:00:00.000Z'
     )`,
    [ids.priorAttempt, ids.scope, ids.user, ids.session, ids.quiz],
  );
  await client.query(
    `INSERT INTO channel_identity
       (id, owner_scope_id, user_id, provider, encrypted_external_id,
        external_id_lookup_digest, verified_at, identity_class)
     VALUES ($1, $2, $3, 'email', decode('22', 'hex'), decode($4, 'hex'),
             '2026-07-23T00:00:00Z', 'demo_staff')`,
    [ids.channel, ids.scope, ids.user, destination.recipientLookupDigest],
  );
}

function evidence(attemptId) {
  return {
    attemptId,
    conceptId: ids.concept,
    eligibleForMastery: true,
    fsrsRating: 1,
    graderConfidence: null,
    gradingMethod: "keyed_mc",
    gradingPolicyVersion: "grading-policy-v1",
    ineligibilityReason: null,
    judgmentKind: "scored",
    knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
    knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
    rationaleRef: `keyed-mc/${ids.quiz}`,
    ratingMappingVersion: "rating-mapping-v1",
    replacementForAttemptId: null,
    rubricBand: "incorrect",
    rubricId: `keyed-mc/${ids.quiz}`,
    rubricVersion: "fixture-v1",
    score: "0.00000",
    unanswerableReason: null,
  };
}
