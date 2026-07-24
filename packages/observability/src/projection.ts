import { createHash } from "node:crypto";

import type {
  ModelLogicalCallTrace,
  ModelTaskId,
  ModelTraceSink,
} from "@reflo/model-router";
import { assertSafeTraceEnvelope } from "@reflo/model-router";

import {
  DEMO_TELEMETRY_SCHEMA_VERSION,
  assertSafeDemoOperationalTrace,
  type DemoOperationalTrace,
  type DemoOperationalTraceSink,
  type DemoOperationName,
  type DemoPipelineStage,
} from "./contracts.js";

export function createSlsModelHealthTraceSink(options: {
  readonly component: string;
  readonly demoRunId: string;
  readonly environment: "dev" | "pilot" | "staging";
  readonly sink: DemoOperationalTraceSink;
}): ModelTraceSink {
  return Object.freeze({
    record(
      unsafeTrace: ModelLogicalCallTrace,
      signal: AbortSignal,
    ): Promise<void> | void {
      const trace = assertSafeTraceEnvelope(unsafeTrace);
      return options.sink.record(projectModelTrace(trace, options), signal);
    },
  });
}

export function createCompositeModelTraceSink(
  sinks: readonly ModelTraceSink[],
): ModelTraceSink {
  const selected = [...sinks];
  return Object.freeze({
    async record(
      trace: ModelLogicalCallTrace,
      signal: AbortSignal,
    ): Promise<void> {
      await Promise.all(
        selected.map(async (sink) => {
          await sink.record(trace, signal);
        }),
      );
    },
  });
}

function projectModelTrace(
  trace: ModelLogicalCallTrace,
  options: {
    readonly component: string;
    readonly demoRunId: string;
    readonly environment: "dev" | "pilot" | "staging";
  },
): DemoOperationalTrace {
  const task = modelTaskHealth(trace.task);
  const finalAttempt = trace.attempts.at(-1);
  return assertSafeDemoOperationalTrace({
    attemptCount: trace.attempts.length,
    component: options.component,
    demoRunId: options.demoRunId,
    durationMs: trace.durationMs,
    environment: options.environment,
    eventId: eventId(trace.callId),
    finishedAt: trace.finishedAt,
    ...(finalAttempt === undefined
      ? {}
      : {
          model: finalAttempt.effectiveModel,
          modelVersion: finalAttempt.effectiveModelVersion,
          validationStatus: finalAttempt.validationStatus,
        }),
    modelTask: trace.task,
    operation: task.operation,
    outcome: trace.outcome,
    ...(trace.promptId === undefined ? {} : { promptId: trace.promptId }),
    ...(trace.promptVersion === undefined
      ? {}
      : { promptVersion: trace.promptVersion }),
    routePolicyVersion: trace.routePolicyVersion,
    schemaVersion: DEMO_TELEMETRY_SCHEMA_VERSION,
    stage: task.stage,
    startedAt: trace.startedAt,
  });
}

function modelTaskHealth(task: ModelTaskId): {
  readonly operation: DemoOperationName;
  readonly stage: DemoPipelineStage;
} {
  switch (task) {
    case "curriculum.structure.v1":
    case "embedding.document.v1":
    case "embedding.query.v1":
      return { operation: "curriculum_generation", stage: "ingestion" };
    case "assessment.grade-short-answer.v1":
      return { operation: "short_answer_grading", stage: "grading" };
    case "assessment.quiz.v1":
      return { operation: "quiz_generation", stage: "generation" };
    case "lesson.audio-script.v1":
    case "lesson.reteach.v1":
    case "lesson.text.v1":
      return { operation: "lesson_generation", stage: "generation" };
    case "media.tts.v1":
      return { operation: "audio_generation", stage: "generation" };
    case "media.video.v1":
      return { operation: "video_generation", stage: "generation" };
    case "tutor.answer.v1":
      return { operation: "tutor_answer", stage: "generation" };
  }
}

function eventId(callId: string): string {
  return `evt-${createHash("sha256")
    .update(`reflo/model-trace/${callId}`)
    .digest("hex")
    .slice(0, 32)}`;
}
