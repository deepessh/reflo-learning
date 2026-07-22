import { describe, expect, it, vi } from "vitest";

import type { AudioGenerationEnvelope, AudioOperationView } from "@reflo/audio";

import { createAudioQueueHandler } from "./audio-worker.js";

const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  scope: "00000000-0000-4000-8000-000000000101",
  course: "00000000-0000-4000-8000-000000000201",
  operation: "00000000-0000-4000-8000-000000000301",
  message: "00000000-0000-4000-8000-000000000401",
  correlation: "00000000-0000-4000-8000-000000000501",
} as const;

describe("RocketMQ audio command handler", () => {
  it("reauthorizes opaque work before invoking audio generation", async () => {
    const consume = vi.fn(async () => operation("succeeded"));
    const resolve = vi.fn(async () => ({
      actorId: ids.actor,
      authorizationId: "authorization-current",
      ownerScopeId: ids.scope,
    }));
    const handle = createAudioQueueHandler({
      authorization: { resolve },
      consumer: { consume },
    });

    await expect(handle(envelope(), 1)).resolves.toEqual({
      kind: "ack",
      status: "succeeded",
    });
    expect(resolve).toHaveBeenCalledWith({
      courseId: ids.course,
      operationId: ids.operation,
    });
    expect(consume).toHaveBeenCalledOnce();
  });

  it("dead-letters unknown contracts before domain logic", async () => {
    const consume = vi.fn();
    const resolve = vi.fn();
    const handle = createAudioQueueHandler({
      authorization: { resolve },
      consumer: { consume },
    });

    await expect(handle({ messageName: "unknown" }, 1)).resolves.toEqual({
      failureClass: "unsupported_contract",
      kind: "dead_letter",
      status: "rejected",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("maps bounded retry and permanent failure to broker dispositions", async () => {
    for (const [status, expected] of [
      [
        "retry_scheduled",
        {
          delayMs: expect.any(Number),
          kind: "retry",
          status: "retry_scheduled",
        },
      ],
      [
        "failed_permanent",
        {
          failureClass: "provider_failure",
          kind: "dead_letter",
          status: "failed_permanent",
        },
      ],
    ] as const) {
      const handle = createAudioQueueHandler({
        authorization: {
          resolve: async () => ({
            actorId: ids.actor,
            authorizationId: "authorization-current",
            ownerScopeId: ids.scope,
          }),
        },
        consumer: { consume: async () => operation(status) },
      });
      await expect(handle(envelope(), 1)).resolves.toEqual(expected);
    }
  });
});

function envelope(): AudioGenerationEnvelope {
  return {
    correlationId: ids.correlation,
    deadlineAt: "2026-07-21T17:10:00.000Z",
    environment: "dev",
    idempotencyKey: `dev/media.audio.generate/v1/${ids.operation}`,
    messageId: ids.message,
    messageKind: "command",
    messageName: "media.audio.generate",
    messageVersion: 1,
    occurredAt: "2026-07-21T17:00:00.000Z",
    payload: {
      courseId: ids.course,
      operationId: ids.operation,
      ownerScopeId: ids.scope,
    },
    producer: "audio-generation",
  };
}

function operation(status: AudioOperationView["status"]): AudioOperationView {
  return {
    assetId: status === "succeeded" ? "asset-0001" : null,
    attemptCount: 1,
    chapterId: "chapter-0001",
    deadlineAt: new Date("2026-07-21T17:10:00.000Z"),
    failureClass: status === "failed_permanent" ? "provider_failure" : null,
    generationVersion: "audio-generation-v1",
    id: ids.operation,
    idempotencyKey: `dev/media.audio.generate/v1/${ids.operation}`,
    narrationScriptId: "narration-0001",
    priority: 1,
    status,
    updatedAt: new Date("2026-07-21T17:01:00.000Z"),
  };
}
