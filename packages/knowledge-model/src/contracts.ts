export const KNOWLEDGE_ALGORITHM_VERSION = "knowledge-model-v1" as const;
export const KNOWLEDGE_CONFIGURATION_ID =
  "beta-1-3-unit-mass-score-5dp-v1" as const;
export const SCORE_QUANTA = 100_000n;
export const PRIOR_ALPHA_QUANTA = SCORE_QUANTA;
export const PRIOR_BETA_QUANTA = 3n * SCORE_QUANTA;

export type KnowledgeModelErrorCode =
  | "conflicting_duplicate"
  | "invalid_evidence"
  | "invalid_score"
  | "invalid_timestamp"
  | "unsupported_algorithm";

export class KnowledgeModelError extends Error {
  constructor(readonly code: KnowledgeModelErrorCode) {
    super(code);
    this.name = "KnowledgeModelError";
  }
}

export interface KnowledgeAuthorizationContext {
  readonly actorId: string;
  readonly authorizationId: string;
  readonly ownerScopeId: string;
}

export type LearningEventName =
  | "assessment_graded"
  | "assessment_submitted"
  | "course_opened"
  | "delivery_received"
  | "lesson_abandoned"
  | "lesson_completed"
  | "lesson_started"
  | "question_asked"
  | "question_presented"
  | "reteach_served"
  | "review_rescheduled"
  | "review_scheduled"
  | "session_abandoned"
  | "session_completed"
  | "session_started";

export interface LearningEventPayloadV1 {
  readonly assetId?: string;
  readonly chapterId?: string;
  readonly courseId?: string;
  readonly modality?: "audio" | "text" | "video";
  readonly quizItemId?: string;
  readonly strategyTag?: string;
}

export interface LearningEventV1 {
  readonly attemptId: string | null;
  readonly causationId: string | null;
  readonly conceptIds: readonly string[];
  readonly correlationId: string;
  readonly deliveryId: string | null;
  readonly eventVersion: 1;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly name: LearningEventName;
  readonly occurredAt: string;
  readonly ownerScopeId: string;
  readonly payload: LearningEventPayloadV1;
  readonly producer: string;
  readonly sessionId: string | null;
  readonly userId: string;
}

export type EvidenceJudgmentKind = "scored" | "unanswerable";
export type EvidenceGradingMethod = "keyed_mc" | "llm_short_answer";
export type EvidenceRubricBand = "correct" | "incorrect" | "partially_correct";
export type EvidenceIneligibilityReason =
  | "attempt_abstained"
  | "below_threshold"
  | "policy_ineligible"
  | "semantic_unanswerable"
  | "superseded";
export type EvidenceFsrsRating = 1 | 3;

export interface AssessmentEvidenceWrite {
  readonly attemptId: string;
  readonly conceptId: string;
  readonly eligibleForMastery: boolean;
  readonly fsrsRating: EvidenceFsrsRating | null;
  readonly graderConfidence: string | null;
  readonly gradingMethod: EvidenceGradingMethod;
  readonly gradingPolicyVersion: string;
  readonly ineligibilityReason: EvidenceIneligibilityReason | null;
  readonly judgmentKind: EvidenceJudgmentKind;
  readonly knowledgeAlgorithmVersion: typeof KNOWLEDGE_ALGORITHM_VERSION;
  readonly knowledgeConfigurationId: typeof KNOWLEDGE_CONFIGURATION_ID;
  readonly rationaleRef: string | null;
  readonly ratingMappingVersion: string;
  readonly replacementForAttemptId: string | null;
  readonly rubricBand: EvidenceRubricBand | null;
  readonly rubricId: string;
  readonly rubricVersion: string;
  readonly score: string | null;
}

export interface PerConceptEvidence {
  readonly attemptCreatedAt: string;
  readonly attemptCreatedAtOrder: string;
  readonly attemptId: string;
  readonly attemptOutcome: "abstained" | "graded" | "superseded";
  readonly conceptId: string;
  readonly eligibleForMastery: boolean;
  readonly fsrsRating: EvidenceFsrsRating | null;
  readonly gradingPolicyVersion: string;
  readonly knowledgeAlgorithmVersion: typeof KNOWLEDGE_ALGORITHM_VERSION;
  readonly knowledgeConfigurationId: typeof KNOWLEDGE_CONFIGURATION_ID;
  readonly ownerScopeId: string;
  readonly ratingMappingVersion: string;
  readonly score: string | null;
  readonly userId: string;
}

export interface ExactKnowledgeState {
  readonly algorithmVersion: typeof KNOWLEDGE_ALGORITHM_VERSION;
  readonly alphaQuanta: string;
  readonly assessmentStatus: "assessed" | "unassessed";
  readonly betaQuanta: string;
  readonly confidence: string;
  readonly configurationId: typeof KNOWLEDGE_CONFIGURATION_ID;
  readonly evidenceCount: number;
  readonly lastReviewedAt: string | null;
  readonly mastery: string;
}
