import path from "node:path";

import {
  IngestionError,
  validateIngestionOutcome,
  type AuthorizedQuarantinedSource,
  type IngestionCommand,
  type IngestionOperationStore,
  type IngestionOutcome,
  type OperationClaim,
} from "@reflo/ingestion";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;
const MAX_DELIVERIES = 5;

interface OperationRow extends Record<string, unknown> {
  attempt_count: number;
  deadline_at: Date | null;
  deadline_expired: boolean;
  idempotency_key: string;
  input_sha256: string;
  lease_expires_at: Date | null;
  lease_active: boolean;
  lease_owner: string | null;
  operation_name: string;
  operation_version: number;
  owner_scope_id: string;
  result_ref: unknown;
  source_document_id: string;
  state: string;
}

interface SourceRow extends Record<string, unknown> {
  byte_size: string;
  checksum: string;
  media_type: string;
  object_key: string;
  owner_scope_id: string;
  source_document_id: string;
}

export interface PostgresIngestionOperationStoreOptions {
  readonly connectionString: string;
  readonly environment: "dev" | "pilot" | "staging";
  readonly leaseDurationMs: number;
  readonly leaseOwner: string;
}

export class PostgresIngestionOperationStore implements IngestionOperationStore {
  readonly #environment: PostgresIngestionOperationStoreOptions["environment"];
  readonly #leaseDurationMs: number;
  readonly #leaseOwner: string;
  readonly #pool: InstanceType<typeof Pool>;

