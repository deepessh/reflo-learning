import { validateAudioGenerationEnvelope } from "@reflo/audio";
import type {
  RedriveClaimResult,
  RefloEventEnvelope,
  RocketMqRedriveReasonCode,
} from "@reflo/db";

import {
  RocketMqPublishingError,
  type RocketMqPublishingPort,
} from "./outbox-relay.js";
import type { RocketMqDeadLetterRecord } from "./rocketmq-adapter.js";

const MAX_WRAPPER_BYTES = 32 * 1024;
const MAX_OPERATOR_DELIVERY_NUMBER = 1;
const CLOUD_EVENT_KEYS = new Set([
  "aliyunaccountid",
  "aliyuneventbusname",
  "aliyuneventid",
  "aliyunoriginalaccountid",
  "aliyunpublishaddr",
  "aliyunpublishtime",
  "aliyunregionid",
  "data",
  "datacontenttype",
  "id",
  "source",
  "specversion",
  "subject",
  "time",
  "type",
]);
const DATA_KEYS = new Set([
  "body",
  "msgId",
  "systemProperties",
  "topic",
  "userProperties",
]);
const SYSTEM_PROPERTY_KEYS = new Set([
  "BORN_HOST",
  "BORN_TIMESTAMP",
  "CONSUME_START_TIME",
  "INSTANCE_ID",
  "KEYS",
  "MAX_OFFSET",
  "MESSAGE_ID",
  "MIN_OFFSET",
  "MSG_REGION",
  "RECONSUME_TIMES",
  "TAG",
  "TAGS",
  "TRACE_ON",
  "UNIQ_KEY",
]);

export interface RedriveRepository {
  claimRedrive(input: {
    readonly messageId: string;
    readonly now: Date;
    readonly reasonCode: RocketMqRedriveReasonCode;
    readonly requestKey: string;
  }): Promise<RedriveClaimResult>;
  inspectRedrive(
    messageId: string,
    now: Date,
  ): Promise<{
    readonly envelope: RefloEventEnvelope;
    readonly operationState: string;
    readonly rejectionClass:
      | "authorization_denied"
      | "changed_intent"
      | "deleted_scope"
      | "expired"
      | "invalid_wrapper"
      | "state_conflict"
      | "unsupported_contract"
      | null;
  } | null>;
  markRedrivePublished(input: {
    readonly messageId: string;
    readonly now: Date;
    readonly requestKey: string;
  }): Promise<boolean>;
  rejectRedrive(input: {
    readonly failureClass:
      | "authorization_denied"
      | "changed_intent"
      | "deleted_scope"
      | "expired"
      | "invalid_wrapper"
      | "state_conflict"
      | "unsupported_contract";
    readonly messageId: string;
    readonly now: Date;
    readonly reasonCode: RocketMqRedriveReasonCode;
    readonly requestKey: string;
  }): Promise<boolean>;
  releaseRedrive(input: {
    readonly failureClass:
      | "broker_unavailable"
      | "invalid_receipt"
      | "publication_timeout"
      | "publisher_shutdown";
    readonly messageId: string;
    readonly now: Date;
    readonly requestKey: string;
  }): Promise<boolean>;
}

