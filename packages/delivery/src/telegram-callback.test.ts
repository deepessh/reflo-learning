import { describe, expect, it } from "vitest";

import type { DeliveryError } from "./errors.js";
import {
  decodeTelegramCallback,
  encodeTelegramCallback,
} from "./telegram-callback.js";

describe("Telegram callback references", () => {
  const reference = {
    answerIndex: 9,
    deliveryId: "30000000-0000-4000-8000-000000000043",
    deliveryItemId: "40000000-0000-4000-8000-000000000043",
  };

  it("round trips delivery-bound UUIDs within Telegram's byte limit", () => {
    const encoded = encodeTelegramCallback(reference);

    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(64);
    expect(decodeTelegramCallback(encoded)).toEqual(reference);
  });

  it.each([
    "",
    "reflo:not-base64:not-base64:0",
    "reflo:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:100",
    "reflo:AAAAAAAAAAAAAAAAAAAAA!:AAAAAAAAAAAAAAAAAAAAAA:0",
  ])("rejects malformed callback data: %s", (value) => {
    expect(() => decodeTelegramCallback(value)).toThrowError(
      expect.objectContaining<Partial<DeliveryError>>({
        code: "invalid_input",
      }),
    );
  });

  it("rejects non-canonical UUID inputs", () => {
    expect(() =>
      encodeTelegramCallback({ ...reference, deliveryId: "not-a-uuid" }),
    ).toThrowError(
      expect.objectContaining<Partial<DeliveryError>>({
        code: "invalid_input",
      }),
    );
  });
});
