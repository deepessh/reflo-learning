import { describe, expect, it, vi } from "vitest";

import type { RefloEventEnvelope } from "@reflo/db";

import { OutboxRelay, RocketMqPublishingError } from "./outbox-relay.js";

describe("outbox relay", () => {
  it("publishes validated claims and marks only broker acknowledgements", async () => {
    const messages = [envelope("1"), envelope("2")];
    const repository = {
      claimOutbox: vi.fn(async () => messages),
      markOutboxPublished: vi.fn(async () => true),
      releaseOutbox: vi.fn(async () => true),
    };
    const publisher = {
      publish: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      startup: vi.fn(async () => undefined),
    };
    const relay = new OutboxRelay({
      batchSize: 2,
      clock: { now: () => new Date("2026-07-30T20:00:00.000Z") },
      publisher,
      repository,
      validate: (input) => input as RefloEventEnvelope,
    });

    await expect(relay.runOnce()).resolves.toEqual({
      ambiguous: 0,
      claimed: 2,
      failureClasses: {},
      published: 2,
      released: 0,
    });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(repository.markOutboxPublished).toHaveBeenCalledTimes(2);
    expect(repository.releaseOutbox).not.toHaveBeenCalled();
  });

  it("releases a failed publication without marking it published", async () => {
    const repository = {
      claimOutbox: vi.fn(async () => [envelope("1")]),
      markOutboxPublished: vi.fn(async () => true),
      releaseOutbox: vi.fn(async () => true),
    };
    const relay = new OutboxRelay({
      batchSize: 1,
      publisher: {
        publish: async () => {
          throw new RocketMqPublishingError("publication_timeout");
        },
        shutdown: async () => undefined,
        startup: async () => undefined,
      },
      repository,
      validate: (input) => input as RefloEventEnvelope,
    });

    await expect(relay.runOnce()).resolves.toEqual({
      ambiguous: 1,
      claimed: 1,
      failureClasses: { publication_timeout: 1 },
      published: 0,
      released: 1,
    });
    expect(repository.releaseOutbox).toHaveBeenCalledWith(
      envelope("1").messageId,
      "publication_timeout",
    );
    expect(repository.markOutboxPublished).not.toHaveBeenCalled();
  });

  it("fails closed before publication when a claimed envelope is invalid", async () => {
    const publish = vi.fn();
    const relay = new OutboxRelay({
      batchSize: 1,
      publisher: {
        publish,
        shutdown: async () => undefined,
        startup: async () => undefined,
      },
      repository: {
        claimOutbox: async () => [envelope("1")],
        markOutboxPublished: async () => true,
        releaseOutbox: async () => true,
      },
      validate: () => {
        throw new Error("invalid envelope");
      },
    });

    await expect(relay.runOnce()).rejects.toThrow("invalid envelope");
    expect(publish).not.toHaveBeenCalled();
  });
});

function envelope(suffix: string): RefloEventEnvelope {
  return {
    correlationId: `00000000-0000-4000-8000-00000000010${suffix}`,
    deadlineAt: "2026-07-30T21:00:00.000Z",
    environment: "dev",
    idempotencyKey: `dev/media.audio.generate/v1/00000000-0000-4000-8000-00000000020${suffix}`,
    messageId: `00000000-0000-4000-8000-00000000030${suffix}`,
    messageKind: "command",
    messageName: "media.audio.generate",
    messageVersion: 1,
    occurredAt: "2026-07-30T20:00:00.000Z",
    payload: {
      courseId: "00000000-0000-4000-8000-000000000401",
      operationId: `00000000-0000-4000-8000-00000000020${suffix}`,
      ownerScopeId: "00000000-0000-4000-8000-000000000501",
    },
    producer: "audio-generation",
  };
}
