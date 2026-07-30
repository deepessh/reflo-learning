import pg from "pg";

const { Pool } = pg;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_OWNER = /^[a-zA-Z0-9_-]{8,128}$/;

export type RocketMqFailureClass =
  | "broker_unavailable"
  | "invalid_receipt"
  | "publication_timeout"
  | "publisher_shutdown"
  | "throttled"
  | "unknown_transient";

export type RocketMqRedriveReasonCode =
  | "configuration_repaired"
  | "provider_recovered"
  | "transient_dependency_recovered";

export type RocketMqRedriveRejectionClass =
  | "authorization_denied"
  | "changed_intent"
  | "deleted_scope"
  | "expired"
  | "invalid_wrapper"
  | "state_conflict"
  | "unsupported_contract";

export interface RefloEventEnvelope {
  readonly causationId?: string;
  readonly correlationId: string;
  readonly deadlineAt?: string;
  readonly environment: "dev" | "pilot" | "staging";
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly messageKind: "command" | "event";
  readonly messageName: string;
  readonly messageVersion: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly producer: string;
}

export interface PostgresRocketMqRepositoryOptions {
  readonly connectionString: string;
  readonly leaseDurationMs: number;
  readonly leaseOwner: string;
}

interface EnvelopeRow extends Record<string, unknown> {
  causation_id: string | null;
  correlation_id: string;
  deadline_at: Date | null;
  environment: RefloEventEnvelope["environment"];
  idempotency_key: string;
  message_id: string;
  message_kind: RefloEventEnvelope["messageKind"];
  message_name: string;
  message_version: number;
  occurred_at: Date;
  payload: Readonly<Record<string, unknown>>;
  producer: string;
}

interface InspectRow extends EnvelopeRow {
  operation_state: string;
  rejection_class: RocketMqRedriveRejectionClass | null;
}

interface RedriveClaimRow extends EnvelopeRow {
  claim_outcome: RedriveClaimResult["kind"];
}

export type RedriveClaimResult =
  | {
      readonly kind:
        "active" | "conflict" | "ineligible" | "published" | "rejected";
    }
  | { readonly envelope: RefloEventEnvelope; readonly kind: "claimed" };

export class PostgresRocketMqRepository {
  readonly #leaseDurationMs: number;
  readonly #leaseOwner: string;
  readonly #pool: InstanceType<typeof Pool>;

  constructor(options: PostgresRocketMqRepositoryOptions) {
    if (
      options.connectionString.length === 0 ||
      !LEASE_OWNER.test(options.leaseOwner) ||
      !Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 10_000 ||
      options.leaseDurationMs > 5 * 60_000
    ) {
      throw new Error("RocketMQ database configuration is invalid");
    }
    this.#leaseDurationMs = options.leaseDurationMs;
    this.#leaseOwner = options.leaseOwner;
    this.#pool = new Pool({ connectionString: options.connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async claimOutbox(
    batchSize: number,
    now: Date,
  ): Promise<readonly RefloEventEnvelope[]> {
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 25 ||
      !validDate(now)
    ) {
      throw new Error("outbox claim input is invalid");
    }
    const result = await this.#query<EnvelopeRow>(
      `SELECT *
       FROM reflo_claim_outbox_messages($1, $2, $3, $4)`,
      [
        this.#leaseOwner,
        new Date(now.getTime() + this.#leaseDurationMs),
        batchSize,
        now,
      ],
    );
    return result.rows.map(envelopeFromRow);
  }

  async markOutboxPublished(messageId: string, now: Date): Promise<boolean> {
    return this.#booleanFunction(
      "reflo_mark_outbox_published",
      [messageId, this.#leaseOwner, now],
      messageId,
      now,
    );
  }

  async releaseOutbox(
    messageId: string,
    failureClass: RocketMqFailureClass,
  ): Promise<boolean> {
    if (!isRocketMqFailureClass(failureClass)) {
      throw new Error("outbox failure class is invalid");
    }
    return this.#booleanFunction(
      "reflo_release_outbox_message",
      [messageId, this.#leaseOwner, failureClass],
      messageId,
    );
  }

  async inspectRedrive(
    messageId: string,
    now: Date,
  ): Promise<{
    readonly envelope: RefloEventEnvelope;
    readonly operationState: string;
    readonly rejectionClass: RocketMqRedriveRejectionClass | null;
  } | null> {
    assertUuid(messageId, "redrive message ID");
    if (!validDate(now)) {
      throw new Error("redrive inspection time is invalid");
    }
    const result = await this.#query<InspectRow>(
      `SELECT *
       FROM reflo_inspect_audio_redrive($1, $2)`,
      [messageId, now],
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) {
      return null;
    }
    if (
      row.rejection_class !== null &&
      !isRedriveRejectionClass(row.rejection_class)
    ) {
      throw new Error("redrive inspection returned an invalid result");
    }
    return {
      envelope: envelopeFromRow(row),
      operationState: row.operation_state,
      rejectionClass: row.rejection_class,
    };
  }

  async claimRedrive(input: {
    readonly messageId: string;
    readonly now: Date;
    readonly reasonCode: RocketMqRedriveReasonCode;
    readonly requestKey: string;
  }): Promise<RedriveClaimResult> {
    assertRedriveIdentity(input);
    const result = await this.#query<RedriveClaimRow>(
      `SELECT *
       FROM reflo_claim_audio_redrive($1, $2, $3, $4, $5, $6)`,
      [
        input.messageId,
        input.requestKey,
        input.reasonCode,
        this.#leaseOwner,
        new Date(input.now.getTime() + this.#leaseDurationMs),
        input.now,
      ],
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) {
      throw new Error("redrive claim returned an invalid result");
    }
    if (row.claim_outcome !== "claimed") {
      return { kind: row.claim_outcome };
    }
    return { envelope: envelopeFromRow(row), kind: "claimed" };
  }

  async markRedrivePublished(input: {
    readonly messageId: string;
    readonly now: Date;
    readonly requestKey: string;
  }): Promise<boolean> {
    assertRedriveMutation(input);
    return this.#booleanFunction(
      "reflo_mark_audio_redrive_published",
      [input.messageId, input.requestKey, this.#leaseOwner, input.now],
      input.messageId,
      input.now,
    );
  }

  async releaseRedrive(input: {
    readonly failureClass: Extract<
      RocketMqFailureClass,
      | "broker_unavailable"
      | "invalid_receipt"
      | "publication_timeout"
      | "publisher_shutdown"
    >;
    readonly messageId: string;
    readonly now: Date;
    readonly requestKey: string;
  }): Promise<boolean> {
    assertRedriveMutation(input);
    return this.#booleanFunction(
      "reflo_release_audio_redrive",
      [
        input.messageId,
        input.requestKey,
        this.#leaseOwner,
        input.failureClass,
        input.now,
      ],
      input.messageId,
      input.now,
    );
  }

  async rejectRedrive(input: {
    readonly failureClass: RocketMqRedriveRejectionClass;
    readonly messageId: string;
    readonly now: Date;
    readonly reasonCode: RocketMqRedriveReasonCode;
    readonly requestKey: string;
  }): Promise<boolean> {
    assertRedriveIdentity(input);
    if (!isRedriveRejectionClass(input.failureClass)) {
      throw new Error("redrive rejection class is invalid");
    }
    return this.#booleanFunction(
      "reflo_reject_audio_redrive",
      [
        input.messageId,
        input.requestKey,
        input.reasonCode,
        input.failureClass,
        input.now,
      ],
      input.messageId,
      input.now,
    );
  }

  async #booleanFunction(
    name: string,
    parameters: readonly unknown[],
    messageId: string,
    now?: Date,
  ): Promise<boolean> {
    assertUuid(messageId, "RocketMQ message ID");
    if (now !== undefined && !validDate(now)) {
      throw new Error("RocketMQ mutation time is invalid");
    }
    const placeholders = parameters
      .map((_, index) => `$${index + 1}`)
      .join(", ");
    const result = await this.#query<{ outcome: boolean }>(
      `SELECT ${name}(${placeholders}) AS outcome`,
      [...parameters],
    );
    return result.rows[0]?.outcome === true;
  }

  async #query<Row extends Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[],
  ) {
    const client = await this.#pool.connect();
    try {
      return await client.query<Row>(text, parameters);
    } finally {
      client.release();
    }
  }
}

