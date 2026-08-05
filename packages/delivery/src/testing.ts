import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  type KnowledgeAuthorizationContext,
} from "@reflo/knowledge-model";
import { stableUuid } from "@reflo/retrieval";

import type {
  DeliveryAnswerFinalization,
  DeliveryAnswerInput,
  DeliveryKnowledgeUpdate,
  DeliveryMessage,
  DeliveryPreferenceSettings,
  DemoDeliveryDestination,
  DemoDeliveryProvider,
  EmailQuizPreview,
  ReservedDelivery,
} from "./contracts.js";
import { DeliveryError } from "./errors.js";
import type {
  DeliveryKnowledgePort,
  DemoDeliveryRepository,
  DemoMessagePort,
} from "./ports.js";

export class FakeDemoMessagePort implements DemoMessagePort {
  readonly messages: DeliveryMessage[] = [];

  constructor(readonly provider: DemoDeliveryProvider) {}

  async send(message: DeliveryMessage): Promise<{
    readonly providerMessageId: string;
  }> {
    this.messages.push(message);
    return {
      providerMessageId: `${this.provider}-message-${this.messages.length}`,
    };
  }
}

export class InMemoryDeliveryKnowledgePort implements DeliveryKnowledgePort {
  readonly updates: DeliveryKnowledgeUpdate[] = [];

  async record(update: DeliveryKnowledgeUpdate): Promise<void> {
    if (
      !this.updates.some(
        (current) =>
          current.evidence.attemptId === update.evidence.attemptId &&
          current.evidence.conceptId === update.evidence.conceptId,
      )
    ) {
      this.updates.push(update);
    }
  }
}

export class InMemoryDemoDeliveryRepository implements DemoDeliveryRepository {
  readonly claims = new Map<string, string>();
  readonly deliveries = new Map<string, ReservedDelivery>();
  readonly requestDeliveries = new Map<string, string>();
  readonly emailTokens = new Map<
    string,
    { readonly digest: string; readonly expiresAt: string }
  >();
  readonly finalizations = new Map<
    string,
    {
      readonly answers: string;
      readonly results: readonly DeliveryAnswerFinalization[];
    }
  >();
  readonly preferences = new Map<string, DeliveryPreferenceSettings>();
  nextDelivery: ReservedDelivery | null = null;

  async loadPreference(
    authorization: KnowledgeAuthorizationContext,
  ): Promise<DeliveryPreferenceSettings | null> {
    return this.preferences.get(preferenceKey(authorization)) ?? null;
  }

  async savePreference(
    authorization: KnowledgeAuthorizationContext,
    preference: DeliveryPreferenceSettings,
  ): Promise<DeliveryPreferenceSettings> {
    this.preferences.set(preferenceKey(authorization), preference);
    return preference;
  }

  async reserveDueBatch(
    authorization: KnowledgeAuthorizationContext,
    destination: DemoDeliveryDestination,
    request: {
      readonly expiresAt: string;
      readonly idempotencyKey: string;
      readonly now: string;
    },
  ): Promise<ReservedDelivery | null> {
    assertAuthorization(authorization, destination);
    const currentId = this.requestDeliveries.get(request.idempotencyKey);
    if (currentId !== undefined) {
      return this.deliveries.get(currentId) ?? null;
    }
    const delivery = this.nextDelivery;
    if (delivery === null || delivery.provider !== destination.provider) {
      return null;
    }
    const reserved = { ...delivery, expiresAt: request.expiresAt };
    this.deliveries.set(reserved.deliveryId, reserved);
    this.requestDeliveries.set(request.idempotencyKey, reserved.deliveryId);
    this.nextDelivery = null;
    return reserved;
  }

  async bindEmailToken(
    _authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    tokenDigest: string,
    expiresAt: string,
  ): Promise<void> {
    const current = this.emailTokens.get(deliveryId);
    if (
      current !== undefined &&
      (current.digest !== tokenDigest || current.expiresAt !== expiresAt)
    ) {
      throw new DeliveryError("conflicting_duplicate");
    }
    this.emailTokens.set(deliveryId, {
      digest: tokenDigest,
      expiresAt,
    });
  }

  async claimDispatch(
    _authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claim: { readonly leaseExpiresAt: string; readonly token: string },
  ): Promise<boolean> {
    const current = requiredDelivery(this.deliveries, deliveryId);
    if (current.status !== "pending" || this.claims.has(deliveryId)) {
      return false;
    }
    this.claims.set(deliveryId, claim.token);
    this.deliveries.set(deliveryId, { ...current, status: "processing" });
    return true;
  }

  async markSubmitted(
    _authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claimToken: string,
    providerMessageId: string,
  ): Promise<ReservedDelivery> {
    const current = requiredDelivery(this.deliveries, deliveryId);
    if (
      this.claims.get(deliveryId) !== claimToken ||
      (current.providerMessageId !== null &&
        current.providerMessageId !== providerMessageId)
    ) {
      throw new DeliveryError("conflicting_duplicate");
    }
    const submitted: ReservedDelivery = {
      ...current,
      providerMessageId,
      status: "submitted",
    };
    this.claims.delete(deliveryId);
    this.deliveries.set(deliveryId, submitted);
    return submitted;
  }

