import { describe, expect, it, vi } from "vitest";

import {
  FunctionComputeDeliveryError,
  createRocketMqFunctionComputeHandler,
  parseRocketMqEvent,
} from "./function-compute.js";

const envelope = {
  correlationId: "21111111-1111-4111-8111-111111111111",
  deadlineAt: "2026-07-29T00:00:00.000Z",
  environment: "dev",
  idempotencyKey:
    "dev/media.audio.generate/v1/21111111-1111-4111-8111-111111111112",
  messageId: "21111111-1111-4111-8111-111111111113",
  messageKind: "command",
  messageName: "media.audio.generate",
  messageVersion: 1,
  occurredAt: "2026-07-28T23:00:00.000Z",
  payload: {
    courseId: "21111111-1111-4111-8111-111111111114",
    operationId: "21111111-1111-4111-8111-111111111112",
    ownerScopeId: "21111111-1111-4111-8111-111111111115",
  },
  producer: "audio-generation",
};

describe("RocketMQ Function Compute transport", () => {
  it("unwraps one CloudEvent and maps the broker redelivery count", () => {
    expect(
      parseRocketMqEvent(
        JSON.stringify([
          {
            data: {
              body: JSON.stringify(envelope),
              systemProperties: { RECONSUME_TIMES: "2" },
              topic: "reflo-jobs",
            },
            specversion: "1.0",
            type: "mq:Topic:SendMessage",
          },
        ]),
        "reflo-jobs",
      ),
    ).toEqual({ deliveryNumber: 3, envelope });
  });

  it("accepts the documented direct RocketMQ batch shape", () => {
    expect(
      parseRocketMqEvent(
        Buffer.from(
          JSON.stringify([
            {
              body: envelope,
              systemProperties: {},
              topic: "reflo-jobs",
            },
          ]),
        ),
        "reflo-jobs",
      ),
    ).toEqual({ deliveryNumber: 1, envelope });
  });

  it.each([
    "[]",
    JSON.stringify([{}, {}]),
    JSON.stringify([{ data: { body: "{}", topic: "other" } }]),
    JSON.stringify([
      {
        data: {
          body: "{}",
          systemProperties: { RECONSUME_TIMES: "5" },
          topic: "reflo-jobs",
        },
      },
    ]),
  ])("rejects malformed or out-of-budget events", (event) => {
    expect(() => parseRocketMqEvent(event, "reflo-jobs")).toThrow(
      "RocketMQ trigger event is invalid",
    );
  });

  it("acknowledges terminal success and closes invocation resources", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const domainHandler = vi.fn().mockResolvedValue({
      kind: "ack",
      status: "succeeded",
    });
    const handler = createRocketMqFunctionComputeHandler({
      createHandler: async () => ({ close, handler: domainHandler }),
      timeoutMs: 1_000,
      topic: "reflo-jobs",
    });

    await expect(
      handler(
        JSON.stringify([
          {
            data: {
              body: JSON.stringify(envelope),
              systemProperties: {},
              topic: "reflo-jobs",
            },
          },
        ]),
        {},
      ),
    ).resolves.toEqual({
      outcome: "acknowledged",
      status: "succeeded",
    });
    expect(domainHandler).toHaveBeenCalledWith(envelope, 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails the invocation for broker retry or dead-letter routing", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const handler = createRocketMqFunctionComputeHandler({
      createHandler: async () => ({
        close,
        handler: async () => ({
          delayMs: 2_000,
          kind: "retry",
          status: "retry_scheduled",
        }),
      }),
      timeoutMs: 1_000,
      topic: "reflo-jobs",
    });

    await expect(
      handler(
        JSON.stringify([
          {
            data: {
              body: envelope,
              systemProperties: {},
              topic: "reflo-jobs",
            },
          },
        ]),
        {},
      ),
    ).rejects.toBeInstanceOf(FunctionComputeDeliveryError);
    expect(close).toHaveBeenCalledOnce();
  });
});
