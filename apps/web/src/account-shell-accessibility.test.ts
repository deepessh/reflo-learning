import { describe, expect, it } from "vitest";

import {
  accountConnectionStatus,
  isLinkActivationKey,
  retryPresentation,
} from "./account-shell-accessibility";

describe("account shell accessibility presentation", () => {
  it("supports Enter, Space, and the legacy Space key name for links", () => {
    expect(isLinkActivationKey("Enter")).toBe(true);
    expect(isLinkActivationKey(" ")).toBe(true);
    expect(isLinkActivationKey("Spacebar")).toBe(true);
    expect(isLinkActivationKey("Tab")).toBe(false);
    expect(isLinkActivationKey("Escape")).toBe(false);
  });

  it("disables retry and exposes visible progress while pending", () => {
    expect(retryPresentation("pending")).toEqual({
      ariaBusy: true,
      buttonDisabled: true,
      buttonLabel: "Trying again…",
      visibleStatus: "Checking your connection…",
    });
  });

  it("returns a failed retry to an actionable, honest error state", () => {
    expect(retryPresentation("failed")).toEqual({
      ariaBusy: false,
      buttonDisabled: false,
      buttonLabel: "Try again",
      visibleStatus:
        "The connection is still unavailable. You can safely try again.",
    });
  });

  it("provides non-empty live-region messages for retry outcomes", () => {
    expect(accountConnectionStatus("retry", "pending")).toBe(
      "Checking your library connection…",
    );
    expect(accountConnectionStatus("retry", "success")).toBe(
      "Connection restored. Your library is open.",
    );
    expect(accountConnectionStatus("retry", "failure")).toContain(
      "still unavailable",
    );
  });
});
