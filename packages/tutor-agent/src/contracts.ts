import type {
  AuthorizedSourceSpan,
  ModelCallProvenance,
} from "@reflo/model-router";
import type {
  RetrievedSourceSpan,
  ScopeAuthorizationContext,
} from "@reflo/retrieval";

export const TUTOR_AGENT_VERSION = "tutor-agent-v1" as const;
export const RETEACH_GENERATION_VERSION = "reteach-generation-v1" as const;
export const RETEACH_SIMILARITY_THRESHOLD = 0.85;
export const RETEACH_MASTERY_THRESHOLD = "0.60000" as const;
export const MAX_RETEACHES_PER_CONCEPT_SESSION = 2 as const;

export interface TutorAttemptEvidence {
  readonly attemptId: string;
  readonly createdAt: string;
  readonly eligibleForMastery: true;
  readonly quizItemId: string;
  readonly rubricBand: "correct" | "incorrect" | "partially_correct";
  readonly score: "0.00000" | "0.50000" | "1.00000";
}

export interface TutorRetestQuestion {
  readonly conceptId: string;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly itemId: string;
  readonly itemType: "concept_linking" | "multiple_choice" | "short_answer";
  readonly prompt: string;
  readonly responseOptions?: readonly string[];
  readonly sourceSpanIds: readonly string[];
}

export interface TutorLessonReference {
  readonly assetId: string;
  readonly contentHash: string;
  readonly modality: "audio" | "text" | "video";
  readonly objectKey: string;
  readonly servedAt: string;
  readonly strategyTag: string;
}

export interface PersistedReteachLesson extends TutorLessonReference {
  readonly baselineMastery: string;
  readonly chapterId: string;
  readonly conceptId: string;
  readonly generationId: string;
  readonly generationVersion: typeof RETEACH_GENERATION_VERSION;
  readonly modelProvenance: ModelCallProvenance;
  readonly ownerScopeId: string;
  readonly replacementOrdinal: 1 | 2;
  readonly semanticSimilarity: string;
  readonly sessionId: string;
  readonly sourceSpanIds: readonly string[];
}

export interface TutorLoopResult {
  readonly completedAt: string;
  readonly conceptId: string;
  readonly evidenceAttemptId: string;
  readonly finalMastery: string;
  readonly initialMastery: string;
  readonly masteryDelta: string;
  readonly outcome: "retest_succeeded" | "stopped_after_two_replacements";
  readonly replacementCount: 1 | 2;
}

export interface TutorConceptSnapshot {
  readonly chapterId: string;
  readonly conceptId: string;
  readonly conceptName: string;
  readonly dueForReview: boolean;
  readonly eligibleAttemptCount: number;
  readonly latestEligibleAttempt: TutorAttemptEvidence | null;
  readonly latestLessonExposureAt: string | null;
  readonly lesson: TutorLessonReference | null;
  readonly loopResult: TutorLoopResult | null;
  readonly mastery: string;
  readonly nextRetestQuestion: TutorRetestQuestion | null;
  readonly reteachLessons: readonly PersistedReteachLesson[];
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
}

export interface TutorSessionSnapshot {
  readonly actorId: string;
  readonly authorizationId: string;
  readonly concepts: readonly TutorConceptSnapshot[];
  readonly courseId: string;
  readonly ownerScopeId: string;
  readonly sessionId: string;
  readonly sourceDocumentId: string;
  readonly status: "active";
  readonly userId: string;
}

export interface TextArtifactWriteResult {
  readonly byteSize: number;
  readonly contentType: "text/markdown; charset=utf-8";
  readonly etag: string;
  readonly objectKey: string;
}

export interface GeneratedReteachLesson {
  readonly assetId: string;
  readonly baselineMastery: string;
  readonly chapterId: string;
  readonly conceptId: string;
  readonly contentHash: string;
  readonly generationId: string;
  readonly generationVersion: typeof RETEACH_GENERATION_VERSION;
  readonly modelProvenance: ModelCallProvenance;
  readonly objectKey: string;
  readonly ownerScopeId: string;
  readonly replacementOrdinal: 1 | 2;
  readonly semanticSimilarity: string;
  readonly sessionId: string;
  readonly sourceSpanIds: readonly string[];
  readonly storage: TextArtifactWriteResult;
  readonly strategyTag: string;
}

export interface NextTutorActionCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly deadlineMs: number;
  readonly sessionId: string;
}

export type NextTutorAction =
  | {
      readonly conceptId: string;
      readonly kind: "advance";
    }
  | {
      readonly conceptId: string;
      readonly kind: "review";
    }
  | {
      readonly conceptId: string;
      readonly kind: "reteach";
      readonly lesson: PersistedReteachLesson;
    }
  | {
      readonly conceptId: string;
      readonly kind: "retest";
      readonly question: TutorRetestQuestion;
    }
  | {
      readonly kind: "retest_succeeded";
      readonly result: TutorLoopResult;
    }
  | {
      readonly conceptId: string;
      readonly kind: "review_scheduled";
      readonly nextDeliveryAt: string;
      readonly result: TutorLoopResult;
    }
  | {
      readonly kind: "session_complete";
    };

export interface AskTutorCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly contextQuestionId?: string;
  readonly courseId: string;
  readonly deadlineMs: number;
  readonly idempotencyKey: string;
  readonly question: string;
  readonly sessionId: string;
  readonly sourceDocumentId: string;
}

export interface TutorCitation {
  readonly sectionPath: readonly string[];
  readonly sourceSpanId: string;
}

export type TutorAnswer =
  | {
      readonly citations: readonly TutorCitation[];
      readonly content: string;
      readonly kind: "answer";
    }
  | {
      readonly kind: "not_found";
    };

export interface TutorQuestionRecord {
  readonly idempotencyKey: string;
  readonly resultKind: TutorAnswer["kind"];
  readonly sessionId: string;
  readonly sourceSpanIds: readonly string[];
}

export interface ReteachPersistenceRequest {
  readonly concept: TutorConceptSnapshot;
  readonly generated: GeneratedReteachLesson;
  readonly session: TutorSessionSnapshot;
}

export interface LoopSuccessRecord {
  readonly conceptId: string;
  readonly finalMastery: string;
  readonly initialMastery: string;
  readonly latestAttemptId: string;
  readonly replacementCount: 1 | 2;
  readonly sessionId: string;
}

export interface LaterReviewRequest {
  readonly causationId: string;
  readonly conceptId: string;
  readonly sessionId: string;
}

export interface TutorSearchRequest {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly deadlineMs: number;
  readonly limit: number;
  readonly preferredSourceSpanIds?: readonly string[];
  readonly query: string;
  readonly sourceDocumentId: string;
}

export interface TutorQuestionSourceSpanRequest {
  readonly courseId: string;
  readonly currentQuestionId?: string;
  readonly questionId: string;
  readonly sessionId: string;
  readonly sourceDocumentId: string;
}

export type TutorRetrievedSpan = RetrievedSourceSpan;
