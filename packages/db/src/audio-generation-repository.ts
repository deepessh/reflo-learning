import {
  AUDIO_GENERATION_VERSION,
  AUDIO_MAX_DELIVERIES,
  AudioGenerationError,
  canScheduleAudioRetry,
  type AudioChapter,
  type AudioGenerationClaim,
  type AudioGenerationFailure,
  type AudioGenerationEnvelope,
  type AudioGenerationRepositoryPort,
  type AudioGenerationWork,
  type AudioOperationView,
  type AuthorizedAudioCourse,
  type AuthorizedNarrationScript,
  type GeneratedAudioAsset,
  type PlannedAudioOperation,
} from "@reflo/audio";
import { stableUuid, type ScopeAuthorizationContext } from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

interface AudioOperationRow extends Record<string, unknown> {
  asset_id: string | null;
  attempt_count: number;
  chapter_id: string;
  deadline_at: Date;
  failure_class: string | null;
  generation_version: typeof AUDIO_GENERATION_VERSION;
  id: string;
  idempotency_key: string;
  lease_active: boolean;
  lease_owner: string | null;
  narration_script_id: string;
  priority: number;
  state: AudioOperationView["status"];
  updated_at: Date;
}

interface CourseRow extends Record<string, unknown> {
  course_id: string;
  owner_scope_id: string;
  source_document_id: string;
}

interface AudioContentRow extends Record<string, unknown> {
  chapter_id: string;
  chapter_order: number;
  generation_version: string;
  model_provenance: unknown;
  narration_script_id: string;
  script_sha256: string;
  script_text: string;
  source_span_id: string;
  span_order: number;
}

export interface PostgresAudioGenerationRepositoryOptions {
  readonly connectionString: string;
  readonly leaseDurationMs: number;
  readonly leaseOwner: string;
}

export class PostgresAudioGenerationRepository implements AudioGenerationRepositoryPort {
  readonly #leaseDurationMs: number;
  readonly #leaseOwner: string;
  readonly #pool: InstanceType<typeof Pool>;

