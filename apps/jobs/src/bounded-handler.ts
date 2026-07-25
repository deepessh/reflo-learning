export const MAX_DEVELOPMENT_HANDLER_TIMEOUT_MS = 120_000;

export class HandlerDeadlineError extends Error {
  constructor() {
    super("development handler deadline exceeded");
    this.name = "HandlerDeadlineError";
  }
}

export async function executeBoundedHandler<Result>(
  operation: () => Promise<Result>,
  timeoutMs: number,
): Promise<Result> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_DEVELOPMENT_HANDLER_TIMEOUT_MS
  ) {
    throw new Error("development handler timeout is invalid");
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HandlerDeadlineError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
