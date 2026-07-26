import { describe, expect, it } from "vitest";

import { demoUploadPresentation } from "./demo-upload-view";

describe("staff demo upload presentation", () => {
  it("keeps live standard-profile work polling until an outline is ready", () => {
    for (const state of [
      "accepted",
      "validating",
      "queued",
      "parsing",
      "generating_outline",
    ] as const) {
      expect(demoUploadPresentation(state)).toMatchObject({
        poll: true,
        tone: "neutral",
      });
    }
    expect(demoUploadPresentation("outline_ready")).toMatchObject({
      label: "Outline ready",
      poll: false,
      tone: "positive",
    });
  });

  it("labels OCR and large-document paths separately from the standard target", () => {
    expect(demoUploadPresentation("ocr_required")).toMatchObject({
      label: "OCR required",
      poll: false,
      tone: "attention",
    });
    expect(demoUploadPresentation("large_document")).toMatchObject({
      label: "Large-document path",
      poll: true,
      tone: "attention",
    });
  });

  it("never converts dependency or source failures into successful copy", () => {
    expect(
      demoUploadPresentation("failed", "dependency_unavailable"),
    ).toMatchObject({
      label: "Upload did not complete",
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
    ).toContain("human-approved rights-cleared");
  });
});
