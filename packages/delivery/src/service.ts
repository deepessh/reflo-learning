import {
  createHmac,
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { canonicalJson } from "@reflo/retrieval";

import {
  DEMO_DELIVERY_CONTRACT_VERSION,
  EMAIL_LINK_CONTRACT_VERSION,
  type DeliveryAnswerInput,
  type DeliveryDispatchResult,
  type DeliveryPreferenceSettings,
  type DeliveryPreferenceView,
  type DeliveryQuestion,
  type DemoDeliveryDestination,
  type DemoDeliveryProvider,
  type EmailQuizPreview,
  type ReservedDelivery,
  type TelegramCallback,
} from "./contracts.js";
import { DeliveryError } from "./errors.js";
import { REVIEW_QUIZ_PATH } from "./experience.js";
import type {
  DeliveryKnowledgePort,
  DemoDeliveryRepository,
  DemoMessagePort,
} from "./ports.js";

const EMAIL_LINK_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DISPATCH_LEASE_MS = 10 * 60 * 1_000;
const MAX_WEBHOOK_BYTES = 16_384;

export class DemoDeliveryService {
  readonly #destinations: readonly DemoDeliveryDestination[];
  readonly #ports: ReadonlyMap<DemoDeliveryProvider, DemoMessagePort>;

  constructor(
    private readonly dependencies: {
      readonly destinations: readonly DemoDeliveryDestination[];
      readonly defaultPreference: DeliveryPreferenceSettings;
      readonly allowLocalHttpEmailOrigin?: boolean;
      readonly emailLinkOrigin?: string;
      readonly emailLinkSigningKey?: Uint8Array;
      readonly knowledge: DeliveryKnowledgePort;
      readonly messagePorts: readonly DemoMessagePort[];
      readonly repository: DemoDeliveryRepository;
    },
  ) {
    this.#destinations = validateDestinations(dependencies.destinations);
    validatePreference(dependencies.defaultPreference);
    this.#ports = new Map(
      dependencies.messagePorts.map((port) => [port.provider, port]),
    );
    const hasEmail = this.#destinations.some(
      (destination) => destination.provider === "email",
    );
    if (
      (hasEmail &&
        (dependencies.emailLinkSigningKey?.byteLength !== 32 ||
          !validEmailLinkOrigin(
            dependencies.emailLinkOrigin ?? "",
            dependencies.allowLocalHttpEmailOrigin === true,
          ))) ||
      new Set(dependencies.messagePorts.map((port) => port.provider)).size !==
        dependencies.messagePorts.length
    ) {
      throw new DeliveryError("invalid_configuration");
    }
  }

  async dispatch(command: {
    readonly authorization: DemoDeliveryDestination["authorization"];
    readonly idempotencyKey: string;
    readonly now: string;
  }): Promise<DeliveryDispatchResult | null> {
    validateIdentity(command.idempotencyKey);
    const now = parseTimestamp(command.now);
    const preference = await this.#preference(command.authorization);
    const destination = this.#destinationForAuthorization(
      command.authorization,
      preference.provider,
    );
    const port = this.#ports.get(preference.provider);
    if (port === undefined) {
      throw new DeliveryError("invalid_configuration");
    }
    const delivery = await this.dependencies.repository.reserveDueBatch(
      command.authorization,
      destination,
      {
        expiresAt: new Date(now + EMAIL_LINK_LIFETIME_MS).toISOString(),
        idempotencyKey: `${DEMO_DELIVERY_CONTRACT_VERSION}/${command.idempotencyKey}`,
        now: new Date(now).toISOString(),
      },
    );
    if (delivery === null) {
      return null;
    }
    if (delivery.status === "submitted" || delivery.status === "delivered") {
      return { delivery: publicDelivery(delivery), status: "replayed" };
    }
    if (delivery.status === "processing") {
      throw new DeliveryError("dispatch_ambiguous");
    }
    if (delivery.status !== "pending") {
      throw new DeliveryError(
        delivery.status === "expired" ? "delivery_expired" : "dispatch_failed",
      );
    }

    let emailLink: string | null = null;
    if (delivery.provider === "email") {
      const token = this.#emailToken(delivery, destination);
      emailLink = `${this.#emailLinkOrigin()}${REVIEW_QUIZ_PATH}?token=${encodeURIComponent(token)}`;
      await this.dependencies.repository.bindEmailToken(
        command.authorization,
        delivery.deliveryId,
        tokenDigest(token),
        delivery.expiresAt,
      );
    }

    const claimToken = randomUUID();
    const claimed = await this.dependencies.repository.claimDispatch(
      command.authorization,
      delivery.deliveryId,
      {
        leaseExpiresAt: new Date(now + DISPATCH_LEASE_MS).toISOString(),
        token: claimToken,
      },
    );
    if (!claimed) {
      throw new DeliveryError("dispatch_ambiguous");
    }

    let providerAccepted = false;
    try {
      const submitted = await port.send({
        deliveryId: delivery.deliveryId,
        emailLink,
        expiresAt: delivery.expiresAt,
        provider: delivery.provider,
        questions: delivery.items.map(publicQuestion),
        recipient: destination.recipient,
      });
      providerAccepted = true;
      const finalized = await this.dependencies.repository.markSubmitted(
        command.authorization,
        delivery.deliveryId,
        claimToken,
        submitted.providerMessageId,
      );
      return { delivery: publicDelivery(finalized), status: "created" };
    } catch (error) {
      const ambiguous =
        providerAccepted ||
        (error instanceof DeliveryError && error.code === "dispatch_ambiguous");
      await this.dependencies.repository.markDispatchFailed(
        command.authorization,
        delivery.deliveryId,
        claimToken,
        {
          ambiguous,
          code: error instanceof DeliveryError ? error.code : "dispatch_failed",
        },
      );
      throw new DeliveryError(
        ambiguous ? "dispatch_ambiguous" : "dispatch_failed",
      );
    }
  }

  async getPreference(
    authorization: DemoDeliveryDestination["authorization"],
  ): Promise<DeliveryPreferenceView> {
    const preference = await this.#preference(authorization);
    return {
      ...preference,
      availableProviders: this.#availableProviders(authorization),
    };
  }

  async updatePreference(
    authorization: DemoDeliveryDestination["authorization"],
    preference: DeliveryPreferenceSettings,
  ): Promise<DeliveryPreferenceView> {
    validatePreference(preference);
    this.#destinationForAuthorization(authorization, preference.provider);
    const saved = await this.dependencies.repository.savePreference(
      authorization,
      preference,
    );
    return {
      ...saved,
      availableProviders: this.#availableProviders(authorization),
    };
  }

  async handleTelegramWebhook(
    rawBody: string,
    secretToken: string | undefined,
  ): Promise<
    readonly {
      readonly attemptId: string;
      readonly correct: boolean;
      readonly status: "created" | "replayed";
      readonly streak: {
        readonly current: number;
        readonly longest: number;
      };
    }[]
  > {
    if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) {
      throw new DeliveryError("invalid_input");
    }
    const callback = parseTelegramCallback(rawBody);
    const destination = this.#destinations.find(
      (candidate) =>
        candidate.provider === "telegram" &&
        candidate.recipient === callback.chatId &&
        candidate.recipient === callback.senderId,
    );
    if (
      destination === undefined ||
      destination.telegramWebhookSecret === undefined ||
      !safeEqual(destination.telegramWebhookSecret, secretToken ?? "")
    ) {
      throw new DeliveryError("invalid_signature");
    }
    const preview = await this.dependencies.repository.finalizeAnswers(
      destination.authorization,
      destination,
      {
        answers: [
          {
            answer: String(callback.answerIndex),
            deliveryItemId: callback.deliveryItemId,
          },
        ],
        deliveryId: deliveryIdFromCallback(rawBody),
        providerSubmissionId: callback.providerSubmissionId,
        submittedAt: new Date().toISOString(),
        tokenDigest: null,
      },
    );
    await this.#recordKnowledge(destination, preview);
    return preview.map((result) => ({
      attemptId: result.attemptId,
      correct: result.correct,
      status: result.status,
      streak: result.streak,
    }));
  }

  async previewEmail(
    authorization: DemoDeliveryDestination["authorization"],
    token: string,
    now: string,
  ): Promise<EmailQuizPreview> {
    const claims = this.#verifyEmailToken(token, now);
    assertClaimAuthorization(claims, authorization);
    const destination = this.#destinationForAuthorization(
      authorization,
      "email",
    );
    if (destination.channelIdentityId !== claims.channelIdentityId) {
      throw new DeliveryError("authorization_denied");
    }
    const preview = await this.dependencies.repository.loadEmailPreview(
      authorization,
      claims.deliveryId,
      tokenDigest(token),
      now,
    );
    if (preview === null) {
      throw new DeliveryError("not_found");
    }
    return preview;
  }

  async submitEmail(
    authorization: DemoDeliveryDestination["authorization"],
    token: string,
    answers: readonly DeliveryAnswerInput[],
    now: string,
  ): Promise<
    readonly {
      readonly attemptId: string;
      readonly correct: boolean;
      readonly status: "created" | "replayed";
      readonly streak: {
        readonly current: number;
        readonly longest: number;
      };
    }[]
  > {
    const claims = this.#verifyEmailToken(token, now);
    assertClaimAuthorization(claims, authorization);
    const destination = this.#destinationForAuthorization(
      authorization,
      "email",
    );
    const finalizations = await this.dependencies.repository.finalizeAnswers(
      authorization,
      destination,
      {
        answers,
        deliveryId: claims.deliveryId,
        providerSubmissionId: claims.tokenId,
        submittedAt: now,
        tokenDigest: tokenDigest(token),
      },
    );
    await this.#recordKnowledge(destination, finalizations);
    return finalizations.map((result) => ({
      attemptId: result.attemptId,
      correct: result.correct,
      status: result.status,
      streak: result.streak,
    }));
  }

  async #recordKnowledge(
    destination: DemoDeliveryDestination,
    finalizations: Awaited<
      ReturnType<DemoDeliveryRepository["finalizeAnswers"]>
    >,
  ): Promise<void> {
    for (const finalization of finalizations) {
      await this.dependencies.knowledge.record({
        authorization: destination.authorization,
        deliveryPreference: finalization.deliveryPreference,
        evidence: finalization.evidence,
      });
    }
  }

  #destinationForAuthorization(
    authorization: DemoDeliveryDestination["authorization"],
    provider: DemoDeliveryProvider,
  ): DemoDeliveryDestination {
    const destination = this.#destinations.find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.authorization.actorId === authorization.actorId &&
        candidate.authorization.ownerScopeId === authorization.ownerScopeId,
    );
    if (destination === undefined) {
      throw new DeliveryError("authorization_denied");
    }
    return destination;
  }

  async #preference(
    authorization: DemoDeliveryDestination["authorization"],
  ): Promise<DeliveryPreferenceSettings> {
    const persisted =
      await this.dependencies.repository.loadPreference(authorization);
    const preference = persisted ?? this.dependencies.defaultPreference;
    validatePreference(preference);
    this.#destinationForAuthorization(authorization, preference.provider);
    return preference;
  }

  #availableProviders(
    authorization: DemoDeliveryDestination["authorization"],
  ): readonly DemoDeliveryProvider[] {
    return this.#destinations
      .filter(
        (destination) =>
          destination.authorization.actorId === authorization.actorId &&
          destination.authorization.ownerScopeId === authorization.ownerScopeId,
      )
      .map((destination) => destination.provider);
  }

  #emailToken(
    delivery: ReservedDelivery,
    destination: DemoDeliveryDestination,
  ): string {
    const claims: EmailTokenClaims = {
      channelIdentityId: destination.channelIdentityId,
      deliveryId: delivery.deliveryId,
      expiresAt: delivery.expiresAt,
      ownerScopeId: destination.authorization.ownerScopeId,
      tokenId: tokenDigest(`token/${delivery.deliveryId}`).slice(0, 36),
      userId: destination.authorization.actorId,
      version: EMAIL_LINK_CONTRACT_VERSION,
    };
    const payload = Buffer.from(canonicalJson(claims)).toString("base64url");
    return `${payload}.${this.#sign(payload)}`;
  }

  #verifyEmailToken(token: string, now: string): EmailTokenClaims {
    const [payload, signature, extra] = token.split(".");
    if (
      payload === undefined ||
      signature === undefined ||
      extra !== undefined ||
      !safeEqual(this.#sign(payload), signature)
    ) {
      throw new DeliveryError("invalid_signature");
    }
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new DeliveryError("invalid_signature");
    }
    if (!validEmailClaims(claims)) {
      throw new DeliveryError("invalid_signature");
    }
    if (parseTimestamp(claims.expiresAt) < parseTimestamp(now)) {
      throw new DeliveryError("delivery_expired");
    }
    return claims;
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#emailSigningKey())
      .update(payload)
      .digest("base64url");
  }

  #emailLinkOrigin(): string {
    const origin = this.dependencies.emailLinkOrigin;
    if (origin === undefined) throw new DeliveryError("invalid_configuration");
    return origin;
  }

  #emailSigningKey(): Uint8Array {
    const key = this.dependencies.emailLinkSigningKey;
    if (key === undefined) throw new DeliveryError("invalid_configuration");
    return key;
  }
}

