import type { KnowledgeAuthorizationContext } from "@reflo/knowledge-model";

import type {
  DeliveryAnswerFinalization,
  DeliveryAnswerInput,
  DeliveryKnowledgeUpdate,
  DeliveryMessage,
  DemoDeliveryDestination,
  DemoDeliveryProvider,
  EmailQuizPreview,
  ReservedDelivery,
} from "./contracts.js";

export interface DemoDeliveryRepository {
  bindEmailToken(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    tokenDigest: string,
    expiresAt: string,
  ): Promise<void>;

  claimDispatch(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claim: {
      readonly leaseExpiresAt: string;
      readonly token: string;
    },
  ): Promise<boolean>;

  finalizeAnswers(
    authorization: KnowledgeAuthorizationContext,
    destination: DemoDeliveryDestination,
    request: {
      readonly answers: readonly DeliveryAnswerInput[];
      readonly deliveryId: string;
      readonly providerSubmissionId: string;
      readonly submittedAt: string;
      readonly tokenDigest: string | null;
    },
  ): Promise<readonly DeliveryAnswerFinalization[]>;

  loadEmailPreview(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    tokenDigest: string,
    now: string,
  ): Promise<EmailQuizPreview | null>;

  markDispatchFailed(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claimToken: string,
    failure: {
      readonly ambiguous: boolean;
      readonly code: string;
    },
  ): Promise<void>;

  markSubmitted(
    authorization: KnowledgeAuthorizationContext,
    deliveryId: string,
    claimToken: string,
    providerMessageId: string,
  ): Promise<ReservedDelivery>;

  reserveDueBatch(
    authorization: KnowledgeAuthorizationContext,
    destination: DemoDeliveryDestination,
    request: {
      readonly expiresAt: string;
      readonly idempotencyKey: string;
      readonly now: string;
    },
  ): Promise<ReservedDelivery | null>;
}

export interface DemoMessagePort {
  readonly provider: DemoDeliveryProvider;
  send(message: DeliveryMessage): Promise<{
    readonly providerMessageId: string;
  }>;
}

export interface DeliveryKnowledgePort {
  record(update: DeliveryKnowledgeUpdate): Promise<void>;
}
