import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  canonicalJson,
  composeCurriculum,
  partitionCurriculumSource,
  sha256,
} from "@reflo/retrieval";
import { PostgresContentRepository } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  typeof baseDatabaseUrl === "string" && baseDatabaseUrl.length > 0;

const ids = {
  course: "82000000-0000-4000-8000-000000000001",
  document: "82000000-0000-4000-8000-000000000002",
  embedding: "82000000-0000-5000-8000-000000000003",
  foreignMember: "82000000-0000-4000-8000-000000000004",
  foreignScope: "82000000-0000-4000-8000-000000000005",
  foreignUser: "82000000-0000-4000-8000-000000000006",
  member: "82000000-0000-4000-8000-000000000007",
  scope: "82000000-0000-4000-8000-000000000008",
  spanA: "82000000-0000-5000-8000-000000000009",
  spanB: "82000000-0000-5000-8000-00000000000a",
  user: "82000000-0000-4000-8000-00000000000b",
};

const access = {
  actorId: ids.user,
  authorizationId: "bounded-curriculum-db-test",
  courseId: ids.course,
  courseTitle: "Bounded Course",
  ownerScopeId: ids.scope,
  sourceDocumentId: ids.document,
};
const spans = [
  sourceSpan(ids.spanA, 0, ["One"], "First grounded section."),
  sourceSpan(ids.spanB, 1, ["Two"], "Second grounded section."),
];

