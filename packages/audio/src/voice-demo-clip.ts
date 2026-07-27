import { createHash } from "node:crypto";

import {
  AUDIO_PAYLOAD_VERSION,
  type AudioPayloadResult,
} from "@reflo/model-router";

export const VOICE_DEMO_CLIP_CONTRACT_VERSION =
  "voice-tutoring-recorded-clip-v1" as const;
export const VOICE_DEMO_SOURCE_SPAN_ID =
  "16400000-0000-4000-8000-00000000000b" as const;
export const VOICE_DEMO_SOURCE_TEXT =
  "Retention improves when a learner retrieves knowledge in a distinct assessment; viewing a lesson alone is not evidence." as const;
export const VOICE_DEMO_QUESTION =
  "Why doesn't viewing a lesson immediately raise mastery?" as const;
export const VOICE_DEMO_ANSWER =
  "Because seeing an explanation is exposure, not assessment evidence. Mastery changes only after the learner retrieves the idea in a distinct check." as const;
export const VOICE_DEMO_TRANSCRIPT =
  `Recorded prototype, not live voice tutoring. Staff question: ${VOICE_DEMO_QUESTION} Reflo answer: ${VOICE_DEMO_ANSWER} Citation: Synthetic Connected Flow B, Evidence and retention.` as const;

export interface VoiceDemoClipManifest {
  readonly answer: typeof VOICE_DEMO_ANSWER;
  readonly artifact: {
    readonly byteLength: number;
    readonly channels: 1;
    readonly codec: "pcm_s16le";
    readonly container: "wav";
    readonly durationSeconds: number;
    readonly file: "voice-tutoring-recorded-prototype.wav";
    readonly sampleRateHz: 22_050 | 24_000;
    readonly sha256: string;
  };
  readonly artifactClass: "recorded-prototype";
  readonly citation: {
    readonly label: "Synthetic Connected Flow B › Evidence and retention";
    readonly sourceSpanIds: readonly [typeof VOICE_DEMO_SOURCE_SPAN_ID];
  };
  readonly contractVersion: typeof VOICE_DEMO_CLIP_CONTRACT_VERSION;
  readonly displayLabel: "Recorded prototype · not live voice tutoring";
  readonly featureGate: {
    readonly key: "p1.tutor.voice";
    readonly liveRuntimeEligible: false;
    readonly runtimeDefault: false;
  };
  readonly nonClaims: readonly [
    "shipped voice runtime",
    "live streaming chat",
    "live tutor-answer generation",
    "runtime trace evidence",
    "Piper production activation",
    "external learner readiness",
  ];
  readonly provenance: {
    readonly answerOrigin: "frozen-source-backed-prototype-script";
    readonly adapterContractUsed: "piper-tts-adapter-v1";
    readonly liveTutorRouteUsed: false;
    readonly mediaTaskContract: "media.tts.v1";
    readonly runtimeTraceEmitted: false;
    readonly synthesisClass: "development-only-recording";
  };
  readonly question: typeof VOICE_DEMO_QUESTION;
  readonly source: {
    readonly class: "synthetic-staff-controlled";
    readonly course: "Synthetic Connected Flow B";
    readonly sourceTextSha256: string;
    readonly span: "Evidence and retention";
  };
  readonly synthesis: {
    readonly activationBlockers: readonly string[];
    readonly engine: "piper";
    readonly engineVersion: "1.4.2";
    readonly piperManifestActivationStatus: "blocked";
    readonly settingsVersion: "piper-settings-v1";
    readonly voiceArtifactRevision: string;
    readonly voiceArtifactVersion: string;
    readonly voiceConfigSha256: string;
    readonly voiceId: "en_US-ljspeech-high";
    readonly voiceModelSha256: string;
    readonly voiceProfileId: "en-US/reflo-narrator-v1";
  };
  readonly transcript: typeof VOICE_DEMO_TRANSCRIPT;
}

