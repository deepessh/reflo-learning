import { describe, expect, it, vi } from "vitest";

import type { RefloEventEnvelope } from "@reflo/db";

import { RocketMqPublishingError } from "./outbox-relay.js";
import {
  RocketMqDeadLetterConsumer,
  RocketMqPublisher,
} from "./rocketmq-adapter.js";

describe("RocketMQ 5.x adapter", () => {
  it("freezes one SDK attempt, private route inputs, and Reflo identity", async () => {
    let options: Readonly<Record<string, unknown>> | undefined;
    const send = vi.fn(async () => ({ messageId: "broker-id", offset: 0 }));
    const publisher = new RocketMqPublisher(configuration(), (candidate) => {
      options = candidate as unknown as Readonly<Record<string, unknown>>;
      return {
        send,
        shutdown: async () => undefined,
        startup: async () => undefined,
      };
    });

    await publisher.publish(envelope());

    expect(options).toMatchObject({
      endpoints: "rmq-private.internal:8080",
      maxAttempts: 1,
      namespace: "rmq-instance",
      requestTimeout: 3_000,
      topic: "reflo-jobs",
    });
    expect(options).not.toHaveProperty("sessionCredentials");
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.topic).toBe("reflo-jobs");
    expect(sent?.keys).toEqual([envelope().messageId]);
    expect(sent?.properties.get("reflo_message_id")).toBe(envelope().messageId);
    expect(JSON.parse(sent?.body.toString("utf8") ?? "{}")).toEqual(envelope());
  });

  it("rejects a non-acknowledgement receipt", async () => {
    const publisher = new RocketMqPublisher(configuration(), () => ({
      send: async () => ({ messageId: "", offset: -1 }),
      shutdown: async () => undefined,
      startup: async () => undefined,
    }));

    await expect(publisher.publish(envelope())).rejects.toEqual(
      new RocketMqPublishingError("invalid_receipt"),
    );
  });

  it("uses the dedicated bounded operator group without SDK redelivery", async () => {
    let options: Readonly<Record<string, unknown>> | undefined;
    const acknowledge = vi.fn(async () => undefined);
    const receive = vi.fn(async () => [
      {
        body: Buffer.from("safe-wrapper"),
        deliveryAttempt: 1,
      },
    ]);
    const consumer = new RocketMqDeadLetterConsumer(
      {
        ...configuration(),
        awaitDurationMs: 1_000,
        consumerGroup: "reflo-dev-audio-generate-v1-dlq-operator",
        invisibleDurationMs: 30_000,
        topic: "reflo-dev-audio-generate-v1-dlq",
      },
      (candidate) => {
        options = candidate as unknown as Readonly<Record<string, unknown>>;
        return {
          ack: acknowledge,
          receive,
          shutdown: async () => undefined,
          startup: async () => undefined,
        };
      },
    );

    const records = await consumer.receive(2);

    expect(options).toMatchObject({
      consumerGroup: "reflo-dev-audio-generate-v1-dlq-operator",
      endpoints: "rmq-private.internal:8080",
      maxRetryAttempts: 1,
      namespace: "rmq-instance",
      requestTimeout: 3_000,
    });
    expect(
      (options?.subscriptions as Map<string, string>).get(
        "reflo-dev-audio-generate-v1-dlq",
      ),
    ).toBe("*");
    expect(receive).toHaveBeenCalledWith(2, 30_000);
    await records[0]?.acknowledge();
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});

function configuration() {
  return {
    endpoints: "rmq-private.internal:8080",
    namespace: "rmq-instance",
    requestTimeoutMs: 3_000,
    topic: "reflo-jobs",
  };
}

function envelope(): RefloEventEnvelope {
  return {
    correlationId: "00000000-0000-4000-8000-000000000101",
    deadlineAt: "2026-07-30T21:00:00.000Z",
    environment: "dev",
    idempotencyKey:
      "dev/media.audio.generate/v1/00000000-0000-4000-8000-000000000201",
    messageId: "00000000-0000-4000-8000-000000000301",
    messageKind: "command",
    messageName: "media.audio.generate",
    messageVersion: 1,
    occurredAt: "2026-07-30T20:00:00.000Z",
    payload: {
      courseId: "00000000-0000-4000-8000-000000000401",
      operationId: "00000000-0000-4000-8000-000000000201",
      ownerScopeId: "00000000-0000-4000-8000-000000000501",
    },
    producer: "audio-generation",
  };
}
