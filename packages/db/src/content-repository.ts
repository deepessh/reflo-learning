import {
  CURRICULUM_SEGMENT_DEADLINE_MS,
  RetrievalError,
  canonicalJson,
  materializeCurriculumOutline,
  type AuthorizedSourceAccess,
  type ContentRepositoryPort,
  type CurriculumGenerationRecord,
  type CurriculumOutline,
  type CurriculumPartitionManifest,
  type CurriculumSegmentClaim,
  type CurriculumSegmentCompletion,
  type CurriculumSegmentFailure,
  type CurriculumSegmentManifestEntry,
  type PersistedCurriculumSegmentResult,
  type EmbeddingGenerationRecord,
  type RetrievedSourceSpan,
  type ScopeAuthorizationContext,
  type SourceSpanRecord,
} from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;
const CURRICULUM_SEGMENT_LEASE_MS = CURRICULUM_SEGMENT_DEADLINE_MS + 40_000;

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

interface EmbeddingGenerationRow extends Record<string, unknown> {
  adapter_version: string;
  dimensions: number;
  effective_model: string;
  effective_model_version: string;
  endpoint: string;
  generation_id: string;
  input_mode: "document";
  profile_version: string;
  provider_identifier: string;
  provider_request_ids: unknown;
  region: string;
  span_ids: string[];
}

interface CurriculumSegmentRow extends Record<string, unknown> {
  attempt_count: number;
  input_hash: string;
  lease_active: boolean;
  model_provenance: unknown;
  result: unknown;
  result_hash: string | null;
  state:
    | "cancelled"
    | "expired"
    | "failed_permanent"
    | "processing"
    | "queued"
    | "retry_scheduled"
    | "succeeded";
}

export class PostgresContentRepository implements ContentRepositoryPort {
  readonly #environment: "dev" | "pilot" | "staging";
  readonly #pool: InstanceType<typeof Pool>;

