import { describe, expect, it } from "vitest";

import {
  activateControlFromKeyboard,
  accountConnectionStatus,
  isButtonActivationKey,
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

  it("supports Enter and Space activation for the connection retry button", () => {
    expect(isButtonActivationKey("Enter")).toBe(true);
    expect(isButtonActivationKey(" ")).toBe(true);
    expect(isButtonActivationKey("Spacebar")).toBe(true);
    expect(isButtonActivationKey("Tab")).toBe(false);
    expect(isButtonActivationKey("Escape")).toBe(false);
  });

  it.each(["Enter", " ", "Spacebar"])(
    "activates %s exactly once through the pointer path",
    (key) => {
      let clicks = 0;
      let prevented = 0;
      expect(
        activateControlFromKeyboard({
          currentTarget: { click: () => (clicks += 1) },
          key,
          preventDefault: () => (prevented += 1),
          repeat: false,
        }),
      ).toBe(true);
      expect(clicks).toBe(1);
      expect(prevented).toBe(1);
    },
  );

  it("ignores key repeats and non-activation keys", () => {
    let clicks = 0;
    let prevented = 0;
    const event = {
      currentTarget: { click: () => (clicks += 1) },
      key: "Enter",
      preventDefault: () => (prevented += 1),
      repeat: true,
    };
    expect(activateControlFromKeyboard(event)).toBe(false);
    expect(clicks).toBe(0);
    expect(prevented).toBe(1);
    expect(
      activateControlFromKeyboard({ ...event, key: "Tab", repeat: false }),
    ).toBe(false);
    expect(clicks).toBe(0);
    expect(prevented).toBe(1);
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
