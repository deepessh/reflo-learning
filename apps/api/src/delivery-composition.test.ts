import { describe, expect, it, vi } from "vitest";

import {
  createDeliveryRuntime,
  instrumentDemoDelivery,
} from "./delivery-composition.js";

const key = (value: number) => Buffer.alloc(32, value).toString("base64");

describe("demo delivery composition", () => {
  it("can remain disabled only in development", () => {
    expect(createDeliveryRuntime({}, "dev").delivery).toBeUndefined();
    expect(() => createDeliveryRuntime({}, "staging")).toThrow(
      /must enable the staff-only P0 delivery path/,
    );
  });

  it("fails closed for unknown modes and reused keys", () => {
    expect(() =>
      createDeliveryRuntime({ REFLO_DEMO_DELIVERY_MODE: "public" }, "dev"),
    ).toThrow(/not allowlisted/);
    expect(() =>
      createDeliveryRuntime(
        {
          ...environment(),
          REFLO_DEMO_DELIVERY_PROVIDER: "email",
          REFLO_DEMO_DESTINATION_LOOKUP_KEY: key(1),
        },
        "staging",
      ),
    ).toThrow(/keys must be independent/);
    expect(() =>
      createDeliveryRuntime(
        {
          ...environment(),
          REFLO_DEMO_MESSAGE_ADAPTER: "local-fixture",
        },
        "staging",
      ),
    ).toThrow(/development-only/);
  });

  it("composes only explicit staff destinations and approved free capacity", async () => {
    expect(() =>
      createDeliveryRuntime(
        {
          ...environment(),
          REFLO_DEMO_DELIVERY_PROVIDER: "email",
          REFLO_DIRECTMAIL_DAILY_LIMIT: "201",
        },
        "staging",
      ),
    ).toThrow(/exceed approved free capacity/);
    const runtime = createDeliveryRuntime(environment(), "staging");
    expect(runtime.delivery).toBeDefined();
    await runtime.close();
    const local = createDeliveryRuntime(
      {
        ...environment(),
        REFLO_DEMO_MESSAGE_ADAPTER: "local-fixture",
      },
      "dev",
    );
    expect(local.delivery).toBeDefined();
    await local.close();
  });

  it("composes Telegram without DirectMail or email configuration", async () => {
    const telegram = environment();
    for (const name of Object.keys(telegram)) {
      if (name.includes("EMAIL") || name.includes("DIRECTMAIL")) {
        delete telegram[name];
      }
    }
    const runtime = createDeliveryRuntime(telegram, "staging");
    expect(runtime.delivery).toBeDefined();
    await runtime.close();
  });

  it("composes email without Telegram configuration", async () => {
    const email = {
      ...environment(),
      REFLO_DEMO_DELIVERY_PROVIDER: "email",
    };
    for (const name of Object.keys(email)) {
      if (name.includes("TELEGRAM")) delete email[name];
    }
    const runtime = createDeliveryRuntime(email, "staging");
    expect(runtime.delivery).toBeDefined();
    await runtime.close();
  });

  it("records bounded delivery health without changing delivery outcomes", async () => {
    const recorded: unknown[] = [];
    const dispatch = vi.fn(async () => null);
    const traced = instrumentDemoDelivery(
      {
        dispatch,
        handleTelegramWebhook: vi.fn(),
        previewEmail: vi.fn(),
        submitEmail: vi.fn(),
      } as never,
      {
        enabled: true,
        modelTraces: { record: () => undefined },
        async recordOperational(trace) {
          recorded.push(trace);
          throw new Error("SLS unavailable");
        },
      },
    );
    const result = await traced.dispatch({
      authorization: {
        actorId: "staff-test",
        authorizationId: "staff-demo-config-v1",
        ownerScopeId: "staff-scope",
      },
      idempotencyKey: "delivery-1",
      now: "2026-07-24T20:00:00.000Z",
      provider: "telegram",
    });

    expect(result).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(recorded).toEqual([
      expect.objectContaining({
        operation: "test_delivery_dispatch",
        outcome: "success",
        stage: "test_delivery",
      }),
    ]);
    expect(JSON.stringify(recorded)).not.toContain("staff-test");
    expect(JSON.stringify(recorded)).not.toContain("staff-scope");
  });
});

function environment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://runtime@db.invalid/reflo",
    REFLO_DEMO_DELIVERY_MODE: "staff-only-demo-v1",
    REFLO_DEMO_DELIVERY_PROVIDER: "telegram",
    REFLO_DEMO_DESTINATION_LOOKUP_KEY: key(2),
    REFLO_DEMO_EMAIL_CHANNEL_ID: "10000000-0000-4000-8000-000000000001",
    REFLO_DEMO_EMAIL_DESTINATION: "staff-email@example.test",
    REFLO_DEMO_EMAIL_LINK_ORIGIN: "https://app.reflo.example",
    REFLO_DEMO_EMAIL_LINK_SIGNING_KEY: key(1),
    REFLO_DEMO_EMAIL_OWNER_SCOPE_ID: "20000000-0000-4000-8000-000000000001",
    REFLO_DEMO_EMAIL_USER_ID: "30000000-0000-4000-8000-000000000001",
    REFLO_DEMO_TELEGRAM_BOT_TOKEN: `123:${"a".repeat(32)}`,
    REFLO_DEMO_TELEGRAM_CHANNEL_ID: "40000000-0000-4000-8000-000000000001",
    REFLO_DEMO_TELEGRAM_DESTINATION: "100123456",
    REFLO_DEMO_TELEGRAM_OWNER_SCOPE_ID: "50000000-0000-4000-8000-000000000001",
    REFLO_DEMO_TELEGRAM_USER_ID: "60000000-0000-4000-8000-000000000001",
    REFLO_DEMO_TELEGRAM_WEBHOOK_SECRET: "staff-demo-webhook-secret",
    REFLO_DIRECTMAIL_DAILY_LIMIT: "200",
    REFLO_DIRECTMAIL_ELIGIBILITY: "approved-free-quota-v1",
    REFLO_DIRECTMAIL_FROM_ALIAS: "Reflo",
    REFLO_DIRECTMAIL_RAM_ROLE_NAME: "reflo-directmail-runtime",
    REFLO_DIRECTMAIL_REGION: "ap-southeast-1",
    REFLO_DIRECTMAIL_SENDER_ADDRESS: "demo@reflo.example",
    REFLO_DIRECTMAIL_TOTAL_LIMIT: "2000",
  };
}