test(
  "PostgresContentRepository durably recovers bounded curriculum children and activates only a complete owner-scoped generation",
  { skip: enabled ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const databaseName = `reflo_content_${process.pid}_${Date.now()}`;
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
      await seedFixture(client);
      repository = new PostgresContentRepository(databaseUrl.toString(), {
        environment: "dev",
      });

      const manifest = partitionCurriculumSource(access, ids.embedding, spans);
      await repository.persistCurriculumPartition(access, manifest);
      const [firstSegment, secondSegment] = manifest.segments;
      assert.ok(firstSegment);
      assert.ok(secondSegment);

      const firstClaim = await repository.claimCurriculumSegment(
        access,
        manifest.parentGenerationId,
        firstSegment,
      );
      assert.deepEqual(firstClaim, { attemptCount: 1, kind: "claimed" });
      assert.deepEqual(
        await repository.claimCurriculumSegment(
          access,
          manifest.parentGenerationId,
          firstSegment,
        ),
        { kind: "active" },
      );
      await repository.failCurriculumSegment(access, {
        attemptCount: 1,
        failureClass: "adapter_unavailable",
        inputHash: firstSegment.inputHash,
        parentGenerationId: manifest.parentGenerationId,
        retryable: true,
        segmentId: firstSegment.id,
      });
      const recoveredClaim = await repository.claimCurriculumSegment(
        access,
        manifest.parentGenerationId,
        firstSegment,
      );
      assert.deepEqual(recoveredClaim, { attemptCount: 2, kind: "claimed" });

      const first = completion(firstSegment, 2);
      await repository.completeCurriculumSegment(access, first);
      const secondClaim = await repository.claimCurriculumSegment(
        access,
        manifest.parentGenerationId,
        secondSegment,
      );
      assert.deepEqual(secondClaim, { attemptCount: 1, kind: "claimed" });
      const second = completion(secondSegment, 1);
      await repository.completeCurriculumSegment(access, second);

      await repository.close();
      repository = new PostgresContentRepository(databaseUrl.toString(), {
        environment: "dev",
      });
      const replay = await repository.claimCurriculumSegment(
        access,
        manifest.parentGenerationId,
        firstSegment,
      );
      assert.equal(replay.kind, "completed");
      assert.equal(replay.persisted.attemptCount, 2);
      await assert.rejects(
        repository.claimCurriculumSegment(
          {
            ...access,
            actorId: ids.foreignUser,
            authorizationId: "foreign-bounded-curriculum-test",
            ownerScopeId: ids.foreignScope,
          },
          manifest.parentGenerationId,
          firstSegment,
        ),
        (error) => error?.code === "authorization_denied",
      );

      const composed = composeCurriculum(manifest, access.courseTitle, spans, [
        first,
        second,
      ]);
      const outline = await repository.persistCurriculum(
        access,
        {
          courseId: access.courseId,
          embeddingGenerationId: ids.embedding,
          generationId: manifest.parentGenerationId,
          modelProvenance: composed.modelProvenance,
          ownerScopeId: access.ownerScopeId,
          resultHash: sha256(canonicalJson(composed.result)),
          sourceDocumentId: access.sourceDocumentId,
          structure: composed.result,
          version: "curriculum-v2",
        },
        10_000,
      );
      assert.equal(outline.status, "ready");
      assert.equal(outline.chapters.length, 2);

      const persisted = await client.query(
        `SELECT course.status, generation.generation_version,
                array_agg(segment.attempt_count
                  ORDER BY segment.segment_ordinal) AS attempt_counts
         FROM course
         JOIN curriculum_generation AS generation
           ON generation.owner_scope_id = course.owner_scope_id
          AND generation.id = course.active_curriculum_generation_id
         JOIN curriculum_segment_operation AS segment
           ON segment.owner_scope_id = generation.owner_scope_id
          AND segment.parent_generation_id = generation.id
         WHERE course.owner_scope_id = $1 AND course.id = $2
         GROUP BY course.id, generation.id`,
        [ids.scope, ids.course],
      );
      assert.deepEqual(persisted.rows, [
        {
          attempt_counts: [2, 1],
          generation_version: "curriculum-v2",
          status: "ready",
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

function completion(segment, attemptCount) {
  const result = {
    chapters: [
      {
        concepts: [
          {
            key: `concept-${segment.ordinal}`,
            name: `Concept ${segment.ordinal + 1}`,
            prerequisiteKeys: [],
            sourceSpanIds: [...segment.sourceSpanIds],
          },
        ],
        sourceSpanIds: [...segment.sourceSpanIds],
        title: `Section ${segment.ordinal + 1}`,
      },
    ],
    kind: "instructional",
    segmentId: segment.id,
    segmentOrdinal: segment.ordinal,
  };
  return {
    attemptCount,
    inputHash: segment.inputHash,
    modelProvenance: {
      adapterVersion: "test-adapter-v1",
      evidenceClassification: "development_only",
      effectiveModel: "test-model",
      effectiveModelVersion: "test-model-v1",
      inputSchemaVersion: "curriculum-segment-input-v1",
      requestedSelector: "configured/test-model",
      resultSchemaVersion: "curriculum-segment-result-v1",
      routePolicyVersion: "route-policy-v5",
      task: "curriculum.segment.v1",
      validationOutcome: "passed",
    },
    parentGenerationId: segment.parentGenerationId,
    result,
    resultHash: sha256(canonicalJson(result)),
    segmentId: segment.id,
  };
}

function sourceSpan(id, chunkOrder, sectionPath, canonicalText) {
  const embeddingInput = `[Section: ${sectionPath.join(" > ")}] ${canonicalText}`;
  return {
    canonicalEnd: canonicalText.length,
    canonicalStart: 0,
    canonicalText,
    chunkOrder,
    chunkerVersion: "chunk-v1",
    contractVersion: "source-span-v1",
    embeddingInput,
    embeddingInputHash: sha256(embeddingInput),
    embeddingInputProfileVersion: "embedding-input-v1",
    id,
    mappings: [],
    ownerScopeId: ids.scope,
    pageEnd: 1,
    pageStart: 1,
    parserVersion: "parser-v1",
    sectionPath,
    sourceDocumentId: ids.document,
    textHash: sha256(canonicalText),
    tokenizerVersion: "reflo-unicode-tokenizer-v1",
  };
}

async function seedFixture(client) {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
     VALUES ($1, decode('01', 'hex'), decode('11', 'hex')),
            ($2, decode('02', 'hex'), decode('12', 'hex'))`,
    [ids.user, ids.foreignUser],
  );
  await client.query("INSERT INTO owner_scope (id) VALUES ($1), ($2)", [
    ids.scope,
    ids.foreignScope,
  ]);
  await client.query(
    `INSERT INTO scope_membership (id, owner_scope_id, user_id)
     VALUES ($1, $2, $3), ($4, $5, $6)`,
    [
      ids.member,
      ids.scope,
      ids.user,
      ids.foreignMember,
      ids.foreignScope,
      ids.foreignUser,
    ],
  );
  await client.query("COMMIT");
  await client.query(
    `INSERT INTO source_document
       (id, owner_scope_id, object_key, checksum, media_type, byte_size,
        parse_status)
     VALUES ($1, $2, $3, 'sha256:bounded', 'application/pdf', 100, 'parsed')`,
    [ids.document, ids.scope, `owners/${ids.scope}/source.pdf`],
  );
  await client.query(
    `INSERT INTO course
       (id, owner_scope_id, source_document_id, title, status)
     VALUES ($1, $2, $3, $4, 'generating')`,
    [ids.course, ids.scope, ids.document, access.courseTitle],
  );
  for (const span of spans) {
    await client.query(
      `INSERT INTO source_span
         (id, owner_scope_id, source_document_id, canonical_text, text_hash,
          page_start, page_end, section_path, canonical_start, canonical_end,
          parser_version, chunker_version, tokenizer_version, contract_version,
          chunk_order, native_mappings, embedding_input, embedding_input_hash,
          embedding_input_profile_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16::jsonb, $17, $18, $19)`,
      [
        span.id,
        span.ownerScopeId,
        span.sourceDocumentId,
        span.canonicalText,
        span.textHash,
        span.pageStart,
        span.pageEnd,
        span.sectionPath,
        span.canonicalStart,
        span.canonicalEnd,
        span.parserVersion,
        span.chunkerVersion,
        span.tokenizerVersion,
        span.contractVersion,
        span.chunkOrder,
        JSON.stringify(span.mappings),
        span.embeddingInput,
        span.embeddingInputHash,
        span.embeddingInputProfileVersion,
      ],
    );
  }
  await client.query(
    `INSERT INTO source_embedding_generation
       (id, owner_scope_id, source_document_id, profile_version, dimensions,
        input_mode, adapter_version, effective_model, effective_model_version,
        provider_identifier, provider_request_ids, region, endpoint, span_count,
        status, activated_at)
     VALUES ($1, $2, $3, 'embedding-v1', 1024, 'document', 'adapter-v1',
             'embedding-model', 'embedding-model-v1', 'test-provider',
             '["embedding-request"]'::jsonb, 'local', 'http://local.invalid',
             2, 'active', clock_timestamp())`,
    [ids.embedding, ids.scope, ids.document],
  );
  for (const [spanOrder, span] of spans.entries()) {
    await client.query(
      `INSERT INTO source_embedding_generation_span
         (owner_scope_id, embedding_generation_id, source_span_id, span_order,
          embedding_input_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [ids.scope, ids.embedding, span.id, spanOrder, span.embeddingInputHash],
    );
  }
  await client.query(
    `UPDATE source_document SET active_embedding_generation_id = $1
     WHERE owner_scope_id = $2 AND id = $3`,
    [ids.embedding, ids.scope, ids.document],
  );
}
