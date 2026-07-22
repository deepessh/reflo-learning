import { normalizedDocument } from "@reflo/ingestion/testing";
import { createModelRouter } from "@reflo/model-router";
import {
  createScriptedAdapterRegistry,
  InMemoryTraceSink,
} from "@reflo/model-router/testing";
import { describe, expect, it } from "vitest";

import { chunkNormalizedDocument } from "./chunker.js";
import { EMBEDDING_DIMENSIONS } from "./contracts.js";
import { RetrievalService } from "./service.js";
import { InMemoryContentRepository, InMemoryVectorStore } from "./testing.js";

const access = {
  actorId: "00000000-0000-4000-8000-000000000001",
  authorizationId: "request-auth-0001",
  courseId: "00000000-0000-4000-8000-000000000301",
  courseTitle: "Cloud foundations",
  ownerScopeId: "00000000-0000-4000-8000-000000000101",
  sourceDocumentId: "00000000-0000-4000-8000-000000000201",
} as const;
const authorization = {
  actorId: access.actorId,
  authorizationId: access.authorizationId,
  ownerScopeId: access.ownerScopeId,
};
const document = normalizedDocument("pdf", "a".repeat(64));
const [fixtureSpan] = chunkNormalizedDocument({
  document,
  ownerScopeId: access.ownerScopeId,
  sourceDocumentId: access.sourceDocumentId,
});
if (fixtureSpan === undefined) {
  throw new Error("fixture source span missing");
}

