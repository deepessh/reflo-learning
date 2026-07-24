import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  replayKnowledgeState,
  type KnowledgeModelError,
  type PerConceptEvidence,
} from "./index.js";

const base = {
  attemptCreatedAt: "2026-07-23T17:00:00.000Z",
  conceptId: "concept-a",
  eligibleForMastery: true,
  knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
  knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
  ownerScopeId: "scope-a",
  score: "1.00000",
  userId: "user-a",
} as const;

describe("knowledge-model-v1", () => {
  it("surfaces the empty prior as unassessed", () => {
    expect(replayKnowledgeState([])).toEqual({
      algorithmVersion: "knowledge-model-v1",
      alphaQuanta: "100000",
      assessmentStatus: "unassessed",
      betaQuanta: "300000",
      confidence: "0.00000",
      configurationId: "beta-1-3-unit-mass-score-5dp-v1",
      evidenceCount: 0,
      lastReviewedAt: null,
      mastery: "0.25000",
    });
  });

  it.each([
    [["0.50000"], "0.30000", "0.20000"],
    [["0.00000", "0.00000"], "0.16667", "0.33333"],
    [["0.00000", "0.00000", "1.00000"], "0.28571", "0.42857"],
    [["1.00000", "1.00000", "1.00000"], "0.57143", "0.42857"],
    [["1.00000", "1.00000", "1.00000", "1.00000"], "0.62500", "0.50000"],
  ])(
    "reproduces the accepted golden projection for %j",
    (scores, mastery, confidence) => {
      const state = replayKnowledgeState(
        scores.map((score, index) => evidence(index, score)),
      );
      expect(state.mastery).toBe(mastery);
      expect(state.confidence).toBe(confidence);
      expect(state.evidenceCount).toBe(scores.length);
    },
  );

  it("ignores abstained, superseded, exposure, and engagement effects represented as ineligible evidence", () => {
    const assessed = replayKnowledgeState([evidence(0, "1.00000")]);
    const withIneligible = replayKnowledgeState([
      evidence(0, "1.00000"),
      {
        ...evidence(1, null),
        eligibleForMastery: false,
      },
      {
        ...evidence(2, "0.00000"),
        eligibleForMastery: false,
      },
    ]);

    expect(withIneligible).toEqual({
      ...assessed,
      lastReviewedAt: assessed.lastReviewedAt,
    });
  });

  it("deduplicates identical replay and rejects a conflicting duplicate", () => {
    const original = evidence(0, "1.00000");
    expect(replayKnowledgeState([original, original])).toEqual(
      replayKnowledgeState([original]),
    );

    expect(() =>
      replayKnowledgeState([original, { ...original, score: "0.00000" }]),
    ).toThrowError(
      expect.objectContaining<Partial<KnowledgeModelError>>({
        code: "conflicting_duplicate",
      }),
    );
  });

  it("is invariant to arrival order and uses canonical time and ID ordering", () => {
    const inputs = [
      evidence(2, "1.00000", "2026-07-23T17:00:01.000Z"),
      evidence(1, "0.50000", "2026-07-23T17:00:00.000Z"),
      evidence(0, "0.00000", "2026-07-23T17:00:00.000Z"),
    ];

    expect(replayKnowledgeState(inputs)).toEqual(
      replayKnowledgeState([...inputs].reverse()),
    );
    expect(replayKnowledgeState(inputs).lastReviewedAt).toBe(
      "2026-07-23T17:00:01.000Z",
    );
  });

  it("keeps multi-concept outcomes independent", () => {
    const conceptA = replayKnowledgeState([
      evidence(0, "1.00000", base.attemptCreatedAt, "concept-a"),
    ]);
    const conceptB = replayKnowledgeState([
      evidence(0, "0.00000", base.attemptCreatedAt, "concept-b"),
    ]);

    expect(conceptA.mastery).toBe("0.40000");
    expect(conceptB.mastery).toBe("0.20000");
  });

  it("uses exact fixed-point score bounds and rejects excess precision", () => {
    expect(replayKnowledgeState([evidence(0, "0")]).mastery).toBe("0.20000");
    expect(replayKnowledgeState([evidence(0, "1")]).mastery).toBe("0.40000");
    expect(() => replayKnowledgeState([evidence(0, "0.123456")])).toThrowError(
      expect.objectContaining<Partial<KnowledgeModelError>>({
        code: "invalid_score",
      }),
    );
  });

  it("supports long exact sequences without floating-point drift", () => {
    const inputs = Array.from({ length: 10_000 }, (_, index) =>
      evidence(index, index % 2 === 0 ? "1.00000" : "0.00000"),
    );
    const state = replayKnowledgeState(inputs);

    expect(state.alphaQuanta).toBe("500100000");
    expect(state.betaQuanta).toBe("500300000");
    expect(state.mastery).toBe("0.49990");
    expect(state.confidence).toBe("0.99960");
  });

  it("rejects historical evidence under an unsupported algorithm identity", () => {
    expect(() =>
      replayKnowledgeState([
        {
          ...evidence(0, "1.00000"),
          knowledgeAlgorithmVersion: "knowledge-model-v0",
        } as unknown as PerConceptEvidence,
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<KnowledgeModelError>>({
        code: "unsupported_algorithm",
      }),
    );
  });

  it("proves the seeded Flow B delta comes only from the correct re-test", () => {
    const failed = replayKnowledgeState([
      evidence(0, "0.00000"),
      evidence(1, "0.00000"),
    ]);
    const afterReplacementLesson = replayKnowledgeState([
      evidence(0, "0.00000"),
      evidence(1, "0.00000"),
      { ...evidence(2, null), eligibleForMastery: false },
    ]);
    const afterCorrectRetest = replayKnowledgeState([
      evidence(0, "0.00000"),
      evidence(1, "0.00000"),
      { ...evidence(2, null), eligibleForMastery: false },
      evidence(3, "1.00000"),
    ]);

    expect(failed.mastery).toBe("0.16667");
    expect(afterReplacementLesson).toEqual(failed);
    expect(afterCorrectRetest.mastery).toBe("0.28571");
    expect(afterCorrectRetest.assessmentStatus).toBe("assessed");
  });
});

function evidence(
  index: number,
  score: string | null,
  attemptCreatedAt = base.attemptCreatedAt,
  conceptId = base.conceptId,
): PerConceptEvidence {
  return {
    ...base,
    attemptCreatedAt,
    attemptId: `attempt-${index.toString().padStart(5, "0")}`,
    conceptId,
    score,
  };
}
