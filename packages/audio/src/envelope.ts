import {
  AUDIO_MESSAGE_NAME,
  AUDIO_MESSAGE_VERSION,
  type AudioGenerationEnvelope,
} from "./contracts.js";
import { AudioGenerationError } from "./errors.js";

export function validateAudioGenerationEnvelope(
  value: unknown,
): AudioGenerationEnvelope {
  if (!isRecord(value)) {
    throw invalid();
  }
  const optional = value.causationId === undefined ? [] : ["causationId"];
  if (
    !hasExactKeys(value, [
      ...optional,
      "correlationId",
      "deadlineAt",
      "environment",
      "idempotencyKey",
      "messageId",
      "messageKind",
      "messageName",
      "messageVersion",
      "occurredAt",
      "payload",
      "producer",
    ]) ||
    value.messageKind !== "command" ||
    value.messageName !== AUDIO_MESSAGE_NAME ||
    value.messageVersion !== AUDIO_MESSAGE_VERSION ||
    value.producer !== "audio-generation" ||
    !["dev", "staging", "pilot"].includes(String(value.environment)) ||
    !isUuid(value.messageId) ||
    !isUuid(value.correlationId) ||
    (value.causationId !== undefined && !isUuid(value.causationId)) ||
    !isIsoUtc(value.occurredAt) ||
    !isIsoUtc(value.deadlineAt) ||
    Date.parse(value.deadlineAt as string) <=
      Date.parse(value.occurredAt as string) ||
    !isIdempotencyKey(value.idempotencyKey, String(value.environment)) ||
    !isRecord(value.payload) ||
    !hasExactKeys(value.payload, ["courseId", "operationId", "ownerScopeId"]) ||
    !isUuid(value.payload.courseId) ||
    !isUuid(value.payload.operationId) ||
    !isUuid(value.payload.ownerScopeId) ||
    !String(value.idempotencyKey).endsWith(`/${value.payload.operationId}`)
  ) {
    throw invalid();
  }
  return value as unknown as AudioGenerationEnvelope;
}

function invalid(): AudioGenerationError {
  return new AudioGenerationError("invalid_envelope");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

function isIsoUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isIdempotencyKey(value: unknown, environment: string): boolean {
  return (
    typeof value === "string" &&
    new RegExp(
      `^${environment}/media[.]audio[.]generate/v1/[a-f0-9-]{36}$`,
    ).test(value)
  );
}
