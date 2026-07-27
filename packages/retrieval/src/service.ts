import { ModelRouterError } from "@reflo/model-router";
import type {
  EmbeddingResult,
  ModelCallProvenance,
  RoutedModelResult,
} from "@reflo/model-router";

import { chunkNormalizedDocument } from "./chunker.js";
import {
  CURRICULUM_FINALIZATION_RESERVE_MS,
  CURRICULUM_PARENT_DEADLINE_MS,
  CURRICULUM_SEGMENT_DEADLINE_MS,
  CURRICULUM_SEGMENT_GENERATION_VERSION,
  CURRICULUM_SEGMENT_MAX_CONCURRENCY,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROFILE_VERSION,
  type AuthorizedSourceAccess,
  type BuildCurriculumCommand,
  type BuildCurriculumResult,
  type CurriculumGenerationRecord,
  type ComposedCurriculumResult,
  type CurriculumOrchestrationMetrics,
  type CurriculumOutline,
  type EmbeddingGenerationRecord,
  type PersistedCurriculumSegmentResult,
  type RetrievedSourceSpan,
  type ScopeAuthorizationContext,
  type SearchCommand,
  type SourceSpanRecord,
  type VectorRecord,
} from "./contracts.js";
import {
  composeCurriculum,
  curriculumSegmentInput,
  partitionCurriculumSource,
} from "./curriculum.js";
import { RetrievalError } from "./errors.js";
import { canonicalJson, sha256, stableUuid } from "./identity.js";
import type {
  ContentRepositoryPort,
  RetrievalModelRouterPort,
  VectorStorePort,
} from "./ports.js";

export interface RetrievalServiceDependencies {
  readonly models: RetrievalModelRouterPort;
  readonly now?: () => number;
  readonly observeCurriculum?: (
    metrics: CurriculumOrchestrationMetrics,
  ) => Promise<void> | void;
  readonly repository: ContentRepositoryPort;
  readonly vectors: VectorStorePort;
}

export class RetrievalService {
  readonly #now: () => number;

  constructor(private readonly dependencies: RetrievalServiceDependencies) {
    this.#now = dependencies.now ?? Date.now;
  }

  async buildCurriculum(
    command: BuildCurriculumCommand,
  ): Promise<BuildCurriculumResult> {
    validateDeadline(command.deadlineMs);
    if (command.deadlineMs > CURRICULUM_PARENT_DEADLINE_MS) {
      throw new RetrievalError(
        "invalid_configuration",
        "curriculum deadline exceeds the shipped policy",
      );
    }
    const startedAt = this.#now();
    const deadlineAt = startedAt + command.deadlineMs;
    const access = await this.#authorize(
      command.authorization,
      command.sourceDocumentId,
      command.courseId,
    );
    if (
      command.document.scan.classification !== "digital" ||
      command.document.inputSha256.length !== 64
    ) {
      throw new RetrievalError(
        "invalid_chunk",
        "only validated digital normalized documents can be chunked",
      );
    }
    const sourceSpans = chunkNormalizedDocument({
      document: command.document,
      ownerScopeId: access.ownerScopeId,
      sourceDocumentId: access.sourceDocumentId,
    });
    await this.dependencies.repository.persistSourceSpans(access, sourceSpans);

