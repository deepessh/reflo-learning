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
  lessonOperation: "16200000-0000-4000-8000-000000000008",
  member: "16200000-0000-4000-8000-000000000009",
  otherScope: "16200000-0000-4000-8000-000000000010",
  quizA: "16200000-0000-4000-8000-000000000011",
  quizB: "16200000-0000-4000-8000-000000000012",
  quizC: "16200000-0000-4000-8000-000000000013",
  scope: "16200000-0000-4000-8000-000000000014",
  span: "16200000-0000-4000-8000-000000000015",
  user: "16200000-0000-4000-8000-000000000016",
};

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
      tutor = new PostgresTutorAgentRepository(databaseUrl.toString());

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

  for (const [index, quizId] of [ids.quizA, ids.quizB, ids.quizC].entries()) {
    await client.query(
      `INSERT INTO quiz_item
         (id, owner_scope_id, course_id, item_type, difficulty, prompt,
          keyed_answer, version, item_order, normalized_prompt_hash,
          response_options)
       VALUES ($1, $2, $3, 'multiple_choice', $4, $5,
               to_jsonb('An isolated network'::text), 'fixture-v1', $6, $7,
               '["An isolated network","A public bucket"]'::jsonb)`,
      [
        quizId,
        ids.scope,
        ids.course,
        index + 1,
        `Connected demo question ${index + 1}`,
        index,
        String(index + 1).repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO quiz_item_concept
         (owner_scope_id, quiz_item_id, concept_id)
       VALUES ($1, $2, $3)`,
      [ids.scope, quizId, ids.concept],
    );
    await client.query(
      `INSERT INTO quiz_item_source_span
         (owner_scope_id, quiz_item_id, source_span_id)
       VALUES ($1, $2, $3)`,
      [ids.scope, quizId, ids.span],
    );
  }
}
