import { describe, expect, it, vi } from "vitest";

import { DeliveryError } from "../errors.js";
import { TelegramLongPollingReceiver } from "./telegram-polling.js";

const token = `123:${"a".repeat(32)}`;

describe("Telegram long polling receiver", () => {
  it("requests only callback updates and advances the offset after handling", async () => {
    const handleUpdate = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(
      telegramResponse([
        { callback_query: { id: "first" }, update_id: 40 },
        { callback_query: { id: "second" }, update_id: 41 },
      ]),
    );
    const receiver = configuredReceiver(fetch, handleUpdate);

    await expect(
      receiver.pollOnce(undefined, new AbortController().signal),
    ).resolves.toBe(42);
    expect(handleUpdate).toHaveBeenCalledTimes(2);
    expect(JSON.parse(handleUpdate.mock.calls[0]![0])).toMatchObject({
      update_id: 40,
    });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      allowed_updates: ["callback_query"],
      timeout: 0,
    });
  });

  it("consumes malformed callbacks but retries transient handler failures", async () => {
    const update = { callback_query: { id: "retry" }, update_id: 50 };
    const fetch = vi
      .fn()
      .mockImplementation(async () => telegramResponse([update]));
    const ignored = configuredReceiver(
      fetch,
      vi.fn().mockRejectedValue(new DeliveryError("invalid_input")),
    );
    await expect(
      ignored.pollOnce(50, new AbortController().signal),
    ).resolves.toBe(51);

    const transient = configuredReceiver(
      fetch,
      vi.fn().mockRejectedValue(new Error("database unavailable")),
    );
    await expect(
      transient.pollOnce(50, new AbortController().signal),
    ).rejects.toThrow("database unavailable");
  });

  it("fails closed for provider errors and stops an in-flight poll", async () => {
    const rejected = configuredReceiver(
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false }), { status: 409 }),
        ),
      vi.fn(),
    );
    await expect(
      rejected.pollOnce(undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    let observedSignal: AbortSignal | undefined;
    const blockingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const receiver = configuredReceiver(blockingFetch, vi.fn());
    receiver.start();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await expect(receiver.close()).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });
});

function configuredReceiver(
  fetch: typeof globalThis.fetch,
  handleUpdate: (rawUpdate: string) => Promise<void>,
) {
  return new TelegramLongPollingReceiver({
    botToken: token,
    fetch,
    handleUpdate,
    longPollSeconds: 0,
    retryDelayMs: 1,
  });
}

function telegramResponse(updates: readonly Record<string, unknown>[]) {
  return new Response(JSON.stringify({ ok: true, result: updates }), {
    status: 200,
  });
}