    const embeddingGeneration = await this.#ensureEmbeddingGeneration(
      access,
      sourceSpans,
      deadlineAt,
    );
    const manifest = partitionCurriculumSource(
      access,
      embeddingGeneration.generationId,
      sourceSpans,
    );
    await this.dependencies.repository.persistCurriculumPartition(
      access,
      manifest,
    );
    const segmentExecutions = await this.#executeCurriculumSegments(
      access,
      manifest,
      sourceSpans,
      deadlineAt,
    );
    const compositionStartedAt = this.#now();
    const composed = composeCurriculum(
      manifest,
      access.courseTitle,
      sourceSpans,
      segmentExecutions.map((entry) => entry.persisted),
    );
    const curriculumGeneration = buildComposedCurriculumGeneration(
      access,
      manifest.parentGenerationId,
      embeddingGeneration.generationId,
      composed.result,
      composed.modelProvenance,
    );
    const outline = await this.dependencies.repository.persistCurriculum(
      access,
      curriculumGeneration,
      remainingDeadline(deadlineAt, this.#now),
    );
    assertOutline(access, curriculumGeneration, outline);
    const finishedAt = this.#now();
    if (finishedAt > deadlineAt) {
      throw new RetrievalError(
        "deadline_exceeded",
        "curriculum finalized after the parent deadline",
      );
    }
    const orchestration = {
      chapterCount: outline.chapters.length,
      compositionFinalizationMs: Math.max(0, finishedAt - compositionStartedAt),
      conceptCount: outline.chapters.reduce(
        (count, chapter) => count + chapter.concepts.length,
        0,
      ),
      finalizationReserveMs: CURRICULUM_FINALIZATION_RESERVE_MS,
      parentDeadlineMs: command.deadlineMs,
      retryCount: segmentExecutions.reduce(
        (count, entry) => count + Math.max(0, entry.persisted.attemptCount - 1),
        0,
      ),
      segmentAttemptCounts: segmentExecutions.map(
        (entry) => entry.persisted.attemptCount,
      ),
      segmentCount: manifest.segments.length,
      segmentLatenciesMs: segmentExecutions.map((entry) => entry.latencyMs),
      segmentQueueTimesMs: segmentExecutions.map((entry) => entry.queueTimeMs),
      terminalReason: "outline_ready",
      totalLatencyMs: Math.max(0, finishedAt - startedAt),
    } satisfies CurriculumOrchestrationMetrics;
    await this.dependencies.observeCurriculum?.(orchestration);
    return { embeddingGeneration, orchestration, outline, sourceSpans };
  }

  async search(
    command: SearchCommand,
  ): Promise<readonly RetrievedSourceSpan[]> {
    validateDeadline(command.deadlineMs);
    const deadlineAt = this.#now() + command.deadlineMs;
    if (
      command.query.trim().length === 0 ||
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > 50
    ) {
      throw new RetrievalError(
        "invalid_configuration",
        "invalid search request",
      );
    }
    const access = await this.#authorize(
      command.authorization,
      command.sourceDocumentId,
      command.courseId,
    );
    const activeGeneration =
      await this.dependencies.repository.activeEmbeddingGeneration(access);
    if (activeGeneration === null) {
      throw new RetrievalError(
        "authorization_denied",
        "source has no retrievable active generation",
      );
    }
    const embedded = await this.dependencies.models.execute(
      "embedding.query.v1",
      { texts: [command.query] },
      { deadlineMs: remainingDeadline(deadlineAt, this.#now) },
    );
    assertEmbeddingMetadata(embedded.value, "query");
    assertCompatibleActiveEmbeddingGeneration(activeGeneration, embedded);
    const generationId = activeGeneration.generationId;
    const queryVector = required(
      embedded.value.vectors[0],
      "missing query embedding",
    );
    const vectorResults = await this.dependencies.vectors.searchExact(
      access,
      generationId,
      queryVector,
      command.limit,
    );
    if (
      vectorResults.some(
        (result) =>
          result.ownerScopeId !== access.ownerScopeId ||
          result.sourceDocumentId !== access.sourceDocumentId ||
          result.generationId !== generationId,
      )
    ) {
      throw new RetrievalError(
        "invalid_vector_result",
        "vector results escaped the authorized namespace",
      );
    }
    const orderedIds = vectorResults.map((result) => result.sourceSpanId);
    const resolved =
      await this.dependencies.repository.resolveAuthorizedSourceSpans(
        access,
        generationId,
        orderedIds,
      );
    const byId = new Map(resolved.map((span) => [span.id, span]));
    if (
      byId.size !== orderedIds.length ||
      resolved.some((span) => !orderedIds.includes(span.id))
    ) {
      throw new RetrievalError(
        "authorization_denied",
        "source-span authorization changed during retrieval",
      );
    }
    return orderedIds.map((id) =>
      required(byId.get(id), "authorized source span disappeared"),
    );
  }

  async #authorize(
    context: ScopeAuthorizationContext,
    sourceDocumentId: string,
    courseId: string,
  ): Promise<AuthorizedSourceAccess> {
    if (
      context.actorId.length === 0 ||
      context.authorizationId.length === 0 ||
      context.ownerScopeId.length === 0 ||
      sourceDocumentId.length === 0 ||
      courseId.length === 0
    ) {
      throw new RetrievalError("authorization_denied");
    }
    const access = await this.dependencies.repository.authorizeSource(
      context,
      sourceDocumentId,
      courseId,
    );
    if (
      access === null ||
      access.actorId !== context.actorId ||
      access.authorizationId !== context.authorizationId ||
      access.ownerScopeId !== context.ownerScopeId ||
      access.sourceDocumentId !== sourceDocumentId ||
      access.courseId !== courseId
    ) {
      throw new RetrievalError("authorization_denied");
    }
    return access;
  }

  async #embedDocuments(
    texts: readonly string[],
    deadlineAt: number,
  ): Promise<readonly RoutedModelResult<"embedding.document.v1">[]> {
    const batches: RoutedModelResult<"embedding.document.v1">[] = [];
    for (let index = 0; index < texts.length; index += 10) {
      const batch = await this.dependencies.models.execute(
        "embedding.document.v1",
        { texts: texts.slice(index, index + 10) },
        { deadlineMs: remainingDeadline(deadlineAt, this.#now) },
      );
      assertEmbeddingMetadata(batch.value, "document");
      if (batches[0] !== undefined) {
        assertSameEmbeddingProfile(batches[0], batch);
      }
      batches.push(batch);
    }
    if (batches.length === 0) {
      throw new RetrievalError("invalid_model_result");
    }
    return batches;
  }

  async #ensureEmbeddingGeneration(
    access: AuthorizedSourceAccess,
    sourceSpans: readonly SourceSpanRecord[],
    deadlineAt: number,
  ): Promise<EmbeddingGenerationRecord> {
    const active =
      await this.dependencies.repository.activeEmbeddingGeneration(access);
    if (
      active !== null &&
      active.ownerScopeId === access.ownerScopeId &&
      active.sourceDocumentId === access.sourceDocumentId &&
      active.spanIds.length === sourceSpans.length &&
      active.spanIds.every((id, index) => id === sourceSpans[index]?.id)
    ) {
      return active;
    }
    const embeddingBatches = await this.#embedDocuments(
      sourceSpans.map((span) => span.embeddingInput),
      deadlineAt,
    );
    const embeddedVectors = embeddingBatches.flatMap(
      (batch) => batch.value.vectors,
    );
    const embeddingGeneration = buildEmbeddingGeneration(
      access,
      sourceSpans,
      embeddingBatches,
    );
    const vectorRecords: readonly VectorRecord[] = sourceSpans.map(
      (span, index) => ({
        embedding: required(
          embeddedVectors[index],
          "missing document embedding",
        ),
        embeddingInputHash: span.embeddingInputHash,
        generationId: embeddingGeneration.generationId,
        ownerScopeId: access.ownerScopeId,
        sourceDocumentId: access.sourceDocumentId,
        sourceSpanId: span.id,
      }),
    );
    await this.dependencies.repository.recordEmbeddingGeneration(
      access,
      embeddingGeneration,
    );
    await this.dependencies.vectors.writeGeneration(
      access,
      embeddingGeneration,
      vectorRecords,
    );
    await this.dependencies.repository.activateEmbeddingGeneration(
      access,
      embeddingGeneration.generationId,
    );
    return embeddingGeneration;
  }

  async #executeCurriculumSegments(
    access: AuthorizedSourceAccess,
    manifest: ReturnType<typeof partitionCurriculumSource>,
    sourceSpans: readonly SourceSpanRecord[],
    deadlineAt: number,
  ): Promise<
    readonly {
      readonly latencyMs: number;
      readonly persisted: PersistedCurriculumSegmentResult;
      readonly queueTimeMs: number;
    }[]
  > {
    const executionStartedAt = this.#now();
    const completed = new Map<
      string,
      {
        readonly latencyMs: number;
        readonly persisted: PersistedCurriculumSegmentResult;
        readonly queueTimeMs: number;
      }
    >();
    let nextIndex = 0;
    const executeNext = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const segment = manifest.segments[index];
        if (segment === undefined) {
          return;
        }
        const remaining = deadlineAt - this.#now();
        if (remaining <= CURRICULUM_FINALIZATION_RESERVE_MS) {
          throw new RetrievalError(
            "deadline_exceeded",
            "curriculum finalization reserve reached",
          );
        }
        const claim = await this.dependencies.repository.claimCurriculumSegment(
          access,
          manifest.parentGenerationId,
          segment,
        );
        if (claim.kind === "completed") {
          completed.set(segment.id, {
            latencyMs: 0,
            persisted: claim.persisted,
            queueTimeMs: 0,
          });
          continue;
        }
        if (claim.kind === "active") {
          throw new RetrievalError(
            "persistence_failure",
            "curriculum segment already has an active lease",
          );
        }
        if (claim.kind === "failed") {
          throw new RetrievalError(
            "invalid_model_result",
            "curriculum segment is permanently failed",
          );
        }
        if (
          claim.attemptCount > 1 &&
          remaining <
            CURRICULUM_SEGMENT_DEADLINE_MS + CURRICULUM_FINALIZATION_RESERVE_MS
        ) {
          await this.dependencies.repository.failCurriculumSegment(access, {
            attemptCount: claim.attemptCount,
            failureClass: "generation_deadline_exceeded",
            inputHash: segment.inputHash,
            parentGenerationId: manifest.parentGenerationId,
            retryable: false,
            segmentId: segment.id,
          });
          throw new RetrievalError(
            "deadline_exceeded",
            "insufficient parent budget for a curriculum segment retry",
          );
        }
        const callRemaining = deadlineAt - this.#now();
        if (callRemaining <= CURRICULUM_FINALIZATION_RESERVE_MS) {
          await this.dependencies.repository.failCurriculumSegment(access, {
            attemptCount: claim.attemptCount,
            failureClass: "generation_deadline_exceeded",
            inputHash: segment.inputHash,
            parentGenerationId: manifest.parentGenerationId,
            retryable: false,
            segmentId: segment.id,
          });
          throw new RetrievalError(
            "deadline_exceeded",
            "curriculum finalization reserve reached before child launch",
          );
        }
        const input = curriculumSegmentInput(
          access.courseTitle,
          segment,
          sourceSpans,
        );
        const callStartedAt = this.#now();
        try {
          const routed = await this.dependencies.models.execute(
            "curriculum.segment.v1",
            input,
            {
              deadlineMs: Math.min(
                CURRICULUM_SEGMENT_DEADLINE_MS,
                callRemaining - CURRICULUM_FINALIZATION_RESERVE_MS,
              ),
            },
          );
          const resultHash = sha256(canonicalJson(routed.value));
          await this.dependencies.repository.completeCurriculumSegment(access, {
            attemptCount: claim.attemptCount,
            inputHash: segment.inputHash,
            modelProvenance: routed.provenance,
            parentGenerationId: manifest.parentGenerationId,
            result: routed.value,
            resultHash,
            segmentId: segment.id,
          });
          completed.set(segment.id, {
            latencyMs: Math.max(0, this.#now() - callStartedAt),
            persisted: {
              attemptCount: claim.attemptCount,
              inputHash: segment.inputHash,
              modelProvenance: routed.provenance,
              result: routed.value,
              resultHash,
              segmentId: segment.id,
            },
            queueTimeMs: Math.max(0, callStartedAt - executionStartedAt),
          });
        } catch (error) {
          await this.dependencies.repository
            .failCurriculumSegment(access, {
              attemptCount: claim.attemptCount,
              failureClass: curriculumSegmentFailureClass(error),
              inputHash: segment.inputHash,
              parentGenerationId: manifest.parentGenerationId,
              retryable: curriculumSegmentRetryable(error),
              segmentId: segment.id,
            })
            .catch(() => undefined);
          throw error;
        }
      }
    };
    const workers = await Promise.allSettled(
      Array.from(
        {
          length: Math.min(
            CURRICULUM_SEGMENT_MAX_CONCURRENCY,
            manifest.segments.length,
          ),
        },
        executeNext,
      ),
    );
    const failedWorker = workers.find(
      (worker): worker is PromiseRejectedResult => worker.status === "rejected",
    );
    if (failedWorker !== undefined) {
      throw failedWorker.reason;
    }
    return manifest.segments.map((segment) =>
      required(
        completed.get(segment.id),
        "missing completed curriculum segment",
      ),
    );
  }
}

