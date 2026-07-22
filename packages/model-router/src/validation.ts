import { createHash } from "node:crypto";

import type {
  AuthorizedSourceSpan,
  EmbeddingInput,
  LessonInput,
  ModelTaskId,
  ModelTaskInput,
  TextToSpeechInput,
  TutorAnswerInput,
} from "./contracts.js";
import {
  AUDIO_PAYLOAD_VERSION,
  QUIZ_ITEM_TYPES,
  TTS_ALLOWED_SAMPLE_RATES,
} from "./contracts.js";

export const EMBEDDING_V1_DIMENSIONS = 1_024 as const;

type Validator = (
  value: unknown,
  input: ModelTaskInput<ModelTaskId>,
) => boolean;

export const RESULT_VALIDATORS: Readonly<Record<ModelTaskId, Validator>> = {
  "assessment.grade-short-answer.v1":
    validator<"assessment.grade-short-answer.v1">((value, input) =>
      isRecordWith(value, {
        evidence: (evidence) =>
          Array.isArray(evidence) &&
          evidence.length > 0 &&
          evidence.every((entry) =>
            isRecordWith(entry, {
              conceptId: (conceptId) =>
                isString(conceptId) && input.conceptIds.includes(conceptId),
              confidence: isUnitNumber,
              rubricBand: isString,
              score: isUnitNumber,
            }),
          ),
      }),
    ),
  "assessment.quiz.v1": validator<"assessment.quiz.v1">((value, input) =>
    isQuizGenerationResult(value, input),
  ),
  "curriculum.structure.v1": validator<"curriculum.structure.v1">(
    isCurriculumStructureResult,
  ),
  "embedding.document.v1": validator<"embedding.document.v1">((value, input) =>
    isEmbeddingResult(value, input, "document"),
  ),
  "embedding.query.v1": validator<"embedding.query.v1">((value, input) =>
    isEmbeddingResult(value, input, "query"),
  ),
  "lesson.audio-script.v1": validator<"lesson.audio-script.v1">(
    (value, input) =>
      isRecordWith(value, {
        script: isString,
        sourceSpanIds: (sourceSpanIds) =>
          isAuthorizedIds(sourceSpanIds, sourceIds(input.sourceSpans)),
      }),
  ),
  "lesson.reteach.v1": validator<"lesson.reteach.v1">(isLessonResult),
  "lesson.text.v1": validator<"lesson.text.v1">(isLessonResult),
  "media.tts.v1": validator<"media.tts.v1">((value, input) =>
    isAudioPayload(value, input),
  ),
  "media.video.v1": validator<"media.video.v1">((value, input) =>
    isVideoAssetResult(value, sourceIds(input.sourceSpans)),
  ),
  "tutor.answer.v1": validator<"tutor.answer.v1">(isTutorAnswerResult),
};

function validator<Task extends ModelTaskId>(
  validate: (value: unknown, input: ModelTaskInput<Task>) => boolean,
): Validator {
  return validate as Validator;
}

function isEmbeddingResult(
  value: unknown,
  input: EmbeddingInput,
  expectedInputMode: "document" | "query",
): boolean {
  return isRecordWith(value, {
    metadata: (metadata) =>
      isRecordWith(metadata, {
        dimensions: (dimensions) => dimensions === EMBEDDING_V1_DIMENSIONS,
        endpoint: isSafeProviderMetadata,
        inputMode: (inputMode) => inputMode === expectedInputMode,
        providerIdentifier: isSafeProviderMetadata,
        providerRequestId: isSafeProviderMetadata,
        region: isSafeProviderMetadata,
      }),
    vectors: (vectors) =>
      input.texts.length > 0 &&
      Array.isArray(vectors) &&
      vectors.length === input.texts.length &&
      vectors.every(
        (vector) =>
          Array.isArray(vector) &&
          vector.length === EMBEDDING_V1_DIMENSIONS &&
          vector.every(isFiniteNumber),
      ),
  });
}

