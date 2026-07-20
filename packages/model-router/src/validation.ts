import type { ModelTaskId } from "./contracts.js";

type Validator = (value: unknown) => boolean;

export const RESULT_VALIDATORS: Readonly<Record<ModelTaskId, Validator>> = {
  "assessment.grade-short-answer.v1": (value) =>
    isRecord(value) &&
    isArrayOf(value.evidence, (entry) =>
      isRecordWith(entry, {
        conceptId: isString,
        confidence: isUnitNumber,
        rubricBand: isString,
        score: isUnitNumber,
      }),
    ),
  "assessment.quiz.v1": (value) =>
    isRecord(value) &&
    isArrayOf(
      value.items,
      (entry) =>
        isRecord(entry) &&
        isStringArray(entry.conceptIds) &&
        isString(entry.keyedAnswer) &&
        isString(entry.prompt) &&
        isStringArray(entry.sourceSpanIds),
    ),
  "curriculum.structure.v1": (value) =>
    isRecord(value) &&
    isArrayOf(
      value.chapters,
      (entry) =>
        isRecord(entry) &&
        isStringArray(entry.conceptNames) &&
        isStringArray(entry.sourceSpanIds) &&
        isString(entry.title),
    ),
  "embedding.document.v1": isEmbeddingResult,
  "embedding.query.v1": isEmbeddingResult,
  "lesson.audio-script.v1": (value) =>
    isRecord(value) &&
    isString(value.script) &&
    isStringArray(value.sourceSpanIds),
  "lesson.reteach.v1": isLessonResult,
  "lesson.text.v1": isLessonResult,
  "media.tts.v1": isMediaAssetResult,
  "media.video.v1": isMediaAssetResult,
  "tutor.answer.v1": (value) =>
    isRecord(value) &&
    (value.kind === "not_found" ||
      (value.kind === "answer" &&
        isString(value.content) &&
        isStringArray(value.sourceSpanIds))),
};

function isEmbeddingResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    isArrayOf(
      value.vectors,
      (vector) => Array.isArray(vector) && vector.every(isFiniteNumber),
    )
  );
}

function isLessonResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.content) &&
    isStringArray(value.sourceSpanIds) &&
    isString(value.strategyTag)
  );
}

function isMediaAssetResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.durationSeconds) &&
    value.durationSeconds > 0 &&
    isString(value.mimeType) &&
    isStringArray(value.sourceSpanIds) &&
    isString(value.uri)
  );
}

function isArrayOf(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    Object.entries(fields).every(([key, predicate]) => predicate(value[key]))
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return isArrayOf(value, isString);
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}
