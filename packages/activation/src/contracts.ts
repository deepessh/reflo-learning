import type {
  AuthorizedSourceSpan,
  ModelCallProvenance,
  QuizGenerationResult,
} from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

export const ACTIVATION_GENERATION_VERSION =
  "activation-generation-v1" as const;
export const PLACEMENT_QUIZ_ITEM_COUNT = 10 as const;
export const CHAPTER_QUIZ_ITEM_COUNT = 5 as const;
export const TEXT_READING_WORDS_PER_MINUTE = 200 as const;
export const REQUIRED_QUIZ_ITEM_TYPES = [
  "multiple_choice",
  "short_answer",
  "concept_linking",
] as const;

export type ActivationArtifactKind =
  "first_text_lesson" | "placement_quiz" | "chapter_quiz";

export type GenerationOperationStatus =
  | "queued"
  | "processing"
  | "retry_scheduled"
  | "succeeded"
  | "failed_permanent"
  | "cancelled"
  | "expired";

export interface ActivationConcept {
  readonly id: string;
  readonly name: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
}

export interface ActivationChapter {
  readonly concepts: readonly ActivationConcept[];
  readonly id: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
  readonly title: string;
}

export interface AuthorizedActivationCourse {
  readonly actorId: string;
  readonly authorizationId: string;
  readonly chapters: readonly ActivationChapter[];
  readonly courseId: string;
  readonly curriculumGenerationId: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
}

export interface PlannedGenerationOperation {
  readonly artifactKind: ActivationArtifactKind;
  readonly chapterId: string | null;
  readonly conceptId: string | null;
  readonly generationVersion: typeof ACTIVATION_GENERATION_VERSION;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly priority: 1 | 2 | 3;
}

export interface GenerationOperationView extends PlannedGenerationOperation {
  readonly artifactId: string | null;
  readonly attemptCount: number;
  readonly failureClass: string | null;
  readonly retryable: boolean;
  readonly status: GenerationOperationStatus;
  readonly updatedAt: Date;
}

export interface GenerationWork {
  readonly course: AuthorizedActivationCourse;
  readonly operation: GenerationOperationView;
}

export type GenerationClaim =
  | {
      readonly kind: "already_final";
      readonly status: GenerationOperationView;
    }
  | {
      readonly kind: "claimed";
      readonly work: GenerationWork;
    };

export interface TextArtifactWriteResult {
  readonly byteSize: number;
  readonly contentType: "text/markdown; charset=utf-8";
  readonly etag: string;
  readonly objectKey: string;
}

export interface GeneratedTextLesson {
  readonly assetId: string;
  readonly contentHash: string;
  readonly estimatedReadingMinutes: number;
  readonly generationId: string;
  readonly modelProvenance: ModelCallProvenance;
  readonly sourceSpanIds: readonly string[];
  readonly storage: TextArtifactWriteResult;
  readonly strategyTag: string;
}

export type GeneratedQuizItem = QuizGenerationResult["items"][number] & {
  readonly id: string;
  readonly itemOrder: number;
  readonly normalizedPromptHash: string;
};

export interface GeneratedQuizBank {
  readonly bankId: string;
  readonly bankKind: "placement" | "chapter";
  readonly items: readonly GeneratedQuizItem[];
  readonly modelProvenance: ModelCallProvenance;
  readonly resultHash: string;
}

export interface PlanActivationCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly environment: "dev" | "staging" | "pilot";
}

export interface RunGenerationCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly deadlineMs: number;
  readonly operationId: string;
}

export interface GenerationFailure {
  readonly failureClass: string;
  readonly retryable: boolean;
}