  constructor(options: PostgresAudioGenerationRepositoryOptions) {
    if (
      options.connectionString.length === 0 ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(options.leaseOwner) ||
      !Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 10_000 ||
      options.leaseDurationMs > 30 * 60_000
    ) {
      throw new AudioGenerationError("invalid_configuration");
    }
    this.#leaseDurationMs = options.leaseDurationMs;
    this.#leaseOwner = options.leaseOwner;
    this.#pool = new Pool({ connectionString: options.connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async loadCourse(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<AuthorizedAudioCourse | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, authorization);
      return loadAuthorizedAudioCourse(client, authorization, courseId);
    });
  }

  async registerOperations(
    course: AuthorizedAudioCourse,
    operations: readonly PlannedAudioOperation[],
  ): Promise<readonly AudioOperationView[]> {
    return this.#scopedCourseTransaction(course, async (client, current) => {
      assertSameCourse(course, current);
      for (const operation of operations) {
        assertPlannedOperation(current, operation);
        await client.query(
          `INSERT INTO async_operation
             (id, owner_scope_id, operation_name, operation_version,
              idempotency_key, state, deadline_at)
           VALUES ($1, $2, 'media.audio.generate', 1, $3, 'queued', $4)
           ON CONFLICT (id) DO NOTHING`,
          [
            operation.id,
            current.ownerScopeId,
            operation.idempotencyKey,
            operation.deadlineAt,
          ],
        );
        await client.query(
          `INSERT INTO audio_generation_operation
             (id, owner_scope_id, course_id, chapter_id,
              narration_script_id, generation_version, priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            operation.id,
            current.ownerScopeId,
            current.courseId,
            operation.chapterId,
            operation.narrationScriptId,
            operation.generationVersion,
            operation.priority,
          ],
        );
        await client.query(
          `INSERT INTO outbox_message
             (message_id, owner_scope_id, operation_id, message_kind,
              message_name, message_version, producer, environment,
              correlation_id, causation_id, idempotency_key, payload,
              occurred_at, deadline_at, priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   $11, $12::jsonb, $13, $14, $15)
           ON CONFLICT (message_id) DO NOTHING`,
          [
            operation.envelope.messageId,
            current.ownerScopeId,
            operation.id,
            operation.envelope.messageKind,
            operation.envelope.messageName,
            operation.envelope.messageVersion,
            operation.envelope.producer,
            operation.envelope.environment,
            operation.envelope.correlationId,
            operation.envelope.causationId ?? null,
            operation.envelope.idempotencyKey,
            JSON.stringify(operation.envelope.payload),
            operation.envelope.occurredAt,
            operation.envelope.deadlineAt,
            operation.priority,
          ],
        );
        const stored = await selectOperation(
          client,
          current.ownerScopeId,
          current.courseId,
          operation.id,
          false,
        );
        if (
          stored === null ||
          stored.chapterId !== operation.chapterId ||
          stored.narrationScriptId !== operation.narrationScriptId ||
          stored.idempotencyKey !== operation.idempotencyKey ||
          stored.priority !== operation.priority
        ) {
          throw new AudioGenerationError("invalid_result");
        }
      }
      return Promise.all(
        operations.map(async (operation) =>
          required(
            await selectOperation(
              client,
              current.ownerScopeId,
              current.courseId,
              operation.id,
              false,
            ),
          ),
        ),
      );
    });
  }

  async claimOperation(
    authorization: ScopeAuthorizationContext,
    envelope: AudioGenerationEnvelope,
  ): Promise<AudioGenerationClaim | null> {
    const courseId = envelope.payload.courseId;
    const operationId = envelope.payload.operationId;
    return this.#scopedCourseTransaction(
      { ...authorization, courseId },
      async (client, course) => {
        let current = await selectOperation(
          client,
          course.ownerScopeId,
          course.courseId,
          operationId,
          true,
        );
        if (current === null) {
          return null;
        }
        await assertCanonicalEnvelope(client, course.ownerScopeId, envelope);
        if (isTerminal(current.status)) {
          return { kind: "already_final", status: current };
        }
        if (current.status === "processing" && current.leaseActive) {
          return { kind: "active" };
        }
        const now = new Date();
        if (current.status === "processing") {
          await finishAttempt(
            client,
            course.ownerScopeId,
            current.id,
            current.attemptCount,
            current.deadlineAt <= now
              ? "expired"
              : current.attemptCount >= AUDIO_MAX_DELIVERIES
                ? "failed_permanent"
                : "retry_scheduled",
            current.deadlineAt <= now
              ? "deadline_exceeded"
              : "infrastructure_unavailable",
          );
        }
        if (
          current.attemptCount >= AUDIO_MAX_DELIVERIES ||
          current.deadlineAt <= now
        ) {
          const terminal =
            current.deadlineAt <= now ? "expired" : "failed_permanent";
          await client.query(
            `UPDATE async_operation
             SET state = $1, lease_owner = NULL, lease_expires_at = NULL,
                 sanitized_failure = $2::jsonb, completed_at = now(),
                 updated_at = now()
             WHERE owner_scope_id = $3 AND id = $4
               AND state NOT IN ('succeeded', 'failed_permanent', 'cancelled', 'expired')`,
            [
              terminal,
              JSON.stringify({
                failureClass:
                  terminal === "expired"
                    ? "deadline_exceeded"
                    : "delivery_exhausted",
                policyVersion: "audio-retry-v1",
              }),
              course.ownerScopeId,
              current.id,
            ],
          );
          current = required(
            await selectOperation(
              client,
              course.ownerScopeId,
              course.courseId,
              operationId,
              false,
            ),
          );
          await insertTerminalEvent(client, course, current, {
            assetId: null,
            messageName: "media.audio.failed",
            status: terminal,
          });
          return { kind: "already_final", status: current };
        }
        const claimed = await client.query<AudioOperationRow>(
          `UPDATE async_operation
           SET state = 'processing', lease_owner = $1,
               lease_expires_at = now() + ($2::integer * interval '1 millisecond'),
               attempt_count = attempt_count + 1,
               sanitized_failure = NULL, updated_at = now()
           WHERE owner_scope_id = $3 AND id = $4
             AND state IN ('queued', 'processing', 'retry_scheduled')
           RETURNING attempt_count`,
          [
            this.#leaseOwner,
            this.#leaseDurationMs,
            course.ownerScopeId,
            operationId,
          ],
        );
        const attemptCount = claimed.rows[0]?.attempt_count;
        if (attemptCount === undefined) {
          throw new AudioGenerationError("operation_unavailable");
        }
        await client.query(
          `INSERT INTO async_operation_attempt
             (owner_scope_id, operation_id, delivery_number, outcome)
           VALUES ($1, $2, $3, 'started')`,
          [course.ownerScopeId, operationId, attemptCount],
        );
        current = required(
          await selectOperation(
            client,
            course.ownerScopeId,
            course.courseId,
            operationId,
            false,
          ),
        );
        const chapter = course.chapters.find(
          (candidate) => candidate.id === current?.chapterId,
        );
        if (
          chapter === undefined ||
          chapter.narration.id !== current.narrationScriptId
        ) {
          throw new AudioGenerationError("authorization_denied");
        }
        return {
          kind: "claimed",
          work: { chapter, course, operation: current },
        };
      },
    );
  }

  async completeAudio(
    work: AudioGenerationWork,
    asset: GeneratedAudioAsset,
  ): Promise<AudioOperationView> {
    return this.#scopedCourseTransaction(
      work.course,
      async (client, course) => {
        assertSameCourse(work.course, course);
        const current = required(
          await selectOperation(
            client,
            course.ownerScopeId,
            course.courseId,
            work.operation.id,
            true,
          ),
        );
        if (isTerminal(current.status)) {
          return current;
        }
        assertProcessingAttempt(current, work, this.#leaseOwner);
        assertGeneratedAsset(work, asset);
        await assertAuthorizedSourceSpans(client, work, asset.sourceSpanIds);
        const persisted = await client.query<{ id: string }>(
          `INSERT INTO asset
           (id, owner_scope_id, course_id, chapter_id, asset_type,
            object_key, model_id, generation_version, status,
            model_provenance, content_hash, content_type, byte_size, etag,
            audio_generation_operation_id, narration_script_id,
            narration_script_sha256, audio_payload_metadata)
         VALUES ($1, $2, $3, $4, 'audio', $5, $6, $7, 'ready',
                 $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
         ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
         WHERE asset.audio_generation_operation_id = EXCLUDED.audio_generation_operation_id
           AND asset.object_key = EXCLUDED.object_key
           AND asset.content_hash = EXCLUDED.content_hash
           AND asset.audio_payload_metadata = EXCLUDED.audio_payload_metadata
         RETURNING id`,
          [
            asset.assetId,
            course.ownerScopeId,
            course.courseId,
            work.chapter.id,
            asset.storage.objectKey,
            asset.modelProvenance.effectiveModel,
            AUDIO_GENERATION_VERSION,
            JSON.stringify(asset.modelProvenance),
            asset.payload.payloadSha256,
            asset.storage.contentType,
            asset.storage.byteSize,
            asset.storage.etag,
            work.operation.id,
            asset.narrationScriptId,
            asset.narrationScriptSha256,
            JSON.stringify(asset.payload),
          ],
        );
        if (persisted.rows[0]?.id !== asset.assetId) {
          throw new AudioGenerationError("invalid_result");
        }
        await insertAssetSourceSpans(
          client,
          course.ownerScopeId,
          asset.assetId,
          asset.sourceSpanIds,
        );
        await client.query(
          `UPDATE audio_generation_operation
         SET asset_id = $1, updated_at = now()
         WHERE owner_scope_id = $2 AND id = $3 AND asset_id IS NULL`,
          [asset.assetId, course.ownerScopeId, work.operation.id],
        );
        const finalized = await client.query(
          `UPDATE async_operation
         SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
             result_ref = $1::jsonb, sanitized_failure = NULL,
             completed_at = now(), updated_at = now()
         WHERE owner_scope_id = $2 AND id = $3 AND state = 'processing'
           AND attempt_count = $4 AND lease_owner = $5`,
          [
            JSON.stringify({ assetId: asset.assetId }),
            course.ownerScopeId,
            work.operation.id,
            work.operation.attemptCount,
            this.#leaseOwner,
          ],
        );
        if (finalized.rowCount !== 1) {
          throw new AudioGenerationError("operation_unavailable");
        }
        await finishAttempt(
          client,
          course.ownerScopeId,
          work.operation.id,
          work.operation.attemptCount,
          "succeeded",
          null,
        );
        await insertTerminalEvent(client, course, work.operation, {
          assetId: asset.assetId,
          messageName: "media.audio.generated",
          status: "succeeded",
        });
        return required(
          await selectOperation(
            client,
            course.ownerScopeId,
            course.courseId,
            work.operation.id,
            false,
          ),
        );
      },
    );
  }

  async recordFailure(
    work: AudioGenerationWork,
    failure: AudioGenerationFailure,
  ): Promise<AudioOperationView> {
    if (!/^[a-z0-9_]{3,64}$/.test(failure.failureClass)) {
      throw new AudioGenerationError("invalid_result");
    }
    return this.#scopedCourseTransaction(
      work.course,
      async (client, course) => {
        const current = required(
          await selectOperation(
            client,
            course.ownerScopeId,
            course.courseId,
            work.operation.id,
            true,
          ),
        );
        if (isTerminal(current.status)) {
          return current;
        }
        assertProcessingAttempt(current, work, this.#leaseOwner);
        const now = new Date();
        const retryable =
          failure.retryable &&
          current.attemptCount < AUDIO_MAX_DELIVERIES &&
          canScheduleAudioRetry({
            deadlineAt: current.deadlineAt,
            deliveryNumber: current.attemptCount,
            now,
            operationId: current.id,
          });
        const status = retryable ? "retry_scheduled" : failure.terminalStatus;
        const finalized = await client.query(
          `UPDATE async_operation
         SET state = $1, lease_owner = NULL, lease_expires_at = NULL,
             sanitized_failure = $2::jsonb,
             completed_at = CASE WHEN $1 = 'retry_scheduled' THEN NULL ELSE now() END,
             updated_at = now()
         WHERE owner_scope_id = $3 AND id = $4 AND state = 'processing'
           AND attempt_count = $5 AND lease_owner = $6`,
          [
            status,
            JSON.stringify({
              attemptCount: current.attemptCount,
              failureClass: failure.failureClass,
              policyVersion: "audio-retry-v1",
            }),
            course.ownerScopeId,
            work.operation.id,
            work.operation.attemptCount,
            this.#leaseOwner,
          ],
        );
        if (finalized.rowCount !== 1) {
          throw new AudioGenerationError("operation_unavailable");
        }
        await finishAttempt(
          client,
          course.ownerScopeId,
          work.operation.id,
          work.operation.attemptCount,
          status,
          failure.failureClass,
        );
        if (!retryable) {
          await insertTerminalEvent(client, course, work.operation, {
            assetId: null,
            messageName: "media.audio.failed",
            status,
          });
        }
        return required(
          await selectOperation(
            client,
            course.ownerScopeId,
            course.courseId,
            work.operation.id,
            false,
          ),
        );
      },
    );
  }

  async listOperations(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<readonly AudioOperationView[]> {
    return this.#scopedCourseTransaction(
      { ...authorization, courseId },
      async (client, course) => {
        const result = await client.query<AudioOperationRow>(
          `${operationSelect()}
           WHERE operation.owner_scope_id = $1 AND audio.course_id = $2
           ORDER BY audio.priority, audio.id`,
          [course.ownerScopeId, course.courseId],
        );
        return result.rows.map(operationView);
      },
    );
  }

  async #scopedCourseTransaction<Result>(
    context:
      | AuthorizedAudioCourse
      | (ScopeAuthorizationContext & { readonly courseId: string }),
    operation: (
      client: PoolClient,
      course: AuthorizedAudioCourse,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, context);
      const course = await loadAuthorizedAudioCourse(
        client,
        context,
        context.courseId,
      );
      if (course === null) {
        throw new AudioGenerationError("authorization_denied");
      }
      return operation(client, course);
    });
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

async function loadAuthorizedAudioCourse(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
  courseId: string,
): Promise<AuthorizedAudioCourse | null> {
  validateAuthorization(authorization, courseId);
  const result = await client.query<CourseRow>(
    `SELECT course.id AS course_id, course.owner_scope_id,
            course.source_document_id
     FROM course
     JOIN source_document AS source
       ON source.owner_scope_id = course.owner_scope_id
      AND source.id = course.source_document_id
     JOIN owner_scope AS scope ON scope.id = course.owner_scope_id
     JOIN app_user AS actor ON actor.id = $1
     JOIN scope_membership AS membership
       ON membership.owner_scope_id = course.owner_scope_id
      AND membership.user_id = actor.id
     WHERE course.owner_scope_id = $2 AND course.id = $3
       AND course.status IN ('generating', 'ready')
       AND source.parse_status = 'parsed'
       AND source.retention_status = 'active'
       AND scope.status = 'active' AND actor.status = 'active'
       AND membership.role = 'owner' AND membership.revoked_at IS NULL
     FOR SHARE OF course, source, scope, actor, membership`,
    [authorization.actorId, authorization.ownerScopeId, courseId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const content = await client.query<AudioContentRow>(
    `SELECT chapter.id AS chapter_id, chapter.chapter_order,
            script.id AS narration_script_id, script.script_text,
            script.script_sha256, script.generation_version,
            script.model_provenance, link.source_span_id, link.span_order
     FROM chapter
     JOIN narration_script AS script
       ON script.owner_scope_id = chapter.owner_scope_id
      AND script.course_id = chapter.course_id
      AND script.chapter_id = chapter.id
      AND script.status = 'active'
     JOIN narration_script_source_span AS link
       ON link.owner_scope_id = script.owner_scope_id
      AND link.narration_script_id = script.id
     JOIN source_span AS span
       ON span.owner_scope_id = link.owner_scope_id
      AND span.id = link.source_span_id
      AND span.source_document_id = $3
     WHERE chapter.owner_scope_id = $1 AND chapter.course_id = $2
     ORDER BY chapter.chapter_order, link.span_order`,
    [row.owner_scope_id, row.course_id, row.source_document_id],
  );
  return {
    actorId: authorization.actorId,
    authorizationId: authorization.authorizationId,
    chapters: materializeAudioChapters(content.rows),
    courseId: row.course_id,
    ownerScopeId: row.owner_scope_id,
    sourceDocumentId: row.source_document_id,
  };
}

function materializeAudioChapters(
  rows: readonly AudioContentRow[],
): readonly AudioChapter[] {
  const chapters = new Map<string, AudioChapter>();
  for (const row of rows) {
    const previous = chapters.get(row.chapter_id);
    const provenance = modelProvenance(row.model_provenance);
    if (
      previous !== undefined &&
      (previous.narration.id !== row.narration_script_id ||
        previous.narration.scriptSha256 !== row.script_sha256)
    ) {
      throw new AudioGenerationError("invalid_result");
    }
    chapters.set(row.chapter_id, {
      chapterOrder: row.chapter_order,
      id: row.chapter_id,
      narration: {
        id: row.narration_script_id,
        modelProvenance: provenance,
        scriptSha256: row.script_sha256,
        sourceSpanIds: [
          ...(previous?.narration.sourceSpanIds ?? []),
          row.source_span_id,
        ],
        text: row.script_text,
        version: row.generation_version,
      },
    });
  }
  return [...chapters.values()];
}

function operationSelect(): string {
  return `SELECT audio.id, audio.chapter_id, audio.narration_script_id,
                 audio.generation_version, audio.priority, audio.asset_id,
                 operation.idempotency_key, operation.state,
                 operation.attempt_count, operation.deadline_at,
                 operation.lease_owner, operation.updated_at,
                 operation.sanitized_failure->>'failureClass' AS failure_class,
                 operation.lease_expires_at > clock_timestamp() AS lease_active
          FROM audio_generation_operation AS audio
          JOIN async_operation AS operation
            ON operation.owner_scope_id = audio.owner_scope_id
           AND operation.id = audio.id`;
}

async function selectOperation(
  client: PoolClient,
  ownerScopeId: string,
  courseId: string,
  operationId: string,
  lock: boolean,
): Promise<
  | (AudioOperationView & { leaseActive: boolean; leaseOwner: string | null })
  | null
> {
  const result = await client.query<AudioOperationRow>(
    `${operationSelect()}
     WHERE audio.owner_scope_id = $1 AND audio.course_id = $2 AND audio.id = $3
     ${lock ? "FOR UPDATE OF operation, audio" : ""}`,
    [ownerScopeId, courseId, operationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...operationView(row),
    leaseActive: row.lease_active,
    leaseOwner: row.lease_owner,
  };
}

function operationView(row: AudioOperationRow): AudioOperationView {
  return {
    assetId: row.asset_id,
    attemptCount: row.attempt_count,
    chapterId: row.chapter_id,
    deadlineAt: row.deadline_at,
    failureClass: row.failure_class,
    generationVersion: row.generation_version,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    narrationScriptId: row.narration_script_id,
    priority: row.priority,
    status: row.state,
    updatedAt: row.updated_at,
  };
}

async function assertAuthorizedSourceSpans(
  client: PoolClient,
  work: AudioGenerationWork,
  sourceSpanIds: readonly string[],
): Promise<void> {
  if (
    sourceSpanIds.length === 0 ||
    new Set(sourceSpanIds).size !== sourceSpanIds.length ||
    sourceSpanIds.some(
      (id) => !work.chapter.narration.sourceSpanIds.includes(id),
    )
  ) {
    throw new AudioGenerationError("authorization_denied");
  }
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM narration_script_source_span AS link
     JOIN source_span AS span
       ON span.owner_scope_id = link.owner_scope_id
      AND span.id = link.source_span_id
     WHERE link.owner_scope_id = $1 AND link.narration_script_id = $2
       AND link.source_span_id = ANY($3::uuid[])
       AND span.source_document_id = $4`,
    [
      work.course.ownerScopeId,
      work.chapter.narration.id,
      sourceSpanIds,
      work.course.sourceDocumentId,
    ],
  );
  if (result.rows[0]?.count !== sourceSpanIds.length) {
    throw new AudioGenerationError("authorization_denied");
  }
}

async function insertAssetSourceSpans(
  client: PoolClient,
  ownerScopeId: string,
  assetId: string,
  sourceSpanIds: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO asset_source_span (owner_scope_id, asset_id, source_span_id)
     SELECT $1, $2, unnest($3::uuid[])
     ON CONFLICT DO NOTHING`,
    [ownerScopeId, assetId, sourceSpanIds],
  );
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM asset_source_span
     WHERE owner_scope_id = $1 AND asset_id = $2
       AND source_span_id = ANY($3::uuid[])`,
    [ownerScopeId, assetId, sourceSpanIds],
  );
  if (result.rows[0]?.count !== sourceSpanIds.length) {
    throw new AudioGenerationError("invalid_result");
  }
}

async function finishAttempt(
  client: PoolClient,
  ownerScopeId: string,
  operationId: string,
  deliveryNumber: number,
  outcome: AudioOperationView["status"],
  failureClass: string | null,
): Promise<void> {
  const result = await client.query(
    `UPDATE async_operation_attempt
     SET outcome = $1, normalized_failure_class = $2, finished_at = now()
     WHERE owner_scope_id = $3 AND operation_id = $4
       AND delivery_number = $5 AND outcome = 'started'`,
    [outcome, failureClass, ownerScopeId, operationId, deliveryNumber],
  );
  if (deliveryNumber > 0 && result.rowCount !== 1) {
    throw new AudioGenerationError("operation_unavailable");
  }
}

async function insertTerminalEvent(
  client: PoolClient,
  course: AuthorizedAudioCourse,
  operation: AudioOperationView,
  event: {
    readonly assetId: string | null;
    readonly messageName: "media.audio.failed" | "media.audio.generated";
    readonly status: string;
  },
): Promise<void> {
  const environment = operation.idempotencyKey.split("/", 1)[0];
  const eventId = stableUuid({
    messageName: event.messageName,
    operationId: operation.id,
  });
  const idempotencyKey = `${environment}/${event.messageName}/v1/${operation.id}`;
  await client.query(
    `INSERT INTO outbox_message
       (message_id, owner_scope_id, operation_id, message_kind,
        message_name, message_version, producer, environment, correlation_id,
        idempotency_key, payload, occurred_at)
     VALUES ($1, $2, $3, 'event', $4, 1, 'audio-generation', $5, $6,
             $7, $8::jsonb, now())
     ON CONFLICT (message_id) DO NOTHING`,
    [
      eventId,
      course.ownerScopeId,
      operation.id,
      event.messageName,
      environment,
      stableUuid({
        courseId: course.courseId,
        generationVersion: AUDIO_GENERATION_VERSION,
      }),
      idempotencyKey,
      JSON.stringify({
        assetId: event.assetId,
        courseId: course.courseId,
        operationId: operation.id,
        ownerScopeId: course.ownerScopeId,
        status: event.status,
      }),
    ],
  );
}

async function assertCanonicalEnvelope(
  client: PoolClient,
  ownerScopeId: string,
  envelope: AudioGenerationEnvelope,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM outbox_message
     WHERE owner_scope_id = $1 AND operation_id = $2
       AND message_id = $3 AND message_kind = $4
       AND message_name = $5 AND message_version = $6
       AND producer = $7 AND environment = $8
       AND correlation_id = $9
       AND causation_id IS NOT DISTINCT FROM $10::uuid
       AND idempotency_key = $11 AND payload = $12::jsonb
       AND occurred_at = $13 AND deadline_at = $14`,
    [
      ownerScopeId,
      envelope.payload.operationId,
      envelope.messageId,
      envelope.messageKind,
      envelope.messageName,
      envelope.messageVersion,
      envelope.producer,
      envelope.environment,
      envelope.correlationId,
      envelope.causationId ?? null,
      envelope.idempotencyKey,
      JSON.stringify(envelope.payload),
      envelope.occurredAt,
      envelope.deadlineAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw new AudioGenerationError("invalid_envelope");
  }
}

async function setScopeContext(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
): Promise<void> {
  validateUuid(authorization.actorId);
  validateUuid(authorization.ownerScopeId);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(authorization.authorizationId)) {
    throw new AudioGenerationError("authorization_denied");
  }
  await client.query(
    `SELECT set_config('reflo.actor_id', $1, true),
            set_config('reflo.owner_scope_id', $2, true)`,
    [authorization.actorId, authorization.ownerScopeId],
  );
}

function assertPlannedOperation(
  course: AuthorizedAudioCourse,
  operation: PlannedAudioOperation,
): void {
  const chapter = course.chapters.find(
    (candidate) => candidate.id === operation.chapterId,
  );
  if (
    chapter === undefined ||
    chapter.narration.id !== operation.narrationScriptId ||
    operation.generationVersion !== AUDIO_GENERATION_VERSION ||
    operation.priority !== chapter.chapterOrder ||
    operation.envelope.payload.operationId !== operation.id ||
    operation.envelope.payload.courseId !== course.courseId ||
    operation.envelope.payload.ownerScopeId !== course.ownerScopeId ||
    operation.envelope.idempotencyKey !== operation.idempotencyKey ||
    operation.envelope.deadlineAt !== operation.deadlineAt.toISOString()
  ) {
    throw new AudioGenerationError("invalid_result");
  }
}

function assertGeneratedAsset(
  work: AudioGenerationWork,
  asset: GeneratedAudioAsset,
): void {
  if (
    asset.narrationScriptId !== work.chapter.narration.id ||
    asset.narrationScriptSha256 !== work.chapter.narration.scriptSha256 ||
    asset.payload.payloadSha256.length !== 64 ||
    asset.payload.byteLength !== asset.storage.byteSize ||
    asset.payload.contractVersion !== "audio-payload-v1" ||
    asset.payload.headerValidated !== true ||
    asset.storage.contentType !== "audio/wav" ||
    asset.sourceSpanIds.length === 0
  ) {
    throw new AudioGenerationError("invalid_result");
  }
}

function assertProcessingAttempt(
  current: AudioOperationView & { leaseOwner?: string | null },
  work: AudioGenerationWork,
  leaseOwner: string,
): void {
  if (
    current.status !== "processing" ||
    current.attemptCount !== work.operation.attemptCount ||
    current.leaseOwner !== leaseOwner
  ) {
    throw new AudioGenerationError("operation_unavailable");
  }
}

function assertSameCourse(
  expected: AuthorizedAudioCourse,
  actual: AuthorizedAudioCourse,
): void {
  if (
    expected.actorId !== actual.actorId ||
    expected.authorizationId !== actual.authorizationId ||
    expected.ownerScopeId !== actual.ownerScopeId ||
    expected.courseId !== actual.courseId ||
    expected.sourceDocumentId !== actual.sourceDocumentId
  ) {
    throw new AudioGenerationError("authorization_denied");
  }
}

function modelProvenance(
  value: unknown,
): AuthorizedNarrationScript["modelProvenance"] {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).task !== "lesson.audio-script.v1" ||
    (value as Record<string, unknown>).validationOutcome !== "passed"
  ) {
    throw new AudioGenerationError("invalid_result");
  }
  return value as AuthorizedNarrationScript["modelProvenance"];
}

function validateAuthorization(
  authorization: ScopeAuthorizationContext,
  courseId: string,
): void {
  validateUuid(authorization.actorId);
  validateUuid(authorization.ownerScopeId);
  validateUuid(courseId);
}

function validateUuid(value: string): void {
  if (!/^[a-f0-9-]{36}$/.test(value)) {
    throw new AudioGenerationError("authorization_denied");
  }
}

function isTerminal(status: AudioOperationView["status"]): boolean {
  return ["succeeded", "failed_permanent", "cancelled", "expired"].includes(
    status,
  );
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new AudioGenerationError("operation_unavailable");
  }
  return value;
}
