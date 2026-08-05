export interface BrowserAssessmentResult {
  readonly attemptId: string;
  readonly evidence: readonly {
    readonly eligibleForMastery: boolean;
    readonly rubricBand: "correct" | "incorrect" | "partially_correct" | null;
  }[];
  readonly fallback: {
    readonly id: string;
    readonly items: readonly {
      readonly id: string;
      readonly question: {
        readonly prompt: string;
        readonly responseOptions: readonly string[];
      };
    }[];
  } | null;
  readonly learnerMessage: string;
  readonly outcome: "abstained" | "graded";
  readonly status: "created" | "replayed";
}

export type AssessmentDisposition =
  "abstained" | "correct" | "failed" | "unavailable";

export function assessmentRequestErrorCopy(
  code: string | undefined,
): string | null {
  switch (code) {
    case "fallback_unavailable":
      return "This question is missing a source-backed recovery option. Your answer was not submitted; refresh the course before trying again.";
    case "assessment_projection_unavailable":
      return "Your answer was saved, but its result could not be loaded. Try again—Reflo will reuse the same submission.";
    case "assessment_unavailable":
      return "Grading did not finish. Try again—your original answer will be reused without creating a duplicate attempt.";
    default:
      return null;
  }
}

export type StudyErrorRetryTarget =
  | { readonly kind: "course_lesson"; readonly sessionId: string }
  | { readonly kind: "idle" }
  | { readonly kind: "persisted_state"; readonly sessionId: string }
  | { readonly kind: "replacement" }
  | { readonly kind: "short_answer" };

export function studyErrorRetryTarget(input: {
  readonly courseLessonSessionId: string | null;
  readonly submissionRetry: "replacement" | "short_answer" | null;
  readonly viewSessionId: string | null;
}): StudyErrorRetryTarget {
  if (input.submissionRetry === "short_answer") {
    return { kind: "short_answer" };
  }
  if (input.submissionRetry === "replacement") {
    return { kind: "replacement" };
  }
  if (input.courseLessonSessionId !== null) {
    return {
      kind: "course_lesson",
      sessionId: input.courseLessonSessionId,
    };
  }
  if (input.viewSessionId === null) {
    return { kind: "idle" };
  }
  return { kind: "persisted_state", sessionId: input.viewSessionId };
}

export function studyRetryPresentation(retrying: boolean): {
  readonly actionDisabled: boolean;
  readonly actionLabel: "Try again" | "Trying again…";
  readonly announcement: string;
  readonly ariaBusy: boolean;
} {
  return retrying
    ? {
        actionDisabled: true,
        actionLabel: "Trying again…",
        announcement: "Retrying your saved activity…",
        ariaBusy: true,
      }
    : {
        actionDisabled: false,
        actionLabel: "Try again",
        announcement: "",
        ariaBusy: false,
      };
}

export function completedSessionTransition(actionKind: string): {
  readonly loadActiveState: false;
  readonly phase: "summary";
  readonly refreshProgress: true;
} | null {
  return actionKind === "session_complete"
    ? {
        loadActiveState: false,
        phase: "summary",
        refreshProgress: true,
      }
    : null;
}

export interface PrivatePlaybackGrant {
  readonly contractVersion: "private-delivery-v1";
  readonly expiresAt: string;
  readonly metadata: {
    readonly byteSize: number;
    readonly contentType: string;
    readonly etag: string;
    readonly resourceId: string;
    readonly resourceKind: "asset";
  };
  readonly playback: {
    readonly acceptsByteRanges: true;
    readonly cacheControl: "private, no-store, max-age=0";
    readonly refreshOnForbidden: true;
    readonly resumeSupported: true;
  };
  readonly url: string;
}

export interface LessonMediaState {
  readonly delivery: PrivatePlaybackGrant | null;
  readonly status: "preparing" | "ready" | "unavailable";
}

export interface LessonMediaPresentation {
  readonly kind: "audio" | "text" | "video";
  readonly message: string | null;
  readonly state: "playable" | "preparing" | "readable" | "unavailable";
  readonly url: string | null;
}

export interface ActivationFailure {
  readonly artifactKind: "first_text_lesson";
  readonly attemptCount: number;
  readonly failureClass: string | null;
  readonly retryable: boolean;
  readonly updatedAt: string;
}

export interface CourseActivationPlan {
  readonly activationFailure?: ActivationFailure | null;
  readonly activationStatus?: "lesson_failed" | "lesson_pending" | "ready";
  readonly assessmentStatus?: "failed" | "pending" | "ready";
  readonly demoFlowBPlacementComplete?: true;
  readonly assessments?: {
    readonly chapterQuiz: AssessmentArtifactPlan;
    readonly placementQuiz: AssessmentArtifactPlan;
  };
  readonly nextAction?: string;
  readonly placement?: {
    readonly answered: number;
    readonly status: "complete" | "failed" | "pending" | "question";
    readonly total: 10;
  };
  readonly regeneration?: {
    readonly availableAt: string;
    readonly eligible: true;
  } | null;
}

export function shouldEnterPlacement(
  plan: CourseActivationPlan | undefined,
): boolean {
  return (
    plan?.demoFlowBPlacementComplete !== true &&
    plan?.placement?.status !== "complete"
  );
}

