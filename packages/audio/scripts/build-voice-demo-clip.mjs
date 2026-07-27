#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  TTS_ALLOWED_SAMPLE_RATES,
  TTS_SYNTHESIS_REQUEST_VERSION,
} from "@reflo/model-router";
import {
  NodePiperSynthesisProcess,
  createPiperTtsAdapter,
} from "@reflo/model-router/tts";

import {
  VOICE_DEMO_SOURCE_SPAN_ID,
  VOICE_DEMO_TRANSCRIPT,
  buildVoiceDemoClipManifest,
} from "../dist/index.js";

const audioRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(audioRoot, "../..");
const profile = await readProfile(
  path.join(repositoryRoot, ".reflo/local-workers/profile.env"),
);
const piperManifest = JSON.parse(
  await readFile(path.join(audioRoot, "piper-worker/manifest.json"), "utf8"),
);
const artifactRevision = required(
  profile,
  "REFLO_LOCAL_PIPER_ARTIFACT_REVISION",
);
const configSha256 = required(profile, "REFLO_LOCAL_PIPER_CONFIG_SHA256");
const modelSha256 = required(profile, "REFLO_LOCAL_PIPER_MODEL_SHA256");
if (
  piperManifest.activationStatus !== "blocked" ||
  !Array.isArray(piperManifest.blockers) ||
  piperManifest.blockers.length === 0 ||
  piperManifest.voice?.revision !== artifactRevision ||
  piperManifest.voice?.configSha256 !== configSha256 ||
  piperManifest.voice?.modelSha256 !== modelSha256
) {
  throw new Error("the Piper candidate profile does not match its manifest");
}

const scratchRoot = path.join(
  repositoryRoot,
  ".reflo/voice-tutoring-recorded-prototype",
);
const synthesisProcess = new NodePiperSynthesisProcess({
  configPath: required(profile, "REFLO_LOCAL_PIPER_CONFIG_PATH"),
  configSha256,
  modelPath: required(profile, "REFLO_LOCAL_PIPER_MODEL_PATH"),
  modelSha256,
  pythonExecutable: required(profile, "REFLO_LOCAL_PIPER_PYTHON"),
  scratchRoot,
  workerPath: path.join(audioRoot, "piper-worker/worker.py"),
});
const voiceArtifactVersion = required(
  profile,
  "REFLO_LOCAL_PIPER_VOICE_ARTIFACT_VERSION",
);
const adapter = createPiperTtsAdapter({
  process: synthesisProcess,
  profile: {
    artifactRevision,
    configPath: required(profile, "REFLO_LOCAL_PIPER_CONFIG_PATH"),
    configSha256,
    modelPath: required(profile, "REFLO_LOCAL_PIPER_MODEL_PATH"),
    modelSha256,
    runtimeDownloadsAllowed: false,
    voiceArtifactVersion,
  },
});
const response = await adapter.synthesize({
  input: {
    contractVersion: TTS_SYNTHESIS_REQUEST_VERSION,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    generationReference: "voice-demo-generation-001",
    locale: "en-US",
    narration: VOICE_DEMO_TRANSCRIPT,
    narrationScriptId: "voice-demo-script-001",
    operationId: "voice-demo-operation-001",
    output: {
      allowedSampleRates: TTS_ALLOWED_SAMPLE_RATES,
      channels: 1,
      codec: "pcm_s16le",
      container: "wav",
    },
    scriptSha256: sha256(Buffer.from(VOICE_DEMO_TRANSCRIPT, "utf8")),
    sourceSpanIds: [VOICE_DEMO_SOURCE_SPAN_ID],
    speakingRate: 1,
    voiceProfileId: "en-US/reflo-narrator-v1",
  },
  signal: globalThis.AbortSignal.timeout(120_000),
  task: "media.tts.v1",
});
const audio = response.value;
const manifest = buildVoiceDemoClipManifest({
  activationBlockers: piperManifest.blockers,
  audio,
  voiceArtifactRevision: artifactRevision,
  voiceConfigSha256: configSha256,
  voiceModelSha256: modelSha256,
});
const outputRoot = path.join(
  repositoryRoot,
  "demo-artifacts/voice-tutoring-recorded-prototype",
);
await mkdir(outputRoot, { recursive: true });
await Promise.all([
  writeFile(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  ),
  writeFile(
    path.join(outputRoot, "voice-tutoring-recorded-prototype.wav"),
    audio.bytes,
    { mode: 0o644 },
  ),
]);
process.stdout.write(
  `${JSON.stringify({
    artifact: "voice-tutoring-recorded-prototype.wav",
    byteLength: audio.byteLength,
    contractVersion: manifest.contractVersion,
    durationSeconds: audio.durationSeconds,
    runtimeCapability: false,
    sha256: audio.payloadSha256,
  })}\n`,
);

async function readProfile(profilePath) {
  const values = {};
  for (const rawLine of (await readFile(profilePath, "utf8")).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) {
      throw new Error("the local worker profile is malformed");
    }
    const [, key, rawValue] = match;
    if (!key.startsWith("REFLO_")) {
      throw new Error("the local worker profile contains an unknown key");
    }
    values[key] = parseProfileValue(rawValue);
  }
  return values;
}

function parseProfileValue(rawValue) {
  if (/^'[^']*'$/.test(rawValue)) {
    return rawValue.slice(1, -1);
  }
  if (/^[A-Za-z0-9_./:@+-]+$/.test(rawValue)) {
    return rawValue;
  }
  throw new Error("the local worker profile contains an unsafe value");
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
