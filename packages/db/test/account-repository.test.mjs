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

      const library = await repository.listLibrary(account);
      assert.equal(library.length, 1);
      assert.equal(library[0].courseId, ids.course);
      assert.equal(library[0].sourceDocumentId, ids.document);

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
        calibration: {
          meanAbsoluteError: null,
          sampleSize: null,
          status: "unavailable",
          version: null,
        },
        evidenceCoverage: "0.00000",
        evidenceEligibleConceptCount: 0,
        invalidatedConceptCount: 0,
        mappedConceptCount: 0,
        mappingSetVersion: null,
        objectiveCount: 0,
        objectiveEvidenceCount: 0,
        objectiveMappedCount: 0,
        profileVersion: "exam-readiness-profile-v1",
        reasons: ["blueprint_missing"],
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

test(
  "PostgresAccountRepository gates, records, calibrates, and invalidates exam readiness",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_readiness_${process.pid}_${Date.now()}`;
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
        blueprint: "11000000-0000-4000-8000-000000000001",
        calibration: "11000000-0000-4000-8000-000000000002",
        chapter: "12000000-0000-4000-8000-000000000001",
        conceptA: "13000000-0000-4000-8000-000000000001",
        conceptB: "13000000-0000-4000-8000-000000000002",
        conceptC: "13000000-0000-4000-8000-000000000003",
        conceptD: "13000000-0000-4000-8000-000000000004",
        conceptUnmapped: "13000000-0000-4000-8000-000000000005",
        course: "14000000-0000-4000-8000-000000000001",
        document: "15000000-0000-4000-8000-000000000001",
        embedding: "16000000-0000-4000-8000-000000000001",
        generation: "17000000-0000-4000-8000-000000000001",
        mappingSet: "18000000-0000-4000-8000-000000000001",
        member: "19000000-0000-4000-8000-000000000001",
        objectiveA: "21000000-0000-4000-8000-000000000001",
        objectiveB: "21000000-0000-4000-8000-000000000002",
        scope: "22000000-0000-4000-8000-000000000001",
        user: "23000000-0000-4000-8000-000000000001",
      };

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO exam_blueprint
           (id, version, name, objective_count, source_provenance, published_at)
         VALUES ($1, 'blueprint-v1', 'Cloud exam', 2,
                 '{"source":"reviewed-objectives"}',
                 '2026-07-27T12:00:00Z')`,
        [ids.blueprint],
      );
      await client.query(
        `INSERT INTO exam_blueprint_objective
           (blueprint_id, blueprint_version, id, objective_key, title,
            weight, source_provenance)
         VALUES
           ($1, 'blueprint-v1', $2, 'networking', 'Networking', 0.60000,
            '{"source":"objective-a"}'),
           ($1, 'blueprint-v1', $3, 'security', 'Security', 0.40000,
            '{"source":"objective-b"}')`,
        [ids.blueprint, ids.objectiveA, ids.objectiveB],
      );
      await client.query("COMMIT");

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
         VALUES ($1, decode('31', 'hex'), decode('41', 'hex'))`,
        [ids.user],
      );
      await client.query("INSERT INTO owner_scope (id) VALUES ($1)", [
        ids.scope,
      ]);
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
         VALUES ($1, $2, 'owners/readiness/source', 'sha256:readiness',
                 'application/pdf', 10, 'parsed')`,
        [ids.document, ids.scope],
      );
      await client.query(
        `INSERT INTO course
           (id, owner_scope_id, source_document_id, title, status,
            target_exam_blueprint_id)
         VALUES ($1, $2, $3, 'Readiness fixture', 'ready', $4)`,
        [ids.course, ids.scope, ids.document, ids.blueprint],
      );
      await client.query(
        `INSERT INTO source_embedding_generation
           (id, owner_scope_id, source_document_id, profile_version,
            dimensions, input_mode, adapter_version, effective_model,
            effective_model_version, provider_identifier,
            provider_request_ids, region, endpoint, span_count, status,
            activated_at)
         VALUES ($1, $2, $3, 'embedding-v1', 1024, 'document',
                 'adapter-v1', 'model', 'model-v1', 'provider',
                 '[]', 'local', 'local', 1, 'active',
                 '2026-07-27T12:00:00Z')`,
        [ids.embedding, ids.scope, ids.document],
      );
      await client.query(
        `INSERT INTO curriculum_generation
           (id, owner_scope_id, course_id, source_document_id,
            embedding_generation_id, generation_version, result_hash,
            model_provenance, structure, status, activated_at)
         VALUES ($1, $2, $3, $4, $5, 'curriculum-v1', repeat('a', 64),
                 '{"route":"fixture"}', '{"chapters":1}', 'active',
                 '2026-07-27T12:01:00Z')`,
        [ids.generation, ids.scope, ids.course, ids.document, ids.embedding],
      );
      await client.query(
        `UPDATE course SET active_curriculum_generation_id = $1
         WHERE id = $2`,
        [ids.generation, ids.course],
      );
      await client.query(
        `INSERT INTO chapter
           (id, owner_scope_id, course_id, chapter_order, title,
            curriculum_generation_id)
         VALUES ($1, $2, $3, 1, 'Exam concepts', $4)`,
        [ids.chapter, ids.scope, ids.course, ids.generation],
      );
      await client.query(
        `INSERT INTO concept
           (id, owner_scope_id, chapter_id, name, generation_version,
            curriculum_generation_id, concept_key, concept_order)
         VALUES
           ($1, $6, $7, 'A', 'curriculum-v1', $8, 'a', 0),
           ($2, $6, $7, 'B', 'curriculum-v1', $8, 'b', 1),
           ($3, $6, $7, 'C', 'curriculum-v1', $8, 'c', 2),
           ($4, $6, $7, 'D', 'curriculum-v1', $8, 'd', 3),
           ($5, $6, $7, 'Unmapped', 'curriculum-v1', $8, 'unmapped', 4)`,
        [
          ids.conceptA,
          ids.conceptB,
          ids.conceptC,
          ids.conceptD,
          ids.conceptUnmapped,
          ids.scope,
          ids.chapter,
          ids.generation,
        ],
      );
      await client.query(
        `INSERT INTO knowledge_state
           (owner_scope_id, user_id, concept_id, mastery, confidence,
            last_reviewed_at, review_count, algorithm_version, alpha_quanta,
            beta_quanta, evidence_count, assessment_status,
            knowledge_configuration_id)
         VALUES
           ($1, $2, $3, 0.75000, 0.66667, '2026-07-27T12:10:00Z', 8,
            'knowledge-model-v1', 900000, 300000, 8, 'assessed',
            'beta-1-3-unit-mass-score-5dp-v1'),
           ($1, $2, $4, 0.25000, 0.33333, '2026-07-27T12:11:00Z', 2,
            'knowledge-model-v1', 150000, 450000, 2, 'assessed',
            'beta-1-3-unit-mass-score-5dp-v1'),
           ($1, $2, $5, 0.50000, 0.50000, '2026-07-27T12:12:00Z', 4,
            'knowledge-model-v1', 400000, 400000, 4, 'assessed',
            'beta-1-3-unit-mass-score-5dp-v1'),
           ($1, $2, $6, 0.40000, 0.20000, '2026-07-27T12:13:00Z', 1,
            'knowledge-model-v1', 200000, 300000, 1, 'assessed',
            'beta-1-3-unit-mass-score-5dp-v1')`,
        [
          ids.scope,
          ids.user,
          ids.conceptA,
          ids.conceptB,
          ids.conceptC,
          ids.conceptD,
        ],
      );
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO exam_readiness_mapping_set
           (owner_scope_id, id, course_id, blueprint_id, blueprint_version,
            mapping_set_version, mapping_count, readiness_profile_version,
            knowledge_algorithm_version, reviewer_provenance, reviewed_at)
         VALUES ($1, $2, $3, $4, 'blueprint-v1', 'mapping-v1', 4,
                 'exam-readiness-profile-v1', 'knowledge-model-v1',
                 '{"reviewer":"staff-fixture"}',
                 '2026-07-27T12:20:00Z')`,
        [ids.scope, ids.mappingSet, ids.course, ids.blueprint],
      );
      await client.query(
        `INSERT INTO exam_readiness_mapping
           (owner_scope_id, mapping_set_id, course_id, blueprint_id,
            objective_id, concept_id, concept_generation_id,
            concept_generation_version, mapping_weight, source_provenance,
            reviewer_provenance)
         VALUES
           ($1, $2, $3, $4, $5, $7, $11, 'curriculum-v1', 0.80000,
            '{"span":"a"}', '{"reviewer":"staff-fixture"}'),
           ($1, $2, $3, $4, $5, $8, $11, 'curriculum-v1', 0.20000,
            '{"span":"b"}', '{"reviewer":"staff-fixture"}'),
           ($1, $2, $3, $4, $6, $9, $11, 'curriculum-v1', 0.50000,
            '{"span":"c"}', '{"reviewer":"staff-fixture"}'),
           ($1, $2, $3, $4, $6, $10, $11, 'curriculum-v1', 0.50000,
            '{"span":"d"}', '{"reviewer":"staff-fixture"}')`,
        [
          ids.scope,
          ids.mappingSet,
          ids.course,
          ids.blueprint,
          ids.objectiveA,
          ids.objectiveB,
          ids.conceptA,
          ids.conceptB,
          ids.conceptC,
          ids.conceptD,
          ids.generation,
        ],
      );
      await client.query("COMMIT");

      repository = new PostgresAccountRepository(databaseUrl.toString());
      const account = {
        absoluteExpiresAt: new Date("2026-08-27T00:00:00Z"),
        authenticatedAt: new Date("2026-07-27T12:00:00Z"),
        idleExpiresAt: new Date("2026-08-03T00:00:00Z"),
        ownerScopeId: ids.scope,
        sessionId: "24000000-0000-4000-8000-000000000001",
        userId: ids.user,
      };
      const experimental = await repository.getCourseProgress(
        account,
        ids.course,
      );
      assert.deepEqual(experimental.readiness, {
        blueprintVersion: "blueprint-v1",
        calibration: {
          meanAbsoluteError: null,
          sampleSize: null,
          status: "unavailable",
          version: null,
        },
        evidenceCoverage: "0.80000",
        evidenceEligibleConceptCount: 3,
        experimental: true,
        invalidatedConceptCount: 0,
        label: "Exam Readiness — Experimental",
        mappedConceptCount: 4,
        mappingSetVersion: "mapping-v1",
        objectiveCount: 2,
        objectiveEvidenceCount: 2,
        objectiveMappedCount: 2,
        profileVersion: "exam-readiness-profile-v1",
        reasons: [],
        score: "0.59000",
        status: "eligible",
        targetBlueprintId: ids.blueprint,
        unmappedConceptCount: 1,
      });
      assert.equal(
        experimental.chapters[0].concepts.filter(
          (concept) => concept.mappingStatus === "mapped",
        ).length,
        4,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM exam_readiness_score",
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (
          await client.query(
            `SELECT input_snapshot ->> 'activeCurriculumGenerationId'
                     AS generation_id
             FROM exam_readiness_score`,
          )
        ).rows[0].generation_id,
        ids.generation,
      );
      await repository.getCourseProgress(account, ids.course);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM exam_readiness_score",
          )
        ).rows[0].count,
        1,
      );

      await client.query(
        `INSERT INTO exam_readiness_calibration
           (id, blueprint_id, blueprint_version, version, sample_size,
            mean_absolute_error, representative, evidence_provenance,
            frozen_at)
         VALUES ($1, $2, 'blueprint-v1', 'calibration-v1', 100, 0.10000,
                 true, '{"dataset":"rights-cleared-fixture"}',
                 '2026-07-27T13:00:00Z')`,
        [ids.calibration, ids.blueprint],
      );
      const calibrated = await repository.getCourseProgress(
        account,
        ids.course,
      );
      assert.deepEqual(calibrated.readiness.calibration, {
        meanAbsoluteError: "0.10000",
        sampleSize: 100,
        status: "adequate",
        version: "calibration-v1",
      });
      assert.equal(calibrated.readiness.experimental, false);
      assert.equal(calibrated.readiness.label, "Exam Readiness");
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM exam_readiness_score",
          )
        ).rows[0].count,
        2,
      );
      await assert.rejects(
        client.query(
          "UPDATE exam_blueprint SET name = 'Mutated' WHERE id = $1",
          [ids.blueprint],
        ),
        { code: "55000" },
      );
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO exam_blueprint_objective
           (blueprint_id, blueprint_version, id, objective_key, title,
            weight, source_provenance)
         VALUES ($1, 'blueprint-v1',
                 '24000000-0000-4000-8000-000000000002', 'late', 'Late',
                 0.00000, '{"source":"late"}')`,
        [ids.blueprint],
      );
      await assert.rejects(client.query("COMMIT"), { code: "23514" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO exam_readiness_mapping
           (owner_scope_id, mapping_set_id, course_id, blueprint_id,
            objective_id, concept_id, concept_generation_id,
            concept_generation_version, mapping_weight, source_provenance,
            reviewer_provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'curriculum-v1', 0.00000,
                 '{"span":"late"}', '{"reviewer":"staff-fixture"}')`,
        [
          ids.scope,
          ids.mappingSet,
          ids.course,
          ids.blueprint,
          ids.objectiveA,
          ids.conceptUnmapped,
          ids.generation,
        ],
      );
      await assert.rejects(client.query("COMMIT"), { code: "23514" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO exam_blueprint
           (id, version, name, objective_count, source_provenance, published_at)
         VALUES ('25000000-0000-4000-8000-000000000001', 'bad-v1',
                 'Invalid fixture', 2, '{"source":"fixture"}',
                 '2026-07-27T14:00:00Z')`,
      );
      await client.query(
        `INSERT INTO exam_blueprint_objective
           (blueprint_id, blueprint_version, id, objective_key, title,
            weight, source_provenance)
         VALUES
           ('25000000-0000-4000-8000-000000000001', 'bad-v1',
            '25000000-0000-4000-8000-000000000002', 'a', 'A', 0.40000,
            '{"source":"fixture"}'),
           ('25000000-0000-4000-8000-000000000001', 'bad-v1',
            '25000000-0000-4000-8000-000000000003', 'b', 'B', 0.40000,
            '{"source":"fixture"}')`,
      );
      await assert.rejects(client.query("COMMIT"), { code: "23514" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO exam_readiness_mapping_set
           (owner_scope_id, id, course_id, blueprint_id, blueprint_version,
            mapping_set_version, mapping_count, readiness_profile_version,
            knowledge_algorithm_version, reviewer_provenance, reviewed_at)
         VALUES ($1, '26000000-0000-4000-8000-000000000001', $2, $3,
                 'blueprint-v1', 'mapping-invalid',
                 1,
                 'exam-readiness-profile-v1', 'knowledge-model-v1',
                 '{"reviewer":"staff-fixture"}',
                 '2026-07-27T14:00:00Z')`,
        [ids.scope, ids.course, ids.blueprint],
      );
      await client.query(
        `INSERT INTO exam_readiness_mapping
           (owner_scope_id, mapping_set_id, course_id, blueprint_id,
            objective_id, concept_id, concept_generation_id,
            concept_generation_version, mapping_weight, source_provenance,
            reviewer_provenance)
         VALUES ($1, '26000000-0000-4000-8000-000000000001', $2, $3, $4,
                 $5, $6, 'curriculum-v1', 0.90000, '{"span":"a"}',
                 '{"reviewer":"staff-fixture"}')`,
        [
          ids.scope,
          ids.course,
          ids.blueprint,
          ids.objectiveA,
          ids.conceptA,
          ids.generation,
        ],
      );
      await assert.rejects(client.query("COMMIT"), { code: "23514" });
      await client.query("ROLLBACK");

      await client.query(
        `INSERT INTO curriculum_generation
           (id, owner_scope_id, course_id, source_document_id,
            embedding_generation_id, generation_version, result_hash,
            model_provenance, structure, status, activated_at)
         VALUES ('27000000-0000-4000-8000-000000000001', $1, $2, $3, $4,
                 'curriculum-v1', repeat('b', 64), '{"route":"fixture"}',
                 '{"chapters":1}', 'active', '2026-07-27T15:00:00Z')`,
        [ids.scope, ids.course, ids.document, ids.embedding],
      );
      await client.query(
        `UPDATE course
         SET active_curriculum_generation_id =
               '27000000-0000-4000-8000-000000000001'
         WHERE id = $1`,
        [ids.course],
      );
      await client.query(
        `INSERT INTO chapter
           (id, owner_scope_id, course_id, chapter_order, title,
            curriculum_generation_id)
         VALUES ('27000000-0000-4000-8000-000000000002', $1, $2, 1,
                 'Regenerated concepts',
                 '27000000-0000-4000-8000-000000000001')`,
        [ids.scope, ids.course],
      );
      await client.query(
        `INSERT INTO concept
           (id, owner_scope_id, chapter_id, name, generation_version,
            curriculum_generation_id, concept_key, concept_order)
         VALUES ('27000000-0000-4000-8000-000000000003', $1,
                 '27000000-0000-4000-8000-000000000002', 'Regenerated A',
                 'curriculum-v1',
                 '27000000-0000-4000-8000-000000000001', 'a', 0)`,
        [ids.scope],
      );
      const invalidated = await repository.getCourseProgress(
        account,
        ids.course,
      );
      assert.deepEqual(invalidated.readiness, {
        blueprintVersion: "blueprint-v1",
        calibration: {
          meanAbsoluteError: "0.10000",
          sampleSize: 100,
          status: "adequate",
          version: "calibration-v1",
        },
        evidenceCoverage: "0.00000",
        evidenceEligibleConceptCount: 0,
        invalidatedConceptCount: 4,
        mappedConceptCount: 0,
        mappingSetVersion: "mapping-v1",
        objectiveCount: 2,
        objectiveEvidenceCount: 0,
        objectiveMappedCount: 0,
        profileVersion: "exam-readiness-profile-v1",
        reasons: [
          "objective_mapping_incomplete",
          "objective_evidence_missing",
          "evidence_coverage_insufficient",
        ],
        score: null,
        status: "unavailable",
        targetBlueprintId: ids.blueprint,
        unmappedConceptCount: 1,
      });
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM exam_readiness_score",
          )
        ).rows[0].count,
        2,
      );
    } finally {
      await repository?.close().catch(() => undefined);
      await client?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  },
);
