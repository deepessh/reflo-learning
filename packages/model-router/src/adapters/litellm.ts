import { createHash } from "node:crypto";

import type {
  ModelTaskId,
  ModelTaskInput,
  QuizGenerationInput,
  ShortAnswerGradingInput,
} from "../contracts.js";
import {
  ModelAdapterError,
  type AdapterDescriptor,
  type AdapterInvocation,
  type AdapterResponse,
  type DialogueModelPort,
  type EmbeddingModelPort,
  type GradingModelPort,
  type GroundedGenerationPort,
  type ModelAdapterRegistry,
  type ModelCapability,
  type StructuredModelPort,
} from "../ports.js";
import { EMBEDDING_V1_DIMENSIONS } from "../validation.js";

export const LITELLM_DEV_TEXT_ADAPTER_VERSION =
  "litellm-openai-compatible-dev-text-v2" as const;
export const LITELLM_DEV_EMBEDDING_ADAPTER_VERSION =
  "litellm-openai-compatible-dev-v1" as const;
export const LITELLM_DEV_ADAPTER_VERSION = LITELLM_DEV_TEXT_ADAPTER_VERSION;

const MAX_BATCH_SIZE = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TEXT_MODEL_VERSION = "mutable-development-alias";

const TEXT_TASKS = {
  dialogue: new Set<ModelTaskId>(["tutor.answer.v1"]),
  grading: new Set<ModelTaskId>(["assessment.grade-short-answer.v1"]),
  grounded_generation: new Set<ModelTaskId>([
    "lesson.audio-script.v1",
    "lesson.reteach.v1",
    "lesson.text.v1",
  ]),
  structured: new Set<ModelTaskId>([
    "assessment.quiz.v1",
    "curriculum.segment.v1",
    "curriculum.structure.v1",
  ]),
} as const;

export interface LiteLlmDevEnvironment {
  readonly REFLO_ENV?: string;
  readonly REFLO_LITELLM_API_KEY?: string;
  readonly REFLO_LITELLM_BASE_URL?: string;
  readonly REFLO_LITELLM_EMBEDDING_MODEL?: string;
  readonly REFLO_LITELLM_TEXT_MODEL?: string;
}

export interface LiteLlmDevAdapters {
  readonly adapters: ModelAdapterRegistry;
  readonly embeddingProfileVersion: string;
}

export function createLiteLlmDevAdapters(
  environment: LiteLlmDevEnvironment,
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): LiteLlmDevAdapters {
  const configuration = readConfiguration(environment);
  const client = new LiteLlmHttpClient(
    configuration,
    options.fetch ?? globalThis.fetch,
  );
  const embeddingProfileVersion = developmentEmbeddingProfile(
    configuration.baseUrl,
    configuration.embeddingModel,
  );

  const structured = textDescriptor(
    "structured",
    "qwen.structured",
    configuration.textModel,
  );
  const groundedGeneration = textDescriptor(
    "grounded_generation",
    "qwen.grounded-generation",
    configuration.textModel,
  );
  const grading = textDescriptor(
    "grading",
    "qwen.grading",
    configuration.textModel,
  );
  const dialogue = textDescriptor(
    "dialogue",
    "qwen.dialogue",
    configuration.textModel,
  );
  const embedding: AdapterDescriptor = Object.freeze({
    adapterVersion: LITELLM_DEV_EMBEDDING_ADAPTER_VERSION,
    capability: "embedding",
    developmentOnly: true,
    driftCanaryPassed: false,
    embeddingProfileVersion,
    effectiveModel: configuration.embeddingModel,
    effectiveModelVersion: embeddingProfileVersion,
    maxImmediateAttempts: 1,
    mediaSubmissionIdempotent: false,
    mutableAlias: true,
    selector: "embedding-v1",
  });

  return Object.freeze({
    adapters: Object.freeze({
      dialogue: Object.freeze({
        "qwen.dialogue": Object.freeze<DialogueModelPort>({
          answerGrounded: (invocation) =>
            client.complete("dialogue", invocation),
          descriptor: dialogue,
        }),
      }),
      embedding: Object.freeze({
        "embedding-v1": Object.freeze<EmbeddingModelPort>({
          descriptor: embedding,
          embed: (invocation) => client.embed(invocation),
        }),
      }),
      grading: Object.freeze({
        "qwen.grading": Object.freeze<GradingModelPort>({
          descriptor: grading,
          grade: (invocation) => client.complete("grading", invocation),
        }),
      }),
      groundedGeneration: Object.freeze({
        "qwen.grounded-generation": Object.freeze<GroundedGenerationPort>({
          descriptor: groundedGeneration,
          generateGrounded: (invocation) =>
            client.complete("grounded_generation", invocation),
        }),
      }),
      speech: Object.freeze({}),
      structured: Object.freeze({
        "qwen.structured": Object.freeze<StructuredModelPort>({
          descriptor: structured,
          executeStructured: (invocation) =>
            client.complete("structured", invocation),
        }),
      }),
      video: Object.freeze({}),
    }),
    embeddingProfileVersion,
  });
}

