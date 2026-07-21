import {
  EMBEDDING_DIMENSIONS,
  VECTOR_NAMESPACE_VERSION,
  type AuthorizedSourceAccess,
  type EmbeddingGenerationRecord,
  type VectorRecord,
  type VectorSearchResult,
} from "./contracts.js";
import { RetrievalError } from "./errors.js";
import type {
  AnalyticDbPoolPort,
  AnalyticDbSessionPort,
  VectorStorePort,
} from "./ports.js";

interface StoredVectorRow extends Record<string, unknown> {
  embedding_generation_id: string;
  embedding_input_hash: string;
  owner_scope_id: string;
  source_document_id: string;
  source_span_id: string;
}

interface SearchRow extends StoredVectorRow {
  distance: number | string;
}

export class AnalyticDbVectorStore implements VectorStorePort {
  constructor(private readonly pool: AnalyticDbPoolPort) {}

  async writeGeneration(
    access: AuthorizedSourceAccess,
    generation: EmbeddingGenerationRecord,
    records: readonly VectorRecord[],
  ): Promise<void> {
    assertGeneration(access, generation);
    if (
      records.length === 0 ||
      records.length !== generation.spanIds.length ||
      new Set(records.map((record) => record.sourceSpanId)).size !==
        records.length
    ) {
      invalidVector("incomplete vector generation");
    }
    const expectedSpanIds = new Set(generation.spanIds);
    for (const record of records) {
      assertRecord(access, generation, record, expectedSpanIds);
    }

    await this.#transaction(async (session) => {
      for (const record of records) {
        await session.query(
          `INSERT INTO reflo_source_span_embedding_v1
             (owner_scope_id, source_span_id, embedding_generation_id,
              source_document_id, embedding_profile_version,
              embedding_input_hash, dimensions, distance_metric, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'cosine', $8::vector)
           ON CONFLICT (owner_scope_id, source_span_id, embedding_generation_id)
           DO NOTHING`,
          [
            access.ownerScopeId,
            record.sourceSpanId,
            generation.generationId,
            access.sourceDocumentId,
            generation.profileVersion,
            record.embeddingInputHash,
            EMBEDDING_DIMENSIONS,
            vectorLiteral(record.embedding),
          ],
        );
      }
      const stored = await session.query<StoredVectorRow>(
        `SELECT owner_scope_id, source_span_id, embedding_generation_id,
                source_document_id, embedding_input_hash
         FROM reflo_source_span_embedding_v1
         WHERE owner_scope_id = $1
           AND source_document_id = $2
           AND embedding_generation_id = $3
         ORDER BY source_span_id`,
        [access.ownerScopeId, access.sourceDocumentId, generation.generationId],
      );
      assertStoredGeneration(access, generation, records, stored.rows);
    });
  }

  async searchExact(
    access: AuthorizedSourceAccess,
    generationId: string,
    queryVector: readonly number[],
    limit: number,
  ): Promise<readonly VectorSearchResult[]> {
    assertAccess(access);
    assertUuid(generationId);
    assertVector(queryVector);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      invalidVector("invalid search limit");
    }
    const session = await this.pool.connect();
    try {
      const result = await session.query<SearchRow>(
        `SELECT owner_scope_id, source_span_id, embedding_generation_id,
                source_document_id, embedding_input_hash,
                embedding <=> $4::vector AS distance
         FROM reflo_source_span_embedding_v1
         WHERE owner_scope_id = $1
           AND source_document_id = $2
           AND embedding_generation_id = $3
           AND embedding_profile_version = 'embedding-v1'
           AND dimensions = 1024
           AND distance_metric = 'cosine'
         ORDER BY embedding <=> $4::vector ASC, source_span_id ASC
         LIMIT $5`,
        [
          access.ownerScopeId,
          access.sourceDocumentId,
          generationId,
          vectorLiteral(queryVector),
          limit,
        ],
      );
      return result.rows.map((row) => {
        if (
          row.owner_scope_id !== access.ownerScopeId ||
          row.source_document_id !== access.sourceDocumentId ||
          row.embedding_generation_id !== generationId ||
          typeof row.source_span_id !== "string" ||
          typeof row.embedding_input_hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.embedding_input_hash) ||
          !Number.isFinite(Number(row.distance))
        ) {
          invalidVector("contaminated vector search result");
        }
        return {
          distance: Number(row.distance),
          embeddingInputHash: row.embedding_input_hash,
          generationId: row.embedding_generation_id,
          ownerScopeId: row.owner_scope_id,
          sourceDocumentId: row.source_document_id,
          sourceSpanId: row.source_span_id,
        };
      });
    } finally {
      session.release();
    }
  }

  async purgeSource(access: AuthorizedSourceAccess): Promise<number> {
    assertAccess(access);
    const session = await this.pool.connect();
    try {
      const result = await session.query(
        `DELETE FROM reflo_source_span_embedding_v1
         WHERE owner_scope_id = $1 AND source_document_id = $2`,
        [access.ownerScopeId, access.sourceDocumentId],
      );
      return result.rowCount ?? 0;
    } finally {
      session.release();
    }
  }

  async #transaction<Value>(
    operation: (session: AnalyticDbSessionPort) => Promise<Value>,
  ): Promise<Value> {
    const session = await this.pool.connect();
    try {
      await session.query("BEGIN");
      const value = await operation(session);
      await session.query("COMMIT");
      return value;
    } catch (error) {
      await session.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      session.release();
    }
  }
}

