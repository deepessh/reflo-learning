import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { PostgresDemoUploadRepository } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;
const ids = {
  course: "55000000-0000-4000-8000-000000000001",
  generationOperation: "55000000-0000-4000-8000-00000000000a",
  member: "55000000-0000-4000-8000-000000000002",
  operation: "55000000-0000-4000-8000-000000000003",
  otherMember: "55000000-0000-4000-8000-000000000004",
  otherScope: "55000000-0000-4000-8000-000000000005",
  otherUser: "55000000-0000-4000-8000-000000000006",
  scope: "55000000-0000-4000-8000-000000000007",
  source: "55000000-0000-4000-8000-000000000008",
  user: "55000000-0000-4000-8000-000000000009",
};

test(
  "PostgresDemoUploadRepository creates and reads only the active owner-scoped ingestion operation",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_demo_upload_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let repository;
    let client;
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
      await seedIdentities(client);
      repository = new PostgresDemoUploadRepository(databaseUrl.toString(), {
        environment: "dev",
      });
      const authorization = {
        actorId: ids.user,
        authorizationId: "demo-upload-test-session",
        ownerScopeId: ids.scope,
      };
      await repository.create({
        authorization,
        byteSize: 478_301,
        checksum: "a".repeat(64),
        courseId: ids.course,
        generationOperationId: ids.generationOperation,
        mediaType: "application/pdf",
        objectKey: `owners/${ids.scope}/sources/${ids.source}/versions/v1/original.pdf`,
        operationId: ids.operation,
        sourceDocumentId: ids.source,
        title: "Approved Agents Course",
      });

      assert.deepEqual(await repository.get(authorization, ids.source), {
        activeCurriculumGenerationId: null,
        byteSize: 478_301,
        checksum: "a".repeat(64),
        courseId: ids.course,
        courseStatus: "generating",
        failureClass: null,
        operationState: "queued",
        pageCount: null,
        parseStatus: "quarantined",
        sourceDocumentId: ids.source,
        title: "Approved Agents Course",
        updatedAt: (await repository.get(authorization, ids.source)).updatedAt,
      });
      const [recoverable] = await repository.listRecoverable(authorization);
      assert.deepEqual(recoverable, {
        authorization,
        courseId: ids.course,
        expectedInputSha256: "a".repeat(64),
        generationOperationId: ids.generationOperation,
        operationId: ids.operation,
        sourceDocumentId: ids.source,
      });
      await client.query(
        `UPDATE source_document
         SET parse_status = 'parsed', page_count = 12,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [ids.source],
      );
      await client.query(
        `UPDATE async_operation
         SET state = 'succeeded', completed_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [ids.operation],
      );
      assert.equal(
        (await repository.claimCourseGeneration(recoverable)).kind,
        "claimed",
      );
      assert.equal(
        await repository.failCourseGenerationAttempt(recoverable, {
          failureClass: "generation_dependency_unavailable",
          retryable: true,
        }),
        "retry_scheduled",
      );
      assert.equal(
        (await repository.claimCourseGeneration(recoverable)).kind,
        "claimed",
      );
      assert.equal(
        await repository.failCourseGenerationAttempt(recoverable, {
          failureClass: "generation_invalid_result",
          retryable: false,
        }),
        "failed",
      );
      const generationFailed = await repository.get(authorization, ids.source);
      assert.equal(generationFailed.courseStatus, "failed");
      assert.equal(
        generationFailed.failureClass,
        "curriculum_generation_failed",
      );
      assert.equal(
        await repository.get(
          {
            actorId: ids.otherUser,
            authorizationId: "other-demo-session",
            ownerScopeId: ids.otherScope,
          },
          ids.source,
        ),
        null,
      );

      assert.equal(
        await repository.loadOutline(authorization, ids.source),
        null,
      );
    } finally {
      await repository?.close().catch(() => undefined);
      await client?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  },
);

async function seedIdentities(client) {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
     VALUES ($1, decode('01', 'hex'), decode('11', 'hex')),
            ($2, decode('02', 'hex'), decode('12', 'hex'))`,
    [ids.user, ids.otherUser],
  );
  await client.query("INSERT INTO owner_scope (id) VALUES ($1), ($2)", [
    ids.scope,
    ids.otherScope,
  ]);
  await client.query(
    `INSERT INTO scope_membership (id, owner_scope_id, user_id)
     VALUES ($1, $2, $3), ($4, $5, $6)`,
    [
      ids.member,
      ids.scope,
      ids.user,
      ids.otherMember,
      ids.otherScope,
      ids.otherUser,
    ],
  );
  await client.query("COMMIT");
}
