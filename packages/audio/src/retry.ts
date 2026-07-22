import { AUDIO_MAX_DELIVERIES } from "./contracts.js";
import { AudioGenerationError } from "./errors.js";

export const AUDIO_RETRYABLE_FAILURE_CLASSES = Object.freeze([
  "adapter_unavailable",
  "infrastructure_unavailable",
  "provider_failure",
] as const);

export function audioRetryDelayMs(
  operationId: string,
  deliveryNumber: number,
): number {
  if (
    !/^[a-zA-Z0-9_-]{8,128}$/.test(operationId) ||
    !Number.isSafeInteger(deliveryNumber) ||
    deliveryNumber < 1 ||
    deliveryNumber >= AUDIO_MAX_DELIVERIES
  ) {
    throw new AudioGenerationError("invalid_configuration");
  }
  const baseMs = Math.min(60_000, 2_000 * 2 ** (deliveryNumber - 1));
  let hash = 2_166_136_261;
  for (const character of `${operationId}:${deliveryNumber}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const jitter = 0.75 + (hash / 0xffffffff) * 0.5;
  return Math.max(1, Math.round(baseMs * jitter));
}

export function canScheduleAudioRetry(input: {
  readonly deadlineAt: Date;
  readonly deliveryNumber: number;
  readonly now: Date;
  readonly operationId: string;
}): boolean {
  const delayMs = audioRetryDelayMs(input.operationId, input.deliveryNumber);
  return input.now.getTime() + delayMs < input.deadlineAt.getTime();
}