export function materializeCurriculumOutline(
  access: AuthorizedSourceAccess,
  generation: CurriculumGenerationRecord,
): CurriculumOutline {
  const conceptIds = new Map<string, string>();
  for (const chapter of generation.structure.chapters) {
    for (const concept of chapter.concepts) {
      conceptIds.set(
        concept.key,
        "id" in concept
          ? concept.id
          : stableUuid({
              conceptKey: concept.key,
              courseId: access.courseId,
              curriculumGenerationId: generation.generationId,
            }),
      );
    }
  }
  return {
    chapters: generation.structure.chapters.map((chapter, chapterIndex) => ({
      concepts: chapter.concepts.map((concept) => ({
        id: required(conceptIds.get(concept.key), "missing concept identity"),
        key: concept.key,
        name: concept.name,
        prerequisiteIds: concept.prerequisiteKeys.map((key) =>
          required(conceptIds.get(key), "missing prerequisite identity"),
        ),
        sourceSpanIds: concept.sourceSpanIds,
      })),
      id:
        "id" in chapter
          ? chapter.id
          : stableUuid({
              chapterIndex,
              courseId: access.courseId,
              curriculumGenerationId: generation.generationId,
              sourceSpanIds: chapter.sourceSpanIds,
              title: chapter.title,
            }),
      sourceSpanIds: chapter.sourceSpanIds,
      title: chapter.title,
    })),
    courseId: access.courseId,
    generationId: generation.generationId,
    ownerScopeId: access.ownerScopeId,
    sourceDocumentId: access.sourceDocumentId,
    status: "ready",
  };
}

