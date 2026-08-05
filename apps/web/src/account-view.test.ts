import { describe, expect, it } from "vitest";

import {
  conceptProgressPresentation,
  courseProgress,
  exactPercentLabel,
  masteryDeltaLabel,
  readinessPresentation,
  sessionDuration,
  sessionSummaryPresentation,
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

  it("summarizes completed session evidence without exposing raw summary data", () => {
    expect(
      sessionSummaryPresentation({
        courseId: "course-a",
        courseTitle: "Networks",
        endedAt: new Date("2026-07-31T12:12:00.000Z"),
        sessionId: "session-a",
        startedAt: new Date("2026-07-31T12:00:00.000Z"),
        status: "completed",
        summary: {
          flowB: {
            "concept-a": {
              masteryDelta: "0.20000",
              outcome: "retest_succeeded",
            },
            "concept-b": {
              masteryDelta: "0.00000",
              outcome: "stopped_after_two_replacements",
            },
          },
        },
      }),
    ).toEqual({
      detail: "2 concepts reviewed · 1 strengthened after a follow-up check.",
      reviewedConceptCount: 2,
      statusLabel: "Completed",
      successfulReviewCount: 1,
    });
  });

  it("keeps sparse and unfinished history summaries useful", () => {
    expect(
      sessionSummaryPresentation({
        courseId: "course-a",
        courseTitle: "Networks",
        endedAt: null,
        sessionId: "session-a",
        startedAt: new Date("2026-07-31T12:00:00.000Z"),
        status: "active",
        summary: null,
      }),
    ).toMatchObject({
      detail: "Your completed activities and answers are saved.",
      statusLabel: "In progress",
    });
    expect(
      sessionSummaryPresentation({
        courseId: "course-a",
        courseTitle: "Networks",
        endedAt: new Date("2026-07-31T12:04:00.000Z"),
        sessionId: "session-b",
        startedAt: new Date("2026-07-31T12:00:00.000Z"),
        status: "abandoned",
        summary: { conceptsReviewed: 3 },
      }),
    ).toMatchObject({
      detail: "3 concepts reviewed. Your next session will build on this work.",
      statusLabel: "Ended early",
    });
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