  constructor(
    connectionString: string,
    options: {
      readonly environment?: "dev" | "pilot" | "staging";
    } = {},
  ) {
    if (connectionString.length === 0) {
      throw new RetrievalError("invalid_configuration");
    }
    this.#environment = options.environment ?? "dev";
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
  ): Promise<EmbeddingGenerationRecord | null> {
    return this.#scopedTransaction(access, async (client) => {
      const result = await client.query<EmbeddingGenerationRow>(
        `SELECT generation.id AS generation_id, generation.profile_version,
                generation.dimensions, generation.input_mode,
                generation.adapter_version, generation.effective_model,
                generation.effective_model_version,
                generation.provider_identifier,
                generation.provider_request_ids, generation.region,
                generation.endpoint,
                array_agg(link.source_span_id ORDER BY link.span_order) AS span_ids
         FROM source_document AS source
         JOIN source_embedding_generation AS generation
           ON generation.owner_scope_id = source.owner_scope_id
          AND generation.source_document_id = source.id
          AND generation.id = source.active_embedding_generation_id
         JOIN source_embedding_generation_span AS link
           ON link.owner_scope_id = generation.owner_scope_id
          AND link.embedding_generation_id = generation.id
         WHERE source.owner_scope_id = $1 AND source.id = $2
           AND source.parse_status = 'parsed'
           AND source.retention_status = 'active'
           AND generation.status = 'active'
         GROUP BY generation.id, generation.profile_version,
                  generation.dimensions, generation.input_mode,
                  generation.adapter_version, generation.effective_model,
                  generation.effective_model_version,
                  generation.provider_identifier,
                  generation.provider_request_ids, generation.region,
                  generation.endpoint`,
        [access.ownerScopeId, access.sourceDocumentId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      if (
        !Array.isArray(row.provider_request_ids) ||
        row.provider_request_ids.some((value) => typeof value !== "string") ||
        !Array.isArray(row.span_ids) ||
        row.span_ids.some((value) => typeof value !== "string")
      ) {
        throw new RetrievalError("persistence_failure");
      }
      return {
        adapterVersion: row.adapter_version,
        dimensions: row.dimensions as EmbeddingGenerationRecord["dimensions"],
        effectiveModel: row.effective_model,
        effectiveModelVersion: row.effective_model_version,
        endpoint: row.endpoint,
        generationId: row.generation_id,
        inputMode: row.input_mode,
        ownerScopeId: access.ownerScopeId,
        profileVersion: row.profile_version,
        providerIdentifier: row.provider_identifier,
        providerRequestIds: row.provider_request_ids,
        region: row.region,
        sourceDocumentId: access.sourceDocumentId,
        spanIds: row.span_ids,
      };
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

  async persistCurriculumPartition(
    access: AuthorizedSourceAccess,
    manifest: CurriculumPartitionManifest,
  ): Promise<void> {
    if (
      manifest.ownerScopeId !== access.ownerScopeId ||
      manifest.courseId !== access.courseId ||
      manifest.sourceDocumentId !== access.sourceDocumentId ||
      manifest.segments.length === 0
    ) {
      throw new RetrievalError("authorization_denied");
    }
    await this.#scopedTransaction(access, async (client) => {
      const orderedSpanIds = manifest.segments.flatMap(
        (segment) => segment.sourceSpanIds,
      );
      if (new Set(orderedSpanIds).size !== orderedSpanIds.length) {
        throw new RetrievalError("invalid_chunk");
      }
      const authorized = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM source_embedding_generation_span AS link
         JOIN source_document AS source
           ON source.owner_scope_id = link.owner_scope_id
          AND source.id = $3
          AND source.active_embedding_generation_id =
              link.embedding_generation_id
         WHERE link.owner_scope_id = $1
           AND link.embedding_generation_id = $2
           AND link.source_span_id = ANY($4::uuid[])`,
        [
          access.ownerScopeId,
          manifest.embeddingGenerationId,
          access.sourceDocumentId,
          orderedSpanIds,
        ],
      );
      if (authorized.rows[0]?.count !== orderedSpanIds.length) {
        throw new RetrievalError("authorization_denied");
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO curriculum_partition_manifest
           (id, owner_scope_id, course_id, source_document_id,
            embedding_generation_id, partition_version, composition_version,
            generation_version, tokenizer_version, manifest_hash, manifest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
         WHERE curriculum_partition_manifest.course_id = EXCLUDED.course_id
           AND curriculum_partition_manifest.source_document_id =
               EXCLUDED.source_document_id
           AND curriculum_partition_manifest.embedding_generation_id =
               EXCLUDED.embedding_generation_id
           AND curriculum_partition_manifest.partition_version =
               EXCLUDED.partition_version
           AND curriculum_partition_manifest.composition_version =
               EXCLUDED.composition_version
           AND curriculum_partition_manifest.generation_version =
               EXCLUDED.generation_version
           AND curriculum_partition_manifest.tokenizer_version =
               EXCLUDED.tokenizer_version
           AND curriculum_partition_manifest.manifest_hash =
               EXCLUDED.manifest_hash
           AND curriculum_partition_manifest.manifest = EXCLUDED.manifest
         RETURNING id`,
        [
          manifest.parentGenerationId,
          manifest.ownerScopeId,
          manifest.courseId,
          manifest.sourceDocumentId,
          manifest.embeddingGenerationId,
          manifest.partitionVersion,
          manifest.compositionVersion,
          manifest.generationVersion,
          manifest.tokenizerVersion,
          manifest.manifestHash,
          JSON.stringify(manifest),
        ],
      );
      if (inserted.rows[0]?.id !== manifest.parentGenerationId) {
        throw new RetrievalError("persistence_failure");
      }
      for (const segment of manifest.segments) {
        const idempotencyKey =
          `${this.#environment}/curriculum.segment/v1/` +
          `${manifest.parentGenerationId}/${segment.id}`;
        const child = await client.query<{ segment_id: string }>(
          `INSERT INTO curriculum_segment_operation
             (owner_scope_id, parent_generation_id, segment_id,
              segment_ordinal, idempotency_key, task_version,
              input_schema_version, result_schema_version, input_hash,
              ordered_source_span_ids, ordered_source_input_hashes, state)
           VALUES ($1, $2, $3, $4, $5, 'curriculum.segment.v1',
                   'curriculum-segment-input-v1',
                   'curriculum-segment-result-v1', $6, $7::jsonb, $8::jsonb,
                   'queued')
           ON CONFLICT (owner_scope_id, parent_generation_id, segment_id)
           DO UPDATE SET segment_id = EXCLUDED.segment_id
           WHERE curriculum_segment_operation.segment_ordinal =
                 EXCLUDED.segment_ordinal
             AND curriculum_segment_operation.idempotency_key =
                 EXCLUDED.idempotency_key
             AND curriculum_segment_operation.task_version =
                 EXCLUDED.task_version
             AND curriculum_segment_operation.input_schema_version =
                 EXCLUDED.input_schema_version
             AND curriculum_segment_operation.result_schema_version =
                 EXCLUDED.result_schema_version
             AND curriculum_segment_operation.input_hash = EXCLUDED.input_hash
             AND curriculum_segment_operation.ordered_source_span_ids =
                 EXCLUDED.ordered_source_span_ids
             AND curriculum_segment_operation.ordered_source_input_hashes =
                 EXCLUDED.ordered_source_input_hashes
           RETURNING segment_id`,
          [
            access.ownerScopeId,
            manifest.parentGenerationId,
            segment.id,
            segment.ordinal,
            idempotencyKey,
            segment.inputHash,
            JSON.stringify(segment.sourceSpanIds),
            JSON.stringify(segment.sourceSpanInputHashes),
          ],
        );
        if (child.rows[0]?.segment_id !== segment.id) {
          throw new RetrievalError("persistence_failure");
        }
      }
    });
  }

