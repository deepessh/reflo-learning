import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("pinned Piper worker candidate", () => {
  it("pins every distributable input and remains activation-blocked", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../piper-worker/manifest.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      activationStatus: "blocked",
      baseImage: {
        pythonVersion: "3.13.12",
        reference: expect.stringMatching(
          /^python:3\.13\.12-slim-bookworm@sha256:[a-f0-9]{64}$/,
        ),
      },
      cpuOnly: true,
      finalImageDigest: null,
      onnxRuntime: {
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        version: "1.27.0",
      },
      piper: {
        embeddedEspeakPinnedByWheelDigest: true,
        license: "GPL-3.0-or-later",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        version: "1.4.2",
      },
      runtimeDownloadsAllowed: false,
      voice: {
        configSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        metadataInconsistencyRequiresGateReview: true,
        modelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        profileId: "en-US/reflo-narrator-v1",
        revision: expect.stringMatching(/^[a-f0-9]{40}$/),
        voiceId: "en_US-ljspeech-high",
      },
    });
    expect(manifest.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("GPL"),
        expect.stringContaining("benchmark"),
        expect.stringContaining("listening"),
      ]),
    );
  });
});