function isCurriculumStructureResult(
  value: unknown,
  input: ModelTaskInput<"curriculum.structure.v1">,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["chapters"])) {
    return false;
  }
  if (!Array.isArray(value.chapters) || value.chapters.length === 0) {
    return false;
  }
  const authorizedSpanIds = sourceIds(input.sourceSpans);
  const seenConceptKeys = new Set<string>();
  for (const chapter of value.chapters) {
    if (
      !isRecord(chapter) ||
      !hasExactKeys(chapter, ["concepts", "sourceSpanIds", "title"]) ||
      !isString(chapter.title) ||
      !isAuthorizedIds(chapter.sourceSpanIds, authorizedSpanIds) ||
      !Array.isArray(chapter.concepts) ||
      chapter.concepts.length === 0
    ) {
      return false;
    }
    for (const concept of chapter.concepts) {
      if (
        !isRecord(concept) ||
        !hasExactKeys(concept, [
          "key",
          "name",
          "prerequisiteKeys",
          "sourceSpanIds",
        ]) ||
        !isSafeConceptKey(concept.key) ||
        seenConceptKeys.has(concept.key) ||
        !isString(concept.name) ||
        !Array.isArray(concept.prerequisiteKeys) ||
        concept.prerequisiteKeys.some(
          (key) => !isSafeConceptKey(key) || !seenConceptKeys.has(key),
        ) ||
        !isAuthorizedIds(concept.sourceSpanIds, authorizedSpanIds)
      ) {
        return false;
      }
      seenConceptKeys.add(concept.key);
    }
  }
  return true;
}

function isQuizGenerationResult(
  value: unknown,
  input: ModelTaskInput<"assessment.quiz.v1">,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["items"])) {
    return false;
  }
  if (!Array.isArray(value.items) || value.items.length !== input.count) {
    return false;
  }
  const itemTypes = new Set<string>();
  for (const entry of value.items) {
    if (!isRecord(entry)) {
      return false;
    }
    const optionalKeys = [
      ...(entry.responseOptions === undefined ? [] : ["responseOptions"]),
      ...(entry.rubric === undefined ? [] : ["rubric"]),
    ];
    if (
      !hasExactKeys(entry, [
        "conceptIds",
        "difficulty",
        "itemType",
        "keyedAnswer",
        "prompt",
        "sourceSpanIds",
        ...optionalKeys,
      ]) ||
      !isAuthorizedIds(entry.conceptIds, input.conceptIds) ||
      !isQuizDifficulty(entry.difficulty) ||
      !isQuizItemType(entry.itemType) ||
      !isString(entry.keyedAnswer) ||
      !isString(entry.prompt) ||
      !isAuthorizedIds(entry.sourceSpanIds, sourceIds(input.sourceSpans)) ||
      !isValidQuizShape(entry)
    ) {
      return false;
    }
    itemTypes.add(entry.itemType);
  }
  return (input.requiredItemTypes ?? []).every((type) => itemTypes.has(type));
}

function isValidQuizShape(entry: Record<string, unknown>): boolean {
  if (entry.itemType === "short_answer") {
    return isString(entry.rubric) && entry.responseOptions === undefined;
  }
  if (
    !Array.isArray(entry.responseOptions) ||
    entry.responseOptions.length < 2 ||
    !entry.responseOptions.every(isString) ||
    new Set(entry.responseOptions).size !== entry.responseOptions.length
  ) {
    return false;
  }
  return (
    entry.rubric === undefined &&
    typeof entry.keyedAnswer === "string" &&
    entry.responseOptions.includes(entry.keyedAnswer)
  );
}

function isQuizDifficulty(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5;
}

function isQuizItemType(value: unknown): value is string {
  return (QUIZ_ITEM_TYPES as readonly unknown[]).includes(value);
}

function isLessonResult(value: unknown, input: LessonInput): boolean {
  return isRecordWith(value, {
    content: isString,
    sourceSpanIds: (sourceSpanIds) =>
      isAuthorizedIds(sourceSpanIds, sourceIds(input.sourceSpans)),
    strategyTag: isString,
  });
}

