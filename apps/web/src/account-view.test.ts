import { describe, expect, it } from "vitest";

import {
  conceptProgressPresentation,
  courseProgress,
  exactPercentLabel,
  masteryDeltaLabel,
  readinessPresentation,
  sessionDuration,
} from "./account-view";

describe("account shell presentation", () => {
  it("makes progressive course state explicit", () => {
    expect(
      courseProgress({
        chapterCount: 8,
        chaptersReady: 3,
        courseId: "course-a",
        courseStatus: "generating",
        sourceStatus: "parsed",
        title: "Course A",
        updatedAt: new Date(),
      }),
    ).toEqual({
      label: "3 of 8 chapters ready",
      percent: 38,
      tone: "active",
    });
  });

  it("labels active sessions without inventing a duration", () => {
    expect(
      sessionDuration({
        courseId: "course-a",
        courseTitle: "Course A",
        endedAt: null,
        sessionId: "session-a",
        startedAt: new Date(),
        status: "active",
        summary: null,
      }),
    ).toBe("In progress");
  });

  it("keeps the Bayesian prior hidden until eligible evidence exists", () => {
    expect(
      conceptProgressPresentation({
        assessmentStatus: "unassessed",
        conceptId: "concept-a",
        confidence: "0.00000",
        evidenceCount: 0,
        generationVersion: "curriculum-v1",
        lastReviewedAt: null,
        mappingStatus: "unmapped",
        mastery: null,
        name: "Virtual networks",
        order: 0,
        review: {
          fsrsDueAt: null,
          nextDeliveryAt: null,
          state: "not_scheduled",
        },
      }),
    ).toEqual({
      confidencePercent: 0,
      label: "Unassessed",
      masteryPercent: null,
      tone: "unassessed",
    });
  });

  it("separates mastery from evidence strength and labels session deltas", () => {
    expect(
      conceptProgressPresentation({
        assessmentStatus: "assessed",
        conceptId: "concept-a",
        confidence: "0.42857",
        evidenceCount: 3,
        generationVersion: "curriculum-v1",
        lastReviewedAt: new Date(),
        mappingStatus: "unmapped",
        mastery: "0.28571",
        name: "Virtual networks",
        order: 0,
        review: {
          fsrsDueAt: new Date(),
          nextDeliveryAt: new Date(),
          state: "due",
        },
      }),
    ).toEqual({
      confidencePercent: 43,
      label: "Needs review",
      masteryPercent: 29,
      tone: "weak",
    });
    expect(exactPercentLabel("0.28571")).toBe("28.571%");
    expect(masteryDeltaLabel("0.11904")).toBe("+11.904 pts");
  });

  it("discloses experimental readiness calibration without inventing it", () => {
    expect(
      readinessPresentation({
        blueprintVersion: "blueprint-v1",
        calibration: {
          meanAbsoluteError: null,
          sampleSize: null,
          status: "unavailable",
          version: null,
        },
        evidenceCoverage: "0.80000",
        evidenceEligibleConceptCount: 3,
        experimental: true,
        invalidatedConceptCount: 0,
        label: "Exam Readiness — Experimental",
        mappedConceptCount: 4,
        mappingSetVersion: "mapping-v1",
        objectiveCount: 2,
        objectiveEvidenceCount: 2,
        objectiveMappedCount: 2,
        profileVersion: "exam-readiness-profile-v1",
        reasons: [],
        score: "0.59000",
        status: "eligible",
        targetBlueprintId: "blueprint-v1",
        unmappedConceptCount: 1,
      }),
    ).toEqual({
      calibration: "Sample size: unavailable · error: unavailable",
      copy: "Eligibility gates passed. This sprint policy score is experimental, not a certification prediction.",
      label: "Exam Readiness — Experimental",
      value: "59%",
    });
  });
});
