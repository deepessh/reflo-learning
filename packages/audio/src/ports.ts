import type { ModelTaskInput, RoutedModelResult } from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

import type {
  AudioArtifactWriteResult,
  AudioGenerationClaim,
  AudioGenerationFailure,
  AudioGenerationEnvelope,
  AudioGenerationWork,
  AudioOperationView,
  AuthorizedAudioCourse,
  GeneratedAudioAsset,
  PlannedAudioOperation,
} from "./contracts.js";

export interface AudioClock {
  now(): Date;
}

export interface AudioModelRouterPort {
  execute(
    task: "media.tts.v1",
    input: ModelTaskInput<"media.tts.v1">,
    options: { readonly deadlineMs: number },
  ): Promise<RoutedModelResult<"media.tts.v1">>;
}

export interface AudioGenerationRepositoryPort {
  loadCourse(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<AuthorizedAudioCourse | null>;

  registerOperations(
    course: AuthorizedAudioCourse,
    operations: readonly PlannedAudioOperation[],
  ): Promise<readonly AudioOperationView[]>;

  claimOperation(
    authorization: ScopeAuthorizationContext,
    envelope: AudioGenerationEnvelope,
  ): Promise<AudioGenerationClaim | null>;

  completeAudio(
    work: AudioGenerationWork,
    asset: GeneratedAudioAsset,
  ): Promise<AudioOperationView>;

  recordFailure(
    work: AudioGenerationWork,
    failure: AudioGenerationFailure,
  ): Promise<AudioOperationView>;

  listOperations(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<readonly AudioOperationView[]>;
}

export interface AudioArtifactWriterPort {
  putImmutable(input: {
    readonly bytes: Uint8Array;
    readonly contentSha256: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<AudioArtifactWriteResult>;
}
