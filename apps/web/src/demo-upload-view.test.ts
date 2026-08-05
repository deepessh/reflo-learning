import { describe, expect, it } from "vitest";

import { demoUploadPresentation } from "./demo-upload-view";

describe("course upload presentation", () => {
  it("keeps live standard-profile work polling until an outline is ready", () => {
    for (const state of [
      "accepted",
      "validating",
      "queued",
      "parsing",
      "generating_outline",
    ] as const) {
      expect(demoUploadPresentation(state)).toMatchObject({
        formLocked: true,
        poll: true,
        progress: expect.any(String),
        tone: "neutral",
      });
    }
    expect(demoUploadPresentation("outline_ready")).toMatchObject({
      label: "Outline ready",
      formLocked: true,
      poll: false,
      progress: "Stage 5 of 5: course outline ready.",
      tone: "positive",
    });
  });

  it("reports honest stage progress without a percentage or promised ETA", () => {
    expect(demoUploadPresentation("accepted").progress).toBe(
      "Stage 1 of 5: upload received.",
    );
    expect(demoUploadPresentation("parsing").progress).toBe(
      "Stage 3 of 5: parsing the source.",
    );
    expect(demoUploadPresentation("generating_outline").progress).toBe(
      "Stage 4 of 5: generating the course outline.",
    );
    expect(demoUploadPresentation("large_document").progress).toContain(
      "completion estimate",
    );
    for (const state of [
      "accepted",
      "validating",
      "queued",
      "parsing",
      "generating_outline",
      "large_document",
    ] as const) {
      expect(demoUploadPresentation(state).progress).not.toMatch(/\d+%/);
    }
  });

  it("labels OCR and larger-document paths in learner language", () => {
    expect(demoUploadPresentation("ocr_required")).toMatchObject({
      formLocked: false,
      label: "Text recognition needed",
      poll: false,
      tone: "attention",
    });
    expect(demoUploadPresentation("large_document")).toMatchObject({
      formLocked: true,
      label: "Processing a larger PDF",
      poll: true,
      tone: "attention",
    });
  });

  it("never converts dependency or source failures into successful copy", () => {
    expect(
      demoUploadPresentation("failed", "dependency_unavailable"),
    ).toMatchObject({
      label: "Upload did not complete",
      formLocked: false,
      poll: false,
      tone: "negative",
    });
    expect(demoUploadPresentation("failed", "generation_failed")).toMatchObject(
      {
        poll: false,
        tone: "negative",
      },
    );
    expect(
      demoUploadPresentation("failed", "source_not_approved").detail,
    ).toContain("does not match");
    expect(
      demoUploadPresentation("failed", "unsupported_type").detail,
    ).toContain("matching approved PDF");
  });
});
