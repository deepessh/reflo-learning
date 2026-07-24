import { describe, expect, it, vi } from "vitest";

import type { ModelLogicalCallTrace } from "@reflo/model-router";

import { createLangfuseModelTraceSink } from "./adapters/langfuse.js";
import { createSlsDemoOperationalTraceSink } from "./adapters/sls.js";
import {
  DEMO_TELEMETRY_SCHEMA_VERSION,
  assertSafeDemoOperationalTrace,
  type DemoOperationalTrace,
} from "./contracts.js";
import { SLS_DEMO_HEALTH_DASHBOARD } from "./dashboard.js";
import { createSlsModelHealthTraceSink } from "./projection.js";
import { createDemoTraceRuntime } from "./runtime.js";

const logicalTrace: ModelLogicalCallTrace = {
  attempts: [
    {
      adapterVersion: "model-studio-v1",
      attempt: 1,
      durationMs: 40,
      effectiveModel: "qwen-plus",
      effectiveModelVersion: "2026-07-01",
      outcome: "success",
      requestedSelector: "qwen.grading",
      startedAt: "2026-07-24T20:00:00.010Z",
      usage: { inputUnits: 20, outputUnits: 5 },
      validationStatus: "passed",
    },
  ],
  callId: "8d0d87d1-0a79-4074-a4d6-296d021f9ef8",
  durationMs: 50,
  finishedAt: "2026-07-24T20:00:00.050Z",
  outcome: "success",
  promptDigest: "a".repeat(64),
  promptId: "assessment-grade-short-answer",
  promptVersion: "2",
  routePolicyVersion: "route-policy-v3",
  startedAt: "2026-07-24T20:00:00.000Z",
  task: "assessment.grade-short-answer.v1",
};

const operationalTrace: DemoOperationalTrace = {
  attemptCount: 1,
  component: "api",
  demoRunId: `demo-${"a".repeat(32)}`,
  durationMs: 12,
  environment: "staging",
  eventId: `evt-${"b".repeat(32)}`,
  finishedAt: "2026-07-24T20:00:00.012Z",
  operation: "test_delivery_dispatch",
  outcome: "success",
  schemaVersion: DEMO_TELEMETRY_SCHEMA_VERSION,
  stage: "test_delivery",
  startedAt: "2026-07-24T20:00:00.000Z",
};

describe("closed demo telemetry schema", () => {
  it("rejects content, contact, filename, learner, and arbitrary fields", () => {
    for (const field of [
      "answer",
      "email",
      "filename",
      "learnerId",
      "passage",
      "prompt",
      "providerPayload",
      "sourceTitle",
    ]) {
      expect(() =>
        assertSafeDemoOperationalTrace({
          ...operationalTrace,
          [field]: "private value",
        } as never),
      ).toThrow("closed safe schema");
    }
  });

  it("requires explicit non-learner demo and event identifiers", () => {
    expect(() =>
      assertSafeDemoOperationalTrace({
        ...operationalTrace,
        demoRunId: "learner-123",
      }),
    ).toThrow("closed safe schema");
    expect(() =>
      assertSafeDemoOperationalTrace({
        ...operationalTrace,
        eventId: "delivery@example.com",
      }),
    ).toThrow("closed safe schema");
  });
});

