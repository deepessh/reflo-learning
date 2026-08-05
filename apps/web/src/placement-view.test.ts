import { describe, expect, it } from "vitest";

import {
  placementAnswerReady,
  placementFailureAction,
  placementProgressLabel,
  placementResultCopy,
  placementResumeState,
  PLACEMENT_POLL_INTERVAL_MS,
  PLACEMENT_MAX_POLLS,
  shouldContinuePlacementPolling,
  validPlacementView,
  type PlacementView,
} from "./placement-view";

describe("placement browser presentation", () => {
  it("accepts only the exact ten-question sequencing contract", () => {
    const question = placementFixture();
    expect(validPlacementView(question)).toBe(true);
    expect(
      validPlacementView({
        ...question,
        question: { ...question.question!, position: 4 },
      }),
    ).toBe(false);
    expect(validPlacementView({ ...question, total: 9 })).toBe(false);
    expect(
      validPlacementView({
        ...question,
        status: "complete",
        answered: 10,
        question: null,
      }),
    ).toBe(true);
  });

  it("requires a source question option or nonblank short answer", () => {
    const multipleChoice = placementFixture().question!;
    expect(placementAnswerReady(multipleChoice, "B")).toBe(true);
    expect(placementAnswerReady(multipleChoice, "not-an-option")).toBe(false);
    expect(
      placementAnswerReady(
        { ...multipleChoice, itemType: "short_answer", responseOptions: null },
        "  a grounded answer  ",
      ),
    ).toBe(true);
    expect(
      placementAnswerReady(
        { ...multipleChoice, itemType: "short_answer", responseOptions: null },
        "   ",
      ),
    ).toBe(false);
  });

  it("reports exact progress and honest keyed outcomes", () => {
    const placement = placementFixture();
    expect(placementProgressLabel(placement)).toBe(
      "Placement question 3 of 10",
    );
    expect(
      placementResultCopy({ kind: "keyed", correct: false, status: "created" }),
    ).toContain("Not quite");
    expect(
      placementResultCopy({ kind: "keyed", correct: true, status: "replayed" }),
    ).toContain("Correct");
  });

  it("bounds independent pending-status polling", () => {
    const pending = {
      ...placementFixture(),
      answered: 0,
      question: null,
      status: "pending" as const,
    };
    expect(shouldContinuePlacementPolling(pending.status, 0)).toBe(true);
    expect(
      shouldContinuePlacementPolling(pending.status, PLACEMENT_MAX_POLLS),
    ).toBe(false);
    expect(shouldContinuePlacementPolling("complete", 0)).toBe(false);
    expect(
      PLACEMENT_MAX_POLLS * PLACEMENT_POLL_INTERVAL_MS,
    ).toBeGreaterThanOrEqual(200_000);
  });

  it("restores a pending short-answer fallback before re-showing its question", () => {
    const placement = placementFixture();
    const pendingFallback = {
      attemptId: "attempt",
      evidence: [],
      fallback: {
        id: "bundle",
        items: [
          {
            id: "replacement",
            question: { prompt: "Choose", responseOptions: ["A", "B"] },
          },
        ],
      },
      learnerMessage: "Choose a source-backed replacement.",
      outcome: "abstained" as const,
      status: "created" as const,
    };
    expect(placementResumeState(placement, pendingFallback)).toBe("result");
    expect(placementResumeState(placement, null)).toBe("question");
  });

  it("offers regeneration only when durable eligibility is currently available", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    expect(placementFailureAction(null, now).action).toBe("refresh");
    expect(
      placementFailureAction(
        { availableAt: "2026-08-05T12:01:00.000Z", eligible: true },
        now,
      ),
    ).toMatchObject({ action: "refresh" });
    expect(
      placementFailureAction(
        { availableAt: "2026-08-05T11:59:00.000Z", eligible: true },
        now,
      ),
    ).toMatchObject({ action: "regenerate" });
  });
});

function placementFixture(): PlacementView {
  return {
    answered: 2,
    failure: null,
    question: {
      difficulty: 2,
      id: "question-3",
      itemType: "multiple_choice",
      position: 3,
      prompt: "Choose the source-backed answer.",
      responseOptions: ["A", "B"],
    },
    status: "question",
    total: 10,
  };
}
