import {
  ACTIVATION_GENERATION_VERSION,
  ActivationGenerationError,
  type ActivationChapter,
  type ActivationConcept,
  type ActivationRepositoryPort,
  type AuthorizedActivationCourse,
  type GeneratedQuizBank,
  type GeneratedTextLesson,
  type GenerationClaim,
  type GenerationFailure,
  type GenerationOperationView,
  type GenerationWork,
  type PlannedGenerationOperation,
} from "@reflo/activation";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

interface CourseRow extends Record<string, unknown> {
  course_id: string;
  curriculum_generation_id: string;
  owner_scope_id: string;
  source_document_id: string;
}

interface ContentRow extends Record<string, unknown> {
  chapter_id: string;
  chapter_order: number;
  chapter_title: string;
  concept_id: string;
  concept_name: string;
  concept_order: number;
  source_span_id: string;
  source_text: string;
}

interface OperationRow extends Record<string, unknown> {
  artifact_id: string | null;
  artifact_kind: GenerationOperationView["artifactKind"];
  attempt_count: number;
  chapter_id: string | null;
  concept_id: string | null;
  failure_class: string | null;
  generation_version: GenerationOperationView["generationVersion"];
  id: string;
  idempotency_key: string;
  priority: number;
  retryable: boolean;
  status: GenerationOperationView["status"];
  updated_at: Date;
}