interface EmailTokenClaims {
  readonly channelIdentityId: string;
  readonly deliveryId: string;
  readonly expiresAt: string;
  readonly ownerScopeId: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly version: typeof EMAIL_LINK_CONTRACT_VERSION;
}

function validateDestinations(
  destinations: readonly DemoDeliveryDestination[],
): readonly DemoDeliveryDestination[] {
  if (
    destinations.length === 0 ||
    new Set(
      destinations.map(
        (destination) =>
          `${destination.provider}/${destination.channelIdentityId}`,
      ),
    ).size !== destinations.length ||
    destinations.some(
      (destination) =>
        destination.recipient.length === 0 ||
        !/^[0-9a-f]{64}$/.test(destination.recipientLookupDigest) ||
        destination.authorization.authorizationId.length === 0 ||
        (destination.provider === "telegram" &&
          (!/^\d+$/.test(destination.recipient) ||
            !/^[A-Za-z0-9_-]{16,256}$/.test(
              destination.telegramWebhookSecret ?? "",
            ))),
    )
  ) {
    throw new DeliveryError("invalid_configuration");
  }
  return destinations;
}

function validatePreference(preference: DeliveryPreferenceSettings): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preference.chosenLocalTime)) {
    throw new DeliveryError("invalid_input");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: preference.timeZone });
  } catch {
    throw new DeliveryError("invalid_input");
  }
}

