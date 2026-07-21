import type { EmbeddingInput, EmbeddingResult } from "../contracts.js";
import {
  ModelAdapterError,
  type AdapterInvocation,
  type AdapterResponse,
  type EmbeddingModelPort,
} from "../ports.js";
import { EMBEDDING_V1_DIMENSIONS } from "../validation.js";

const MODEL = "text-embedding-v4";
const MAX_BATCH_SIZE = 10;
const PATH = "/api/v1/services/embeddings/text-embedding/text-embedding";
const REGION_SUFFIXES = {
  "ap-southeast-1": ".ap-southeast-1.maas.aliyuncs.com",
  "cn-beijing": ".cn-beijing.maas.aliyuncs.com",
  "cn-hongkong": ".cn-hongkong.maas.aliyuncs.com",
} as const;

type ModelStudioRegion = keyof typeof REGION_SUFFIXES;

export interface ModelStudioEmbeddingAdapterOptions {
  readonly adapterVersion: string;
  readonly apiKey: string;
  readonly driftCanaryPassed: boolean;
  readonly effectiveModelVersion: string;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly region: ModelStudioRegion;
}

export function createModelStudioEmbeddingAdapter(
  options: ModelStudioEmbeddingAdapterOptions,
): EmbeddingModelPort {
  const endpoint = validateOptions(options);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    descriptor: Object.freeze({
      adapterVersion: options.adapterVersion,
      capability: "embedding" as const,
      driftCanaryPassed: options.driftCanaryPassed,
      effectiveModel: MODEL,
      effectiveModelVersion: options.effectiveModelVersion,
      maxImmediateAttempts: 2,
      mediaSubmissionIdempotent: false,
      mutableAlias: true,
      selector: "embedding-v1",
    }),
    embed: async (invocation: AdapterInvocation): Promise<AdapterResponse> => {
      if (
        invocation.task !== "embedding.document.v1" &&
        invocation.task !== "embedding.query.v1"
      ) {
        throw adapterFailure("invalid_request", false);
      }
      const input = invocation.input as EmbeddingInput;
      if (
        !Array.isArray(input.texts) ||
        input.texts.length < 1 ||
        input.texts.length > MAX_BATCH_SIZE ||
        input.texts.some(
          (text) => typeof text !== "string" || text.length === 0,
        )
      ) {
        throw adapterFailure("invalid_request", false);
      }
      const inputMode =
        invocation.task === "embedding.document.v1" ? "document" : "query";
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          body: JSON.stringify({
            input: { texts: input.texts },
            model: MODEL,
            parameters: {
              dimension: EMBEDDING_V1_DIMENSIONS,
              output_type: "dense",
              text_type: inputMode,
            },
          }),
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: invocation.signal,
        });
      } catch (error) {
        throw adapterFailure(
          invocation.signal.aborted ? "timeout" : "unavailable",
          true,
          error,
        );
      }
      if (!response.ok) {
        throw adapterFailure(
          response.status === 401 || response.status === 403
            ? "authentication_failed"
            : response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "unavailable"
                : "request_rejected",
          response.status === 429 || response.status >= 500,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw adapterFailure("provider_error", false, error);
      }
      const parsed = parseResponse(payload, input.texts.length);
      const value: EmbeddingResult = {
        metadata: {
          dimensions: EMBEDDING_V1_DIMENSIONS,
          endpoint: endpoint.toString(),
          inputMode,
          providerIdentifier: "alibaba-model-studio",
          providerRequestId: parsed.requestId,
          region: options.region,
        },
        vectors: parsed.vectors,
      };
      return {
        usage:
          parsed.totalTokens === undefined
            ? undefined
            : { inputUnits: parsed.totalTokens },
        value,
      };
    },
  });
}

function parseResponse(
  payload: unknown,
  expectedCount: number,
): {
  readonly requestId: string;
  readonly totalTokens?: number;
  readonly vectors: readonly (readonly number[])[];
} {
  if (!isRecord(payload) || !isRecord(payload.output)) {
    throw adapterFailure("provider_error", false);
  }
  const requestId = payload.request_id;
  const embeddings = payload.output.embeddings;
  if (
    typeof requestId !== "string" ||
    requestId.length < 1 ||
    requestId.length > 256 ||
    !Array.isArray(embeddings) ||
    embeddings.length !== expectedCount
  ) {
    throw adapterFailure("provider_error", false);
  }
  const ordered: (readonly number[] | undefined)[] = Array.from({
    length: expectedCount,
  });
  for (const entry of embeddings) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.text_index) ||
      (entry.text_index as number) < 0 ||
      (entry.text_index as number) >= expectedCount ||
      ordered[entry.text_index as number] !== undefined ||
      !Array.isArray(entry.embedding) ||
      entry.embedding.length !== EMBEDDING_V1_DIMENSIONS ||
      entry.embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      throw adapterFailure("provider_error", false);
    }
    ordered[entry.text_index as number] = entry.embedding as readonly number[];
  }
  if (ordered.some((vector) => vector === undefined)) {
    throw adapterFailure("provider_error", false);
  }
  const totalTokens =
    isRecord(payload.usage) &&
    Number.isSafeInteger(payload.usage.total_tokens) &&
    (payload.usage.total_tokens as number) >= 0
      ? (payload.usage.total_tokens as number)
      : undefined;
  return {
    requestId,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    vectors: ordered as readonly (readonly number[])[],
  };
}

function validateOptions(options: ModelStudioEmbeddingAdapterOptions): URL {
  if (
    !options.enabled ||
    !options.driftCanaryPassed ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(options.adapterVersion) ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(options.effectiveModelVersion) ||
    options.apiKey.length < 8 ||
    /\s/.test(options.apiKey)
  ) {
    throw new Error("Model Studio embedding adapter is unavailable");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error("Model Studio embedding endpoint is invalid");
  }
  const suffix = REGION_SUFFIXES[options.region];
  const workspace = endpoint.hostname.slice(0, -suffix.length);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.port !== "" ||
    endpoint.pathname !== PATH ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    !endpoint.hostname.endsWith(suffix) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(workspace)
  ) {
    throw new Error("Model Studio embedding endpoint is invalid");
  }
  return endpoint;
}

function adapterFailure(
  safeCode: ConstructorParameters<typeof ModelAdapterError>[0]["safeCode"],
  transient: boolean,
  cause?: unknown,
): ModelAdapterError {
  return new ModelAdapterError({ cause, safeCode, transient });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
