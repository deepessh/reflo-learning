import { createHash } from "node:crypto";

import type {
  AudioArtifactWriteResult,
  AudioGenerationClaim,
  AudioGenerationFailure,
  AudioGenerationWork,
  AudioOperationView,
  AuthorizedAudioCourse,
  GeneratedAudioAsset,
  PlannedAudioOperation,
} from "./contracts.js";
import { AUDIO_MAX_DELIVERIES } from "./contracts.js";
import { validateAudioGenerationEnvelope } from "./envelope.js";
import { AudioGenerationError } from "./errors.js";
import type {
  AudioArtifactWriterPort,
  AudioClock,
  AudioGenerationRepositoryPort,
} from "./ports.js";

export class FixedAudioClock implements AudioClock {
  constructor(private readonly value: Date) {}

  now(): Date {
    return new Date(this.value);
  }
}

export class InMemoryAudioGenerationRepository implements AudioGenerationRepositoryPort {
  readonly #courses = new Map<string, AuthorizedAudioCourse>();
  readonly #envelopes = new Map<string, PlannedAudioOperation["envelope"]>();
  readonly #operations = new Map<string, AudioOperationView>();

  addCourse(course: AuthorizedAudioCourse): void {
    this.#courses.set(course.courseId, course);
  }

  async loadCourse(
    authorization: {
      readonly actorId: string;
      readonly authorizationId: string;
      readonly ownerScopeId: string;
    },
    courseId: string,
  ): Promise<AuthorizedAudioCourse | null> {
    const course = this.#courses.get(courseId);
    return course !== undefined && authorized(course, authorization)
      ? course
      : null;
  }

