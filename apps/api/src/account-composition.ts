import { randomUUID } from "node:crypto";

import { AccountService, FixedWindowAuthAbuseLimiter } from "@reflo/accounts";
import {
  createDirectMailTransactionalEmailAdapter,
  type DirectMailRegion,
} from "@reflo/accounts/directmail";
import type { Deployment } from "@reflo/config";
import { PostgresAccountRepository } from "@reflo/db";

const DIRECTMAIL_ELIGIBILITY = "approved-free-quota-v1";
const DIRECTMAIL_REGIONS = new Set<DirectMailRegion>([
  "ap-southeast-1",
  "cn-hangzhou",
  "eu-central-1",
  "us-east-1",
]);
const FREE_DAILY_LIMIT = 200;
const FREE_TOTAL_LIMIT = 2_000;

export interface AccountRuntime {
  readonly accounts?: AccountService;
  close(): Promise<void>;
}

export function createAccountRuntime(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
): AccountRuntime {
  const adapter = input.REFLO_AUTH_EMAIL_ADAPTER;
  if (adapter === undefined || adapter === "disabled") {
    if (deployment !== "dev") {
      throw new Error(
        "REFLO_AUTH_EMAIL_ADAPTER must select an eligible production adapter",
      );
    }
    return { close: async () => undefined };
  }
  if (adapter !== "directmail") {
    throw new Error("REFLO_AUTH_EMAIL_ADAPTER is not allowlisted");
  }
  if (input.REFLO_DIRECTMAIL_ELIGIBILITY !== DIRECTMAIL_ELIGIBILITY) {
    throw new Error("DirectMail production eligibility is not approved");
  }

  const dailyLimit = readLimit(input, "REFLO_DIRECTMAIL_DAILY_LIMIT");
  const totalLimit = readLimit(input, "REFLO_DIRECTMAIL_TOTAL_LIMIT");
  if (dailyLimit > FREE_DAILY_LIMIT || totalLimit > FREE_TOTAL_LIMIT) {
    throw new Error("DirectMail delivery limits exceed approved free capacity");
  }
  if (dailyLimit > totalLimit) {
    throw new Error("DirectMail daily limit cannot exceed total limit");
  }

  const callbackOrigins = required(input, "REFLO_AUTH_CALLBACK_ORIGINS")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (callbackOrigins.length === 0) {
    throw new Error("REFLO_AUTH_CALLBACK_ORIGINS must not be empty");
  }

  const keys = [
    readKey(input, "REFLO_AUTH_EMAIL_ENCRYPTION_KEY"),
    readKey(input, "REFLO_AUTH_LOOKUP_KEY"),
    readKey(input, "REFLO_AUTH_SESSION_DIGEST_KEY"),
    readKey(input, "REFLO_AUTH_TOKEN_DIGEST_KEY"),
  ] as const;
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      if (Buffer.from(keys[left]!).equals(Buffer.from(keys[right]!))) {
        throw new Error("Authentication keys must be independent");
      }
    }
  }

  const region = required(input, "REFLO_DIRECTMAIL_REGION");
  if (!DIRECTMAIL_REGIONS.has(region as DirectMailRegion)) {
    throw new Error("REFLO_DIRECTMAIL_REGION is not allowlisted");
  }
  const emailPort = createDirectMailTransactionalEmailAdapter({
    fromAlias: required(input, "REFLO_DIRECTMAIL_FROM_ALIAS"),
    ramRoleName: required(input, "REFLO_DIRECTMAIL_RAM_ROLE_NAME"),
    region: region as DirectMailRegion,
    senderAddress: required(input, "REFLO_DIRECTMAIL_SENDER_ADDRESS"),
  });
  const repository = new PostgresAccountRepository(
    required(input, "DATABASE_URL"),
  );
  const accounts = new AccountService({
    abuseLimiter: new FixedWindowAuthAbuseLimiter(),
    callbackOrigins,
    clock: { now: () => new Date() },
    emailEncryptionKey: keys[0],
    emailPort,
    idGenerator: { createId: () => randomUUID() },
    lookupKey: keys[1],
    magicLinkDailyLimit: dailyLimit,
    magicLinkTotalLimit: totalLimit,
    repository,
    sessionDigestKey: keys[2],
    tokenDigestKey: keys[3],
  });

  return {
    accounts,
    close: () => repository.close(),
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
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error(`${name} must be a canonical base64-encoded 32-byte key`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new Error(`${name} must be a canonical base64-encoded 32-byte key`);
  }
  return decoded;
}

function readLimit(input: NodeJS.ProcessEnv, name: string): number {
  const value = required(input, name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}