function assertStoredGeneration(
  access: AuthorizedSourceAccess,
  generation: EmbeddingGenerationRecord,
  records: readonly VectorRecord[],
  stored: readonly StoredVectorRow[],
): void {
  if (stored.length !== records.length) {
    invalidVector("vector generation failed completeness validation");
  }
  const expected = new Map(
    records.map((record) => [record.sourceSpanId, record.embeddingInputHash]),
  );
  for (const row of stored) {
    if (
      row.owner_scope_id !== access.ownerScopeId ||
      row.source_document_id !== access.sourceDocumentId ||
      row.embedding_generation_id !== generation.generationId ||
      expected.get(row.source_span_id) !== row.embedding_input_hash
    ) {
      invalidVector("vector generation contains mismatched data");
    }
  }
}

function assertGeneration(
  access: AuthorizedSourceAccess,
  generation: EmbeddingGenerationRecord,
): void {
  assertAccess(access);
  if (
    generation.ownerScopeId !== access.ownerScopeId ||
    generation.sourceDocumentId !== access.sourceDocumentId ||
    generation.profileVersion !== "embedding-v1" ||
    generation.dimensions !== EMBEDDING_DIMENSIONS ||
    generation.inputMode !== "document" ||
    generation.spanIds.length === 0
  ) {
    invalidVector("embedding generation is outside the authorized namespace");
  }
  assertUuid(generation.generationId);
}

function assertRecord(
  access: AuthorizedSourceAccess,
  generation: EmbeddingGenerationRecord,
  record: VectorRecord,
  expectedSpanIds: ReadonlySet<string>,
): void {
  if (
    record.ownerScopeId !== access.ownerScopeId ||
    record.sourceDocumentId !== access.sourceDocumentId ||
    record.generationId !== generation.generationId ||
    !expectedSpanIds.has(record.sourceSpanId) ||
    !/^[a-f0-9]{64}$/.test(record.embeddingInputHash)
  ) {
    invalidVector("vector record is outside the authorized namespace");
  }
  assertVector(record.embedding);
}

function assertAccess(access: AuthorizedSourceAccess): void {
  if (
    access.actorId.length === 0 ||
    access.authorizationId.length === 0 ||
    access.ownerScopeId.length === 0 ||
    access.sourceDocumentId.length === 0
  ) {
    throw new RetrievalError("authorization_denied");
  }
}

function assertVector(vector: readonly number[]): void {
  if (
    vector.length !== EMBEDDING_DIMENSIONS ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    invalidVector("embedding vector has invalid dimensions or values");
  }
}

function vectorLiteral(vector: readonly number[]): string {
  assertVector(vector);
  return `[${vector.join(",")}]`;
}

function assertUuid(value: string): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  ) {
    invalidVector("invalid generation identifier");
  }
}

function invalidVector(message: string): never {
  throw new RetrievalError("invalid_vector_result", message);
}

export const ANALYTICDB_VECTOR_NAMESPACE_VERSION = VECTOR_NAMESPACE_VERSION;
