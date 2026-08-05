import { createHash, createHmac } from "node:crypto";

import type { Deployment } from "@reflo/config";
import {
  DemoDeliveryService,
  type DeliveryKnowledgePort,
  type DeliveryMessage,
  type DemoDeliveryDestination,
  type DemoMessagePort,
} from "@reflo/delivery";
import {
  createDirectMailDemoMessageAdapter,
  type DemoDirectMailRegion,
} from "@reflo/delivery/directmail";
import { createTelegramDemoMessageAdapter } from "@reflo/delivery/telegram";
import {
  PostgresAccountRepository,
  PostgresDemoDeliveryRepository,
  PostgresKnowledgeRepository,
} from "@reflo/db";
import {
  createDemoTraceRuntime,
  type DemoOperationName,
  type DemoTraceRuntime,
} from "@reflo/observability";

const DELIVERY_MODE = "staff-only-demo-v1";
const DELIVERY_PROVIDERS = new Set(["email", "telegram"]);
const DIRECTMAIL_ELIGIBILITY = "approved-free-quota-v1";
const FREE_DAILY_LIMIT = 200;
const FREE_TOTAL_LIMIT = 2_000;
const DIRECTMAIL_REGIONS = new Set<DemoDirectMailRegion>([
  "ap-southeast-1",
  "cn-hangzhou",
  "eu-central-1",
  "us-east-1",
]);

export interface DeliveryRuntime {
  readonly delivery?: Pick<
    DemoDeliveryService,
    | "dispatch"
    | "getPreference"
    | "handleTelegramWebhook"
    | "previewEmail"
    | "submitEmail"
    | "updatePreference"
  >;
  close(): Promise<void>;
}

export function createDeliveryRuntime(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
): DeliveryRuntime {
  const mode = input.REFLO_DEMO_DELIVERY_MODE;
  if (mode === undefined || mode === "disabled") {
    if (deployment !== "dev") {
      throw new Error(
        "REFLO_DEMO_DELIVERY_MODE must enable the staff-only P0 delivery path",
      );
    }
    return { close: async () => undefined };
  }
  if (mode !== DELIVERY_MODE) {
    throw new Error("REFLO_DEMO_DELIVERY_MODE is not allowlisted");
  }
  const databaseUrl = required(input, "DATABASE_URL");
  const destinationLookupKey = readKey(
    input,
    "REFLO_DEMO_DESTINATION_LOOKUP_KEY",
  );
  const selectedProvider = required(input, "REFLO_DEMO_DELIVERY_PROVIDER");
  if (!DELIVERY_PROVIDERS.has(selectedProvider)) {
    throw new Error("REFLO_DEMO_DELIVERY_PROVIDER is not allowlisted");
  }
  const provider = selectedProvider as "email" | "telegram";
  const configuredProviders = configuredDeliveryProviders(input, provider);
  const destinations = configuredProviders.map((configuredProvider) =>
    destination(
      input,
      configuredProvider === "email" ? "EMAIL" : "TELEGRAM",
      configuredProvider,
      destinationLookupKey,
    ),
  );
  const messageAdapter = input.REFLO_DEMO_MESSAGE_ADAPTER ?? "provider";
  if (messageAdapter !== "provider" && messageAdapter !== "local-fixture") {
    throw new Error("REFLO_DEMO_MESSAGE_ADAPTER is not allowlisted");
  }
  if (messageAdapter === "local-fixture" && deployment !== "dev") {
    throw new Error("The local delivery fixture is development-only");
  }

  const repository = new PostgresDemoDeliveryRepository(databaseUrl);
  const knowledgeRepository = new PostgresKnowledgeRepository(databaseUrl);
  const capacityRepository = new PostgresAccountRepository(databaseUrl);
  const knowledge: DeliveryKnowledgePort = {
    record: async (update) => {
      await knowledgeRepository.recordEvidenceAndReplay(
        update.authorization,
        update.evidence,
        update.deliveryPreference,
      );
    },
  };
  const messagePorts = configuredProviders.map((configuredProvider) =>
    messageAdapter === "local-fixture"
      ? new LocalFixtureMessagePort(configuredProvider)
      : configuredProvider === "telegram"
        ? createTelegramDemoMessageAdapter({
            botToken: required(input, "REFLO_DEMO_TELEGRAM_BOT_TOKEN"),
          })
        : createEmailPort(input, capacityRepository),
  );
  const emailLinkSigningKey = configuredProviders.includes("email")
    ? readKey(input, "REFLO_DEMO_EMAIL_LINK_SIGNING_KEY")
    : undefined;
  if (
    emailLinkSigningKey !== undefined &&
    Buffer.from(emailLinkSigningKey).equals(Buffer.from(destinationLookupKey))
  ) {
    throw new Error("Demo delivery keys must be independent");
  }
  const delivery = new DemoDeliveryService({
    allowLocalHttpEmailOrigin:
      deployment === "dev" && messageAdapter === "local-fixture",
    defaultPreference: defaultPreference(input, provider),
    destinations,
    emailLinkOrigin: configuredProviders.includes("email")
      ? required(input, "REFLO_DEMO_EMAIL_LINK_ORIGIN")
      : undefined,
    emailLinkSigningKey,
    knowledge,
    messagePorts,
    repository,
  });
  const tracing = createDemoTraceRuntime(input, {
    component: "api",
    deployment,
  });
  return {
    delivery: instrumentDemoDelivery(delivery, tracing),
    close: async () => {
      await Promise.all([
        repository.close(),
        knowledgeRepository.close(),
        capacityRepository.close(),
      ]);
    },
  };
}

