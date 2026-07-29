import { describe, expect, it, vi } from "vitest";

import { REFLO_NARRATOR_VOICE_PROFILE } from "../contracts.js";
import {
  DashScopeModelStudioTtsClient,
  ModelStudioTtsClientError,
  QWEN_3_TTS_FLASH_MODEL,
  QWEN_3_TTS_FLASH_MODEL_VERSION,
} from "./tts.js";

const request = {
  idempotencyKey: "audio_operation_123",
  model: QWEN_3_TTS_FLASH_MODEL,
  narration: "A short rights-cleared demo narration.",
  speakingRate: 1,
  voiceProfileId: REFLO_NARRATOR_VOICE_PROFILE,
};

describe("DashScope Model Studio TTS client", () => {
  it("uses the Singapore endpoint and downloads only an allowlisted result URL", async () => {
    const audio = pcmWav([1, 2, 3, 4]);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          output: {
            audio: {
              url: "http://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/audio.wav?Expires=1",
            },
            finish_reason: "stop",
          },
          status_code: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(audio, { status: 200 }));
    const client = new DashScopeModelStudioTtsClient({
      apiKey: "sk-development-placeholder-1234",
      fetchImplementation,
    });

    await expect(
      client.synthesize(request, new AbortController().signal),
    ).resolves.toEqual({
      audioBytes: audio,
      engineVersion: QWEN_3_TTS_FLASH_MODEL_VERSION,
      sampleRateHz: 24_000,
      voiceArtifactVersion: "qwen-cherry-2025-11-27",
      voiceId: "Cherry",
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toBe(
      "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/audio.wav?Expires=1",
    );
  });

  it("deterministically segments exact narration and composes one PCM WAV", async () => {
    const narration = `${"a".repeat(580)}. ${"b".repeat(620)}`;
    const expectedSegments = [
      `${"a".repeat(580)}. `,
      "b".repeat(600),
      "b".repeat(20),
    ];
    expect(expectedSegments.join("")).toBe(narration);
    expect(expectedSegments.map(characterCount)).toEqual([582, 600, 20]);
    expect(
      expectedSegments.every((segment) => characterCount(segment) <= 600),
    ).toBe(true);

    const segmentAudio = [pcmWav([1, 2]), pcmWav([3, 4, 5, 6]), pcmWav([7, 8])];
    const fetchImplementation = vi.fn<typeof fetch>();
    for (const [index, audio] of segmentAudio.entries()) {
      fetchImplementation
        .mockResolvedValueOnce(
          Response.json({
            output: {
              audio: {
                url: `https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/audio-${index}.wav`,
              },
              finish_reason: "stop",
            },
            status_code: 200,
          }),
        )
        .mockResolvedValueOnce(new Response(audio, { status: 200 }));
    }
    const client = new DashScopeModelStudioTtsClient({
      apiKey: "sk-development-placeholder-1234",
      fetchImplementation,
    });
    const signal = new AbortController().signal;

    const result = await client.synthesize({ ...request, narration }, signal);

    const submittedText = fetchImplementation.mock.calls
      .filter((_, index) => index % 2 === 0)
      .map((call) => {
        const body = JSON.parse(String(call[1]?.body)) as {
          readonly input: { readonly text: string };
        };
        expect(call[1]?.signal).toBe(signal);
        return body.input.text;
      });
    expect(submittedText).toEqual(expectedSegments);
    expect(result.audioBytes).toEqual(pcmWav([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it("never splits a Unicode character or mutates text without a boundary", async () => {
    const narration = "🙂".repeat(1_201);
    const fetchImplementation = vi.fn<typeof fetch>();
    for (let index = 0; index < 3; index += 1) {
      fetchImplementation
        .mockResolvedValueOnce(
          Response.json({
            output: {
              audio: {
                url: `https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/unicode-${index}.wav`,
              },
              finish_reason: "stop",
            },
            status_code: 200,
          }),
        )
        .mockResolvedValueOnce(new Response(pcmWav([1, 2]), { status: 200 }));
    }
    const client = new DashScopeModelStudioTtsClient({
      apiKey: "sk-development-placeholder-1234",
      fetchImplementation,
    });

    await client.synthesize(
      { ...request, narration },
      new AbortController().signal,
    );

    const segments = fetchImplementation.mock.calls
      .filter((_, index) => index % 2 === 0)
      .map((call) => {
        const body = JSON.parse(String(call[1]?.body)) as {
          readonly input: { readonly text: string };
        };
        return body.input.text;
      });
    expect(segments.map(characterCount)).toEqual([600, 600, 1]);
    expect(segments.join("")).toBe(narration);
  });

  it("rejects narration beyond the priced 4,000-character bound", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new DashScopeModelStudioTtsClient({
      apiKey: "sk-development-placeholder-1234",
      fetchImplementation,
    });

    await expect(
      client.synthesize(
        { ...request, narration: "🙂".repeat(4_001) },
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "invalid_request",
        retryable: false,
        submissionState: "not_accepted",
      }),
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("prevents retry or fallback after an earlier segment was accepted", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          output: {
            audio: {
              url: "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/audio-0.wav",
            },
            finish_reason: "stop",
          },
          status_code: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(pcmWav([1, 2]), { status: 200 }))
      .mockResolvedValueOnce(new Response("limited", { status: 429 }));
    const client = new DashScopeModelStudioTtsClient({
      apiKey: "sk-development-placeholder-1234",
      fetchImplementation,
    });

    await expect(
      client.synthesize(
        { ...request, narration: "x".repeat(601) },
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "rate_limited",
        retryable: false,
        submissionState: "accepted",
      }),
    );
  });

  it("rejects provider-controlled download URLs outside Alibaba result storage", async () => {
    const client = new DashScopeModelStudioTtsClient({
      apiKey: "sk-development-placeholder-1234",
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          output: {
            audio: { url: "https://example.test/private.wav" },
            finish_reason: "stop",
          },
          status_code: 200,
        }),
      ),
    });

    await expect(
      client.synthesize(request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "provider_error",
      submissionState: "accepted",
    });
  });

  it("classifies throttling as a retryable non-submission", async () => {
    const client = new DashScopeModelStudioTtsClient({
      apiKey: "sk-development-placeholder-1234",
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("limited", { status: 429 })),
    });

    await expect(
      client.synthesize(request, new AbortController().signal),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "rate_limited",
        retryable: true,
        submissionState: "not_accepted",
      }),
    );
  });

  it("fails closed for an invalid API key", () => {
    expect(
      () =>
        new DashScopeModelStudioTtsClient({
          apiKey: "invalid",
        }),
    ).toThrow(ModelStudioTtsClientError);
  });
});

function characterCount(value: string): number {
  return Array.from(value).length;
}

function pcmWav(data: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(44 + data.length);
  const view = new DataView(bytes.buffer);
  write(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  write(bytes, 8, "WAVE");
  write(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(bytes, 36, "data");
  view.setUint32(40, data.length, true);
  bytes.set(data, 44);
  return bytes;
}

function write(bytes: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of Array.from(value).entries()) {
    bytes[offset + index] = character.charCodeAt(0);
  }
}
