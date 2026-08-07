import { Buffer } from "node:buffer";

import { DeliveryError } from "./errors.js";

const COMPACT_UUID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLBACK_PATTERN =
  /^reflo:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22}):([0-9]|[1-9][0-9])$/;
const TELEGRAM_CALLBACK_MAX_BYTES = 64;

export interface TelegramCallbackReference {
  readonly answerIndex: number;
  readonly deliveryId: string;
  readonly deliveryItemId: string;
}

export function encodeTelegramCallback(
  reference: TelegramCallbackReference,
): string {
  if (
    !Number.isSafeInteger(reference.answerIndex) ||
    reference.answerIndex < 0 ||
    reference.answerIndex > 99
  ) {
    throw new DeliveryError("invalid_input");
  }
  const encoded = [
    "reflo",
    compactUuid(reference.deliveryId),
    compactUuid(reference.deliveryItemId),
    String(reference.answerIndex),
  ].join(":");
  if (Buffer.byteLength(encoded, "utf8") > TELEGRAM_CALLBACK_MAX_BYTES) {
    throw new DeliveryError("invalid_input");
  }
  return encoded;
}

export function decodeTelegramCallback(
  value: string,
): TelegramCallbackReference {
  const match = CALLBACK_PATTERN.exec(value);
  if (match === null) {
    throw new DeliveryError("invalid_input");
  }
  return {
    answerIndex: Number(match[3]),
    deliveryId: expandUuid(match[1]!),
    deliveryItemId: expandUuid(match[2]!),
  };
}

function compactUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new DeliveryError("invalid_input");
  }
  return Buffer.from(value.replaceAll("-", ""), "hex").toString("base64url");
}

function expandUuid(value: string): string {
  if (!COMPACT_UUID_PATTERN.test(value)) {
    throw new DeliveryError("invalid_input");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 16 || bytes.toString("base64url") !== value) {
    throw new DeliveryError("invalid_input");
  }
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
