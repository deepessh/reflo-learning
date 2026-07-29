import { createHash } from "node:crypto";

import {
  AUDIO_PAYLOAD_VERSION,
  REFLO_NARRATOR_VOICE_PROFILE,
  TTS_ALLOWED_SAMPLE_RATES,
  TTS_SYNTHESIS_REQUEST_VERSION,
  type AudioPayloadResult,
  type TextToSpeechInput,
} from "../contracts.js";
import {
  ModelAdapterError,
  type AdapterInvocation,
  type AdapterResponse,
  type SpeechModelPort,
} from "../ports.js";

export { NodePiperSynthesisProcess } from "./piper-process.js";
export type { NodePiperProcessOptions } from "./piper-process.js";

export const QWEN_TTS_ADAPTER_VERSION = "qwen3-tts-flash-adapter-v2" as const;
export const QWEN_3_TTS_FLASH_MODEL = "qwen3-tts-flash" as const;
export const QWEN_3_TTS_FLASH_MODEL_VERSION =
  "qwen3-tts-flash-2025-11-27" as const;
export const PIPER_TTS_ADAPTER_VERSION = "piper-tts-adapter-v1" as const;
export const PIPER_ENGINE_VERSION = "1.4.2" as const;
export const PIPER_VOICE_ID = "en_US-ljspeech-high" as const;

export interface TtsSynthesisResponse {
  readonly audioBytes: Uint8Array;
  readonly engineVersion: string;
  readonly sampleRateHz: 22_050 | 24_000;
  readonly voiceArtifactVersion: string;
  readonly voiceId: string;
}

export interface ModelStudioTtsClient {
  synthesize(
    request: {
      readonly idempotencyKey: string;
      readonly model: string;
      readonly narration: string;
      readonly speakingRate: number;
      readonly voiceProfileId: typeof REFLO_NARRATOR_VOICE_PROFILE;
    },
    signal: AbortSignal,
  ): Promise<TtsSynthesisResponse>;
}

export class ModelStudioTtsClientError extends Error {
  constructor(
    readonly code:
      | "authentication_failed"
      | "capacity_unavailable"
      | "invalid_request"
      | "provider_error"
      | "quota_exhausted"
      | "rate_limited"
      | "request_rejected"
      | "timeout"
      | "unavailable",
    readonly submissionState: "accepted" | "not_accepted" | "unknown",
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super("Model Studio TTS request failed", options);
    this.name = "ModelStudioTtsClientError";
  }
}

const DASHSCOPE_TTS_ENDPOINT =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const MAX_DASHSCOPE_RESPONSE_BYTES = 64 * 1024;
const MAX_TTS_AUDIO_BYTES = 32 * 1024 * 1024;

export class DashScopeModelStudioTtsClient implements ModelStudioTtsClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    readonly apiKey: string;
    readonly fetchImplementation?: typeof fetch;
  }) {
    if (!/^sk-[a-zA-Z0-9_-]{16,256}$/.test(options.apiKey)) {
      throw new ModelStudioTtsClientError(
        "authentication_failed",
        "not_accepted",
        false,
      );
    }
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async synthesize(
    request: Parameters<ModelStudioTtsClient["synthesize"]>[0],
    signal: AbortSignal,
  ): Promise<TtsSynthesisResponse> {
    if (
      request.model !== QWEN_3_TTS_FLASH_MODEL ||
      request.voiceProfileId !== REFLO_NARRATOR_VOICE_PROFILE ||
      request.speakingRate !== 1 ||
      request.narration.length < 1 ||
      request.narration.length > 600 ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(request.idempotencyKey)
    ) {
      throw new ModelStudioTtsClientError(
        "invalid_request",
        "not_accepted",
        false,
      );
    }
    let response: Response;
    try {
      response = await this.#fetch(DASHSCOPE_TTS_ENDPOINT, {
        body: JSON.stringify({
          input: {
            language_type: "English",
            text: request.narration,
            voice: "Cherry",
          },
          model: request.model,
        }),
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw transportFailure(error, signal, "unknown");
    }
    if (!response.ok) {
      throw responseFailure(response.status);
    }
    const payload = await readJsonResponse(response, signal);
    const audioUrl = modelStudioAudioUrl(payload);
    let audioResponse: Response;
    try {
      audioResponse = await this.#fetch(audioUrl, {
        method: "GET",
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw transportFailure(error, signal, "accepted");
    }
    if (!audioResponse.ok) {
      throw new ModelStudioTtsClientError("provider_error", "accepted", false);
    }
    const audioBytes = await readBoundedBytes(
      audioResponse,
      MAX_TTS_AUDIO_BYTES,
      signal,
      "accepted",
    );
    return {
      audioBytes,
      engineVersion: QWEN_3_TTS_FLASH_MODEL_VERSION,
      sampleRateHz: 24_000,
      voiceArtifactVersion: "qwen-cherry-2025-11-27",
      voiceId: "Cherry",
    };
  }
}