  constructor(options: PostgresIngestionOperationStoreOptions) {
    if (
      options.connectionString.length < 1 ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(options.leaseOwner) ||
      !Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 10_000 ||
      options.leaseDurationMs > 30 * 60 * 1_000
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
    this.#environment = options.environment;
    this.#leaseDurationMs = options.leaseDurationMs;
    this.#leaseOwner = options.leaseOwner;
    this.#pool = new Pool({ connectionString: options.connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async claim(command: IngestionCommand): Promise<OperationClaim> {
    return this.#transaction(async (client) => {
      await this.#setOperationContext(client, command.operationId);
      const result = await client.query<OperationRow>(
        `SELECT operation.owner_scope_id, operation.operation_name,
                operation.operation_version, operation.idempotency_key,
                operation.state, operation.lease_owner,
                operation.lease_expires_at, operation.attempt_count,
                operation.result_ref, operation.deadline_at,
                operation.lease_expires_at > clock_timestamp() AS lease_active,
                operation.deadline_at <= clock_timestamp() AS deadline_expired,
                ingestion.source_document_id, ingestion.input_sha256
         FROM async_operation AS operation
         JOIN ingestion_operation AS ingestion
           ON ingestion.owner_scope_id = operation.owner_scope_id
          AND ingestion.operation_id = operation.id
         WHERE operation.id = $1
         FOR UPDATE OF operation`,
        [command.operationId],
      );
      const row = result.rows[0];
      assertBoundOperation(row, command, this.#environment);
      if (isTerminal(row.state)) {
        return {
          kind: "completed",
          outcome: storedOutcome(row.result_ref, row.state),
        };
      }
      if (row.state === "processing" && row.lease_active) {
        return { kind: "active" };
      }
      if (row.state === "processing") {
        await client.query(
          `UPDATE async_operation_attempt
           SET outcome = $4, normalized_failure_class = $5,
               finished_at = clock_timestamp()
           WHERE owner_scope_id = $1 AND operation_id = $2
             AND delivery_number = $3 AND outcome = 'started'`,
          [
            row.owner_scope_id,
            command.operationId,
            row.attempt_count,
            row.attempt_count >= MAX_DELIVERIES || row.deadline_expired
              ? "failed_permanent"
              : "retry_scheduled",
            row.attempt_count >= MAX_DELIVERIES || row.deadline_expired
              ? "parse_timeout"
              : "infrastructure_unavailable",
          ],
        );
      }
      if (row.attempt_count >= MAX_DELIVERIES || row.deadline_expired) {
        const outcome: IngestionOutcome = {
          failure: { code: "parse_timeout", retryable: false },
          kind: "failed",
        };
        await client.query(
          `UPDATE async_operation
           SET state = 'failed_permanent', lease_owner = NULL,
               lease_expires_at = NULL, result_ref = $2,
               sanitized_failure = '{"class":"parse_timeout"}'::jsonb,
               updated_at = clock_timestamp(), completed_at = clock_timestamp()
           WHERE id = $1`,
          [command.operationId, outcome],
        );
        await client.query(
          `UPDATE source_document
           SET parse_status = 'failed', updated_at = clock_timestamp()
           WHERE owner_scope_id = $1 AND id = $2`,
          [row.owner_scope_id, row.source_document_id],
        );
        return { kind: "completed", outcome };
      }
      if (
        row.state !== "queued" &&
        row.state !== "retry_scheduled" &&
        row.state !== "processing"
      ) {
        throw new IngestionError("infrastructure_unavailable");
      }
      const claimed = await client.query<{ attempt_count: number }>(
        `UPDATE async_operation
         SET state = 'processing', lease_owner = $2,
             lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
             attempt_count = attempt_count + 1,
             result_ref = NULL, sanitized_failure = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING attempt_count`,
        [command.operationId, this.#leaseOwner, this.#leaseDurationMs],
      );
      const attempt = requiredRow(claimed.rows[0], "ingestion claim");
      await client.query(
        `INSERT INTO async_operation_attempt
           (owner_scope_id, operation_id, delivery_number, outcome)
         VALUES ($1, $2, $3, 'started')`,
        [row.owner_scope_id, command.operationId, attempt.attempt_count],
      );
      return { kind: "claimed" };
    });
  }

  async resolveAuthorizedSource(
    command: IngestionCommand,
  ): Promise<AuthorizedQuarantinedSource | null> {
    return this.#transaction(async (client) => {
      const authorized = await this.#setOperationContext(
        client,
        command.operationId,
      );
      if (!authorized) {
        return null;
      }
      const result = await client.query<SourceRow>(
        `SELECT source.id AS source_document_id, source.owner_scope_id,
                source.object_key, source.checksum, source.media_type,
                source.byte_size::text
         FROM ingestion_operation AS ingestion
         JOIN async_operation AS operation
           ON operation.owner_scope_id = ingestion.owner_scope_id
          AND operation.id = ingestion.operation_id
         JOIN source_document AS source
           ON source.owner_scope_id = ingestion.owner_scope_id
          AND source.id = ingestion.source_document_id
         JOIN owner_scope AS scope ON scope.id = source.owner_scope_id
         WHERE ingestion.operation_id = $1
           AND ingestion.owner_scope_id = $2
           AND ingestion.source_document_id = $3
           AND ingestion.input_sha256 = $4
           AND operation.state = 'processing'
           AND operation.lease_owner = $5
           AND operation.lease_expires_at > clock_timestamp()
           AND source.retention_status = 'active'
           AND source.parse_status IN ('quarantined', 'validating', 'queued', 'parsing')
           AND scope.status = 'active'
           AND 1 = (
             SELECT count(*)
             FROM scope_membership AS membership
             WHERE membership.owner_scope_id = source.owner_scope_id
               AND membership.role = 'owner'
               AND membership.revoked_at IS NULL
           )
         FOR UPDATE OF source`,
        [
          command.operationId,
          command.ownerScopeId,
          command.sourceDocumentId,
          command.expectedInputSha256,
          this.#leaseOwner,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const extension = path.extname(row.object_key).slice(1).toLowerCase();
      const expectedByteLength = Number(row.byte_size);
      if (
        row.checksum !== command.expectedInputSha256 ||
        !Number.isSafeInteger(expectedByteLength) ||
        expectedByteLength < 1 ||
        !validMediaType(extension, row.media_type)
      ) {
        return null;
      }
      await client.query(
        `UPDATE source_document
         SET parse_status = 'parsing', updated_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND id = $2`,
        [row.owner_scope_id, row.source_document_id],
      );
      return {
        clientMimeType: row.media_type,
        expectedByteLength,
        expectedInputSha256: row.checksum,
        extension,
        objectKey: row.object_key,
        ownerScopeId: row.owner_scope_id,
        retentionState: "active",
        sourceDocumentId: row.source_document_id,
      };
    });
  }

