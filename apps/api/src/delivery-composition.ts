import { createHmac } from "node:crypto";

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

const DELIVERY_MODE = "staff-only-demo-v1";
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
  readonly delivery?: DemoDeliveryService;
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
  const emailLinkSigningKey = readKey(
    input,
    "REFLO_DEMO_EMAIL_LINK_SIGNING_KEY",
  );
  const destinationLookupKey = readKey(
    input,
    "REFLO_DEMO_DESTINATION_LOOKUP_KEY",
  );
  if (
    Buffer.from(emailLinkSigningKey).equals(Buffer.from(destinationLookupKey))
  ) {
    throw new Error("Demo delivery keys must be independent");
  }
  const telegram = destination(
    input,
    "TELEGRAM",
    "telegram",
    destinationLookupKey,
  );
  const email = destination(input, "EMAIL", "email", destinationLookupKey);

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
  const directMail = createDirectMailDemoMessageAdapter({
    fromAlias: required(input, "REFLO_DIRECTMAIL_FROM_ALIAS"),
    ramRoleName: required(input, "REFLO_DIRECTMAIL_RAM_ROLE_NAME"),
    region: region as DemoDirectMailRegion,
    senderAddress: required(input, "REFLO_DIRECTMAIL_SENDER_ADDRESS"),
  });
  const emailPort = new CapacityGuardedEmailPort(
    directMail,
    capacityRepository,
    dailyLimit,
    totalLimit,
  );
  const telegramPort = createTelegramDemoMessageAdapter({
    botToken: required(input, "REFLO_DEMO_TELEGRAM_BOT_TOKEN"),
  });
  const delivery = new DemoDeliveryService({
    destinations: [telegram, email],
    emailLinkOrigin: required(input, "REFLO_DEMO_EMAIL_LINK_ORIGIN"),
    emailLinkSigningKey,
    knowledge,
    messagePorts: [telegramPort, emailPort],
    repository,
  });
  return {
    delivery,
    close: async () => {
      await Promise.all([
        repository.close(),
        knowledgeRepository.close(),
        capacityRepository.close(),
      ]);
    },
  };
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
