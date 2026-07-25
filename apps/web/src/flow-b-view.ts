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