export interface PiperSynthesisProcess {
  synthesize(
    request: {
      readonly configPath: string;
      readonly modelPath: string;
      readonly narration: string;
      readonly speakingRate: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly audioBytes: Uint8Array;
    readonly sampleRateHz: 22_050 | 24_000;
  }>;
}

export interface PiperVoiceProfile {
  readonly artifactRevision: string;
  readonly configPath: string;
  readonly configSha256: string;
  readonly modelPath: string;
  readonly modelSha256: string;
  readonly runtimeDownloadsAllowed: false;
  readonly voiceArtifactVersion: string;
}

export function createQwenTtsAdapter(options: {
  readonly client: ModelStudioTtsClient;
  readonly driftCanaryPassed: boolean;
  readonly effectiveModelVersion: typeof QWEN_3_TTS_FLASH_MODEL_VERSION;
  readonly model: typeof QWEN_3_TTS_FLASH_MODEL;
}): SpeechModelPort {
  assertQwenTtsOptions(options);
  return {
    descriptor: {
      adapterVersion: QWEN_TTS_ADAPTER_VERSION,
      capability: "speech",
      driftCanaryPassed: options.driftCanaryPassed,
      effectiveModel: options.model,
      effectiveModelVersion: options.effectiveModelVersion,
      maxImmediateAttempts: 1,
      mediaSubmissionIdempotent: false,
      mutableAlias: true,
      selector: "qwen-tts.primary",
    },
    async synthesize(invocation): Promise<AdapterResponse> {
      const input = ttsInput(invocation);
      try {
        const response = await options.client.synthesize(
          {
            idempotencyKey: input.operationId,
            model: options.model,
            narration: input.narration,
            speakingRate: input.speakingRate,
            voiceProfileId: input.voiceProfileId,
          },
          invocation.signal,
        );
        if (response.engineVersion !== options.effectiveModelVersion) {
          throw new ModelAdapterError({
            safeCode: "request_rejected",
            submissionState: "accepted",
            transient: false,
          });
        }
        return {
          identity: { effectiveModel: options.model },
          value: materializeAudioPayload(
            input,
            response,
            "qwen3-tts-flash-settings-v1",
          ),
        };
      } catch (error) {
        if (error instanceof ModelAdapterError) {
          throw error;
        }
        if (error instanceof ModelStudioTtsClientError) {
          throw new ModelAdapterError({
            cause: error,
            safeCode: error.code,
            submissionState: error.submissionState,
            transient: error.retryable,
          });
        }
        throw new ModelAdapterError({
          cause: error,
          safeCode: "provider_error",
          submissionState: "unknown",
          transient: false,
        });
      }
    },
  };
}

export function createPiperTtsAdapter(options: {
  readonly process: PiperSynthesisProcess;
  readonly profile: PiperVoiceProfile;
}): SpeechModelPort {
  assertPiperProfile(options.profile);
  return {
    descriptor: {
      adapterVersion: PIPER_TTS_ADAPTER_VERSION,
      capability: "speech",
      driftCanaryPassed: true,
      effectiveModel: "piper-tts",
      effectiveModelVersion: PIPER_ENGINE_VERSION,
      maxImmediateAttempts: 1,
      mediaSubmissionIdempotent: false,
      mutableAlias: false,
      selector: "piper-tts.cpu",
    },
    async synthesize(invocation): Promise<AdapterResponse> {
      const input = ttsInput(invocation);
      try {
        const response = await options.process.synthesize(
          {
            configPath: options.profile.configPath,
            modelPath: options.profile.modelPath,
            narration: input.narration,
            speakingRate: input.speakingRate,
          },
          invocation.signal,
        );
        return {
          value: materializeAudioPayload(
            input,
            {
              ...response,
              engineVersion: PIPER_ENGINE_VERSION,
              voiceArtifactVersion: options.profile.voiceArtifactVersion,
              voiceId: PIPER_VOICE_ID,
            },
            "piper-settings-v1",
          ),
        };
      } catch (error) {
        if (error instanceof ModelAdapterError) {
          throw error;
        }
        throw new ModelAdapterError({
          cause: error,
          safeCode: invocation.signal.aborted ? "timeout" : "provider_error",
          submissionState: "not_accepted",
          transient: invocation.signal.aborted,
        });
      }
    },
  };
}

export function materializeAudioPayload(
  input: TextToSpeechInput,
  response: TtsSynthesisResponse,
  settingsVersion: string,
): AudioPayloadResult {
  assertSafeVersion(response.engineVersion);
  assertSafeVersion(response.voiceArtifactVersion);
  assertSafeVersion(response.voiceId);
  assertSafeVersion(settingsVersion);
  const durationSeconds = validatePcmWav(
    response.audioBytes,
    response.sampleRateHz,
  );
  return {
    bytes: response.audioBytes,
    byteLength: response.audioBytes.byteLength,
    channels: 1,
    codec: "pcm_s16le",
    container: "wav",
    contractVersion: AUDIO_PAYLOAD_VERSION,
    durationSeconds,
    engine:
      response.engineVersion === PIPER_ENGINE_VERSION ? "piper" : "qwen-tts",
    engineVersion: response.engineVersion,
    headerValidated: true,
    payloadSha256: sha256(response.audioBytes),
    sampleRateHz: response.sampleRateHz,
    settingsVersion,
    sourceSpanIds: input.sourceSpanIds,
    voiceArtifactVersion: response.voiceArtifactVersion,
    voiceId: response.voiceId,
    voiceProfileId: input.voiceProfileId,
  };
}

function ttsInput(invocation: AdapterInvocation): TextToSpeechInput {
  if (invocation.task !== "media.tts.v1") {
    throw new ModelAdapterError({
      safeCode: "invalid_request",
      submissionState: "not_accepted",
      transient: false,
    });
  }
  const input = invocation.input as TextToSpeechInput;
  const deadline = Date.parse(input.deadlineAt);
  if (
    input.contractVersion !== TTS_SYNTHESIS_REQUEST_VERSION ||
    input.voiceProfileId !== REFLO_NARRATOR_VOICE_PROFILE ||
    input.locale !== "en-US" ||
    input.output.container !== "wav" ||
    input.output.codec !== "pcm_s16le" ||
    input.output.channels !== 1 ||
    input.output.allowedSampleRates.length !== 2 ||
    !input.output.allowedSampleRates.every(
      (rate, index) => rate === TTS_ALLOWED_SAMPLE_RATES[index],
    ) ||
    input.narration.length === 0 ||
    input.narration.length > 100_000 ||
    input.scriptSha256 !== sha256(Buffer.from(input.narration, "utf8")) ||
    !isOpaqueId(input.operationId) ||
    !isOpaqueId(input.generationReference) ||
    !isOpaqueId(input.narrationScriptId) ||
    input.sourceSpanIds.length === 0 ||
    new Set(input.sourceSpanIds).size !== input.sourceSpanIds.length ||
    input.sourceSpanIds.some((id) => !isOpaqueId(id)) ||
    !Number.isFinite(input.speakingRate) ||
    input.speakingRate < 0.75 ||
    input.speakingRate > 1.5 ||
    !Number.isFinite(deadline)
  ) {
    throw new ModelAdapterError({
      safeCode: "invalid_request",
      submissionState: "not_accepted",
      transient: false,
    });
  }
  return input;
}

function validatePcmWav(bytes: Uint8Array, sampleRateHz: number): number {
  if (
    !(TTS_ALLOWED_SAMPLE_RATES as readonly number[]).includes(sampleRateHz) ||
    bytes.byteLength < 44
  ) {
    throw invalidAudio();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const dataLength = view.getUint32(40, true);
  if (
    ascii(0, 4) !== "RIFF" ||
    view.getUint32(4, true) !== bytes.byteLength - 8 ||
    ascii(8, 4) !== "WAVE" ||
    ascii(12, 4) !== "fmt " ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== sampleRateHz ||
    view.getUint32(28, true) !== sampleRateHz * 2 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    ascii(36, 4) !== "data" ||
    dataLength !== bytes.byteLength - 44 ||
    dataLength === 0 ||
    dataLength % 2 !== 0
  ) {
    throw invalidAudio();
  }
  return dataLength / (sampleRateHz * 2);
}

function invalidAudio(): ModelAdapterError {
  return new ModelAdapterError({
    safeCode: "request_rejected",
    submissionState: "accepted",
    transient: false,
  });
}

function assertPiperProfile(profile: PiperVoiceProfile): void {
  if (
    profile.runtimeDownloadsAllowed !== false ||
    !pathIsAbsolute(profile.modelPath) ||
    !pathIsAbsolute(profile.configPath) ||
    !/^[a-f0-9]{64}$/.test(profile.modelSha256) ||
    !/^[a-f0-9]{64}$/.test(profile.configSha256) ||
    !/^[a-f0-9]{40}$/.test(profile.artifactRevision) ||
    !/^piper-voice-[a-z0-9.-]+$/.test(profile.voiceArtifactVersion)
  ) {
    throw new ModelAdapterError({
      safeCode: "invalid_request",
      submissionState: "not_accepted",
      transient: false,
    });
  }
}

function assertQwenTtsOptions(options: {
  readonly driftCanaryPassed: boolean;
  readonly effectiveModelVersion: string;
  readonly model: string;
}): void {
  if (
    typeof options.driftCanaryPassed !== "boolean" ||
    options.model !== QWEN_3_TTS_FLASH_MODEL ||
    options.effectiveModelVersion !== QWEN_3_TTS_FLASH_MODEL_VERSION
  ) {
    throw new ModelAdapterError({
      safeCode: "invalid_request",
      submissionState: "not_accepted",
      transient: false,
    });
  }
}

function assertSafeVersion(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new ModelAdapterError({
      safeCode: "invalid_request",
      submissionState: "not_accepted",
      transient: false,
    });
  }
}

async function readJsonResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedBytes(
    response,
    MAX_DASHSCOPE_RESPONSE_BYTES,
    signal,
    "accepted",
  );
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new ModelStudioTtsClientError("provider_error", "accepted", false, {
      cause: error,
    });
  }
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  submissionState: "accepted" | "unknown",
): Promise<Uint8Array> {
  const declaredHeader = response.headers.get("content-length");
  const declaredLength =
    declaredHeader === null ? undefined : Number(declaredHeader);
  if (
    (declaredLength !== undefined &&
      Number.isFinite(declaredLength) &&
      (declaredLength < 1 || declaredLength > maximumBytes)) ||
    response.body === null
  ) {
    throw new ModelStudioTtsClientError(
      "provider_error",
      submissionState,
      false,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        throw new ModelStudioTtsClientError("timeout", submissionState, false);
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumBytes) {
        throw new ModelStudioTtsClientError(
          "provider_error",
          submissionState,
          false,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength < 1) {
    throw new ModelStudioTtsClientError(
      "provider_error",
      submissionState,
      false,
    );
  }
  return new Uint8Array(Buffer.concat(chunks, byteLength));
}

function modelStudioAudioUrl(value: unknown): URL {
  const root = record(value);
  const output = record(root?.output);
  const audio = record(output?.audio);
  if (
    root?.status_code !== 200 ||
    output?.finish_reason !== "stop" ||
    typeof audio?.url !== "string"
  ) {
    throw new ModelStudioTtsClientError("provider_error", "accepted", false);
  }
  let url: URL;
  try {
    url = new URL(audio.url);
  } catch (error) {
    throw new ModelStudioTtsClientError("provider_error", "accepted", false, {
      cause: error,
    });
  }
  if (
    !url.hostname.startsWith("dashscope-result-") ||
    !url.hostname.endsWith(".aliyuncs.com") ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ModelStudioTtsClientError("provider_error", "accepted", false);
  }
  url.protocol = "https:";
  return url;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function responseFailure(status: number): ModelStudioTtsClientError {
  if (status === 401 || status === 403) {
    return new ModelStudioTtsClientError(
      "authentication_failed",
      "not_accepted",
      false,
    );
  }
  if (status === 429) {
    return new ModelStudioTtsClientError("rate_limited", "not_accepted", true);
  }
  if (status >= 400 && status < 500) {
    return new ModelStudioTtsClientError(
      "invalid_request",
      "not_accepted",
      false,
    );
  }
  return new ModelStudioTtsClientError("unavailable", "unknown", true);
}

function transportFailure(
  error: unknown,
  signal: AbortSignal,
  submissionState: "accepted" | "unknown",
): ModelStudioTtsClientError {
  return new ModelStudioTtsClientError(
    signal.aborted ? "timeout" : "unavailable",
    submissionState,
    submissionState !== "accepted",
    { cause: error },
  );
}

function pathIsAbsolute(value: string): boolean {
  return (
    value.startsWith("/") && !value.includes("..") && !/[\r\n]/.test(value)
  );
}

function isOpaqueId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
