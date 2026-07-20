import type { ModelTaskId } from "./contracts.js";
import type { ProviderUsage } from "./ports.js";

export type AttemptOutcome =
  | "deadline_exceeded"
  | "permanent_error"
  | "success"
  | "transient_error"
  | "validation_error";

export interface ModelAttemptTrace {
  readonly adapterVersion: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly effectiveModel: string;
  readonly effectiveModelVersion: string;
  readonly outcome: AttemptOutcome;
  readonly requestedSelector: string;
  readonly retryReason?: string;
  readonly startedAt: string;
  readonly usage?: ProviderUsage;
  readonly validationStatus: "failed" | "not_run" | "passed";
}

export interface ModelLogicalCallTrace {
  readonly attempts: readonly ModelAttemptTrace[];
  readonly callId: string;
  readonly durationMs: number;
  readonly finishedAt: string;
  readonly outcome: "failure" | "success";
  readonly promptDigest?: string;
  readonly promptId?: string;
  readonly routePolicyVersion: string;
  readonly startedAt: string;
  readonly task: ModelTaskId;
}

export interface ModelTraceSink {
  record(trace: ModelLogicalCallTrace): Promise<void> | void;
}

const LOGICAL_TRACE_KEYS = new Set([
  "attempts",
  "callId",
  "durationMs",
  "finishedAt",
  "outcome",
  "promptDigest",
  "promptId",
  "routePolicyVersion",
  "startedAt",
  "task",
]);

const ATTEMPT_TRACE_KEYS = new Set([
  "adapterVersion",
  "attempt",
  "durationMs",
  "effectiveModel",
  "effectiveModelVersion",
  "outcome",
  "requestedSelector",
  "retryReason",
  "startedAt",
  "usage",
  "validationStatus",
]);

export function assertSafeTraceEnvelope(
  trace: ModelLogicalCallTrace,
): ModelLogicalCallTrace {
  assertOnlyKeys(trace, LOGICAL_TRACE_KEYS, "logical trace");
  for (const attempt of trace.attempts) {
    assertOnlyKeys(attempt, ATTEMPT_TRACE_KEYS, "attempt trace");
    if (attempt.usage !== undefined) {
      assertOnlyKeys(
        attempt.usage,
        new Set(["inputUnits", "outputUnits"]),
        "usage trace",
      );
    }
  }
  return trace;
}

function assertOnlyKeys(
  value: object,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const rejected = Object.keys(value).filter((key) => !allowed.has(key));
  if (rejected.length > 0) {
    throw new Error(
      `${label} contains non-allowlisted fields: ${rejected.sort().join(", ")}`,
    );
  }
}
