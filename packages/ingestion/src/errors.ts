import type { IngestionFailure, IngestionFailureCode } from "./contracts.js";

const RETRYABLE_FAILURES: ReadonlySet<IngestionFailureCode> = new Set([
  "infrastructure_unavailable",
]);

export class IngestionError extends Error {
  readonly code: IngestionFailureCode;
  readonly sanitizedDetail: string | undefined;

  constructor(code: IngestionFailureCode, sanitizedDetail?: string) {
    super(code);
    this.name = "IngestionError";
    this.code = code;
    this.sanitizedDetail = sanitizedDetail;
  }

  toFailure(): IngestionFailure {
    return {
      code: this.code,
      retryable: RETRYABLE_FAILURES.has(this.code),
      ...(this.sanitizedDetail === undefined
        ? {}
        : { sanitizedDetail: this.sanitizedDetail }),
    };
  }
}

export function normalizeIngestionFailure(error: unknown): IngestionFailure {
  if (error instanceof IngestionError) {
    return error.toFailure();
  }
  return {
    code: "infrastructure_unavailable",
    retryable: true,
  };
}
