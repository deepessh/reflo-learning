export type ActivationGenerationErrorCode =
  | "authorization_denied"
  | "content_out_of_bounds"
  | "invalid_configuration"
  | "invalid_result"
  | "operation_unavailable"
  | "regeneration_cooldown"
  | "regeneration_not_allowed";

export class ActivationGenerationError extends Error {
  readonly code: ActivationGenerationErrorCode;
  readonly retryAt: Date | null;

  constructor(
    code: ActivationGenerationErrorCode,
    message?: string,
    options: { readonly retryAt?: Date } = {},
  ) {
    super(message ?? code);
    this.name = "ActivationGenerationError";
    this.code = code;
    this.retryAt = options.retryAt ?? null;
  }
}