export interface AssessmentArtifactPlan {
  readonly attemptCount: number;
  readonly failureClass: string | null;
  readonly regeneration: {
    readonly availableAt: string;
    readonly eligible: true;
  } | null;
  readonly regenerationOrdinal: number;
  readonly status: "failed" | "pending" | "ready" | "retrying";
  readonly updatedAt: string | null;
}

export function activationPlanDisposition(
  plan: CourseActivationPlan | undefined,
): "failed" | "pending" | "ready" {
  if (
    plan?.activationStatus === "lesson_failed" ||
    plan?.nextAction === "activation_failed"
  ) {
    return "failed";
  }
  if (
    plan?.activationStatus === "lesson_pending" ||
    plan?.nextAction === "prepare_activation"
  ) {
    return "pending";
  }
  return "ready";
}

export function activationFailurePresentation(
  failure: ActivationFailure | null,
): {
  readonly copy: string;
  readonly guidance: string;
  readonly retryable: boolean;
  readonly updatedAt: string | null;
} {
  const retryable = failure?.retryable === true;
  const reason =
    failure?.failureClass === "invalid_result" ||
    failure?.failureClass === "generation_invalid_result"
      ? "The lesson draft could not be verified, so it was not added to your course."
      : "We couldn’t prepare this lesson because the generation service did not complete successfully.";
  const updatedAt = failure?.updatedAt ?? null;
  return {
    copy: retryable
      ? `${reason} Try again to prepare a new version.`
      : `${reason} No further attempts will run automatically, and your progress is safe.`,
    guidance: retryable
      ? "A new preparation attempt can be started safely."
      : "You can leave this page or return to your course library.",
    retryable,
    updatedAt:
      updatedAt !== null && !Number.isNaN(new Date(updatedAt).getTime())
        ? updatedAt
        : null,
  };
}

export function assessmentAvailabilityMessage(
  status: "failed" | "pending" | "ready" | null,
): string | null {
  if (status === "pending") {
    return "You can read this lesson now. Its practice questions are still being prepared.";
  }
  if (status === "failed") {
    return "Practice-question preparation failed. Your lesson and progress are unchanged.";
  }
  return null;
}

export function assessmentDisposition(
  result: BrowserAssessmentResult,
): AssessmentDisposition {
  if (result.outcome === "abstained") {
    return "abstained";
  }
  const eligible = result.evidence.filter(
    (evidence) => evidence.eligibleForMastery,
  );
  if (eligible.length === 0) {
    return "unavailable";
  }
  return eligible.every((evidence) => evidence.rubricBand === "correct")
    ? "correct"
    : "failed";
}

export function unavailableDependencyNames(
  dependencies: readonly {
    readonly code: "available" | "unavailable";
    readonly name: string;
  }[],
): readonly string[] {
  return dependencies
    .filter((dependency) => dependency.code === "unavailable")
    .map((dependency) => dependency.name);
}

export function lessonMediaPresentation(
  assetId: string,
  modality: "audio" | "text" | "video",
  media: LessonMediaState | null | undefined,
  now = new Date(),
): LessonMediaPresentation {
  if (modality === "text") {
    return { kind: "text", message: null, state: "readable", url: null };
  }
  if (media?.status === "preparing") {
    return {
      kind: modality,
      message: `${mediaLabel(modality)} is still being prepared. You can read the lesson below.`,
      state: "preparing",
      url: null,
    };
  }
  if (
    media?.status === "ready" &&
    validPlaybackGrant(media.delivery, assetId, modality, now)
  ) {
    return {
      kind: modality,
      message: null,
      state: "playable",
      url: media.delivery.url,
    };
  }
  return {
    kind: modality,
    message: `${mediaLabel(modality)} playback is unavailable right now. The full lesson is available below.`,
    state: "unavailable",
    url: null,
  };
}

function validPlaybackGrant(
  delivery: PrivatePlaybackGrant | null,
  assetId: string,
  modality: "audio" | "video",
  now: Date,
): delivery is PrivatePlaybackGrant {
  if (
    delivery === null ||
    delivery.contractVersion !== "private-delivery-v1" ||
    delivery.metadata.resourceKind !== "asset" ||
    delivery.metadata.resourceId !== assetId ||
    !Number.isSafeInteger(delivery.metadata.byteSize) ||
    delivery.metadata.byteSize < 1 ||
    !delivery.metadata.contentType.startsWith(`${modality}/`) ||
    delivery.metadata.etag.length < 1 ||
    !delivery.playback.acceptsByteRanges ||
    delivery.playback.cacheControl !== "private, no-store, max-age=0" ||
    !delivery.playback.refreshOnForbidden ||
    !delivery.playback.resumeSupported ||
    Number.isNaN(new Date(delivery.expiresAt).getTime()) ||
    new Date(delivery.expiresAt) <= now
  ) {
    return false;
  }
  try {
    const url = new URL(delivery.url);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
    );
  } catch {
    return false;
  }
}

function mediaLabel(modality: "audio" | "video"): "Audio" | "Video" {
  return modality === "audio" ? "Audio" : "Video";
}