describe("retrieval vertical slice", () => {
  it("turns a standard-profile fixture into a source-backed usable outline", async () => {
    const repository = new InMemoryContentRepository(access);
    const vectors = new InMemoryVectorStore();
    const scripted = createScriptedAdapterRegistry({
      "curriculum.structure.v1": [
        {
          type: "result",
          value: {
            chapters: [
              {
                concepts: [
                  {
                    key: "virtual-networks",
                    name: "Virtual networks",
                    prerequisiteKeys: [],
                    sourceSpanIds: [fixtureSpan.id],
                  },
                  {
                    key: "subnets",
                    name: "Subnets",
                    prerequisiteKeys: ["virtual-networks"],
                    sourceSpanIds: [fixtureSpan.id],
                  },
                ],
                sourceSpanIds: [fixtureSpan.id],
                title: "Networking",
              },
            ],
          },
        },
      ],
      "embedding.document.v1": [
        {
          type: "result",
          value: {
            metadata: embeddingMetadata("document", "document-request-1"),
            vectors: [vector(0.1)],
          },
        },
      ],
      "embedding.query.v1": [
        {
          type: "result",
          value: {
            metadata: embeddingMetadata("query", "query-request-1"),
            vectors: [vector(0.2)],
          },
        },
      ],
    });
    const service = new RetrievalService({
      models: createModelRouter({
        adapters: scripted.adapters,
        traceSink: new InMemoryTraceSink(),
      }),
      repository,
      vectors,
    });

    const result = await service.buildCurriculum({
      authorization,
      courseId: access.courseId,
      deadlineMs: 5_000,
      document,
      sourceDocumentId: access.sourceDocumentId,
    });

    expect(result.outline).toMatchObject({
      courseId: access.courseId,
      ownerScopeId: access.ownerScopeId,
      status: "ready",
    });
    expect(result.outline.chapters).toHaveLength(1);
    expect(result.outline.chapters[0]?.concepts).toHaveLength(2);
    expect(result.outline.chapters[0]?.concepts[1]?.prerequisiteIds).toEqual([
      result.outline.chapters[0]?.concepts[0]?.id,
    ]);
    expect(result.outline.chapters[0]?.concepts[0]?.sourceSpanIds).toEqual([
      fixtureSpan.id,
    ]);
    expect(result.embeddingGeneration.profileVersion).toBe("embedding-v1");
    expect(repository.activeGeneration?.generationId).toBe(
      result.embeddingGeneration.generationId,
    );

    await expect(
      service.search({
        authorization,
        courseId: access.courseId,
        deadlineMs: 5_000,
        limit: 5,
        query: "What is a virtual network?",
        sourceDocumentId: access.sourceDocumentId,
      }),
    ).resolves.toEqual([
      {
        id: fixtureSpan.id,
        sectionPath: ["Introduction"],
        text: "Grounded lesson text",
      },
    ]);
  });

  it("fails closed before model or vector access for a forged owner scope", async () => {
    const repository = new InMemoryContentRepository(access);
    const vectors = new InMemoryVectorStore();
    const scripted = createScriptedAdapterRegistry({});
    const service = new RetrievalService({
      models: createModelRouter({
        adapters: scripted.adapters,
        traceSink: new InMemoryTraceSink(),
      }),
      repository,
      vectors,
    });

    await expect(
      service.buildCurriculum({
        authorization: {
          ...authorization,
          ownerScopeId: "00000000-0000-4000-8000-000000000999",
        },
        courseId: access.courseId,
        deadlineMs: 5_000,
        document,
        sourceDocumentId: access.sourceDocumentId,
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
    expect(scripted.invocations).toHaveLength(0);
    expect(vectors.records).toHaveLength(0);
  });

  it("rejects a contaminated cross-scope vector result before resolving text", async () => {
    const repository = new InMemoryContentRepository(access);
    repository.sourceSpans.set(fixtureSpan.id, fixtureSpan);
    repository.activeGeneration = {
      adapterVersion: "scripted-adapter-v1",
      dimensions: EMBEDDING_DIMENSIONS,
      effectiveModel: "text-embedding-v4",
      effectiveModelVersion: "fixture-version-1",
      endpoint: "model-studio.example.invalid",
      generationId: "00000000-0000-5000-8000-000000000501",
      inputMode: "document",
      ownerScopeId: access.ownerScopeId,
      profileVersion: "embedding-v1",
      providerIdentifier: "model-studio",
      providerRequestIds: ["document-request-1"],
      region: "fixture-region-1",
      sourceDocumentId: access.sourceDocumentId,
      spanIds: [fixtureSpan.id],
    };
    const vectors = new InMemoryVectorStore();
    vectors.contaminatedResult = {
      distance: 0,
      embeddingInputHash: fixtureSpan.embeddingInputHash,
      generationId: repository.activeGeneration.generationId,
      ownerScopeId: "00000000-0000-4000-8000-000000000999",
      sourceDocumentId: access.sourceDocumentId,
      sourceSpanId: fixtureSpan.id,
    };
    const scripted = createScriptedAdapterRegistry({
      "embedding.query.v1": [
        {
          type: "result",
          value: {
            metadata: embeddingMetadata("query", "query-request-2"),
            vectors: [vector(0.2)],
          },
        },
      ],
    });
    const service = new RetrievalService({
      models: createModelRouter({
        adapters: scripted.adapters,
        traceSink: new InMemoryTraceSink(),
      }),
      repository,
      vectors,
    });

    await expect(
      service.search({
        authorization,
        courseId: access.courseId,
        deadlineMs: 5_000,
        limit: 5,
        query: "scope escape",
        sourceDocumentId: access.sourceDocumentId,
      }),
    ).rejects.toMatchObject({ code: "invalid_vector_result" });
  });

  it("requires a clean rebuild when the configured development embedding profile changes", async () => {
    const repository = new InMemoryContentRepository(access);
    repository.activeGeneration = {
      adapterVersion: "scripted-adapter-v1",
      dimensions: EMBEDDING_DIMENSIONS,
      effectiveModel: "local/test-embedding",
      effectiveModelVersion: "fixture-version-1",
      endpoint: "model-studio.example.invalid",
      generationId: "00000000-0000-5000-8000-000000000501",
      inputMode: "document",
      ownerScopeId: access.ownerScopeId,
      profileVersion: "litellm-dev-embedding-v1-aaaaaaaaaaaaaaaa",
      providerIdentifier: "model-studio",
      providerRequestIds: ["document-request-1"],
      region: "fixture-region-1",
      sourceDocumentId: access.sourceDocumentId,
      spanIds: [fixtureSpan.id],
    };
    const vectors = new InMemoryVectorStore();
    const scripted = createScriptedAdapterRegistry({
      "embedding.query.v1": [
        {
          type: "result",
          value: {
            metadata: embeddingMetadata("query", "query-request-profile"),
            vectors: [vector(0.2)],
          },
        },
      ],
    });
    const embedding = scripted.adapters.embedding["embedding-v1"]!;
    const service = new RetrievalService({
      models: createModelRouter({
        adapters: {
          ...scripted.adapters,
          embedding: {
            "embedding-v1": {
              ...embedding,
              descriptor: {
                ...embedding.descriptor,
                developmentOnly: true,
                driftCanaryPassed: false,
                effectiveModel: "local/test-embedding",
                embeddingProfileVersion:
                  "litellm-dev-embedding-v1-bbbbbbbbbbbbbbbb",
              },
            },
          },
        },
        deployment: "dev",
        traceSink: new InMemoryTraceSink(),
      }),
      repository,
      vectors,
    });

    await expect(
      service.search({
        authorization,
        courseId: access.courseId,
        deadlineMs: 5_000,
        limit: 5,
        query: "profile mismatch",
        sourceDocumentId: access.sourceDocumentId,
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      message:
        "active embedding profile is incompatible; rebuild the local generation before search",
    });
    expect(vectors.records).toHaveLength(0);
  });
});

function vector(value: number): readonly number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
}

function embeddingMetadata(
  inputMode: "document" | "query",
  providerRequestId: string,
) {
  return {
    dimensions: EMBEDDING_DIMENSIONS,
    endpoint: "model-studio.example.invalid",
    inputMode,
    providerIdentifier: "model-studio",
    providerRequestId,
    region: "fixture-region-1",
  } as const;
}
