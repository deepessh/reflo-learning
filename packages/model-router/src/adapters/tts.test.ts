import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AUDIO_PAYLOAD_VERSION,
  REFLO_NARRATOR_VOICE_PROFILE,
  TTS_ALLOWED_SAMPLE_RATES,
  TTS_SYNTHESIS_REQUEST_VERSION,
  type TextToSpeechInput,
} from "../contracts.js";
import { ModelAdapterError } from "../ports.js";
import {
  createPiperTtsAdapter,
  createQwenTtsAdapter,
  PIPER_ENGINE_VERSION,
} from "./tts.js";

describe("TTS provider adapters", () => {
  it("normalizes Qwen-TTS WAV bytes without assigning storage authority", async () => {
    const wav = pcmWav(24_000);
    const client = {
      synthesize: vi.fn(async () => ({
        audioBytes: wav,
        engineVersion: "2026-07-01",
        sampleRateHz: 24_000 as const,
        voiceArtifactVersion: "qwen-voice-v1",
        voiceId: "cherry",
      })),
    };
    const adapter = createQwenTtsAdapter({
      client,
      effectiveModelVersion: "2026-07-01",
    });

    const response = await adapter.synthesize(invocation());

    expect(client.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "operation-0001",
        narration: "Authorized narration",
        voiceProfileId: REFLO_NARRATOR_VOICE_PROFILE,
      }),
      expect.any(AbortSignal),
    );
    expect(response.value).toMatchObject({
      byteLength: wav.byteLength,
      contractVersion: AUDIO_PAYLOAD_VERSION,
      headerValidated: true,
      payloadSha256: createHash("sha256").update(wav).digest("hex"),
      sampleRateHz: 24_000,
    });
    expect(response.value).not.toHaveProperty("objectKey");
    expect(response.value).not.toHaveProperty("uri");
    expect(response.value).not.toHaveProperty("signedUrl");
  });

  it("maps only the approved profile to the pinned Piper CPU process", async () => {
    const wav = pcmWav(22_050);
    const process = {
      synthesize: vi.fn(async () => ({
        audioBytes: wav,
        sampleRateHz: 22_050 as const,
      })),
    };
    const adapter = createPiperTtsAdapter({
      process,
      profile: {
        artifactRevision: "1".repeat(40),
        configPath: "/opt/reflo/voices/en_US-ljspeech-high.onnx.json",
        configSha256: "2".repeat(64),
        modelPath: "/opt/reflo/voices/en_US-ljspeech-high.onnx",
        modelSha256: "3".repeat(64),
        runtimeDownloadsAllowed: false,
        voiceArtifactVersion: "piper-voice-ljspeech-v1",
      },
    });

    const response = await adapter.synthesize(invocation());

    expect(adapter.descriptor).toMatchObject({
      effectiveModelVersion: PIPER_ENGINE_VERSION,
      maxImmediateAttempts: 1,
      mediaSubmissionIdempotent: false,
      selector: "piper-tts.cpu",
    });
    expect(process.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/opt/reflo/voices/en_US-ljspeech-high.onnx.json",
        modelPath: "/opt/reflo/voices/en_US-ljspeech-high.onnx",
      }),
      expect.any(AbortSignal),
    );
    expect(response.value).toMatchObject({
      engine: "piper",
      engineVersion: PIPER_ENGINE_VERSION,
      voiceId: "en_US-ljspeech-high",
    });
  });

  it("fails closed for mutable voice revisions and malformed WAV payloads", async () => {
    expect(() =>
      createPiperTtsAdapter({
        process: { synthesize: vi.fn() },
        profile: {
          artifactRevision: "main",
          configPath: "/voice.json",
          configSha256: "2".repeat(64),
          modelPath: "/voice.onnx",
          modelSha256: "3".repeat(64),
          runtimeDownloadsAllowed: false,
          voiceArtifactVersion: "piper-voice-v1",
        },
      }),
    ).toThrow(ModelAdapterError);

    const adapter = createQwenTtsAdapter({
      client: {
        synthesize: async () => ({
          audioBytes: new Uint8Array([1, 2, 3]),
          engineVersion: "2026-07-01",
          sampleRateHz: 24_000,
          voiceArtifactVersion: "qwen-voice-v1",
          voiceId: "cherry",
        }),
      },
      effectiveModelVersion: "2026-07-01",
    });
    await expect(adapter.synthesize(invocation())).rejects.toMatchObject({
      safeCode: "request_rejected",
      submissionState: "accepted",
      transient: false,
    });
  });
});

function invocation() {
  return {
    input: input(),
    signal: new AbortController().signal,
    task: "media.tts.v1" as const,
  };
}

function input(): TextToSpeechInput {
  const narration = "Authorized narration";
  return {
    contractVersion: TTS_SYNTHESIS_REQUEST_VERSION,
    deadlineAt: "2026-07-21T17:00:00.000Z",
    generationReference: "generation-0001",
    locale: "en-US",
    narration,
    narrationScriptId: "narration-0001",
    operationId: "operation-0001",
    output: {
      allowedSampleRates: TTS_ALLOWED_SAMPLE_RATES,
      channels: 1,
      codec: "pcm_s16le",
      container: "wav",
    },
    scriptSha256: createHash("sha256").update(narration).digest("hex"),
    sourceSpanIds: ["source-span-0001"],
    speakingRate: 1,
    voiceProfileId: REFLO_NARRATOR_VOICE_PROFILE,
  };
}

function pcmWav(sampleRate: 22_050 | 24_000): Uint8Array {
  const dataLength = sampleRate * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  write(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  write(bytes, 8, "WAVE");
  write(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(bytes, 36, "data");
  view.setUint32(40, dataLength, true);
  return bytes;
}

function write(bytes: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of [...value].entries()) {
    bytes[offset + index] = character.charCodeAt(0);
  }
}
