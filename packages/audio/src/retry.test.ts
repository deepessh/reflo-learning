import { describe, expect, it } from "vitest";

import { audioRetryDelayMs, canScheduleAudioRetry } from "./retry.js";

describe("audio outer retry policy", () => {
  it("uses deterministic bounded exponential backoff with jitter", () => {
    const operationId = "00000000-0000-4000-8000-000000000301";
    const delays = [1, 2, 3, 4].map((attempt) =>
      audioRetryDelayMs(operationId, attempt),
    );

    expect(delays).toEqual(
      [1, 2, 3, 4].map((attempt) => audioRetryDelayMs(operationId, attempt)),
    );
    expect(delays[0]).toBeGreaterThanOrEqual(1_500);
    expect(delays[3]).toBeLessThanOrEqual(20_000);
    expect(delays).toEqual([...delays].sort((left, right) => left - right));
  });

  it("never schedules a delivery at or beyond the absolute deadline", () => {
    const now = new Date("2026-07-21T17:00:00.000Z");
    const operationId = "00000000-0000-4000-8000-000000000301";
    const delayMs = audioRetryDelayMs(operationId, 1);

    expect(
      canScheduleAudioRetry({
        deadlineAt: new Date(now.getTime() + delayMs),
        deliveryNumber: 1,
        now,
        operationId,
      }),
    ).toBe(false);
  });
});
