import { describe, expect, it } from "vitest";

import {
  conceptProgressPresentation,
  courseProgress,
  exactPercentLabel,
  masteryDeltaLabel,
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
});
