import { describe, expect, it, vi } from "vitest";

import { HandlerDeadlineError } from "./bounded-handler";
import { runDevelopmentJob } from "./development-runner";

describe("jobs development runner", () => {
  it("stays idle when no bounded handler input is configured", async () => {
    const handler = vi.fn();

    await expect(
      runDevelopmentJob({ REFLO_ENV: "dev" }, { handler }),
    ).resolves.toEqual({ kind: "idle" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("consumes the configured envelope and delivery number", async () => {
    const handler = vi.fn().mockResolvedValue({ outcome: "processed" });

    await expect(
      runDevelopmentJob(
        {
          REFLO_JOBS_DEV_AUDIO_ENVELOPE: JSON.stringify({
            id: "synthetic-envelope",
          }),
          REFLO_JOBS_DEV_DELIVERY_NUMBER: "3",
          REFLO_JOBS_HANDLER_TIMEOUT_MS: "100",
        },
        { handler },
      ),
    ).resolves.toEqual({
      kind: "completed",
      result: { outcome: "processed" },
    });
    expect(handler).toHaveBeenCalledWith({ id: "synthetic-envelope" }, 3);
  });

  it("enforces the configured bounded handler deadline", async () => {
    await expect(
      runDevelopmentJob(
        {
          REFLO_JOBS_DEV_AUDIO_ENVELOPE: "{}",
          REFLO_JOBS_HANDLER_TIMEOUT_MS: "5",
        },
        { handler: () => new Promise(() => undefined) },
      ),
    ).rejects.toBeInstanceOf(HandlerDeadlineError);
  });
});
