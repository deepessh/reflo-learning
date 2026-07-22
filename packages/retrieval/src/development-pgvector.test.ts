import { describe, expect, it } from "vitest";

import {
  DevelopmentPgVectorStore,
  type AuthorizedSourceAccess,
  type EmbeddingGenerationRecord,
  type VectorRecord,
} from "./index.js";
import type {
  AnalyticDbPoolPort,
  AnalyticDbSessionPort,
  SqlQueryResult,
} from "./ports.js";

const profile = "litellm-dev-embedding-v1-0123456789abcdef";
const access: AuthorizedSourceAccess = {
  actorId: "11200000-0000-4000-8000-000000000001",
  authorizationId: "local-smoke-auth-112",
  courseId: "11200000-0000-4000-8000-000000000004",
  courseTitle: "Synthetic course",
  ownerScopeId: "11200000-0000-4000-8000-000000000002",
  sourceDocumentId: "11200000-0000-4000-8000-000000000006",
};
const generation: EmbeddingGenerationRecord = {
  adapterVersion: "litellm-openai-compatible-dev-v1",
  dimensions: 1024,
  effectiveModel: "local-embedding",
  effectiveModelVersion: profile,
  endpoint: "http://127.0.0.1:4000/v1/embeddings",
  generationId: "11200000-0000-5000-8000-000000000010",
  inputMode: "document",
  ownerScopeId: access.ownerScopeId,
  profileVersion: profile,
  providerIdentifier: "litellm-development",
  providerRequestIds: ["request-1"],
  region: "local-development",
  sourceDocumentId: access.sourceDocumentId,
  spanIds: ["11200000-0000-5000-8000-000000000011"],
};
const record: VectorRecord = {
  embedding: Array.from({ length: 1024 }, () => 0.25),
  embeddingInputHash: "a".repeat(64),
  generationId: generation.generationId,
  ownerScopeId: access.ownerScopeId,
  sourceDocumentId: access.sourceDocumentId,
  sourceSpanId: generation.spanIds[0] ?? "",
};

describe("isolated LiteLLM development pgvector store", () => {
  it("binds writes and exact searches to the configured development profile", async () => {
    const database = new ScriptedDatabase();
    database.storedRows = [storedRow()];
    database.searchRows = [{ ...storedRow(), distance: "0.25" }];
    const store = new DevelopmentPgVectorStore(database, profile);

    await store.writeGeneration(access, generation, [record]);
    const results = await store.searchExact(
      access,
      generation.generationId,
      record.embedding,
      3,
    );

    expect(results).toHaveLength(1);
    expect(
      database.queries.every(
        (query) =>
          !query.text.includes("reflo_source_span_embedding_v1\n") &&
          !query.text.includes("embedding_profile_version = 'embedding-v1'"),
      ),
    ).toBe(true);
    expect(
      database.queries.filter((query) => query.text.includes("litellm_dev_v1")),
    ).toHaveLength(3);
    expect(
      database.queries.some((query) => query.values?.includes(profile)),
    ).toBe(true);
  });

  it("rejects authoritative or mismatched profiles before database access", async () => {
    const database = new ScriptedDatabase();
    expect(
      () => new DevelopmentPgVectorStore(database, "embedding-v1"),
    ).toThrowError(/development embedding profile/);

    const store = new DevelopmentPgVectorStore(database, profile);
    await expect(
      store.writeGeneration(
        access,
        { ...generation, profileVersion: `${profile.slice(0, -1)}0` },
        [record],
      ),
    ).rejects.toMatchObject({ code: "invalid_vector_result" });
    expect(database.connectCalls).toBe(0);
  });
});

class ScriptedDatabase implements AnalyticDbPoolPort, AnalyticDbSessionPort {
  connectCalls = 0;
  readonly queries: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }[] = [];
  searchRows: readonly Record<string, unknown>[] = [];
  storedRows: readonly Record<string, unknown>[] = [];

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
        ? this.storedRows
        : [];
    return { rowCount: rows.length, rows: rows as readonly Row[] };
  }

  release(): void {}
}

function storedRow() {
  return {
    embedding_generation_id: generation.generationId,
    embedding_input_hash: record.embeddingInputHash,
    embedding_profile_version: profile,
    owner_scope_id: access.ownerScopeId,
    source_document_id: access.sourceDocumentId,
    source_span_id: record.sourceSpanId,
  };
}
