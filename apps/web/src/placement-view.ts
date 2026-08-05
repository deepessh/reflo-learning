import type { BrowserAssessmentResult } from "./flow-b-view";

export const PLACEMENT_POLL_INTERVAL_MS = 5_000;
// Covers the 180-second placement generation deadline with a small status
// propagation margin when the shared SSE stream is reporting another artifact.
export const PLACEMENT_MAX_POLLS = 40;

export type PlacementQuestionType =
  "concept_linking" | "multiple_choice" | "short_answer";

export interface PlacementQuestion {
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly id: string;
  readonly itemType: PlacementQuestionType;
  readonly position: number;
  readonly prompt: string;
  readonly responseOptions: readonly string[] | null;
}

export interface PlacementView {
  readonly answered: number;
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly updatedAt: string | null;
  } | null;
  readonly question: PlacementQuestion | null;
  readonly status: "complete" | "failed" | "pending" | "question";
  readonly total: number;
}

export type PlacementAnswerResult =
  | {
      readonly kind: "keyed";
      readonly correct: boolean;
      readonly status: "created" | "replayed";
    }
  | {
      readonly kind: "short_answer";
      readonly assessment: BrowserAssessmentResult;
    };

export function placementResumeState(
  view: PlacementView,
  pendingFallback: BrowserAssessmentResult | null,
): PlacementView["status"] | "result" {
  return view.status === "question" && pendingFallback !== null
    ? "result"
    : view.status;
}

export function validPlacementView(view: PlacementView): boolean {
  if (
    view.total !== 10 ||
    !Number.isInteger(view.answered) ||
    view.answered < 0 ||
    view.answered > view.total
  ) {
    return false;
  }
  if (view.status === "question") {
    const question = view.question;
    if (
      question === null ||
      question.position !== view.answered + 1 ||
      question.position < 1 ||
      question.position > view.total ||
      question.prompt.trim().length === 0
    ) {
      return false;
    }
    return question.itemType === "short_answer"
      ? question.responseOptions === null
      : question.responseOptions !== null &&
          question.responseOptions.length >= 2 &&
          new Set(question.responseOptions).size ===
            question.responseOptions.length;
  }
  if (view.question !== null) return false;
  if (view.status === "complete") return view.answered === view.total;
  return view.answered < view.total;
}

export function placementProgressLabel(view: PlacementView): string {
  if (view.status === "complete") {
    return `Placement complete · ${view.total} of ${view.total}`;
  }
  if (view.status === "question" && view.question !== null) {
    return `Placement question ${view.question.position} of ${view.total}`;
  }
  return `Placement prepared · ${view.answered} of ${view.total} answered`;
}

export function placementResultCopy(result: PlacementAnswerResult): string {
  if (result.kind === "keyed") {
    return result.correct
      ? "Correct. This answer was added to your Knowledge Map."
      : "Not quite. This answer was added to your Knowledge Map.";
  }
  return result.assessment.learnerMessage;
}

export function placementFailureAction(
  regeneration:
    | {
        readonly availableAt: string;
        readonly eligible: true;
      }
    | null
    | undefined,
  now = new Date(),
): {
  readonly action: "refresh" | "regenerate";
  readonly guidance: string;
} {
  if (regeneration === null || regeneration === undefined) {
    return {
      action: "refresh",
      guidance:
        "A new quiz cannot be requested from this state. Refresh to check for a newer durable status.",
    };
  }
  const availableAt = new Date(regeneration.availableAt);
  if (
    Number.isNaN(availableAt.getTime()) ||
    availableAt.getTime() > now.getTime()
  ) {
    return {
      action: "refresh",
      guidance: Number.isNaN(availableAt.getTime())
        ? "Regeneration availability could not be verified. Refresh the status before trying again."
        : `A new quiz can be requested after ${availableAt.toLocaleString()}. Refresh the status then.`,
    };
  }
  return {
    action: "regenerate",
    guidance: "A new source-backed placement quiz can now be requested safely.",
  };
}

export function placementAnswerReady(
  question: PlacementQuestion | null,
  answer: string,
): boolean {
  if (question === null || answer.trim().length === 0) return false;
  return question.itemType === "short_answer"
    ? true
    : question.responseOptions?.includes(answer) === true;
}

export function shouldContinuePlacementPolling(
  status: PlacementView["status"],
  completedPolls: number,
): boolean {
  return (
    status === "pending" &&
    Number.isSafeInteger(completedPolls) &&
    completedPolls >= 0 &&
    completedPolls < PLACEMENT_MAX_POLLS
  );
}
