import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { PostgresAccountRepository } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

test(
  "PostgresAccountRepository reserves free email capacity atomically",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_account_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: baseDatabaseUrl });
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
      repository = new PostgresAccountRepository(databaseUrl.toString());

      const firstDay = new Date("2026-07-20T23:59:00.000Z");
      const firstResults = await Promise.all(
        Array.from({ length: 6 }, () =>
          repository.reserveMagicLinkDelivery(firstDay, 2, 3),
        ),
      );
      assert.equal(firstResults.filter(Boolean).length, 2);

      const secondDay = new Date("2026-07-22T00:01:00.000Z");
      const secondResults = await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.reserveMagicLinkDelivery(secondDay, 2, 3),
        ),
      );
      assert.equal(secondResults.filter(Boolean).length, 1);
    } finally {
      await repository?.close();
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

test(
  "PostgresAccountRepository projects eligible mastery without inventing readiness",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_progress_${process.pid}_${Date.now()}`;
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
      const ids = {
        chapter: "10000000-0000-4000-8000-000000000001",
        conceptA: "20000000-0000-4000-8000-000000000001",
        conceptB: "20000000-0000-4000-8000-000000000002",
        conceptUnassessed: "20000000-0000-4000-8000-000000000003",
        course: "30000000-0000-4000-8000-000000000001",
        document: "40000000-0000-4000-8000-000000000001",
        member: "50000000-0000-4000-8000-000000000001",
        otherCourse: "30000000-0000-4000-8000-000000000002",
        otherDocument: "40000000-0000-4000-8000-000000000002",
        otherMember: "50000000-0000-4000-8000-000000000002",
        otherScope: "60000000-0000-4000-8000-000000000002",
        otherUser: "70000000-0000-4000-8000-000000000002",
        scope: "60000000-0000-4000-8000-000000000001",
        session: "80000000-0000-4000-8000-000000000001",
        user: "70000000-0000-4000-8000-000000000001",
      };
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
      await client.query(
        `INSERT INTO source_document
           (id, owner_scope_id, object_key, checksum, media_type, byte_size,
            parse_status)
         VALUES
           ($1, $2, 'owners/progress/source', 'sha256:progress',
            'application/pdf', 10, 'parsed'),
           ($3, $4, 'owners/other/source', 'sha256:other',
            'application/pdf', 10, 'parsed')`,
        [ids.document, ids.scope, ids.otherDocument, ids.otherScope],
      );
      await client.query(
        `INSERT INTO course
           (id, owner_scope_id, source_document_id, title, status)
         VALUES ($1, $2, $3, 'Progress fixture', 'ready'),
                ($4, $5, $6, 'Other fixture', 'ready')`,
        [
          ids.course,
          ids.scope,
          ids.document,
          ids.otherCourse,
          ids.otherScope,
          ids.otherDocument,
        ],
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
         VALUES ($1, $2, $3, 'Virtual networks', 'curriculum-v1', 0),
                ($4, $2, $3, 'Routing', 'curriculum-v1', 1),
                ($5, $2, $3, 'Gateways', 'curriculum-v1', 2)`,
        [
          ids.conceptA,
          ids.scope,
          ids.chapter,
          ids.conceptB,
          ids.conceptUnassessed,
        ],
      );
      await client.query(
        `INSERT INTO knowledge_state
           (owner_scope_id, user_id, concept_id, mastery, confidence,
            last_reviewed_at, review_count, algorithm_version, alpha_quanta,
            beta_quanta, evidence_count, assessment_status,
            knowledge_configuration_id)
         VALUES
           ($1, $2, $3, 0.40000, 0.20000, '2026-07-24T10:00:00Z', 1,
            'knowledge-model-v1', 200000, 300000, 1, 'assessed',
            'beta-1-3-unit-mass-score-5dp-v1'),
           ($1, $2, $4, 0.20000, 0.20000, '2026-07-24T10:01:00Z', 1,
            'knowledge-model-v1', 100000, 400000, 1, 'assessed',
            'beta-1-3-unit-mass-score-5dp-v1')`,
        [ids.scope, ids.user, ids.conceptA, ids.conceptB],
      );
      await client.query(
        `INSERT INTO study_session
           (id, owner_scope_id, user_id, course_id, status, summary,
            started_at, ended_at)
         VALUES (
           $1, $2, $3, $4, 'completed',
           jsonb_build_object(
             'flowB',
             jsonb_build_object(
               $5::text,
               jsonb_build_object(
                 'completedAt', '2026-07-24T10:02:00.000Z',
                 'conceptId', $5::text,
                 'evidenceAttemptId', '90000000-0000-4000-8000-000000000001',
                 'finalMastery', '0.40000',
                 'initialMastery', '0.20000',
                 'masteryDelta', '0.20000',
                 'outcome', 'retest_succeeded',
                 'replacementCount', 1
               )
             )
           ),
           '2026-07-24T09:55:00Z', '2026-07-24T10:03:00Z'
         )`,
        [ids.session, ids.scope, ids.user, ids.course, ids.conceptA],
      );
      repository = new PostgresAccountRepository(databaseUrl.toString());
      const account = {
        absoluteExpiresAt: new Date("2026-08-24T00:00:00Z"),
        authenticatedAt: new Date("2026-07-24T09:00:00Z"),
        idleExpiresAt: new Date("2026-07-31T00:00:00Z"),
        ownerScopeId: ids.scope,
        sessionId: "90000000-0000-4000-8000-000000000099",
        userId: ids.user,
      };

      const progress = await repository.getCourseProgress(account, ids.course);

      assert.equal(progress.courseId, ids.course);
      assert.deepEqual(progress.mastery, {
        assessedConceptCount: 2,
        kind: "course_mastery_estimate",
        label: "Course Mastery Estimate",
        totalConceptCount: 3,
        value: "0.30000",
      });
      assert.equal(
        progress.chapters[0].concepts[2].assessmentStatus,
        "unassessed",
      );
      assert.equal(progress.chapters[0].concepts[2].mastery, null);
      assert.equal(
        progress.chapters[0].concepts[0].review.state,
        "not_scheduled",
      );
      assert.deepEqual(progress.readiness, {
        blueprintVersion: null,
        invalidatedConceptCount: 0,
        mappedConceptCount: 0,
        reasons: [
          "blueprint_missing",
          "evidence_minimum_not_met",
          "calibration_unavailable",
        ],
        score: null,
        status: "unavailable",
        targetBlueprintId: null,
        unmappedConceptCount: 3,
      });
      assert.deepEqual(progress.recentSessionDeltas, [
        {
          completedAt: new Date("2026-07-24T10:02:00.000Z"),
          conceptId: ids.conceptA,
          conceptName: "Virtual networks",
          finalMastery: "0.40000",
          initialMastery: "0.20000",
          masteryDelta: "0.20000",
          outcome: "retest_succeeded",
          sessionId: ids.session,
        },
      ]);
      assert.equal(
        await repository.getCourseProgress(account, ids.otherCourse),
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
