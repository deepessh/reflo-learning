import { createHash } from "node:crypto";

import type { ModelTaskId } from "../contracts.js";
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

export const LITELLM_DEV_ADAPTER_VERSION =
  "litellm-openai-compatible-dev-v1" as const;

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
    "curriculum.structure.v1",
  ]),
} as const;

const TEXT_OUTPUT_CONTRACTS = Object.freeze({
  "assessment.grade-short-answer.v1":
    '{"evidence":[{"conceptId":string,"confidence":number,"rubricBand":string,"score":number}]}',
  "assessment.quiz.v1":
    '{"items":[{"conceptIds":string[],"difficulty":1|2|3|4|5,"itemType":"multiple_choice"|"short_answer"|"concept_linking","keyedAnswer":string,"prompt":string,"sourceSpanIds":string[],"responseOptions"?:string[],"rubric"?:string}]}',
  "curriculum.structure.v1":
    '{"chapters":[{"concepts":[{"key":string,"name":string,"prerequisiteKeys":string[],"sourceSpanIds":string[]}],"sourceSpanIds":string[],"title":string}]}',
  "lesson.audio-script.v1": '{"script":string,"sourceSpanIds":string[]}',
  "lesson.reteach.v1":
    '{"content":string,"sourceSpanIds":string[],"strategyTag":string}',
  "lesson.text.v1":
    '{"content":string (400-600 words),"sourceSpanIds":string[],"strategyTag":string}',
  "tutor.answer.v1":
    '{"kind":"answer","content":string,"sourceSpanIds":string[]} | {"kind":"not_found","reason":string}',
} as const satisfies Partial<Record<ModelTaskId, string>>);

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
    adapterVersion: LITELLM_DEV_ADAPTER_VERSION,
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
              outputSchemaId: prompt.outputSchemaId,
              outputContract: textOutputContract(invocation.task),
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
        response_format: { type: "json_object" },
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

function textOutputContract(task: ModelTaskId): string {
  const contract =
    TEXT_OUTPUT_CONTRACTS[task as keyof typeof TEXT_OUTPUT_CONTRACTS];
  if (contract === undefined) {
    throw adapterFailure("invalid_request", false);
  }
  const requirements =
    task === "lesson.text.v1"
      ? " The content string must contain 400 to 600 words; fewer than 400 or more than 600 words is invalid."
      : "";
  return `Return exactly this JSON shape with no additional keys: ${contract}.${requirements}`;
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
        transport: LITELLM_DEV_ADAPTER_VERSION,
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
    adapterVersion: LITELLM_DEV_ADAPTER_VERSION,
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
