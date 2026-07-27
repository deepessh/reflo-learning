export const HEALTH_CONTRACT_VERSION = 1 as const;

export interface HealthResponse {
  readonly contractVersion: typeof HEALTH_CONTRACT_VERSION;
  readonly environment: "dev" | "staging" | "pilot";
  readonly service: string;
  readonly status: "ok";
}

export const CONNECTED_STUDY_VIEW_VERSION = "connected-study-view-v1" as const;
export const CONNECTED_DEMO_PREFLIGHT_VERSION =
  "connected-demo-preflight-v1" as const;
export const CONNECTED_DEMO_BOUNDARY_VERSION =
  "connected-demo-boundary-v1" as const;
export const DEMO_UPLOAD_CONTRACT_VERSION = "demo-upload-v2" as const;

export type ConnectedDemoDependencyName =
  "delivery" | "model" | "postgres" | "storage" | "vector";

export interface ConnectedDemoPreflightDependency {
  readonly code: "available" | "unavailable";
  readonly contractVersion: string;
  readonly name: ConnectedDemoDependencyName;
}

export interface ConnectedDemoPreflightView {
  readonly boundary: {
    readonly contractVersion: typeof CONNECTED_DEMO_BOUNDARY_VERSION;
    readonly destinationClass: "staff-controlled-test";
    readonly learnerClass: "staff-controlled";
    readonly sourceClass: "human-approved-rights-cleared";
  };
  readonly checkedAt: string;
  readonly contractVersion: typeof CONNECTED_DEMO_PREFLIGHT_VERSION;
  readonly dependencies: readonly ConnectedDemoPreflightDependency[];
  readonly status: "ready" | "unavailable";
}

export type DemoUploadMediaType = "application/pdf";

export interface DemoSourceApproval {
  readonly approvalId: string;
  readonly attribution: string;
  readonly contractVersion: typeof DEMO_UPLOAD_CONTRACT_VERSION;
  readonly extension: "pdf";
  readonly licenseLabel: string;
  readonly mediaType: DemoUploadMediaType;
  readonly sourceRevision: string;
  readonly title: string;
}

export type DemoUploadState =
  | "accepted"
  | "failed"
  | "generating_outline"
  | "large_document"
  | "ocr_required"
  | "outline_ready"
  | "parsing"
  | "queued"
  | "validating";

export type DemoUploadFailureCode =
  | "active_content"
  | "archive_limit"
  | "dependency_unavailable"
  | "encrypted"
  | "generation_failed"
  | "malformed_document"
  | "malware_detected"
  | "mime_mismatch"
  | "over_limit"
  | "parser_failed"
  | "source_not_approved"
  | "unsupported_type";

export interface DemoUploadView {
  readonly approvalId: string;
  readonly contractVersion: typeof DEMO_UPLOAD_CONTRACT_VERSION;
  readonly courseId: string | null;
  readonly failure: {
    readonly code: DemoUploadFailureCode;
    readonly retryable: boolean;
  } | null;
  readonly processingLane: "large" | "standard" | null;
  readonly state: DemoUploadState;
  readonly statusUpdatedAt: string;
  readonly uploadId: string;
}

export interface DemoCourseOutline {
  readonly chapters: readonly {
    readonly chapterId: string;
    readonly concepts: readonly {
      readonly conceptId: string;
      readonly name: string;
      readonly sourceSpanCount: number;
    }[];
    readonly order: number;
    readonly title: string;
  }[];
  readonly contractVersion: typeof DEMO_UPLOAD_CONTRACT_VERSION;
  readonly courseId: string;
  readonly generatedAt: string;
  readonly title: string;
  readonly uploadId: string;
}

export interface ConnectedStudyQuestion {
  readonly conceptId: string;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly itemId: string;
  readonly itemType: "short_answer";
  readonly prompt: string;
}

export interface ConnectedStudyLesson {
  readonly baselineMastery: string;
  readonly content: string;
  readonly generationVersion: "reteach-generation-v1";
  readonly modality: "text";
  readonly priorStrategyTag: string;
  readonly replacementOrdinal: 1 | 2;
  readonly semanticSimilarity: string;
  readonly servedAt: string;
  readonly sourceSpanCount: number;
  readonly strategyTag: string;
}

export interface ConnectedStudyLoopResult {
  readonly completedAt: string;
  readonly conceptId: string;
  readonly evidenceAttemptId: string;
  readonly finalMastery: string;
  readonly initialMastery: string;
  readonly masteryDelta: string;
  readonly outcome: "retest_succeeded" | "stopped_after_two_replacements";
  readonly replacementCount: 1 | 2;
}

export interface ConnectedStudyView {
  readonly concept: {
    readonly conceptId: string;
    readonly conceptName: string;
    readonly eligibleAttemptCount: number;
    readonly latestEligibleAttempt: {
      readonly attemptId: string;
      readonly createdAt: string;
      readonly rubricBand: "correct" | "incorrect" | "partially_correct";
    } | null;
    readonly mastery: string;
  };
  readonly contractVersion: typeof CONNECTED_STUDY_VIEW_VERSION;
  readonly courseId: string;
  readonly demoOnly: true;
  readonly lesson: ConnectedStudyLesson | null;
  readonly loopResult: ConnectedStudyLoopResult | null;
  readonly plan: {
    readonly steps: readonly [
      "answer",
      "different_lesson",
      "retest",
      "refresh_map",
    ];
    readonly target: "close_evidence_gap";
  };
  readonly question: ConnectedStudyQuestion | null;
  readonly sessionId: string;
  readonly sourceDocumentId: string;
  readonly state:
    | "complete"
    | "lesson_unavailable"
    | "question"
    | "retest"
    | "review_scheduled";
}
