import type { ModelCallProvenance } from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

export interface DevelopmentSmokeSeed {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly fixtureByteLength: number;
  readonly fixtureSha256: string;
  readonly ingestionOperationId: string;
  readonly membershipId: string;
  readonly sourceDocumentId: string;
  readonly sourceObjectKey: string;
}

export interface DevelopmentNarrationWrite {
  readonly authorization: ScopeAuthorizationContext;
  readonly chapterId: string;
  readonly courseId: string;
  readonly generationVersion: string;
  readonly modelProvenance: ModelCallProvenance;
  readonly narrationScriptId: string;
  readonly scriptSha256: string;
  readonly scriptText: string;
  readonly sourceSpanIds: readonly string[];
}

export interface DevelopmentSmokeSnapshot extends Record<string, unknown> {
  readonly activationArtifactCount: number;
  readonly activationOperationCount: number;
  readonly audioAssetCount: number;
  readonly audioOperationCount: number;
  readonly chapterCount: number;
  readonly conceptCount: number;
  readonly curriculumGenerationCount: number;
  readonly narrationScriptCount: number;
  readonly quizBankCount: number;
  readonly quizItemCount: number;
  readonly sourceSpanCount: number;
}

export interface DevelopmentSmokeArtifactEvidence extends Record<
  string,
  unknown
> {
  readonly assetType: "audio" | "text";
  readonly byteSize: string;
  readonly contentHash: string;
  readonly contentType: string;
  readonly objectKey: string;
}

/** Development-only bootstrap and evidence queries for the local smoke flow. */
export class PostgresDevelopmentSmokeRepository {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(options: {
    readonly connectionString: string;
    readonly environment: "dev";
  }) {
    if (
      options.environment !== "dev" ||
      options.connectionString.length === 0
    ) {
      throw new Error("development smoke persistence requires REFLO_ENV=dev");
    }
    this.#pool = new Pool({ connectionString: options.connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async seed(input: DevelopmentSmokeSeed): Promise<void> {
    validateSeed(input);
    await this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO app_user (id, email_lookup_digest, email_ciphertext)
         VALUES ($1, decode($2, 'hex'), decode($3, 'hex'))
         ON CONFLICT (id) DO NOTHING`,
        [
          input.authorization.actorId,
          input.authorization.actorId.replaceAll("-", ""),
          Buffer.from("synthetic-local-smoke-user", "utf8").toString("hex"),
        ],
      );
      await client.query(
        `INSERT INTO owner_scope (id) VALUES ($1)
         ON CONFLICT (id) DO NOTHING`,
        [input.authorization.ownerScopeId],
      );
      await client.query(
        `INSERT INTO scope_membership (id, owner_scope_id, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner_scope_id, user_id) DO NOTHING`,
        [
          input.membershipId,
          input.authorization.ownerScopeId,
          input.authorization.actorId,
        ],
      );
      await setScopeContext(client, input.authorization);
      await client.query(
        `INSERT INTO source_document
           (id, owner_scope_id, object_key, checksum, media_type,
            byte_size, parse_status)
         VALUES ($1, $2, $3, $4, 'application/pdf', $5, 'queued')
         ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
         WHERE source_document.object_key = EXCLUDED.object_key
           AND source_document.checksum = EXCLUDED.checksum
           AND source_document.media_type = EXCLUDED.media_type
           AND source_document.byte_size = EXCLUDED.byte_size
         RETURNING id`,
        [
          input.sourceDocumentId,
          input.authorization.ownerScopeId,
          input.sourceObjectKey,
          input.fixtureSha256,
          input.fixtureByteLength,
        ],
      );
      await client.query(
        `INSERT INTO course
           (id, owner_scope_id, source_document_id, title, status)
         VALUES ($1, $2, $3, $4, 'generating')
         ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
         WHERE course.source_document_id = EXCLUDED.source_document_id
           AND course.title = EXCLUDED.title
         RETURNING id`,
        [
          input.courseId,
          input.authorization.ownerScopeId,
          input.sourceDocumentId,
          input.courseTitle,
        ],
      );
      await client.query(
        `INSERT INTO async_operation
           (id, owner_scope_id, operation_name, operation_version,
            idempotency_key, state, deadline_at)
         VALUES ($1, $2, 'ingestion.parse', 1, $3, 'queued',
                 now() + interval '1 hour')
         ON CONFLICT (owner_scope_id, id) DO NOTHING`,
        [
          input.ingestionOperationId,
          input.authorization.ownerScopeId,
          `dev/ingestion.parse/v1/${input.sourceDocumentId}`,
        ],
      );
      await client.query(
        `INSERT INTO ingestion_operation
           (operation_id, owner_scope_id, requested_by_user_id,
            source_document_id, input_sha256)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (owner_scope_id, operation_id) DO NOTHING`,
        [
          input.ingestionOperationId,
          input.authorization.ownerScopeId,
          input.authorization.actorId,
          input.sourceDocumentId,
          input.fixtureSha256,
        ],
      );
    });
  }

  async persistNarration(input: DevelopmentNarrationWrite): Promise<void> {
    validateNarration(input);
    await this.#transaction(async (client) => {
      await setScopeContext(client, input.authorization);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO narration_script
           (id, owner_scope_id, course_id, chapter_id, script_text,
            script_sha256, generation_version, model_provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (owner_scope_id, course_id, chapter_id, generation_version)
         DO UPDATE SET id = narration_script.id
         WHERE narration_script.script_sha256 = EXCLUDED.script_sha256
           AND narration_script.model_provenance = EXCLUDED.model_provenance
         RETURNING id`,
        [
          input.narrationScriptId,
          input.authorization.ownerScopeId,
          input.courseId,
          input.chapterId,
          input.scriptText,
          input.scriptSha256,
          input.generationVersion,
          JSON.stringify(input.modelProvenance),
        ],
      );
      const narrationScriptId = inserted.rows[0]?.id;
      if (narrationScriptId === undefined) {
        throw new Error("narration replay conflicts with persisted provenance");
      }
      for (const [spanOrder, sourceSpanId] of input.sourceSpanIds.entries()) {
        await client.query(
          `INSERT INTO narration_script_source_span
             (owner_scope_id, narration_script_id, source_span_id, span_order)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (owner_scope_id, narration_script_id, source_span_id)
           DO UPDATE SET span_order = EXCLUDED.span_order`,
          [
            input.authorization.ownerScopeId,
            narrationScriptId,
            sourceSpanId,
            spanOrder,
          ],
        );
      }
    });
  }

  async snapshot(
    authorization: ScopeAuthorizationContext,
    courseId: string,
    sourceDocumentId: string,
  ): Promise<DevelopmentSmokeSnapshot> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query<DevelopmentSmokeSnapshot>(
        `SELECT
           (SELECT count(*)::integer FROM source_span
             WHERE owner_scope_id = $1 AND source_document_id = $3)
             AS "sourceSpanCount",
           (SELECT count(*)::integer FROM curriculum_generation
             WHERE owner_scope_id = $1 AND course_id = $2)
             AS "curriculumGenerationCount",
           (SELECT count(*)::integer FROM chapter
             WHERE owner_scope_id = $1 AND course_id = $2)
             AS "chapterCount",
           (SELECT count(*)::integer FROM concept
             WHERE owner_scope_id = $1 AND chapter_id IN (
               SELECT id FROM chapter WHERE owner_scope_id = $1 AND course_id = $2
             )) AS "conceptCount",
           (SELECT count(*)::integer FROM activation_generation_operation
             WHERE owner_scope_id = $1 AND course_id = $2)
             AS "activationOperationCount",
           (SELECT count(*)::integer FROM asset
             WHERE owner_scope_id = $1 AND course_id = $2
               AND generation_operation_id IS NOT NULL)
             AS "activationArtifactCount",
           (SELECT count(*)::integer FROM quiz_bank
             WHERE owner_scope_id = $1 AND course_id = $2)
             AS "quizBankCount",
           (SELECT count(*)::integer FROM quiz_item
             WHERE owner_scope_id = $1 AND course_id = $2
               AND quiz_bank_id IS NOT NULL)
             AS "quizItemCount",
           (SELECT count(*)::integer FROM narration_script
             WHERE owner_scope_id = $1 AND course_id = $2)
             AS "narrationScriptCount",
           (SELECT count(*)::integer FROM audio_generation_operation
             WHERE owner_scope_id = $1 AND course_id = $2)
             AS "audioOperationCount",
           (SELECT count(*)::integer FROM asset
             WHERE owner_scope_id = $1 AND course_id = $2
               AND audio_generation_operation_id IS NOT NULL)
             AS "audioAssetCount"`,
        [authorization.ownerScopeId, courseId, sourceDocumentId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("development smoke snapshot is unavailable");
      }
      return row;
    });
  }

  async artifactEvidence(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<readonly DevelopmentSmokeArtifactEvidence[]> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      const result = await client.query<DevelopmentSmokeArtifactEvidence>(
        `SELECT asset_type AS "assetType", byte_size::text AS "byteSize",
                content_hash AS "contentHash", content_type AS "contentType",
                object_key AS "objectKey"
         FROM asset
         WHERE owner_scope_id = $1 AND course_id = $2 AND status = 'ready'
           AND asset_type IN ('text', 'audio')
           AND (
             generation_operation_id IS NOT NULL
             OR audio_generation_operation_id IS NOT NULL
           )
         ORDER BY asset_type, id`,
        [authorization.ownerScopeId, courseId],
      );
      return result.rows;
    });
  }

  async #transaction<Value>(
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function setScopeContext(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
): Promise<void> {
  await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
    authorization.actorId,
  ]);
  await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
    authorization.ownerScopeId,
  ]);
}

