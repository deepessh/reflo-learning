import { describe, expect, it } from "vitest";

import {
  AUDIO_GATE_EVIDENCE_VERSION,
  evaluateAudioGate,
  type AudioGateEvidence,
} from "./evidence.js";

describe("audio release-gate evidence", () => {
  it("passes only a 30-script, five-course, two-reviewer profile for both paths", () => {
    expect(evaluateAudioGate(evidence())).toMatchObject({
      chapterOneP95Ms: {
        "piper-tts.cpu": 120_000,
        "qwen-tts.primary": 120_000,
      },
      sampleCountPerAdapter: 30,
      status: "passed",
    });
  });

  it("fails closed when listening, authorization, sample, or latency evidence is absent", () => {
    const input = evidence();
    expect(
      evaluateAudioGate({
        ...input,
        samples: input.samples.slice(0, 29),
        workerImageDigest: "pending",
      }),
    ).toMatchObject({ status: "failed" });
  });
});

function evidence(): AudioGateEvidence {
  const samples = (["qwen-tts.primary", "piper-tts.cpu"] as const).flatMap(
    (adapter) =>
      Array.from({ length: 30 }, (_, index) => ({
        adapter,
        authorizedPrivateAsset: true as const,
        courseId: `course-${String(index % 5).padStart(4, "0")}`,
        finalizedAt: new Date(
          Date.parse("2026-07-21T16:00:00.000Z") + 120_000,
        ).toISOString(),
        listeningReviews: [
          {
            intelligibleAt1_5x: true as const,
            intelligibleAt1x: true as const,
            reviewerId: "reviewer-0001",
          },
          {
            intelligibleAt1_5x: true as const,
            intelligibleAt1x: true as const,
            reviewerId: "reviewer-0002",
          },
        ] as const,
        playable: true as const,
        rangePlayback: true as const,
        scriptId: `${adapter}-script-${String(index).padStart(4, "0")}`,
        startedAt: "2026-07-21T16:00:00.000Z",
      })),
  );
  return {
    capacity: {
      concurrencyLimit: 5,
      cpuProfile: "fixture-cpu-profile",
      existingOrApprovedCapacity: true,
      memoryMiB: 8_192,
      queueReservation: "fixture-audio-queue",
      vCpu: 4,
      workerCount: 5,
    },
    contractVersion: AUDIO_GATE_EVIDENCE_VERSION,
    environment: "staging",
    primaryQuotaEvidenceReference: "approved-evidence-reference",
    samples,
    workerImageDigest: `sha256:${"a".repeat(64)}`,
  };
}
