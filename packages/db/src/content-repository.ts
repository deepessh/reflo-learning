import {
  RetrievalError,
  materializeCurriculumOutline,
  type AuthorizedSourceAccess,
  type ContentRepositoryPort,
  type CurriculumGenerationRecord,
  type CurriculumOutline,
  type EmbeddingGenerationRecord,
  type RetrievedSourceSpan,
  type ScopeAuthorizationContext,
  type SourceSpanRecord,
} from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

interface AuthorizedRow extends Record<string, unknown> {
  course_id: string;
  course_title: string;
  owner_scope_id: string;
  source_document_id: string;
}

interface ResolvedSpanRow extends Record<string, unknown> {
  canonical_text: string;
  id: string;
  section_path: string[];
}

export class PostgresContentRepository implements ContentRepositoryPort {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new RetrievalError("invalid_configuration");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async authorizeSource(
    context: ScopeAuthorizationContext,
    sourceDocumentId: string,
    courseId: string,
  ): Promise<AuthorizedSourceAccess | null> {
    validateContext(context);
    validateUuid(sourceDocumentId);
    validateUuid(courseId);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await setScopeContext(client, context.actorId, context.ownerScopeId);
      const result = await client.query<AuthorizedRow>(
        `SELECT course.id AS course_id, course.title AS course_title,
                course.owner_scope_id, source.id AS source_document_id
         FROM course
         JOIN source_document AS source
           ON source.owner_scope_id = course.owner_scope_id
          AND source.id = course.source_document_id
         JOIN owner_scope AS scope ON scope.id = course.owner_scope_id
         JOIN app_user AS actor ON actor.id = $1
         JOIN scope_membership AS membership
           ON membership.owner_scope_id = course.owner_scope_id
          AND membership.user_id = actor.id
         WHERE course.owner_scope_id = $2
           AND course.id = $3
           AND source.id = $4
           AND course.status IN ('generating', 'ready')
           AND source.parse_status = 'parsed'
           AND source.retention_status = 'active'
           AND scope.status = 'active'
           AND actor.status = 'active'
           AND membership.role = 'owner'
           AND membership.revoked_at IS NULL
         FOR SHARE OF course, source, scope, actor, membership`,
        [context.actorId, context.ownerScopeId, courseId, sourceDocumentId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        actorId: context.actorId,
        authorizationId: context.authorizationId,
        courseId: row.course_id,
        courseTitle: row.course_title,
        ownerScopeId: row.owner_scope_id,
        sourceDocumentId: row.source_document_id,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistSourceSpans(
    access: AuthorizedSourceAccess,
    spans: readonly SourceSpanRecord[],
  ): Promise<void> {
    validateAccess(access);
    if (spans.length === 0) {
      throw new RetrievalError("invalid_chunk");
    }
    await this.#scopedTransaction(access, async (client) => {
      for (const span of spans) {
        if (
          span.ownerScopeId !== access.ownerScopeId ||
          span.sourceDocumentId !== access.sourceDocumentId
        ) {
          throw new RetrievalError("authorization_denied");
        }
        const result = await client.query<{ id: string }>(
          `INSERT INTO source_span
             (id, owner_scope_id, source_document_id, canonical_text, text_hash,
              page_start, page_end, section_path, canonical_start, canonical_end,
              parser_version, chunker_version, tokenizer_version,
              contract_version, chunk_order, native_mappings, embedding_input,
              embedding_input_hash, embedding_input_profile_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16::jsonb, $17, $18, $19)
           ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
           WHERE source_span.source_document_id = EXCLUDED.source_document_id
             AND source_span.canonical_text = EXCLUDED.canonical_text
             AND source_span.text_hash = EXCLUDED.text_hash
             AND source_span.page_start IS NOT DISTINCT FROM EXCLUDED.page_start
             AND source_span.page_end IS NOT DISTINCT FROM EXCLUDED.page_end
             AND source_span.section_path = EXCLUDED.section_path
             AND source_span.canonical_start = EXCLUDED.canonical_start
             AND source_span.canonical_end = EXCLUDED.canonical_end
             AND source_span.parser_version = EXCLUDED.parser_version
             AND source_span.chunker_version = EXCLUDED.chunker_version
             AND source_span.tokenizer_version = EXCLUDED.tokenizer_version
             AND source_span.contract_version = EXCLUDED.contract_version
             AND source_span.chunk_order = EXCLUDED.chunk_order
             AND source_span.native_mappings = EXCLUDED.native_mappings
             AND source_span.embedding_input = EXCLUDED.embedding_input
             AND source_span.embedding_input_hash = EXCLUDED.embedding_input_hash
             AND source_span.embedding_input_profile_version = EXCLUDED.embedding_input_profile_version
           RETURNING id`,
          [
            span.id,
            span.ownerScopeId,
            span.sourceDocumentId,
            span.canonicalText,
            span.textHash,
            span.pageStart,
            span.pageEnd,
            [...span.sectionPath],
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
        if (result.rows[0]?.id !== span.id) {
          throw new RetrievalError(
            "persistence_failure",
            "stable source span conflicts with different provenance",
          );
        }
      }
    });
  }

  async recordEmbeddingGeneration(
    access: AuthorizedSourceAccess,
    generation: EmbeddingGenerationRecord,
  ): Promise<void> {
    validateGeneration(access, generation);
    await this.#scopedTransaction(access, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO source_embedding_generation
           (id, owner_scope_id, source_document_id, profile_version,
            dimensions, input_mode, adapter_version, effective_model,
            effective_model_version, provider_identifier, provider_request_ids,
            region, endpoint, span_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, 'building')
         ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
         WHERE source_embedding_generation.source_document_id = EXCLUDED.source_document_id
           AND source_embedding_generation.profile_version = EXCLUDED.profile_version
           AND source_embedding_generation.dimensions = EXCLUDED.dimensions
           AND source_embedding_generation.input_mode = EXCLUDED.input_mode
           AND source_embedding_generation.adapter_version = EXCLUDED.adapter_version
           AND source_embedding_generation.effective_model = EXCLUDED.effective_model
           AND source_embedding_generation.effective_model_version = EXCLUDED.effective_model_version
           AND source_embedding_generation.provider_identifier = EXCLUDED.provider_identifier
           AND source_embedding_generation.provider_request_ids = EXCLUDED.provider_request_ids
           AND source_embedding_generation.region = EXCLUDED.region
           AND source_embedding_generation.endpoint = EXCLUDED.endpoint
           AND source_embedding_generation.span_count = EXCLUDED.span_count
         RETURNING id`,
        [
          generation.generationId,
          generation.ownerScopeId,
          generation.sourceDocumentId,
          generation.profileVersion,
          generation.dimensions,
          generation.inputMode,
          generation.adapterVersion,
          generation.effectiveModel,
          generation.effectiveModelVersion,
          generation.providerIdentifier,
          JSON.stringify(generation.providerRequestIds),
          generation.region,
          generation.endpoint,
          generation.spanIds.length,
        ],
      );
      if (inserted.rows[0]?.id !== generation.generationId) {
        throw new RetrievalError("persistence_failure");
      }
      for (const [spanOrder, sourceSpanId] of generation.spanIds.entries()) {
        const linked = await client.query<{ source_span_id: string }>(
          `INSERT INTO source_embedding_generation_span
             (owner_scope_id, embedding_generation_id, source_span_id,
              span_order, embedding_input_hash)
           SELECT $1, $2, span.id, $4, span.embedding_input_hash
           FROM source_span AS span
           WHERE span.owner_scope_id = $1
             AND span.source_document_id = $3
             AND span.id = $5
             AND span.embedding_input_hash IS NOT NULL
           ON CONFLICT (owner_scope_id, embedding_generation_id, source_span_id)
           DO UPDATE SET source_span_id = EXCLUDED.source_span_id
           WHERE source_embedding_generation_span.span_order = EXCLUDED.span_order
             AND source_embedding_generation_span.embedding_input_hash = EXCLUDED.embedding_input_hash
           RETURNING source_span_id`,
          [
            access.ownerScopeId,
            generation.generationId,
            access.sourceDocumentId,
            spanOrder,
            sourceSpanId,
          ],
        );
        if (linked.rows[0]?.source_span_id !== sourceSpanId) {
          throw new RetrievalError("persistence_failure");
        }
      }
    });
  }

  async activateEmbeddingGeneration(
    access: AuthorizedSourceAccess,
    generationId: string,
  ): Promise<void> {
    validateUuid(generationId);
    await this.#scopedTransaction(access, async (client) => {
      const ready = await client.query<{ complete: boolean }>(
        `SELECT generation.status IN ('building', 'active')
                  AND count(link.source_span_id) = generation.span_count AS complete
         FROM source_embedding_generation AS generation
         LEFT JOIN source_embedding_generation_span AS link
           ON link.owner_scope_id = generation.owner_scope_id
          AND link.embedding_generation_id = generation.id
         WHERE generation.owner_scope_id = $1
           AND generation.source_document_id = $2
           AND generation.id = $3
         GROUP BY generation.status, generation.span_count`,
        [access.ownerScopeId, access.sourceDocumentId, generationId],
      );
      if (ready.rows[0]?.complete !== true) {
        throw new RetrievalError("persistence_failure");
      }
      await client.query(
        `UPDATE source_embedding_generation
         SET status = 'retired'
         WHERE owner_scope_id = $1 AND source_document_id = $2
           AND status = 'active' AND id <> $3`,
        [access.ownerScopeId, access.sourceDocumentId, generationId],
      );
      await client.query(
        `UPDATE source_embedding_generation
         SET status = 'active', activated_at = COALESCE(activated_at, clock_timestamp())
         WHERE owner_scope_id = $1 AND source_document_id = $2 AND id = $3`,
        [access.ownerScopeId, access.sourceDocumentId, generationId],
      );
      const activated = await client.query<{ id: string }>(
        `UPDATE source_document
         SET active_embedding_generation_id = $3, updated_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND id = $2
           AND parse_status = 'parsed' AND retention_status = 'active'
         RETURNING id`,
        [access.ownerScopeId, access.sourceDocumentId, generationId],
      );
      if (activated.rows[0]?.id !== access.sourceDocumentId) {
        throw new RetrievalError("authorization_denied");
      }
    });
  }

  async activeEmbeddingGeneration(
    access: AuthorizedSourceAccess,
  ): Promise<string | null> {
    return this.#scopedTransaction(access, async (client) => {
      const result = await client.query<{ generation_id: string }>(
        `SELECT source.active_embedding_generation_id AS generation_id
         FROM source_document AS source
         JOIN source_embedding_generation AS generation
           ON generation.owner_scope_id = source.owner_scope_id
          AND generation.source_document_id = source.id
          AND generation.id = source.active_embedding_generation_id
         WHERE source.owner_scope_id = $1 AND source.id = $2
           AND source.parse_status = 'parsed'
           AND source.retention_status = 'active'
           AND generation.status = 'active'`,
        [access.ownerScopeId, access.sourceDocumentId],
      );
      return result.rows[0]?.generation_id ?? null;
    });
  }

  async resolveAuthorizedSourceSpans(
    access: AuthorizedSourceAccess,
    generationId: string,
    sourceSpanIds: readonly string[],
  ): Promise<readonly RetrievedSourceSpan[]> {
    validateUuid(generationId);
    if (
      sourceSpanIds.length === 0 ||
      new Set(sourceSpanIds).size !== sourceSpanIds.length
    ) {
      return [];
    }
    return this.#scopedTransaction(access, async (client) => {
      const result = await client.query<ResolvedSpanRow>(
        `SELECT span.id, span.canonical_text, span.section_path
         FROM source_document AS source
         JOIN source_embedding_generation AS generation
           ON generation.owner_scope_id = source.owner_scope_id
          AND generation.source_document_id = source.id
          AND generation.id = source.active_embedding_generation_id
         JOIN source_embedding_generation_span AS link
           ON link.owner_scope_id = generation.owner_scope_id
          AND link.embedding_generation_id = generation.id
         JOIN source_span AS span
           ON span.owner_scope_id = link.owner_scope_id
          AND span.source_document_id = source.id
          AND span.id = link.source_span_id
         WHERE source.owner_scope_id = $1
           AND source.id = $2
           AND generation.id = $3
           AND generation.status = 'active'
           AND source.parse_status = 'parsed'
           AND source.retention_status = 'active'
           AND span.id = ANY($4::uuid[])`,
        [
          access.ownerScopeId,
          access.sourceDocumentId,
          generationId,
          sourceSpanIds,
        ],
      );
      return result.rows.map((row) => ({
        id: row.id,
        sectionPath: row.section_path,
        text: row.canonical_text,
      }));
    });
  }

  async persistCurriculum(
    access: AuthorizedSourceAccess,
    generation: CurriculumGenerationRecord,
  ): Promise<CurriculumOutline> {
    if (
      generation.ownerScopeId !== access.ownerScopeId ||
      generation.sourceDocumentId !== access.sourceDocumentId ||
      generation.courseId !== access.courseId
    ) {
      throw new RetrievalError("authorization_denied");
    }
    const outline = materializeCurriculumOutline(access, generation);
    await this.#scopedTransaction(access, async (client) => {
      const sourceSpanIds = [
        ...new Set(
          generation.structure.chapters.flatMap((chapter) => [
            ...chapter.sourceSpanIds,
            ...chapter.concepts.flatMap((concept) => concept.sourceSpanIds),
          ]),
        ),
      ];
      const authorized = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM source_embedding_generation_span AS link
         JOIN source_span AS span
           ON span.owner_scope_id = link.owner_scope_id
          AND span.id = link.source_span_id
         JOIN source_document AS source
           ON source.owner_scope_id = span.owner_scope_id
          AND source.id = span.source_document_id
         WHERE link.owner_scope_id = $1
           AND link.embedding_generation_id = $2
           AND source.id = $3
           AND source.active_embedding_generation_id = $2
           AND source.retention_status = 'active'
           AND span.id = ANY($4::uuid[])`,
        [
          access.ownerScopeId,
          generation.embeddingGenerationId,
          access.sourceDocumentId,
          sourceSpanIds,
        ],
      );
      if (authorized.rows[0]?.count !== sourceSpanIds.length) {
        throw new RetrievalError("authorization_denied");
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO curriculum_generation
           (id, owner_scope_id, course_id, source_document_id,
            embedding_generation_id, generation_version, result_hash,
            model_provenance, structure, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'building')
         ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
         WHERE curriculum_generation.course_id = EXCLUDED.course_id
           AND curriculum_generation.source_document_id = EXCLUDED.source_document_id
           AND curriculum_generation.embedding_generation_id = EXCLUDED.embedding_generation_id
           AND curriculum_generation.generation_version = EXCLUDED.generation_version
           AND curriculum_generation.result_hash = EXCLUDED.result_hash
           AND curriculum_generation.model_provenance = EXCLUDED.model_provenance
           AND curriculum_generation.structure = EXCLUDED.structure
         RETURNING id`,
        [
          generation.generationId,
          generation.ownerScopeId,
          generation.courseId,
          generation.sourceDocumentId,
          generation.embeddingGenerationId,
          generation.version,
          generation.resultHash,
          JSON.stringify(generation.modelProvenance),
          JSON.stringify(generation.structure),
        ],
      );
      if (inserted.rows[0]?.id !== generation.generationId) {
        throw new RetrievalError("persistence_failure");
      }

      for (const [chapterIndex, chapter] of outline.chapters.entries()) {
        await client.query(
          `INSERT INTO chapter
             (id, owner_scope_id, course_id, chapter_order, title,
              generation_status, curriculum_generation_id)
           VALUES ($1, $2, $3, $4, $5, 'ready', $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            chapter.id,
            access.ownerScopeId,
            access.courseId,
            chapterIndex + 1,
            chapter.title,
            generation.generationId,
          ],
        );
        for (const [
          spanOrder,
          sourceSpanId,
        ] of chapter.sourceSpanIds.entries()) {
          await client.query(
            `INSERT INTO chapter_source_span
               (owner_scope_id, chapter_id, source_span_id, span_order)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [access.ownerScopeId, chapter.id, sourceSpanId, spanOrder],
          );
        }
        for (const [conceptIndex, concept] of chapter.concepts.entries()) {
          await client.query(
            `INSERT INTO concept
               (id, owner_scope_id, chapter_id, name, generation_version,
                curriculum_generation_id, concept_key, concept_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [
              concept.id,
              access.ownerScopeId,
              chapter.id,
              concept.name,
              generation.version,
              generation.generationId,
              concept.key,
              conceptIndex,
            ],
          );
          for (const sourceSpanId of concept.sourceSpanIds) {
            await client.query(
              `INSERT INTO concept_source_span
                 (owner_scope_id, concept_id, source_span_id)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [access.ownerScopeId, concept.id, sourceSpanId],
            );
          }
          for (const prerequisiteId of concept.prerequisiteIds) {
            await client.query(
              `INSERT INTO concept_prerequisite
                 (owner_scope_id, concept_id, prerequisite_concept_id)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [access.ownerScopeId, concept.id, prerequisiteId],
            );
          }
        }
      }
      await client.query(
        `UPDATE curriculum_generation
         SET status = 'retired'
         WHERE owner_scope_id = $1 AND course_id = $2
           AND status = 'active' AND id <> $3`,
        [access.ownerScopeId, access.courseId, generation.generationId],
      );
      await client.query(
        `UPDATE curriculum_generation
         SET status = 'active', activated_at = COALESCE(activated_at, clock_timestamp())
         WHERE owner_scope_id = $1 AND course_id = $2 AND id = $3`,
        [access.ownerScopeId, access.courseId, generation.generationId],
      );
      const activated = await client.query<{ id: string }>(
        `UPDATE course
         SET active_curriculum_generation_id = $3, status = 'ready',
             updated_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND id = $2
           AND source_document_id = $4 AND status IN ('generating', 'ready')
         RETURNING id`,
        [
          access.ownerScopeId,
          access.courseId,
          generation.generationId,
          access.sourceDocumentId,
        ],
      );
      if (activated.rows[0]?.id !== access.courseId) {
        throw new RetrievalError("authorization_denied");
      }
    });
    return outline;
  }

