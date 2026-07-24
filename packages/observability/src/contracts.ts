import { MODEL_TASK_IDS, type ModelTaskId } from "@reflo/model-router";

export const DEMO_TELEMETRY_SCHEMA_VERSION =
  "demo-operational-trace-v1" as const;

export const DEMO_PIPELINE_STAGES = [
  "ingestion",
  "generation",
  "grading",
  "test_delivery",
] as const;

export type DemoPipelineStage = (typeof DEMO_PIPELINE_STAGES)[number];

export const DEMO_OPERATION_NAMES = [
  "document_ingestion",
  "curriculum_generation",
  "lesson_generation",
  "quiz_generation",
  "short_answer_grading",
  "tutor_answer",
  "audio_generation",
  "video_generation",
  "test_delivery_dispatch",
  "test_delivery_response",
] as const;

export type DemoOperationName = (typeof DEMO_OPERATION_NAMES)[number];

export type DemoOperationalOutcome =
  "abstained" | "failure" | "replayed" | "success";

export interface DemoOperationalTrace {
  readonly attemptCount: number;
  readonly component: string;
  readonly demoRunId: string;
  readonly durationMs: number;
  readonly environment: "dev" | "pilot" | "staging";
  readonly eventId: string;
  readonly finishedAt: string;
  readonly model?: string;
  readonly modelTask?: ModelTaskId;
  readonly modelVersion?: string;
  readonly operation: DemoOperationName;
  readonly outcome: DemoOperationalOutcome;
  readonly promptId?: string;
  readonly promptVersion?: string;
  readonly routePolicyVersion?: string;
  readonly schemaVersion: typeof DEMO_TELEMETRY_SCHEMA_VERSION;
  readonly stage: DemoPipelineStage;
  readonly startedAt: string;
  readonly validationStatus?: "failed" | "not_run" | "passed";
}

export interface DemoOperationalTraceSink {
  record(
    trace: DemoOperationalTrace,
    signal: AbortSignal,
  ): Promise<void> | void;
}

export interface DemoOperationalTraceInput {
  readonly attemptCount?: number;
  readonly durationMs: number;
  readonly finishedAt: string;
  readonly operation: DemoOperationName;
  readonly outcome: DemoOperationalOutcome;
  readonly stage: DemoPipelineStage;
  readonly startedAt: string;
}

const TRACE_KEYS = new Set([
  "attemptCount",
  "component",
  "demoRunId",
  "durationMs",
  "environment",
  "eventId",
  "finishedAt",
  "model",
  "modelTask",
  "modelVersion",
  "operation",
  "outcome",
  "promptId",
  "promptVersion",
  "routePolicyVersion",
  "schemaVersion",
  "stage",
  "startedAt",
  "validationStatus",
]);

const SAFE_COMPONENT = /^[a-z][a-z0-9-]{1,39}$/;
const SAFE_DEMO_RUN_ID = /^demo-[a-f0-9]{32}$/;
const SAFE_EVENT_ID = /^evt-[a-f0-9]{32}$/;
const SAFE_BOUNDED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function assertSafeDemoOperationalTrace(
  trace: DemoOperationalTrace,
): DemoOperationalTrace {
  const rejected = Object.keys(trace).filter((key) => !TRACE_KEYS.has(key));
  if (
    rejected.length > 0 ||
    trace.schemaVersion !== DEMO_TELEMETRY_SCHEMA_VERSION ||
    !DEMO_PIPELINE_STAGES.includes(trace.stage) ||
    !DEMO_OPERATION_NAMES.includes(trace.operation) ||
    !["abstained", "failure", "replayed", "success"].includes(trace.outcome) ||
    !["dev", "pilot", "staging"].includes(trace.environment) ||
    !SAFE_COMPONENT.test(trace.component) ||
    !SAFE_DEMO_RUN_ID.test(trace.demoRunId) ||
    !SAFE_EVENT_ID.test(trace.eventId) ||
    !validTimestamp(trace.startedAt) ||
    !validTimestamp(trace.finishedAt) ||
    !Number.isSafeInteger(trace.durationMs) ||
    trace.durationMs < 0 ||
    trace.durationMs > 86_400_000 ||
    !Number.isSafeInteger(trace.attemptCount) ||
    trace.attemptCount < 0 ||
    trace.attemptCount > 10 ||
    !boundedOptional(trace.model) ||
    !boundedOptional(trace.modelVersion) ||
    (trace.modelTask !== undefined &&
      !MODEL_TASK_IDS.includes(trace.modelTask)) ||
    !boundedOptional(trace.promptId) ||
    !boundedOptional(trace.promptVersion) ||
    !boundedOptional(trace.routePolicyVersion) ||
    (trace.validationStatus !== undefined &&
      !["failed", "not_run", "passed"].includes(trace.validationStatus))
  ) {
    throw new Error("demo operational trace violates its closed safe schema");
  }
  return trace;
}

function validTimestamp(value: string): boolean {
  return value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function boundedOptional(value: string | undefined): boolean {
  return value === undefined || SAFE_BOUNDED_VALUE.test(value);
}
