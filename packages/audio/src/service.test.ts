import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AUDIO_PAYLOAD_VERSION,
  createModelRouter,
  REFLO_NARRATOR_VOICE_PROFILE,
} from "@reflo/model-router";
import {
  createScriptedAdapterRegistry,
  InMemoryTraceSink,
  type ScriptedAdapterAction,
} from "@reflo/model-router/testing";

import type {
  AudioGenerationEnvelope,
  AuthorizedAudioCourse,
} from "./contracts.js";
import { AudioGenerationService } from "./service.js";
import {
  createPcmWavFixture,
  FixedAudioClock,
  InMemoryAudioArtifactWriter,
  InMemoryAudioGenerationRepository,
} from "./testing.js";

const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  scope: "00000000-0000-4000-8000-000000000101",
  document: "00000000-0000-4000-8000-000000000201",
  course: "00000000-0000-4000-8000-000000000301",
  chapterA: "00000000-0000-4000-8000-000000000401",
  chapterB: "00000000-0000-4000-8000-000000000402",
  scriptA: "00000000-0000-4000-8000-000000000501",
  scriptB: "00000000-0000-4000-8000-000000000502",
  spanA: "00000000-0000-4000-8000-000000000601",
  spanB: "00000000-0000-4000-8000-000000000602",
} as const;

const now = new Date("2026-07-21T16:00:00.000Z");
const authorization = {
  actorId: ids.actor,
  authorizationId: "authorization-fixture-1",
  ownerScopeId: ids.scope,
} as const;

