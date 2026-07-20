import {
  createCipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type {
  AuthenticatedAccount,
  LibraryCourse,
  RedeemedSession,
  SessionHistoryItem,
} from "./contracts.js";
import type {
  AccountClock,
  AccountIdGenerator,
  AccountRepository,
  AuthAbuseLimiter,
  TransactionalEmailPort,
} from "./ports.js";

const LOGIN_LIFETIME_MS = 10 * 60 * 1_000;
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1_000;
const RECENT_AUTH_MS = 15 * 60 * 1_000;

export interface AccountServiceOptions {
  readonly abuseLimiter: AuthAbuseLimiter;
  readonly callbackOrigins: readonly string[];
  readonly clock: AccountClock;
  readonly emailEncryptionKey: Uint8Array;
  readonly emailPort: TransactionalEmailPort;
  readonly idGenerator: AccountIdGenerator;
  readonly lookupKey: Uint8Array;
  readonly repository: AccountRepository;
  readonly sessionDigestKey: Uint8Array;
  readonly tokenDigestKey: Uint8Array;
}

export class AccountService {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #options: AccountServiceOptions;

  constructor(options: AccountServiceOptions) {
    assertKey("emailEncryptionKey", options.emailEncryptionKey);
    assertKey("lookupKey", options.lookupKey);
    assertKey("sessionDigestKey", options.sessionDigestKey);
    assertKey("tokenDigestKey", options.tokenDigestKey);
    this.#allowedOrigins = new Set(
      options.callbackOrigins.map((origin) => normalizeOrigin(origin)),
    );
    if (this.#allowedOrigins.size === 0) {
      throw new Error("At least one exact callback origin is required");
    }
    this.#options = options;
  }

  isTrustedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) {
      return false;
    }
    try {
      return this.#allowedOrigins.has(normalizeOrigin(origin));
    } catch {
      return false;
    }
  }

  async requestMagicLink(emailInput: string, origin: string): Promise<void> {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!this.#allowedOrigins.has(normalizedOrigin)) {
      throw new AccountInputError("callback_origin_not_allowed");
    }

    const email = normalizeEmail(emailInput);
    const now = this.#options.clock.now();
    const emailLookupDigest = digest(this.#options.lookupKey, `email:${email}`);
    const originKey = digest(
      this.#options.lookupKey,
      `origin:${normalizedOrigin}`,
    );
    if (!this.#options.abuseLimiter.allow(emailLookupDigest, originKey, now)) {
      return;
    }

    const token = randomBytes(32).toString("base64url");
    const tokenDigest = digest(this.#options.tokenDigestKey, token);
    const expiresAt = new Date(now.getTime() + LOGIN_LIFETIME_MS);
    await this.#options.repository.issueLoginToken({
      emailCiphertext: encryptEmail(email, this.#options.emailEncryptionKey),
      emailLookupDigest,
      expiresAt,
      issuedAt: now,
      tokenDigest,
      tokenId: this.#options.idGenerator.createId(),
      userId: this.#options.idGenerator.createId(),
    });

    const loginUrl = new URL("/auth/callback", normalizedOrigin);
    loginUrl.searchParams.set("token", token);
    await this.#options.emailPort.sendMagicLink({
      destination: email,
      expiresAt,
      loginUrl: loginUrl.toString(),
    });
  }

  async redeemMagicLink(token: string): Promise<RedeemedSession | null> {
    if (!isOpaqueSecret(token)) {
      return null;
    }
    const now = this.#options.clock.now();
    const sessionSecret = randomBytes(32).toString("base64url");
    const sessionDigest = digest(this.#options.sessionDigestKey, sessionSecret);
    const sessionId = this.#options.idGenerator.createId();
    const account = await this.#options.repository.redeemLoginToken(
      digest(this.#options.tokenDigestKey, token),
      now,
      {
        absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
        authenticatedAt: now,
        idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
        membershipId: this.#options.idGenerator.createId(),
        ownerScopeId: this.#options.idGenerator.createId(),
        sessionDigest,
        sessionId,
      },
    );
    if (account === null) {
      return null;
    }
    return {
      ...account,
      csrfToken: digest(
        this.#options.sessionDigestKey,
        `csrf:${sessionSecret}`,
      ),
      sessionSecret,
    };
  }

  async authenticate(
    sessionSecret: string,
  ): Promise<AuthenticatedAccount | null> {
    if (!isOpaqueSecret(sessionSecret)) {
      return null;
    }
    return this.#options.repository.authenticateSession(
      digest(this.#options.sessionDigestKey, sessionSecret),
      this.#options.clock.now(),
    );
  }

  verifyCsrf(
    sessionSecret: string,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
  ): boolean {
    if (
      !isOpaqueSecret(sessionSecret) ||
      csrfCookie === undefined ||
      csrfHeader === undefined
    ) {
      return false;
    }
    const expected = digest(
      this.#options.sessionDigestKey,
      `csrf:${sessionSecret}`,
    );
    return safeEqual(expected, csrfCookie) && safeEqual(expected, csrfHeader);
  }

  async logout(sessionSecret: string): Promise<void> {
    if (!isOpaqueSecret(sessionSecret)) {
      return;
    }
    await this.#options.repository.revokeSession(
      digest(this.#options.sessionDigestKey, sessionSecret),
      this.#options.clock.now(),
    );
  }

  async beginDeletion(account: AuthenticatedAccount): Promise<void> {
    const now = this.#options.clock.now();
    if (now.getTime() - account.authenticatedAt.getTime() > RECENT_AUTH_MS) {
      throw new RecentAuthenticationRequiredError();
    }
    await this.#options.repository.beginDeletion(account.userId, now);
  }

  listLibrary(
    account: AuthenticatedAccount,
  ): Promise<readonly LibraryCourse[]> {
    return this.#options.repository.listLibrary(account);
  }

  listSessionHistory(
    account: AuthenticatedAccount,
  ): Promise<readonly SessionHistoryItem[]> {
    return this.#options.repository.listSessionHistory(account);
  }
}

