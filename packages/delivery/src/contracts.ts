import type {
  AssessmentEvidenceWrite,
  DeliveryPreference,
  KnowledgeAuthorizationContext,
} from "@reflo/knowledge-model";

export const DEMO_DELIVERY_CONTRACT_VERSION = "demo-delivery-v1" as const;
export const EMAIL_LINK_CONTRACT_VERSION = "demo-email-link-v1" as const;

export type DemoDeliveryProvider = "email" | "telegram";

export interface DeliveryPreferenceSettings extends DeliveryPreference {
  readonly provider: DemoDeliveryProvider;
}

export interface DeliveryPreferenceView extends DeliveryPreferenceSettings {
  readonly availableProviders: readonly DemoDeliveryProvider[];
}

export interface DemoDeliveryDestination {
  readonly authorization: KnowledgeAuthorizationContext;
  readonly channelIdentityId: string;
  readonly provider: DemoDeliveryProvider;
  readonly recipient: string;
  readonly recipientLookupDigest: string;
  readonly telegramWebhookSecret?: string;
}

export interface DeliveryQuestion {
  readonly conceptId: string;
  readonly deliveryItemId: string;
  readonly prompt: string;
  readonly quizItemId: string;
  readonly responseOptions: readonly string[];
}

export interface ReservedDeliveryItem extends DeliveryQuestion {
  readonly keyedAnswer: string;
  readonly reviewScheduleId: string;
  readonly rubricId: string;
  readonly rubricVersion: string;
}

export interface ReservedDelivery {
  readonly deliveryId: string;
  readonly expiresAt: string;
  readonly items: readonly ReservedDeliveryItem[];
  readonly provider: DemoDeliveryProvider;
  readonly providerMessageId: string | null;
  readonly status:
    | "cancelled"
    | "delivered"
    | "expired"
    | "failed"
    | "pending"
    | "processing"
    | "submitted";
}

export interface DeliveryMessage {
  readonly deliveryId: string;
  readonly emailLink: string | null;
  readonly expiresAt: string;
  readonly provider: DemoDeliveryProvider;
  readonly questions: readonly DeliveryQuestion[];
  readonly recipient: string;
}

export interface DeliveryDispatchResult {
  readonly delivery: Omit<ReservedDelivery, "items"> & {
    readonly items: readonly DeliveryQuestion[];
  };
  readonly status: "created" | "replayed";
}

export interface DeliveryAnswerInput {
  readonly answer: string;
  readonly deliveryItemId: string;
}

export interface DeliveryAnswerFinalization {
  readonly attemptId: string;
  readonly correct: boolean;
  readonly deliveryId: string;
  readonly deliveryPreference: DeliveryPreference;
  readonly evidence: AssessmentEvidenceWrite;
  readonly status: "created" | "replayed";
  readonly streak: {
    readonly current: number;
    readonly longest: number;
  };
}

export interface EmailQuizPreview {
  readonly deliveryId: string;
  readonly expiresAt: string;
  readonly questions: readonly DeliveryQuestion[];
}

export interface TelegramCallback {
  readonly answerIndex: number;
  readonly chatId: string;
  readonly deliveryItemId: string;
  readonly providerSubmissionId: string;
  readonly senderId: string;
}

export interface DeliveryKnowledgeUpdate {
  readonly authorization: KnowledgeAuthorizationContext;
  readonly deliveryPreference: DeliveryPreference;
  readonly evidence: AssessmentEvidenceWrite;
}
