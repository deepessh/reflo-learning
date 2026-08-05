import { describe, expect, it } from "vitest";

import {
  deliveryProviderLabel,
  parseDeliveryPreference,
} from "./delivery-preferences-view";

describe("delivery preference presentation", () => {
  it("accepts a provider only when the account reports it as available", () => {
    expect(
      parseDeliveryPreference({
        availableProviders: ["email"],
        chosenLocalTime: "08:30",
        provider: "email",
        timeZone: "America/Los_Angeles",
      }),
    ).toMatchObject({ provider: "email" });
    expect(
      parseDeliveryPreference({
        availableProviders: ["email"],
        chosenLocalTime: "08:30",
        provider: "telegram",
        timeZone: "America/Los_Angeles",
      }),
    ).toBeNull();
  });

  it("rejects malformed local schedule values", () => {
    expect(
      parseDeliveryPreference({
        availableProviders: ["telegram"],
        chosenLocalTime: "25:00",
        provider: "telegram",
        timeZone: "",
      }),
    ).toBeNull();
    expect(deliveryProviderLabel("telegram")).toBe("Telegram");
  });
});