export function buildVoiceDemoClipManifest(input: {
  readonly activationBlockers: readonly string[];
  readonly audio: AudioPayloadResult;
  readonly voiceArtifactRevision: string;
  readonly voiceConfigSha256: string;
  readonly voiceModelSha256: string;
}): VoiceDemoClipManifest {
  const audio = input.audio;
  if (
    audio.contractVersion !== AUDIO_PAYLOAD_VERSION ||
    audio.engine !== "piper" ||
    audio.engineVersion !== "1.4.2" ||
    audio.settingsVersion !== "piper-settings-v1" ||
    audio.voiceId !== "en_US-ljspeech-high" ||
    audio.voiceProfileId !== "en-US/reflo-narrator-v1" ||
    audio.channels !== 1 ||
    audio.codec !== "pcm_s16le" ||
    audio.container !== "wav" ||
    !audio.headerValidated ||
    audio.byteLength !== audio.bytes.byteLength ||
    !Number.isFinite(audio.durationSeconds) ||
    audio.durationSeconds <= 0 ||
    audio.sourceSpanIds.length !== 1 ||
    audio.sourceSpanIds[0] !== VOICE_DEMO_SOURCE_SPAN_ID ||
    audio.payloadSha256 !== sha256(audio.bytes) ||
    input.activationBlockers.length === 0 ||
    input.activationBlockers.some(
      (blocker) =>
        blocker.length < 3 ||
        blocker.length > 240 ||
        !/^[\x20-\x7e]+$/.test(blocker),
    ) ||
    !safeSha256(input.voiceConfigSha256) ||
    !safeSha256(input.voiceModelSha256) ||
    !safeVersion(input.voiceArtifactRevision) ||
    !safeVersion(audio.voiceArtifactVersion)
  ) {
    throw new Error("voice demo clip evidence is invalid");
  }
  return {
    answer: VOICE_DEMO_ANSWER,
    artifact: {
      byteLength: audio.byteLength,
      channels: audio.channels,
      codec: audio.codec,
      container: audio.container,
      durationSeconds: audio.durationSeconds,
      file: "voice-tutoring-recorded-prototype.wav",
      sampleRateHz: audio.sampleRateHz,
      sha256: audio.payloadSha256,
    },
    artifactClass: "recorded-prototype",
    citation: {
      label: "Synthetic Connected Flow B › Evidence and retention",
      sourceSpanIds: [VOICE_DEMO_SOURCE_SPAN_ID],
    },
    contractVersion: VOICE_DEMO_CLIP_CONTRACT_VERSION,
    displayLabel: "Recorded prototype · not live voice tutoring",
    featureGate: {
      key: "p1.tutor.voice",
      liveRuntimeEligible: false,
      runtimeDefault: false,
    },
    nonClaims: [
      "shipped voice runtime",
      "live streaming chat",
      "live tutor-answer generation",
      "runtime trace evidence",
      "Piper production activation",
      "external learner readiness",
    ],
    provenance: {
      answerOrigin: "frozen-source-backed-prototype-script",
      adapterContractUsed: "piper-tts-adapter-v1",
      liveTutorRouteUsed: false,
      mediaTaskContract: "media.tts.v1",
      runtimeTraceEmitted: false,
      synthesisClass: "development-only-recording",
    },
    question: VOICE_DEMO_QUESTION,
    source: {
      class: "synthetic-staff-controlled",
      course: "Synthetic Connected Flow B",
      sourceTextSha256: sha256(Buffer.from(VOICE_DEMO_SOURCE_TEXT, "utf8")),
      span: "Evidence and retention",
    },
    synthesis: {
      activationBlockers: input.activationBlockers,
      engine: "piper",
      engineVersion: "1.4.2",
      piperManifestActivationStatus: "blocked",
      settingsVersion: "piper-settings-v1",
      voiceArtifactRevision: input.voiceArtifactRevision,
      voiceArtifactVersion: audio.voiceArtifactVersion,
      voiceConfigSha256: input.voiceConfigSha256,
      voiceId: "en_US-ljspeech-high",
      voiceModelSha256: input.voiceModelSha256,
      voiceProfileId: "en-US/reflo-narrator-v1",
    },
    transcript: VOICE_DEMO_TRANSCRIPT,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function safeVersion(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value);
}
