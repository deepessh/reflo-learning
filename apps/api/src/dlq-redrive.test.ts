import { describe, expect, it, vi } from "vitest";

import type { RefloEventEnvelope } from "@reflo/db";

import {
  RocketMqDlqRedrive,
  validateRocketMqDlqWrapper,
} from "./dlq-redrive.js";

const request = {
  batchSize: 1,
  reasonCode: "provider_recovered" as const,
  requestKey: "00000000-0000-4000-8000-000000000601",
};
const sourceInstance = "rmq-instance";

describe("RocketMQ EventBridge DLQ redrive", () => {
  it("extracts only the closed validated Reflo envelope", () => {
    expect(
      validateRocketMqDlqWrapper(wrapper(), "reflo-jobs", sourceInstance),
    ).toEqual(envelope());
  });

  it.each([
    () => wrapper({ topic: "other" }),
    () => wrapper({ environment: "staging" }),
    () => wrapper({ userProperties: { unexpected: "value" } }),
    () => wrapper({ systemProperties: { PRIVATE_ENDPOINT: "forbidden" } }),
  ])("rejects malformed, cross-environment, or disallowed data", (fixture) => {
    expect(() =>
      validateRocketMqDlqWrapper(fixture(), "reflo-jobs", sourceInstance),
    ).toThrow("RocketMQ dead-letter wrapper is invalid");
  });

  it("publishes the unchanged canonical envelope before audit and ack", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const markRedrivePublished = vi.fn(async () => true);
    const repository = repositoryFixture({ markRedrivePublished });
    const redrive = new RocketMqDlqRedrive({
      consumer: {
        receive: async () => [
          { acknowledge, body: wrapper(), deliveryNumber: 1 },
        ],
      },
      publisher: {
        publish,
        shutdown: async () => undefined,
        startup: async () => undefined,
      },
      repository,
      sourceInstance,
      sourceTopic: "reflo-jobs",
    });

    await expect(redrive.run(request)).resolves.toEqual({
      ambiguousPublications: 0,
      blocked: 0,
      published: 1,
      received: 1,
      rejected: 0,
      retryGuard: 0,
      validatorRejections: 0,
    });
    expect(publish).toHaveBeenCalledWith(envelope());
    expect(markRedrivePublished).toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(markRedrivePublished.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledge.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not acknowledge an ambiguous publication or exhausted operator guard", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const releaseRedrive = vi.fn(async () => true);
    const redrive = new RocketMqDlqRedrive({
      consumer: {
        receive: async () => [
          { acknowledge, body: wrapper(), deliveryNumber: 1 },
          { acknowledge, body: wrapper(), deliveryNumber: 2 },
        ],
      },
      publisher: {
        publish: async () => {
          throw new Error("ambiguous");
        },
        shutdown: async () => undefined,
        startup: async () => undefined,
      },
      repository: repositoryFixture({ releaseRedrive }),
      sourceInstance,
      sourceTopic: "reflo-jobs",
    });

    await expect(redrive.run({ ...request, batchSize: 2 })).resolves.toEqual({
      ambiguousPublications: 1,
      blocked: 2,
      published: 0,
      received: 2,
      rejected: 0,
      retryGuard: 1,
      validatorRejections: 0,
    });
    expect(releaseRedrive).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: "broker_unavailable" }),
    );
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges a permanent wrapper rejection without exposing provider data", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const repository = repositoryFixture();
    const redrive = new RocketMqDlqRedrive({
      consumer: {
        receive: async () => [
          {
            acknowledge,
            body: Buffer.from('{"private":"diagnostic"}'),
            deliveryNumber: 1,
          },
        ],
      },
      publisher: {
        publish: async () => undefined,
        shutdown: async () => undefined,
        startup: async () => undefined,
      },
      repository,
      sourceInstance,
      sourceTopic: "reflo-jobs",
    });

    await expect(redrive.run(request)).resolves.toEqual({
      ambiguousPublications: 0,
      blocked: 0,
      published: 0,
      received: 1,
      rejected: 1,
      retryGuard: 0,
      validatorRejections: 1,
    });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(repository.claimRedrive).not.toHaveBeenCalled();
  });
});

function repositoryFixture(
  overrides: Partial<{
    markRedrivePublished: ReturnType<typeof vi.fn>;
    releaseRedrive: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    claimRedrive: vi.fn(async () => ({
      envelope: envelope(),
      kind: "claimed" as const,
    })),
    inspectRedrive: vi.fn(async () => ({
      envelope: envelope(),
      operationState: "failed_permanent",
      rejectionClass: null,
    })),
    markRedrivePublished:
      overrides.markRedrivePublished ?? vi.fn(async () => true),
    rejectRedrive: vi.fn(async () => true),
    releaseRedrive: overrides.releaseRedrive ?? vi.fn(async () => true),
  };
}

function wrapper(
  overrides: {
    readonly environment?: string;
    readonly systemProperties?: Readonly<Record<string, unknown>>;
    readonly topic?: string;
    readonly userProperties?: Readonly<Record<string, unknown>>;
  } = {},
): Buffer {
  return Buffer.from(
    JSON.stringify([
      {
        data: {
          body: JSON.stringify({
            ...envelope(),
            environment: overrides.environment ?? "dev",
          }),
          systemProperties: overrides.systemProperties ?? {
            INSTANCE_ID: sourceInstance,
            RECONSUME_TIMES: "3",
          },
          topic: overrides.topic ?? "reflo-jobs",
          userProperties: overrides.userProperties ?? {
            reflo_message_id: envelope().messageId,
          },
        },
        datacontenttype: "application/json; charset=utf-8",
        id: "event-id",
        source: "RocketMQSource",
        specversion: "1.0",
        subject: `acs:mq:ap-southeast-1:staff-account:${sourceInstance}%reflo-jobs`,
        time: "2026-07-30T20:01:00.000Z",
        type: "mq:Topic:SendMessage",
      },
    ]),
  );
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
