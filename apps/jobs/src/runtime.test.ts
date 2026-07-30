import { describe, expect, it } from "vitest";

import type { SpeechModelPort } from "@reflo/model-router";

import { speechAdapterRegistry } from "./runtime.js";

const primary = {
  descriptor: {
    adapterVersion: "test-adapter-v1",
    capability: "speech",
    driftCanaryPassed: true,
    effectiveModel: "test-primary",
    effectiveModelVersion: "test-primary-v1",
    maxImmediateAttempts: 1,
    mediaSubmissionIdempotent: false,
    mutableAlias: false,
    selector: "qwen-tts.primary",
  },
  synthesize: async () => {
    throw new Error("not exercised");
  },
} satisfies SpeechModelPort;

describe("production speech composition", () => {
  it("keeps the unqualified Piper layer unavailable", () => {
    const registry = speechAdapterRegistry(
      { REFLO_PIPER_ACTIVATION_STATUS: "blocked" },
      primary,
    );

    expect(Object.keys(registry.speech)).toEqual(["qwen-tts.primary"]);
  });

  it("registers the exact activation-gated Piper profile", () => {
    const registry = speechAdapterRegistry(piperEnvironment(), primary);

    expect(Object.keys(registry.speech).sort()).toEqual([
      "piper-tts.cpu",
      "qwen-tts.primary",
    ]);
    expect(registry.speech["piper-tts.cpu"]?.descriptor).toMatchObject({
      adapterVersion: "piper-tts-adapter-v1",
      effectiveModelVersion: "1.4.2",
      selector: "piper-tts.cpu",
    });
  });

  it("fails closed for an unknown activation state", () => {
    expect(() =>
      speechAdapterRegistry(
        { REFLO_PIPER_ACTIVATION_STATUS: "enabled" },
        primary,
      ),
    ).toThrowError(/activation status is invalid/);
  });
});

function piperEnvironment(): NodeJS.ProcessEnv {
  return {
    REFLO_PIPER_ACTIVATION_STATUS: "active",
    REFLO_PIPER_ARTIFACT_REVISION: "5b44ec7bab7c5822cfec48fbd5aa99db71a823d6",
    REFLO_PIPER_CONFIG_PATH:
      "/opt/reflo/piper/voice/en_US-ljspeech-high.onnx.json",
    REFLO_PIPER_CONFIG_SHA256:
      "7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14",
    REFLO_PIPER_MODEL_PATH: "/opt/reflo/piper/voice/en_US-ljspeech-high.onnx",
    REFLO_PIPER_MODEL_SHA256:
      "5d4f08ba6a2a48c44592eed3ce56bf85e9de3dd4e20df90541ae68a8310c029a",
    REFLO_PIPER_PYTHON_EXECUTABLE: "/opt/reflo/piper/bin/python",
    REFLO_PIPER_SCRATCH_ROOT: "/tmp/reflo-piper-work",
    REFLO_PIPER_VOICE_ARTIFACT_VERSION: "piper-voice-en-us-ljspeech-high-v1",
    REFLO_PIPER_WORKER_PATH: "/opt/reflo/piper/worker.py",
  };
}
