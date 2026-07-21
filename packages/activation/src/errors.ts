export type ActivationGenerationErrorCode =
  | "authorization_denied"
  | "content_out_of_bounds"
  | "invalid_configuration"
  | "invalid_result"
  | "operation_unavailable";

export class ActivationGenerationError extends Error {
  readonly code: ActivationGenerationErrorCode;

  constructor(code: ActivationGenerationErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ActivationGenerationError";
    this.code = code;
  }
}