export class AccountInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccountInputError";
  }
}

export class RecentAuthenticationRequiredError extends Error {
  constructor() {
    super("recent_authentication_required");
    this.name = "RecentAuthenticationRequiredError";
  }
}

export class FixedWindowAuthAbuseLimiter implements AuthAbuseLimiter {
  readonly #destination = new Map<string, number[]>();
  readonly #origin = new Map<string, number[]>();

  constructor(
    private readonly destinationLimit = 4,
    private readonly originLimit = 20,
    private readonly windowMs = 15 * 60 * 1_000,
  ) {}

  allow(destinationKey: string, originKey: string, now: Date): boolean {
    const destination = activeEntries(
      this.#destination.get(destinationKey),
      now,
      this.windowMs,
    );
    const origin = activeEntries(
      this.#origin.get(originKey),
      now,
      this.windowMs,
    );
    if (
      destination.length >= this.destinationLimit ||
      origin.length >= this.originLimit
    ) {
      return false;
    }
    destination.push(now.getTime());
    origin.push(now.getTime());
    this.#destination.set(destinationKey, destination);
    this.#origin.set(originKey, origin);
    return true;
  }
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new AccountInputError("invalid_email");
  }
  return normalized;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new AccountInputError("callback_origin_must_use_https");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AccountInputError("invalid_callback_origin");
  }
  return url.origin;
}

function digest(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function encryptEmail(email: string, key: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(email, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}

function isOpaqueSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function assertKey(name: string, value: Uint8Array): void {
  if (value.byteLength !== 32) {
    throw new Error(`${name} must be exactly 32 bytes`);
  }
}

function activeEntries(
  entries: number[] | undefined,
  now: Date,
  windowMs: number,
): number[] {
  const threshold = now.getTime() - windowMs;
  return (entries ?? []).filter((entry) => entry > threshold);
}