  async finalize(
    operationId: string,
    outcome: IngestionOutcome,
  ): Promise<boolean> {
    const validated = validateIngestionOutcome(outcome);
    return this.#transaction(async (client) => {
      const authorized = await this.#setOperationContext(client, operationId);
      if (!authorized) {
        return false;
      }
      const selected = await client.query<{
        attempt_count: number;
        owner_scope_id: string;
        source_document_id: string;
      }>(
        `SELECT operation.owner_scope_id, operation.attempt_count,
                ingestion.source_document_id
         FROM async_operation AS operation
         JOIN ingestion_operation AS ingestion
           ON ingestion.owner_scope_id = operation.owner_scope_id
          AND ingestion.operation_id = operation.id
         JOIN source_document AS source
           ON source.owner_scope_id = ingestion.owner_scope_id
          AND source.id = ingestion.source_document_id
         JOIN owner_scope AS scope ON scope.id = ingestion.owner_scope_id
         WHERE operation.id = $1
           AND operation.state = 'processing'
           AND operation.lease_owner = $2
           AND operation.lease_expires_at > clock_timestamp()
           AND source.retention_status = 'active'
           AND scope.status = 'active'
         FOR UPDATE OF operation`,
        [operationId, this.#leaseOwner],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        return false;
      }
      const retry = validated.kind === "failed" && validated.failure.retryable;
      const operationState = retry
        ? "retry_scheduled"
        : validated.kind === "failed"
          ? "failed_permanent"
          : "succeeded";
      const failure =
        validated.kind === "failed" ? { class: validated.failure.code } : null;
      const updated = await client.query(
        `UPDATE async_operation
         SET state = $3, lease_owner = NULL, lease_expires_at = NULL,
             result_ref = $4, sanitized_failure = $5,
             updated_at = clock_timestamp(),
             completed_at = CASE WHEN $3 = 'retry_scheduled'
               THEN NULL ELSE clock_timestamp() END
         WHERE id = $1 AND state = 'processing' AND lease_owner = $2`,
        [operationId, this.#leaseOwner, operationState, validated, failure],
      );
      if (updated.rowCount !== 1) {
        return false;
      }
      const attemptOutcome = retry
        ? "retry_scheduled"
        : validated.kind === "failed"
          ? "failed_permanent"
          : "succeeded";
      await client.query(
        `UPDATE async_operation_attempt
         SET outcome = $4, normalized_failure_class = $5,
             finished_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND operation_id = $2
           AND delivery_number = $3 AND outcome = 'started'`,
        [
          row.owner_scope_id,
          operationId,
          row.attempt_count,
          attemptOutcome,
          validated.kind === "failed" ? validated.failure.code : null,
        ],
      );
      const sourceState = retry
        ? "queued"
        : validated.kind === "failed"
          ? "failed"
          : validated.kind === "ocr_required"
            ? "ocr_required"
            : "parsed";
      const pageCount =
        validated.kind === "failed" ? null : validated.artifact.pageCount;
      await client.query(
        `UPDATE source_document
         SET parse_status = $3, page_count = $4,
             updated_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND id = $2`,
        [row.owner_scope_id, row.source_document_id, sourceState, pageCount],
      );
      return true;
    });
  }

  async readCompleted(operationId: string): Promise<IngestionOutcome | null> {
    return this.#transaction(async (client) => {
      const authorized = await this.#setOperationContext(client, operationId);
      if (!authorized) {
        return null;
      }
      const result = await client.query<{ result_ref: unknown }>(
        `SELECT result_ref
         FROM async_operation
         WHERE id = $1 AND result_ref IS NOT NULL`,
        [operationId],
      );
      return result.rows[0] === undefined
        ? null
        : storedOutcome(result.rows[0].result_ref);
    });
  }

  async #setOperationContext(
    client: PoolClient,
    operationId: string,
  ): Promise<boolean> {
    const authorization = await client.query<{
      actor_id: string;
      owner_scope_id: string;
    }>(
      `SELECT actor_id, owner_scope_id
       FROM reflo_resolve_ingestion_authorization($1)`,
      [operationId],
    );
    const row = authorization.rows[0];
    if (row === undefined) {
      return false;
    }
    await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
      row.actor_id,
    ]);
    await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
      row.owner_scope_id,
    ]);
    return true;
  }

  async #transaction<Result>(
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function assertBoundOperation(
  row: OperationRow | undefined,
  command: IngestionCommand,
  environment: string,
): asserts row is OperationRow {
  if (
    row === undefined ||
    row.owner_scope_id !== command.ownerScopeId ||
    row.source_document_id !== command.sourceDocumentId ||
    row.input_sha256 !== command.expectedInputSha256 ||
    row.operation_name !== "ingestion.parse" ||
    row.operation_version !== 1 ||
    !row.idempotency_key.startsWith(`${environment}/ingestion.parse/v1/`)
  ) {
    throw new IngestionError("authorization_denied");
  }
}

function storedOutcome(value: unknown, state?: string): IngestionOutcome {
  if (value === null) {
    if (state === "expired") {
      return {
        failure: { code: "parse_timeout", retryable: false },
        kind: "failed",
      };
    }
    if (state === "cancelled") {
      return {
        failure: { code: "retention_blocked", retryable: false },
        kind: "failed",
      };
    }
    throw new IngestionError("infrastructure_unavailable");
  }
  return validateIngestionOutcome(value);
}

function isTerminal(state: string): boolean {
  return (
    state === "succeeded" ||
    state === "failed_permanent" ||
    state === "cancelled" ||
    state === "expired"
  );
}

function validMediaType(extension: string, mediaType: string): boolean {
  return (
    (extension === "pdf" && mediaType === "application/pdf") ||
    (extension === "epub" && mediaType === "application/epub+zip") ||
    (extension === "docx" &&
      mediaType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  );
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (row === undefined) {
    throw new Error(`Database did not return required ${label}`);
  }
  return row;
}