describe("Langfuse OTLP adapter", () => {
  it("sends only allowlisted model metadata to the current OTLP endpoint", async () => {
    const fetchImplementation = vi.fn(async () => new Response(null));
    const sink = createLangfuseModelTraceSink(
      {
        baseUrl: new URL("https://cloud.langfuse.example"),
        deployment: "staging",
        publicKey: "pk-demo",
        secretKey: "sk-demo",
        serviceName: "jobs",
      },
      fetchImplementation,
    );

    await sink.record(logicalTrace, new AbortController().signal);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, request] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://cloud.langfuse.example/api/public/otel/v1/traces",
    );
    expect(request?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("pk-demo:sk-demo").toString(
        "base64",
      )}`,
      "content-type": "application/json",
      "x-langfuse-ingestion-version": "4",
    });
    const serialized = String(request?.body);
    expect(serialized).toContain("assessment-grade-short-answer");
    expect(serialized).toContain("qwen-plus");
    expect(serialized).toContain("reflo.prompt_version");
    const payload = JSON.parse(serialized) as {
      resourceSpans: {
        scopeSpans: { spans: { parentSpanId?: string }[] }[];
      }[];
    };
    expect(
      payload.resourceSpans[0]?.scopeSpans[0]?.spans[1]?.parentSpanId,
    ).toMatch(/^[a-f0-9]{16}$/);
    for (const prohibited of [
      "pk-demo",
      "sk-demo",
      "learner",
      "source passage",
      "answer text",
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it("returns bounded failures without provider response bodies", async () => {
    const sink = createLangfuseModelTraceSink(
      {
        baseUrl: new URL("https://cloud.langfuse.example"),
        deployment: "staging",
        publicKey: "pk-demo",
        secretKey: "sk-demo",
        serviceName: "jobs",
      },
      async () =>
        new Response("secret provider diagnostic", {
          status: 503,
        }),
    );

    await expect(
      sink.record(logicalTrace, new AbortController().signal),
    ).rejects.toThrow("telemetry sink rejected the request (503)");
  });
});

describe("SLS OTLP adapter and health projection", () => {
  it("keeps credentials in headers and emits bounded dashboard fields", async () => {
    const fetchImplementation = vi.fn(async () => new Response(null));
    const sink = createSlsDemoOperationalTraceSink(
      {
        accessKeyId: "ak-id",
        accessKeySecret: "ak-secret",
        deployment: "staging",
        endpoint: new URL(
          "https://reflo-demo.cn-hangzhou.log.aliyuncs.com/opentelemetry/v1/traces",
        ),
        instanceId: "reflo-demo-traces",
        project: "reflo-demo",
        serviceName: "api",
      },
      fetchImplementation,
    );

    await sink.record(operationalTrace, new AbortController().signal);

    const [url, request] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://reflo-demo.cn-hangzhou.log.aliyuncs.com/opentelemetry/v1/traces",
    );
    expect(request?.headers).toMatchObject({
      "x-sls-otel-ak-id": "ak-id",
      "x-sls-otel-ak-secret": "ak-secret",
      "x-sls-otel-instance-id": "reflo-demo-traces",
      "x-sls-otel-project": "reflo-demo",
    });
    const serialized = String(request?.body);
    expect(serialized).toContain("reflo_stage");
    expect(serialized).toContain("test_delivery");
    expect(serialized).not.toContain("ak-id");
    expect(serialized).not.toContain("ak-secret");
  });

  it("projects model traces into grading health without learner identifiers", async () => {
    const received: DemoOperationalTrace[] = [];
    const sink = createSlsModelHealthTraceSink({
      component: "jobs",
      demoRunId: `demo-${"c".repeat(32)}`,
      environment: "staging",
      sink: {
        record(trace) {
          received.push(trace);
        },
      },
    });

    await sink.record(logicalTrace, new AbortController().signal);

    expect(received).toEqual([
      expect.objectContaining({
        model: "qwen-plus",
        modelTask: "assessment.grade-short-answer.v1",
        modelVersion: "2026-07-01",
        operation: "short_answer_grading",
        promptId: "assessment-grade-short-answer",
        promptVersion: "2",
        stage: "grading",
      }),
    ]);
    expect(JSON.stringify(received)).not.toContain("learner");
  });
});

describe("configuration and dashboard contract", () => {
  it("stays disabled until the complete staff-only mode is selected", async () => {
    const runtime = createDemoTraceRuntime(
      {},
      { component: "api", deployment: "dev" },
    );
    expect(runtime.enabled).toBe(false);
    await runtime.recordOperational({
      durationMs: 1,
      finishedAt: "2026-07-24T20:00:00.001Z",
      operation: "test_delivery_dispatch",
      outcome: "success",
      stage: "test_delivery",
      startedAt: "2026-07-24T20:00:00.000Z",
    });
  });

  it("fans model traces to Langfuse and SLS and sends operations only to SLS", async () => {
    const fetchImplementation = vi.fn(async () => new Response(null));
    const runtime = createDemoTraceRuntime(
      environment({
        REFLO_SLS_OTEL_ENDPOINT:
          "https://reflo-demo.cn-hangzhou.log.aliyuncs.com/opentelemetry/v1/traces",
      }),
      {
        component: "api",
        deployment: "staging",
        fetchImplementation,
      },
    );
    await runtime.modelTraces.record(
      logicalTrace,
      new AbortController().signal,
    );
    await runtime.recordOperational({
      durationMs: 1,
      finishedAt: "2026-07-24T20:00:00.001Z",
      operation: "test_delivery_dispatch",
      outcome: "success",
      stage: "test_delivery",
      startedAt: "2026-07-24T20:00:00.000Z",
    });

    expect(runtime.enabled).toBe(true);
    expect(
      fetchImplementation.mock.calls.map(([url]) => String(url)).sort(),
    ).toEqual([
      "https://langfuse.example.invalid/api/public/otel/v1/traces",
      "https://reflo-demo.cn-hangzhou.log.aliyuncs.com/opentelemetry/v1/traces",
      "https://reflo-demo.cn-hangzhou.log.aliyuncs.com/opentelemetry/v1/traces",
    ]);
  });

  it("rejects non-TLS and non-SLS production endpoints", () => {
    expect(() =>
      createDemoTraceRuntime(
        environment({
          REFLO_SLS_OTEL_ENDPOINT: "http://sls.example.invalid",
        }),
        { component: "api", deployment: "staging" },
      ),
    ).toThrow("telemetry endpoint is not allowlisted");
    expect(() =>
      createDemoTraceRuntime(environment(), {
        component: "api",
        deployment: "staging",
      }),
    ).toThrow("must use Alibaba Cloud SLS");
  });

  it("defines one honestly labeled health panel for every required stage", () => {
    expect(
      SLS_DEMO_HEALTH_DASHBOARD.panels.map((panel) => panel.stage).sort(),
    ).toEqual(["generation", "grading", "ingestion", "test_delivery"]);
    expect(SLS_DEMO_HEALTH_DASHBOARD.honestLabel).toContain(
      "not production privacy or pilot-readiness evidence",
    );
    for (const panel of SLS_DEMO_HEALTH_DASHBOARD.panels) {
      expect(panel.traceFilter).toContain(
        "reflo_schema_version:demo-operational-trace-v1",
      );
      expect(panel.query).toContain("p95_duration_ms");
      expect(panel.query).toContain("failure_count");
    }
  });
});

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    REFLO_DEMO_TRACING_MODE: "staff-only-demo-v1",
    REFLO_DEMO_TRACE_RUN_ID: `demo-${"d".repeat(32)}`,
    REFLO_LANGFUSE_BASE_URL: "https://langfuse.example.invalid",
    REFLO_LANGFUSE_PUBLIC_KEY: "pk",
    REFLO_LANGFUSE_SECRET_KEY: "sk",
    REFLO_SLS_ACCESS_KEY_ID: "ak",
    REFLO_SLS_ACCESS_KEY_SECRET: "secret",
    REFLO_SLS_OTEL_ENDPOINT:
      "https://sls.example.invalid/opentelemetry/v1/traces",
    REFLO_SLS_PROJECT: "reflo-demo",
    REFLO_SLS_TRACE_INSTANCE_ID: "reflo-demo-traces",
    ...overrides,
  };
}
