#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  FLOW_B_ALLOWED_TRACE_FIELDS,
  FLOW_B_CORE_TRACE_FIELDS,
  type FlowBTraceField,
} from "./contracts.js";

const HOST = "127.0.0.1";
const PORT = readPort(process.env.REFLO_FLOW_B_MODEL_FIXTURE_PORT ?? "4000");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TRACE_SCHEMA_VERSION = "demo-operational-trace-v1";
const OTLP_TRACE_KEYS = new Map(
  FLOW_B_ALLOWED_TRACE_FIELDS.map((field) => [
    `reflo_${field.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`)}`,
    field,
  ]),
);
const ALLOWED_OPERATIONAL_KEYS = new Set([...OTLP_TRACE_KEYS.keys()]);

let operationalEventCount = 0;
const observedFields = new Set<FlowBTraceField>();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      sendJson(response, 200, {
        data: [{ id: "reflo-local-text", object: "model" }],
        object: "list",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/__reflo/traces/") {
      const complete = FLOW_B_CORE_TRACE_FIELDS.every((field) =>
        observedFields.has(field),
      );
      sendJson(response, complete ? 200 : 503, {
        allowlistValidated: complete,
        coreFieldCoverage: complete ? FLOW_B_CORE_TRACE_FIELDS : [],
        eventCount: operationalEventCount,
        observedFieldSet: FLOW_B_ALLOWED_TRACE_FIELDS.filter((field) =>
          observedFields.has(field),
        ),
        schemaVersion: TRACE_SCHEMA_VERSION,
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/opentelemetry/v1/traces"
    ) {
      const body = await readJson(request);
      recordOperationalTraces(body);
      sendJson(response, 200, {});
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/public/otel/v1/traces"
    ) {
      await readJson(request);
      sendJson(response, 200, {});
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/embeddings") {
      const body = asRecord(await readJson(request));
      const input = body.input;
      if (
        !Array.isArray(input) ||
        input.length < 1 ||
        input.some((entry) => typeof entry !== "string")
      ) {
        sendJson(response, 400, { error: "invalid_embedding_input" });
        return;
      }
      sendJson(response, 200, {
        data: input.map((_, index) => ({
          embedding: basisVector(index),
          index,
          object: "embedding",
        })),
        id: requestId("embedding", body),
        model: String(body.model),
        object: "list",
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = asRecord(await readJson(request));
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length !== 2) {
        sendJson(response, 400, { error: "invalid_messages" });
        return;
      }
      const system = parseMessage(messages[0]);
      const user = parseMessage(messages[1]);
      const task = String(system.task);
      const value =
        task === "assessment.grade-short-answer.v1"
          ? grade(user)
          : task === "lesson.reteach.v1"
            ? reteach(user)
            : null;
      if (value === null) {
        sendJson(response, 400, { error: "unsupported_fixture_task" });
        return;
      }
      sendJson(response, 200, {
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: JSON.stringify(value),
              role: "assistant",
            },
          },
        ],
        id: requestId("chat", body),
        model: String(body.model),
        object: "chat.completion",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
      });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  } catch {
    sendJson(response, 400, { error: "invalid_fixture_request" });
  }
});

server.listen(PORT, HOST, () => {
  console.info(
    `Reflo deterministic model fixture listening on ${HOST}:${PORT}`,
  );
});

function grade(user: Record<string, unknown>): Record<string, unknown> {
  const typedInput = asRecord(user.typedInput);
  const rubrics = typedInput.rubrics;
  if (!Array.isArray(rubrics) || rubrics.length < 1) {
    throw new Error("grading rubrics are unavailable");
  }
  const answer = String(user.learnerAnswer ?? "").toLowerCase();
  const correct =
    answer.includes("isolated") &&
    (answer.includes("network") || answer.includes("retention"));
  return {
    judgments: rubrics.map((rubric) => ({
      conceptId: String(asRecord(rubric).conceptId),
      confidence: 0.99,
      judgmentKind: "scored",
      rubricBand: correct ? "correct" : "incorrect",
      score: correct ? 1 : 0,
    })),
  };
}

function reteach(user: Record<string, unknown>): Record<string, unknown> {
  const sourceMaterial = user.sourceMaterial;
  if (!Array.isArray(sourceMaterial) || sourceMaterial.length < 1) {
    throw new Error("authorized source material is unavailable");
  }
  return {
    content: [
      "Picture each memory as a labeled card in a study queue.",
      "A card grows stronger only after a learner answers a fresh check;",
      "opening an explanation changes what is visible, but it does not count",
      "as evidence. The next distinct check supplies the evidence that can",
      "move the remembered state.",
    ].join(" "),
    sourceSpanIds: sourceMaterial.map((span) => String(asRecord(span).id)),
    strategyTag: "queue-card-analogy-v1",
  };
}

function recordOperationalTraces(value: unknown): void {
  const body = asRecord(value);
  const resources = body.resourceSpans;
  if (!Array.isArray(resources)) {
    throw new Error("operational trace payload is malformed");
  }
  for (const resource of resources) {
    const scopes = asRecord(resource).scopeSpans;
    if (!Array.isArray(scopes)) {
      throw new Error("operational trace scopes are malformed");
    }
    for (const scope of scopes) {
      const spans = asRecord(scope).spans;
      if (!Array.isArray(spans)) {
        throw new Error("operational trace spans are malformed");
      }
      for (const span of spans) {
        const attributes = asRecord(span).attributes;
        if (!Array.isArray(attributes)) {
          throw new Error("operational trace attributes are malformed");
        }
        const keys = attributes.map((attribute) =>
          String(asRecord(attribute).key),
        );
        if (
          keys.some((key) => !ALLOWED_OPERATIONAL_KEYS.has(key)) ||
          !keys.includes("reflo_schema_version")
        ) {
          throw new Error("operational trace escaped its safe allowlist");
        }
        for (const key of keys) {
          const field = OTLP_TRACE_KEYS.get(key);
          if (field !== undefined) {
            observedFields.add(field);
          }
        }
        operationalEventCount += 1;
      }
    }
  }
}

function basisVector(index: number): number[] {
  const vector = Array.from({ length: 1_024 }, () => 0);
  vector[index % 2] = 1;
  return vector;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error("fixture request is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseMessage(value: unknown): Record<string, unknown> {
  const message = asRecord(value);
  if (typeof message.content !== "string") {
    throw new Error("fixture message is malformed");
  }
  return asRecord(JSON.parse(message.content));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fixture value is malformed");
  }
  return value as Record<string, unknown>;
}

function requestId(kind: string, body: Record<string, unknown>): string {
  return `fixture-${kind}-${createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex")
    .slice(0, 24)}`;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: object,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function shutdown(): void {
  server.close(() => process.exit());
}

function readPort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("REFLO_FLOW_B_MODEL_FIXTURE_PORT is invalid");
  }
  return port;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