function isAudioPayload(value: unknown, input: TextToSpeechInput): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "bytes",
      "byteLength",
      "channels",
      "codec",
      "container",
      "contractVersion",
      "durationSeconds",
      "engine",
      "engineVersion",
      "headerValidated",
      "payloadSha256",
      "sampleRateHz",
      "settingsVersion",
      "sourceSpanIds",
      "voiceArtifactVersion",
      "voiceId",
      "voiceProfileId",
    ]) ||
    !(value.bytes instanceof Uint8Array) ||
    value.contractVersion !== AUDIO_PAYLOAD_VERSION ||
    value.container !== "wav" ||
    value.codec !== "pcm_s16le" ||
    value.channels !== 1 ||
    value.headerValidated !== true ||
    value.voiceProfileId !== input.voiceProfileId ||
    !isSafeProviderMetadata(value.engine) ||
    !isSafeProviderMetadata(value.engineVersion) ||
    !isSafeProviderMetadata(value.voiceArtifactVersion) ||
    !isSafeProviderMetadata(value.voiceId) ||
    !isSafeProviderMetadata(value.settingsVersion) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength !== value.bytes.byteLength ||
    !isFiniteNumber(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    !(TTS_ALLOWED_SAMPLE_RATES as readonly unknown[]).includes(
      value.sampleRateHz,
    ) ||
    !/^[a-f0-9]{64}$/.test(String(value.payloadSha256)) ||
    value.payloadSha256 !== sha256(value.bytes) ||
    !isAuthorizedIds(value.sourceSpanIds, input.sourceSpanIds)
  ) {
    return false;
  }
  return isValidPcmWav(
    value.bytes,
    value.sampleRateHz as (typeof TTS_ALLOWED_SAMPLE_RATES)[number],
    value.durationSeconds,
  );
}

function isValidPcmWav(
  bytes: Uint8Array,
  expectedSampleRate: number,
  expectedDurationSeconds: number,
): boolean {
  if (bytes.byteLength < 44) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const dataLength = view.getUint32(40, true);
  const measuredDuration = dataLength / (expectedSampleRate * 2);
  return (
    ascii(0, 4) === "RIFF" &&
    ascii(8, 4) === "WAVE" &&
    ascii(12, 4) === "fmt " &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === expectedSampleRate &&
    view.getUint16(34, true) === 16 &&
    ascii(36, 4) === "data" &&
    dataLength === bytes.byteLength - 44 &&
    Math.abs(measuredDuration - expectedDurationSeconds) <=
      Math.max(1 / expectedSampleRate, expectedDurationSeconds * 0.001)
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isVideoAssetResult(
  value: unknown,
  authorizedSourceSpanIds: readonly string[],
): boolean {
  return isRecordWith(value, {
    durationSeconds: (durationSeconds) =>
      isFiniteNumber(durationSeconds) && durationSeconds > 0,
    mimeType: isString,
    sourceSpanIds: (sourceSpanIds) =>
      isAuthorizedIds(sourceSpanIds, authorizedSourceSpanIds),
    uri: isString,
  });
}

function isTutorAnswerResult(value: unknown, input: TutorAnswerInput): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "not_found") {
    return hasExactKeys(value, ["kind"]);
  }
  return isRecordWith(value, {
    content: isString,
    kind: (kind) => kind === "answer",
    sourceSpanIds: (sourceSpanIds) =>
      isAuthorizedIds(sourceSpanIds, sourceIds(input.sourceSpans)),
  });
}

function isAuthorizedIds(
  value: unknown,
  authorizedIds: readonly string[],
): value is readonly string[] {
  return (
    isNonEmptyStringArray(value) &&
    value.every((id) => authorizedIds.includes(id))
  );
}

function sourceIds(spans: readonly AuthorizedSourceSpan[]): readonly string[] {
  return spans.map((span) => span.id);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeConceptKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function isSafeProviderMetadata(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\r\n]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordWith(
  value: unknown,
  fields: Readonly<Record<string, (entry: unknown) => boolean>>,
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, Object.keys(fields)) &&
    Object.entries(fields).every(([key, predicate]) => predicate(value[key]))
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isString);
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}