export class PostgresActivationRepository implements ActivationRepositoryPort {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new ActivationGenerationError("invalid_configuration");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async loadCourse(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<AuthorizedActivationCourse | null> {
    return this.#transaction(async (client) => {
      await setScopeContext(
        client,
        authorization.actorId,
        authorization.ownerScopeId,
      );
      return loadAuthorizedCourse(client, authorization, courseId);
    });
  }

  async registerOperations(
    course: AuthorizedActivationCourse,
    operations: readonly PlannedGenerationOperation[],
  ): Promise<readonly GenerationOperationView[]> {
    if (operations.length !== 3) {
      throw new ActivationGenerationError("invalid_configuration");
    }
    return this.#scopedCourseTransaction(
      course,
      async (client, currentCourse) => {
        if (
          currentCourse.curriculumGenerationId !== course.curriculumGenerationId
        ) {
          throw new ActivationGenerationError("authorization_denied");
        }
        const persisted: GenerationOperationView[] = [];
        for (const operation of operations) {
          validatePlannedOperation(operation);
          const result = await client.query<OperationRow>(
            `INSERT INTO activation_generation_operation
               (id, owner_scope_id, course_id, curriculum_generation_id,
                artifact_kind, chapter_id, concept_id, generation_version,
                idempotency_key, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (owner_scope_id, id) DO UPDATE
             SET id = EXCLUDED.id
             WHERE activation_generation_operation.course_id = EXCLUDED.course_id
               AND activation_generation_operation.curriculum_generation_id = EXCLUDED.curriculum_generation_id
               AND activation_generation_operation.artifact_kind = EXCLUDED.artifact_kind
               AND activation_generation_operation.chapter_id IS NOT DISTINCT FROM EXCLUDED.chapter_id
               AND activation_generation_operation.concept_id IS NOT DISTINCT FROM EXCLUDED.concept_id
               AND activation_generation_operation.generation_version = EXCLUDED.generation_version
               AND activation_generation_operation.idempotency_key = EXCLUDED.idempotency_key
               AND activation_generation_operation.priority = EXCLUDED.priority
             RETURNING id, artifact_kind, chapter_id, concept_id,
                       generation_version, idempotency_key, priority, status,
                       attempt_count, retryable, failure_class, artifact_id,
                       updated_at`,
            [
              operation.id,
              course.ownerScopeId,
              course.courseId,
              course.curriculumGenerationId,
              operation.artifactKind,
              operation.chapterId,
              operation.conceptId,
              operation.generationVersion,
              operation.idempotencyKey,
              operation.priority,
            ],
          );
          const row = result.rows[0];
          if (row === undefined) {
            throw new ActivationGenerationError("invalid_result");
          }
          persisted.push(operationView(row));
        }
        const chapterIds = [
          ...new Set(
            operations
              .map((operation) => operation.chapterId)
              .filter((id): id is string => id !== null),
          ),
        ];
        if (chapterIds.length > 0) {
          await client.query(
            `UPDATE chapter
             SET generation_status = 'generating'
             WHERE owner_scope_id = $1 AND course_id = $2
               AND curriculum_generation_id = $3
               AND id = ANY($4::uuid[])
               AND generation_status = 'pending'`,
            [
              course.ownerScopeId,
              course.courseId,
              course.curriculumGenerationId,
              chapterIds,
            ],
          );
        }
        return persisted.sort((left, right) => left.priority - right.priority);
      },
    );
  }

  async claimOperation(
    authorization: ScopeAuthorizationContext,
    courseId: string,
    operationId: string,
  ): Promise<GenerationClaim | null> {
    validateUuid(operationId);
    return this.#scopedCourseTransaction(
      { ...authorization, courseId },
      async (client, course) => {
        const claimed = await client.query<OperationRow>(
          `UPDATE activation_generation_operation
           SET status = 'processing', attempt_count = attempt_count + 1,
               retryable = false, failure_class = NULL, updated_at = now()
           WHERE owner_scope_id = $1 AND course_id = $2 AND id = $3
             AND status IN ('queued', 'retry_scheduled')
             AND attempt_count < 5
             AND curriculum_generation_id = $4
           RETURNING id, artifact_kind, chapter_id, concept_id,
                     generation_version, idempotency_key, priority, status,
                     attempt_count, retryable, failure_class, artifact_id,
                     updated_at`,
          [
            course.ownerScopeId,
            course.courseId,
            operationId,
            course.curriculumGenerationId,
          ],
        );
        const row = claimed.rows[0];
        if (row !== undefined) {
          return {
            kind: "claimed",
            work: { course, operation: operationView(row) },
          };
        }
        const current = await selectOperation(
          client,
          course.ownerScopeId,
          course.courseId,
          operationId,
        );
        if (current === null) {
          return null;
        }
        if (isFinal(current.status)) {
          return { kind: "already_final", status: current };
        }
        return null;
      },
    );
  }

  async completeTextLesson(
    work: GenerationWork,
    lesson: GeneratedTextLesson,
  ): Promise<GenerationOperationView> {
    return this.#scopedCourseTransaction(
      work.course,
      async (client, course) => {
        const current = await lockOperation(client, work);
        if (current.status === "succeeded") {
          return current;
        }
        assertProcessingAttempt(current, work);
        const conceptId = requiredId(work.operation.conceptId);
        await assertAuthorizedLinks(
          client,
          course,
          conceptId,
          lesson.sourceSpanIds,
        );
        const persisted = await client.query<{ id: string }>(
          `INSERT INTO asset
             (id, owner_scope_id, course_id, chapter_id, concept_id,
              asset_type, object_key, model_id, prompt_id, generation_version,
              strategy_tag, status, generation_operation_id, model_provenance,
              content_hash, content_type, byte_size, etag)
           VALUES ($1, $2, $3, $4, $5, 'text', $6, $7, $8, $9, $10,
                   'ready', $11, $12::jsonb, $13, $14, $15, $16)
           ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
           WHERE asset.generation_operation_id = EXCLUDED.generation_operation_id
             AND asset.object_key = EXCLUDED.object_key
             AND asset.model_provenance = EXCLUDED.model_provenance
             AND asset.content_hash = EXCLUDED.content_hash
           RETURNING id`,
          [
            lesson.assetId,
            course.ownerScopeId,
            course.courseId,
            requiredId(work.operation.chapterId),
            conceptId,
            lesson.storage.objectKey,
            lesson.modelProvenance.effectiveModel,
            lesson.modelProvenance.promptId ?? null,
            ACTIVATION_GENERATION_VERSION,
            lesson.strategyTag,
            work.operation.id,
            JSON.stringify(lesson.modelProvenance),
            lesson.contentHash,
            lesson.storage.contentType,
            lesson.storage.byteSize,
            lesson.storage.etag,
          ],
        );
        if (persisted.rows[0]?.id !== lesson.assetId) {
          throw new ActivationGenerationError("invalid_result");
        }
        await insertAssetSourceSpans(
          client,
          course.ownerScopeId,
          lesson.assetId,
          lesson.sourceSpanIds,
        );
        return finalizeSuccess(client, work, lesson.assetId);
      },
    );
  }

  async completeQuizBank(
    work: GenerationWork,
    quizBank: GeneratedQuizBank,
  ): Promise<GenerationOperationView> {
    return this.#scopedCourseTransaction(
      work.course,
      async (client, course) => {
        const current = await lockOperation(client, work);
        if (current.status === "succeeded") {
          return current;
        }
        assertProcessingAttempt(current, work);
        if (
          quizBank.items.length !== (quizBank.bankKind === "placement" ? 10 : 5)
        ) {
          throw new ActivationGenerationError("invalid_result");
        }
        const persisted = await client.query<{ id: string }>(
          `INSERT INTO quiz_bank
             (id, owner_scope_id, course_id, chapter_id,
              generation_operation_id, bank_kind, generation_version,
              model_provenance, result_hash, item_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
           ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
           WHERE quiz_bank.generation_operation_id = EXCLUDED.generation_operation_id
             AND quiz_bank.model_provenance = EXCLUDED.model_provenance
             AND quiz_bank.result_hash = EXCLUDED.result_hash
             AND quiz_bank.item_count = EXCLUDED.item_count
           RETURNING id`,
          [
            quizBank.bankId,
            course.ownerScopeId,
            course.courseId,
            work.operation.chapterId,
            work.operation.id,
            quizBank.bankKind,
            ACTIVATION_GENERATION_VERSION,
            JSON.stringify(quizBank.modelProvenance),
            quizBank.resultHash,
            quizBank.items.length,
          ],
        );
        if (persisted.rows[0]?.id !== quizBank.bankId) {
          throw new ActivationGenerationError("invalid_result");
        }
        for (const item of quizBank.items) {
          const quizItem = await client.query<{ id: string }>(
            `INSERT INTO quiz_item
               (id, owner_scope_id, course_id, item_type, difficulty, prompt,
                keyed_answer, rubric, version, quiz_bank_id, item_order,
                normalized_prompt_hash, response_options)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9,
                     $10, $11, $12, $13::jsonb)
             ON CONFLICT (owner_scope_id, id) DO UPDATE SET id = EXCLUDED.id
             WHERE quiz_item.quiz_bank_id = EXCLUDED.quiz_bank_id
               AND quiz_item.item_order = EXCLUDED.item_order
               AND quiz_item.normalized_prompt_hash = EXCLUDED.normalized_prompt_hash
               AND quiz_item.prompt = EXCLUDED.prompt
               AND quiz_item.keyed_answer = EXCLUDED.keyed_answer
             RETURNING id`,
            [
              item.id,
              course.ownerScopeId,
              course.courseId,
              item.itemType,
              item.difficulty,
              item.prompt,
              JSON.stringify(item.keyedAnswer),
              item.rubric === undefined ? null : JSON.stringify(item.rubric),
              ACTIVATION_GENERATION_VERSION,
              quizBank.bankId,
              item.itemOrder,
              item.normalizedPromptHash,
              item.responseOptions === undefined
                ? null
                : JSON.stringify(item.responseOptions),
            ],
          );
          if (quizItem.rows[0]?.id !== item.id) {
            throw new ActivationGenerationError("invalid_result");
          }
          await insertQuizLinks(client, course, item);
        }
        const finalized = await finalizeSuccess(client, work, quizBank.bankId);
        if (quizBank.bankKind === "chapter") {
          await updateChapterReadiness(
            client,
            course,
            requiredId(work.operation.chapterId),
          );
        }
        return finalized;
      },
    );
  }

  async recordFailure(
    work: GenerationWork,
    failure: GenerationFailure,
  ): Promise<GenerationOperationView> {
    if (!/^[a-z0-9_]{3,64}$/.test(failure.failureClass)) {
      throw new ActivationGenerationError("invalid_result");
    }
    return this.#scopedCourseTransaction(work.course, async (client) => {
      const current = await lockOperation(client, work);
      if (isFinal(current.status)) {
        return current;
      }
      assertProcessingAttempt(current, work);
      const retryable = failure.retryable && current.attemptCount < 5;
      const result = await client.query<OperationRow>(
        `UPDATE activation_generation_operation
         SET status = $1, retryable = $2, failure_class = $3,
             completed_at = CASE WHEN $2 THEN NULL ELSE now() END,
             updated_at = now()
         WHERE owner_scope_id = $4 AND id = $5
           AND status = 'processing' AND attempt_count = $6
         RETURNING id, artifact_kind, chapter_id, concept_id,
                   generation_version, idempotency_key, priority, status,
                   attempt_count, retryable, failure_class, artifact_id,
                   updated_at`,
        [
          retryable ? "retry_scheduled" : "failed_permanent",
          retryable,
          failure.failureClass,
          work.course.ownerScopeId,
          work.operation.id,
          work.operation.attemptCount,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ActivationGenerationError("operation_unavailable");
      }
      return operationView(row);
    });
  }

  async listOperations(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<readonly GenerationOperationView[]> {
    return this.#scopedCourseTransaction(
      { ...authorization, courseId },
      async (client, course) => {
        const result = await client.query<OperationRow>(
          `SELECT id, artifact_kind, chapter_id, concept_id,
                  generation_version, idempotency_key, priority, status,
                  attempt_count, retryable, failure_class, artifact_id,
                  updated_at
           FROM activation_generation_operation
           WHERE owner_scope_id = $1 AND course_id = $2
             AND curriculum_generation_id = $3
           ORDER BY priority, id`,
          [course.ownerScopeId, course.courseId, course.curriculumGenerationId],
        );
        return result.rows.map(operationView);
      },
    );
  }

  async #scopedCourseTransaction<Result>(
    context: ScopeAuthorizationContext & { readonly courseId: string },
    operation: (
      client: PoolClient,
      course: AuthorizedActivationCourse,
    ) => Promise<Result>,
  ): Promise<Result>;
  async #scopedCourseTransaction<Result>(
    context: AuthorizedActivationCourse,
    operation: (
      client: PoolClient,
      course: AuthorizedActivationCourse,
    ) => Promise<Result>,
  ): Promise<Result>;
  async #scopedCourseTransaction<Result>(
    context:
      | AuthorizedActivationCourse
      | (ScopeAuthorizationContext & { readonly courseId: string }),
    operation: (
      client: PoolClient,
      course: AuthorizedActivationCourse,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.#transaction(async (client) => {
      await setScopeContext(client, context.actorId, context.ownerScopeId);
      const course = await loadAuthorizedCourse(
        client,
        context,
        context.courseId,
      );
      if (course === null) {
        throw new ActivationGenerationError("authorization_denied");
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

async function loadAuthorizedCourse(
  client: PoolClient,
  authorization: ScopeAuthorizationContext,
  courseId: string,
): Promise<AuthorizedActivationCourse | null> {
  validateContext(authorization);
  validateUuid(courseId);
  const authorized = await client.query<CourseRow>(
    `SELECT course.id AS course_id, course.owner_scope_id,
            course.source_document_id,
            course.active_curriculum_generation_id AS curriculum_generation_id
     FROM course
     JOIN source_document AS source
       ON source.owner_scope_id = course.owner_scope_id
      AND source.id = course.source_document_id
     JOIN curriculum_generation AS generation
       ON generation.owner_scope_id = course.owner_scope_id
      AND generation.course_id = course.id
      AND generation.id = course.active_curriculum_generation_id
     JOIN owner_scope AS scope ON scope.id = course.owner_scope_id
     JOIN app_user AS actor ON actor.id = $1
     JOIN scope_membership AS membership
       ON membership.owner_scope_id = course.owner_scope_id
      AND membership.user_id = actor.id
     WHERE course.owner_scope_id = $2 AND course.id = $3
       AND course.status IN ('generating', 'ready')
       AND source.parse_status = 'parsed'
       AND source.retention_status = 'active'
       AND generation.status = 'active'
       AND scope.status = 'active' AND actor.status = 'active'
       AND membership.role = 'owner' AND membership.revoked_at IS NULL
     FOR SHARE OF course, source, generation, scope, actor, membership`,
    [authorization.actorId, authorization.ownerScopeId, courseId],
  );
  const row = authorized.rows[0];
  if (row === undefined) {
    return null;
  }
  const content = await client.query<ContentRow>(
    `SELECT chapter.id AS chapter_id, chapter.chapter_order,
            chapter.title AS chapter_title, concept.id AS concept_id,
            concept.concept_order, concept.name AS concept_name,
            span.id AS source_span_id, span.canonical_text AS source_text
     FROM chapter
     JOIN concept
       ON concept.owner_scope_id = chapter.owner_scope_id
      AND concept.chapter_id = chapter.id
      AND concept.curriculum_generation_id = chapter.curriculum_generation_id
     JOIN concept_source_span AS link
       ON link.owner_scope_id = concept.owner_scope_id
      AND link.concept_id = concept.id
     JOIN source_span AS span
       ON span.owner_scope_id = link.owner_scope_id
      AND span.id = link.source_span_id
      AND span.source_document_id = $4
     WHERE chapter.owner_scope_id = $1 AND chapter.course_id = $2
       AND chapter.curriculum_generation_id = $3
     ORDER BY chapter.chapter_order, concept.concept_order, span.chunk_order, span.id`,
    [
      row.owner_scope_id,
      row.course_id,
      row.curriculum_generation_id,
      row.source_document_id,
    ],
  );
  return {
    actorId: authorization.actorId,
    authorizationId: authorization.authorizationId,
    chapters: materializeChapters(content.rows),
    courseId: row.course_id,
    curriculumGenerationId: row.curriculum_generation_id,
    ownerScopeId: row.owner_scope_id,
    sourceDocumentId: row.source_document_id,
  };
}

function materializeChapters(
  rows: readonly ContentRow[],
): readonly ActivationChapter[] {
  const chapters = new Map<
    string,
    {
      readonly concepts: Map<string, ActivationConcept>;
      readonly id: string;
      readonly sourceSpans: Map<
        string,
        { readonly id: string; readonly text: string }
      >;
      readonly title: string;
    }
  >();
  for (const row of rows) {
    let chapter = chapters.get(row.chapter_id);
    if (chapter === undefined) {
      chapter = {
        concepts: new Map(),
        id: row.chapter_id,
        sourceSpans: new Map(),
        title: row.chapter_title,
      };
      chapters.set(row.chapter_id, chapter);
    }
    chapter.sourceSpans.set(row.source_span_id, {
      id: row.source_span_id,
      text: row.source_text,
    });
    const previous = chapter.concepts.get(row.concept_id);
    chapter.concepts.set(row.concept_id, {
      id: row.concept_id,
      name: row.concept_name,
      sourceSpans: [
        ...(previous?.sourceSpans ?? []),
        { id: row.source_span_id, text: row.source_text },
      ],
    });
  }
  return [...chapters.values()].map((chapter) => ({
    concepts: [...chapter.concepts.values()],
    id: chapter.id,
    sourceSpans: [...chapter.sourceSpans.values()],
    title: chapter.title,
  }));
}

async function selectOperation(
  client: PoolClient,
  ownerScopeId: string,
  courseId: string,
  operationId: string,
): Promise<GenerationOperationView | null> {
  const result = await client.query<OperationRow>(
    `SELECT id, artifact_kind, chapter_id, concept_id, generation_version,
            idempotency_key, priority, status, attempt_count, retryable,
            failure_class, artifact_id, updated_at
     FROM activation_generation_operation
     WHERE owner_scope_id = $1 AND course_id = $2 AND id = $3`,
    [ownerScopeId, courseId, operationId],
  );
  return result.rows[0] === undefined ? null : operationView(result.rows[0]);
}

async function lockOperation(
  client: PoolClient,
  work: GenerationWork,
): Promise<GenerationOperationView> {
  const result = await client.query<OperationRow>(
    `SELECT id, artifact_kind, chapter_id, concept_id, generation_version,
            idempotency_key, priority, status, attempt_count, retryable,
            failure_class, artifact_id, updated_at
     FROM activation_generation_operation
     WHERE owner_scope_id = $1 AND course_id = $2 AND id = $3
     FOR UPDATE`,
    [work.course.ownerScopeId, work.course.courseId, work.operation.id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ActivationGenerationError("operation_unavailable");
  }
  return operationView(row);
}

async function assertAuthorizedLinks(
  client: PoolClient,
  course: AuthorizedActivationCourse,
  conceptId: string,
  sourceSpanIds: readonly string[],
): Promise<void> {
  if (
    sourceSpanIds.length === 0 ||
    new Set(sourceSpanIds).size !== sourceSpanIds.length
  ) {
    throw new ActivationGenerationError("invalid_result");
  }
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM concept
     JOIN concept_source_span AS link
       ON link.owner_scope_id = concept.owner_scope_id
      AND link.concept_id = concept.id
     JOIN source_span AS span
       ON span.owner_scope_id = link.owner_scope_id
      AND span.id = link.source_span_id
     WHERE concept.owner_scope_id = $1 AND concept.id = $2
       AND concept.curriculum_generation_id = $3
       AND span.source_document_id = $4
       AND span.id = ANY($5::uuid[])`,
    [
      course.ownerScopeId,
      conceptId,
      course.curriculumGenerationId,
      course.sourceDocumentId,
      sourceSpanIds,
    ],
  );
  if (result.rows[0]?.count !== sourceSpanIds.length) {
    throw new ActivationGenerationError("authorization_denied");
  }
}

async function insertAssetSourceSpans(
  client: PoolClient,
  ownerScopeId: string,
  assetId: string,
  sourceSpanIds: readonly string[],
): Promise<void> {
  const result = await client.query(
    `INSERT INTO asset_source_span (owner_scope_id, asset_id, source_span_id)
     SELECT $1, $2, span.id
     FROM source_span AS span
     WHERE span.owner_scope_id = $1 AND span.id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING`,
    [ownerScopeId, assetId, sourceSpanIds],
  );
  if (result.rowCount !== sourceSpanIds.length) {
    const existing = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM asset_source_span
       WHERE owner_scope_id = $1 AND asset_id = $2
         AND source_span_id = ANY($3::uuid[])`,
      [ownerScopeId, assetId, sourceSpanIds],
    );
    if (existing.rows[0]?.count !== sourceSpanIds.length) {
      throw new ActivationGenerationError("invalid_result");
    }
  }
}

async function insertQuizLinks(
  client: PoolClient,
  course: AuthorizedActivationCourse,
  item: GeneratedQuizBank["items"][number],
): Promise<void> {
  for (const conceptId of item.conceptIds) {
    const grounded = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM concept_source_span
         JOIN concept
           ON concept.owner_scope_id = concept_source_span.owner_scope_id
          AND concept.id = concept_source_span.concept_id
         WHERE concept_source_span.owner_scope_id = $1
           AND concept_source_span.concept_id = $2
           AND concept_source_span.source_span_id = ANY($3::uuid[])
           AND concept.curriculum_generation_id = $4
       ) AS present`,
      [
        course.ownerScopeId,
        conceptId,
        item.sourceSpanIds,
        course.curriculumGenerationId,
      ],
    );
    if (grounded.rows[0]?.present !== true) {
      throw new ActivationGenerationError("authorization_denied");
    }
  }
  for (const conceptId of item.conceptIds) {
    const concept = await client.query<{ id: string }>(
      `INSERT INTO quiz_item_concept (owner_scope_id, quiz_item_id, concept_id)
       SELECT $1, $2, concept.id
       FROM concept
       WHERE concept.owner_scope_id = $1 AND concept.id = $3
         AND concept.curriculum_generation_id = $4
       ON CONFLICT DO NOTHING
       RETURNING concept_id AS id`,
      [course.ownerScopeId, item.id, conceptId, course.curriculumGenerationId],
    );
    if (concept.rows[0]?.id !== conceptId) {
      const existing = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM quiz_item_concept
           WHERE owner_scope_id = $1 AND quiz_item_id = $2 AND concept_id = $3
         ) AS present`,
        [course.ownerScopeId, item.id, conceptId],
      );
      if (existing.rows[0]?.present !== true) {
        throw new ActivationGenerationError("authorization_denied");
      }
    }
  }
  for (const sourceSpanId of item.sourceSpanIds) {
    const span = await client.query<{ id: string }>(
      `INSERT INTO quiz_item_source_span
         (owner_scope_id, quiz_item_id, source_span_id)
       SELECT $1, $2, span.id
       FROM source_span AS span
       WHERE span.owner_scope_id = $1 AND span.id = $3
         AND span.source_document_id = $4
       ON CONFLICT DO NOTHING
       RETURNING source_span_id AS id`,
      [course.ownerScopeId, item.id, sourceSpanId, course.sourceDocumentId],
    );
    if (span.rows[0]?.id !== sourceSpanId) {
      const existing = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM quiz_item_source_span
           WHERE owner_scope_id = $1 AND quiz_item_id = $2 AND source_span_id = $3
         ) AS present`,
        [course.ownerScopeId, item.id, sourceSpanId],
      );
      if (existing.rows[0]?.present !== true) {
        throw new ActivationGenerationError("authorization_denied");
      }
    }
  }
}

async function finalizeSuccess(
  client: PoolClient,
  work: GenerationWork,
  artifactId: string,
): Promise<GenerationOperationView> {
  const result = await client.query<OperationRow>(
    `UPDATE activation_generation_operation
     SET status = 'succeeded', retryable = false, failure_class = NULL,
         artifact_id = $1, completed_at = now(), updated_at = now()
     WHERE owner_scope_id = $2 AND id = $3
       AND status = 'processing' AND attempt_count = $4
     RETURNING id, artifact_kind, chapter_id, concept_id,
               generation_version, idempotency_key, priority, status,
               attempt_count, retryable, failure_class, artifact_id, updated_at`,
    [
      artifactId,
      work.course.ownerScopeId,
      work.operation.id,
      work.operation.attemptCount,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ActivationGenerationError("operation_unavailable");
  }
  return operationView(row);
}

async function updateChapterReadiness(
  client: PoolClient,
  course: AuthorizedActivationCourse,
  chapterId: string,
): Promise<void> {
  await client.query(
    `UPDATE chapter
     SET generation_status = CASE WHEN (
       SELECT count(DISTINCT operation.artifact_kind) = 2
       FROM activation_generation_operation AS operation
       WHERE operation.owner_scope_id = $1 AND operation.course_id = $2
         AND operation.curriculum_generation_id = $3
         AND operation.chapter_id = $4
         AND operation.artifact_kind IN ('first_text_lesson', 'chapter_quiz')
         AND operation.status = 'succeeded'
     ) THEN 'ready' ELSE 'generating' END
     WHERE owner_scope_id = $1 AND course_id = $2
       AND curriculum_generation_id = $3 AND id = $4`,
    [
      course.ownerScopeId,
      course.courseId,
      course.curriculumGenerationId,
      chapterId,
    ],
  );
}

function operationView(row: OperationRow): GenerationOperationView {
  return {
    artifactId: row.artifact_id,
    artifactKind: row.artifact_kind,
    attemptCount: row.attempt_count,
    chapterId: row.chapter_id,
    conceptId: row.concept_id,
    failureClass: row.failure_class,
    generationVersion: row.generation_version,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    priority: row.priority as 1 | 2 | 3,
    retryable: row.retryable,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function validatePlannedOperation(operation: PlannedGenerationOperation): void {
  validateUuid(operation.id);
  if (
    operation.generationVersion !== ACTIVATION_GENERATION_VERSION ||
    ![1, 2, 3].includes(operation.priority) ||
    !/^(dev|staging|pilot)\/content[.]activation[.]generate\/v1\/[a-f0-9-]{36}$/.test(
      operation.idempotencyKey,
    )
  ) {
    throw new ActivationGenerationError("invalid_configuration");
  }
}

function assertProcessingAttempt(
  current: GenerationOperationView,
  work: GenerationWork,
): void {
  if (
    current.status !== "processing" ||
    current.attemptCount !== work.operation.attemptCount
  ) {
    throw new ActivationGenerationError("operation_unavailable");
  }
}

function isFinal(status: GenerationOperationView["status"]): boolean {
  return ["succeeded", "failed_permanent", "cancelled", "expired"].includes(
    status,
  );
}

function requiredId(value: string | null): string {
  if (value === null) {
    throw new ActivationGenerationError("invalid_result");
  }
  return value;
}

function validateContext(context: ScopeAuthorizationContext): void {
  validateUuid(context.actorId);
  validateUuid(context.ownerScopeId);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(context.authorizationId)) {
    throw new ActivationGenerationError("authorization_denied");
  }
}

function validateUuid(value: string): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  ) {
    throw new ActivationGenerationError("authorization_denied");
  }
}

async function setScopeContext(
  client: PoolClient,
  actorId: string,
  ownerScopeId: string,
): Promise<void> {
  await client.query("SELECT set_config('reflo.actor_id', $1, true)", [
    actorId,
  ]);
  await client.query("SELECT set_config('reflo.owner_scope_id', $1, true)", [
    ownerScopeId,
  ]);
}
