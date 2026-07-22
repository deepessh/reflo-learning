import type { VideoGenerationInput, VideoAssetResult } from "../contracts.js";
import {
  ModelAdapterError,
  type AdapterInvocation,
  type AdapterResponse,
  type VideoModelPort,
} from "../ports.js";

export const FAL_DEV_VIDEO_ADAPTER_VERSION = "fal-queue-dev-v1" as const;

const FAL_QUEUE_ORIGIN = "https://queue.fal.run";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_POLLS = 600;
const SHORT_CLIP_DURATION_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface FalDevVideoEnvironment {
  readonly REFLO_ENV?: string;
  readonly REFLO_FAL_KEY?: string;
  readonly REFLO_FAL_MEDIA_LIFETIME_SECONDS?: string;
  readonly REFLO_FAL_VIDEO_MODEL?: string;
}

export interface FalDevVideoAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly pollIntervalMs?: number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createFalDevVideoAdapter(
  environment: FalDevVideoEnvironment,
  options: FalDevVideoAdapterOptions = {},
): VideoModelPort {
  const configuration = readConfiguration(environment);
  const client = new FalQueueClient(
    configuration,
    options.fetch ?? globalThis.fetch,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    options.wait ?? abortableWait,
  );

  return Object.freeze({
    descriptor: Object.freeze({
      adapterVersion: FAL_DEV_VIDEO_ADAPTER_VERSION,
      capability: "video",
      developmentOnly: true,
      driftCanaryPassed: false,
      effectiveModel: configuration.videoModel,
      effectiveModelVersion: "mutable-development-endpoint",
      maxImmediateAttempts: 1,
      mediaSubmissionIdempotent: false,
      mutableAlias: true,
      selector: "wanx.video",
    }),
    generateVideo: (invocation: AdapterInvocation) =>
      client.generate(invocation),
  });
}

interface FalConfiguration {
  readonly apiKey: string;
  readonly mediaLifetimeSeconds: number;
  readonly modelUrl: URL;
  readonly videoModel: string;
}

interface SubmittedRequest {
  readonly requestId: string;
  readonly responseUrl: URL;
  readonly statusUrl: URL;
}

