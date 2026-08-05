import {
  CURRICULUM_PARENT_DEADLINE_MS,
  type ScopeAuthorizationContext,
} from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;
const GENERATION_LEASE_OWNER = "api_demo_upload_generation_v1";
const GENERATION_LEASE_MS = 1_200_000;
const MAX_GENERATION_DELIVERIES = 3;

export interface DemoUploadCreate {
  readonly authorization: ScopeAuthorizationContext;
  readonly byteSize: number;
  readonly checksum: string;
  readonly courseId: string;
  readonly generationOperationId: string;
  readonly mediaType: string;
  readonly objectKey: string;
  readonly operationId: string;
  readonly replacesSourceDocumentId?: string;
  readonly sourceDocumentId: string;
  readonly title: string;
}

export interface DemoUploadProcessingWorkRecord {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly expectedInputSha256: string;
  readonly generationOperationId: string;
  readonly operationId: string;
  readonly sourceDocumentId: string;
}

export type DemoUploadGenerationClaim =
  | { readonly kind: "active" }
  | {
      readonly kind: "claimed";
      readonly deadlineMs: number;
    }
  | {
      readonly kind: "completed";
      readonly outcome: "failed" | "succeeded";
    };

export interface DemoUploadGenerationFailure {
  readonly failureClass: string;
  readonly retryable: boolean;
}

export interface DemoUploadSnapshot {
  readonly activeCurriculumGenerationId: string | null;
  readonly byteSize: number;
  readonly checksum: string;
  readonly courseId: string;
  readonly courseStatus: "archived" | "failed" | "generating" | "ready";
  readonly failureClass: string | null;
  readonly operationState:
    | "cancelled"
    | "expired"
    | "failed_permanent"
    | "processing"
    | "queued"
    | "retry_scheduled"
    | "succeeded";
  readonly pageCount: number | null;
  readonly parseStatus:
    | "failed"
    | "ocr_required"
    | "parsed"
    | "parsing"
    | "quarantined"
    | "queued"
    | "validating";
  readonly sourceDocumentId: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface DemoUploadOutlineSnapshot {
  readonly chapters: readonly {
    readonly chapterId: string;
    readonly concepts: readonly {
      readonly conceptId: string;
      readonly name: string;
      readonly sourceSpanCount: number;
    }[];
    readonly order: number;
    readonly title: string;
  }[];
  readonly courseId: string;
  readonly generatedAt: Date;
  readonly title: string;
}

export class PostgresDemoUploadRepository {
  readonly #environment: "dev" | "pilot" | "staging";
  readonly #pool: InstanceType<typeof Pool>;

