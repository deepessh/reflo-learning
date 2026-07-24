import type {
  ModelAttemptTrace,
  ModelLogicalCallTrace,
  ModelTraceSink,
} from "@reflo/model-router";
import { assertSafeTraceEnvelope } from "@reflo/model-router";

import {
  buildOtlpTraceRequest,
  postOtlpJson,
  type OtlpSpan,
  validateTelemetryEndpoint,
} from "../otlp.js";

export interface LangfuseModelTraceConfiguration {
  readonly baseUrl: URL;
  readonly deployment: "dev" | "pilot" | "staging";
  readonly publicKey: string;
  readonly secretKey: string;
  readonly serviceName: string;
}

export function createLangfuseModelTraceSink(
  configuration: LangfuseModelTraceConfiguration,
  fetchImplementation: typeof fetch = fetch,
): ModelTraceSink {
  const baseUrl = validateTelemetryEndpoint(
    configuration.baseUrl.toString(),
    configuration.deployment,
  );
  if (
    !safeServiceName(configuration.serviceName) ||
    !credential(configuration.publicKey) ||
    !credential(configuration.secretKey)
  ) {
    throw new Error("Langfuse trace configuration is invalid");
  }
  const endpoint = new URL("/api/public/otel/v1/traces", baseUrl);
  const authorization = `Basic ${Buffer.from(
    `${configuration.publicKey}:${configuration.secretKey}`,
  ).toString("base64")}`;

  return Object.freeze({
    async record(
      unsafeTrace: ModelLogicalCallTrace,
      signal: AbortSignal,
    ): Promise<void> {
      const trace = assertSafeTraceEnvelope(unsafeTrace);
      await postOtlpJson(
        {
          body: buildOtlpTraceRequest(
            configuration.serviceName,
            configuration.deployment,
            langfuseSpans(trace),
          ),
          headers: {
            authorization,
            "x-langfuse-ingestion-version": "4",
          },
          signal,
          url: endpoint,
        },
        fetchImplementation,
      );
    },
  });
}

function langfuseSpans(trace: ModelLogicalCallTrace): OtlpSpan[] {
  const rootSpanId = spanId(trace.callId, "logical");
  return [
    logicalSpan(trace),
    ...trace.attempts.map((attempt) => attemptSpan(trace, attempt, rootSpanId)),
  ];
}

function logicalSpan(trace: ModelLogicalCallTrace): OtlpSpan {
  return {
    attributes: [
      { key: "reflo.call_id", value: trace.callId },
      { key: "reflo.model_task", value: trace.task },
      { key: "reflo.outcome", value: trace.outcome },
      {
        key: "reflo.route_policy_version",
        value: trace.routePolicyVersion,
      },
      ...(trace.promptId === undefined
        ? []
        : [{ key: "reflo.prompt_id", value: trace.promptId }]),
      ...(trace.promptVersion === undefined
        ? []
        : [{ key: "reflo.prompt_version", value: trace.promptVersion }]),
    ],
    endTime: trace.finishedAt,
    name: `model.${trace.task}`,
    spanKey: spanId(trace.callId, "logical"),
    startTime: trace.startedAt,
    status: trace.outcome === "success" ? ("ok" as const) : ("error" as const),
    traceKey: trace.callId,
  };
}

function attemptSpan(
  trace: ModelLogicalCallTrace,
  attempt: ModelAttemptTrace,
  parentSpanId: string,
): OtlpSpan {
  return {
    attributes: [
      { key: "reflo.adapter_version", value: attempt.adapterVersion },
      { key: "reflo.attempt", value: attempt.attempt },
      { key: "reflo.model", value: attempt.effectiveModel },
      {
        key: "reflo.model_version",
        value: attempt.effectiveModelVersion,
      },
      { key: "reflo.outcome", value: attempt.outcome },
      {
        key: "reflo.requested_selector",
        value: attempt.requestedSelector,
      },
      {
        key: "reflo.validation_status",
        value: attempt.validationStatus,
      },
      ...(attempt.retryReason === undefined
        ? []
        : [{ key: "reflo.retry_reason", value: attempt.retryReason }]),
      ...(attempt.usage?.inputUnits === undefined
        ? []
        : [
            {
              key: "reflo.usage_input_units",
              value: attempt.usage.inputUnits,
            },
          ]),
      ...(attempt.usage?.outputUnits === undefined
        ? []
        : [
            {
              key: "reflo.usage_output_units",
              value: attempt.usage.outputUnits,
            },
          ]),
    ],
    endTime: new Date(
      Date.parse(attempt.startedAt) + attempt.durationMs,
    ).toISOString(),
    name: `model.attempt.${attempt.attempt}`,
    parentSpanId,
    spanKey: spanId(trace.callId, `attempt/${attempt.attempt}`),
    startTime: attempt.startedAt,
    status:
      attempt.outcome === "success" ? ("ok" as const) : ("error" as const),
    traceKey: trace.callId,
  };
}

function spanId(callId: string, suffix: string): string {
  return `${callId}/${suffix}`;
}

function credential(value: string): boolean {
  return value.length >= 1 && value.length <= 512;
}

function safeServiceName(value: string): boolean {
  return /^[a-z][a-z0-9-]{1,39}$/.test(value);
}