function buildEmbeddingGeneration(
  access: AuthorizedSourceAccess,
  spans: readonly SourceSpanRecord[],
  batches: readonly RoutedModelResult<"embedding.document.v1">[],
): EmbeddingGenerationRecord {
  const first = required(batches[0], "missing embedding batch");
  const result = first.value;
  const provenance = first.provenance;
  const providerRequestIds = batches.map(
    (batch) => batch.value.metadata.providerRequestId,
  );
  const profileVersion =
    provenance.embeddingProfileVersion ?? EMBEDDING_PROFILE_VERSION;
  const generationId = stableUuid({
    adapterVersion: provenance.adapterVersion,
    effectiveModel: provenance.effectiveModel,
    effectiveModelVersion: provenance.effectiveModelVersion,
    endpoint: result.metadata.endpoint,
    inputHashes: spans.map((span) => span.embeddingInputHash),
    profileVersion,
    providerIdentifier: result.metadata.providerIdentifier,
    providerRequestIds,
    region: result.metadata.region,
    sourceDocumentId: access.sourceDocumentId,
  });
  return {
    adapterVersion: provenance.adapterVersion,
    dimensions: EMBEDDING_DIMENSIONS,
    effectiveModel: provenance.effectiveModel,
    effectiveModelVersion: provenance.effectiveModelVersion,
    endpoint: result.metadata.endpoint,
    generationId,
    inputMode: "document",
    ownerScopeId: access.ownerScopeId,
    profileVersion,
    providerIdentifier: result.metadata.providerIdentifier,
    providerRequestIds,
    region: result.metadata.region,
    sourceDocumentId: access.sourceDocumentId,
    spanIds: spans.map((span) => span.id),
  };
}

