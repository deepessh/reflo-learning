import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { SIGNED_URL_TTL_SECONDS } from "../contracts.js";
import { PrivateDeliveryError } from "../errors.js";
import { parseCanonicalObjectKey } from "../object-keys.js";
import type { CdnSignedUrl, CdnSigningPort } from "../ports.js";

const RANDOM_PATTERN = /^(?:0|[0-9a-f]{32})$/;
const AUTH_KEY_PATTERN = /^(\d{10})-(0|[0-9a-f]{32})-0-([0-9a-f]{32})$/;

export interface KmsSigningSecret {
  readonly keyVersion: string;
  readonly source: "kms-secrets-manager";
  readonly value: string;
}

export interface AlibabaTypeASignerOptions {
  readonly activeKey: KmsSigningSecret;
  readonly cdnOrigin: string;
  readonly randomValue?: () => string;
  readonly ttlSeconds?: number;
}

export function createAlibabaTypeASigner(
  options: AlibabaTypeASignerOptions,
): CdnSigningPort {
  const origin = validateCdnOrigin(options.cdnOrigin);
  const ttlSeconds = options.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
  if (
    ttlSeconds !== SIGNED_URL_TTL_SECONDS ||
    options.activeKey.source !== "kms-secrets-manager" ||
    options.activeKey.value.length < 32 ||
    options.activeKey.keyVersion.length === 0
  ) {
    throw new PrivateDeliveryError("configuration_invalid");
  }
  const randomValue =
    options.randomValue ?? (() => randomUUID().replaceAll("-", ""));

  return {
    canonicalUrl(canonicalPath: string): string {
      validateCanonicalPath(canonicalPath);
      return new URL(canonicalPath, origin).toString();
    },
    sign(canonicalPath: string, issuedAt: Date): CdnSignedUrl {
      validateCanonicalPath(canonicalPath);
      const timestamp = unixTimestamp(issuedAt);
      const random = randomValue();
      if (!RANDOM_PATTERN.test(random)) {
        throw new PrivateDeliveryError("signing_unavailable");
      }
      const digest = computeAlibabaTypeASignature({
        canonicalPath,
        privateKey: options.activeKey.value,
        random,
        timestamp,
      });
      const url = new URL(canonicalPath, origin);
      url.searchParams.set("auth_key", `${timestamp}-${random}-0-${digest}`);
      return {
        expiresAt: new Date((timestamp + ttlSeconds) * 1_000),
        url: url.toString(),
      };
    },
  };
}

export function computeAlibabaTypeASignature(input: {
  readonly canonicalPath: string;
  readonly privateKey: string;
  readonly random: string;
  readonly timestamp: number;
}): string {
  validateCanonicalPath(input.canonicalPath, false);
  if (
    !RANDOM_PATTERN.test(input.random) ||
    !Number.isInteger(input.timestamp)
  ) {
    throw new PrivateDeliveryError("signing_unavailable");
  }
  return createHash("md5")
    .update(
      `${input.canonicalPath}-${input.timestamp}-${input.random}-0-${input.privateKey}`,
      "utf8",
    )
    .digest("hex");
}

export function verifyAlibabaTypeAUrl(input: {
  readonly expectedOrigin: string;
  readonly now: Date;
  readonly signingKeys: readonly string[];
  readonly url: string;
}): boolean {
  try {
    const expectedOrigin = validateCdnOrigin(input.expectedOrigin);
    const url = new URL(input.url);
    if (url.origin !== expectedOrigin.origin || url.hash !== "") {
      return false;
    }
    if (
      [...url.searchParams.keys()].some((key) => key !== "auth_key") ||
      url.searchParams.getAll("auth_key").length !== 1
    ) {
      return false;
    }
    const authKey = url.searchParams.get("auth_key") ?? "";
    const match = AUTH_KEY_PATTERN.exec(authKey);
    if (match === null) {
      return false;
    }
    const timestampText = match[1];
    const random = match[2];
    const suppliedDigest = match[3];
    if (
      timestampText === undefined ||
      random === undefined ||
      suppliedDigest === undefined
    ) {
      return false;
    }
    const timestamp = Number(timestampText);
    const now = unixTimestamp(input.now);
    if (timestamp > now || now >= timestamp + SIGNED_URL_TTL_SECONDS) {
      return false;
    }
    validateCanonicalPath(url.pathname);
    return input.signingKeys.some((privateKey) => {
      const expectedDigest = computeAlibabaTypeASignature({
        canonicalPath: url.pathname,
        privateKey,
        random,
        timestamp,
      });
      return safeEqual(suppliedDigest, expectedDigest);
    });
  } catch {
    return false;
  }
}

export function redactSignedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[REDACTED_PRIVATE_DELIVERY_URL]";
  }
}

function validateCdnOrigin(value: string): URL {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      throw new Error("invalid origin");
    }
    return origin;
  } catch {
    throw new PrivateDeliveryError("configuration_invalid");
  }
}

function validateCanonicalPath(
  canonicalPath: string,
  requireRefloLayout = true,
): void {
  if (!canonicalPath.startsWith("/") || canonicalPath.includes("?")) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
  if (requireRefloLayout) {
    parseCanonicalObjectKey(canonicalPath.slice(1));
  }
}

function unixTimestamp(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new PrivateDeliveryError("signing_unavailable");
  }
  return Math.floor(milliseconds / 1_000);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