  async markDispatchFailed(
    _authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claimToken: string,
    failure: { readonly ambiguous: boolean; readonly code: string },
  ): Promise<void> {
    const current = requiredDelivery(this.deliveries, deliveryId);
    if (this.claims.get(deliveryId) !== claimToken) {
      return;
    }
    this.claims.delete(deliveryId);
    this.deliveries.set(deliveryId, {
      ...current,
      status: failure.ambiguous ? "failed" : "pending",
    });
  }

  async loadEmailPreview(
    _authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    tokenDigest: string,
    now: string,
  ): Promise<EmailQuizPreview | null> {
    const delivery = this.deliveries.get(deliveryId);
    const token = this.emailTokens.get(deliveryId);
    if (
      delivery === undefined ||
      token === undefined ||
      token.digest !== tokenDigest ||
      Date.parse(token.expiresAt) < Date.parse(now)
    ) {
      return null;
    }
    return {
      deliveryId,
      expiresAt: delivery.expiresAt,
      questions: delivery.items.map((item) => ({
        conceptId: item.conceptId,
        deliveryItemId: item.deliveryItemId,
        prompt: item.prompt,
        quizItemId: item.quizItemId,
        responseOptions: item.responseOptions,
      })),
    };
  }

  async finalizeAnswers(
    authorization: KnowledgeAuthorizationContext,
    destination: DemoDeliveryDestination,
    request: {
      readonly answers: readonly DeliveryAnswerInput[];
      readonly deliveryId: string;
      readonly providerSubmissionId: string;
      readonly submittedAt: string;
      readonly tokenDigest: string | null;
    },
  ): Promise<readonly DeliveryAnswerFinalization[]> {
    assertAuthorization(authorization, destination);
    const delivery = requiredDelivery(this.deliveries, request.deliveryId);
    const replayKey = `${delivery.provider}/${request.providerSubmissionId}`;
    const answers = JSON.stringify(request.answers);
    const replay = this.finalizations.get(replayKey);
    if (replay !== undefined) {
      if (replay.answers !== answers) {
        throw new DeliveryError("conflicting_duplicate");
      }
      return replay.results.map((result) => ({
        ...result,
        status: "replayed",
      }));
    }
    if (Date.parse(delivery.expiresAt) < Date.parse(request.submittedAt)) {
      throw new DeliveryError("delivery_expired");
    }
    if (delivery.provider === "email") {
      const token = this.emailTokens.get(delivery.deliveryId);
      if (token === undefined || token.digest !== request.tokenDigest) {
        throw new DeliveryError("invalid_signature");
      }
    }
    if (
      request.answers.length < 1 ||
      request.answers.length > delivery.items.length ||
      new Set(request.answers.map((answer) => answer.deliveryItemId)).size !==
        request.answers.length
    ) {
      throw new DeliveryError("invalid_input");
    }
    const results = request.answers.map((answer) => {
      const item = delivery.items.find(
        (candidate) => candidate.deliveryItemId === answer.deliveryItemId,
      );
      if (item === undefined) {
        throw new DeliveryError("authorization_denied");
      }
      const selected = /^\d+$/.test(answer.answer)
        ? item.responseOptions[Number(answer.answer)]
        : answer.answer;
      if (selected === undefined) {
        throw new DeliveryError("invalid_input");
      }
      const correct = selected === item.keyedAnswer;
      const attemptId = stableUuid({
        deliveryItemId: item.deliveryItemId,
        providerSubmissionId: request.providerSubmissionId,
      });
      return {
        attemptId,
        correct,
        deliveryId: delivery.deliveryId,
        deliveryPreference: {
          chosenLocalTime: "09:00",
          timeZone: "UTC",
        },
        evidence: {
          attemptId,
          conceptId: item.conceptId,
          eligibleForMastery: true,
          fsrsRating: correct ? (3 as const) : (1 as const),
          graderConfidence: null,
          gradingMethod: "keyed_mc" as const,
          gradingPolicyVersion: "grading-policy-v1",
          ineligibilityReason: null,
          judgmentKind: "scored" as const,
          knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
          knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
          rationaleRef: `keyed-mc/${item.quizItemId}`,
          ratingMappingVersion: "rating-mapping-v1",
          replacementForAttemptId: null,
          rubricBand: correct ? ("correct" as const) : ("incorrect" as const),
          rubricId: item.rubricId,
          rubricVersion: item.rubricVersion,
          score: correct ? "1.00000" : "0.00000",
          unanswerableReason: null,
        },
        status: "created" as const,
        streak: { current: 1, longest: 1 },
      };
    });
    this.finalizations.set(replayKey, { answers, results });
    return results;
  }
}

function assertAuthorization(
  authorization: KnowledgeAuthorizationContext,
  destination: DemoDeliveryDestination,
): void {
  if (
    authorization.actorId !== destination.authorization.actorId ||
    authorization.ownerScopeId !== destination.authorization.ownerScopeId
  ) {
    throw new DeliveryError("authorization_denied");
  }
}

function requiredDelivery(
  deliveries: ReadonlyMap<string, ReservedDelivery>,
  deliveryId: string,
): ReservedDelivery {
  const delivery = deliveries.get(deliveryId);
  if (delivery === undefined) {
    throw new DeliveryError("not_found");
  }
  return delivery;
}

function preferenceKey(authorization: KnowledgeAuthorizationContext): string {
  return `${authorization.ownerScopeId}/${authorization.actorId}`;
}
