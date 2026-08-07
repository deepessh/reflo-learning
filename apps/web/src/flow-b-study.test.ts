import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
});
