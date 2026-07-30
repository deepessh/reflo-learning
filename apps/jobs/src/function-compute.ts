import { AUDIO_MAX_DELIVERIES } from "@reflo/audio";

import type {
  AudioDeliveryDisposition,
  createAudioQueueHandler,
} from "./audio-worker.js";
import { executeBoundedHandler } from "./bounded-handler.js";

const MAX_TRIGGER_BYTES = 32 * 1024;
const ROCKETMQ_EVENT_TYPE = "mq:Topic:SendMessage";

type AudioQueueHandler = ReturnType<typeof createAudioQueueHandler>;

export interface FunctionComputeContext {
  readonly credentials?: {
    readonly accessKeyId?: string;
    readonly accessKeySecret?: string;
    readonly securityToken?: string;
  };
  readonly requestId?: string;
}

export class FunctionComputeDeliveryError extends Error {
  constructor(
    readonly disposition: Exclude<AudioDeliveryDisposition, { kind: "ack" }>,
  ) {
    super(`audio delivery requires ${disposition.kind}`);
    this.name = "FunctionComputeDeliveryError";
  }
}

export function createRocketMqFunctionComputeHandler(input: {
  readonly createHandler: (context: FunctionComputeContext) => Promise<{
    readonly close?: () => Promise<void>;
    readonly handler: AudioQueueHandler;
  }>;
  readonly timeoutMs: number;
  readonly topic: string;
}) {
  assertConfiguration(input.timeoutMs, input.topic);
  return async function handleRocketMqEvent(
    event: Buffer | Uint8Array | string,
    context: FunctionComputeContext,
  ): Promise<{
    readonly outcome: "acknowledged";
    readonly status: "cancelled" | "expired" | "succeeded";
  }> {
    const message = parseRocketMqEvent(event, input.topic);
    const runtime = await input.createHandler(context);
    try {
      const disposition = await executeBoundedHandler(
        () => runtime.handler(message.envelope, message.deliveryNumber),
        input.timeoutMs,
      );
      if (disposition.kind !== "ack") {
        throw new FunctionComputeDeliveryError(disposition);
      }
      return {
        outcome: "acknowledged",
        status: disposition.status,
      };
    } finally {
      await runtime.close?.();
    }
  };
}

export function parseRocketMqEvent(
  event: Buffer | Uint8Array | string,
  expectedTopic: string,
): {
  readonly deliveryNumber: number;
  readonly envelope: unknown;
} {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(expectedTopic)) {
    throw invalidEvent();
  }
  const bytes =
    typeof event === "string" ? Buffer.from(event, "utf8") : Buffer.from(event);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_TRIGGER_BYTES) {
    throw invalidEvent();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw invalidEvent();
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    throw invalidEvent();
  }
  const cloudEvent = object(decoded[0]);
  if (
    cloudEvent === null ||
    (cloudEvent.specversion !== undefined &&
      cloudEvent.specversion !== "1.0") ||
    (cloudEvent.type !== undefined && cloudEvent.type !== ROCKETMQ_EVENT_TYPE)
  ) {
    throw invalidEvent();
  }
  const data = object(cloudEvent.data ?? cloudEvent);
  if (data === null || data.topic !== expectedTopic) {
    throw invalidEvent();
  }
  const systemProperties = object(data.systemProperties);
  const redeliveryCount = integerProperty(
    systemProperties,
    "RECONSUME_TIMES",
    0,
  );
  const deliveryNumber = redeliveryCount + 1;
  if (deliveryNumber < 1 || deliveryNumber > AUDIO_MAX_DELIVERIES) {
    throw invalidEvent();
  }
  const body = data.body;
  if (typeof body === "string") {
    if (
      Buffer.byteLength(body, "utf8") < 2 ||
      Buffer.byteLength(body, "utf8") > 16_384
    ) {
      throw invalidEvent();
    }
    try {
      return {
        deliveryNumber,
        envelope: JSON.parse(body) as unknown,
      };
    } catch {
      throw invalidEvent();
    }
  }
  if (object(body) === null) {
    throw invalidEvent();
  }
  return { deliveryNumber, envelope: body };
}

function assertConfiguration(timeoutMs: number, topic: string): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000 ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(topic)
  ) {
    throw new Error("Function Compute jobs configuration is invalid");
  }
}

function integerProperty(
  value: Readonly<Record<string, unknown>> | null,
  name: string,
  fallback: number,
): number {
  const raw = value?.[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^[0-9]+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidEvent();
  }
  return parsed;
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function invalidEvent(): Error {
  return new Error("RocketMQ trigger event is invalid");
}
