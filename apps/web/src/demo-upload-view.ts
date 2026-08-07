import type {
  DemoCourseOutline,
  DemoUploadFailureCode,
  DemoUploadState,
  DemoUploadView,
} from "@reflo/contracts";
import { DEMO_UPLOAD_CONTRACT_VERSION } from "@reflo/contracts";

export interface DemoUploadPresentation {
  readonly detail: string;
  readonly formLocked: boolean;
  readonly label: string;
  readonly poll: boolean;
  readonly progress: string;
  readonly tone: "attention" | "negative" | "neutral" | "positive";
}

export type DemoUploadFailureAction =
  | {
      readonly label: "Try again";
      readonly replacesUploadId: string;
    }
  | {
      readonly label: "Validate another PDF";
      readonly replacesUploadId: null;
    };

export function demoUploadFailureAction(
  upload: DemoUploadView,
): DemoUploadFailureAction | null {
  if (upload.state !== "failed") {
    return null;
  }
  return upload.failure?.retryable === true
    ? { label: "Try again", replacesUploadId: upload.uploadId }
    : { label: "Validate another PDF", replacesUploadId: null };
}

export function demoUploadTrackedTarget(
  uploadId: string,
  upload: DemoUploadView,
): DemoUploadView | null {
  return upload.uploadId === uploadId ? upload : null;
}

export function demoCourseOutlineForUpload(
  uploadId: string,
  value: unknown,
): DemoCourseOutline | null {
  if (!isRecord(value)) {
    return null;
  }
  const outline = value.outline;
  if (
    !isRecord(outline) ||
    outline.contractVersion !== DEMO_UPLOAD_CONTRACT_VERSION ||
    !isUuid(outline.courseId) ||
    !isUuid(outline.uploadId) ||
    outline.uploadId !== uploadId ||
    typeof outline.generatedAt !== "string" ||
    !Number.isFinite(new Date(outline.generatedAt).getTime()) ||
    typeof outline.title !== "string" ||
    outline.title.trim() === "" ||
    !Array.isArray(outline.chapters) ||
    !outline.chapters.every(isOutlineChapter)
  ) {
    return null;
  }
  return outline as unknown as DemoCourseOutline;
}

function isOutlineChapter(value: unknown): boolean {
  return (
    isRecord(value) &&
    isUuid(value.chapterId) &&
    Number.isSafeInteger(value.order) &&
    Number(value.order) >= 1 &&
    typeof value.title === "string" &&
    value.title.trim() !== "" &&
    Array.isArray(value.concepts) &&
    value.concepts.every(
      (concept) =>
        isRecord(concept) &&
        isUuid(concept.conceptId) &&
        typeof concept.name === "string" &&
        concept.name.trim() !== "" &&
        Number.isSafeInteger(concept.sourceSpanCount) &&
        Number(concept.sourceSpanCount) >= 1,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function demoUploadPresentation(
  state: DemoUploadState,
  failureCode: DemoUploadFailureCode | null = null,
): DemoUploadPresentation {
  switch (state) {
    case "accepted":
      return {
        detail: "The course source was received and is entering validation.",
        formLocked: true,
        label: "Upload received",
        poll: true,
        progress: "Stage 1 of 5: upload received.",
        tone: "neutral",
      };
    case "validating":
      return {
        detail:
          "Checking the declared type, file signature, approval, limits, and malware gate.",
        formLocked: true,
        label: "Validating source",
        poll: true,
        progress: "Stage 2 of 5: validating the source.",
        tone: "neutral",
      };
    case "queued":
      return {
        detail:
          "Validation passed. The isolated parser is waiting for bounded capacity.",
        formLocked: true,
        label: "Queued for parsing",
        poll: true,
        progress: "Stage 3 of 5: waiting for the isolated parser.",
        tone: "neutral",
      };
    case "parsing":
      return {
        detail:
          "The source is being parsed in the isolated, networkless ingestion worker.",
        formLocked: true,
        label: "Parsing source",
        poll: true,
        progress: "Stage 3 of 5: parsing the source.",
        tone: "neutral",
      };
    case "generating_outline":
      return {
        detail:
          "The validated source has left the parser. Reflo is generating the owner-scoped, source-backed outline.",
        formLocked: true,
        label: "Generating outline",
        poll: true,
        progress: "Stage 4 of 5: generating the course outline.",
        tone: "neutral",
      };
    case "large_document":
      return {
        detail:
          "This larger PDF needs more time. You can leave this page while Reflo continues processing it.",
        formLocked: true,
        label: "Processing a larger PDF",
        poll: true,
        progress:
          "Asynchronous processing is active. Exact progress and a completion estimate are not available yet.",
        tone: "attention",
      };
    case "ocr_required":
      return {
        detail:
          "Scanned pages were detected. Text recognition is needed before this source can become a course.",
        formLocked: false,
        label: "Text recognition needed",
        poll: false,
        progress:
          "Outline generation did not start. Choose a digitally generated course PDF to try again.",
        tone: "attention",
      };
    case "outline_ready":
      return {
        detail:
          "The owner-scoped, source-backed course outline is ready. Lessons, quizzes, and audio continue separately.",
        formLocked: true,
        label: "Outline ready",
        poll: false,
        progress: "Stage 5 of 5: course outline ready.",
        tone: "positive",
      };
    case "failed":
      return {
        detail: failureCopy(failureCode),
        formLocked: false,
        label: "Upload did not complete",
        poll: false,
        progress: "Processing stopped before a course outline was ready.",
        tone: "negative",
      };
  }
}

function failureCopy(code: DemoUploadFailureCode | null): string {
  switch (code) {
    case "source_not_approved":
      return "This PDF is not configured for this demo.";
    case "unsupported_type":
    case "mime_mismatch":
      return "Choose a PDF file. This file type or signature did not match.";
    case "over_limit":
    case "archive_limit":
      return "The source exceeded a declared compressed, expanded, or page limit.";
    case "encrypted":
      return "Encrypted documents cannot be processed. Use an unencrypted course source.";
    case "malformed_document":
    case "active_content":
      return "The source could not be parsed safely. Check the course PDF and try again.";
    case "malware_detected":
      return "The malware gate rejected this source. No course was created.";
    case "dependency_unavailable":
      return "A required upload dependency is unavailable. No successful outcome was recorded; retry after recovery.";
    case "generation_failed":
      return "The source parsed safely, but the source-backed course outline could not be generated. No successful outline was recorded.";
    case "parser_failed":
      return "The isolated parser failed without producing an outline. No successful outcome was recorded.";
    case null:
      return "The upload stopped without producing an outline. No successful outcome was recorded.";
  }
}