interface LiteLlmConfiguration {
  readonly apiKey: string;
  readonly baseUrl: URL;
  readonly embeddingModel: string;
  readonly textModel: string;
}

class LiteLlmHttpClient {
  constructor(
    private readonly configuration: LiteLlmConfiguration,
    private readonly fetchImplementation: typeof globalThis.fetch,
  ) {}

  async complete(
    capability: keyof typeof TEXT_TASKS,
    invocation: AdapterInvocation,
  ): Promise<AdapterResponse> {
    if (!TEXT_TASKS[capability].has(invocation.task)) {
      throw adapterFailure("invalid_request", false);
    }
    const prompt = invocation.prompt;
    if (prompt === undefined) {
      throw adapterFailure("invalid_request", false);
    }
    const response = await this.request(
      "chat/completions",
      {
        messages: [
          {
            content: JSON.stringify({
              fixedInstructions: prompt.fixedInstructions,
              generationParametersVersion: prompt.generationParametersVersion,
              outputContract: prompt.outputContract,
              outputSchemaId: prompt.outputSchemaId,
              promptDigest: prompt.digest,
              promptId: prompt.id,
              promptVersion: prompt.version,
              task: invocation.task,
              tools: prompt.tools,
            }),
            role: "system",
          },
          {
            content: JSON.stringify({
              learnerAnswer: prompt.learnerAnswer ?? null,
              sourceMaterial: prompt.sourceMaterial,
              typedInput: withoutUntrustedPromptFields(invocation.input),
            }),
            role: "user",
          },
        ],
        model: this.configuration.textModel,
        response_format: responseFormat(invocation),
        stream: false,
        ...allowedGenerationParameters(prompt.generationParameters),
      },
      invocation.signal,
    );
    const parsed = parseChatResponse(response.payload);
    return {
      identity: providerIdentity(response, parsed.model),
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
      value: parsed.value,
    };
  }

  async embed(invocation: AdapterInvocation): Promise<AdapterResponse> {
    if (
      invocation.task !== "embedding.document.v1" &&
      invocation.task !== "embedding.query.v1"
    ) {
      throw adapterFailure("invalid_request", false);
    }
    const input = invocation.input as { readonly texts?: readonly string[] };
    if (
      !Array.isArray(input.texts) ||
      input.texts.length < 1 ||
      input.texts.length > MAX_BATCH_SIZE ||
      input.texts.some((text) => typeof text !== "string" || text.length === 0)
    ) {
      throw adapterFailure("invalid_request", false);
    }
    const response = await this.request(
      "embeddings",
      {
        dimensions: EMBEDDING_V1_DIMENSIONS,
        encoding_format: "float",
        input: input.texts,
        model: this.configuration.embeddingModel,
      },
      invocation.signal,
    );
    const parsed = parseEmbeddingResponse(response.payload, input.texts.length);
    const inputMode =
      invocation.task === "embedding.document.v1" ? "document" : "query";
    return {
      identity: providerIdentity(response, parsed.model),
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
      value: {
        metadata: {
          dimensions: EMBEDDING_V1_DIMENSIONS,
          endpoint: response.endpoint,
          inputMode,
          providerIdentifier: "litellm-development",
          providerRequestId:
            providerIdentity(response, parsed.model).providerRequestId ??
            "not-provided",
          region: "local-development",
        },
        vectors: parsed.vectors,
      },
    };
  }

  private async request(
    path: "chat/completions" | "embeddings",
    body: unknown,
    signal: AbortSignal,
  ): Promise<ParsedHttpResponse> {
    const endpoint = new URL(`v1/${path}`, this.configuration.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImplementation(endpoint, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${this.configuration.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal,
      });
    } catch {
      throw adapterFailure(signal.aborted ? "timeout" : "unavailable", true);
    }
    if (!response.ok) {
      throw statusFailure(response.status);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      throw adapterFailure("provider_error", false);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw adapterFailure("provider_error", false);
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw adapterFailure("provider_error", false);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw adapterFailure("provider_error", false);
    }
    return {
      endpoint: endpoint.toString(),
      headerRequestId: safeMetadata(response.headers.get("x-request-id")),
      payload,
    };
  }
}

