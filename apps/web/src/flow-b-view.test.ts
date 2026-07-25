import { describe, expect, it } from "vitest";

import {
  assessmentDisposition,
  unavailableDependencyNames,
  type BrowserAssessmentResult,
} from "./flow-b-view";

describe("Flow B browser presentation", () => {
  it("never presents abstention as mastery evidence", () => {
    expect(
      assessmentDisposition(
        resultFixture({
          evidence: [
            {
              eligibleForMastery: false,
              rubricBand: "correct",
            },
          ],
          outcome: "abstained",
        }),
      ),
    ).toBe("abstained");
  });

  it("distinguishes failing and correct eligible evidence", () => {
    expect(
      assessmentDisposition(
        resultFixture({
          evidence: [
            {
              eligibleForMastery: true,
              rubricBand: "partially_correct",
            },
          ],
        }),
      ),
    ).toBe("failed");
    expect(
      assessmentDisposition(
        resultFixture({
          evidence: [{ eligibleForMastery: true, rubricBand: "correct" }],
        }),
      ),
    ).toBe("correct");
  });

  it("names only unavailable preflight dependencies", () => {
    expect(
      unavailableDependencyNames([
        { code: "available", name: "postgres" },
        { code: "unavailable", name: "model" },
        { code: "unavailable", name: "storage" },
      ]),
    ).toEqual(["model", "storage"]);
  });
});

function resultFixture(
  overrides: Partial<BrowserAssessmentResult> = {},
): BrowserAssessmentResult {
  return {
    attemptId: "attempt",
    evidence: [],
    fallback: null,
    learnerMessage: "Recorded.",
    outcome: "graded",
    status: "created",
    ...overrides,
  };
}