class FalQueueClient {
  constructor(
    private readonly configuration: FalConfiguration,
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
      throw new Error("fal poll interval is invalid");
    }
  }

  async generate(invocation: AdapterInvocation): Promise<AdapterResponse> {
    if (invocation.task !== "media.video.v1") {
      throw adapterFailure("invalid_request", false, "not_accepted");
    }
    const input = invocation.input as VideoGenerationInput;
    validateInput(input);
    const submitted = await this.submit(input, invocation.signal);
    await this.waitForCompletion(submitted, invocation.signal);
    const result = await this.result(submitted, input, invocation.signal);
    return {
      identity: {
        effectiveModel: this.configuration.videoModel,
        providerRequestId: submitted.requestId,
      },
      value: result,
    };
  }

  private async submit(
    input: VideoGenerationInput,
    signal: AbortSignal,
  ): Promise<SubmittedRequest> {
    let response: Response;
    try {
      response = await this.fetchImplementation(this.configuration.modelUrl, {
        body: JSON.stringify({
          aspect_ratio: "16:9",
          duration: SHORT_CLIP_DURATION_SECONDS,
          enable_safety_checker: true,
          prompt: input.visualBrief,
          resolution: "720p",
        }),
        headers: this.headers({
          "X-Fal-Object-Lifecycle-Preference": JSON.stringify({
            expiration_duration_seconds:
              this.configuration.mediaLifetimeSeconds,
          }),
          "X-Fal-Store-IO": "0",
          "X-Fal-No-Retry": "1",
          "x-app-fal-disable-fallback": "true",
        }),
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
    if (!isRecord(payload) || !isSafeRequestId(payload.request_id)) {
      throw adapterFailure("provider_error", false, "unknown");
    }
    const requestId = payload.request_id;
    return {
      requestId,
      responseUrl: validateQueueUrl(
        payload.response_url,
        this.configuration.videoModel,
        requestId,
        "response",
      ),
      statusUrl: validateQueueUrl(
        payload.status_url,
        this.configuration.videoModel,
        requestId,
        "status",
      ),
    };
  }

  private async waitForCompletion(
    submitted: SubmittedRequest,
    signal: AbortSignal,
  ): Promise<void> {
    for (let poll = 0; poll < MAX_STATUS_POLLS; poll += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(submitted.statusUrl, {
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
      if (!isRecord(payload) || payload.request_id !== submitted.requestId) {
        throw adapterFailure("provider_error", false, "accepted");
      }
      if (payload.status === "COMPLETED") {
        if (payload.error !== undefined || payload.error_type !== undefined) {
          throw adapterFailure(
            safeCodeForProviderError(payload.error_type),
            isTransientProviderError(payload.error_type),
            "accepted",
          );
        }
        return;
      }
      if (payload.status !== "IN_QUEUE" && payload.status !== "IN_PROGRESS") {
        throw adapterFailure("provider_error", false, "accepted");
      }
      await this.wait(this.pollIntervalMs, signal).catch((error: unknown) => {
        throw requestFailure(error, "accepted");
      });
    }
    throw adapterFailure("timeout", true, "accepted");
  }

  private async result(
    submitted: SubmittedRequest,
    input: VideoGenerationInput,
    signal: AbortSignal,
  ): Promise<VideoAssetResult> {
    let response: Response;
    try {
      response = await this.fetchImplementation(submitted.responseUrl, {
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
    if (!isRecord(payload) || !isRecord(payload.video)) {
      throw adapterFailure("provider_error", false, "accepted");
    }
    const uri = safeMediaUrl(payload.video.url);
    const mimeType = payload.video.content_type;
    const durationSeconds =
      payload.video.duration ?? SHORT_CLIP_DURATION_SECONDS;
    if (
      uri === null ||
      typeof mimeType !== "string" ||
      !/^video\/[a-z0-9.+-]{1,64}$/i.test(mimeType) ||
      typeof durationSeconds !== "number" ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 60
    ) {
      throw adapterFailure("provider_error", false, "accepted");
    }
    return Object.freeze({
      durationSeconds,
      mimeType,
      sourceSpanIds: Object.freeze(input.sourceSpans.map((span) => span.id)),
      uri,
    });
  }

  private headers(additional: Readonly<Record<string, string>> = {}): Headers {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Key ${this.configuration.apiKey}`,
      "Content-Type": "application/json",
      ...additional,
    });
    return headers;
  }
}

function readConfiguration(
  environment: FalDevVideoEnvironment,
): FalConfiguration {
  if (environment.REFLO_ENV !== "dev") {
    throw new Error("fal video adapter is available only when REFLO_ENV=dev");
  }
  const apiKey = requiredValue(environment.REFLO_FAL_KEY, "REFLO_FAL_KEY");
  if (apiKey.length < 8 || /[\r\n]/.test(apiKey)) {
    throw new Error("REFLO_FAL_KEY is invalid");
  }
  const videoModel = requiredValue(
    environment.REFLO_FAL_VIDEO_MODEL,
    "REFLO_FAL_VIDEO_MODEL",
  );
  if (
    videoModel.length > 200 ||
    !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/i.test(videoModel)
  ) {
    throw new Error("REFLO_FAL_VIDEO_MODEL is invalid");
  }
  const lifetime = requiredValue(
    environment.REFLO_FAL_MEDIA_LIFETIME_SECONDS,
    "REFLO_FAL_MEDIA_LIFETIME_SECONDS",
  );
  if (!/^[0-9]+$/.test(lifetime)) {
    throw new Error("REFLO_FAL_MEDIA_LIFETIME_SECONDS is invalid");
  }
  const mediaLifetimeSeconds = Number(lifetime);
  if (
    !Number.isSafeInteger(mediaLifetimeSeconds) ||
    mediaLifetimeSeconds < 300 ||
    mediaLifetimeSeconds > 86_400
  ) {
    throw new Error("REFLO_FAL_MEDIA_LIFETIME_SECONDS is invalid");
  }
  const modelUrl = new URL(`/${videoModel}`, FAL_QUEUE_ORIGIN);
  return { apiKey, mediaLifetimeSeconds, modelUrl, videoModel };
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

function validateQueueUrl(
  value: unknown,
  model: string,
  requestId: string,
  kind: "response" | "status",
): URL {
  if (typeof value !== "string") {
    throw adapterFailure("provider_error", false, "unknown");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw adapterFailure("provider_error", false, "unknown");
  }
  const expectedBase = `/${model}/requests/${requestId}`;
  const allowedPaths =
    kind === "status"
      ? new Set([`${expectedBase}/status`])
      : new Set([expectedBase, `${expectedBase}/response`]);
  if (
    url.origin !== FAL_QUEUE_ORIGIN ||
    !allowedPaths.has(url.pathname) ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw adapterFailure("provider_error", false, "unknown");
  }
  return url;
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
      isAllowedFalMediaLocation(url)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isAllowedFalMediaLocation(url: URL): boolean {
  return (
    url.hostname === "fal.media" ||
    url.hostname.endsWith(".fal.media") ||
    (url.hostname === "storage.googleapis.com" &&
      url.pathname.startsWith("/falserverless/"))
  );
}

function safeCodeForProviderError(value: unknown): string {
  if (typeof value !== "string") return "provider_error";
  const normalized = value.toLowerCase();
  if (normalized.includes("rate")) return "rate_limited";
  if (normalized.includes("quota")) return "quota_exhausted";
  if (normalized.includes("capacity")) return "capacity_unavailable";
  if (normalized.includes("timeout")) return "timeout";
  return "provider_error";
}

function isTransientProviderError(value: unknown): boolean {
  return [
    "rate_limited",
    "quota_exhausted",
    "capacity_unavailable",
    "timeout",
  ].includes(safeCodeForProviderError(value));
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

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
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