  async #scopedTransaction<Value>(
    access: AuthorizedSourceAccess,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    validateAccess(access);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await setScopeContext(client, access.actorId, access.ownerScopeId);
      const stillAuthorized = await client.query(
        `SELECT 1
         FROM course
         JOIN source_document AS source
           ON source.owner_scope_id = course.owner_scope_id
          AND source.id = course.source_document_id
         JOIN owner_scope AS scope ON scope.id = course.owner_scope_id
         JOIN app_user AS actor ON actor.id = $1
         JOIN scope_membership AS membership
           ON membership.owner_scope_id = course.owner_scope_id
          AND membership.user_id = actor.id
         WHERE course.owner_scope_id = $2 AND course.id = $3
           AND source.id = $4 AND scope.status = 'active'
           AND actor.status = 'active' AND membership.role = 'owner'
           AND membership.revoked_at IS NULL
           AND source.parse_status = 'parsed'
           AND source.retention_status = 'active'
           AND course.status IN ('generating', 'ready')
         FOR SHARE OF course, source, scope, actor, membership`,
        [
          access.actorId,
          access.ownerScopeId,
          access.courseId,
          access.sourceDocumentId,
        ],
      );
      if (stillAuthorized.rows.length !== 1) {
        throw new RetrievalError("authorization_denied");
      }
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
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
  actorId: string,
  ownerScopeId: string,
): Promise<void> {
  await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
    actorId,
  ]);
  await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
    ownerScopeId,
  ]);
}

function validateGeneration(
  access: AuthorizedSourceAccess,
  generation: EmbeddingGenerationRecord,
): void {
  if (
    generation.ownerScopeId !== access.ownerScopeId ||
    generation.sourceDocumentId !== access.sourceDocumentId ||
    generation.spanIds.length === 0
  ) {
    throw new RetrievalError("authorization_denied");
  }
  validateUuid(generation.generationId);
  for (const spanId of generation.spanIds) {
    validateUuid(spanId);
  }
}

function validateAccess(access: AuthorizedSourceAccess): void {
  validateContext(access);
  validateUuid(access.courseId);
  validateUuid(access.sourceDocumentId);
  if (access.courseTitle.length === 0) {
    throw new RetrievalError("authorization_denied");
  }
}

function validateContext(context: ScopeAuthorizationContext): void {
  validateUuid(context.actorId);
  validateUuid(context.ownerScopeId);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(context.authorizationId)) {
    throw new RetrievalError("authorization_denied");
  }
}

function validateUuid(value: string): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  ) {
    throw new RetrievalError("authorization_denied");
  }
}