export class RocketMqDlqRedrive {
  readonly #clock: { now(): Date };
  readonly #consumer: {
    receive(batchSize: number): Promise<readonly RocketMqDeadLetterRecord[]>;
  };
  readonly #publisher: RocketMqPublishingPort;
  readonly #repository: RedriveRepository;
  readonly #sourceInstance: string;
  readonly #sourceTopic: string;

  constructor(input: {
    readonly clock?: { now(): Date };
    readonly consumer: {
      receive(batchSize: number): Promise<readonly RocketMqDeadLetterRecord[]>;
    };
    readonly publisher: RocketMqPublishingPort;
    readonly repository: RedriveRepository;
    readonly sourceInstance: string;
    readonly sourceTopic: string;
  }) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sourceTopic) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sourceInstance)
    ) {
      throw new Error("redrive source identity is invalid");
    }
    this.#clock = input.clock ?? { now: () => new Date() };
    this.#consumer = input.consumer;
    this.#publisher = input.publisher;
    this.#repository = input.repository;
    this.#sourceInstance = input.sourceInstance;
    this.#sourceTopic = input.sourceTopic;
  }

  async run(input: {
    readonly batchSize: number;
    readonly reasonCode: RocketMqRedriveReasonCode;
    readonly requestKey: string;
  }): Promise<{
    readonly ambiguousPublications: number;
    readonly blocked: number;
    readonly oldestRecordAgeSeconds?: number;
    readonly published: number;
    readonly received: number;
    readonly rejected: number;
    readonly retryGuard: number;
    readonly validatorRejections: number;
  }> {
    const records = await this.#consumer.receive(input.batchSize);
    let ambiguousPublications = 0;
    let blocked = 0;
    let oldestRecordAgeSeconds: number | undefined;
    let published = 0;
    let rejected = 0;
    let retryGuard = 0;
    let validatorRejections = 0;
    for (const record of records) {
      if (
        record.bornAt !== undefined &&
        Number.isFinite(record.bornAt.getTime())
      ) {
        const ageSeconds = Math.max(
          0,
          Math.min(
            86_400,
            Math.floor(
              (this.#clock.now().getTime() - record.bornAt.getTime()) / 1_000,
            ),
          ),
        );
        oldestRecordAgeSeconds = Math.max(
          oldestRecordAgeSeconds ?? 0,
          ageSeconds,
        );
      }
      if (
        !Number.isSafeInteger(record.deliveryNumber) ||
        record.deliveryNumber < 1 ||
        record.deliveryNumber > MAX_OPERATOR_DELIVERY_NUMBER
      ) {
        blocked += 1;
        retryGuard += 1;
        continue;
      }
      let envelope: RefloEventEnvelope;
      try {
        envelope = validateRocketMqDlqWrapper(
          record.body,
          this.#sourceTopic,
          this.#sourceInstance,
        );
      } catch {
        await record.acknowledge();
        rejected += 1;
        validatorRejections += 1;
        continue;
      }
      const identity = {
        messageId: envelope.messageId,
        now: this.#clock.now(),
        reasonCode: input.reasonCode,
        requestKey: input.requestKey,
      };
      const inspection = await this.#repository.inspectRedrive(
        envelope.messageId,
        identity.now,
      );
      if (inspection === null) {
        await this.#repository.rejectRedrive({
          ...identity,
          failureClass: "authorization_denied",
        });
        await record.acknowledge();
        rejected += 1;
        continue;
      }
      if (inspection.rejectionClass !== null) {
        await this.#repository.rejectRedrive({
          ...identity,
          failureClass: inspection.rejectionClass,
        });
        await record.acknowledge();
        rejected += 1;
        continue;
      }
      if (!sameEnvelope(envelope, inspection.envelope)) {
        await this.#repository.rejectRedrive({
          ...identity,
          failureClass: "changed_intent",
        });
        await record.acknowledge();
        rejected += 1;
        continue;
      }
      const claim = await this.#repository.claimRedrive(identity);
      if (claim.kind === "published" || claim.kind === "rejected") {
        await record.acknowledge();
        if (claim.kind === "published") {
          published += 1;
        } else {
          rejected += 1;
        }
        continue;
      }
      if (claim.kind === "ineligible") {
        await this.#repository.rejectRedrive({
          ...identity,
          failureClass: "state_conflict",
        });
        await record.acknowledge();
        rejected += 1;
        continue;
      }
      if (claim.kind !== "claimed") {
        blocked += 1;
        continue;
      }
      if (!sameEnvelope(envelope, claim.envelope)) {
        await this.#repository.rejectRedrive({
          ...identity,
          failureClass: "changed_intent",
        });
        await record.acknowledge();
        rejected += 1;
        continue;
      }
      try {
        await this.#publisher.publish(envelope);
      } catch (error) {
        await this.#repository.releaseRedrive({
          failureClass:
            error instanceof RocketMqPublishingError &&
            error.failureClass !== "throttled" &&
            error.failureClass !== "unknown_transient"
              ? error.failureClass
              : "broker_unavailable",
          messageId: envelope.messageId,
          now: this.#clock.now(),
          requestKey: input.requestKey,
        });
        blocked += 1;
        ambiguousPublications += 1;
        continue;
      }
      if (
        !(await this.#repository.markRedrivePublished({
          messageId: envelope.messageId,
          now: this.#clock.now(),
          requestKey: input.requestKey,
        }))
      ) {
        blocked += 1;
        ambiguousPublications += 1;
        continue;
      }
      await record.acknowledge();
      published += 1;
    }
    return {
      ambiguousPublications,
      blocked,
      ...(oldestRecordAgeSeconds === undefined
        ? {}
        : { oldestRecordAgeSeconds }),
      published,
      received: records.length,
      rejected,
      retryGuard,
      validatorRejections,
    };
  }
}

