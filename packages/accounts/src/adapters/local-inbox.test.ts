import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalAuthInbox } from "./local-inbox.js";

const environment = {
  REFLO_DEV_AUTH_INBOX_ACCESS_KEY: "a".repeat(32),
  REFLO_DEV_AUTH_INBOX_DESTINATION: "staff-demo@example.test",
  REFLO_ENV: "dev",
} as const;

afterEach(() => vi.restoreAllMocks());

describe("development authentication inbox", () => {
  it("is single-recipient, access-key protected, and destructive on read", async () => {
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const inbox = createLocalAuthInbox(environment);
    await inbox.sendMagicLink({
      destination: "staff-demo@example.test",
      expiresAt: new Date("2026-07-24T12:10:00.000Z"),
      loginUrl:
        "http://127.0.0.1:3000/auth/callback?token=sensitive-token-value",
    });

    expect(inbox.take("wrong")).toBeNull();
    expect(inbox.take(environment.REFLO_DEV_AUTH_INBOX_ACCESS_KEY)).toEqual({
      expiresAt: "2026-07-24T12:10:00.000Z",
      loginUrl:
        "http://127.0.0.1:3000/auth/callback?token=sensitive-token-value",
    });
    expect(inbox.take(environment.REFLO_DEV_AUTH_INBOX_ACCESS_KEY)).toBeNull();
    expect(JSON.stringify(inbox)).not.toContain("sensitive-token-value");
    expect(JSON.stringify(inbox)).not.toContain("staff-demo@example.test");
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("rejects non-development activation and any other recipient", async () => {
    expect(() =>
      createLocalAuthInbox({ ...environment, REFLO_ENV: "staging" }),
    ).toThrow("development-only");
    const inbox = createLocalAuthInbox(environment);
    await expect(
      inbox.sendMagicLink({
        destination: "other@example.test",
        expiresAt: new Date(),
        loginUrl: "http://127.0.0.1:3000/auth/callback?token=other",
      }),
    ).rejects.toThrow("rejected the recipient");
  });
});