  async registerOperations(
    course: AuthorizedAudioCourse,
    operations: readonly PlannedAudioOperation[],
  ): Promise<readonly AudioOperationView[]> {
    for (const operation of operations) {
      validateAudioGenerationEnvelope(operation.envelope);
      const previous = this.#operations.get(operation.id);
      if (previous === undefined) {
        this.#envelopes.set(operation.id, structuredClone(operation.envelope));
        this.#operations.set(operation.id, {
          assetId: null,
          attemptCount: 0,
          chapterId: operation.chapterId,
          deadlineAt: operation.deadlineAt,
          failureClass: null,
          generationVersion: operation.generationVersion,
          id: operation.id,
          idempotencyKey: operation.idempotencyKey,
          narrationScriptId: operation.narrationScriptId,
          priority: operation.priority,
          status: "queued",
          updatedAt: new Date(operation.envelope.occurredAt),
        });
      } else if (
        previous.chapterId !== operation.chapterId ||
        previous.narrationScriptId !== operation.narrationScriptId ||
        previous.idempotencyKey !== operation.idempotencyKey
      ) {
        throw new AudioGenerationError("invalid_result");
      }
    }
    return operations.map((operation) =>
      required(this.#operations.get(operation.id)),
    );
  }

  async claimOperation(
    authorization: {
      readonly actorId: string;
      readonly authorizationId: string;
      readonly ownerScopeId: string;
    },
    envelope: PlannedAudioOperation["envelope"],
  ): Promise<AudioGenerationClaim | null> {
    const courseId = envelope.payload.courseId;
    const operationId = envelope.payload.operationId;
    const course = this.#courses.get(courseId);
    const current = this.#operations.get(operationId);
    const canonicalEnvelope = this.#envelopes.get(operationId);
    if (
      canonicalEnvelope !== undefined &&
      JSON.stringify(canonicalEnvelope) !== JSON.stringify(envelope)
    ) {
      throw new AudioGenerationError("invalid_envelope");
    }
    if (
      course === undefined ||
      current === undefined ||
      canonicalEnvelope === undefined ||
      !authorized(course, authorization)
    ) {
      return null;
    }
    if (isTerminal(current.status)) {
      return { kind: "already_final", status: current };
    }
    if (current.status === "processing") {
      return { kind: "active" };
    }
    const chapter = course.chapters.find(
      (candidate) => candidate.id === current.chapterId,
    );
    if (
      chapter === undefined ||
      chapter.narration.id !== current.narrationScriptId
    ) {
      return null;
    }
    const claimed: AudioOperationView = {
      ...current,
      attemptCount: current.attemptCount + 1,
      failureClass: null,
      status: "processing",
      updatedAt: new Date(),
    };
    this.#operations.set(operationId, claimed);
    return { kind: "claimed", work: { chapter, course, operation: claimed } };
  }

  async completeAudio(
    work: AudioGenerationWork,
    asset: GeneratedAudioAsset,
  ): Promise<AudioOperationView> {
    const current = required(this.#operations.get(work.operation.id));
    if (isTerminal(current.status)) {
      return current;
    }
    assertSameAttempt(current, work);
    const completed: AudioOperationView = {
      ...current,
      assetId: asset.assetId,
      failureClass: null,
      status: "succeeded",
      updatedAt: new Date(),
    };
    this.#operations.set(current.id, completed);
    return completed;
  }

  async recordFailure(
    work: AudioGenerationWork,
    failure: AudioGenerationFailure,
  ): Promise<AudioOperationView> {
    const current = required(this.#operations.get(work.operation.id));
    if (isTerminal(current.status)) {
      return current;
    }
    assertSameAttempt(current, work);
    const retryable =
      failure.retryable && current.attemptCount < AUDIO_MAX_DELIVERIES;
    const failed: AudioOperationView = {
      ...current,
      failureClass: failure.failureClass,
      status: retryable ? "retry_scheduled" : failure.terminalStatus,
      updatedAt: new Date(),
    };
    this.#operations.set(current.id, failed);
    return failed;
  }

  async listOperations(
    authorization: {
      readonly actorId: string;
      readonly authorizationId: string;
      readonly ownerScopeId: string;
    },
    courseId: string,
  ): Promise<readonly AudioOperationView[]> {
    const course = this.#courses.get(courseId);
    if (course === undefined || !authorized(course, authorization)) {
      throw new AudioGenerationError("authorization_denied");
    }
    const chapterIds = new Set(course.chapters.map((chapter) => chapter.id));
    return [...this.#operations.values()]
      .filter((operation) => chapterIds.has(operation.chapterId))
      .sort((left, right) => left.priority - right.priority);
  }
}

export class InMemoryAudioArtifactWriter implements AudioArtifactWriterPort {
  readonly #objects = new Map<
    string,
    { readonly bytes: Uint8Array; readonly sha256: string }
  >();
  writes = 0;

  async putImmutable(input: {
    readonly bytes: Uint8Array;
    readonly contentSha256: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<AudioArtifactWriteResult> {
    const actual = createHash("sha256").update(input.bytes).digest("hex");
    if (actual !== input.contentSha256) {
      throw new AudioGenerationError("invalid_result");
    }
    const previous = this.#objects.get(input.objectKey);
    if (
      previous !== undefined &&
      (previous.sha256 !== actual ||
        !Buffer.from(previous.bytes).equals(Buffer.from(input.bytes)))
    ) {
      throw new AudioGenerationError("invalid_result");
    }
    if (previous === undefined) {
      this.#objects.set(input.objectKey, {
        bytes: input.bytes,
        sha256: actual,
      });
      this.writes += 1;
    }
    return {
      byteSize: input.bytes.byteLength,
      contentType: "audio/wav",
      etag: `sha256:${actual}`,
      objectKey: input.objectKey,
    };
  }
}

export function createPcmWavFixture(
  sampleRateHz: 22_050 | 24_000 = 22_050,
  durationSeconds = 1,
): Uint8Array {
  const sampleCount = Math.round(sampleRateHz * durationSeconds);
  const dataLength = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataLength, true);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of [...value].entries()) {
    bytes[offset + index] = character.charCodeAt(0);
  }
}

function authorized(
  course: AuthorizedAudioCourse,
  authorization: {
    readonly actorId: string;
    readonly authorizationId: string;
    readonly ownerScopeId: string;
  },
): boolean {
  return (
    course.actorId === authorization.actorId &&
    course.authorizationId === authorization.authorizationId &&
    course.ownerScopeId === authorization.ownerScopeId
  );
}

function assertSameAttempt(
  current: AudioOperationView,
  work: AudioGenerationWork,
): void {
  if (
    current.status !== "processing" ||
    current.attemptCount !== work.operation.attemptCount
  ) {
    throw new AudioGenerationError("operation_unavailable");
  }
}

function isTerminal(status: AudioOperationView["status"]): boolean {
  return ["succeeded", "failed_permanent", "cancelled", "expired"].includes(
    status,
  );
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new AudioGenerationError("operation_unavailable");
  }
  return value;
}
