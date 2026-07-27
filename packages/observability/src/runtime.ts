import { randomUUID } from "node:crypto";

import type { ModelTraceSink } from "@reflo/model-router";

import { createLangfuseModelTraceSink } from "./adapters/langfuse.js";
import { createSlsDemoOperationalTraceSink } from "./adapters/sls.js";
import {
  DEMO_TELEMETRY_SCHEMA_VERSION,
  assertSafeDemoOperationalTrace,
  type DemoOperationalTraceInput,
  type DemoOperationalTraceSink,
} from "./contracts.js";
import {
  createCompositeModelTraceSink,
  createSlsModelHealthTraceSink,
} from "./projection.js";
import { validateTelemetryEndpoint } from "./otlp.js";

const ENABLED_MODE = "staff-only-demo-v1";

export interface DemoTraceRuntime {
  readonly enabled: boolean;
  readonly modelTraces: ModelTraceSink;
  recordOperational(trace: DemoOperationalTraceInput): Promise<void>;
}

export function createDemoTraceRuntime(
  input: NodeJS.ProcessEnv,
  options: {
    readonly component: string;
    readonly deployment: "dev" | "pilot" | "staging";
    readonly fetchImplementation?: typeof fetch;
  },
): DemoTraceRuntime {
  const mode = input.REFLO_DEMO_TRACING_MODE?.trim();
  if (mode === undefined || mode === "disabled") {
    return disabledRuntime();
  }
  if (mode !== ENABLED_MODE) {
    throw new Error("REFLO_DEMO_TRACING_MODE is not allowlisted");
  }
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(options.component)) {
    throw new Error("demo trace component is not allowlisted");
  }

  const demoRunId = required(input, "REFLO_DEMO_TRACE_RUN_ID");
  if (!/^demo-[a-f0-9]{32}$/.test(demoRunId)) {
    throw new Error(
      "REFLO_DEMO_TRACE_RUN_ID must be a non-learner demo identifier",
    );
  }
  const langfuseEndpoint = validateTelemetryEndpoint(
    required(input, "REFLO_LANGFUSE_BASE_URL"),
    options.deployment,
  );
  const slsEndpoint = validateTelemetryEndpoint(
    required(input, "REFLO_SLS_OTEL_ENDPOINT"),
    options.deployment,
    "/opentelemetry/v1/traces",
  );
  if (
    options.deployment !== "dev" &&
    !slsEndpoint.hostname.endsWith(".log.aliyuncs.com")
  ) {
    throw new Error("REFLO_SLS_OTEL_ENDPOINT must use Alibaba Cloud SLS");
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const sls: DemoOperationalTraceSink = createSlsDemoOperationalTraceSink(
    {
      accessKeyId: required(input, "REFLO_SLS_ACCESS_KEY_ID"),
      accessKeySecret: required(input, "REFLO_SLS_ACCESS_KEY_SECRET"),
      deployment: options.deployment,
      endpoint: slsEndpoint,
      instanceId: bounded(input, "REFLO_SLS_TRACE_INSTANCE_ID"),
      project: bounded(input, "REFLO_SLS_PROJECT"),
      serviceName: options.component,
    },
    fetchImplementation,
  );
  const langfuse = createLangfuseModelTraceSink(
    {
      baseUrl: langfuseEndpoint,
      deployment: options.deployment,
      publicKey: required(input, "REFLO_LANGFUSE_PUBLIC_KEY"),
      secretKey: required(input, "REFLO_LANGFUSE_SECRET_KEY"),
      serviceName: options.component,
    },
    fetchImplementation,
  );

  return Object.freeze({
    enabled: true,
    modelTraces: createCompositeModelTraceSink([
      langfuse,
      createSlsModelHealthTraceSink({
        component: options.component,
        demoRunId,
        environment: options.deployment,
        sink: sls,
      }),
    ]),
    async recordOperational(trace: DemoOperationalTraceInput): Promise<void> {
      const event = assertSafeDemoOperationalTrace({
        attemptCount: trace.attemptCount ?? 1,
        chapterCount: trace.chapterCount,
        component: options.component,
        compositionFinalizationMs: trace.compositionFinalizationMs,
        conceptCount: trace.conceptCount,
        deadlineBudgetMs: trace.deadlineBudgetMs,
        demoRunId,
        durationMs: trace.durationMs,
        environment: options.deployment,
        eventId: `evt-${randomUUID().replaceAll("-", "")}`,
        finalizationReserveMs: trace.finalizationReserveMs,
        finishedAt: trace.finishedAt,
        operation: trace.operation,
        outcome: trace.outcome,
        retryCount: trace.retryCount,
        schemaVersion: DEMO_TELEMETRY_SCHEMA_VERSION,
        segmentCount: trace.segmentCount,
        segmentLatencyMaxMs: trace.segmentLatencyMaxMs,
        segmentLatencyMinMs: trace.segmentLatencyMinMs,
        segmentLatencyP50Ms: trace.segmentLatencyP50Ms,
        segmentLatencyP95Ms: trace.segmentLatencyP95Ms,
        segmentQueueMaxMs: trace.segmentQueueMaxMs,
        segmentQueueMinMs: trace.segmentQueueMinMs,
        segmentQueueP50Ms: trace.segmentQueueP50Ms,
        segmentQueueP95Ms: trace.segmentQueueP95Ms,
        stage: trace.stage,
        startedAt: trace.startedAt,
      });
      await sls.record(event, new AbortController().signal);
    },
  });
}

function disabledRuntime(): DemoTraceRuntime {
  return Object.freeze({
    enabled: false,
    modelTraces: {
      record: () => undefined,
    },
    recordOperational: async () => undefined,
  });
}

function bounded(input: NodeJS.ProcessEnv, name: string): string {
  const value = required(input, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value)) {
    throw new Error(`${name} is not a bounded provider identifier`);
  }
  return value;
}

function required(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "" || value.length > 512) {
    throw new Error(`${name} is required`);
  }
  return value;
}
