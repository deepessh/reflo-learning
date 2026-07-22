import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { buildAudioPlan } from "@reflo/audio";

import { PostgresAudioGenerationRepository } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  chapter: "20000000-0000-4000-8000-000000000001",
  course: "20000000-0000-4000-8000-000000000002",
  document: "20000000-0000-4000-8000-000000000003",
  membership: "20000000-0000-4000-8000-000000000004",
  scope: "20000000-0000-4000-8000-000000000005",
  script: "20000000-0000-4000-8000-000000000006",
  span: "20000000-0000-4000-8000-000000000007",
  user: "20000000-0000-4000-8000-000000000008",
};
const authorization = {
  actorId: ids.user,
  authorizationId: "audio-authorization-test",
  ownerScopeId: ids.scope,
};

test(
  "PostgresAudioGenerationRepository binds envelopes, leases, priority, and terminal state",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const databaseName = `reflo_audio_${suffix}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let repository;
    let competing;
    let client;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const databaseUrl = new URL(baseDatabaseUrl);
      databaseUrl.pathname = `/${databaseName}`;
      await execFileAsync(
        process.execPath,
        [path.join(packageRoot, "scripts/strict-migrate.mjs")],
        { env: { ...process.env, DATABASE_URL: databaseUrl.toString() } },
      );
      client = new pg.Client({ connectionString: databaseUrl.toString() });
      await client.connect();
      await seed(client);
      repository = new PostgresAudioGenerationRepository({
        connectionString: databaseUrl.toString(),
        leaseDurationMs: 60_000,
        leaseOwner: "audio-worker-test-0001",
      });
      competing = new PostgresAudioGenerationRepository({
        connectionString: databaseUrl.toString(),
        leaseDurationMs: 60_000,
        leaseOwner: "audio-worker-test-0002",
      });

      const course = await repository.loadCourse(authorization, ids.course);
      assert.ok(course);
      const operations = buildAudioPlan(
        course,
        "dev",
        new Date(),
        new Date(Date.now() + 60 * 60_000),
      );
      const registered = await repository.registerOperations(
        course,
        operations,
      );
      assert.deepEqual(
        registered.map(({ priority, status }) => ({ priority, status })),
        [{ priority: 1, status: "queued" }],
      );

      const envelope = operations[0].envelope;
      const claimed = await repository.claimOperation(authorization, envelope);
      assert.equal(claimed.kind, "claimed");
      await assert.rejects(
        competing.claimOperation(authorization, {
          ...envelope,
          messageId: "20000000-0000-4000-8000-000000000099",
        }),
        (error) => error.code === "invalid_envelope",
      );
      assert.deepEqual(
        await competing.claimOperation(authorization, envelope),
        { kind: "active" },
      );
      if (claimed.kind !== "claimed") {
        assert.fail("operation was not claimed");
      }
      const failed = await repository.recordFailure(claimed.work, {
        failureClass: "ambiguous_submission",
        retryable: false,
        terminalStatus: "failed_permanent",
      });
      assert.deepEqual(
        {
          attemptCount: failed.attemptCount,
          failureClass: failed.failureClass,
          status: failed.status,
        },
        {
          attemptCount: 1,
          failureClass: "ambiguous_submission",
          status: "failed_permanent",
        },
      );
      assert.deepEqual(
        await competing.claimOperation(authorization, envelope),
        { kind: "already_final", status: failed },
      );

      const outbox = await client.query(
        `SELECT message_kind, message_name, priority, payload::text
         FROM outbox_message
         WHERE operation_id = $1
         ORDER BY priority, message_kind DESC`,
        [failed.id],
      );
      assert.deepEqual(
        outbox.rows.map(({ message_name, priority }) => ({
          messageName: message_name,
          priority,
        })),
        [
          { messageName: "media.audio.generate", priority: 1 },
          { messageName: "media.audio.failed", priority: 800 },
        ],
      );
      assert.equal(
        outbox.rows.some(({ payload }) => payload.includes("Narration")),
        false,
      );
    } finally {
      await competing?.close();
      await repository?.close();
      await client?.end();
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

async function seed(client) {
  const narration = "Narration grounded in one source span.";
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
     VALUES ($1, decode('21', 'hex'), decode('22', 'hex'))`,
    [ids.user],
  );
  await client.query("INSERT INTO owner_scope (id) VALUES ($1)", [ids.scope]);
  await client.query(
    `INSERT INTO scope_membership (id, owner_scope_id, user_id)
     VALUES ($1, $2, $3)`,
    [ids.membership, ids.scope, ids.user],
  );
  await client.query(
    `INSERT INTO source_document
       (id, owner_scope_id, object_key, checksum, media_type,
        byte_size, parse_status)
     VALUES ($1, $2, 'owners/audio/source.pdf', 'sha256:audio',
             'application/pdf', 512, 'parsed')`,
    [ids.document, ids.scope],
  );
  await client.query(
    `INSERT INTO source_span
       (id, owner_scope_id, source_document_id, canonical_text, text_hash,
        page_start, page_end, canonical_start, canonical_end,
        parser_version, chunker_version, tokenizer_version)
     VALUES ($1, $2, $3, 'Grounded text', $4, 1, 1, 0, 13,
             'parser-v1', 'chunker-v1', 'tokenizer-v1')`,
    [ids.span, ids.scope, ids.document, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, 'Audio course', 'ready')`,
    [ids.course, ids.scope, ids.document],
  );
  await client.query(
    `INSERT INTO chapter
       (id, owner_scope_id, course_id, chapter_order, title, generation_status)
     VALUES ($1, $2, $3, 1, 'Chapter one', 'ready')`,
    [ids.chapter, ids.scope, ids.course],
  );
  await client.query(
    `INSERT INTO narration_script
       (id, owner_scope_id, course_id, chapter_id, script_text,
        script_sha256, generation_version, model_provenance)
     VALUES ($1, $2, $3, $4, $5, $6,
             'narration-script-v1',
             '{"task":"lesson.audio-script.v1","validationOutcome":"passed"}'::jsonb)`,
    [
      ids.script,
      ids.scope,
      ids.course,
      ids.chapter,
      narration,
      createHash("sha256").update(narration).digest("hex"),
    ],
  );
  await client.query(
    `INSERT INTO narration_script_source_span
       (owner_scope_id, narration_script_id, source_span_id, span_order)
     VALUES ($1, $2, $3, 0)`,
    [ids.scope, ids.script, ids.span],
  );
  await client.query("COMMIT");
}