function publicQuestion(
  item: ReservedDelivery["items"][number],
): DeliveryQuestion {
  return {
    conceptId: item.conceptId,
    deliveryItemId: item.deliveryItemId,
    prompt: item.prompt,
    quizItemId: item.quizItemId,
    responseOptions: item.responseOptions,
  };
}

function publicDelivery(
  delivery: ReservedDelivery,
): DeliveryDispatchResult["delivery"] {
  return {
    ...delivery,
    items: delivery.items.map(publicQuestion),
  };
}

function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.endsWith("Z")) {
    throw new DeliveryError("invalid_input");
  }
  return parsed;
}

function validateIdentity(value: string): void {
  if (
    value.length < 1 ||
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new DeliveryError("invalid_input");
  }
}

function validEmailLinkOrigin(value: string, allowLocalHttp: boolean): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (allowLocalHttp &&
          url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validEmailClaims(value: unknown): value is EmailTokenClaims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    claims.version === EMAIL_LINK_CONTRACT_VERSION &&
    typeof claims.channelIdentityId === "string" &&
    typeof claims.deliveryId === "string" &&
    typeof claims.expiresAt === "string" &&
    typeof claims.ownerScopeId === "string" &&
    typeof claims.tokenId === "string" &&
    typeof claims.userId === "string"
  );
}