function buildComposedCurriculumGeneration(
  access: AuthorizedSourceAccess,
  generationId: string,
  embeddingGenerationId: string,
  structure: ComposedCurriculumResult,
  provenance: readonly ModelCallProvenance[],
): CurriculumGenerationRecord {
  const resultHash = sha256(canonicalJson(structure));
  return {
    courseId: access.courseId,
    embeddingGenerationId,
    generationId,
    modelProvenance: provenance,
    ownerScopeId: access.ownerScopeId,
    resultHash,
    sourceDocumentId: access.sourceDocumentId,
    structure,
    version: CURRICULUM_SEGMENT_GENERATION_VERSION,
  };
}

function assertEmbeddingMetadata(
  result: EmbeddingResult,
  expectedInputMode: "document" | "query",
): void {
  if (
    result.metadata.inputMode !== expectedInputMode ||
    result.metadata.dimensions !== EMBEDDING_DIMENSIONS
  ) {
    throw new RetrievalError(
      "invalid_model_result",
      "embedding result used the wrong input profile",
    );
  }
}

function assertSameEmbeddingProfile(
  expected: RoutedModelResult<"embedding.document.v1">,
  actual: RoutedModelResult<"embedding.document.v1">,
): void {
  if (
    expected.provenance.adapterVersion !== actual.provenance.adapterVersion ||
    expected.provenance.effectiveModel !== actual.provenance.effectiveModel ||
    expected.provenance.effectiveModelVersion !==
      actual.provenance.effectiveModelVersion ||
    expected.provenance.embeddingProfileVersion !==
      actual.provenance.embeddingProfileVersion ||
    expected.value.metadata.endpoint !== actual.value.metadata.endpoint ||
    expected.value.metadata.providerIdentifier !==
      actual.value.metadata.providerIdentifier ||
    expected.value.metadata.region !== actual.value.metadata.region
  ) {
    throw new RetrievalError(
      "invalid_model_result",
      "embedding profile changed within one generation",
    );
  }
}

