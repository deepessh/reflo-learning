export type TutorAgentErrorCode =
  | "authorization_denied"
  | "content_unavailable"
  | "invalid_configuration"
  | "invalid_result"
  | "invalid_session"
  | "retest_unavailable";

export class TutorAgentError extends Error {
  constructor(
    readonly code: TutorAgentErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "TutorAgentError";
  }
}
