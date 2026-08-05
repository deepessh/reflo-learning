import type { GenerationOperationView } from "@reflo/activation";
import { describe, expect, it, vi } from "vitest";

import { ActivationPackageProcessingQueue } from "./activation-package-processing.js";

const request = Object.freeze({
  authorization: {
    actorId: "55100000-0000-4000-8000-000000000001",
    authorizationId: "activation-package-test",
    ownerScopeId: "55100000-0000-4000-8000-000000000002",
  },
  courseId: "55100000-0000-4000-8000-000000000003",
});

describe("activation package processing queue", () => {
  it("plans once and runs every operation in activation priority order", async () => {
    const operations = [operation(3), operation(1), operation(2)];
    const generation = {
      plan: vi.fn(async () => operations),
      run: vi.fn(async (command: { readonly operationId: string }) => ({
        ...operations.find(
          (candidate) => candidate.id === command.operationId,
        )!,
        attemptCount: 1,
        status: "succeeded" as const,
      })),
    };
    const queue = new ActivationPackageProcessingQueue({ generation });

    queue.schedule(request);
    queue.schedule(request);
    await queue.close();

    expect(generation.plan).toHaveBeenCalledTimes(1);
    expect(generation.plan).toHaveBeenCalledWith({
      authorization: request.authorization,
      courseId: request.courseId,
      environment: "dev",
    });
    expect(
      generation.run.mock.calls.map(([command]) => command.operationId),
    ).toEqual([operation(1).id, operation(2).id, operation(3).id]);
  });

  it("redelivers retryable operations within the repository attempt budget", async () => {
    const queued = operation(1);
    const delay = vi.fn(async () => undefined);
    const generation = {
      plan: vi.fn(async () => [queued]),
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ...queued,
          attemptCount: 1,
          retryable: true,
          status: "retry_scheduled",
        })
        .mockResolvedValueOnce({
          ...queued,
          attemptCount: 2,
          status: "succeeded",
        }),
    };
    const queue = new ActivationPackageProcessingQueue({
      delay,
      generation,
      retryDelaysMs: [7, 8, 9, 10],
    });

    queue.schedule(request);
    await queue.close();

    expect(generation.run).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(7);
  });

  it("replays completed plans without rerunning model-backed work", async () => {
    const succeeded = {
      ...operation(1),
      artifactId: "55100000-0000-4000-8000-000000000099",
      attemptCount: 1,
      status: "succeeded" as const,
    };
    const generation = {
      plan: vi.fn(async () => [succeeded]),
      run: vi.fn(),
    };
    const queue = new ActivationPackageProcessingQueue({ generation });

    queue.schedule(request);
    await queue.close();

    expect(generation.run).not.toHaveBeenCalled();
  });

  it("runs one exact regenerated lesson operation for duplicate schedules", async () => {
    const regenerated = { ...operation(1), regenerationOrdinal: 1 };
    const generation = {
      plan: vi.fn(),
      run: vi.fn(async () => ({
        ...regenerated,
        attemptCount: 1,
        status: "succeeded" as const,
      })),
    };
    const queue = new ActivationPackageProcessingQueue({ generation });

    queue.scheduleRegeneration(request, regenerated);
    queue.scheduleRegeneration(request, regenerated);
    await queue.close();

    expect(generation.plan).not.toHaveBeenCalled();
    expect(generation.run).toHaveBeenCalledTimes(1);
    expect(generation.run).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: regenerated.id }),
    );
  });
});

function operation(priority: 1 | 2 | 3): GenerationOperationView {
  const artifactKind =
    priority === 1
      ? "first_text_lesson"
      : priority === 2
        ? "placement_quiz"
        : "chapter_quiz";
  return {
    artifactId: null,
    artifactKind,
    attemptCount: 0,
    chapterId:
      artifactKind === "placement_quiz"
        ? null
        : "55100000-0000-4000-8000-000000000010",
    conceptId:
      artifactKind === "first_text_lesson"
        ? "55100000-0000-4000-8000-000000000011"
        : null,
    failureClass: null,
    generationVersion: "activation-generation-v1",
    id: `55100000-0000-4000-8000-00000000000${priority}`,
    idempotencyKey: `activation-package-test/${priority}`,
    priority,
    regenerationOrdinal: 0,
    retryable: false,
    status: "queued",
    updatedAt: new Date("2026-07-31T12:00:00.000Z"),
  };
}