export function instrumentDemoDelivery(
  delivery: Pick<
    DemoDeliveryService,
    | "dispatch"
    | "getPreference"
    | "handleTelegramWebhook"
    | "previewEmail"
    | "submitEmail"
    | "updatePreference"
  >,
  tracing: DemoTraceRuntime,
): NonNullable<DeliveryRuntime["delivery"]> {
  return {
    dispatch: (command) =>
      traced(tracing, "test_delivery_dispatch", async () => {
        const result = await delivery.dispatch(command);
        return {
          outcome:
            result?.status === "replayed" ? ("replayed" as const) : "success",
          value: result,
        };
      }),
    getPreference: (authorization) => delivery.getPreference(authorization),
    handleTelegramWebhook: (rawBody, secretToken) =>
      traced(tracing, "test_delivery_response", async () => {
        const value = await delivery.handleTelegramWebhook(
          rawBody,
          secretToken,
        );
        return {
          outcome: replayOutcome(value.map((result) => result.status)),
          value,
        };
      }),
    previewEmail: (authorization, token, now) =>
      delivery.previewEmail(authorization, token, now),
    submitEmail: (authorization, token, answers, now) =>
      traced(tracing, "test_delivery_response", async () => {
        const value = await delivery.submitEmail(
          authorization,
          token,
          answers,
          now,
        );
        return {
          outcome: replayOutcome(value.map((result) => result.status)),
          value,
        };
      }),
    updatePreference: (authorization, preference) =>
      delivery.updatePreference(authorization, preference),
  };
}

async function traced<Value>(
  tracing: DemoTraceRuntime,
  operation: DemoOperationName,
  work: () => Promise<{
    readonly outcome: "replayed" | "success";
    readonly value: Value;
  }>,
): Promise<Value> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    const result = await work();
    const finished = Date.now();
    await recordOperationalBestEffort(tracing, {
      durationMs: Math.max(0, finished - started),
      finishedAt: new Date(finished).toISOString(),
      operation,
      outcome: result.outcome,
      stage: "test_delivery",
      startedAt,
    });
    return result.value;
  } catch (error) {
    const finished = Date.now();
    await recordOperationalBestEffort(tracing, {
      durationMs: Math.max(0, finished - started),
      finishedAt: new Date(finished).toISOString(),
      operation,
      outcome: "failure",
      stage: "test_delivery",
      startedAt,
    });
    throw error;
  }
}

async function recordOperationalBestEffort(
  tracing: DemoTraceRuntime,
  trace: Parameters<DemoTraceRuntime["recordOperational"]>[0],
): Promise<void> {
  try {
    await tracing.recordOperational(trace);
  } catch {
    // The bounded event was validated before transport. Trace availability does
    // not reinterpret an already committed delivery outcome.
  }
}

function createEmailPort(
  input: NodeJS.ProcessEnv,
  capacityRepository: PostgresAccountRepository,
): DemoMessagePort {
  if (input.REFLO_DIRECTMAIL_ELIGIBILITY !== DIRECTMAIL_ELIGIBILITY) {
    throw new Error("DirectMail production eligibility is not approved");
  }
  const dailyLimit = readLimit(input, "REFLO_DIRECTMAIL_DAILY_LIMIT");
  const totalLimit = readLimit(input, "REFLO_DIRECTMAIL_TOTAL_LIMIT");
  if (
    dailyLimit > FREE_DAILY_LIMIT ||
    totalLimit > FREE_TOTAL_LIMIT ||
    dailyLimit > totalLimit
  ) {
    throw new Error("DirectMail delivery limits exceed approved free capacity");
  }
  const region = required(input, "REFLO_DIRECTMAIL_REGION");
  if (!DIRECTMAIL_REGIONS.has(region as DemoDirectMailRegion)) {
    throw new Error("REFLO_DIRECTMAIL_REGION is not allowlisted");
  }
  return new CapacityGuardedEmailPort(
    createDirectMailDemoMessageAdapter({
      fromAlias: required(input, "REFLO_DIRECTMAIL_FROM_ALIAS"),
      ramRoleName: required(input, "REFLO_DIRECTMAIL_RAM_ROLE_NAME"),
      region: region as DemoDirectMailRegion,
      senderAddress: required(input, "REFLO_DIRECTMAIL_SENDER_ADDRESS"),
    }),
    capacityRepository,
    dailyLimit,
    totalLimit,
  );
}

