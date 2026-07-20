import { describe, expect, it } from "vitest";

import { courseProgress, sessionDuration } from "./account-view";

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
});
