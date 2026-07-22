import { buildAssetObjectKey } from "@reflo/asset-delivery";
import {
  ModelRouterError,
  REFLO_NARRATOR_VOICE_PROFILE,
  TTS_ALLOWED_SAMPLE_RATES,
  TTS_SYNTHESIS_REQUEST_VERSION,
} from "@reflo/model-router";
import { stableUuid } from "@reflo/retrieval";

import {
  AUDIO_GENERATION_VERSION,
  AUDIO_MAX_DELIVERIES,
  AUDIO_MESSAGE_NAME,
  AUDIO_MESSAGE_VERSION,
  type AudioGenerationFailure,
  type AudioOperationView,
  type AuthorizedAudioCourse,
  type ConsumeAudioCommand,
  type GeneratedAudioAsset,
  type PlanAudioCommand,
  type PlannedAudioOperation,
} from "./contracts.js";
import { validateAudioGenerationEnvelope } from "./envelope.js";
import { AudioGenerationError } from "./errors.js";
import type {
  AudioArtifactWriterPort,
  AudioClock,
  AudioGenerationRepositoryPort,
  AudioModelRouterPort,
} from "./ports.js";

export interface AudioGenerationDependencies {
  readonly artifacts: AudioArtifactWriterPort;
  readonly clock: AudioClock;
  readonly models: AudioModelRouterPort;
  readonly repository: AudioGenerationRepositoryPort;
}

export class AudioGenerationService {
  constructor(private readonly dependencies: AudioGenerationDependencies) {}

  async plan(
    command: PlanAudioCommand,
  ): Promise<readonly AudioOperationView[]> {
    assertDeadline(command.deadlineAt, this.dependencies.clock.now());
    const course = await this.dependencies.repository.loadCourse(
      command.authorization,
      command.courseId,
    );
    if (course === null) {
      throw new AudioGenerationError("authorization_denied");
    }
    const operations = buildAudioPlan(
      course,
      command.environment,
      this.dependencies.clock.now(),
      command.deadlineAt,
    );
    return this.dependencies.repository.registerOperations(course, operations);
  }

  async consume(command: ConsumeAudioCommand): Promise<AudioOperationView> {
    const envelope = validateAudioGenerationEnvelope(command.envelope);
    if (envelope.payload.ownerScopeId !== command.authorization.ownerScopeId) {
      throw new AudioGenerationError("authorization_denied");
    }
    const claim = await this.dependencies.repository.claimOperation(
      command.authorization,
      envelope,
    );
    if (claim === null) {
      throw new AudioGenerationError("operation_unavailable");
    }
    if (claim.kind === "already_final") {
      return claim.status;
    }
    if (claim.kind === "active") {
      throw new AudioGenerationError("operation_unavailable");
    }

    try {
      const now = this.dependencies.clock.now();
      const deadlineMs = Date.parse(envelope.deadlineAt) - now.getTime();
      if (deadlineMs <= 0) {
        throw new AudioGenerationError("deadline_exceeded");
      }
      const narration = claim.work.chapter.narration;
      const routed = await this.dependencies.models.execute(
        "media.tts.v1",
        {
          contractVersion: TTS_SYNTHESIS_REQUEST_VERSION,
          deadlineAt: envelope.deadlineAt,
          generationReference: claim.work.operation.id,
          locale: "en-US",
          narration: narration.text,
          narrationScriptId: narration.id,
          operationId: claim.work.operation.id,
          output: {
            allowedSampleRates: TTS_ALLOWED_SAMPLE_RATES,
            channels: 1,
            codec: "pcm_s16le",
            container: "wav",
          },
          scriptSha256: narration.scriptSha256,
          sourceSpanIds: narration.sourceSpanIds,
          speakingRate: 1,
          voiceProfileId: REFLO_NARRATOR_VOICE_PROFILE,
        },
        { deadlineMs },
      );
      const generationId = stableUuid({
        operationId: claim.work.operation.id,
        payloadSha256: routed.value.payloadSha256,
        route: routed.provenance,
      });
      const assetId = stableUuid({
        chapterId: claim.work.chapter.id,
        courseId: claim.work.course.courseId,
        generationVersion: AUDIO_GENERATION_VERSION,
        type: "audio",
      });
      const objectKey = buildAssetObjectKey({
        assetId,
        courseId: claim.work.course.courseId,
        extension: "wav",
        generationId,
        ownerScopeId: claim.work.course.ownerScopeId,
      });
      const storage = await this.dependencies.artifacts.putImmutable({
        bytes: routed.value.bytes,
        contentSha256: routed.value.payloadSha256,
        idempotencyKey: claim.work.operation.idempotencyKey,
        objectKey,
      });
      if (
        storage.objectKey !== objectKey ||
        storage.contentType !== "audio/wav" ||
        storage.byteSize !== routed.value.byteLength
      ) {
        throw new AudioGenerationError("invalid_result");
      }
      const { bytes: _bytes, ...payload } = routed.value;
      const asset: GeneratedAudioAsset = {
        assetId,
        generationId,
        modelProvenance: routed.provenance,
        narrationScriptId: narration.id,
        narrationScriptSha256: narration.scriptSha256,
        payload,
        sourceSpanIds: narration.sourceSpanIds,
        storage,
      };
      return this.dependencies.repository.completeAudio(claim.work, asset);
    } catch (error) {
      return this.dependencies.repository.recordFailure(
        claim.work,
        normalizeFailure(error, claim.work.operation.attemptCount),
      );
    }
  }

