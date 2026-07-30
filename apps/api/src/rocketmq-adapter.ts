import {
  ForbiddenException,
  Producer,
  ProxyTimeoutException,
  SimpleConsumer,
  TooManyRequestsException,
  UnauthorizedException,
  type ILogger,
  type MessageView,
  type ProducerOptions,
  type SimpleConsumerOptions,
} from "rocketmq-client-nodejs";

import type { RefloEventEnvelope } from "@reflo/db";

import {
  RocketMqPublishingError,
  type RocketMqPublishingPort,
} from "./outbox-relay.js";

interface ProducerLike {
  send(input: {
    readonly body: Buffer;
    readonly keys: string[];
    readonly properties: Map<string, string>;
    readonly topic: string;
  }): Promise<unknown>;
  shutdown(): Promise<void>;
  startup(): Promise<void>;
}

interface ConsumerLike {
  ack(message: MessageView): Promise<void>;
  receive(
    maxMessageNumber: number,
    invisibleDurationMs: number,
  ): Promise<readonly MessageView[]>;
  shutdown(): Promise<void>;
  startup(): Promise<void>;
}

export interface RocketMqAdapterConfiguration {
  readonly endpoints: string;
  readonly namespace: string;
  readonly requestTimeoutMs: number;
  readonly topic: string;
}

export interface RocketMqDeadLetterRecord {
  readonly bornAt?: Date;
  readonly body: Uint8Array;
  readonly deliveryNumber: number;
  acknowledge(): Promise<void>;
}

const silentLogger: ILogger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

export class RocketMqPublisher implements RocketMqPublishingPort {
  readonly #producer: ProducerLike;
  readonly #topic: string;

  constructor(
    configuration: RocketMqAdapterConfiguration,
    factory: (options: ProducerOptions) => ProducerLike = (options) =>
      new Producer(options),
  ) {
    assertAdapterConfiguration(configuration);
    this.#topic = configuration.topic;
    this.#producer = factory({
      endpoints: configuration.endpoints,
      logger: silentLogger,
      maxAttempts: 1,
      namespace: configuration.namespace,
      requestTimeout: configuration.requestTimeoutMs,
      topic: configuration.topic,
    });
  }

  startup(): Promise<void> {
    return this.#producer.startup();
  }

  async publish(envelope: RefloEventEnvelope): Promise<void> {
    let receipt: unknown;
    try {
      receipt = await this.#producer.send({
        body: Buffer.from(JSON.stringify(envelope), "utf8"),
        keys: [envelope.messageId],
        properties: new Map([["reflo_message_id", envelope.messageId]]),
        topic: this.#topic,
      });
    } catch (error) {
      throw new RocketMqPublishingError(normalizeFailure(error));
    }
    if (!validReceipt(receipt)) {
      throw new RocketMqPublishingError("invalid_receipt");
    }
  }

  shutdown(): Promise<void> {
    return this.#producer.shutdown();
  }
}

export class RocketMqDeadLetterConsumer {
  readonly #consumer: ConsumerLike;
  readonly #invisibleDurationMs: number;

  constructor(
    configuration: RocketMqAdapterConfiguration & {
      readonly awaitDurationMs: number;
      readonly consumerGroup: string;
      readonly invisibleDurationMs: number;
    },
    factory: (options: SimpleConsumerOptions) => ConsumerLike = (options) =>
      new SimpleConsumer(options),
  ) {
    assertAdapterConfiguration(configuration);
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(configuration.consumerGroup) ||
      !Number.isSafeInteger(configuration.awaitDurationMs) ||
      configuration.awaitDurationMs < 100 ||
      configuration.awaitDurationMs > 10_000 ||
      !Number.isSafeInteger(configuration.invisibleDurationMs) ||
      configuration.invisibleDurationMs < 10_000 ||
      configuration.invisibleDurationMs > 5 * 60_000
    ) {
      throw new Error("RocketMQ dead-letter consumer configuration is invalid");
    }
    this.#invisibleDurationMs = configuration.invisibleDurationMs;
    this.#consumer = factory({
      awaitDuration: configuration.awaitDurationMs,
      consumerGroup: configuration.consumerGroup,
      endpoints: configuration.endpoints,
      logger: silentLogger,
      maxRetryAttempts: 1,
      namespace: configuration.namespace,
      requestTimeout: configuration.requestTimeoutMs,
      subscriptions: new Map([[configuration.topic, "*"]]),
    });
  }

  startup(): Promise<void> {
    return this.#consumer.startup();
  }

  shutdown(): Promise<void> {
    return this.#consumer.shutdown();
  }

  async receive(
    batchSize: number,
  ): Promise<readonly RocketMqDeadLetterRecord[]> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10) {
      throw new Error("RocketMQ dead-letter batch size is invalid");
    }
    const messages = await this.#consumer.receive(
      batchSize,
      this.#invisibleDurationMs,
    );
    return messages.map((message) => ({
      acknowledge: () => this.#consumer.ack(message),
      ...(message.bornTimestamp === undefined
        ? {}
        : { bornAt: new Date(message.bornTimestamp) }),
      body: Buffer.from(message.body),
      deliveryNumber: message.deliveryAttempt ?? 1,
    }));
  }
}

function assertAdapterConfiguration(
  configuration: RocketMqAdapterConfiguration,
): void {
  if (
    configuration.endpoints.length < 3 ||
    configuration.endpoints.length > 512 ||
    /[/?#@\s]/.test(configuration.endpoints) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(configuration.namespace) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(configuration.topic) ||
    !Number.isSafeInteger(configuration.requestTimeoutMs) ||
    configuration.requestTimeoutMs < 1_000 ||
    configuration.requestTimeoutMs > 10_000
  ) {
    throw new Error("RocketMQ adapter configuration is invalid");
  }
}

function validReceipt(
  receipt: unknown,
): receipt is { readonly messageId: string; readonly offset: number } {
  if (typeof receipt !== "object" || receipt === null) {
    return false;
  }
  const candidate = receipt as Readonly<Record<string, unknown>>;
  return (
    typeof candidate.messageId === "string" &&
    candidate.messageId.length >= 1 &&
    candidate.messageId.length <= 512 &&
    Number.isSafeInteger(candidate.offset) &&
    Number(candidate.offset) >= 0
  );
}

function normalizeFailure(error: unknown) {
  if (error instanceof TooManyRequestsException) {
    return "throttled" as const;
  }
  if (error instanceof ProxyTimeoutException) {
    return "publication_timeout" as const;
  }
  if (
    error instanceof UnauthorizedException ||
    error instanceof ForbiddenException
  ) {
    return "broker_unavailable" as const;
  }
  return "broker_unavailable" as const;
}
