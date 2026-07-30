import type { RefloEventEnvelope, RocketMqFailureClass } from "@reflo/db";

export interface OutboxRelayRepository {
  claimOutbox(
    batchSize: number,
    now: Date,
  ): Promise<readonly RefloEventEnvelope[]>;
  markOutboxPublished(messageId: string, now: Date): Promise<boolean>;
  releaseOutbox(
    messageId: string,
    failureClass: RocketMqFailureClass,
  ): Promise<boolean>;
}

export interface RocketMqPublishingPort {
  publish(envelope: RefloEventEnvelope): Promise<void>;
  shutdown(): Promise<void>;
  startup(): Promise<void>;
}

export interface OutboxRelayResult {
  readonly ambiguous: number;
  readonly claimed: number;
  readonly failureClasses: Readonly<
    Partial<Record<RocketMqFailureClass, number>>
  >;
  readonly published: number;
  readonly released: number;
}

export class RocketMqPublishingError extends Error {
  constructor(readonly failureClass: RocketMqFailureClass) {
    super(`RocketMQ publication failed: ${failureClass}`);
    this.name = "RocketMqPublishingError";
  }
}

export class OutboxRelay {
  readonly #batchSize: number;
  readonly #clock: { now(): Date };
  readonly #publisher: RocketMqPublishingPort;
  readonly #repository: OutboxRelayRepository;
  readonly #validate: (input: unknown) => RefloEventEnvelope;

  constructor(input: {
    readonly batchSize: number;
    readonly clock?: { now(): Date };
    readonly publisher: RocketMqPublishingPort;
    readonly repository: OutboxRelayRepository;
    readonly validate: (input: unknown) => RefloEventEnvelope;
  }) {
    if (
      !Number.isSafeInteger(input.batchSize) ||
      input.batchSize < 1 ||
      input.batchSize > 25
    ) {
      throw new Error("outbox relay batch size is invalid");
    }
    this.#batchSize = input.batchSize;
    this.#clock = input.clock ?? { now: () => new Date() };
    this.#publisher = input.publisher;
    this.#repository = input.repository;
    this.#validate = input.validate;
  }

  async runOnce(): Promise<OutboxRelayResult> {
    const messages = await this.#repository.claimOutbox(
      this.#batchSize,
      this.#clock.now(),
    );
    let ambiguous = 0;
    const failureClasses: Partial<Record<RocketMqFailureClass, number>> = {};
    let published = 0;
    let released = 0;
    await Promise.all(
      messages.map(async (rawEnvelope) => {
        const envelope = this.#validate(rawEnvelope);
        try {
          await this.#publisher.publish(envelope);
        } catch (error) {
          const failureClass =
            error instanceof RocketMqPublishingError
              ? error.failureClass
              : "unknown_transient";
          failureClasses[failureClass] =
            (failureClasses[failureClass] ?? 0) + 1;
          if (
            failureClass === "publication_timeout" ||
            failureClass === "invalid_receipt" ||
            failureClass === "unknown_transient"
          ) {
            ambiguous += 1;
          }
          if (
            await this.#repository.releaseOutbox(
              envelope.messageId,
              failureClass,
            )
          ) {
            released += 1;
          }
          return;
        }
        if (
          await this.#repository.markOutboxPublished(
            envelope.messageId,
            this.#clock.now(),
          )
        ) {
          published += 1;
        } else {
          ambiguous += 1;
        }
      }),
    );
    return {
      ambiguous,
      claimed: messages.length,
      failureClasses,
      published,
      released,
    };
  }
}

export async function runOutboxRelayLoop(input: {
  readonly onResult?: (result: OutboxRelayResult) => void;
  readonly pollIntervalMs: number;
  readonly relay: OutboxRelay;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < 100 ||
    input.pollIntervalMs > 60_000
  ) {
    throw new Error("outbox relay poll interval is invalid");
  }
  while (!input.signal.aborted) {
    const result = await input.relay.runOnce();
    input.onResult?.(result);
    if (result.claimed === 0) {
      await abortableDelay(input.pollIntervalMs, input.signal);
    }
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
