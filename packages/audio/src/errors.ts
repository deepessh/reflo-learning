export type AudioGenerationErrorCode =
  | "authorization_denied"
  | "deadline_exceeded"
  | "infrastructure_unavailable"
  | "invalid_configuration"
  | "invalid_envelope"
  | "invalid_result"
  | "operation_unavailable";

export class AudioGenerationError extends Error {
  constructor(
    readonly code: AudioGenerationErrorCode,
    message = "audio generation failed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioGenerationError";
  }
}
