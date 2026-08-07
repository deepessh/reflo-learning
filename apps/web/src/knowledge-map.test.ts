import { readFile } from "node:fs/promises";

import type { CourseProgress } from "@reflo/accounts";
import { describe, expect, it } from "vitest";

import { chapterProgressPresentation } from "./knowledge-map-view";

type Chapter = CourseProgress["chapters"][number];
type Concept = Chapter["concepts"][number];

function concept(
  evidenceCount: number,
  reviewState: Concept["review"]["state"] = "not_scheduled",
): Concept {
  return {
    assessmentStatus: evidenceCount > 0 ? "assessed" : "unassessed",
    conceptId: crypto.randomUUID(),
    confidence: "0.5",
    evidenceCount,
    generationVersion: "v1",
    lastReviewedAt: null,
    mappingStatus: "mapped",
    mastery: null,
    name: "Test concept",
    order: 1,
    review: {
      fsrsDueAt: null,
      nextDeliveryAt: null,
      state: reviewState,
    },
  };
}

function chapter(concepts: readonly Concept[]): Chapter {
  return {
    chapterId: "chapter-1",
    concepts,
    order: 1,
    title: "A chapter",
  };
}

describe("chapterProgressPresentation", () => {
  it("prioritizes due reviews in the compact chapter status", () => {
    expect(
      chapterProgressPresentation(
        chapter([concept(2, "due"), concept(1, "due"), concept(0)]),
      ),
    ).toEqual({ label: "2 reviews due", tone: "attention" });
  });

  it("distinguishes not-started, in-progress, and assessed chapters", () => {
    expect(chapterProgressPresentation(chapter([concept(0)]))).toEqual({
      label: "Not started",
      tone: "neutral",
    });
    expect(
      chapterProgressPresentation(chapter([concept(1), concept(0)])),
    ).toEqual({ label: "In progress", tone: "neutral" });
    expect(
      chapterProgressPresentation(chapter([concept(1), concept(2)])),
    ).toEqual({ label: "Assessed", tone: "ready" });
  });
});

describe("Knowledge Map summary", () => {
  it("shows coverage without a course-wide mastery aggregate", async () => {
    const source = await readFile(
      new URL("./knowledge-map.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Assessment coverage");
    expect(source).toContain("Concept-level mastery appears below.");
    expect(source).toContain(
      "{progress.mastery.totalConceptCount} concepts assessed",
    );
    expect(source).not.toContain("progress.mastery.label");
    expect(source).not.toContain("const mastery = progress.mastery.value");
  });
});
