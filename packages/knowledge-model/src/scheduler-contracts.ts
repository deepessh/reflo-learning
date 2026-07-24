import type { EvidenceFsrsRating, PerConceptEvidence } from "./contracts.js";

export const FSRS_PROFILE_ID = "fsrs-profile-v1" as const;
export const FSRS_PROFILE_VERSION = "v5.4.1 using FSRS-6.0" as const;
export const FSRS_PACKAGE_VERSION = "5.4.1" as const;
export const FSRS_PACKAGE_INTEGRITY =
  "sha512-mOp9+oexJexBTkwjg/jQI1aSUQRLIAvbimeKHLSmVdNJPwObugFNKmZkoggH5d6kZ0uaWLboP1Al1DnXAfIb9w==" as const;
export const FSRS_RUNTIME_NODE_VERSION = "24.18.0" as const;
export const FSRS_RUNTIME_TZDB_VERSION = "2026b" as const;
export const FSRS_CARD_SCHEMA = "fsrs-card-v1" as const;
export const FSRS_REPLAY_SCHEMA = "scheduler-replay-v1" as const;
export const FSRS_ADAPTER_CONTAINMENT = "date-prototype-restore-v1" as const;
export const DELIVERY_TIME_PROFILE_ID = "delivery-time-profile-v1" as const;
export const MAX_REPLAY_EVIDENCE_PER_CONCEPT = 512 as const;
export const MAX_REPLAY_MANIFEST_REFERENCES_PER_CONCEPT =
  (MAX_REPLAY_EVIDENCE_PER_CONCEPT * (MAX_REPLAY_EVIDENCE_PER_CONCEPT + 1)) / 2;

export const FSRS_WEIGHTS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
] as const);

export const FSRS_PROFILE = Object.freeze({
  adapterContainment: FSRS_ADAPTER_CONTAINMENT,
  allowedRatings: Object.freeze([1, 3] as const),
  cardSchema: FSRS_CARD_SCHEMA,
  enableFuzz: false,
  enableShortTerm: false,
  fsrsGeneration: "FSRS-6.0",
  learningSteps: Object.freeze([] as const),
  maximumIntervalDays: 36_500,
  maximumReplayEvidencePerConcept: MAX_REPLAY_EVIDENCE_PER_CONCEPT,
  maximumReplayManifestReferencesPerConcept:
    MAX_REPLAY_MANIFEST_REFERENCES_PER_CONCEPT,
  npmIntegrity: FSRS_PACKAGE_INTEGRITY,
  packageVersion: FSRS_PACKAGE_VERSION,
  profileId: FSRS_PROFILE_ID,
  relearningSteps: Object.freeze([] as const),
  replaySchema: FSRS_REPLAY_SCHEMA,
  requestRetention: 0.9,
  runtimeNodeVersion: FSRS_RUNTIME_NODE_VERSION,
  timestampSchema: "trusted-attempt-created-at-utc-ms-v1",
  weights: FSRS_WEIGHTS,
});

export type FsrsCardState = 0 | 2;

export interface CanonicalFsrsCard {
  readonly difficulty: string;
  readonly due: string;
  readonly elapsedDays: number;
  readonly lapses: number;
  readonly lastReview: string | null;
  readonly learningSteps: 0;
  readonly reps: number;
  readonly scheduledDays: number;
  readonly stability: string;
  readonly state: FsrsCardState;
}

export interface CanonicalFsrsTransition {
  readonly evidenceIdentity: string;
  readonly nextCard: CanonicalFsrsCard;
  readonly nextCardDigest: string;
  readonly priorCard: CanonicalFsrsCard;
  readonly priorCardDigest: string;
  readonly profileId: typeof FSRS_PROFILE_ID;
  readonly rating: EvidenceFsrsRating;
  readonly reviewedAt: string;
  readonly sequence: number;
  readonly transitionDigest: string;
}

export interface DeliveryPreference {
  readonly chosenLocalTime: string;
  readonly timeZone: string;
}

export type DeliveryDisambiguation =
  "exact" | "fold_earlier" | "fold_later" | "gap_forward";

export interface DeliveryResolution {
  readonly chosenLocalTime: string;
  readonly disambiguation: DeliveryDisambiguation;
  readonly nextDeliveryAt: string;
  readonly profileId: typeof DELIVERY_TIME_PROFILE_ID;
  readonly timeZone: string;
  readonly tzdbVersion: typeof FSRS_RUNTIME_TZDB_VERSION;
}

export interface FsrsReplayRun {
  readonly currentCard: CanonicalFsrsCard;
  readonly currentCardDigest: string;
  readonly delivery: DeliveryResolution;
  readonly deliveryResolutionId: string;
  readonly evidenceDigest: string;
  readonly fsrsDueAt: string;
  readonly manifestDigest: string;
  readonly ownerScopeId: string;
  readonly profileDigest: string;
  readonly profileId: typeof FSRS_PROFILE_ID;
  readonly runId: string;
  readonly transitions: readonly CanonicalFsrsTransition[];
  readonly userId: string;
  readonly conceptId: string;
}

export type DeliveryOverrideReason =
  | "channel_unavailable"
  | "operator_demo_control"
  | "reteach_follow_up"
  | "user_snooze";

export interface DeliveryOverrideWrite {
  readonly causationId: string | null;
  readonly conceptId: string;
  readonly deliverNotBeforeAt: string;
  readonly id: string;
  readonly reason: DeliveryOverrideReason;
}

export interface DeliveryOverrideCancellationWrite {
  readonly causationId: string | null;
  readonly conceptId: string;
  readonly id: string;
  readonly targetOverrideId: string;
}

export interface SchedulerEvidence extends PerConceptEvidence {
  readonly fsrsRating: EvidenceFsrsRating | null;
}

export type SchedulerErrorCode =
  | "conflicting_duplicate"
  | "invalid_card"
  | "invalid_delivery_preference"
  | "invalid_evidence"
  | "invalid_profile"
  | "invalid_runtime"
  | "invalid_timestamp"
  | "replay_limit_exceeded"
  | "unexpected_package_side_effect";

export class SchedulerError extends Error {
  constructor(readonly code: SchedulerErrorCode) {
    super(code);
    this.name = "SchedulerError";
  }
}
