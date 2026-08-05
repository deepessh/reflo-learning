import type { DemoUploadFailureCode, DemoUploadState } from "@reflo/contracts";

export interface DemoUploadPresentation {
  readonly detail: string;
  readonly label: string;
  readonly poll: boolean;
  readonly tone: "attention" | "negative" | "neutral" | "positive";
}

export function demoUploadPresentation(
  state: DemoUploadState,
  failureCode: DemoUploadFailureCode | null = null,
): DemoUploadPresentation {
  switch (state) {
    case "accepted":
      return {
        detail: "The approved source was received and is entering validation.",
        label: "Upload received",
        poll: true,
        tone: "neutral",
      };
    case "validating":
      return {
        detail:
          "Checking the declared type, file signature, approval, limits, and malware gate.",
        label: "Validating source",
        poll: true,
        tone: "neutral",
      };
    case "queued":
      return {
        detail:
          "Validation passed. The isolated parser is waiting for bounded capacity.",
        label: "Queued for parsing",
        poll: true,
        tone: "neutral",
      };
    case "parsing":
      return {
        detail:
          "The source is being parsed in the isolated, networkless ingestion worker.",
        label: "Parsing source",
        poll: true,
        tone: "neutral",
      };
    case "generating_outline":
      return {
        detail:
          "The validated source has left the parser. Reflo is generating the owner-scoped, source-backed outline.",
        label: "Generating outline",
        poll: true,
        tone: "neutral",
      };
    case "large_document":
      return {
        detail:
          "This larger PDF needs more time. You can leave this page while Reflo continues processing it.",
        label: "Processing a larger PDF",
        poll: true,
        tone: "attention",
      };
    case "ocr_required":
      return {
        detail:
          "Scanned pages were detected. Text recognition is needed before this source can become a course.",
        label: "Text recognition needed",
        poll: false,
        tone: "attention",
      };
    case "outline_ready":
      return {
        detail:
          "The owner-scoped, source-backed course outline is ready. Lessons, quizzes, and audio continue separately.",
        label: "Outline ready",
        poll: false,
        tone: "positive",
      };
    case "failed":
      return {
        detail: failureCopy(failureCode),
        label: "Upload did not complete",
        poll: false,
        tone: "negative",
      };
  }
}

function failureCopy(code: DemoUploadFailureCode | null): string {
  switch (code) {
    case "source_not_approved":
      return "This file does not match the selected approved source.";
    case "unsupported_type":
    case "mime_mismatch":
      return "Use the matching approved PDF. This file type or signature did not match.";
    case "over_limit":
    case "archive_limit":
      return "The source exceeded a declared compressed, expanded, or page limit.";
    case "encrypted":
      return "Encrypted documents cannot be processed. Use an unencrypted approved source.";
    case "malformed_document":
    case "active_content":
      return "The source could not be parsed safely. Check the approved artifact and try again.";
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
