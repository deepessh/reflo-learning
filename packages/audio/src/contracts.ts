import type {
  AudioPayloadResult,
  ModelCallProvenance,
} from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

export const AUDIO_GENERATION_VERSION = "audio-generation-v1" as const;
export const AUDIO_MESSAGE_NAME = "media.audio.generate" as const;
export const AUDIO_MESSAGE_VERSION = 1 as const;
export const AUDIO_RETRY_POLICY_VERSION = "audio-retry-v1" as const;
export const AUDIO_MAX_DELIVERIES = 5 as const;

export type AudioOperationStatus =
  | "queued"
  | "processing"
  | "retry_scheduled"
  | "succeeded"
  | "failed_permanent"
  | "cancelled"
  | "expired";

export interface AuthorizedNarrationScript {
  readonly id: string;
  readonly modelProvenance: ModelCallProvenance;
  readonly scriptSha256: string;
  readonly sourceSpanIds: readonly string[];
  readonly text: string;
  readonly version: string;
}

export interface AudioChapter {
  readonly chapterOrder: number;
  readonly id: string;
  readonly narration: AuthorizedNarrationScript;
}

export interface AuthorizedAudioCourse {
  readonly actorId: string;
  readonly authorizationId: string;
  readonly chapters: readonly AudioChapter[];
  readonly courseId: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
}

export interface AudioGenerationEnvelope {
  readonly causationId?: string;
  readonly correlationId: string;
  readonly deadlineAt: string;
  readonly environment: "dev" | "staging" | "pilot";
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly messageKind: "command";
  readonly messageName: typeof AUDIO_MESSAGE_NAME;
  readonly messageVersion: typeof AUDIO_MESSAGE_VERSION;
  readonly occurredAt: string;
  readonly payload: {
    readonly courseId: string;
    readonly operationId: string;
    readonly ownerScopeId: string;
  };
  readonly producer: "audio-generation";
}

export interface PlannedAudioOperation {
  readonly chapterId: string;
  readonly deadlineAt: Date;
  readonly envelope: AudioGenerationEnvelope;
  readonly generationVersion: typeof AUDIO_GENERATION_VERSION;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly narrationScriptId: string;
  readonly priority: number;
}

export interface AudioOperationView extends Omit<
  PlannedAudioOperation,
  "envelope"
> {
  readonly assetId: string | null;
  readonly attemptCount: number;
  readonly failureClass: string | null;
  readonly status: AudioOperationStatus;
  readonly updatedAt: Date;
}

export interface AudioGenerationWork {
  readonly chapter: AudioChapter;
  readonly course: AuthorizedAudioCourse;
  readonly operation: AudioOperationView;
}

export type AudioGenerationClaim =
  | { readonly kind: "already_final"; readonly status: AudioOperationView }
  | { readonly kind: "active" }
  | { readonly kind: "claimed"; readonly work: AudioGenerationWork };

export interface AudioArtifactWriteResult {
  readonly byteSize: number;
  readonly contentType: "audio/wav";
  readonly etag: string;
  readonly objectKey: string;
}

export interface GeneratedAudioAsset {
  readonly assetId: string;
  readonly generationId: string;
  readonly modelProvenance: ModelCallProvenance;
  readonly narrationScriptId: string;
  readonly narrationScriptSha256: string;
  readonly payload: Omit<AudioPayloadResult, "bytes">;
  readonly sourceSpanIds: readonly string[];
  readonly storage: AudioArtifactWriteResult;
}

export interface PlanAudioCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly deadlineAt: Date;
  readonly environment: AudioGenerationEnvelope["environment"];
}

export interface ConsumeAudioCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly envelope: unknown;
}

export interface AudioGenerationFailure {
  readonly failureClass: string;
  readonly retryable: boolean;
  readonly terminalStatus: "expired" | "failed_permanent";
}
