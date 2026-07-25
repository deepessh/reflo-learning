import { describe, expect, it } from "vitest";

import { assertConnectedMasteryProof } from "./browser-runner";

const CONCEPT_ID = "16400000-0000-4000-8000-000000000004";
const RETEST_ATTEMPT_ID = "16400000-0000-4000-8000-000000000030";

describe("connected Flow B mastery proof", () => {
  it("binds the exact fixed-point delta to the submitted re-test and concept", () => {
    expect(() => assertConnectedMasteryProof(proof())).not.toThrow();
  });

  it.each([
    {
      change: { loopEvidenceAttemptId: "stale-attempt" },
      name: "a stale evidence attempt",
    },
    {
      change: {
        concepts: {
          ...proof().concepts,
          retestQuestion: "different-concept",
        },
      },
      name: "a mismatched concept",
    },
    {
      change: {
        concepts: {
          ...proof().concepts,
          initialEvidence: ["different-concept"],
        },
      },
      name: "initial evidence for another concept",
    },
    {
      change: { loopInitialMastery: "0.14285" },
      name: "a mismatched loop baseline",
    },
    {
      change: { masteryDelta: "0.10713" },
      name: "an arithmetically incorrect delta",
    },
  ])("rejects $name", ({ change }) => {
    expect(() =>
      assertConnectedMasteryProof({ ...proof(), ...change }),
    ).toThrow("Flow B mastery evidence provenance assertion failed");
  });
});

function proof() {
  return {
    concepts: {
      finalView: CONCEPT_ID,
      initialEvidence: [CONCEPT_ID],
      initialQuestion: CONCEPT_ID,
      initialView: CONCEPT_ID,
      lessonView: CONCEPT_ID,
      loopResult: CONCEPT_ID,
      retestEvidence: [CONCEPT_ID],
      retestQuestion: CONCEPT_ID,
    },
    finalMastery: "0.25000",
    lessonBaselineMastery: "0.14286",
    loopEvidenceAttemptId: RETEST_ATTEMPT_ID,
    loopFinalMastery: "0.25000",
    loopInitialMastery: "0.14286",
    masteryDelta: "0.10714",
    retestAttemptId: RETEST_ATTEMPT_ID,
  };
}