interface ParsedHttpResponse {
  readonly endpoint: string;
  readonly headerRequestId?: string;
  readonly payload: unknown;
}

function parseChatResponse(payload: unknown): {
  readonly model?: string;
  readonly usage?: AdapterResponse["usage"];
  readonly value: unknown;
} {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw adapterFailure("provider_error", false);
  }
  const choice = payload.choices[0];
  if (
    payload.choices.length !== 1 ||
    !isRecord(choice) ||
    choice.index !== 0 ||
    !isRecord(choice.message) ||
    choice.message.role !== "assistant" ||
    typeof choice.message.content !== "string"
  ) {
    throw adapterFailure("provider_error", false);
  }
  let value: unknown;
  try {
    value = JSON.parse(choice.message.content);
  } catch {
    throw adapterFailure("provider_error", false);
  }
  if (!isRecord(value)) {
    throw adapterFailure("provider_error", false);
  }
  return {
    model: safeMetadata(payload.model),
    usage: parseUsage(payload.usage),
    value,
  };
}

function parseEmbeddingResponse(
  payload: unknown,
  expectedCount: number,
): {
  readonly model?: string;
  readonly usage?: AdapterResponse["usage"];
  readonly vectors: readonly (readonly number[])[];
} {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw adapterFailure("provider_error", false);
  }
  const ordered: (readonly number[] | undefined)[] = Array.from({
    length: expectedCount,
  });
  for (const entry of payload.data) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.index) ||
      (entry.index as number) < 0 ||
      (entry.index as number) >= expectedCount ||
      ordered[entry.index as number] !== undefined ||
      !Array.isArray(entry.embedding) ||
      entry.embedding.length !== EMBEDDING_V1_DIMENSIONS ||
      entry.embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      throw adapterFailure("provider_error", false);
    }
    ordered[entry.index as number] = entry.embedding as readonly number[];
  }
  if (ordered.some((entry) => entry === undefined)) {
    throw adapterFailure("provider_error", false);
  }
  return {
    model: safeMetadata(payload.model),
    usage: parseUsage(payload.usage),
    vectors: ordered as readonly (readonly number[])[],
  };
}

function parseUsage(value: unknown): AdapterResponse["usage"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputUnits = nonNegativeInteger(value.prompt_tokens);
  const outputUnits = nonNegativeInteger(value.completion_tokens);
  if (inputUnits === undefined && outputUnits === undefined) {
    return undefined;
  }
  return {
    ...(inputUnits === undefined ? {} : { inputUnits }),
    ...(outputUnits === undefined ? {} : { outputUnits }),
  };
}

function providerIdentity(
  response: ParsedHttpResponse,
  model: string | undefined,
): NonNullable<AdapterResponse["identity"]> {
  const payloadRequestId = isRecord(response.payload)
    ? safeMetadata(response.payload.id)
    : undefined;
  return {
    ...(model === undefined ? {} : { effectiveModel: model }),
    ...(response.headerRequestId === undefined && payloadRequestId === undefined
      ? {}
      : {
          providerRequestId: response.headerRequestId ?? payloadRequestId,
        }),
  };
}

function allowedGenerationParameters(
  parameters: Readonly<Record<string, boolean | number | string>>,
): Readonly<Record<string, number>> {
  const temperature = parameters.temperature;
  return typeof temperature === "number" &&
    Number.isFinite(temperature) &&
    temperature >= 0 &&
    temperature <= 2
    ? { temperature }
    : {};
}

function withoutUntrustedPromptFields(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "answer" && key !== "sourceSpans",
    ),
  );
}

function readConfiguration(
  environment: LiteLlmDevEnvironment,
): LiteLlmConfiguration {
  if (environment.REFLO_ENV !== "dev") {
    throw new Error("LiteLLM adapters are available only when REFLO_ENV=dev");
  }
  const apiKey = requiredValue(
    environment.REFLO_LITELLM_API_KEY,
    "REFLO_LITELLM_API_KEY",
  );
  if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey)) {
    throw new Error("REFLO_LITELLM_API_KEY is invalid");
  }
  const textModel = modelAlias(
    environment.REFLO_LITELLM_TEXT_MODEL,
    "REFLO_LITELLM_TEXT_MODEL",
  );
  const embeddingModel = modelAlias(
    environment.REFLO_LITELLM_EMBEDDING_MODEL,
    "REFLO_LITELLM_EMBEDDING_MODEL",
  );
  const baseUrl = safeBaseUrl(
    requiredValue(environment.REFLO_LITELLM_BASE_URL, "REFLO_LITELLM_BASE_URL"),
  );
  return { apiKey, baseUrl, embeddingModel, textModel };
}

function safeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REFLO_LITELLM_BASE_URL is invalid");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("REFLO_LITELLM_BASE_URL is unsafe");
  }
  return url;
}

function modelAlias(value: string | undefined, name: string): string {
  const alias = requiredValue(value, name);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(alias)) {
    throw new Error(`${name} is invalid`);
  }
  return alias;
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function developmentEmbeddingProfile(baseUrl: URL, model: string): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        baseUrl: baseUrl.origin,
        dimensions: EMBEDDING_V1_DIMENSIONS,
        model,
        transport: LITELLM_DEV_EMBEDDING_ADAPTER_VERSION,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `litellm-dev-embedding-v1-${digest}`;
}

function textDescriptor(
  capability: Exclude<ModelCapability, "embedding" | "speech" | "video">,
  selector: string,
  model: string,
): AdapterDescriptor {
  return Object.freeze({
    adapterVersion: LITELLM_DEV_TEXT_ADAPTER_VERSION,
    capability,
    developmentOnly: true,
    driftCanaryPassed: false,
    effectiveModel: model,
    effectiveModelVersion: TEXT_MODEL_VERSION,
    maxImmediateAttempts: 1,
    mediaSubmissionIdempotent: false,
    mutableAlias: true,
    selector,
  });
}

type JsonSchema = Readonly<Record<string, unknown>>;

function responseFormat(invocation: AdapterInvocation):
  | { readonly type: "json_object" }
  | {
      readonly json_schema: {
        readonly name: string;
        readonly schema: JsonSchema;
        readonly strict: true;
      };
      readonly type: "json_schema";
    } {
  const schema = outputJsonSchema(invocation);
  if (schema === undefined) {
    return { type: "json_object" };
  }
  return {
    json_schema: {
      name: `reflo_${invocation.task.replaceAll(".", "_").replaceAll("-", "_")}`,
      schema,
      strict: true,
    },
    type: "json_schema",
  };
}

function outputJsonSchema(
  invocation: AdapterInvocation,
): JsonSchema | undefined {
  switch (invocation.task) {
    case "assessment.grade-short-answer.v1":
      return gradingJsonSchema(
        invocation.input as ModelTaskInput<"assessment.grade-short-answer.v1">,
      );
    case "assessment.quiz.v1":
      return quizJsonSchema(
        invocation.input as ModelTaskInput<"assessment.quiz.v1">,
      );
    case "curriculum.structure.v1":
      return curriculumJsonSchema(
        invocation.input as ModelTaskInput<"curriculum.structure.v1">,
      );
    case "curriculum.segment.v1":
      // The OpenAI-compatible strict schema dialect rejects a root union.
      // Keep the closed segment union in JSON mode and enforce it in
      // RESULT_VALIDATORS.
      return undefined;
    case "lesson.audio-script.v1":
      return audioScriptJsonSchema(
        invocation.input as ModelTaskInput<"lesson.audio-script.v1">,
      );
    case "lesson.reteach.v1":
      return lessonJsonSchema(
        invocation.input as ModelTaskInput<"lesson.reteach.v1">,
      );
    case "lesson.text.v1":
      return lessonJsonSchema(
        invocation.input as ModelTaskInput<"lesson.text.v1">,
        2_400,
      );
    case "tutor.answer.v1":
      // The OpenAI-compatible strict schema dialect rejects a root union. Keep
      // the dialogue union in JSON mode and enforce it in RESULT_VALIDATORS.
      return undefined;
    default:
      return undefined;
  }
}

function curriculumJsonSchema(
  input: ModelTaskInput<"curriculum.structure.v1">,
): JsonSchema {
  const sourceSpanId = authorizedIdSchema(
    input.sourceSpans.map((span) => span.id),
  );
  return exactObject({
    chapters: curriculumChaptersJsonSchema(sourceSpanId),
  });
}

function curriculumChaptersJsonSchema(sourceSpanId: JsonSchema): JsonSchema {
  return {
    items: exactObject({
      concepts: {
        items: exactObject({
          key: {
            pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
            type: "string",
          },
          name: nonEmptyStringSchema(),
          prerequisiteKeys: {
            items: {
              pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
              type: "string",
            },
            type: "array",
          },
          sourceSpanIds: nonEmptyArray(sourceSpanId),
        }),
        minItems: 1,
        type: "array",
      },
      sourceSpanIds: nonEmptyArray(sourceSpanId),
      title: nonEmptyStringSchema(),
    }),
    minItems: 1,
    type: "array",
  };
}

