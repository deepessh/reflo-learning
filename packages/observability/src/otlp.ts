import { createHash } from "node:crypto";

export interface OtlpAttribute {
  readonly key: string;
  readonly value: string | number;
}

export interface OtlpSpan {
  readonly attributes: readonly OtlpAttribute[];
  readonly endTime: string;
  readonly name: string;
  readonly parentSpanId?: string;
  readonly spanKey: string;
  readonly startTime: string;
  readonly status: "error" | "ok";
  readonly traceKey: string;
}

export function buildOtlpTraceRequest(
  serviceName: string,
  environment: "dev" | "pilot" | "staging",
  spans: readonly OtlpSpan[],
): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", serviceName),
            stringAttribute("deployment.environment.name", environment),
            stringAttribute(
              "telemetry.schema.version",
              "demo-operational-trace-v1",
            ),
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "@reflo/observability",
              version: "demo-operational-trace-v1",
            },
            spans: spans.map((span) => ({
              attributes: span.attributes.map(attribute),
              endTimeUnixNano: unixNanoseconds(span.endTime),
              kind: 1,
              name: span.name,
              ...(span.parentSpanId === undefined
                ? {}
                : { parentSpanId: opaqueId(span.parentSpanId, 16) }),
              spanId: opaqueId(span.spanKey, 16),
              startTimeUnixNano: unixNanoseconds(span.startTime),
              status: { code: span.status === "ok" ? 1 : 2 },
              traceId: opaqueId(span.traceKey, 32),
            })),
          },
        ],
      },
    ],
  };
}

export async function postOtlpJson(
  request: {
    readonly body: unknown;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly url: URL;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImplementation(request.url, {
    body: JSON.stringify(request.body),
    headers: {
      "content-type": "application/json",
      ...request.headers,
    },
    method: "POST",
    signal: request.signal,
  });
  if (!response.ok) {
    throw new Error(`telemetry sink rejected the request (${response.status})`);
  }
}

export function validateTelemetryEndpoint(
  value: string,
  deployment: "dev" | "pilot" | "staging",
  expectedPath = "/",
): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "localhost";
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(deployment === "dev" && loopback))
  ) {
    throw new Error("telemetry endpoint is not allowlisted");
  }
  return url;
}

function attribute(value: OtlpAttribute): unknown {
  return typeof value.value === "number"
    ? integerAttribute(value.key, value.value)
    : stringAttribute(value.key, value.value);
}

function integerAttribute(key: string, value: number): unknown {
  return { key, value: { intValue: String(value) } };
}

function stringAttribute(key: string, value: string): unknown {
  return { key, value: { stringValue: value } };
}

function opaqueId(value: string, length: 16 | 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function unixNanoseconds(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("telemetry timestamp is invalid");
  }
  return (BigInt(milliseconds) * 1_000_000n).toString();
}