describe("queue-driven audio generation", () => {
  it("plans every chapter in chapter order with opaque queue envelopes", async () => {
    const fixture = setup([]);
    const first = await fixture.service.plan({
      authorization,
      courseId: ids.course,
      deadlineAt: new Date(now.getTime() + 10 * 60_000),
      environment: "dev",
    });
    const replay = await fixture.service.plan({
      authorization,
      courseId: ids.course,
      deadlineAt: new Date(now.getTime() + 10 * 60_000),
      environment: "dev",
    });

    expect(first.map((operation) => operation.chapterId)).toEqual([
      ids.chapterA,
      ids.chapterB,
    ]);
    expect(first.map((operation) => operation.priority)).toEqual([1, 2]);
    expect(replay.map((operation) => operation.id)).toEqual(
      first.map((operation) => operation.id),
    );
    const serialized = JSON.stringify(fixture.envelopes);
    expect(serialized).not.toContain("Narration for");
    expect(serialized).not.toContain(ids.spanA);
  });

  it("finalizes one private WAV asset and replays the stored terminal result", async () => {
    const wav = createPcmWavFixture();
    const fixture = setup([
      { type: "result", value: audioPayload(wav, "qwen") },
    ]);
    const operations = await plan(fixture.service);
    const envelope = fixture.envelopes[0];

    const completed = await fixture.service.consume({
      authorization,
      envelope,
    });
    const replay = await fixture.service.consume({ authorization, envelope });

    expect(completed).toMatchObject({
      assetId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      attemptCount: 1,
      status: "succeeded",
    });
    expect(replay).toEqual(completed);
    expect(fixture.artifacts.writes).toBe(1);
    expect(fixture.scripted.invocations).toHaveLength(1);
    expect(operations[0]?.idempotencyKey).toMatch(
      /^dev\/media\.audio\.generate\/v1\//,
    );
  });

  it("falls back sequentially only after known non-acceptance", async () => {
    const wav = createPcmWavFixture(24_000);
    const fixture = setup([
      {
        safeCode: "capacity_unavailable",
        submissionState: "not_accepted",
        transient: true,
        type: "failure",
      },
      { type: "result", value: audioPayload(wav, "piper") },
    ]);
    await plan(fixture.service);

    const completed = await fixture.service.consume({
      authorization,
      envelope: fixture.envelopes[0],
    });

    expect(completed.status).toBe("succeeded");
    expect(fixture.scripted.invocations).toHaveLength(2);
    expect(fixture.traces.traces[0]?.attempts).toMatchObject([
      { requestedSelector: "qwen-tts.primary" },
      { requestedSelector: "piper-tts.cpu" },
    ]);
  });

  it("does not fall back or blindly resubmit after an ambiguous timeout", async () => {
    const fixture = setup([
      {
        safeCode: "timeout",
        submissionState: "unknown",
        transient: true,
        type: "failure",
      },
    ]);
    await plan(fixture.service);

    const failed = await fixture.service.consume({
      authorization,
      envelope: fixture.envelopes[0],
    });

    expect(failed).toMatchObject({
      failureClass: "ambiguous_submission",
      status: "failed_permanent",
    });
    expect(fixture.scripted.invocations).toHaveLength(1);
  });

  it("rejects a different envelope for an already registered operation", async () => {
    const fixture = setup([]);
    await plan(fixture.service);
    const original = fixture.envelopes[0];
    if (original === undefined) {
      throw new Error("fixture envelope missing");
    }

    await expect(
      fixture.service.consume({
        authorization,
        envelope: {
          ...original,
          messageId: "00000000-0000-4000-8000-000000009999",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_envelope" });
    expect(fixture.scripted.invocations).toHaveLength(0);
  });

  it("rejects queue-supplied scope references that disagree with authorization", async () => {
    const fixture = setup([]);
    await plan(fixture.service);
    const original = fixture.envelopes[0];
    if (original === undefined) {
      throw new Error("fixture envelope missing");
    }
    const envelope = {
      ...original,
      payload: {
        ...original.payload,
        ownerScopeId: "00000000-0000-4000-8000-000000009999",
      },
    };

    await expect(
      fixture.service.consume({ authorization, envelope }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
    expect(fixture.scripted.invocations).toHaveLength(0);
  });
});

function setup(actions: readonly ScriptedAdapterAction[]) {
  const repository = new InMemoryAudioGenerationRepository();
  repository.addCourse(courseFixture());
  const scripted = createScriptedAdapterRegistry({
    "media.tts.v1": actions,
  });
  const traces = new InMemoryTraceSink();
  const artifacts = new InMemoryAudioArtifactWriter();
  const service = new AudioGenerationService({
    artifacts,
    clock: new FixedAudioClock(now),
    models: createModelRouter({
      adapters: scripted.adapters,
      traceSink: traces,
    }),
    repository,
  });
  const envelopes: AudioGenerationEnvelope[] = [];
  const originalRegister = repository.registerOperations.bind(repository);
  repository.registerOperations = async (course, operations) => {
    envelopes.push(
      ...operations.map((operation) => structuredClone(operation.envelope)),
    );
    return originalRegister(course, operations);
  };
  return { artifacts, envelopes, repository, scripted, service, traces };
}

function plan(service: AudioGenerationService) {
  return service.plan({
    authorization,
    courseId: ids.course,
    deadlineAt: new Date(now.getTime() + 10 * 60_000),
    environment: "dev",
  });
}

function audioPayload(wav: Uint8Array, engine: "piper" | "qwen") {
  const sampleRateHz = new DataView(wav.buffer).getUint32(24, true) as
    22_050 | 24_000;
  return {
    bytes: wav,
    byteLength: wav.byteLength,
    channels: 1,
    codec: "pcm_s16le",
    container: "wav",
    contractVersion: AUDIO_PAYLOAD_VERSION,
    durationSeconds: (wav.byteLength - 44) / (sampleRateHz * 2),
    engine,
    engineVersion: engine === "piper" ? "1.4.2" : "2026-07-01",
    headerValidated: true,
    payloadSha256: createHash("sha256").update(wav).digest("hex"),
    sampleRateHz,
    settingsVersion: `${engine}-settings-v1`,
    sourceSpanIds: [ids.spanA],
    voiceArtifactVersion: `${engine}-voice-v1`,
    voiceId: engine === "piper" ? "en_US-ljspeech-high" : "cherry",
    voiceProfileId: REFLO_NARRATOR_VOICE_PROFILE,
  } as const;
}

function courseFixture(): AuthorizedAudioCourse {
  const provenance = {
    adapterVersion: "scripted-adapter-v1",
    evidenceClassification: "authoritative",
    effectiveModel: "qwen-plus",
    effectiveModelVersion: "fixture-v1",
    generationParametersVersion: "parameters-v1",
    inputSchemaVersion: "lesson-input-v1",
    promptDigest: "a".repeat(64),
    promptId: "lesson-audio-script",
    promptVersion: "1",
    requestedSelector: "qwen.grounded-generation",
    resultSchemaVersion: "audio-script-result-v1",
    routePolicyVersion: "route-policy-v2",
    task: "lesson.audio-script.v1",
    validationOutcome: "passed",
  } as const;
  const script = (id: string, spanId: string, text: string) => ({
    id,
    modelProvenance: provenance,
    scriptSha256: createHash("sha256").update(text).digest("hex"),
    sourceSpanIds: [spanId],
    text,
    version: "narration-script-v1",
  });
  return {
    actorId: ids.actor,
    authorizationId: authorization.authorizationId,
    chapters: [
      {
        chapterOrder: 1,
        id: ids.chapterA,
        narration: script(ids.scriptA, ids.spanA, "Narration for chapter one."),
      },
      {
        chapterOrder: 2,
        id: ids.chapterB,
        narration: script(ids.scriptB, ids.spanB, "Narration for chapter two."),
      },
    ],
    courseId: ids.course,
    ownerScopeId: ids.scope,
    sourceDocumentId: ids.document,
  };
}
