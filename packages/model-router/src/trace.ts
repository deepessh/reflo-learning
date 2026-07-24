import { MODEL_TASK_IDS, type ModelTaskId } from "./contracts.js";
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
  readonly promptVersion?: string;
  readonly routePolicyVersion: string;
  readonly startedAt: string;
  readonly task: ModelTaskId;
}

export interface ModelTraceSink {
  record(
    trace: ModelLogicalCallTrace,
    signal: AbortSignal,
  ): Promise<void> | void;
}

const LOGICAL_TRACE_KEYS = new Set([
  "attempts",
  "callId",
  "durationMs",
  "finishedAt",
  "outcome",
  "promptDigest",
  "promptId",
  "promptVersion",
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
  if (
    !safeToken(trace.callId) ||
    !Number.isSafeInteger(trace.durationMs) ||
    trace.durationMs < 0 ||
    trace.durationMs > 86_400_000 ||
    !validTimestamp(trace.startedAt) ||
    !validTimestamp(trace.finishedAt) ||
    !MODEL_TASK_IDS.includes(trace.task) ||
    !["failure", "success"].includes(trace.outcome) ||
    !safeToken(trace.routePolicyVersion) ||
    !safeOptionalToken(trace.promptId) ||
    !safeOptionalToken(trace.promptVersion) ||
    (trace.promptDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(trace.promptDigest)) ||
    trace.attempts.length > 4
  ) {
    throw new Error("logical trace contains unsafe field values");
  }
  for (const attempt of trace.attempts) {
    assertOnlyKeys(attempt, ATTEMPT_TRACE_KEYS, "attempt trace");
    if (
      !Number.isSafeInteger(attempt.attempt) ||
      attempt.attempt < 1 ||
      attempt.attempt > 4 ||
      !Number.isSafeInteger(attempt.durationMs) ||
      attempt.durationMs < 0 ||
      attempt.durationMs > 86_400_000 ||
      !validTimestamp(attempt.startedAt) ||
      !safeToken(attempt.adapterVersion) ||
      !safeToken(attempt.effectiveModel) ||
      !safeToken(attempt.effectiveModelVersion) ||
      !safeToken(attempt.requestedSelector) ||
      !safeOptionalToken(attempt.retryReason) ||
      ![
        "deadline_exceeded",
        "permanent_error",
        "success",
        "transient_error",
        "validation_error",
      ].includes(attempt.outcome) ||
      !["failed", "not_run", "passed"].includes(attempt.validationStatus)
    ) {
      throw new Error("attempt trace contains unsafe field values");
    }
    if (attempt.usage !== undefined) {
      assertOnlyKeys(
        attempt.usage,
        new Set(["inputUnits", "outputUnits"]),
        "usage trace",
      );
      if (
        !safeOptionalCount(attempt.usage.inputUnits) ||
        !safeOptionalCount(attempt.usage.outputUnits)
      ) {
        throw new Error("usage trace contains unsafe field values");
      }
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

function safeOptionalCount(value: number | undefined): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000)
  );
}

function safeOptionalToken(value: string | undefined): boolean {
  return value === undefined || safeToken(value);
}

function safeToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}

function validTimestamp(value: string): boolean {
  return value.endsWith("Z") && Number.isFinite(Date.parse(value));
}
