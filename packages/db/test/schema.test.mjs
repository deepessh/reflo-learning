import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  userA: "00000000-0000-4000-8000-000000000001",
  userB: "00000000-0000-4000-8000-000000000002",
  userC: "00000000-0000-4000-8000-000000000003",
  scopeA: "00000000-0000-4000-8000-000000000101",
  scopeB: "00000000-0000-4000-8000-000000000102",
  memberA: "00000000-0000-4000-8000-000000000201",
  memberB: "00000000-0000-4000-8000-000000000202",
  documentA: "00000000-0000-4000-8000-000000000301",
  documentB: "00000000-0000-4000-8000-000000000302",
  courseA: "00000000-0000-4000-8000-000000000401",
  courseB: "00000000-0000-4000-8000-000000000402",
};

test(
  "core migrations roll forward and enforce scope and idempotency invariants",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async (suite) => {
    const suffix = `${process.pid}_${Date.now()}`;
    const databaseName = `reflo_schema_${suffix}`;
    const runtimeRole = `reflo_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    const scratch = await mkdtemp(path.join(tmpdir(), "reflo-schema-"));
    const dumpedSchema = path.join(scratch, "schema.sql");
    let client;

    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      await admin.query(
        `CREATE ROLE ${runtimeRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
      );

      const databaseUrl = new URL(baseDatabaseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      const migrationEnvironment = {
        ...process.env,
        DATABASE_URL: databaseUrl.toString(),
      };
      const strictMigrationScript = path.join(
        packageRoot,
        "scripts/strict-migrate.mjs",
      );
      await execFileAsync(process.execPath, [strictMigrationScript], {
        env: migrationEnvironment,
      });
      await execFileAsync(process.execPath, [strictMigrationScript], {
        env: migrationEnvironment,
      });

      if (process.env.REFLO_SKIP_SCHEMA_DUMP !== "true") {
        const dumpScript = process.env.REFLO_POSTGRES_CONTAINER_ID
          ? path.join(packageRoot, "scripts/dump-schema-from-container.sh")
          : path.join(packageRoot, "scripts/dump-schema.mjs");
        await execFileAsync(
          process.env.REFLO_POSTGRES_CONTAINER_ID
            ? dumpScript
            : process.execPath,
          process.env.REFLO_POSTGRES_CONTAINER_ID ? [] : [dumpScript],
          {
            env: { ...migrationEnvironment, REFLO_SCHEMA_FILE: dumpedSchema },
          },
        );
        const expectedSchema = await readFile(
          path.join(packageRoot, "schema.sql"),
          "utf8",
        );
        const actualSchema = await readFile(dumpedSchema, "utf8");
        assertSchemasEqual(actualSchema, expectedSchema);
      }

      client = new pg.Client({ connectionString: databaseUrl.toString() });
      await client.connect();
      await seedCoreFixture(client);

      await suite.test("keeps organization scopes disabled", async () => {
        await expectSqlState(
          client,
          "23514",
          `INSERT INTO owner_scope (id, scope_type) VALUES ('00000000-0000-4000-8000-000000000199', 'organization')`,
        );
      });

      await suite.test("requires exactly one active owner", async () => {
        await client.query(
          `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
           VALUES ($1, decode('03', 'hex'), decode('13', 'hex'))`,
          [ids.userC],
        );
        await expectSqlState(
          client,
          "23505",
          `INSERT INTO scope_membership (id, owner_scope_id, user_id)
           VALUES ('00000000-0000-4000-8000-000000000299', $1, $2)`,
          [ids.scopeA, ids.userC],
        );

        await client.query("BEGIN");
        await client.query(
          "UPDATE scope_membership SET revoked_at = now() WHERE id = $1",
          [ids.memberA],
        );
        await assert.rejects(
          client.query("COMMIT"),
          (error) => error.code === "23514",
        );
        await client.query("ROLLBACK");
      });

      await suite.test(
        "bootstraps exactly one personal scope for a verified account",
        async () => {
          const existing = await client.query(
            `SELECT reflo_bootstrap_personal_scope(
               '00000000-0000-4000-8000-000000000109',
               '00000000-0000-4000-8000-000000000209',
               $1
             ) AS owner_scope_id`,
            [ids.userA],
          );
          assert.equal(existing.rows[0].owner_scope_id, ids.scopeA);

          await client.query("BEGIN");
          await client.query(
            `INSERT INTO owner_scope (id)
             VALUES ('00000000-0000-4000-8000-000000000109')`,
          );
          await assert.rejects(
            client.query(
              `INSERT INTO scope_membership
                 (id, owner_scope_id, user_id)
               VALUES (
                 '00000000-0000-4000-8000-000000000209',
                 '00000000-0000-4000-8000-000000000109',
                 $1
               )`,
              [ids.userA],
            ),
            (error) => error.code === "23505",
          );
          await client.query("ROLLBACK");
        },
      );

      await suite.test(
        "binds every opaque session to the matching personal membership",
        async () => {
          await client.query(
            `INSERT INTO auth_session
               (id, user_id, owner_scope_id, session_digest,
                idle_expires_at, absolute_expires_at)
             VALUES (
               '00000000-0000-4000-8000-000000000801',
               $1, $2, decode('81', 'hex'),
               now() + interval '7 days', now() + interval '30 days'
             )`,
            [ids.userA, ids.scopeA],
          );
          await expectSqlState(
            client,
            "23503",
            `INSERT INTO auth_session
               (id, user_id, owner_scope_id, session_digest,
                idle_expires_at, absolute_expires_at)
             VALUES (
               '00000000-0000-4000-8000-000000000802',
               $1, $2, decode('82', 'hex'),
               now() + interval '7 days', now() + interval '30 days'
             )`,
            [ids.userA, ids.scopeB],
          );
        },
      );

      await suite.test("rejects cross-scope relationships", async () => {
        await expectSqlState(
          client,
          "23503",
          `INSERT INTO chapter (id, owner_scope_id, course_id, chapter_order, title)
           VALUES ('00000000-0000-4000-8000-000000000499', $1, $2, 1, 'forged')`,
          [ids.scopeA, ids.courseB],
        );
      });

      await suite.test(
        "versions source spans, embeddings, and source-backed curricula",
        async () => {
          const span = "00000000-0000-5000-8000-000000000311";
          const embeddingGeneration = "00000000-0000-5000-8000-000000000312";
          const curriculumGeneration = "00000000-0000-5000-8000-000000000313";
          const chapter = "00000000-0000-5000-8000-000000000314";
          const concept = "00000000-0000-5000-8000-000000000315";
          await client.query(
            `INSERT INTO source_span
               (id, owner_scope_id, source_document_id, canonical_text,
                text_hash, page_start, page_end, section_path,
                canonical_start, canonical_end, parser_version,
                chunker_version, tokenizer_version, contract_version,
                chunk_order, native_mappings, embedding_input,
                embedding_input_hash, embedding_input_profile_version)
             VALUES ($1, $2, $3, 'Grounded text', $4, 1, 1,
                     ARRAY['Introduction'], 0, 13, 'parser-v1', 'chunk-v1',
                     'reflo-unicode-tokenizer-v1', 'source-span-v1', 0,
                     '[]'::jsonb, '[Section: Introduction] Grounded text',
                     $5, 'embedding-input-v1')`,
            [span, ids.scopeA, ids.documentA, "a".repeat(64), "b".repeat(64)],
          );
          await client.query(
            `INSERT INTO source_embedding_generation
               (id, owner_scope_id, source_document_id, profile_version,
                dimensions, input_mode, adapter_version, effective_model,
                effective_model_version, provider_identifier,
                provider_request_ids, region, endpoint, span_count, status,
                activated_at)
             VALUES ($1, $2, $3, 'embedding-v1', 1024, 'document',
                     'adapter-v1', 'text-embedding-v4', 'canary-v1',
                     'alibaba-model-studio', '["request-1"]'::jsonb,
                     'ap-southeast-1', 'https://workspace.invalid', 1,
                     'active', now())`,
            [embeddingGeneration, ids.scopeA, ids.documentA],
          );
          await client.query(
            `INSERT INTO source_embedding_generation_span
               (owner_scope_id, embedding_generation_id, source_span_id,
                span_order, embedding_input_hash)
             VALUES ($1, $2, $3, 0, $4)`,
            [ids.scopeA, embeddingGeneration, span, "b".repeat(64)],
          );
          await client.query(
            `UPDATE source_document
             SET active_embedding_generation_id = $1
             WHERE owner_scope_id = $2 AND id = $3`,
            [embeddingGeneration, ids.scopeA, ids.documentA],
          );
          await client.query(
            `INSERT INTO curriculum_generation
               (id, owner_scope_id, course_id, source_document_id,
                embedding_generation_id, generation_version, result_hash,
                model_provenance, structure, status, activated_at)
             VALUES ($1, $2, $3, $4, $5, 'curriculum-v1', $6,
                     '{}'::jsonb, '{"chapters":[]}'::jsonb, 'active', now())`,
            [
              curriculumGeneration,
              ids.scopeA,
              ids.courseA,
              ids.documentA,
              embeddingGeneration,
              "c".repeat(64),
            ],
          );
          await client.query(
            `UPDATE course SET active_curriculum_generation_id = $1
             WHERE owner_scope_id = $2 AND id = $3`,
            [curriculumGeneration, ids.scopeA, ids.courseA],
          );
          await client.query(
            `INSERT INTO chapter
               (id, owner_scope_id, course_id, chapter_order, title,
                generation_status, curriculum_generation_id)
             VALUES ($1, $2, $3, 1, 'Introduction', 'ready', $4)`,
            [chapter, ids.scopeA, ids.courseA, curriculumGeneration],
          );
          await client.query(
            `INSERT INTO concept
               (id, owner_scope_id, chapter_id, name, generation_version,
                curriculum_generation_id, concept_key, concept_order)
             VALUES ($1, $2, $3, 'Grounding', 'curriculum-v1', $4,
                     'grounding', 0)`,
            [concept, ids.scopeA, chapter, curriculumGeneration],
          );
          await client.query(
            `INSERT INTO concept_source_span
               (owner_scope_id, concept_id, source_span_id)
             VALUES ($1, $2, $3)`,
            [ids.scopeA, concept, span],
          );

          await expectSqlState(
            client,
            "23503",
            `INSERT INTO source_embedding_generation
               (id, owner_scope_id, source_document_id, profile_version,
                dimensions, input_mode, adapter_version, effective_model,
                effective_model_version, provider_identifier,
                provider_request_ids, region, endpoint, span_count, status)
             VALUES ('00000000-0000-5000-8000-000000000399', $1, $2,
                     'embedding-v1', 1024, 'document', 'adapter-v1',
                     'text-embedding-v4', 'canary-v1',
                     'alibaba-model-studio', '[]'::jsonb,
                     'ap-southeast-1', 'https://workspace.invalid', 1,
                     'building')`,
            [ids.scopeA, ids.documentB],
          );
        },
      );

      await suite.test(
        "persists idempotent activation operations and provenance-backed artifacts",
        async () => {
          const curriculum = "00000000-0000-5000-8000-000000000313";
          const chapter = "00000000-0000-5000-8000-000000000314";
          const concept = "00000000-0000-5000-8000-000000000315";
          const placementOperation = "00000000-0000-5000-8000-000000000321";
          await client.query(
            `INSERT INTO activation_generation_operation
               (id, owner_scope_id, course_id, curriculum_generation_id,
                artifact_kind, generation_version, idempotency_key, priority)
             VALUES ($1, $2, $3, $4, 'placement_quiz',
                     'activation-generation-v1', $5, 2)`,
            [
              placementOperation,
              ids.scopeA,
              ids.courseA,
              curriculum,
              `dev/content.activation.generate/v1/${placementOperation}`,
            ],
          );
          await expectSqlState(
            client,
            "23505",
            `INSERT INTO activation_generation_operation
               (id, owner_scope_id, course_id, curriculum_generation_id,
                artifact_kind, generation_version, idempotency_key, priority)
             VALUES ('00000000-0000-5000-8000-000000000329', $1, $2, $3,
                     'placement_quiz', 'activation-generation-v1',
                     'dev/content.activation.generate/v1/00000000-0000-5000-8000-000000000329', 2)`,
            [ids.scopeA, ids.courseA, curriculum],
          );

          const lessonOperation = "00000000-0000-5000-8000-000000000322";
          const asset = "00000000-0000-5000-8000-000000000323";
          await client.query(
            `INSERT INTO activation_generation_operation
               (id, owner_scope_id, course_id, curriculum_generation_id,
                artifact_kind, chapter_id, concept_id, generation_version,
                idempotency_key, priority, status, attempt_count, artifact_id,
                completed_at)
             VALUES ($1, $2, $3, $4, 'first_text_lesson', $5, $6,
                     'activation-generation-v1', $7, 1, 'succeeded', 1, $8,
                     now())`,
            [
              lessonOperation,
              ids.scopeA,
              ids.courseA,
              curriculum,
              chapter,
              concept,
              `dev/content.activation.generate/v1/${lessonOperation}`,
              asset,
            ],
          );
          await expectSqlState(
            client,
            "23514",
            `INSERT INTO asset
               (id, owner_scope_id, course_id, chapter_id, concept_id,
                asset_type, object_key, generation_version, status,
                generation_operation_id)
             VALUES ($1, $2, $3, $4, $5, 'text', 'owners/test/invalid.md',
                     'activation-generation-v1', 'ready', $6)`,
            [asset, ids.scopeA, ids.courseA, chapter, concept, lessonOperation],
          );
          await client.query(
            `INSERT INTO asset
               (id, owner_scope_id, course_id, chapter_id, concept_id,
                asset_type, object_key, model_id, prompt_id,
                generation_version, strategy_tag, status,
                generation_operation_id, model_provenance, content_hash,
                content_type, byte_size, etag)
             VALUES ($1, $2, $3, $4, $5, 'text', $6, 'qwen-plus',
                     'lesson-text', 'activation-generation-v1', 'example-v1',
                     'ready', $7, '{"task":"lesson.text.v1"}'::jsonb, $8,
                     'text/markdown; charset=utf-8', 400, 'etag-1')`,
            [
              asset,
              ids.scopeA,
              ids.courseA,
              chapter,
              concept,
              `owners/${ids.scopeA}/courses/${ids.courseA}/assets/${asset}/generations/${lessonOperation}/payload.md`,
              lessonOperation,
              "d".repeat(64),
            ],
          );
          await expectSqlState(
            client,
            "23514",
            `UPDATE activation_generation_operation
             SET status = 'failed_permanent', artifact_id = NULL,
                 failure_class = 'late_failure', completed_at = now()
             WHERE id = $1`,
            [lessonOperation],
          );

          const chapterOperation = "00000000-0000-5000-8000-000000000324";
          const bank = "00000000-0000-5000-8000-000000000325";
          await client.query(
            `INSERT INTO activation_generation_operation
               (id, owner_scope_id, course_id, curriculum_generation_id,
                artifact_kind, chapter_id, generation_version,
                idempotency_key, priority, status, attempt_count, artifact_id,
                completed_at)
             VALUES ($1, $2, $3, $4, 'chapter_quiz', $5,
                     'activation-generation-v1', $6, 3, 'succeeded', 1, $7,
                     now())`,
            [
              chapterOperation,
              ids.scopeA,
              ids.courseA,
              curriculum,
              chapter,
              `dev/content.activation.generate/v1/${chapterOperation}`,
              bank,
            ],
          );
          await client.query(
            `INSERT INTO quiz_bank
               (id, owner_scope_id, course_id, chapter_id,
                generation_operation_id, bank_kind, generation_version,
                model_provenance, result_hash, item_count)
             VALUES ($1, $2, $3, $4, $5, 'chapter',
                     'activation-generation-v1',
                     '{"task":"assessment.quiz.v1"}'::jsonb, $6, 5)`,
            [
              bank,
              ids.scopeA,
              ids.courseA,
              chapter,
              chapterOperation,
              "e".repeat(64),
            ],
          );
          await client.query(
            `INSERT INTO quiz_item
               (id, owner_scope_id, course_id, item_type, difficulty, prompt,
                keyed_answer, version, quiz_bank_id, item_order,
                normalized_prompt_hash, response_options)
             VALUES ('00000000-0000-5000-8000-000000000326', $1, $2,
                     'multiple_choice', 2, 'Question one?', '"correct"'::jsonb,
                     'activation-generation-v1', $3, 0, $4,
                     '["correct","incorrect"]'::jsonb)`,
            [ids.scopeA, ids.courseA, bank, "f".repeat(64)],
          );
          await expectSqlState(
            client,
            "23505",
            `INSERT INTO quiz_item
               (id, owner_scope_id, course_id, item_type, difficulty, prompt,
                keyed_answer, version, quiz_bank_id, item_order,
                normalized_prompt_hash, response_options)
             VALUES ('00000000-0000-5000-8000-000000000327', $1, $2,
                     'multiple_choice', 2, 'Question one!', '"correct"'::jsonb,
                     'activation-generation-v1', $3, 1, $4,
                     '["correct","incorrect"]'::jsonb)`,
            [ids.scopeA, ids.courseA, bank, "f".repeat(64)],
          );
        },
      );

      await suite.test(
        "enforces provider and logical idempotency uniqueness",
        async () => {
          const channel = "00000000-0000-4000-8000-000000000501";
          await client.query(
            `INSERT INTO channel_identity
             (id, owner_scope_id, user_id, provider, encrypted_external_id, external_id_lookup_digest, verified_at)
           VALUES ($1, $2, $3, 'telegram', decode('aa', 'hex'), decode('bb', 'hex'), now())`,
            [channel, ids.scopeA, ids.userA],
          );
          await client.query(
            `INSERT INTO quiz_delivery
             (id, owner_scope_id, channel_identity_id, provider, provider_message_id, idempotency_key, status, expires_at)
           VALUES ('00000000-0000-4000-8000-000000000511', $1, $2, 'telegram', 'provider-1', 'dev/delivery/v1/a', 'submitted', now() + interval '1 day')`,
            [ids.scopeA, channel],
          );
          await expectSqlState(
            client,
            "23505",
            `INSERT INTO quiz_delivery
             (id, owner_scope_id, channel_identity_id, provider, provider_message_id, status, expires_at)
           VALUES ('00000000-0000-4000-8000-000000000512', $1, $2, 'telegram', 'provider-1', 'submitted', now() + interval '1 day')`,
            [ids.scopeA, channel],
          );
          await expectSqlState(
            client,
            "23505",
            `INSERT INTO quiz_delivery
             (id, owner_scope_id, channel_identity_id, provider, idempotency_key, status, expires_at)
           VALUES ('00000000-0000-4000-8000-000000000513', $1, $2, 'telegram', 'dev/delivery/v1/a', 'pending', now() + interval '1 day')`,
            [ids.scopeA, channel],
          );
        },
      );

      await suite.test(
        "preserves the first committed terminal operation state",
        async () => {
          await client.query(
            `INSERT INTO async_operation
               (id, owner_scope_id, operation_name, operation_version, idempotency_key, state, completed_at)
             VALUES ('00000000-0000-4000-8000-000000000601', $1, 'ingestion.parse', 1,
                     'dev/ingestion.parse/v1/a', 'succeeded', now())`,
            [ids.scopeA],
          );
          await client.query(
            `INSERT INTO ingestion_operation
               (operation_id, owner_scope_id, requested_by_user_id,
                source_document_id, input_sha256)
             VALUES ('00000000-0000-4000-8000-000000000601', $1, $2, $3, $4)`,
            [ids.scopeA, ids.userA, ids.documentA, "a".repeat(64)],
          );
          await expectSqlState(
            client,
            "23514",
            `UPDATE async_operation
             SET state = 'failed_permanent', sanitized_failure = '{"class":"late_failure"}'
             WHERE id = '00000000-0000-4000-8000-000000000601'`,
          );
        },
      );

      await suite.test(
        "fails closed under RLS without the matching transaction context",
        async () => {
          await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
          await client.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`,
          );
          await client.query(
            `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`,
          );
          await client.query(
            `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${runtimeRole}`,
          );

          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${runtimeRole}`);
          let result = await client.query("SELECT id FROM course ORDER BY id");
          assert.deepEqual(result.rows, []);
          result = await client.query(
            "SELECT operation_id FROM ingestion_operation ORDER BY operation_id",
          );
          assert.deepEqual(result.rows, []);
          result = await client.query(
            "SELECT id FROM activation_generation_operation ORDER BY id",
          );
          assert.deepEqual(result.rows, []);
          await client.query("ROLLBACK");

          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${runtimeRole}`);
          await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
            ids.userA,
          ]);
          await client.query(
            "SELECT set_config('reflo.owner_scope_id', $1, true)",
            [ids.scopeA],
          );
          result = await client.query("SELECT id FROM course ORDER BY id");
          assert.deepEqual(result.rows, [{ id: ids.courseA }]);
          result = await client.query(
            "SELECT operation_id FROM ingestion_operation ORDER BY operation_id",
          );
          assert.deepEqual(result.rows, [
            { operation_id: "00000000-0000-4000-8000-000000000601" },
          ]);
          result = await client.query(
            "SELECT id FROM source_embedding_generation ORDER BY id",
          );
          assert.deepEqual(result.rows, [
            { id: "00000000-0000-5000-8000-000000000312" },
          ]);
          result = await client.query(
            "SELECT id FROM activation_generation_operation ORDER BY id",
          );
          assert.deepEqual(result.rows, [
            { id: "00000000-0000-5000-8000-000000000321" },
            { id: "00000000-0000-5000-8000-000000000322" },
            { id: "00000000-0000-5000-8000-000000000324" },
          ]);
          await assert.rejects(
            client.query(
              `INSERT INTO course (id, owner_scope_id, source_document_id, title, status)
             VALUES ('00000000-0000-4000-8000-000000000499', $1, $2, 'forged', 'ready')`,
              [ids.scopeB, ids.documentB],
            ),
            (error) => error.code === "42501",
          );
          await client.query("ROLLBACK");

          const eventId = "00000000-0000-4000-8000-000000000701";
          await client.query(
            `INSERT INTO learning_event
               (id, owner_scope_id, user_id, event_type, event_version,
                producer, correlation_id, idempotency_key, payload, occurred_at)
             VALUES ($1, $2, $3, 'lesson_completed', 1, 'schema-test',
                     $1, 'test/learning.lesson-completed/v1/event-701',
                     '{}', now())`,
            [eventId, ids.scopeA, ids.userA],
          );
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${runtimeRole}`);
          await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
            ids.userA,
          ]);
          await client.query(
            "SELECT set_config('reflo.owner_scope_id', $1, true)",
            [ids.scopeA],
          );
          const tamperResult = await client.query(
            "UPDATE learning_event SET event_type = 'tampered' WHERE id = $1",
            [eventId],
          );
          assert.equal(tamperResult.rowCount, 0);
          await client.query("ROLLBACK");
          const persistedEvent = await client.query(
            "SELECT event_type FROM learning_event WHERE id = $1",
            [eventId],
          );
          assert.equal(persistedEvent.rows[0].event_type, "lesson_completed");
        },
      );
    } finally {
      if (client !== undefined) {
        await client.end().catch(() => undefined);
      }
      await admin
        .query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
        .catch(() => undefined);
      await admin
        .query(`DROP ROLE IF EXISTS ${runtimeRole}`)
        .catch(() => undefined);
      await admin.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

async function seedCoreFixture(client) {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
     VALUES ($1, decode('01', 'hex'), decode('11', 'hex')),
            ($2, decode('02', 'hex'), decode('12', 'hex'))`,
    [ids.userA, ids.userB],
  );
  await client.query(`INSERT INTO owner_scope (id) VALUES ($1), ($2)`, [
    ids.scopeA,
    ids.scopeB,
  ]);
  await client.query(
    `INSERT INTO scope_membership (id, owner_scope_id, user_id)
     VALUES ($1, $2, $3), ($4, $5, $6)`,
    [ids.memberA, ids.scopeA, ids.userA, ids.memberB, ids.scopeB, ids.userB],
  );
  await client.query("COMMIT");

  await client.query(
    `INSERT INTO source_document
       (id, owner_scope_id, object_key, checksum, media_type, byte_size, parse_status)
     VALUES ($1, $2, 'owners/a/source', 'sha256:a', 'application/pdf', 10, 'parsed'),
            ($3, $4, 'owners/b/source', 'sha256:b', 'application/pdf', 10, 'parsed')`,
    [ids.documentA, ids.scopeA, ids.documentB, ids.scopeB],
  );
  await client.query(
    `INSERT INTO course (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Course A', 'ready'),
            ($4, $5, $6, 'Course B', 'ready')`,
    [
      ids.courseA,
      ids.scopeA,
      ids.documentA,
      ids.courseB,
      ids.scopeB,
      ids.documentB,
    ],
  );
}

async function expectSqlState(client, code, sql, parameters = []) {
  await assert.rejects(
    client.query(sql, parameters),
    (error) => error.code === code,
  );
}

function assertSchemasEqual(actual, expected) {
  if (actual === expected) {
    return;
  }

  let firstDifference = 0;
  while (
    firstDifference < actual.length &&
    firstDifference < expected.length &&
    actual[firstDifference] === expected[firstDifference]
  ) {
    firstDifference += 1;
  }

  const contextStart = Math.max(0, firstDifference - 120);
  const contextEnd = firstDifference + 240;
  assert.fail(
    [
      "schema.sql is stale; run db:dump",
      `first difference: ${firstDifference}`,
      `actual length: ${actual.length}; expected length: ${expected.length}`,
      `actual context: ${JSON.stringify(actual.slice(contextStart, contextEnd))}`,
      `expected context: ${JSON.stringify(expected.slice(contextStart, contextEnd))}`,
      `actual tail: ${JSON.stringify(actual.slice(-320))}`,
      `expected tail: ${JSON.stringify(expected.slice(-320))}`,
    ].join("\n"),
  );
}