  listStatus(
    authorization: PlanAudioCommand["authorization"],
    courseId: string,
  ): Promise<readonly AudioOperationView[]> {
    return this.dependencies.repository.listOperations(authorization, courseId);
  }
}

export function buildAudioPlan(
  course: AuthorizedAudioCourse,
  environment: PlanAudioCommand["environment"],
  occurredAt: Date,
  deadlineAt: Date,
): readonly PlannedAudioOperation[] {
  if (course.chapters.length === 0) {
    throw new AudioGenerationError("invalid_configuration");
  }
  const chapters = [...course.chapters].sort(
    (left, right) => left.chapterOrder - right.chapterOrder,
  );
  if (
    chapters.some(
      (chapter, index) =>
        chapter.chapterOrder !== index + 1 ||
        chapter.narration.sourceSpanIds.length === 0,
    )
  ) {
    throw new AudioGenerationError("invalid_configuration");
  }
  const correlationId = stableUuid({
    courseId: course.courseId,
    generationVersion: AUDIO_GENERATION_VERSION,
  });
  return chapters.map((chapter) => {
    const id = stableUuid({
      chapterId: chapter.id,
      courseId: course.courseId,
      generationVersion: AUDIO_GENERATION_VERSION,
      narrationScriptId: chapter.narration.id,
      scriptSha256: chapter.narration.scriptSha256,
    });
    const idempotencyKey = `${environment}/${AUDIO_MESSAGE_NAME}/v${AUDIO_MESSAGE_VERSION}/${id}`;
    return {
      chapterId: chapter.id,
      deadlineAt,
      envelope: {
        correlationId,
        deadlineAt: deadlineAt.toISOString(),
        environment,
        idempotencyKey,
        messageId: stableUuid({ id, kind: "audio-command" }),
        messageKind: "command",
        messageName: AUDIO_MESSAGE_NAME,
        messageVersion: AUDIO_MESSAGE_VERSION,
        occurredAt: occurredAt.toISOString(),
        payload: {
          courseId: course.courseId,
          operationId: id,
          ownerScopeId: course.ownerScopeId,
        },
        producer: "audio-generation",
      },
      generationVersion: AUDIO_GENERATION_VERSION,
      id,
      idempotencyKey,
      narrationScriptId: chapter.narration.id,
      priority: chapter.chapterOrder,
    };
  });
}

function normalizeFailure(
  error: unknown,
  attemptCount: number,
): AudioGenerationFailure {
  if (
    error instanceof AudioGenerationError &&
    error.code === "deadline_exceeded"
  ) {
    return {
      failureClass: error.code,
      retryable: false,
      terminalStatus: "expired",
    };
  }
  if (error instanceof ModelRouterError) {
    const providerFailure = error.providerFailure;
    const retryable =
      attemptCount < AUDIO_MAX_DELIVERIES &&
      (error.code === "adapter_unavailable" ||
        (error.code === "provider_failure" &&
          providerFailure?.transient === true &&
          providerFailure.submissionState === "not_accepted"));
    const ambiguousSubmission =
      error.code === "deadline_exceeded" ||
      (error.code === "provider_failure" &&
        providerFailure?.submissionState !== "not_accepted");
    return {
      failureClass: ambiguousSubmission ? "ambiguous_submission" : error.code,
      retryable,
      terminalStatus: "failed_permanent",
    };
  }
  if (error instanceof AudioGenerationError) {
    return {
      failureClass: error.code,
      retryable: false,
      terminalStatus: "failed_permanent",
    };
  }
  return {
    failureClass: "infrastructure_unavailable",
    retryable: attemptCount < AUDIO_MAX_DELIVERIES,
    terminalStatus: "failed_permanent",
  };
}

function assertDeadline(deadline: Date, now: Date): void {
  if (
    !Number.isFinite(deadline.getTime()) ||
    deadline <= now ||
    deadline.getTime() - now.getTime() > 24 * 60 * 60 * 1_000
  ) {
    throw new AudioGenerationError("invalid_configuration");
  }
}
