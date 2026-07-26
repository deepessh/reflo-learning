import type { ScopeAuthorizationContext } from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

export interface DemoUploadCreate {
  readonly authorization: ScopeAuthorizationContext;
  readonly byteSize: number;
  readonly checksum: string;
  readonly courseId: string;
  readonly mediaType: string;
  readonly objectKey: string;
  readonly operationId: string;
  readonly sourceDocumentId: string;
  readonly title: string;
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
    });
  }

  async failCourseGeneration(
    authorization: ScopeAuthorizationContext,
    sourceDocumentId: string,
  ): Promise<void> {
    if (!isUuid(sourceDocumentId)) {
      throw new Error("invalid demo upload source");
    }
    await this.#transaction(authorization, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE course
         SET status = 'failed', updated_at = clock_timestamp()
         WHERE owner_scope_id = $1
           AND source_document_id = $2
           AND status = 'generating'
           AND EXISTS (
             SELECT 1
             FROM source_document AS source
             WHERE source.owner_scope_id = course.owner_scope_id
               AND source.id = course.source_document_id
               AND source.retention_status = 'active'
               AND source.parse_status = 'parsed'
           )
         RETURNING id`,
        [authorization.ownerScopeId, sourceDocumentId],
      );
      if (result.rowCount !== 1) {
        throw new Error("demo_upload_course_failure_not_recorded");
      }
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
    !isUuid(input.operationId) ||
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
