export type AssessmentErrorCode =
  | "authorization_denied"
  | "conflicting_duplicate"
  | "fallback_unavailable"
  | "grading_unavailable"
  | "grading_in_progress"
  | "invalid_configuration"
  | "invalid_input"
  | "invalid_result"
  | "projection_unavailable"
  | "question_unavailable";

export class AssessmentError extends Error {
  constructor(
    readonly code: AssessmentErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AssessmentError";
  }
}