  constructor(
    connectionString: string,
    options: { readonly environment: "dev" | "pilot" | "staging" },
  ) {
    if (connectionString.trim() === "") {
      throw new Error("demo upload database URL is required");
    }
    this.#environment = options.environment;
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async create(input: DemoUploadCreate): Promise<void> {
    validateCreate(input);
    await this.#transaction(input.authorization, async (client) => {
      const authorized = await client.query<{ allowed: boolean }>(
        "SELECT reflo_has_active_membership($1) AS allowed",
        [input.authorization.ownerScopeId],
      );
      if (authorized.rows[0]?.allowed !== true) {
        throw new Error("demo_upload_authorization_denied");
      }
      if (input.replacesSourceDocumentId !== undefined) {
        const replaced = await client.query<{ course_id: string }>(
          `UPDATE course AS replaced_course
           SET status = 'archived', updated_at = clock_timestamp()
           FROM source_document AS replaced_source,
                ingestion_operation AS replaced_ingestion,
                async_operation AS replaced_operation
           WHERE replaced_course.owner_scope_id = $1
             AND replaced_course.source_document_id = $2
             AND replaced_course.status <> 'archived'
             AND replaced_source.owner_scope_id = replaced_course.owner_scope_id
             AND replaced_source.id = replaced_course.source_document_id
             AND replaced_source.retention_status = 'active'
             AND replaced_source.checksum = $3
             AND replaced_source.media_type = $4
             AND replaced_source.byte_size = $5
             AND replaced_ingestion.owner_scope_id = replaced_source.owner_scope_id
             AND replaced_ingestion.source_document_id = replaced_source.id
             AND replaced_operation.owner_scope_id = replaced_ingestion.owner_scope_id
             AND replaced_operation.id = replaced_ingestion.operation_id
             AND (
               replaced_course.status = 'failed'
               OR replaced_source.parse_status = 'failed'
               OR replaced_operation.state IN
                    ('cancelled', 'expired', 'failed_permanent')
             )
           RETURNING replaced_course.id AS course_id`,
          [
            input.authorization.ownerScopeId,
            input.replacesSourceDocumentId,
            input.checksum,
            input.mediaType,
            input.byteSize,
          ],
        );
        if (replaced.rows.length !== 1) {
          throw new Error("demo_upload_retry_rejected");
        }
      }
      await client.query(
        `INSERT INTO source_document
           (id, owner_scope_id, object_key, checksum, media_type, byte_size,
            parse_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'quarantined')`,
        [
          input.sourceDocumentId,
          input.authorization.ownerScopeId,
          input.objectKey,
          input.checksum,
          input.mediaType,
          input.byteSize,
        ],
      );
      await client.query(
        `INSERT INTO course
           (id, owner_scope_id, source_document_id, title, status)
         VALUES ($1, $2, $3, $4, 'generating')`,
        [
          input.courseId,
          input.authorization.ownerScopeId,
          input.sourceDocumentId,
          input.title,
        ],
      );
      await client.query(
        `INSERT INTO async_operation
           (id, owner_scope_id, operation_name, operation_version,
            idempotency_key, state, deadline_at)
         VALUES ($1, $2, 'ingestion.parse', 1, $3, 'queued',
                 clock_timestamp() + interval '30 minutes')`,
        [
          input.operationId,
          input.authorization.ownerScopeId,
          `${this.#environment}/ingestion.parse/v1/${input.sourceDocumentId}`,
        ],
      );
      await client.query(
        `INSERT INTO ingestion_operation
           (operation_id, owner_scope_id, requested_by_user_id,
            source_document_id, input_sha256)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          input.operationId,
          input.authorization.ownerScopeId,
          input.authorization.actorId,
          input.sourceDocumentId,
          input.checksum,
        ],
      );
      await client.query(
        `INSERT INTO async_operation
           (id, owner_scope_id, operation_name, operation_version,
            idempotency_key, state, deadline_at)
         VALUES ($1, $2, 'curriculum.generate', 1, $3, 'queued',
                 clock_timestamp() +
                   ($4::bigint * interval '1 millisecond'))`,
        [
          input.generationOperationId,
          input.authorization.ownerScopeId,
          `${this.#environment}/curriculum.generate/v1/${input.courseId}`,
          CURRICULUM_PARENT_DEADLINE_MS,
        ],
      );
      await client.query(
        `INSERT INTO demo_upload_generation_operation
           (operation_id, owner_scope_id, requested_by_user_id, course_id,
            source_document_id, input_sha256)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.generationOperationId,
          input.authorization.ownerScopeId,
          input.authorization.actorId,
          input.courseId,
          input.sourceDocumentId,
          input.checksum,
        ],
      );
    });
  }

  async listRecoverable(
    authorization: ScopeAuthorizationContext,
  ): Promise<readonly DemoUploadProcessingWorkRecord[]> {
    return this.#processingWork(authorization);
  }

  async getProcessingWork(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId: string,
  ): Promise<DemoUploadProcessingWorkRecord | null> {
    if (!isUuid(sourceDocumentId)) {
      return null;
    }
    const results = await this.#processingWork(authorization, sourceDocumentId);
    return results[0] ?? null;
  }

  async claimCourseGeneration(
    work: DemoUploadProcessingWorkRecord,
  ): Promise<DemoUploadGenerationClaim> {
    validateProcessingWork(work);
    return this.#transaction(work.authorization, async (client) => {
      const result = await client.query<GenerationOperationRow>(
        `SELECT operation.state, operation.attempt_count,
                operation.deadline_at,
                operation.lease_expires_at > clock_timestamp()
                  AS lease_active,
                operation.deadline_at <= clock_timestamp()
                  AS deadline_expired,
                course.status AS course_status,
                course.active_curriculum_generation_id
         FROM demo_upload_generation_operation AS generation
         JOIN async_operation AS operation
           ON operation.owner_scope_id = generation.owner_scope_id
          AND operation.id = generation.operation_id
         JOIN course
           ON course.owner_scope_id = generation.owner_scope_id
          AND course.id = generation.course_id
         JOIN source_document AS source
           ON source.owner_scope_id = generation.owner_scope_id
          AND source.id = generation.source_document_id
         WHERE generation.owner_scope_id = $1
           AND generation.operation_id = $2
           AND generation.course_id = $3
           AND generation.source_document_id = $4
           AND generation.input_sha256 = $5
           AND source.retention_status = 'active'
           AND source.parse_status = 'parsed'
         FOR UPDATE OF operation, course`,
        [
          work.authorization.ownerScopeId,
          work.generationOperationId,
          work.courseId,
          work.sourceDocumentId,
          work.expectedInputSha256,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("demo_upload_generation_authorization_denied");
      }
      if (row.state === "succeeded") {
        return { kind: "completed", outcome: "succeeded" };
      }
      if (
        row.state === "failed_permanent" ||
        row.state === "cancelled" ||
        row.state === "expired" ||
        row.course_status === "failed"
      ) {
        return { kind: "completed", outcome: "failed" };
      }
      if (
        row.course_status === "ready" &&
        row.active_curriculum_generation_id !== null
      ) {
        await finalizeRecoveredGenerationSuccess(
          client,
          work.authorization.ownerScopeId,
          work.generationOperationId,
          row.attempt_count,
        );
        return { kind: "completed", outcome: "succeeded" };
      }
      if (row.state === "processing" && row.lease_active) {
        return { kind: "active" };
      }
      if (row.state === "processing") {
        await finishGenerationAttempt(
          client,
          work.authorization.ownerScopeId,
          work.generationOperationId,
          row.attempt_count,
          row.attempt_count >= MAX_GENERATION_DELIVERIES || row.deadline_expired
            ? "failed_permanent"
            : "retry_scheduled",
          "generation_dependency_unavailable",
        );
      }
      if (
        row.attempt_count >= MAX_GENERATION_DELIVERIES ||
        row.deadline_expired
      ) {
        await finalizeGenerationFailure(
          client,
          work.authorization.ownerScopeId,
          work.generationOperationId,
          work.sourceDocumentId,
          "generation_deadline_exceeded",
        );
        return { kind: "completed", outcome: "failed" };
      }
      if (
        row.state !== "queued" &&
        row.state !== "retry_scheduled" &&
        row.state !== "processing"
      ) {
        throw new Error("demo_upload_generation_state_invalid");
      }
      const claimed = await client.query<{
        attempt_count: number;
        deadline_ms: string;
      }>(
        `UPDATE async_operation
         SET state = 'processing', lease_owner = $3,
             lease_expires_at =
               clock_timestamp() + ($4 * interval '1 millisecond'),
             attempt_count = attempt_count + 1,
             result_ref = NULL, sanitized_failure = NULL,
             updated_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND id = $2
         RETURNING attempt_count,
           GREATEST(
             1,
             floor(extract(epoch FROM
               (deadline_at - clock_timestamp())) * 1000)
           )::bigint::text AS deadline_ms`,
        [
          work.authorization.ownerScopeId,
          work.generationOperationId,
          GENERATION_LEASE_OWNER,
          GENERATION_LEASE_MS,
        ],
      );
      const attempt = claimed.rows[0];
      if (attempt === undefined) {
        throw new Error("demo_upload_generation_claim_failed");
      }
      await client.query(
        `INSERT INTO async_operation_attempt
           (owner_scope_id, operation_id, delivery_number, outcome)
         VALUES ($1, $2, $3, 'started')`,
        [
          work.authorization.ownerScopeId,
          work.generationOperationId,
          attempt.attempt_count,
        ],
      );
      return {
        deadlineMs: Math.min(
          CURRICULUM_PARENT_DEADLINE_MS,
          Number(attempt.deadline_ms),
        ),
        kind: "claimed",
      };
    });
  }

  async completeCourseGeneration(
    work: DemoUploadProcessingWorkRecord,
  ): Promise<void> {
    validateProcessingWork(work);
    await this.#transaction(work.authorization, async (client) => {
      const result = await client.query<{ attempt_count: number }>(
        `SELECT operation.attempt_count
         FROM demo_upload_generation_operation AS generation
         JOIN async_operation AS operation
           ON operation.owner_scope_id = generation.owner_scope_id
          AND operation.id = generation.operation_id
         JOIN course
           ON course.owner_scope_id = generation.owner_scope_id
          AND course.id = generation.course_id
         WHERE generation.owner_scope_id = $1
           AND generation.operation_id = $2
           AND generation.course_id = $3
           AND generation.source_document_id = $4
           AND generation.input_sha256 = $5
           AND operation.state = 'processing'
           AND operation.lease_owner = $6
           AND operation.lease_expires_at > clock_timestamp()
           AND course.status = 'ready'
           AND course.active_curriculum_generation_id IS NOT NULL
         FOR UPDATE OF operation`,
        [
          work.authorization.ownerScopeId,
          work.generationOperationId,
          work.courseId,
          work.sourceDocumentId,
          work.expectedInputSha256,
          GENERATION_LEASE_OWNER,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("demo_upload_generation_completion_rejected");
      }
      await client.query(
        `UPDATE async_operation
         SET state = 'succeeded', lease_owner = NULL,
             lease_expires_at = NULL, result_ref = '{"kind":"succeeded"}',
             sanitized_failure = NULL, updated_at = clock_timestamp(),
             completed_at = clock_timestamp()
         WHERE owner_scope_id = $1 AND id = $2`,
        [work.authorization.ownerScopeId, work.generationOperationId],
      );
      await finishGenerationAttempt(
        client,
        work.authorization.ownerScopeId,
        work.generationOperationId,
        row.attempt_count,
        "succeeded",
        null,
      );
    });
  }

  async failCourseGenerationAttempt(
    work: DemoUploadProcessingWorkRecord,
    failure: DemoUploadGenerationFailure,
  ): Promise<"failed" | "retry_scheduled"> {
    validateProcessingWork(work);
    validateGenerationFailure(failure);
    return this.#transaction(work.authorization, async (client) => {
      const result = await client.query<{
        attempt_count: number;
        deadline_expired: boolean;
      }>(
        `SELECT operation.attempt_count,
                operation.deadline_at <= clock_timestamp()
                  AS deadline_expired
         FROM demo_upload_generation_operation AS generation
         JOIN async_operation AS operation
           ON operation.owner_scope_id = generation.owner_scope_id
          AND operation.id = generation.operation_id
         WHERE generation.owner_scope_id = $1
           AND generation.operation_id = $2
           AND generation.course_id = $3
           AND generation.source_document_id = $4
           AND generation.input_sha256 = $5
           AND operation.state = 'processing'
           AND operation.lease_owner = $6
           AND operation.lease_expires_at > clock_timestamp()
         FOR UPDATE OF operation`,
        [
          work.authorization.ownerScopeId,
          work.generationOperationId,
          work.courseId,
          work.sourceDocumentId,
          work.expectedInputSha256,
          GENERATION_LEASE_OWNER,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("demo_upload_generation_failure_rejected");
      }
      const retry =
        failure.retryable &&
        row.attempt_count < MAX_GENERATION_DELIVERIES &&
        !row.deadline_expired;
      await client.query(
        `UPDATE async_operation
         SET state = $3, lease_owner = NULL, lease_expires_at = NULL,
             result_ref = $4, sanitized_failure = $5,
             updated_at = clock_timestamp(),
             completed_at = CASE WHEN $3 = 'retry_scheduled'
               THEN NULL ELSE clock_timestamp() END
         WHERE owner_scope_id = $1 AND id = $2`,
        [
          work.authorization.ownerScopeId,
          work.generationOperationId,
          retry ? "retry_scheduled" : "failed_permanent",
          {
            failure: { class: failure.failureClass, retryable: retry },
            kind: "failed",
          },
          { class: failure.failureClass },
        ],
      );
      await finishGenerationAttempt(
        client,
        work.authorization.ownerScopeId,
        work.generationOperationId,
        row.attempt_count,
        retry ? "retry_scheduled" : "failed_permanent",
        failure.failureClass,
      );
      if (!retry) {
        await client.query(
          `UPDATE course
           SET status = 'failed', updated_at = clock_timestamp()
           WHERE owner_scope_id = $1
             AND id = $2
             AND source_document_id = $3
             AND status = 'generating'`,
          [
            work.authorization.ownerScopeId,
            work.courseId,
            work.sourceDocumentId,
          ],
        );
      }
      return retry ? "retry_scheduled" : "failed";
    });
  }

  async get(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId: string,
  ): Promise<DemoUploadSnapshot | null> {
    if (!isUuid(sourceDocumentId)) {
      return null;
    }
    return this.#transaction(authorization, async (client) => {
      const result = await client.query<SnapshotRow>(
        `SELECT source.id AS source_document_id, source.checksum,
                source.byte_size::integer, source.page_count,
                source.parse_status, course.id AS course_id, course.title,
                course.status AS course_status,
                course.active_curriculum_generation_id,
                operation.state AS operation_state,
                CASE
                  WHEN course.status = 'failed'
                    AND source.parse_status = 'parsed'
                    THEN 'curriculum_generation_failed'
                  ELSE operation.sanitized_failure->>'class'
                END AS failure_class,
                GREATEST(source.updated_at, course.updated_at,
                         operation.updated_at) AS updated_at
         FROM source_document AS source
         JOIN course
           ON course.owner_scope_id = source.owner_scope_id
          AND course.source_document_id = source.id
         JOIN ingestion_operation AS ingestion
           ON ingestion.owner_scope_id = source.owner_scope_id
          AND ingestion.source_document_id = source.id
         JOIN async_operation AS operation
           ON operation.owner_scope_id = ingestion.owner_scope_id
          AND operation.id = ingestion.operation_id
         WHERE source.owner_scope_id = $1
           AND source.id = $2
           AND source.retention_status = 'active'
           AND course.status <> 'archived'
         ORDER BY course.created_at, course.id
         LIMIT 1`,
        [authorization.ownerScopeId, sourceDocumentId],
      );
      const row = result.rows[0];
      return row === undefined ? null : snapshot(row);
    });
  }

  async loadOutline(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId: string,
  ): Promise<DemoUploadOutlineSnapshot | null> {
    if (!isUuid(sourceDocumentId)) {
      return null;
    }
    return this.#transaction(authorization, async (client) => {
      const courseResult = await client.query<{
        course_id: string;
        generated_at: Date;
        title: string;
      }>(
        `SELECT course.id AS course_id, course.title,
                course.updated_at AS generated_at
         FROM course
         JOIN source_document AS source
           ON source.owner_scope_id = course.owner_scope_id
          AND source.id = course.source_document_id
         WHERE course.owner_scope_id = $1
           AND source.id = $2
           AND source.retention_status = 'active'
           AND course.status = 'ready'
           AND course.active_curriculum_generation_id IS NOT NULL`,
        [authorization.ownerScopeId, sourceDocumentId],
      );
      const course = courseResult.rows[0];
      if (course === undefined) {
        return null;
      }
      const result = await client.query<OutlineRow>(
        `SELECT chapter.id AS chapter_id, chapter.chapter_order,
                chapter.title AS chapter_title, concept.id AS concept_id,
                concept.name AS concept_name,
                count(concept_span.source_span_id)::integer
                  AS source_span_count
         FROM course
         JOIN chapter
           ON chapter.owner_scope_id = course.owner_scope_id
          AND chapter.course_id = course.id
          AND chapter.curriculum_generation_id =
              course.active_curriculum_generation_id
         LEFT JOIN concept
           ON concept.owner_scope_id = chapter.owner_scope_id
          AND concept.chapter_id = chapter.id
          AND concept.curriculum_generation_id =
              course.active_curriculum_generation_id
         LEFT JOIN concept_source_span AS concept_span
           ON concept_span.owner_scope_id = concept.owner_scope_id
          AND concept_span.concept_id = concept.id
         WHERE course.owner_scope_id = $1 AND course.id = $2
         GROUP BY chapter.id, chapter.chapter_order, chapter.title,
                  concept.id, concept.name, concept.concept_order
         ORDER BY chapter.chapter_order, chapter.id,
                  concept.concept_order NULLS LAST, concept.id`,
        [authorization.ownerScopeId, course.course_id],
      );
      const chapters = new Map<
        string,
        DemoUploadOutlineSnapshot["chapters"][number]
      >();
      for (const row of result.rows) {
        let chapter = chapters.get(row.chapter_id);
        if (chapter === undefined) {
          chapter = {
            chapterId: row.chapter_id,
            concepts: [],
            order: row.chapter_order,
            title: row.chapter_title,
          };
          chapters.set(row.chapter_id, chapter);
        }
        if (row.concept_id !== null && row.concept_name !== null) {
          (
            chapter.concepts as {
              conceptId: string;
              name: string;
              sourceSpanCount: number;
            }[]
          ).push({
            conceptId: row.concept_id,
            name: row.concept_name,
            sourceSpanCount: row.source_span_count,
          });
        }
      }
      return {
        chapters: [...chapters.values()],
        courseId: course.course_id,
        generatedAt: course.generated_at,
        title: course.title,
      };
    });
  }

  async #processingWork(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId?: string,
  ): Promise<readonly DemoUploadProcessingWorkRecord[]> {
    return this.#transaction(authorization, async (client) => {
      const result = await client.query<ProcessingWorkRow>(
        `SELECT ingestion.operation_id,
                generation.operation_id AS generation_operation_id,
                generation.course_id, generation.source_document_id,
                generation.input_sha256
         FROM demo_upload_generation_operation AS generation
         JOIN async_operation AS generation_state
           ON generation_state.owner_scope_id = generation.owner_scope_id
          AND generation_state.id = generation.operation_id
         JOIN ingestion_operation AS ingestion
           ON ingestion.owner_scope_id = generation.owner_scope_id
          AND ingestion.source_document_id = generation.source_document_id
         JOIN async_operation AS ingestion_state
           ON ingestion_state.owner_scope_id = ingestion.owner_scope_id
          AND ingestion_state.id = ingestion.operation_id
         JOIN source_document AS source
           ON source.owner_scope_id = generation.owner_scope_id
          AND source.id = generation.source_document_id
         JOIN course
           ON course.owner_scope_id = generation.owner_scope_id
          AND course.id = generation.course_id
         WHERE generation.owner_scope_id = $1
           AND ($2::uuid IS NULL OR generation.source_document_id = $2)
           AND source.retention_status = 'active'
           AND course.status = 'generating'
           AND (
             (
               ingestion_state.state IN
                 ('queued', 'processing', 'retry_scheduled')
               AND source.parse_status IN
                 ('quarantined', 'validating', 'queued', 'parsing')
             )
             OR (
               ingestion_state.state = 'succeeded'
               AND source.parse_status = 'parsed'
               AND generation_state.state IN
                 ('queued', 'processing', 'retry_scheduled')
             )
           )
         ORDER BY source.created_at, source.id`,
        [authorization.ownerScopeId, sourceDocumentId ?? null],
      );
      return result.rows.map((row) => ({
        authorization,
        courseId: row.course_id,
        expectedInputSha256: row.input_sha256,
        generationOperationId: row.generation_operation_id,
        operationId: row.operation_id,
        sourceDocumentId: row.source_document_id,
      }));
    });
  }

  async #transaction<Value>(
    authorization: ScopeAuthorizationContext,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await setScopeContext(client, authorization);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface SnapshotRow extends Record<string, unknown> {
  active_curriculum_generation_id: string | null;
  byte_size: number;
  checksum: string;
  course_id: string;
  course_status: DemoUploadSnapshot["courseStatus"];
  failure_class: string | null;
  operation_state: DemoUploadSnapshot["operationState"];
  page_count: number | null;
  parse_status: DemoUploadSnapshot["parseStatus"];
  source_document_id: string;
  title: string;
  updated_at: Date;
}

interface OutlineRow extends Record<string, unknown> {
  chapter_id: string;
  chapter_order: number;
  chapter_title: string;
  concept_id: string | null;
  concept_name: string | null;
  source_span_count: number;
}

interface ProcessingWorkRow extends Record<string, unknown> {
  course_id: string;
  generation_operation_id: string;
  input_sha256: string;
  operation_id: string;
  source_document_id: string;
}

interface GenerationOperationRow extends Record<string, unknown> {
  active_curriculum_generation_id: string | null;
  attempt_count: number;
  course_status: DemoUploadSnapshot["courseStatus"];
  deadline_at: Date;
  deadline_expired: boolean;
  lease_active: boolean;
  state: DemoUploadSnapshot["operationState"];
}

function snapshot(row: SnapshotRow): DemoUploadSnapshot {
  return {
    activeCurriculumGenerationId: row.active_curriculum_generation_id,
    byteSize: row.byte_size,
    checksum: row.checksum,
    courseId: row.course_id,
    courseStatus: row.course_status,
    failureClass: row.failure_class,
    operationState: row.operation_state,
    pageCount: row.page_count,
    parseStatus: row.parse_status,
    sourceDocumentId: row.source_document_id,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

async function setScopeContext(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
): Promise<void> {
  await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
    authorization.actorId,
  ]);
  await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
    authorization.ownerScopeId,
  ]);
}

function validateCreate(input: DemoUploadCreate): void {
  if (
    !isUuid(input.authorization.actorId) ||
    !isUuid(input.authorization.ownerScopeId) ||
    input.authorization.authorizationId.length < 8 ||
    !isUuid(input.courseId) ||
    !isUuid(input.generationOperationId) ||
    !isUuid(input.operationId) ||
    (input.replacesSourceDocumentId !== undefined &&
      (!isUuid(input.replacesSourceDocumentId) ||
        input.replacesSourceDocumentId === input.sourceDocumentId)) ||
    !isUuid(input.sourceDocumentId) ||
    input.byteSize < 1 ||
    !Number.isSafeInteger(input.byteSize) ||
    !/^[a-f0-9]{64}$/.test(input.checksum) ||
    input.title.length < 1 ||
    input.title.length > 240 ||
    !input.objectKey.startsWith(
      `owners/${input.authorization.ownerScopeId}/sources/${input.sourceDocumentId}/`,
    )
  ) {
    throw new Error("invalid demo upload");
  }
}

function validateProcessingWork(work: DemoUploadProcessingWorkRecord): void {
  if (
    !isUuid(work.authorization.actorId) ||
    work.authorization.authorizationId.length < 8 ||
    !isUuid(work.authorization.ownerScopeId) ||
    !isUuid(work.courseId) ||
    !/^[a-f0-9]{64}$/.test(work.expectedInputSha256) ||
    !isUuid(work.generationOperationId) ||
    !isUuid(work.operationId) ||
    !isUuid(work.sourceDocumentId)
  ) {
    throw new Error("invalid demo upload processing work");
  }
}

function validateGenerationFailure(failure: DemoUploadGenerationFailure): void {
  if (
    !/^[a-z][a-z0-9_]{2,63}$/.test(failure.failureClass) ||
    typeof failure.retryable !== "boolean"
  ) {
    throw new Error("invalid demo upload generation failure");
  }
}

async function finishGenerationAttempt(
  client: PoolClient,
  ownerScopeId: string,
  operationId: string,
  attemptCount: number,
  outcome: "failed_permanent" | "retry_scheduled" | "succeeded",
  failureClass: string | null,
): Promise<void> {
  await client.query(
    `UPDATE async_operation_attempt
     SET outcome = $4, normalized_failure_class = $5,
         finished_at = clock_timestamp()
     WHERE owner_scope_id = $1 AND operation_id = $2
       AND delivery_number = $3 AND outcome = 'started'`,
    [ownerScopeId, operationId, attemptCount, outcome, failureClass],
  );
}

async function finalizeRecoveredGenerationSuccess(
  client: PoolClient,
  ownerScopeId: string,
  operationId: string,
  attemptCount: number,
): Promise<void> {
  const updated = await client.query(
    `UPDATE async_operation
     SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
         result_ref = '{"kind":"succeeded"}', sanitized_failure = NULL,
         updated_at = clock_timestamp(),
         completed_at = clock_timestamp()
     WHERE owner_scope_id = $1 AND id = $2
       AND state IN ('queued', 'processing', 'retry_scheduled')`,
    [ownerScopeId, operationId],
  );
  if (updated.rowCount === 1 && attemptCount > 0) {
    await finishGenerationAttempt(
      client,
      ownerScopeId,
      operationId,
      attemptCount,
      "succeeded",
      null,
    );
  }
}

async function finalizeGenerationFailure(
  client: PoolClient,
  ownerScopeId: string,
  operationId: string,
  sourceDocumentId: string,
  failureClass: string,
): Promise<void> {
  await client.query(
    `UPDATE async_operation
     SET state = 'failed_permanent', lease_owner = NULL,
         lease_expires_at = NULL,
         result_ref = $3, sanitized_failure = $4,
         updated_at = clock_timestamp(), completed_at = clock_timestamp()
     WHERE owner_scope_id = $1 AND id = $2`,
    [
      ownerScopeId,
      operationId,
      { failure: { class: failureClass, retryable: false }, kind: "failed" },
      { class: failureClass },
    ],
  );
  await client.query(
    `UPDATE course
     SET status = 'failed', updated_at = clock_timestamp()
     WHERE owner_scope_id = $1 AND source_document_id = $2
       AND status = 'generating'`,
    [ownerScopeId, sourceDocumentId],
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