function lessonJsonSchema(
  input: ModelTaskInput<"lesson.reteach.v1" | "lesson.text.v1">,
  minimumContentCharacters = 1,
): JsonSchema {
  return exactObject({
    content: { minLength: minimumContentCharacters, type: "string" },
    sourceSpanIds: nonEmptyArray(
      authorizedIdSchema(input.sourceSpans.map((span) => span.id)),
    ),
    strategyTag: nonEmptyStringSchema(),
  });
}

function audioScriptJsonSchema(
  input: ModelTaskInput<"lesson.audio-script.v1">,
): JsonSchema {
  return exactObject({
    script: nonEmptyStringSchema(),
    sourceSpanIds: nonEmptyArray(
      authorizedIdSchema(input.sourceSpans.map((span) => span.id)),
    ),
  });
}

function quizJsonSchema(input: QuizGenerationInput): JsonSchema {
  const commonProperties = {
    conceptIds: nonEmptyArray(authorizedIdSchema(input.conceptIds)),
    difficulty: { enum: [1, 2, 3, 4, 5], type: "integer" },
    keyedAnswer: nonEmptyStringSchema(),
    prompt: nonEmptyStringSchema(),
    sourceSpanIds: nonEmptyArray(
      authorizedIdSchema(input.sourceSpans.map((span) => span.id)),
    ),
  } as const;
  const closedItem = exactObject({
    ...commonProperties,
    itemType: {
      enum: ["multiple_choice", "concept_linking"],
      type: "string",
    },
    responseOptions: {
      items: nonEmptyStringSchema(),
      minItems: 2,
      type: "array",
    },
  });
  const shortAnswerItem = exactObject({
    ...commonProperties,
    itemType: { enum: ["short_answer"], type: "string" },
    rubric: nonEmptyStringSchema(),
  });
  return exactObject({
    items: {
      items: { anyOf: [closedItem, shortAnswerItem] },
      maxItems: input.count,
      minItems: input.count,
      type: "array",
    },
  });
}

function gradingJsonSchema(input: ShortAnswerGradingInput): JsonSchema {
  const conceptId = authorizedIdSchema(
    input.rubrics.map((rubric) => rubric.conceptId),
  );
  const scored = (
    rubricBand: "correct" | "incorrect" | "partially_correct",
    score: 0 | 0.5 | 1,
  ) =>
    exactObject({
      conceptId,
      confidence: { maximum: 1, minimum: 0, type: "number" },
      judgmentKind: { enum: ["scored"], type: "string" },
      rubricBand: { enum: [rubricBand], type: "string" },
      score: { enum: [score], type: "number" },
    });
  const unanswerable = exactObject({
    conceptId,
    judgmentKind: { enum: ["unanswerable"], type: "string" },
    reason: {
      enum: [
        "source_insufficient",
        "source_conflict",
        "rubric_insufficient",
        "rubric_conflict",
      ],
      type: "string",
    },
  });
  return exactObject({
    judgments: {
      items: {
        anyOf: [
          scored("incorrect", 0),
          scored("partially_correct", 0.5),
          scored("correct", 1),
          unanswerable,
        ],
      },
      maxItems: input.rubrics.length,
      minItems: input.rubrics.length,
      type: "array",
    },
  });
}

function exactObject(
  properties: Readonly<Record<string, JsonSchema>>,
): JsonSchema {
  return {
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
    type: "object",
  };
}

function authorizedIdSchema(values: readonly string[]): JsonSchema {
  return { enum: [...new Set(values)], type: "string" };
}

function nonEmptyArray(items: JsonSchema): JsonSchema {
  return { items, minItems: 1, type: "array" };
}

function nonEmptyStringSchema(): JsonSchema {
  return { minLength: 1, type: "string" };
}

function statusFailure(status: number): ModelAdapterError {
  return adapterFailure(
    status === 401 || status === 403
      ? "authentication_failed"
      : status === 429
        ? "rate_limited"
        : status >= 500
          ? "unavailable"
          : "request_rejected",
    status === 429 || status >= 500,
  );
}

function adapterFailure(
  safeCode: ConstructorParameters<typeof ModelAdapterError>[0]["safeCode"],
  transient: boolean,
): ModelAdapterError {
  return new ModelAdapterError({ safeCode, transient });
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function safeMetadata(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\r\n]/.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
