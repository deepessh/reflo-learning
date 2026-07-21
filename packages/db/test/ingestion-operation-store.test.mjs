import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { PostgresIngestionOperationStore } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  membership: "10000000-0000-4000-8000-000000000001",
  operation: "10000000-0000-4000-8000-000000000002",
  scope: "10000000-0000-4000-8000-000000000003",
  source: "10000000-0000-4000-8000-000000000004",
  user: "10000000-0000-4000-8000-000000000005",
  version: "10000000-0000-4000-8000-000000000006",
};
const inputSha256 = "a".repeat(64);

test(
  "PostgresIngestionOperationStore leases, reauthorizes, and finalizes once",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_ingestion_${process.pid}_${Date.now()}`;
    const runtimeRole = `reflo_ingestion_${process.pid}_${Date.now()}`;
    const runtimePassword = `test-${process.pid}-${Date.now()}-only`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let repository;
    let competing;
    let runtimeClient;
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
      client = new pg.Client({
        connectionString: databaseUrl.toString(),
      });
      await client.connect();
      await seed(client);
      const createRole = await admin.query(
        "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
        [runtimeRole, runtimePassword],
      );
      await admin.query(createRole.rows[0].sql);
      await client.query(
        `GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`,
      );
      await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await client.query(
        `GRANT EXECUTE ON FUNCTION reflo_resolve_ingestion_authorization(uuid)
         TO ${runtimeRole}`,
      );
      await client.query(
        `GRANT SELECT, UPDATE ON async_operation, source_document
         TO ${runtimeRole}`,
      );
      await client.query(
        `GRANT SELECT ON ingestion_operation, owner_scope,
           scope_membership, app_user TO ${runtimeRole}`,
      );
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON async_operation_attempt
         TO ${runtimeRole}`,
      );
      const runtimeDatabaseUrl = new URL(databaseUrl);
      runtimeDatabaseUrl.username = runtimeRole;
      runtimeDatabaseUrl.password = runtimePassword;
      runtimeClient = new pg.Client({
        connectionString: runtimeDatabaseUrl.toString(),
      });
      await runtimeClient.connect();
      assert.equal(
        (
          await runtimeClient.query(
            "SELECT count(*)::int AS count FROM ingestion_operation",
          )
        ).rows[0].count,
        0,
      );
      repository = new PostgresIngestionOperationStore({
        connectionString: runtimeDatabaseUrl.toString(),
        environment: "dev",
        leaseDurationMs: 60_000,
        leaseOwner: "worker-test-0001",
      });
      competing = new PostgresIngestionOperationStore({
        connectionString: runtimeDatabaseUrl.toString(),
        environment: "dev",
        leaseDurationMs: 60_000,
        leaseOwner: "worker-test-0002",
      });
      const command = {
        expectedInputSha256: inputSha256,
        operationId: ids.operation,
        ownerScopeId: ids.scope,
        sourceDocumentId: ids.source,
      };

      assert.deepEqual(await repository.claim(command), { kind: "claimed" });
      assert.deepEqual(await competing.claim(command), { kind: "active" });
      await client.query(
        `UPDATE async_operation
         SET lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [ids.operation],
      );
      assert.deepEqual(await competing.claim(command), { kind: "claimed" });
      assert.equal(await repository.resolveAuthorizedSource(command), null);
      assert.deepEqual(await competing.resolveAuthorizedSource(command), {
        clientMimeType: "application/pdf",
        expectedByteLength: 512,
        expectedInputSha256: inputSha256,
        extension: "pdf",
        objectKey: `owners/${ids.scope}/sources/${ids.source}/versions/${ids.version}/original.pdf`,
        ownerScopeId: ids.scope,
        retentionState: "active",
        sourceDocumentId: ids.source,
      });

      const outcome = parsedOutcome();
      assert.equal(await repository.finalize(ids.operation, outcome), false);
      assert.equal(await competing.finalize(ids.operation, outcome), true);
      assert.deepEqual(await repository.claim(command), {
        kind: "completed",
        outcome,
      });
      const persisted = await client.query(
        `SELECT operation.state, operation.attempt_count,
                source.parse_status, source.page_count
         FROM async_operation AS operation
         JOIN ingestion_operation AS ingestion ON ingestion.operation_id = operation.id
         JOIN source_document AS source ON source.id = ingestion.source_document_id
         WHERE operation.id = $1`,
        [ids.operation],
      );
      assert.deepEqual(persisted.rows[0], {
        attempt_count: 2,
        page_count: 1,
        parse_status: "parsed",
        state: "succeeded",
      });
      const attempts = await client.query(
        `SELECT delivery_number, outcome, normalized_failure_class
         FROM async_operation_attempt
         WHERE operation_id = $1
         ORDER BY delivery_number`,
        [ids.operation],
      );
      assert.deepEqual(attempts.rows, [
        {
          delivery_number: 1,
          normalized_failure_class: "infrastructure_unavailable",
          outcome: "retry_scheduled",
        },
        {
          delivery_number: 2,
          normalized_failure_class: null,
          outcome: "succeeded",
        },
      ]);
      await assert.rejects(
        repository.claim({ ...command, sourceDocumentId: ids.version }),
        (error) => error.code === "authorization_denied",
      );
      await competing.close();
      competing = undefined;
      await runtimeClient.end();
      runtimeClient = undefined;
      await client.end();
      client = undefined;
    } finally {
      await competing?.close();
      await repository?.close();
      await runtimeClient?.end();
      await client?.end();
      await admin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await admin.end();
    }
  },
);

async function seed(client) {
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
    [ids.membership, ids.scope, ids.user],
  );
  await client.query(
    `INSERT INTO source_document
       (id, owner_scope_id, object_key, checksum, media_type,
        byte_size, parse_status)
     VALUES ($1, $2, $3, $4, 'application/pdf', 512, 'queued')`,
    [
      ids.source,
      ids.scope,
      `owners/${ids.scope}/sources/${ids.source}/versions/${ids.version}/original.pdf`,
      inputSha256,
    ],
  );
  await client.query(
    `INSERT INTO async_operation
       (id, owner_scope_id, operation_name, operation_version,
        idempotency_key, state, deadline_at)
     VALUES ($1, $2, 'ingestion.parse', 1, $3, 'queued', now() + interval '1 hour')`,
    [ids.operation, ids.scope, `dev/ingestion.parse/v1/${ids.source}`],
  );
  await client.query(
    `INSERT INTO ingestion_operation
       (operation_id, owner_scope_id, requested_by_user_id,
        source_document_id, input_sha256)
     VALUES ($1, $2, $3, $4, $5)`,
    [ids.operation, ids.scope, ids.user, ids.source, inputSha256],
  );
  await client.query("COMMIT");
}

function parsedOutcome() {
  return {
    artifact: {
      artifactId: "artifact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      blockCount: 2,
      byteLength: 2048,
      documentKind: "pdf",
      documentSha256: "b".repeat(64),
      inputSha256,
      pageCount: 1,
      parserVersion: "apache-tika-3.3.1",
      workerImageDigest: `sha256:${"c".repeat(64)}`,
    },
    kind: "parsed",
    processingLane: "standard",
  };
}
