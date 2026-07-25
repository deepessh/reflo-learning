import { timingSafeEqual } from "node:crypto";

import type { MagicLinkMessage } from "../contracts.js";
import type { TransactionalEmailPort } from "../ports.js";

export interface LocalAuthInboxEnvironment {
  readonly REFLO_DEV_AUTH_INBOX_ACCESS_KEY?: string;
  readonly REFLO_DEV_AUTH_INBOX_DESTINATION?: string;
  readonly REFLO_ENV?: string;
}

export interface LocalAuthInboxMessage {
  readonly expiresAt: string;
  readonly loginUrl: string;
}

/**
 * A single-recipient, memory-only development capability. Message contents are
 * returned only through an explicit access-key check and are never formatted
 * for logs, traces, or diagnostics.
 */
export class LocalAuthInbox implements TransactionalEmailPort {
  readonly #accessKey: Buffer;
  readonly #destination: string;
  #message: MagicLinkMessage | null = null;

  constructor(environment: LocalAuthInboxEnvironment) {
    if (environment.REFLO_ENV !== "dev") {
      throw new Error("the local authentication inbox is development-only");
    }
    const destination = environment.REFLO_DEV_AUTH_INBOX_DESTINATION?.trim();
    if (
      destination === undefined ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination) ||
      destination.length > 254
    ) {
      throw new Error("REFLO_DEV_AUTH_INBOX_DESTINATION is invalid");
    }
    const accessKey = environment.REFLO_DEV_AUTH_INBOX_ACCESS_KEY;
    if (
      accessKey === undefined ||
      accessKey.length < 32 ||
      accessKey.length > 256 ||
      /\s/.test(accessKey)
    ) {
      throw new Error("REFLO_DEV_AUTH_INBOX_ACCESS_KEY is invalid");
    }
    this.#destination = destination.toLowerCase();
    this.#accessKey = Buffer.from(accessKey, "utf8");
  }

  async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    if (message.destination.toLowerCase() !== this.#destination) {
      throw new Error("the local authentication inbox rejected the recipient");
    }
    this.#message = message;
  }

  take(accessKey: string | undefined): LocalAuthInboxMessage | null {
    const supplied = Buffer.from(accessKey ?? "", "utf8");
    if (
      supplied.length !== this.#accessKey.length ||
      !timingSafeEqual(supplied, this.#accessKey)
    ) {
      return null;
    }
    const message = this.#message;
    this.#message = null;
    return message === null
      ? null
      : {
          expiresAt: message.expiresAt.toISOString(),
          loginUrl: message.loginUrl,
        };
  }
}

export function createLocalAuthInbox(
  environment: LocalAuthInboxEnvironment,
): LocalAuthInbox {
  return new LocalAuthInbox(environment);
}