function assertClaimAuthorization(
  claims: EmailTokenClaims,
  authorization: DemoDeliveryDestination["authorization"],
): void {
  if (
    claims.ownerScopeId !== authorization.ownerScopeId ||
    claims.userId !== authorization.actorId
  ) {
    throw new DeliveryError("authorization_denied");
  }
}

function parseTelegramCallback(rawBody: string): TelegramCallback {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new DeliveryError("invalid_input");
  }
  const update = asObject(value);
  const callback = asObject(update?.callback_query);
  const message = asObject(callback?.message);
  const chat = asObject(message?.chat);
  const sender = asObject(callback?.from);
  const data = typeof callback?.data === "string" ? callback.data : "";
  const match =
    /^reflo:([0-9a-f-]{36}):([0-9a-f-]{36}):([0-9]|[1-9][0-9])$/i.exec(data);
  if (
    callback === null ||
    chat === null ||
    sender === null ||
    match === null ||
    !/^\d+$/.test(String(chat.id)) ||
    !/^\d+$/.test(String(sender.id)) ||
    (typeof callback.id !== "string" && typeof update?.update_id !== "number")
  ) {
    throw new DeliveryError("invalid_input");
  }
  return {
    answerIndex: Number(match[3]),
    chatId: String(chat.id),
    deliveryItemId: match[2]!,
    providerSubmissionId:
      typeof callback.id === "string" ? callback.id : String(update?.update_id),
    senderId: String(sender.id),
  };
}

function deliveryIdFromCallback(rawBody: string): string {
  const value = asObject(JSON.parse(rawBody));
  const callback = asObject(value?.callback_query);
  const data = typeof callback?.data === "string" ? callback.data : "";
  const match = /^reflo:([0-9a-f-]{36}):/i.exec(data);
  if (match === null) {
    throw new DeliveryError("invalid_input");
  }
  return match[1]!;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
