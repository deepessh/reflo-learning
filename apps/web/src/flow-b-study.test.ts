import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { tutorLockedForAssessment } from "./flow-b-view";

describe("Tutor question requests", () => {
  it("wires displayed-question context into both the request and replay key", async () => {
    const source = await readFile(
      new URL("./flow-b-study.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /tutorQuestionRequest\(\s*context,\s*tutorQuestion,\s*question\?\.itemId,/,
    );
    expect(source).toContain(
      "contextQuestionId === undefined\n      ? question\n      : `${contextQuestionId}\\u0000${question}`",
    );
    expect(source).toContain(
      "...(contextQuestionId === undefined ? {} : { contextQuestionId })",
    );
  });

  it("shows a useful citation label when a source has no section path", async () => {
    const source = await readFile(
      new URL("./flow-b-study.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'return label === "" ? `Course source ${index + 1}` : label;',
    );
    expect(source).toContain("tutorCitationLabel(citation.sectionPath, index)");
  });

  it("locks Tutor during an assessment until a non-abstained result is graded", async () => {
    const source = await readFile(
      new URL("./flow-b-study.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('response.result.outcome === "graded"');
    expect(source).toContain("Answer once to unlock Tutor");
    expect(source).toContain("disabled={assessmentTutorLocked}");
    expect(source).toContain("disabled={askingTutor || assessmentTutorLocked}");

    expect(tutorLockedForAssessment("question", false, null)).toBe(true);
    expect(tutorLockedForAssessment("submitting", false, null)).toBe(true);
    expect(tutorLockedForAssessment("result", false, null)).toBe(true);
    expect(tutorLockedForAssessment("error", false, "short_answer")).toBe(true);
    expect(tutorLockedForAssessment("error", false, "replacement")).toBe(true);
    expect(tutorLockedForAssessment("error", false, null)).toBe(false);
    expect(tutorLockedForAssessment("result", true, null)).toBe(false);
    expect(tutorLockedForAssessment("lesson", false, null)).toBe(false);
    expect(tutorLockedForAssessment("summary", false, null)).toBe(false);
  });
});
