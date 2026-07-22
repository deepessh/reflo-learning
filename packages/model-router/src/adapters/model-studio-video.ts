import type { VideoAssetResult, VideoGenerationInput } from "../contracts.js";
import {
  ModelAdapterError,
  type AdapterInvocation,
  type AdapterResponse,
  type VideoModelPort,
} from "../ports.js";

export const MODEL_STUDIO_VIDEO_ADAPTER_VERSION =
  "model-studio-wan-video-v1" as const;
export const WAN_2_7_MODEL = "wan2.7-t2v-2026-06-12" as const;

const SUBMISSION_PATH =
  "/api/v1/services/aigc/video-generation/video-synthesis";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_POLLS = 40;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const CLIP_DURATION_SECONDS = 15;
const REGION_SUFFIXES = {
  "ap-southeast-1": ".ap-southeast-1.maas.aliyuncs.com",
  "cn-beijing": ".cn-beijing.maas.aliyuncs.com",
} as const;

type ModelStudioVideoRegion = keyof typeof REGION_SUFFIXES;

export interface ModelStudioVideoAdapterOptions {
  readonly adapterVersion: typeof MODEL_STUDIO_VIDEO_ADAPTER_VERSION;
  readonly apiKey: string;
  readonly driftCanaryPassed: boolean;
  readonly effectiveModelVersion: typeof WAN_2_7_MODEL;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly model: typeof WAN_2_7_MODEL;
  readonly pollIntervalMs?: number;
  readonly region: ModelStudioVideoRegion;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createModelStudioVideoAdapter(
  options: ModelStudioVideoAdapterOptions,
): VideoModelPort {
  const endpoint = validateOptions(options);
  const client = new ModelStudioVideoClient(
    endpoint,
    options,
    options.fetch ?? globalThis.fetch,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    options.wait ?? abortableWait,
  );

  return Object.freeze({
    descriptor: Object.freeze({
      adapterVersion: options.adapterVersion,
      capability: "video" as const,
      driftCanaryPassed: options.driftCanaryPassed,
      effectiveModel: options.model,
      effectiveModelVersion: options.effectiveModelVersion,
      maxImmediateAttempts: 1,
      mediaSubmissionIdempotent: false,
      mutableAlias: false,
      selector: "wanx.video",
    }),
    generateVideo: (invocation: AdapterInvocation) =>
      client.generate(invocation),
  });
}

class ModelStudioVideoClient {
  constructor(
    private readonly endpoint: URL,
    private readonly options: ModelStudioVideoAdapterOptions,
    private readonly fetchImplementation: typeof globalThis.fetch,
    private readonly pollIntervalMs: number,
    private readonly wait: (
      milliseconds: number,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    if (
      !Number.isInteger(pollIntervalMs) ||
      pollIntervalMs < 0 ||
      pollIntervalMs > 60_000
    ) {
      throw new Error("Model Studio video poll interval is invalid");
    }
  }

  async generate(invocation: AdapterInvocation): Promise<AdapterResponse> {
    if (invocation.task !== "media.video.v1") {
      throw adapterFailure("invalid_request", false, "not_accepted");
    }
    const input = invocation.input as VideoGenerationInput;
    validateInput(input);
    const taskId = await this.submit(input, invocation.signal);
    const result = await this.poll(taskId, input, invocation.signal);
    return {
      identity: {
        effectiveModel: this.options.model,
        providerRequestId: taskId,
      },
      usage: { outputUnits: result.durationSeconds },
      value: result,
    };
  }

  private async submit(
    input: VideoGenerationInput,
    signal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        body: JSON.stringify({
          input: { prompt: input.visualBrief },
          model: this.options.model,
          parameters: {
            duration: CLIP_DURATION_SECONDS,
            prompt_extend: false,
            ratio: "16:9",
            resolution: "720P",
            watermark: true,
          },
        }),
        headers: this.headers({ "X-DashScope-Async": "enable" }),
        method: "POST",
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw requestFailure(error, "unknown");
    }
    if (!response.ok) {
      throw httpFailure(response.status, "not_accepted");
    }
    const payload = await readJson(response, "unknown");
    if (
      !isRecord(payload) ||
      !isSafeRequestId(payload.request_id) ||
      !isRecord(payload.output) ||
      !isSafeRequestId(payload.output.task_id) ||
      (payload.output.task_status !== "PENDING" &&
        payload.output.task_status !== "RUNNING")
    ) {
      throw adapterFailure("provider_error", false, "unknown");
    }
    return payload.output.task_id;
  }

  private async poll(
    taskId: string,
    input: VideoGenerationInput,
    signal: AbortSignal,
  ): Promise<VideoAssetResult> {
    const statusUrl = new URL(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      this.endpoint.origin,
    );
    for (let poll = 0; poll < MAX_STATUS_POLLS; poll += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(statusUrl, {
          headers: this.headers(),
          method: "GET",
          redirect: "error",
          signal,
        });
      } catch (error) {
        throw requestFailure(error, "accepted");
      }
      if (!response.ok) {
        throw httpFailure(response.status, "accepted");
      }
      const payload = await readJson(response, "accepted");
      if (
        !isRecord(payload) ||
        !isSafeRequestId(payload.request_id) ||
        !isRecord(payload.output) ||
        payload.output.task_id !== taskId
      ) {
        throw adapterFailure("provider_error", false, "accepted");
      }
      const status = payload.output.task_status;
      if (status === "SUCCEEDED") {
        return parseResult(payload, input);
      }
      if (status === "FAILED") {
        throw providerFailure(payload.output.code);
      }
      if (status === "CANCELED") {
        throw adapterFailure("request_rejected", false, "accepted");
      }
      if (status !== "PENDING" && status !== "RUNNING") {
        throw adapterFailure("provider_error", false, "accepted");
      }
      await this.wait(this.pollIntervalMs, signal).catch((error: unknown) => {
        throw requestFailure(error, "accepted");
      });
    }
    throw adapterFailure("timeout", true, "accepted");
  }

