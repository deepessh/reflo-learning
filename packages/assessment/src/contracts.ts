import type {
  AuthorizedSourceSpan,
  ModelCallProvenance,
  ShortAnswerRubricBand,
  ShortAnswerRubricInput,
  ShortAnswerUnanswerableReason,
} from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

export const GRADING_POLICY_VERSION = "grading-policy-v1" as const;
export const RATING_MAPPING_VERSION = "rating-mapping-v1" as const;
export const ASSESSMENT_SELECTION_VERSION = "assessment-selection-v1" as const;
export const REPLACEMENT_CONTRACT_VERSION = "mc-replacement-bundle-v1" as const;

export type ExactUnitInterval5 = string;

export interface FrozenGradingPolicy {
  readonly calibrationEvidenceId: string;
  readonly confidenceThreshold: ExactUnitInterval5;
  readonly expectedModelProvenance: Pick<
    ModelCallProvenance,
    | "effectiveModel"
    | "effectiveModelVersion"
    | "inputSchemaVersion"
    | "promptDigest"
    | "promptId"
    | "promptVersion"
    | "resultSchemaVersion"
    | "routePolicyVersion"
  >;
  readonly gradingPolicyVersion: typeof GRADING_POLICY_VERSION;
  readonly ratingMappingVersion: typeof RATING_MAPPING_VERSION;
}

export interface AssessmentQuestionBase {
  readonly conceptIds: readonly string[];
  readonly courseId: string;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly id: string;
  readonly normalizedPromptHash: string;
  readonly prompt: string;
  readonly sourceSpans: readonly AuthorizedSourceSpan[];
}

export interface ShortAnswerQuestion extends AssessmentQuestionBase {
  readonly itemType: "short_answer";
  readonly rubrics: readonly ShortAnswerRubricInput[];
}

export interface KeyedMultipleChoiceQuestion extends AssessmentQuestionBase {
  readonly conceptIds: readonly [string];
  readonly itemType: "multiple_choice";
  readonly keyedAnswer: string;
  readonly responseOptions: readonly string[];
  readonly rubricId: string;
  readonly rubricVersion: string;
}

export type SelectableAssessmentQuestion =
  | ShortAnswerQuestion
  | KeyedMultipleChoiceQuestion
  | (AssessmentQuestionBase & {
      readonly itemType: "concept_linking";
    });

export interface ConceptSelectionState {
  readonly conceptId: string;
  readonly dueAt: string | null;
  readonly mastery: ExactUnitInterval5;
}

export interface AdaptiveSelectionInput {
  readonly conceptStates: readonly ConceptSelectionState[];
  readonly limit: number;
  readonly now: string;
  readonly questions: readonly SelectableAssessmentQuestion[];
  readonly seenPromptHashes: ReadonlySet<string>;
}

export interface GradeShortAnswerCommand {
  readonly answer: string;
  readonly authorization: ScopeAuthorizationContext;
  readonly deadlineMs: number;
  readonly fallbackCandidates: readonly KeyedMultipleChoiceQuestion[];
  readonly idempotencyKey: string;
  readonly policy: FrozenGradingPolicy;
  readonly question: ShortAnswerQuestion;
  readonly seenPromptHashes: ReadonlySet<string>;
  readonly sessionId: string;
}

export interface GradeReplacementCommand {
  readonly answer: string;
  readonly authorization: ScopeAuthorizationContext;
  readonly bundleId: string;
  readonly idempotencyKey: string;
  readonly itemId: string;
  readonly policy: FrozenGradingPolicy;
  readonly sessionId: string;
}

export type EvidenceIneligibilityReason =
  "attempt_abstained" | "below_threshold" | "semantic_unanswerable";

export type AssessmentEvidenceCandidate =
  | {
      readonly conceptId: string;
      readonly eligibleForMastery: boolean;
      readonly fsrsRating: 1 | 3 | null;
      readonly graderConfidence: ExactUnitInterval5;
      readonly gradingMethod: "llm_short_answer";
      readonly ineligibilityReason: EvidenceIneligibilityReason | null;
      readonly judgmentKind: "scored";
      readonly rationaleRef: string;
      readonly rubricBand: ShortAnswerRubricBand;
      readonly rubricId: string;
      readonly rubricVersion: string;
      readonly score: "0.00000" | "0.50000" | "1.00000";
    }
  | {
      readonly conceptId: string;
      readonly eligibleForMastery: false;
      readonly fsrsRating: null;
      readonly graderConfidence: null;
      readonly gradingMethod: "llm_short_answer";
      readonly ineligibilityReason: "semantic_unanswerable";
      readonly judgmentKind: "unanswerable";
      readonly rationaleRef: string;
      readonly reason: ShortAnswerUnanswerableReason;
      readonly rubricBand: null;
      readonly rubricId: string;
      readonly rubricVersion: string;
      readonly score: null;
    }
  | {
      readonly conceptId: string;
      readonly eligibleForMastery: true;
      readonly fsrsRating: 1 | 3;
      readonly graderConfidence: null;
      readonly gradingMethod: "keyed_mc";
      readonly ineligibilityReason: null;
      readonly judgmentKind: "scored";
      readonly rationaleRef: string;
      readonly rubricBand: "correct" | "incorrect";
      readonly rubricId: string;
      readonly rubricVersion: string;
      readonly score: "0.00000" | "1.00000";
    };

export interface ReplacementItem {
  readonly conceptId: string;
  readonly id: string;
  readonly question: KeyedMultipleChoiceQuestion;
}

export interface ReplacementBundle {
  readonly id: string;
  readonly items: readonly ReplacementItem[];
  readonly originalAttemptId: string;
  readonly policyVersion: typeof GRADING_POLICY_VERSION;
  readonly version: typeof REPLACEMENT_CONTRACT_VERSION;
}

export interface ShortAnswerFinalization {
  readonly answer: string;
  readonly attemptId: string;
  readonly evidence: readonly AssessmentEvidenceCandidate[];
  readonly fallback: ReplacementBundle | null;
  readonly idempotencyKey: string;
  readonly learnerMessage: string;
  readonly modelProvenance: ModelCallProvenance | null;
  readonly outcome: "abstained" | "graded";
  readonly ownerScopeId: string;
  readonly policy: FrozenGradingPolicy;
  readonly questionId: string;
  readonly requestDigest: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface ReplacementFinalization {
  readonly answer: string;
  readonly attemptId: string;
  readonly bundleId: string;
  readonly evidence: AssessmentEvidenceCandidate;
  readonly idempotencyKey: string;
  readonly itemId: string;
  readonly ownerScopeId: string;
  readonly policy: FrozenGradingPolicy;
  readonly requestDigest: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface AssessmentFinalizationView {
  readonly attemptId: string;
  readonly evidence: readonly AssessmentEvidenceCandidate[];
  readonly fallback: ReplacementBundle | null;
  readonly learnerMessage: string;
  readonly outcome: "abstained" | "graded";
  readonly requestDigest: string;
  readonly status: "created" | "replayed";
}
