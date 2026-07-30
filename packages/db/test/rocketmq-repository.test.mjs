import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { buildAudioPlan } from "@reflo/audio";

import {
  PostgresAudioGenerationRepository,
  PostgresRocketMqRepository,
} from "../dist/index.js";
import {
  provisionLocalApiRole,
  provisionRocketMqRoles,
} from "../scripts/prepare-local-app-profile.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  chapters: [
    "91000000-0000-4000-8000-000000000001",
    "91000000-0000-4000-8000-000000000002",
  ],
  course: "91000000-0000-4000-8000-000000000003",
  document: "91000000-0000-4000-8000-000000000004",
  membership: "91000000-0000-4000-8000-000000000005",
  scope: "91000000-0000-4000-8000-000000000006",
  scripts: [
    "91000000-0000-4000-8000-000000000007",
    "91000000-0000-4000-8000-000000000008",
  ],
  span: "91000000-0000-4000-8000-000000000009",
  user: "91000000-0000-4000-8000-000000000010",
};
const authorization = {
  actorId: ids.user,
  authorizationId: ids.membership,
  ownerScopeId: ids.scope,
};

test(
  "PostgresRocketMqRepository preserves relay leases and audited redrive identity",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const databaseName = `reflo_rocketmq_${suffix}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
    let apiClient;
    let audio;
    let client;
    let redriveA;
    let redriveB;
    let redriveClient;
    let relayA;
    let relayB;
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
      const relayPassword = "a".repeat(48);
      const redrivePassword = "b".repeat(48);
      const apiPassword = "c".repeat(48);
      await provisionLocalApiRole(databaseUrl.toString(), apiPassword);
      await provisionRocketMqRoles(
        databaseUrl.toString(),
        relayPassword,
        redrivePassword,
      );
      const relayUrl = new URL(databaseUrl);
      relayUrl.username = "reflo_relay";
      relayUrl.password = relayPassword;
      const redriveUrl = new URL(databaseUrl);
      redriveUrl.username = "reflo_redrive";
      redriveUrl.password = redrivePassword;
      const apiUrl = new URL(databaseUrl);
      apiUrl.username = "reflo_api";
      apiUrl.password = apiPassword;
      apiClient = new pg.Client({ connectionString: apiUrl.toString() });
      await apiClient.connect();
      await assert.rejects(
        apiClient.query("SELECT * FROM rocketmq_redrive_audit"),
        (error) => error.code === "42501",
      );
      await assert.rejects(
        apiClient.query(
          `SELECT *
           FROM reflo_claim_outbox_messages(
             'api-must-not-relay',
             now() + interval '30 seconds',
             1,
             now()
           )`,
        ),
        (error) => error.code === "42501",
      );
      redriveClient = new pg.Client({
        connectionString: redriveUrl.toString(),
      });
      await redriveClient.connect();
      await assert.rejects(
        redriveClient.query("SELECT * FROM rocketmq_redrive_audit"),
        (error) => error.code === "42501",
      );
      client = new pg.Client({ connectionString: databaseUrl.toString() });
      await client.connect();
      await seed(client);

      audio = new PostgresAudioGenerationRepository({
        connectionString: databaseUrl.toString(),
        leaseDurationMs: 60_000,
        leaseOwner: "audio-seed-owner",
      });
      const course = await audio.loadCourse(authorization, ids.course);
      assert.ok(course);
      const now = new Date();
      const operations = buildAudioPlan(
        course,
        "dev",
        now,
        new Date(now.getTime() + 60 * 60_000),
      );
      assert.equal(operations.length, 2);
      await audio.registerOperations(course, operations);

      relayA = new PostgresRocketMqRepository({
        connectionString: relayUrl.toString(),
        leaseDurationMs: 10_000,
        leaseOwner: "relay-owner-a",
      });
      relayB = new PostgresRocketMqRepository({
        connectionString: relayUrl.toString(),
        leaseDurationMs: 10_000,
        leaseOwner: "relay-owner-b",
      });
      redriveA = new PostgresRocketMqRepository({
        connectionString: redriveUrl.toString(),
        leaseDurationMs: 10_000,
        leaseOwner: "redrive-owner-a",
      });
      redriveB = new PostgresRocketMqRepository({
        connectionString: redriveUrl.toString(),
        leaseDurationMs: 10_000,
        leaseOwner: "redrive-owner-b",
      });

      const [claimA, claimB] = await Promise.all([
        relayA.claimOutbox(1, now),
        relayB.claimOutbox(1, now),
      ]);
      assert.equal(claimA.length, 1);
      assert.equal(claimB.length, 1);
      assert.notEqual(claimA[0].messageId, claimB[0].messageId);
      assert.deepEqual(
        new Set([claimA[0].messageId, claimB[0].messageId]),
        new Set(operations.map(({ envelope }) => envelope.messageId)),
      );

      assert.equal(
        await relayA.markOutboxPublished(claimB[0].messageId, now),
        false,
      );
      assert.equal(
        await relayA.markOutboxPublished(claimA[0].messageId, now),
        true,
      );

      const recoveredAt = new Date(now.getTime() + 10_001);
      const recovered = await relayA.claimOutbox(1, recoveredAt);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].messageId, claimB[0].messageId);
      assert.equal(
        await relayB.markOutboxPublished(claimB[0].messageId, recoveredAt),
        false,
      );
      assert.equal(
        await relayA.markOutboxPublished(claimB[0].messageId, recoveredAt),
        true,
      );
      assert.deepEqual(await relayB.claimOutbox(2, recoveredAt), []);

      const requestKey = "91000000-0000-4000-8000-000000000011";
      const identity = {
        messageId: claimA[0].messageId,
        now: recoveredAt,
        reasonCode: "provider_recovered",
        requestKey,
      };
      await assert.rejects(
        relayA.inspectRedrive(identity.messageId, recoveredAt),
        (error) => error.code === "42501",
      );
      const inspection = await redriveA.inspectRedrive(
        identity.messageId,
        recoveredAt,
      );
      assert.equal(inspection?.rejectionClass, null);
      assert.equal(inspection?.operationState, "queued");
      const firstRedrive = await redriveA.claimRedrive(identity);
      assert.equal(firstRedrive.kind, "claimed");
      assert.deepEqual(await redriveB.claimRedrive(identity), {
        kind: "active",
      });
      assert.equal(
        await redriveA.releaseRedrive({
          failureClass: "publication_timeout",
          messageId: identity.messageId,
          now: recoveredAt,
          requestKey,
        }),
        true,
      );
      const secondRedrive = await redriveB.claimRedrive({
        ...identity,
        now: new Date(recoveredAt.getTime() + 1),
      });
      assert.equal(secondRedrive.kind, "claimed");
      if (firstRedrive.kind !== "claimed" || secondRedrive.kind !== "claimed") {
        assert.fail("redrive claim was not returned");
      }
      assert.deepEqual(secondRedrive.envelope, firstRedrive.envelope);
      assert.equal(
        await redriveA.markRedrivePublished({
          messageId: identity.messageId,
          now: new Date(recoveredAt.getTime() + 2),
          requestKey,
        }),
        false,
      );
      assert.equal(
        await redriveB.markRedrivePublished({
          messageId: identity.messageId,
          now: new Date(recoveredAt.getTime() + 2),
          requestKey,
        }),
        true,
      );
      assert.deepEqual(
        await redriveA.claimRedrive({
          ...identity,
          now: new Date(recoveredAt.getTime() + 3),
        }),
        { kind: "published" },
      );

      const audit = await client.query(
        `SELECT event_kind, attempt_number, normalized_failure_class
         FROM rocketmq_redrive_audit
         WHERE message_id = $1
         ORDER BY id`,
        [identity.messageId],
      );
      assert.deepEqual(audit.rows, [
        {
          attempt_number: 0,
          event_kind: "authorized",
          normalized_failure_class: null,
        },
        {
          attempt_number: 1,
          event_kind: "publication_attempted",
          normalized_failure_class: null,
        },
        {
          attempt_number: 1,
          event_kind: "publication_failed",
          normalized_failure_class: "publication_timeout",
        },
        {
          attempt_number: 2,
          event_kind: "publication_attempted",
          normalized_failure_class: null,
        },
        {
          attempt_number: 2,
          event_kind: "published",
          normalized_failure_class: null,
        },
      ]);
      await assert.rejects(
        client.query(
          `UPDATE rocketmq_redrive_audit
           SET event_kind = 'rejected'
           WHERE message_id = $1`,
          [identity.messageId],
        ),
        (error) => error.message === "rocketmq_redrive_audit is append-only",
      );

      await client.query(
        `UPDATE source_document
         SET retention_status = 'tombstoned'
         WHERE id = $1`,
        [ids.document],
      );
      const deleted = await redriveA.inspectRedrive(
        claimB[0].messageId,
        new Date(recoveredAt.getTime() + 4),
      );
      assert.equal(deleted?.rejectionClass, "deleted_scope");
      assert.equal(
        await redriveA.rejectRedrive({
          failureClass: "deleted_scope",
          messageId: claimB[0].messageId,
          now: new Date(recoveredAt.getTime() + 4),
          reasonCode: "provider_recovered",
          requestKey: "91000000-0000-4000-8000-000000000012",
        }),
        true,
      );
    } finally {
      await redriveB?.close();
      await redriveA?.close();
      await redriveClient?.end();
      await apiClient?.end();
      await relayB?.close();
      await relayA?.close();
      await audio?.close();
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
     VALUES ($1, decode('91', 'hex'), decode('92', 'hex'))`,
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
     VALUES ($1, $2, 'owners/rocketmq/source.pdf', 'sha256:rocketmq',
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
     VALUES ($1, $2, $3, 'RocketMQ course', 'ready')`,
    [ids.course, ids.scope, ids.document],
  );
  for (let index = 0; index < ids.chapters.length; index += 1) {
    await client.query(
      `INSERT INTO chapter
         (id, owner_scope_id, course_id, chapter_order, title,
          generation_status)
       VALUES ($1, $2, $3, $4, $5, 'ready')`,
      [
        ids.chapters[index],
        ids.scope,
        ids.course,
        index + 1,
        `Chapter ${index + 1}`,
      ],
    );
    await client.query(
      `INSERT INTO narration_script
         (id, owner_scope_id, course_id, chapter_id, script_text,
          script_sha256, generation_version, model_provenance)
       VALUES ($1, $2, $3, $4, $5, $6,
               'narration-script-v1',
               '{"task":"lesson.audio-script.v1","validationOutcome":"passed"}'::jsonb)`,
      [
        ids.scripts[index],
        ids.scope,
        ids.course,
        ids.chapters[index],
        narration,
        createHash("sha256").update(narration).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO narration_script_source_span
         (owner_scope_id, narration_script_id, source_span_id, span_order)
       VALUES ($1, $2, $3, 0)`,
      [ids.scope, ids.scripts[index], ids.span],
    );
  }
  await client.query("COMMIT");
}