  private headers(additional: Readonly<Record<string, string>> = {}): Headers {
    return new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      ...additional,
    });
  }
}

function parseResult(
  payload: Record<string, unknown>,
  input: VideoGenerationInput,
): VideoAssetResult {
  if (!isRecord(payload.output) || !isRecord(payload.usage)) {
    throw adapterFailure("provider_error", false, "accepted");
  }
  const uri = safeMediaUrl(payload.output.video_url);
  const duration = payload.usage.output_video_duration;
  if (
    uri === null ||
    duration !== CLIP_DURATION_SECONDS ||
    payload.usage.duration !== CLIP_DURATION_SECONDS ||
    payload.usage.video_count !== 1 ||
    payload.usage.ratio !== "16:9" ||
    payload.usage.SR !== 720
  ) {
    throw adapterFailure("provider_error", false, "accepted");
  }
  return Object.freeze({
    durationSeconds: duration,
    mimeType: "video/mp4",
    sourceSpanIds: Object.freeze(input.sourceSpans.map((span) => span.id)),
    uri,
  });
}

function validateOptions(options: ModelStudioVideoAdapterOptions): URL {
  if (
    !options.enabled ||
    !options.driftCanaryPassed ||
    options.adapterVersion !== MODEL_STUDIO_VIDEO_ADAPTER_VERSION ||
    options.model !== WAN_2_7_MODEL ||
    options.effectiveModelVersion !== WAN_2_7_MODEL ||
    options.apiKey.length < 8 ||
    /\s/.test(options.apiKey)
  ) {
    throw new Error("Model Studio video adapter is unavailable");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error("Model Studio video endpoint is invalid");
  }
  const suffix = REGION_SUFFIXES[options.region];
  const workspace = endpoint.hostname.slice(0, -suffix.length);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.port !== "" ||
    endpoint.pathname !== SUBMISSION_PATH ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    !endpoint.hostname.endsWith(suffix) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(workspace)
  ) {
    throw new Error("Model Studio video endpoint is invalid");
  }
  return endpoint;
}

function validateInput(input: VideoGenerationInput): void {
  if (
    typeof input.conceptId !== "string" ||
    input.conceptId.length === 0 ||
    typeof input.visualBrief !== "string" ||
    input.visualBrief.length < 1 ||
    input.visualBrief.length > 5_000 ||
    !Array.isArray(input.sourceSpans) ||
    input.sourceSpans.length < 1 ||
    input.sourceSpans.some(
      (span) =>
        typeof span.id !== "string" ||
        span.id.length === 0 ||
        typeof span.text !== "string",
    )
  ) {
    throw adapterFailure("invalid_request", false, "not_accepted");
  }
}

async function readJson(
  response: Response,
  submissionState: "accepted" | "unknown",
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    throw adapterFailure("provider_error", false, submissionState);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw requestFailure(error, submissionState);
  }
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES
  ) {
    throw adapterFailure("provider_error", false, submissionState);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw adapterFailure("provider_error", false, submissionState);
  }
}

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      isAllowedModelStudioMediaLocation(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isAllowedModelStudioMediaLocation(hostname: string): boolean {
  return /^dashscope-[a-z0-9-]{1,128}\.oss-(?:accelerate|[a-z0-9-]{2,64})\.aliyuncs\.com$/i.test(
    hostname,
  );
}

function providerFailure(code: unknown): ModelAdapterError {
  const safeCode = safeCodeForProviderError(code);
  return adapterFailure(
    safeCode,
    [
      "rate_limited",
      "quota_exhausted",
      "capacity_unavailable",
      "timeout",
    ].includes(safeCode),
    "accepted",
  );
}

function safeCodeForProviderError(value: unknown): string {
  if (typeof value !== "string") return "provider_error";
  const normalized = value.toLowerCase();
  if (normalized.includes("throttl") || normalized.includes("rate")) {
    return "rate_limited";
  }
  if (normalized.includes("quota")) return "quota_exhausted";
  if (normalized.includes("capacity") || normalized.includes("allocation")) {
    return "capacity_unavailable";
  }
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("invalid") || normalized.includes("parameter")) {
    return "invalid_request";
  }
  return "provider_error";
}

function httpFailure(
  status: number,
  submissionState: "accepted" | "not_accepted",
): ModelAdapterError {
  if (status === 401 || status === 403) {
    return adapterFailure("authentication_failed", false, submissionState);
  }
  if (status === 400 || status === 404 || status === 422) {
    return adapterFailure("invalid_request", false, submissionState);
  }
  if (status === 429) {
    return adapterFailure("rate_limited", true, submissionState);
  }
  if (status === 408 || status === 504) {
    return adapterFailure("timeout", true, submissionState);
  }
  if (status >= 500) {
    return adapterFailure("unavailable", true, submissionState);
  }
  return adapterFailure("provider_error", false, submissionState);
}

function requestFailure(
  cause: unknown,
  submissionState: "accepted" | "unknown",
): ModelAdapterError {
  const timeout = cause instanceof DOMException && cause.name === "AbortError";
  return adapterFailure(
    timeout ? "timeout" : "unavailable",
    true,
    submissionState,
    cause,
  );
}

function adapterFailure(
  safeCode: string,
  transient: boolean,
  submissionState: "accepted" | "not_accepted" | "unknown",
  cause?: unknown,
): ModelAdapterError {
  return new ModelAdapterError({
    ...(cause === undefined ? {} : { cause }),
    safeCode,
    submissionState,
    transient,
  });
}

function isSafeRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortableWait(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
