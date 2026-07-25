import { describe, expect, it, vi } from "vitest";

import {
  HandlerDeadlineError,
  executeBoundedHandler,
} from "./bounded-handler.js";

describe("bounded development handler", () => {
  it("returns a completed handler result", async () => {
    await expect(
      executeBoundedHandler(async () => ({ kind: "ack" }), 100),
    ).resolves.toEqual({ kind: "ack" });
  });

  it("fails closed when the handler exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const result = executeBoundedHandler(
        () => new Promise<never>(() => undefined),
        25,
      );
      const rejection =
        expect(result).rejects.toBeInstanceOf(HandlerDeadlineError);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unbounded timeout configuration", async () => {
    await expect(
      executeBoundedHandler(async () => undefined, 120_001),
    ).rejects.toThrow("timeout is invalid");
  });
});
