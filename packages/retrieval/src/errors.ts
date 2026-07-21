export type RetrievalErrorCode =
  | "authorization_denied"
  | "invalid_chunk"
  | "invalid_configuration"
  | "invalid_model_result"
  | "invalid_vector_result"
  | "persistence_failure";

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;

  constructor(
    code: RetrievalErrorCode,
    message = "retrieval operation failed",
  ) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
  }
}
