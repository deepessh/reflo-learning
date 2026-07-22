export const EVALUATION_CONTRACT_VERSION = "evaluation-contract-v1" as const;
export const DATASET_MANIFEST_VERSION = "dataset-manifest-v1" as const;
export const EVIDENCE_BUNDLE_VERSION = "evidence-bundle-v1" as const;
export const GATE_ATTESTATION_VERSION = "gate-attestation-v1" as const;
export const AUDIO_LISTENING_REVIEW_VERSION =
  "audio-listening-review-v1" as const;
export const SCORER_VERSION = "release-gate-scorer-v1" as const;

export const RELEASE_GATE_IDS = [
  "week1.performance",
  "week1.audio",
  "week1.upload-security",
  "week1.adversarial",
] as const;

export type ReleaseGateId = (typeof RELEASE_GATE_IDS)[number];
export type GateStatus = "failed" | "indeterminate" | "passed";
export type ExecutionEnvironment = "pilot" | "staging";

export interface PreRunExclusion {
  readonly itemId: string;
  readonly reason: string;
}

export interface DatasetSelection {
  readonly method: string;
  readonly seed: number | null;
}

export interface DatasetProtocols {
  readonly adjudication: string;
  readonly annotation: string;
  readonly reviewer: string;
  readonly rubric: string;
}

interface DatasetItemBase {
  readonly id: string;
  readonly rightsApprovalReference: string;
  readonly sha256: string;
  readonly strata: readonly string[];
}

export interface DocumentDatasetItem extends DatasetItemBase {
  readonly byteLength: number;
  readonly complexity: "complex" | "simple";
  readonly format: "docx" | "epub" | "pdf";
  readonly hasImages: boolean;
  readonly hasTables: boolean;
  readonly kind: "document";
  readonly pageCount: number | null;
  readonly standardProfileEligibilityReference: string;
}

export interface AudioScriptDatasetItem extends DatasetItemBase {
  readonly courseId: string;
  readonly kind: "audio-script";
  readonly scriptByteLength: number;
}

export interface UploadSecurityDatasetItem extends DatasetItemBase {
  readonly expectedOutcome: string;
  readonly kind: "upload-security";
}

export interface AdversarialDatasetItem extends DatasetItemBase {
  readonly kind: "adversarial-document";
  readonly threatClasses: readonly (
    | "cross-scope-reference"
    | "fake-citation"
    | "grading-manipulation"
    | "indirect-prompt-injection"
    | "tool-use-request"
  )[];
}

export type DatasetItem =
  | AdversarialDatasetItem
  | AudioScriptDatasetItem
  | DocumentDatasetItem
  | UploadSecurityDatasetItem;

export interface DatasetManifest {
  readonly authority: "authoritative" | "fixture";
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly heldOut: boolean;
  readonly intendedGates: readonly ReleaseGateId[];
  readonly items: readonly DatasetItem[];
  readonly manifestSchemaVersion: typeof DATASET_MANIFEST_VERSION;
  readonly preRunExclusions: readonly PreRunExclusion[];
  readonly protocols: DatasetProtocols;
  readonly rightsApprovalReferences: readonly string[];
  readonly selection: DatasetSelection;
}

export interface MutableEvidenceReference {
  readonly kind:
    "approval" | "capacity" | "legal" | "privacy" | "quota" | "rights";
  readonly reference: string;
  readonly status: "invalid" | "valid";
  readonly validUntil: string;
}

export interface GateRunMetadata {
  readonly cacheProfile: {
    readonly application: "cold" | "warm";
    readonly model: "cold" | "warm";
  };
  readonly completedAt: string;
  readonly concurrency: number;
  readonly declaredSeed: number | null;
  readonly dependencyFingerprints: Readonly<Record<string, string>>;
  readonly deployableArtifactDigest: string;
  readonly environment: ExecutionEnvironment;
  readonly executionBoundary: "production-equivalent" | "target-production";
  readonly infrastructureFingerprint: string;
  readonly mutableEvidence: readonly MutableEvidenceReference[];
  readonly repetitions: number;
  readonly runId: string;
  readonly sourceCommit: string;
  readonly startedAt: string;
}

export type ObservationOutcome = "failed" | "succeeded" | "timed-out";

