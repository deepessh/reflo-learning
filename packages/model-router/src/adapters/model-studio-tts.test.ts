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
    const audio = Uint8Array.from([82, 73, 70, 70]);
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