  async claimCurriculumSegment(
    access: AuthorizedSourceAccess,
    parentGenerationId: string,
    segment: CurriculumSegmentManifestEntry,
  ): Promise<CurriculumSegmentClaim> {
    validateUuid(parentGenerationId);
    validateUuid(segment.id);
    return this.#scopedTransaction(access, async (client) => {
      const selected = await client.query<CurriculumSegmentRow>(
        `SELECT state, attempt_count, input_hash, result_hash, result,
                model_provenance,
                lease_expires_at > clock_timestamp() AS lease_active
         FROM curriculum_segment_operation
         WHERE owner_scope_id = $1 AND parent_generation_id = $2
           AND segment_id = $3 AND segment_ordinal = $4
           AND input_hash = $5
         FOR UPDATE`,
        [
          access.ownerScopeId,
          parentGenerationId,
          segment.id,
          segment.ordinal,
          segment.inputHash,
        ],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        throw new RetrievalError("persistence_failure");
      }
      if (row.state === "succeeded") {
        return {
          kind: "completed",
          persisted: persistedSegment(row, segment.id),
        };
      }
      if (row.state === "processing" && row.lease_active) {
        return { kind: "active" };
      }
      if (
        row.state === "failed_permanent" ||
        row.state === "cancelled" ||
        row.state === "expired"
      ) {
        return { kind: "failed" };
      }
      const claimed = await client.query<{ attempt_count: number }>(
        `UPDATE curriculum_segment_operation
         SET state = 'processing', attempt_count = attempt_count + 1,
             lease_owner = 'content_curriculum_segment_v1',
             lease_expires_at =
               clock_timestamp() +
                 ($4::bigint * interval '1 millisecond'),
             sanitized_failure = NULL, updated_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND parent_generation_id = $2
           AND segment_id = $3
         RETURNING attempt_count`,
        [
          access.ownerScopeId,
          parentGenerationId,
          segment.id,
          CURRICULUM_SEGMENT_LEASE_MS,
        ],
      );
      const attemptCount = claimed.rows[0]?.attempt_count;
      if (attemptCount === undefined) {
        throw new RetrievalError("persistence_failure");
      }
      return { attemptCount, kind: "claimed" };
    });
  }

  async completeCurriculumSegment(
    access: AuthorizedSourceAccess,
    completion: CurriculumSegmentCompletion,
  ): Promise<void> {
    validateUuid(completion.parentGenerationId);
    validateUuid(completion.segmentId);
    await this.#scopedTransaction(access, async (client) => {
      const completed = await client.query<{ segment_id: string }>(
        `UPDATE curriculum_segment_operation
         SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
             result_hash = $7, result = $8::jsonb,
             model_provenance = $9::jsonb, sanitized_failure = NULL,
             updated_at = clock_timestamp(), completed_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND parent_generation_id = $2
           AND segment_id = $3 AND input_hash = $4
           AND state = 'processing'
           AND lease_owner = 'content_curriculum_segment_v1'
           AND lease_expires_at > clock_timestamp()
           AND attempt_count = $5
           AND result IS NULL
           AND model_provenance IS NULL
           AND $6 = 'curriculum.segment.v1'
         RETURNING segment_id`,
        [
          access.ownerScopeId,
          completion.parentGenerationId,
          completion.segmentId,
          completion.inputHash,
          completion.attemptCount,
          completion.modelProvenance.task,
          completion.resultHash,
          JSON.stringify(completion.result),
          JSON.stringify(completion.modelProvenance),
        ],
      );
      if (completed.rows[0]?.segment_id !== completion.segmentId) {
        throw new RetrievalError("persistence_failure");
      }
    });
  }

  async failCurriculumSegment(
    access: AuthorizedSourceAccess,
    failure: CurriculumSegmentFailure,
  ): Promise<void> {
    validateUuid(failure.parentGenerationId);
    validateUuid(failure.segmentId);
    await this.#scopedTransaction(access, async (client) => {
      const state =
        failure.retryable && failure.attemptCount < 3
          ? "retry_scheduled"
          : "failed_permanent";
      const failed = await client.query<{ segment_id: string }>(
        `UPDATE curriculum_segment_operation
         SET state = $6, lease_owner = NULL, lease_expires_at = NULL,
             sanitized_failure = jsonb_build_object('class', $7::text),
             updated_at = clock_timestamp(),
             completed_at = CASE WHEN $6 = 'failed_permanent'
               THEN clock_timestamp() ELSE NULL END
         WHERE owner_scope_id = $1 AND parent_generation_id = $2
           AND segment_id = $3 AND input_hash = $4
           AND state = 'processing'
           AND lease_owner = 'content_curriculum_segment_v1'
           AND attempt_count = $5
         RETURNING segment_id`,
        [
          access.ownerScopeId,
          failure.parentGenerationId,
          failure.segmentId,
          failure.inputHash,
          failure.attemptCount,
          state,
          failure.failureClass,
        ],
      );
      if (failed.rows[0]?.segment_id !== failure.segmentId) {
        throw new RetrievalError("persistence_failure");
      }
    });
  }

  async persistCurriculum(
    access: AuthorizedSourceAccess,
    generation: CurriculumGenerationRecord,
    deadlineMs: number,
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
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        throw new RetrievalError("deadline_exceeded");
      }
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${Math.max(1, Math.floor(deadlineMs))}ms`,
      ]);
      if (generation.version === "curriculum-v2") {
        if (!("partitionManifestHash" in generation.structure)) {
          throw new RetrievalError("persistence_failure");
        }
        const complete = await client.query<{
          manifest_hash: string;
          model_provenance: unknown;
          result_hashes: string[];
          segment_count: number;
          succeeded_count: number;
        }>(
          `SELECT manifest.manifest_hash,
                  count(segment.segment_id)::integer AS segment_count,
                  count(segment.segment_id) FILTER (
                    WHERE segment.state = 'succeeded'
                  )::integer AS succeeded_count,
                  array_agg(segment.result_hash ORDER BY segment.segment_ordinal)
                    AS result_hashes,
                  jsonb_agg(segment.model_provenance
                    ORDER BY segment.segment_ordinal) AS model_provenance
           FROM curriculum_partition_manifest AS manifest
           JOIN curriculum_segment_operation AS segment
             ON segment.owner_scope_id = manifest.owner_scope_id
            AND segment.parent_generation_id = manifest.id
           WHERE manifest.owner_scope_id = $1 AND manifest.id = $2
             AND manifest.course_id = $3
             AND manifest.source_document_id = $4
             AND manifest.embedding_generation_id = $5
           GROUP BY manifest.manifest_hash`,
          [
            access.ownerScopeId,
            generation.generationId,
            access.courseId,
            access.sourceDocumentId,
            generation.embeddingGenerationId,
          ],
        );
        const row = complete.rows[0];
        if (
          row === undefined ||
          row.segment_count === 0 ||
          row.succeeded_count !== row.segment_count ||
          row.manifest_hash !== generation.structure.partitionManifestHash ||
          canonicalJson(row.result_hashes) !==
            canonicalJson(generation.structure.childResultHashes) ||
          canonicalJson(row.model_provenance) !==
            canonicalJson(generation.modelProvenance)
        ) {
          throw new RetrievalError(
            "persistence_failure",
            "curriculum child set is incomplete or inconsistent",
          );
        }
      }
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
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "57014"
      ) {
        throw new RetrievalError("deadline_exceeded");
      }
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

function persistedSegment(
  row: CurriculumSegmentRow,
  segmentId: string,
): PersistedCurriculumSegmentResult {
  if (
    row.state !== "succeeded" ||
    row.attempt_count < 1 ||
    !/^[a-f0-9]{64}$/.test(row.input_hash) ||
    row.result_hash === null ||
    !/^[a-f0-9]{64}$/.test(row.result_hash) ||
    row.result === null ||
    typeof row.result !== "object" ||
    Array.isArray(row.result) ||
    row.model_provenance === null ||
    typeof row.model_provenance !== "object" ||
    Array.isArray(row.model_provenance) ||
    (row.model_provenance as Record<string, unknown>).task !==
      "curriculum.segment.v1" ||
    (row.model_provenance as Record<string, unknown>).validationOutcome !==
      "passed"
  ) {
    throw new RetrievalError("persistence_failure");
  }
  return {
    attemptCount: row.attempt_count,
    inputHash: row.input_hash,
    modelProvenance:
      row.model_provenance as PersistedCurriculumSegmentResult["modelProvenance"],
    result: row.result as PersistedCurriculumSegmentResult["result"],
    resultHash: row.result_hash,
    segmentId,
  };
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