function envelopeFromRow(row: EnvelopeRow): RefloEventEnvelope {
  if (
    !UUID.test(row.message_id) ||
    !UUID.test(row.correlation_id) ||
    (row.causation_id !== null && !UUID.test(row.causation_id)) ||
    !Number.isSafeInteger(row.message_version) ||
    row.message_version < 1 ||
    !validDate(row.occurred_at) ||
    (row.deadline_at !== null && !validDate(row.deadline_at)) ||
    typeof row.payload !== "object" ||
    row.payload === null ||
    Array.isArray(row.payload)
  ) {
    throw new Error("outbox envelope is invalid");
  }
  return {
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    correlationId: row.correlation_id,
    ...(row.deadline_at === null
      ? {}
      : { deadlineAt: row.deadline_at.toISOString() }),
    environment: row.environment,
    idempotencyKey: row.idempotency_key,
    messageId: row.message_id,
    messageKind: row.message_kind,
    messageName: row.message_name,
    messageVersion: row.message_version,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
    producer: row.producer,
  };
}

function assertRedriveIdentity(input: {
  readonly messageId: string;
  readonly now: Date;
  readonly reasonCode: RocketMqRedriveReasonCode;
  readonly requestKey: string;
}): void {
  assertUuid(input.messageId, "redrive message ID");
  assertUuid(input.requestKey, "redrive request key");
  if (!validDate(input.now) || !isReasonCode(input.reasonCode)) {
    throw new Error("redrive identity is invalid");
  }
}

function assertRedriveMutation(input: {
  readonly messageId: string;
  readonly now: Date;
  readonly requestKey: string;
}): void {
  assertUuid(input.messageId, "redrive message ID");
  assertUuid(input.requestKey, "redrive request key");
  if (!validDate(input.now)) {
    throw new Error("redrive mutation time is invalid");
  }
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) {
    throw new Error(`${name} is invalid`);
  }
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isReasonCode(value: string): value is RocketMqRedriveReasonCode {
  return [
    "configuration_repaired",
    "provider_recovered",
    "transient_dependency_recovered",
  ].includes(value);
}

function isRocketMqFailureClass(value: string): value is RocketMqFailureClass {
  return [
    "broker_unavailable",
    "invalid_receipt",
    "publication_timeout",
    "publisher_shutdown",
    "throttled",
    "unknown_transient",
  ].includes(value);
}

function isRedriveRejectionClass(
  value: string,
): value is RocketMqRedriveRejectionClass {
  return [
    "authorization_denied",
    "changed_intent",
    "deleted_scope",
    "expired",
    "invalid_wrapper",
    "state_conflict",
    "unsupported_contract",
  ].includes(value);
}
