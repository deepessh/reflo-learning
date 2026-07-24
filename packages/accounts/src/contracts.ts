export const AUTH_CONTRACT_VERSION = "auth-v1" as const;

export type CourseGenerationStatus =
  "generating" | "ready" | "failed" | "archived";

export type SourceIngestionStatus =
  | "quarantined"
  | "validating"
  | "queued"
  | "parsing"
  | "parsed"
  | "ocr_required"
  | "failed";

export interface AuthenticatedAccount {
  readonly authenticatedAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly idleExpiresAt: Date;
  readonly ownerScopeId: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface LoginTokenIssue {
  readonly emailCiphertext: string;
  readonly emailLookupDigest: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  readonly tokenDigest: string;
  readonly tokenId: string;
  readonly userId: string;
}

export interface SessionIssue {
  readonly absoluteExpiresAt: Date;
  readonly authenticatedAt: Date;
  readonly idleExpiresAt: Date;
  readonly membershipId: string;
  readonly ownerScopeId: string;
  readonly sessionDigest: string;
  readonly sessionId: string;
}

export interface LibraryCourse {
  readonly chapterCount: number;
  readonly chaptersReady: number;
  readonly courseId: string;
  readonly courseStatus: CourseGenerationStatus;
  readonly sourceStatus: SourceIngestionStatus;
  readonly title: string;
  readonly updatedAt: Date;
}

export type ConceptMappingStatus = "invalidated" | "mapped" | "unmapped";

export type ConceptReviewState = "due" | "not_scheduled" | "scheduled";

export interface CourseConceptProgress {
  readonly assessmentStatus: "assessed" | "unassessed";
  readonly conceptId: string;
  readonly confidence: string;
  readonly evidenceCount: number;
  readonly generationVersion: string;
  readonly lastReviewedAt: Date | null;
  readonly mappingStatus: ConceptMappingStatus;
  readonly mastery: string | null;
  readonly name: string;
  readonly order: number;
  readonly review: {
    readonly fsrsDueAt: Date | null;
    readonly nextDeliveryAt: Date | null;
    readonly state: ConceptReviewState;
  };
}

export interface CourseChapterProgress {
  readonly chapterId: string;
  readonly concepts: readonly CourseConceptProgress[];
  readonly order: number;
  readonly title: string;
}

export interface CourseMasteryEstimate {
  readonly assessedConceptCount: number;
  readonly kind: "course_mastery_estimate";
  readonly label: "Course Mastery Estimate";
  readonly totalConceptCount: number;
  readonly value: string | null;
}

export type ReadinessIneligibilityReason =
  | "blueprint_missing"
  | "calibration_unavailable"
  | "evidence_minimum_not_met"
  | "reviewed_mappings_unavailable";

export interface ExamReadinessDisclosure {
  readonly blueprintVersion: string | null;
  readonly invalidatedConceptCount: number;
  readonly mappedConceptCount: number;
  readonly reasons: readonly ReadinessIneligibilityReason[];
  readonly score: null;
  readonly status: "unavailable";
  readonly targetBlueprintId: string | null;
  readonly unmappedConceptCount: number;
}

export interface CourseSessionMasteryDelta {
  readonly completedAt: Date;
  readonly conceptId: string;
  readonly conceptName: string;
  readonly finalMastery: string;
  readonly initialMastery: string;
  readonly masteryDelta: string;
  readonly outcome: "retest_succeeded" | "stopped_after_two_replacements";
  readonly sessionId: string;
}

export interface CourseProgress {
  readonly chapters: readonly CourseChapterProgress[];
  readonly courseId: string;
  readonly generatedAt: Date;
  readonly mastery: CourseMasteryEstimate;
  readonly readiness: ExamReadinessDisclosure;
  readonly recentSessionDeltas: readonly CourseSessionMasteryDelta[];
  readonly title: string;
}

export interface SessionHistoryItem {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly endedAt: Date | null;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly status: "active" | "completed" | "abandoned";
  readonly summary: Readonly<Record<string, unknown>> | null;
}

export interface MagicLinkMessage {
  readonly destination: string;
  readonly expiresAt: Date;
  readonly loginUrl: string;
}

export interface RedeemedSession extends AuthenticatedAccount {
  readonly csrfToken: string;
  readonly sessionSecret: string;
}
