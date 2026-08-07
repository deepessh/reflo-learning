import { describe, expect, it } from "vitest";

import type { DemoUploadView } from "@reflo/contracts";

import {
  demoCourseOutlineForUpload,
  demoUploadFailureAction,
  demoUploadPresentation,
  demoUploadTrackedTarget,
} from "./demo-upload-view";

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
    ).toContain("matching course PDF");
  });

  it("offers retry lineage only for failures the server marks retryable", () => {
    const failedUpload = {
      approvalId: "approved-pdf-v1",
      contractVersion: "demo-upload-v2" as const,
      courseId: "55000000-0000-4000-8000-000000000002",
      processingLane: "standard" as const,
      state: "failed" as const,
      statusUpdatedAt: "2026-08-05T20:00:00.000Z",
      uploadId: "55000000-0000-4000-8000-000000000001",
    };

    expect(
      demoUploadFailureAction({
        ...failedUpload,
        failure: { code: "dependency_unavailable", retryable: true },
      }),
    ).toEqual({
      label: "Try again",
      replacesUploadId: failedUpload.uploadId,
    });
    expect(
      demoUploadFailureAction({
        ...failedUpload,
        failure: { code: "generation_failed", retryable: false },
      }),
    ).toEqual({
      label: "Validate another PDF",
      replacesUploadId: null,
    });
  });

  it("hydrates only the exact tracked upload across terminal states", () => {
    const failed = {
      approvalId: "approved-pdf-v1",
      contractVersion: "demo-upload-v2",
      courseId: "55000000-0000-4000-8000-000000000002",
      failure: { code: "dependency_unavailable", retryable: true },
      processingLane: "standard",
      state: "failed",
      statusUpdatedAt: "2026-08-05T20:00:00.000Z",
      uploadId: "55000000-0000-4000-8000-000000000001",
    } satisfies DemoUploadView;

    expect(demoUploadTrackedTarget(failed.uploadId, failed)).toBe(failed);
    expect(demoUploadTrackedTarget("different-upload", failed)).toBeNull();
    expect(
      demoUploadTrackedTarget(failed.uploadId, {
        ...failed,
        failure: null,
        state: "outline_ready",
      }),
    ).not.toBeNull();
  });

  it("accepts only a complete outline for the exact tracked upload", () => {
    const uploadId = "55000000-0000-4000-8000-000000000001";
    const outline = {
      chapters: [
        {
          chapterId: "55000000-0000-4000-8000-000000000003",
          concepts: [
            {
              conceptId: "55000000-0000-4000-8000-000000000004",
              name: "Tool use",
              sourceSpanCount: 2,
            },
          ],
          order: 1,
          title: "Agents",
        },
      ],
      contractVersion: "demo-upload-v2",
      courseId: "55000000-0000-4000-8000-000000000002",
      generatedAt: "2026-08-06T07:00:00.000Z",
      title: "Approved course",
      uploadId,
    } as const;

    expect(demoCourseOutlineForUpload(uploadId, { outline })).toEqual(outline);
    expect(
      demoCourseOutlineForUpload(uploadId, { outline: { uploadId } }),
    ).toBeNull();
    expect(
      demoCourseOutlineForUpload("55000000-0000-4000-8000-000000000009", {
        outline,
      }),
    ).toBeNull();
  });
});
