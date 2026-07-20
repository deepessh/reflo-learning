import { afterEach, describe, expect, it } from "vitest";

import {
  createAccountRuntime,
  type AccountRuntime,
} from "./account-composition.js";

const runtimes: AccountRuntime[] = [];
const key = (value: number) => Buffer.alloc(32, value).toString("base64");

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://runtime@db.invalid/reflo",
    REFLO_AUTH_CALLBACK_ORIGINS: "https://app.reflo.example",
    REFLO_AUTH_EMAIL_ADAPTER: "directmail",
    REFLO_AUTH_EMAIL_ENCRYPTION_KEY: key(1),
    REFLO_AUTH_LOOKUP_KEY: key(2),
    REFLO_AUTH_SESSION_DIGEST_KEY: key(3),
    REFLO_AUTH_TOKEN_DIGEST_KEY: key(4),
    REFLO_DIRECTMAIL_ELIGIBILITY: "approved-free-quota-v1",
    REFLO_DIRECTMAIL_DAILY_LIMIT: "200",
    REFLO_DIRECTMAIL_FROM_ALIAS: "Reflo",
    REFLO_DIRECTMAIL_RAM_ROLE_NAME: "reflo-directmail-runtime",
    REFLO_DIRECTMAIL_REGION: "ap-southeast-1",
    REFLO_DIRECTMAIL_SENDER_ADDRESS: "signin@reflo.example",
    REFLO_DIRECTMAIL_TOTAL_LIMIT: "2000",
  };
}

describe("account production composition", () => {
  it("allows auth to remain explicitly disabled only in development", async () => {
    const runtime = createAccountRuntime({}, "dev");
    runtimes.push(runtime);
    expect(runtime.accounts).toBeUndefined();

    expect(() => createAccountRuntime({}, "pilot")).toThrow(
      /must select an eligible production adapter/,
    );
  });

  it("fails closed for unknown or ineligible providers", () => {
    expect(() =>
      createAccountRuntime({ REFLO_AUTH_EMAIL_ADAPTER: "smtp" }, "pilot"),
    ).toThrow(/not allowlisted/);
    expect(() =>
      createAccountRuntime(
        {
          REFLO_AUTH_EMAIL_ADAPTER: "directmail",
          REFLO_DIRECTMAIL_ELIGIBILITY: "pending",
        },
        "pilot",
      ),
    ).toThrow(/eligibility is not approved/);
  });

  it("rejects paid-capacity limits and reused authentication keys", () => {
    expect(() =>
      createAccountRuntime(
        {
          ...productionEnvironment(),
          REFLO_DIRECTMAIL_DAILY_LIMIT: "201",
        },
        "pilot",
      ),
    ).toThrow(/exceed approved free capacity/);
    expect(() =>
      createAccountRuntime(
        {
          ...productionEnvironment(),
          REFLO_AUTH_TOKEN_DIGEST_KEY: key(3),
        },
        "pilot",
      ),
    ).toThrow(/keys must be independent/);
  });

  it("composes the allowlisted adapter with RAM-role credentials", () => {
    const runtime = createAccountRuntime(productionEnvironment(), "pilot");
    runtimes.push(runtime);
    expect(runtime.accounts).toBeDefined();
    expect(runtime.accounts?.isTrustedOrigin("https://app.reflo.example")).toBe(
      true,
    );
  });
});
