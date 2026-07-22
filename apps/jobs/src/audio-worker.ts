import {
  AUDIO_MAX_DELIVERIES,
  AudioGenerationError,
  audioRetryDelayMs,
  validateAudioGenerationEnvelope,
  type AudioOperationView,
  type ConsumeAudioCommand,
} from "@reflo/audio";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

export interface AudioConsumerPort {
  consume(command: ConsumeAudioCommand): Promise<AudioOperationView>;
}

export interface AudioQueueAuthorizationResolver {
  /** Reauthorizes current actor, membership, ownership, and retention state. */
  resolve(input: {
    readonly courseId: string;
    readonly operationId: string;
  }): Promise<ScopeAuthorizationContext | null>;
}

export type AudioDeliveryDisposition =
  | {
      readonly kind: "ack";
      readonly status: "cancelled" | "expired" | "succeeded";
    }
  | {
      readonly failureClass: string;
      readonly kind: "dead_letter";
      readonly status: "failed_permanent" | "rejected";
    }
  | {
      readonly delayMs: number;
      readonly kind: "retry";
      readonly status: "retry_scheduled";
    };

export function createAudioQueueHandler(dependencies: {
  readonly authorization: AudioQueueAuthorizationResolver;
  readonly consumer: AudioConsumerPort;
}) {
  return async function handleAudioCommand(
    rawEnvelope: unknown,
    deliveryNumber: number,
  ): Promise<AudioDeliveryDisposition> {
    let envelope;
    try {
      envelope = validateAudioGenerationEnvelope(rawEnvelope);
    } catch {
      return {
        failureClass: "unsupported_contract",
        kind: "dead_letter",
        status: "rejected",
      };
    }
    if (
      !Number.isSafeInteger(deliveryNumber) ||
      deliveryNumber < 1 ||
      deliveryNumber > AUDIO_MAX_DELIVERIES
    ) {
      return {
        failureClass: "delivery_budget_invalid",
        kind: "dead_letter",
        status: "rejected",
      };
    }
    const authorization = await dependencies.authorization.resolve({
      courseId: envelope.payload.courseId,
      operationId: envelope.payload.operationId,
    });
    if (authorization === null) {
      return {
        failureClass: "authorization_denied",
        kind: "dead_letter",
        status: "rejected",
      };
    }
    try {
      const operation = await dependencies.consumer.consume({
        authorization,
        envelope,
      });
      if (operation.status === "retry_scheduled") {
        return {
          delayMs: audioRetryDelayMs(operation.id, operation.attemptCount),
          kind: "retry",
          status: operation.status,
        };
      }
      if (operation.status === "failed_permanent") {
        return {
          failureClass: operation.failureClass ?? "provider_failure",
          kind: "dead_letter",
          status: operation.status,
        };
      }
      if (
        operation.status === "succeeded" ||
        operation.status === "cancelled" ||
        operation.status === "expired"
      ) {
        return { kind: "ack", status: operation.status };
      }
      return {
        delayMs: audioRetryDelayMs(operation.id, operation.attemptCount),
        kind: "retry",
        status: "retry_scheduled",
      };
    } catch (error) {
      if (
        error instanceof AudioGenerationError &&
        ["authorization_denied", "invalid_envelope"].includes(error.code)
      ) {
        return {
          failureClass: error.code,
          kind: "dead_letter",
          status: "rejected",
        };
      }
      if (deliveryNumber >= AUDIO_MAX_DELIVERIES) {
        return {
          failureClass: "delivery_exhausted",
          kind: "dead_letter",
          status: "rejected",
        };
      }
      return {
        delayMs: audioRetryDelayMs(
          envelope.payload.operationId,
          deliveryNumber,
        ),
        kind: "retry",
        status: "retry_scheduled",
      };
    }
  };
}
