import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DemoDeliveryDestination, ReservedDelivery } from "./contracts.js";
import type { DeliveryError } from "./errors.js";
import { DemoDeliveryService } from "./service.js";
import {
  FakeDemoMessagePort,
  InMemoryDeliveryKnowledgePort,
  InMemoryDemoDeliveryRepository,
} from "./testing.js";

const ids = {
  channel: "10000000-0000-4000-8000-000000000001",
  concept: "20000000-0000-4000-8000-000000000001",
  delivery: "30000000-0000-4000-8000-000000000001",
  item: "40000000-0000-4000-8000-000000000001",
  quiz: "50000000-0000-4000-8000-000000000001",
  review: "60000000-0000-4000-8000-000000000001",
  scope: "70000000-0000-4000-8000-000000000001",
  user: "80000000-0000-4000-8000-000000000001",
};
const authorization = {
  actorId: ids.user,
  authorizationId: "staff-demo-config-v1",
  ownerScopeId: ids.scope,
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const emailDestination: DemoDeliveryDestination = {
  authorization,
  channelIdentityId: ids.channel,
  provider: "email",
  recipient: "staff-demo@example.test",
  recipientLookupDigest: digest("staff-demo@example.test"),
};
const telegramDestination: DemoDeliveryDestination = {
  authorization,
  channelIdentityId: ids.channel,
  provider: "telegram",
  recipient: "100123456789",
  recipientLookupDigest: digest("-100123456789"),
  telegramWebhookSecret: "telegram-demo-secret",
};

describe("demo-only ambient delivery", () => {
  let repository: InMemoryDemoDeliveryRepository;
  let email: FakeDemoMessagePort;
  let telegram: FakeDemoMessagePort;
  let knowledge: InMemoryDeliveryKnowledgePort;
  let service: DemoDeliveryService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T09:30:00.000Z"));
    repository = new InMemoryDemoDeliveryRepository();
    email = new FakeDemoMessagePort("email");
    telegram = new FakeDemoMessagePort("telegram");
    knowledge = new InMemoryDeliveryKnowledgePort();
    service = new DemoDeliveryService({
      destinations: [emailDestination, telegramDestination],
      emailLinkOrigin: "https://app.reflo.example",
      emailLinkSigningKey: Buffer.alloc(32, 7),
      knowledge,
      messagePorts: [email, telegram],
      repository,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches a due item once and reuses the logical delivery on retry", async () => {
    repository.nextDelivery = delivery("telegram");
    const command = {
      authorization,
      idempotencyKey: "due/2026-07-24",
      now: "2026-07-24T09:00:00.000Z",
      provider: "telegram" as const,
    };

    const created = await service.dispatch(command);
    const replayed = await service.dispatch(command);

    expect(created?.status).toBe("created");
    expect(replayed?.status).toBe("replayed");
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]?.demoOnlyLabel).toBe(
      "Staff-controlled demo only",
    );
  });

  it("rejects an invalid Telegram secret and deduplicates webhook replays", async () => {
    repository.nextDelivery = delivery("telegram");
    await service.dispatch({
      authorization,
      idempotencyKey: "due/telegram",
      now: "2026-07-24T09:00:00.000Z",
      provider: "telegram",
    });
    const body = JSON.stringify({
      callback_query: {
        data: `reflo:${ids.delivery}:${ids.item}:1`,
        from: { id: Number(telegramDestination.recipient) },
        id: "callback-1",
        message: { chat: { id: telegramDestination.recipient } },
      },
      update_id: 99,
    });

    await expect(
      service.handleTelegramWebhook(body, "wrong-secret"),
    ).rejects.toMatchObject<Partial<DeliveryError>>({
      code: "invalid_signature",
    });
    const forgedSender = JSON.stringify({
      ...JSON.parse(body),
      callback_query: {
        ...JSON.parse(body).callback_query,
        from: { id: 999 },
      },
    });
    await expect(
      service.handleTelegramWebhook(
        forgedSender,
        telegramDestination.telegramWebhookSecret,
      ),
    ).rejects.toMatchObject<Partial<DeliveryError>>({
      code: "invalid_signature",
    });
    expect(
      await service.handleTelegramWebhook(
        body,
        telegramDestination.telegramWebhookSecret,
      ),
    ).toMatchObject([{ correct: true, status: "created" }]);
    expect(
      await service.handleTelegramWebhook(
        body,
        telegramDestination.telegramWebhookSecret,
      ),
    ).toMatchObject([{ correct: true, status: "replayed" }]);
    expect(knowledge.updates).toHaveLength(1);
  });

  it("uses an authenticated 24-hour signed email link exactly once", async () => {
    repository.nextDelivery = delivery("email");
    await service.dispatch({
      authorization,
      idempotencyKey: "due/email",
      now: "2026-07-24T09:00:00.000Z",
      provider: "email",
    });
    const link = new URL(email.messages[0]!.emailLink!);
    const token = link.searchParams.get("token")!;

    const preview = await service.previewEmail(
      authorization,
      token,
      "2026-07-24T09:01:00.000Z",
    );
    expect(preview.demoOnly).toBe(true);
    expect(preview.questions[0]).not.toHaveProperty("keyedAnswer");

    const answers = [{ answer: "B", deliveryItemId: ids.item }];
    expect(
      await service.submitEmail(
        authorization,
        token,
        answers,
        "2026-07-24T09:02:00.000Z",
      ),
    ).toMatchObject([{ correct: true, status: "created" }]);
    expect(
      await service.submitEmail(
        authorization,
        token,
        answers,
        "2026-07-24T09:03:00.000Z",
      ),
    ).toMatchObject([{ correct: true, status: "replayed" }]);
    expect(knowledge.updates).toHaveLength(1);
  });

  it("fails closed for an unconfigured external destination", async () => {
    repository.nextDelivery = delivery("email");
    await expect(
      service.dispatch({
        authorization: { ...authorization, actorId: "external-user" },
        idempotencyKey: "external",
        now: "2026-07-24T09:00:00.000Z",
        provider: "email",
      }),
    ).rejects.toMatchObject<Partial<DeliveryError>>({
      code: "authorization_denied",
    });
    expect(email.messages).toHaveLength(0);
  });

  it("never blindly resends after provider acceptance becomes ambiguous", async () => {
    repository.nextDelivery = delivery("telegram");
    repository.markSubmitted = async () => {
      throw new Error("database_unavailable_after_provider_acceptance");
    };
    const command = {
      authorization,
      idempotencyKey: "due/ambiguous",
      now: "2026-07-24T09:00:00.000Z",
      provider: "telegram" as const,
    };

    await expect(service.dispatch(command)).rejects.toMatchObject<
      Partial<DeliveryError>
    >({ code: "dispatch_ambiguous" });
    await expect(service.dispatch(command)).rejects.toMatchObject<
      Partial<DeliveryError>
    >({ code: "dispatch_failed" });
    expect(telegram.messages).toHaveLength(1);
  });
});

function delivery(provider: "email" | "telegram"): ReservedDelivery {
  return {
    deliveryId: ids.delivery,
    expiresAt: "2026-07-25T09:00:00.000Z",
    items: [
      {
        conceptId: ids.concept,
        deliveryItemId: ids.item,
        keyedAnswer: "B",
        prompt: "Which option is correct?",
        quizItemId: ids.quiz,
        responseOptions: ["A", "B", "C"],
        reviewScheduleId: ids.review,
        rubricId: "rubric-demo",
        rubricVersion: "1",
      },
    ],
    provider,
    providerMessageId: null,
    status: "pending",
  };
}
