import { describe, expect, it } from "vitest";

import type { ModelTaskId, ModelTaskInput } from "../contracts.js";
import { createModelRouter } from "../router.js";
import { InMemoryTraceSink } from "../testing.js";
import { EMBEDDING_V1_DIMENSIONS } from "../validation.js";
import {
  createLiteLlmDevAdapters,
  type LiteLlmDevEnvironment,
} from "./litellm.js";

const environment: LiteLlmDevEnvironment = {
  REFLO_ENV: "dev",
  REFLO_LITELLM_API_KEY: "dev-only-placeholder",
  REFLO_LITELLM_BASE_URL: "http://127.0.0.1:4000",
  REFLO_LITELLM_EMBEDDING_MODEL: "local/test-embedding",
  REFLO_LITELLM_TEXT_MODEL: "local/test-text",
};

describe("LiteLLM development adapters", () => {
  it("rejects staging, pilot, and unsafe non-loopback HTTP configuration", () => {
    for (const deployment of ["staging", "pilot"]) {
      expect(() =>
        createLiteLlmDevAdapters({ ...environment, REFLO_ENV: deployment }),
      ).toThrow("only when REFLO_ENV=dev");
    }
    for (const baseUrl of [
      "http://gateway.example.com:4000",
      "http://127.0.0.1:4000/admin",
      "http://user:password@127.0.0.1:4000",
    ]) {
      expect(() =>
        createLiteLlmDevAdapters({
          ...environment,
          REFLO_LITELLM_BASE_URL: baseUrl,
        }),
      ).toThrow("REFLO_LITELLM_BASE_URL is unsafe");
    }
    for (const override of [
      { REFLO_LITELLM_API_KEY: "short" },
      { REFLO_LITELLM_TEXT_MODEL: "unsafe model alias" },
      { REFLO_LITELLM_EMBEDDING_MODEL: "" },
    ]) {
      expect(() =>
        createLiteLlmDevAdapters({ ...environment, ...override }),
      ).toThrow();
    }
  });

  it.each(textFixtures())(
    "translates the $capability port without exposing a generic completion API",
    async ({ input, task, value }) => {
      const requests: Array<{ readonly body: Record<string, unknown> }> = [];
      const adapters = createLiteLlmDevAdapters(environment, {
        fetch: async (_url, init) => {
          requests.push({ body: JSON.parse(String(init?.body)) });
          return chatResponse(value, {
            model: "resolved/local-text-v2",
            requestId: `request-${task}`,
          });
        },
      });
      const traces = new InMemoryTraceSink();
      const router = createModelRouter({
        adapters: adapters.adapters,
        deployment: "dev",
        traceSink: traces,
      });

      const result = await router.execute(task, input as never, {
        deadlineMs: 1_000,
      });

      expect(result.value).toEqual(value);
      expect(result.provenance).toMatchObject({
        configuredModel: "local/test-text",
        effectiveModel: "resolved/local-text-v2",
        evidenceClassification: "development_only",
        providerRequestId: `request-${task}`,
      });
      expect(traces.traces[0]?.attempts[0]).toMatchObject({
        effectiveModel: "resolved/local-text-v2",
        usage: { inputUnits: 17, outputUnits: 5 },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({
        model: "local/test-text",
        response_format: { type: "json_object" },
        stream: false,
      });
      const messages = requests[0]?.body.messages as Array<{
        readonly content: string;
        readonly role: string;
      }>;
      const system = JSON.parse(messages[0]?.content ?? "null");
      const user = JSON.parse(messages[1]?.content ?? "null");
      expect(messages.map((message) => message.role)).toEqual([
        "system",
        "user",
      ]);
      expect(system.fixedInstructions).toBeInstanceOf(Array);
      expect(system.outputContract).toEqual(
        expect.stringMatching(/^Return exactly this JSON shape/),
      );
      expect(system).not.toHaveProperty("sourceMaterial");
      expect(user.sourceMaterial).toEqual(
        "sourceSpans" in input ? input.sourceSpans : [],
      );
      expect(user.typedInput).not.toHaveProperty("sourceSpans");
      expect(user.typedInput).not.toHaveProperty("answer");
    },
  );

  it("lets the typed router reject malformed grading and unauthorized spans", async () => {
    for (const fixture of [
      {
        input: textFixtures()[0]!.input,
        task: "curriculum.structure.v1" as const,
        value: { chapters: "malformed" },
      },
      {
        input: textFixtures()[2]!.input,
        task: "assessment.grade-short-answer.v1" as const,
        value: {
          evidence: [
            {
              conceptId: "unauthorized-concept",
              confidence: 0.99,
              rubricBand: "correct",
              score: 1,
            },
          ],
        },
      },
      {
        input: textFixtures()[0]!.input,
        task: "curriculum.structure.v1" as const,
        value: {
          chapters: [
            {
              concepts: [
                {
                  key: "networking",
                  name: "Networking",
                  prerequisiteKeys: [],
                  sourceSpanIds: ["span-not-authorized"],
                },
              ],
              sourceSpanIds: ["span-not-authorized"],
              title: "Networking",
            },
          ],
        },
      },
    ]) {
      const adapters = createLiteLlmDevAdapters(environment, {
        fetch: async () => chatResponse(fixture.value),
      });
      await expect(
        createModelRouter({
          adapters: adapters.adapters,
          deployment: "dev",
          traceSink: new InMemoryTraceSink(),
        }).execute(fixture.task, fixture.input as never, { deadlineMs: 1_000 }),
      ).rejects.toMatchObject({ code: "invalid_result" });
    }
  });

  it("rejects malformed JSON content and sanitizes provider failures", async () => {
    const secret = "private source and dev-only-placeholder";
    for (const response of [
      () =>
        Response.json({
          choices: [
            {
              index: 0,
              message: { content: "```json\n{}\n```", role: "assistant" },
            },
          ],
        }),
      () => new Response(secret, { status: 500 }),
    ]) {
      const adapters = createLiteLlmDevAdapters(environment, {
        fetch: async () => response(),
      });
      let thrown: unknown;
      try {
        await createModelRouter({
          adapters: adapters.adapters,
          deployment: "dev",
          traceSink: new InMemoryTraceSink(),
        }).execute("tutor.answer.v1", textFixtures()[3]!.input as never, {
          deadlineMs: 1_000,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "provider_failure" });
      expect(JSON.stringify(thrown)).not.toContain(secret);
    }
  });

  it("requests and requires one ordered 1024-dimensional embedding per input", async () => {
    const requests: Record<string, unknown>[] = [];
    const adapters = createLiteLlmDevAdapters(environment, {
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(
          {
            data: [
              { embedding: vector(0.2), index: 1 },
              { embedding: vector(0.1), index: 0 },
            ],
            model: "resolved/local-embedding-v3",
            usage: { prompt_tokens: 21, total_tokens: 21 },
          },
          { headers: { "x-request-id": "embedding-request-1" } },
        );
      },
    });
    const result = await createModelRouter({
      adapters: adapters.adapters,
      deployment: "dev",
      traceSink: new InMemoryTraceSink(),
    }).execute(
      "embedding.document.v1",
      { texts: ["first", "second"] },
      { deadlineMs: 1_000 },
    );

    expect(requests[0]).toEqual({
      dimensions: 1024,
      encoding_format: "float",
      input: ["first", "second"],
      model: "local/test-embedding",
    });
    expect(result.value.vectors).toEqual([vector(0.1), vector(0.2)]);
    expect(result.provenance).toMatchObject({
      configuredModel: "local/test-embedding",
      effectiveModel: "resolved/local-embedding-v3",
      embeddingProfileVersion: adapters.embeddingProfileVersion,
      evidenceClassification: "development_only",
      providerRequestId: "embedding-request-1",
    });
    expect(result.value.metadata).toMatchObject({
      dimensions: 1024,
      inputMode: "document",
      providerIdentifier: "litellm-development",
      providerRequestId: "embedding-request-1",
      region: "local-development",
    });
  });

  it.each([
    [],
    [{ embedding: [0.1, 0.2], index: 0 }],
    [
      { embedding: vector(0.1), index: 0 },
      { embedding: vector(0.2), index: 1 },
    ],
  ])("rejects wrong embedding count or dimensions", async (data) => {
    const adapters = createLiteLlmDevAdapters(environment, {
      fetch: async () => Response.json({ data, model: "embedding-model" }),
    });
    await expect(
      createModelRouter({
        adapters: adapters.adapters,
        deployment: "dev",
        traceSink: new InMemoryTraceSink(),
      }).execute(
        "embedding.query.v1",
        { texts: ["query"] },
        { deadlineMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it("fails closed if a development adapter reaches staging or pilot routing", async () => {
    const adapters = createLiteLlmDevAdapters(environment, {
      fetch: async () => {
        throw new Error("must not call LiteLLM");
      },
    });
    for (const deployment of ["staging", "pilot"] as const) {
      await expect(
        createModelRouter({
          adapters: adapters.adapters,
          deployment,
          traceSink: new InMemoryTraceSink(),
        }).execute("tutor.answer.v1", textFixtures()[3]!.input as never, {
          deadlineMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "invalid_adapter_configuration" });
    }
  });

  it("changes the isolated development embedding profile with model or endpoint", () => {
    const original = createLiteLlmDevAdapters(environment);
    const changedModel = createLiteLlmDevAdapters({
      ...environment,
      REFLO_LITELLM_EMBEDDING_MODEL: "local/different-embedding",
    });
    const changedEndpoint = createLiteLlmDevAdapters({
      ...environment,
      REFLO_LITELLM_BASE_URL: "http://127.0.0.1:4001",
    });

    expect(original.embeddingProfileVersion).toMatch(
      /^litellm-dev-embedding-v1-[a-f0-9]{16}$/,
    );
    expect(changedModel.embeddingProfileVersion).not.toBe(
      original.embeddingProfileVersion,
    );
    expect(changedEndpoint.embeddingProfileVersion).not.toBe(
      original.embeddingProfileVersion,
    );
    expect(original.embeddingProfileVersion).not.toBe("embedding-v1");
  });
});

function textFixtures(): readonly {
  readonly capability: string;
  readonly input: ModelTaskInput<ModelTaskId>;
  readonly task: ModelTaskId;
  readonly value: unknown;
}[] {
  const sourceSpans = [{ id: "span-1", text: "A VPC is isolated." }];
  return [
    {
      capability: "structured generation",
      input: { courseTitle: "Cloud", sourceSpans },
      task: "curriculum.structure.v1",
      value: {
        chapters: [
          {
            concepts: [
              {
                key: "vpc",
                name: "VPC",
                prerequisiteKeys: [],
                sourceSpanIds: ["span-1"],
              },
            ],
            sourceSpanIds: ["span-1"],
            title: "Networking",
          },
        ],
      },
    },
    {
      capability: "grounded generation",
      input: { conceptId: "vpc", conceptName: "VPC", sourceSpans },
      task: "lesson.text.v1",
      value: {
        content: "A VPC is an isolated network.",
        sourceSpanIds: ["span-1"],
        strategyTag: "definition-v1",
      },
    },
    {
      capability: "grading",
      input: {
        answer: "An isolated network",
        conceptIds: ["vpc"],
        question: "What is a VPC?",
        rubric: "Defines network isolation",
        sourceSpans,
      },
      task: "assessment.grade-short-answer.v1",
      value: {
        evidence: [
          {
            conceptId: "vpc",
            confidence: 0.99,
            rubricBand: "correct",
            score: 1,
          },
        ],
      },
    },
    {
      capability: "dialogue",
      input: { question: "What is a VPC?", sourceSpans },
      task: "tutor.answer.v1",
      value: {
        content: "A VPC is an isolated network.",
        kind: "answer",
        sourceSpanIds: ["span-1"],
      },
    },
  ];
}

function chatResponse(
  value: unknown,
  options: { readonly model?: string; readonly requestId?: string } = {},
): Response {
  return Response.json(
    {
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { content: JSON.stringify(value), role: "assistant" },
        },
      ],
      id: options.requestId ?? "chat-request-1",
      model: options.model ?? "resolved/local-model",
      usage: { completion_tokens: 5, prompt_tokens: 17, total_tokens: 22 },
    },
    {
      headers:
        options.requestId === undefined
          ? undefined
          : { "x-request-id": options.requestId },
    },
  );
}

function vector(value: number): readonly number[] {
  return Array.from({ length: EMBEDDING_V1_DIMENSIONS }, () => value);
}
