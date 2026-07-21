import { describe, expect, it } from "vitest";

import { createModelStudioEmbeddingAdapter } from "./model-studio-embedding.js";
import { EMBEDDING_V1_DIMENSIONS } from "../validation.js";

const apiKey = "secret-api-key-fixture";
const endpoint =
  "https://workspace-1.ap-southeast-1.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";

describe("Model Studio embedding adapter", () => {
  it.each([
    ["embedding.document.v1", "document"],
    ["embedding.query.v1", "query"],
  ] as const)(
    "translates %s with its required text_type",
    async (task, inputMode) => {
      const requests: { readonly body: unknown; readonly headers: Headers }[] =
        [];
      const adapter = createModelStudioEmbeddingAdapter({
        adapterVersion: "model-studio-embedding-adapter-v1",
        apiKey,
        driftCanaryPassed: true,
        effectiveModelVersion: "canary-2026-07-21",
        enabled: true,
        endpoint,
        fetch: async (_input, init) => {
          requests.push({
            body: JSON.parse(String(init?.body)),
            headers: new Headers(init?.headers),
          });
          return Response.json({
            output: {
              embeddings: [
                {
                  embedding: vector(0.25),
                  text_index: 0,
                },
              ],
            },
            request_id: "provider-request-1",
            usage: { total_tokens: 12 },
          });
        },
        region: "ap-southeast-1",
      });

      const response = await adapter.embed({
        input: { texts: ["source text"] },
        signal: new AbortController().signal,
        task,
      });

      expect(requests[0]?.body).toEqual({
        input: { texts: ["source text"] },
        model: "text-embedding-v4",
        parameters: {
          dimension: 1024,
          output_type: "dense",
          text_type: inputMode,
        },
      });
      expect(requests[0]?.headers.get("Authorization")).toBe(
        `Bearer ${apiKey}`,
      );
      expect(response).toMatchObject({
        usage: { inputUnits: 12 },
        value: {
          metadata: {
            dimensions: 1024,
            endpoint,
            inputMode,
            providerIdentifier: "alibaba-model-studio",
            providerRequestId: "provider-request-1",
            region: "ap-southeast-1",
          },
        },
      });
    },
  );

  it("is unavailable until enabled with a passing drift canary", () => {
    for (const options of [
      { driftCanaryPassed: false, enabled: true },
      { driftCanaryPassed: true, enabled: false },
    ]) {
      expect(() =>
        createModelStudioEmbeddingAdapter({
          adapterVersion: "adapter-v1",
          apiKey,
          effectiveModelVersion: "model-v1",
          endpoint,
          fetch,
          region: "ap-southeast-1",
          ...options,
        }),
      ).toThrow("unavailable");
    }
  });

  it("rejects endpoints outside the selected regional workspace boundary", () => {
    expect(() =>
      createModelStudioEmbeddingAdapter({
        adapterVersion: "adapter-v1",
        apiKey,
        driftCanaryPassed: true,
        effectiveModelVersion: "model-v1",
        enabled: true,
        endpoint: "https://attacker.invalid/embedding",
        fetch,
        region: "ap-southeast-1",
      }),
    ).toThrow("endpoint is invalid");
  });

  it("normalizes provider failures without exposing response bodies or credentials", async () => {
    const providerBody = `private source ${apiKey}`;
    const adapter = createModelStudioEmbeddingAdapter({
      adapterVersion: "adapter-v1",
      apiKey,
      driftCanaryPassed: true,
      effectiveModelVersion: "model-v1",
      enabled: true,
      endpoint,
      fetch: async () => new Response(providerBody, { status: 500 }),
      region: "ap-southeast-1",
    });

    let thrown: unknown;
    try {
      await adapter.embed({
        input: { texts: ["private source"] },
        signal: new AbortController().signal,
        task: "embedding.document.v1",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ safeCode: "unavailable", transient: true });
    expect(JSON.stringify(thrown)).not.toContain(apiKey);
    expect(JSON.stringify(thrown)).not.toContain(providerBody);
  });
});

function vector(value: number): readonly number[] {
  return Array.from({ length: EMBEDDING_V1_DIMENSIONS }, () => value);
}