export interface PerformanceObservation {
  readonly activationPackageMs: number | null;
  readonly activationPackageUsable: boolean;
  readonly audioMs: number | null;
  readonly audioPlayableAuthorized: boolean;
  readonly diagnostics: readonly string[];
  readonly itemId: string;
  readonly outlineMs: number | null;
  readonly outlineUsable: boolean;
  readonly outcome: ObservationOutcome;
  readonly repetition: number;
  readonly retries: number;
}

export interface AudioListeningReview {
  readonly intelligibleAt1_5x: boolean;
  readonly intelligibleAt1x: boolean;
  readonly reviewSchemaVersion: typeof AUDIO_LISTENING_REVIEW_VERSION;
  readonly reviewerId: string;
}

export interface AudioObservation {
  readonly adapter: "piper-tts.cpu" | "qwen-tts.primary";
  readonly authorizedPrivateAsset: boolean;
  readonly diagnostics: readonly string[];
  readonly itemId: string;
  readonly latencyMs: number | null;
  readonly listeningReviews: readonly AudioListeningReview[];
  readonly outcome: ObservationOutcome;
  readonly playable: boolean;
  readonly rangePlayback: boolean;
  readonly retries: number;
}

export interface UploadSecurityObservation {
  readonly actualOutcome: string;
  readonly ambientCredentialsAbsent: boolean;
  readonly diagnostics: readonly string[];
  readonly idempotentRetry: boolean;
  readonly itemId: string;
  readonly networkDenied: boolean;
  readonly outcome: ObservationOutcome;
  readonly ownerScopeEnforced: boolean;
  readonly retries: number;
}

export interface AdversarialObservation {
  readonly authorizationPolicyChanged: boolean;
  readonly citationResolvedToAuthorizedSpan: boolean;
  readonly crossScopeDisclosure: boolean;
  readonly diagnostics: readonly string[];
  readonly gradingPolicyChanged: boolean;
  readonly itemId: string;
  readonly outcome: ObservationOutcome;
  readonly retries: number;
  readonly sourceInstructionExecuted: boolean;
  readonly toolPolicyChanged: boolean;
}

export type GateObservation =
  | AdversarialObservation
  | AudioObservation
  | PerformanceObservation
  | UploadSecurityObservation;

export interface GateRun<
  Observation extends GateObservation = GateObservation,
> {
  readonly gateId: ReleaseGateId;
  readonly metadata: GateRunMetadata;
  readonly observations: readonly Observation[];
}

export interface GateMiss {
  readonly criterion: string;
  readonly itemId: string;
  readonly reason: string;
  readonly repetition?: number;
}

export interface GateResult {
  readonly gateId: ReleaseGateId;
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly misses: readonly GateMiss[];
  readonly reasons: readonly string[];
  readonly status: GateStatus;
}

export interface EvidenceBundle {
  readonly bundleDigest: string;
  readonly completedAt: string;
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly deployableArtifactDigest: string;
  readonly environment: ExecutionEnvironment;
  readonly evidenceBundleVersion: typeof EVIDENCE_BUNDLE_VERSION;
  readonly gateId: ReleaseGateId;
  readonly infrastructureFingerprint: string;
  readonly manifestDigest: string;
  readonly metadata: GateRunMetadata;
  readonly observations: readonly GateObservation[];
  readonly result: GateResult;
  readonly scorerVersion: typeof SCORER_VERSION;
  readonly sourceCommit: string;
  readonly startedAt: string;
}

export interface GateAttestation {
  readonly attestationVersion: typeof GATE_ATTESTATION_VERSION;
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly dependencyFingerprints: Readonly<Record<string, string>>;
  readonly deployableArtifactDigest: string;
  readonly environment: ExecutionEnvironment;
  readonly evidenceBundleDigest: string;
  readonly evidenceBundleReference: string;
  readonly gateId: ReleaseGateId;
  readonly mutableEvidence: readonly MutableEvidenceReference[];
  readonly publishedAt: string;
  readonly publisherAuthorizationReference: string;
  readonly publisherId: string;
  readonly status: GateStatus;
}

export interface CurrentReleaseIdentity {
  readonly dependencyFingerprints: Readonly<Record<string, string>>;
  readonly deployableArtifactDigest: string;
  readonly environment: ExecutionEnvironment;
  readonly evidenceBundleAvailable: boolean;
  readonly now: string;
  readonly supersededByLaterRun: boolean;
}
