import { describe, expect, it } from "vitest";

import { AnalyticDbVectorStore } from "./analyticdb.js";
import {
  EMBEDDING_DIMENSIONS,
  type AuthorizedSourceAccess,
  type EmbeddingGenerationRecord,
  type VectorRecord,
} from "./contracts.js";
import type {
  AnalyticDbPoolPort,
  AnalyticDbSessionPort,
  SqlQueryResult,
} from "./ports.js";

const access: AuthorizedSourceAccess = {
  actorId: "00000000-0000-4000-8000-000000000001",
  authorizationId: "request-auth-0001",
  courseId: "00000000-0000-4000-8000-000000000301",
  courseTitle: "Course",
  ownerScopeId: "00000000-0000-4000-8000-000000000101",
  sourceDocumentId: "00000000-0000-4000-8000-000000000201",
};
const generation: EmbeddingGenerationRecord = {
  adapterVersion: "adapter-v1",
  dimensions: EMBEDDING_DIMENSIONS,
  effectiveModel: "text-embedding-v4",
  effectiveModelVersion: "model-version-1",
  endpoint: "model-studio.example.invalid",
  generationId: "00000000-0000-5000-8000-000000000501",
  inputMode: "document",
  ownerScopeId: access.ownerScopeId,
  profileVersion: "embedding-v1",
  providerIdentifier: "model-studio",
  providerRequestIds: ["request-1"],
  region: "fixture-region-1",
  sourceDocumentId: access.sourceDocumentId,
  spanIds: ["00000000-0000-5000-8000-000000000401"],
};
const record: VectorRecord = {
  embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.25),
  embeddingInputHash: "a".repeat(64),
  generationId: generation.generationId,
  ownerScopeId: access.ownerScopeId,
  sourceDocumentId: access.sourceDocumentId,
  sourceSpanId: generation.spanIds[0] ?? "",
};

describe("AnalyticDB vector namespace v1", () => {
  it("writes an immutable complete generation with owner-first keys", async () => {
    const database = new ScriptedAnalyticDb();
    database.generationRows = [storedRow()];
    const store = new AnalyticDbVectorStore(database);

    await store.writeGeneration(access, generation, [record]);

    const insert = database.queries.find((query) =>
      query.text.includes("INSERT INTO"),
    );
    expect(insert?.text).toContain(
      "(owner_scope_id, source_span_id, embedding_generation_id",
    );
    expect(insert?.values?.slice(0, 4)).toEqual([
      access.ownerScopeId,
      record.sourceSpanId,
      generation.generationId,
      access.sourceDocumentId,
    ]);
    expect(database.queries.map((query) => query.text.trim())).toEqual(
      expect.arrayContaining(["BEGIN", "COMMIT"]),
    );
  });

  it("rejects cross-scope writes before opening a database session", async () => {
    const database = new ScriptedAnalyticDb();
    const store = new AnalyticDbVectorStore(database);

    await expect(
      store.writeGeneration(access, generation, [
        {
          ...record,
          ownerScopeId: "00000000-0000-4000-8000-000000000999",
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid_vector_result" });
    expect(database.connectCalls).toBe(0);
  });

  it("uses exact cosine search with non-removable scope and generation filters", async () => {
    const database = new ScriptedAnalyticDb();
    database.searchRows = [{ ...storedRow(), distance: "0.125" }];
    const store = new AnalyticDbVectorStore(database);

    const results = await store.searchExact(
      access,
      generation.generationId,
      record.embedding,
      10,
    );

    expect(results[0]).toMatchObject({
      distance: 0.125,
      ownerScopeId: access.ownerScopeId,
      sourceSpanId: record.sourceSpanId,
    });
    const search = database.queries.find((query) => query.text.includes("<=>"));
    expect(search?.text).toContain("owner_scope_id = $1");
    expect(search?.text).toContain("source_document_id = $2");
    expect(search?.text).toContain("embedding_generation_id = $3");
    expect(search?.text).not.toContain("hnsw");
  });

  it("fails closed on a contaminated database result", async () => {
    const database = new ScriptedAnalyticDb();
    database.searchRows = [
      {
        ...storedRow(),
        distance: 0,
        owner_scope_id: "00000000-0000-4000-8000-000000000999",
      },
    ];
    const store = new AnalyticDbVectorStore(database);

    await expect(
      store.searchExact(access, generation.generationId, record.embedding, 10),
    ).rejects.toMatchObject({ code: "invalid_vector_result" });
  });
});

class ScriptedAnalyticDb implements AnalyticDbPoolPort, AnalyticDbSessionPort {
  connectCalls = 0;
  generationRows: readonly Record<string, unknown>[] = [];
  readonly queries: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }[] = [];
  searchRows: readonly Record<string, unknown>[] = [];

  async connect(): Promise<AnalyticDbSessionPort> {
    this.connectCalls += 1;
    return this;
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    const rows = text.includes("<=>")
      ? this.searchRows
      : text.includes("SELECT owner_scope_id")
        ? this.generationRows
        : [];
    return { rowCount: rows.length, rows: rows as readonly Row[] };
  }

  release(): void {}
}

function storedRow() {
  return {
    embedding_generation_id: generation.generationId,
    embedding_input_hash: record.embeddingInputHash,
    owner_scope_id: access.ownerScopeId,
    source_document_id: access.sourceDocumentId,
    source_span_id: record.sourceSpanId,
  };
}
