import type {
  DemoOperationalTrace,
  DemoOperationalTraceSink,
} from "../contracts.js";
import { assertSafeDemoOperationalTrace } from "../contracts.js";
import {
  buildOtlpTraceRequest,
  postOtlpJson,
  validateTelemetryEndpoint,
} from "../otlp.js";

export interface SlsDemoTraceConfiguration {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly deployment: "dev" | "pilot" | "staging";
  readonly endpoint: URL;
  readonly instanceId: string;
  readonly project: string;
  readonly serviceName: string;
}

export function createSlsDemoOperationalTraceSink(
  configuration: SlsDemoTraceConfiguration,
  fetchImplementation: typeof fetch = fetch,
): DemoOperationalTraceSink {
  const baseUrl = validateTelemetryEndpoint(
    configuration.endpoint.toString(),
    configuration.deployment,
    "/opentelemetry/v1/traces",
  );
  if (
    (configuration.deployment !== "dev" &&
      !baseUrl.hostname.endsWith(".log.aliyuncs.com")) ||
    !credential(configuration.accessKeyId) ||
    !credential(configuration.accessKeySecret) ||
    !providerIdentifier(configuration.instanceId) ||
    !providerIdentifier(configuration.project) ||
    !/^[a-z][a-z0-9-]{1,39}$/.test(configuration.serviceName)
  ) {
    throw new Error("SLS trace configuration is invalid");
  }
  const endpoint = baseUrl;
  return Object.freeze({
    async record(
      unsafeTrace: DemoOperationalTrace,
      signal: AbortSignal,
    ): Promise<void> {
      const trace = assertSafeDemoOperationalTrace(unsafeTrace);
      if (
        trace.environment !== configuration.deployment ||
        trace.component !== configuration.serviceName
      ) {
        throw new Error("SLS trace does not match its configured scope");
      }
      await postOtlpJson(
        {
          body: buildOtlpTraceRequest(
            configuration.serviceName,
            configuration.deployment,
            [
              {
                attributes: operationalAttributes(trace),
                endTime: trace.finishedAt,
                name: `demo.${trace.stage}.${trace.operation}`,
                spanKey: trace.eventId,
                startTime: trace.startedAt,
                status:
                  trace.outcome === "failure"
                    ? ("error" as const)
                    : ("ok" as const),
                traceKey: trace.demoRunId,
              },
            ],
          ),
          headers: {
            "x-sls-otel-ak-id": configuration.accessKeyId,
            "x-sls-otel-ak-secret": configuration.accessKeySecret,
            "x-sls-otel-instance-id": configuration.instanceId,
            "x-sls-otel-project": configuration.project,
          },
          signal,
          url: endpoint,
        },
        fetchImplementation,
      );
    },
  });
}

function operationalAttributes(trace: DemoOperationalTrace) {
  return [
    { key: "reflo_attempt_count", value: trace.attemptCount },
    { key: "reflo_component", value: trace.component },
    { key: "reflo_demo_run_id", value: trace.demoRunId },
    { key: "reflo_duration_ms", value: trace.durationMs },
    { key: "reflo_event_id", value: trace.eventId },
    { key: "reflo_operation", value: trace.operation },
    { key: "reflo_outcome", value: trace.outcome },
    { key: "reflo_schema_version", value: trace.schemaVersion },
    { key: "reflo_stage", value: trace.stage },
    ...optionalMetric("reflo_chapter_count", trace.chapterCount),
    ...optionalMetric(
      "reflo_composition_finalization_ms",
      trace.compositionFinalizationMs,
    ),
    ...optionalMetric("reflo_concept_count", trace.conceptCount),
    ...optionalMetric("reflo_deadline_budget_ms", trace.deadlineBudgetMs),
    ...optionalMetric(
      "reflo_finalization_reserve_ms",
      trace.finalizationReserveMs,
    ),
    ...optionalMetric("reflo_retry_count", trace.retryCount),
    ...optionalMetric("reflo_segment_count", trace.segmentCount),
    ...optionalMetric(
      "reflo_segment_latency_max_ms",
      trace.segmentLatencyMaxMs,
    ),
    ...optionalMetric(
      "reflo_segment_latency_min_ms",
      trace.segmentLatencyMinMs,
    ),
    ...optionalMetric(
      "reflo_segment_latency_p50_ms",
      trace.segmentLatencyP50Ms,
    ),
    ...optionalMetric(
      "reflo_segment_latency_p95_ms",
      trace.segmentLatencyP95Ms,
    ),
    ...optionalMetric("reflo_segment_queue_max_ms", trace.segmentQueueMaxMs),
    ...optionalMetric("reflo_segment_queue_min_ms", trace.segmentQueueMinMs),
    ...optionalMetric("reflo_segment_queue_p50_ms", trace.segmentQueueP50Ms),
    ...optionalMetric("reflo_segment_queue_p95_ms", trace.segmentQueueP95Ms),
    ...(trace.model === undefined
      ? []
      : [{ key: "reflo_model", value: trace.model }]),
    ...(trace.modelTask === undefined
      ? []
      : [{ key: "reflo_model_task", value: trace.modelTask }]),
    ...(trace.modelVersion === undefined
      ? []
      : [{ key: "reflo_model_version", value: trace.modelVersion }]),
    ...(trace.promptId === undefined
      ? []
      : [{ key: "reflo_prompt_id", value: trace.promptId }]),
    ...(trace.promptVersion === undefined
      ? []
      : [{ key: "reflo_prompt_version", value: trace.promptVersion }]),
    ...(trace.routePolicyVersion === undefined
      ? []
      : [
          {
            key: "reflo_route_policy_version",
            value: trace.routePolicyVersion,
          },
        ]),
    ...(trace.validationStatus === undefined
      ? []
      : [
          {
            key: "reflo_validation_status",
            value: trace.validationStatus,
          },
        ]),
  ];
}

function optionalMetric(key: string, value: number | undefined) {
  return value === undefined ? [] : [{ key, value }];
}

function credential(value: string): boolean {
  return value.length >= 1 && value.length <= 512;
}

function providerIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value);
}