function replayOutcome(
  statuses: readonly ("created" | "replayed")[],
): "replayed" | "success" {
  return statuses.length > 0 &&
    statuses.every((status) => status === "replayed")
    ? "replayed"
    : "success";
}

class CapacityGuardedEmailPort implements DemoMessagePort {
  readonly provider = "email" as const;

  constructor(
    private readonly delegate: DemoMessagePort,
    private readonly capacity: Pick<
      PostgresAccountRepository,
      "reserveMagicLinkDelivery"
    >,
    private readonly dailyLimit: number,
    private readonly totalLimit: number,
  ) {}

  async send(message: DeliveryMessage): Promise<{
    readonly providerMessageId: string;
  }> {
    if (
      !(await this.capacity.reserveMagicLinkDelivery(
        new Date(),
        this.dailyLimit,
        this.totalLimit,
      ))
    ) {
      throw new Error("directmail_free_capacity_exhausted");
    }
    return this.delegate.send(message);
  }
}

class LocalFixtureMessagePort implements DemoMessagePort {
  constructor(readonly provider: "email" | "telegram") {}

  async send(message: DeliveryMessage): Promise<{
    readonly providerMessageId: string;
  }> {
    if (message.provider !== this.provider) {
      throw new Error("local delivery fixture provider mismatch");
    }
    return {
      providerMessageId: `local-fixture/${createHash("sha256")
        .update(`${message.provider}/${message.deliveryId}`)
        .digest("hex")}`,
    };
  }
}

function destination(
  input: NodeJS.ProcessEnv,
  prefix: "EMAIL" | "TELEGRAM",
  provider: "email" | "telegram",
  lookupKey: Uint8Array,
): DemoDeliveryDestination {
  const recipient = required(input, `REFLO_DEMO_${prefix}_DESTINATION`);
  return {
    authorization: {
      actorId: required(input, `REFLO_DEMO_${prefix}_USER_ID`),
      authorizationId: "staff-demo-config-v1",
      ownerScopeId: required(input, `REFLO_DEMO_${prefix}_OWNER_SCOPE_ID`),
    },
    channelIdentityId: required(input, `REFLO_DEMO_${prefix}_CHANNEL_ID`),
    provider,
    recipient,
    recipientLookupDigest: createHmac("sha256", lookupKey)
      .update(recipient)
      .digest("hex"),
    ...(provider === "telegram"
      ? {
          telegramWebhookSecret: required(
            input,
            "REFLO_DEMO_TELEGRAM_WEBHOOK_SECRET",
          ),
        }
      : {}),
  };
}

function defaultPreference(
  input: NodeJS.ProcessEnv,
  provider: "email" | "telegram",
) {
  const chosenLocalTime = required(input, "REFLO_DEMO_REVIEW_LOCAL_TIME");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(chosenLocalTime)) {
    throw new Error("REFLO_DEMO_REVIEW_LOCAL_TIME is invalid");
  }
  const timeZone = required(input, "REFLO_DEMO_REVIEW_TIME_ZONE");
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error("REFLO_DEMO_REVIEW_TIME_ZONE is invalid");
  }
  return { chosenLocalTime, provider, timeZone };
}

function configuredDeliveryProviders(
  input: NodeJS.ProcessEnv,
  selected: "email" | "telegram",
): readonly ("email" | "telegram")[] {
  const other = selected === "email" ? "telegram" : "email";
  const prefix = other === "email" ? "EMAIL" : "TELEGRAM";
  return input[`REFLO_DEMO_${prefix}_DESTINATION`]?.trim()
    ? [selected, other]
    : [selected];
}

function required(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readKey(input: NodeJS.ProcessEnv, name: string): Uint8Array {
  const encoded = required(input, name);
  const decoded = Buffer.from(encoded, "base64");
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(encoded) ||
    decoded.length !== 32 ||
    decoded.toString("base64") !== encoded
  ) {
    throw new Error(`${name} must be a canonical base64-encoded 32-byte key`);
  }
  return decoded;
}

function readLimit(input: NodeJS.ProcessEnv, name: string): number {
  const parsed = Number(required(input, name));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}