function assertCompatibleActiveEmbeddingGeneration(
  active: EmbeddingGenerationRecord,
  query: RoutedModelResult<"embedding.query.v1">,
): void {
  const queryProfile =
    query.provenance.embeddingProfileVersion ?? EMBEDDING_PROFILE_VERSION;
  if (
    active.profileVersion !== queryProfile ||
    active.dimensions !== query.value.metadata.dimensions ||
    active.adapterVersion !== query.provenance.adapterVersion ||
    active.effectiveModel !== query.provenance.effectiveModel ||
    active.effectiveModelVersion !== query.provenance.effectiveModelVersion ||
    active.endpoint !== query.value.metadata.endpoint ||
    active.providerIdentifier !== query.value.metadata.providerIdentifier ||
    active.region !== query.value.metadata.region
  ) {
    throw new RetrievalError(
      "invalid_configuration",
      "active embedding profile is incompatible; rebuild the local generation before search",
    );
  }
}

function assertOutline(
  access: AuthorizedSourceAccess,
  generation: CurriculumGenerationRecord,
  outline: CurriculumOutline,
): void {
  if (
    outline.ownerScopeId !== access.ownerScopeId ||
    outline.sourceDocumentId !== access.sourceDocumentId ||
    outline.courseId !== access.courseId ||
    outline.generationId !== generation.generationId ||
    outline.status !== "ready" ||
    outline.chapters.length === 0 ||
    outline.chapters.some(
      (chapter) =>
        chapter.concepts.length === 0 ||
        chapter.sourceSpanIds.length === 0 ||
        chapter.concepts.some((concept) => concept.sourceSpanIds.length === 0),
    )
  ) {
    throw new RetrievalError(
      "persistence_failure",
      "persisted curriculum is not a usable source-backed outline",
    );
  }
}

function validateDeadline(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RetrievalError("invalid_configuration", "invalid model deadline");
  }
}

function remainingDeadline(deadlineAt: number, now: () => number): number {
  const remaining = deadlineAt - now();
  if (remaining <= 0) {
    throw new RetrievalError("deadline_exceeded", "model deadline elapsed");
  }
  return remaining;
}

function curriculumSegmentFailureClass(error: unknown): string {
  if (error instanceof ModelRouterError) {
    return `model_${error.code}`;
  }
  if (error instanceof RetrievalError) {
    return `retrieval_${error.code}`;
  }
  return "generation_dependency_unavailable";
}

function curriculumSegmentRetryable(error: unknown): boolean {
  if (error instanceof ModelRouterError) {
    return (
      error.code === "adapter_unavailable" ||
      error.code === "trace_failure" ||
      (error.code === "provider_failure" &&
        error.providerFailure?.transient !== false)
    );
  }
  return (
    error instanceof RetrievalError && error.code === "persistence_failure"
  );
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) {
    throw new RetrievalError("invalid_model_result", message);
  }
  return value;
}
