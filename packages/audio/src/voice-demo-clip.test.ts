import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  AUDIO_PAYLOAD_VERSION,
  REFLO_NARRATOR_VOICE_PROFILE,
  type AudioPayloadResult,
} from "@reflo/model-router";
import { describe, expect, it } from "vitest";

import { createPcmWavFixture } from "./testing.js";
import {
  VOICE_DEMO_CLIP_CONTRACT_VERSION,
  VOICE_DEMO_SOURCE_SPAN_ID,
  buildVoiceDemoClipManifest,
} from "./voice-demo-clip.js";

describe("recorded voice tutoring prototype", () => {
  it("binds the checked-in non-silent WAV to its honestly labeled manifest", async () => {
    const artifactRoot = fileURLToPath(
      new URL(
        "../../../demo-artifacts/voice-tutoring-recorded-prototype/",
        import.meta.url,
      ),
    );
    const [manifestBytes, wav] = await Promise.all([
      readFile(`${artifactRoot}manifest.json`),
      readFile(`${artifactRoot}voice-tutoring-recorded-prototype.wav`),
    ]);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      readonly artifact?: {
        readonly byteLength?: unknown;
        readonly durationSeconds?: unknown;
        readonly sampleRateHz?: unknown;
        readonly sha256?: unknown;
      };
      readonly contractVersion?: unknown;
      readonly displayLabel?: unknown;
      readonly featureGate?: {
        readonly liveRuntimeEligible?: unknown;
        readonly runtimeDefault?: unknown;
      };
      readonly synthesis?: {
        readonly piperManifestActivationStatus?: unknown;
      };
    };
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const sampleRateHz = view.getUint32(24, true);
    const dataLength = view.getUint32(40, true);
    const durationSeconds = dataLength / (sampleRateHz * 2);
    const nonZeroBytes = wav
      .subarray(44)
      .reduce((count, byte) => count + (byte === 0 ? 0 : 1), 0);

    expect(manifest).toMatchObject({
      contractVersion: VOICE_DEMO_CLIP_CONTRACT_VERSION,
      displayLabel: "Recorded prototype · not live voice tutoring",
      featureGate: {
        liveRuntimeEligible: false,
        runtimeDefault: false,
      },
      synthesis: {
        piperManifestActivationStatus: "blocked",
      },
    });
    expect(manifest.artifact?.byteLength).toBe(wav.byteLength);
    expect(manifest.artifact?.sampleRateHz).toBe(sampleRateHz);
    expect(manifest.artifact?.durationSeconds).toBeCloseTo(durationSeconds, 9);
    expect(manifest.artifact?.sha256).toBe(
      createHash("sha256").update(wav).digest("hex"),
    );
    expect(nonZeroBytes).toBeGreaterThan(dataLength / 4);
  });

  it("is source-cited and cannot imply an enabled live runtime", () => {
    const manifest = buildVoiceDemoClipManifest({
      activationBlockers: ["human review is not recorded"],
      audio: audioPayload(),
      voiceArtifactRevision: "voice-revision-001",
      voiceConfigSha256: "a".repeat(64),
      voiceModelSha256: "b".repeat(64),
    });

    expect(manifest).toMatchObject({
      artifactClass: "recorded-prototype",
      contractVersion: VOICE_DEMO_CLIP_CONTRACT_VERSION,
      featureGate: {
        key: "p1.tutor.voice",
        liveRuntimeEligible: false,
        runtimeDefault: false,
      },
      provenance: {
        liveTutorRouteUsed: false,
        runtimeTraceEmitted: false,
      },
      synthesis: {
        piperManifestActivationStatus: "blocked",
      },
    });
    expect(manifest.citation.sourceSpanIds).toEqual([
      VOICE_DEMO_SOURCE_SPAN_ID,
    ]);
    expect(manifest.transcript).toContain(
      "Recorded prototype, not live voice tutoring.",
    );
    expect(manifest.nonClaims).toContain("shipped voice runtime");
  });

  it("rejects an artifact without the fixed synthetic citation", () => {
    expect(() =>
      buildVoiceDemoClipManifest({
        activationBlockers: ["human review is not recorded"],
        audio: {
          ...audioPayload(),
          sourceSpanIds: ["unrelated-source-span"],
        },
        voiceArtifactRevision: "voice-revision-001",
        voiceConfigSha256: "a".repeat(64),
        voiceModelSha256: "b".repeat(64),
      }),
    ).toThrow("voice demo clip evidence is invalid");
  });
});

function audioPayload(): AudioPayloadResult {
  const bytes = createPcmWavFixture();
  return {
    bytes,
    byteLength: bytes.byteLength,
    channels: 1,
    codec: "pcm_s16le",
    container: "wav",
    contractVersion: AUDIO_PAYLOAD_VERSION,
    durationSeconds: 1,
    engine: "piper",
    engineVersion: "1.4.2",
    headerValidated: true,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    sampleRateHz: 22_050,
    settingsVersion: "piper-settings-v1",
    sourceSpanIds: [VOICE_DEMO_SOURCE_SPAN_ID],
    voiceArtifactVersion: "voice-artifact-v1",
    voiceId: "en_US-ljspeech-high",
    voiceProfileId: REFLO_NARRATOR_VOICE_PROFILE,
  };
}