export function validateRocketMqDlqWrapper(
  raw: Uint8Array,
  expectedTopic: string,
  expectedInstance: string,
): RefloEventEnvelope {
  if (
    raw.byteLength < 2 ||
    raw.byteLength > MAX_WRAPPER_BYTES ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(expectedTopic) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(expectedInstance)
  ) {
    throw invalidWrapper();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
  } catch {
    throw invalidWrapper();
  }
  const candidate =
    Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : decoded;
  const cloudEvent = object(candidate);
  if (
    cloudEvent === null ||
    !allowedKeys(cloudEvent, CLOUD_EVENT_KEYS) ||
    !boundedString(cloudEvent.id, 1, 256) ||
    !["acs:mq", "RocketMQSource"].includes(String(cloudEvent.source)) ||
    cloudEvent.specversion !== "1.0" ||
    cloudEvent.type !== "mq:Topic:SendMessage" ||
    cloudEvent.datacontenttype !== "application/json; charset=utf-8" ||
    !isIsoUtc(cloudEvent.time) ||
    (cloudEvent.aliyunregionid !== undefined &&
      cloudEvent.aliyunregionid !== "ap-southeast-1") ||
    !validSubject(cloudEvent.subject, expectedInstance, expectedTopic) ||
    !validProviderMetadata(cloudEvent)
  ) {
    throw invalidWrapper();
  }
  const data = object(cloudEvent.data);
  if (
    data === null ||
    !allowedKeys(data, DATA_KEYS) ||
    data.topic !== expectedTopic
  ) {
    throw invalidWrapper();
  }
  const systemProperties = object(data.systemProperties);
  if (
    systemProperties === null ||
    !allowedKeys(systemProperties, SYSTEM_PROPERTY_KEYS) ||
    systemProperties.INSTANCE_ID !== expectedInstance ||
    !Object.values(systemProperties).every(boundedProviderScalar)
  ) {
    throw invalidWrapper();
  }
  const userProperties = object(data.userProperties ?? {});
  if (
    userProperties === null ||
    !allowedKeys(userProperties, new Set(["reflo_message_id"])) ||
    !boundedString(userProperties.reflo_message_id, 36, 36)
  ) {
    throw invalidWrapper();
  }
  let envelopeInput: unknown = data.body;
  if (typeof envelopeInput === "string") {
    try {
      envelopeInput = JSON.parse(envelopeInput) as unknown;
    } catch {
      throw invalidWrapper();
    }
  }
  let envelope: RefloEventEnvelope;
  try {
    envelope = validateAudioGenerationEnvelope(envelopeInput);
  } catch {
    throw invalidWrapper();
  }
  if (
    envelope.environment !== "dev" ||
    (userProperties.reflo_message_id !== undefined &&
      userProperties.reflo_message_id !== envelope.messageId)
  ) {
    throw invalidWrapper();
  }
  return envelope;
}

function sameEnvelope(
  left: RefloEventEnvelope,
  right: RefloEventEnvelope,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function allowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function boundedProviderScalar(value: unknown): boolean {
  return (
    (typeof value === "string" && value.length <= 512) ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isIsoUtc(value: unknown): value is string {
  return (
    boundedString(value, 24, 24) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validProviderMetadata(
  cloudEvent: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(cloudEvent).every(([key, value]) => {
    if (
      CLOUD_EVENT_KEYS.has(key) &&
      [
        "data",
        "datacontenttype",
        "id",
        "source",
        "specversion",
        "subject",
        "time",
        "type",
      ].includes(key)
    ) {
      return true;
    }
    return value === undefined || boundedProviderScalar(value);
  });
}

function validSubject(
  value: unknown,
  expectedInstance: string,
  expectedTopic: string,
): boolean {
  if (!boundedString(value, 1, 512)) {
    return false;
  }
  const fields = value.split(":");
  return (
    fields.length === 5 &&
    fields[0] === "acs" &&
    fields[1] === "mq" &&
    fields[2] === "ap-southeast-1" &&
    boundedString(fields[3], 1, 128) &&
    fields[4] === `${expectedInstance}%${expectedTopic}`
  );
}

function invalidWrapper(): Error {
  return new Error("RocketMQ dead-letter wrapper is invalid");
}