function validateSeed(input: DevelopmentSmokeSeed): void {
  const ids = [
    input.authorization.actorId,
    input.authorization.ownerScopeId,
    input.courseId,
    input.ingestionOperationId,
    input.membershipId,
    input.sourceDocumentId,
  ];
  if (
    ids.some((id) => !isUuid(id)) ||
    input.authorization.authorizationId.length < 8 ||
    input.courseTitle.length < 1 ||
    !Number.isSafeInteger(input.fixtureByteLength) ||
    input.fixtureByteLength < 1 ||
    !/^[a-f0-9]{64}$/.test(input.fixtureSha256) ||
    !input.sourceObjectKey.endsWith(".pdf")
  ) {
    throw new Error("invalid development smoke seed");
  }
}

function validateNarration(input: DevelopmentNarrationWrite): void {
  if (
    !isUuid(input.chapterId) ||
    !isUuid(input.courseId) ||
    !isUuid(input.narrationScriptId) ||
    input.scriptText.length < 1 ||
    !/^[a-f0-9]{64}$/.test(input.scriptSha256) ||
    !/^[a-z0-9.-]{3,128}$/.test(input.generationVersion) ||
    input.sourceSpanIds.length < 1 ||
    input.sourceSpanIds.some((id) => !isUuid(id)) ||
    new Set(input.sourceSpanIds).size !== input.sourceSpanIds.length ||
    input.modelProvenance.task !== "lesson.audio-script.v1" ||
    input.modelProvenance.validationOutcome !== "passed" ||
    input.modelProvenance.evidenceClassification !== "development_only"
  ) {
    throw new Error("invalid development narration");
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
}
