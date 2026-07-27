import {
  materializeCurriculumOutline,
  canonicalJson,
  type AuthorizedSourceAccess,
  type ContentRepositoryPort,
  type CurriculumGenerationRecord,
  type CurriculumOutline,
  type CurriculumPartitionManifest,
  type CurriculumSegmentClaim,
  type CurriculumSegmentCompletion,
  type CurriculumSegmentFailure,
  type CurriculumSegmentManifestEntry,
  type PersistedCurriculumSegmentResult,
  type EmbeddingGenerationRecord,
  type RetrievedSourceSpan,
  type ScopeAuthorizationContext,
  type SourceSpanRecord,
  type VectorRecord,
  type VectorSearchResult,
  type VectorStorePort,
} from "./index.js";

export class InMemoryContentRepository implements ContentRepositoryPort {
  activeGeneration: EmbeddingGenerationRecord | null = null;
  readonly curriculumGenerations: CurriculumGenerationRecord[] = [];
  readonly curriculumPartitions = new Map<
    string,
    CurriculumPartitionManifest
  >();
  readonly curriculumSegments = new Map<
    string,
    {
      attempts: number;
      inputHash: string;
      persisted?: PersistedCurriculumSegmentResult;
      state:
        "failed" | "processing" | "queued" | "retry_scheduled" | "succeeded";
    }
  >();
  readonly embeddingGenerations: EmbeddingGenerationRecord[] = [];
  readonly sourceSpans = new Map<string, SourceSpanRecord>();

  constructor(readonly access: AuthorizedSourceAccess) {}

  async authorizeSource(
    context: ScopeAuthorizationContext,
    sourceDocumentId: string,
    courseId: string,
  ): Promise<AuthorizedSourceAccess | null> {
    return context.actorId === this.access.actorId &&
      context.authorizationId === this.access.authorizationId &&
      context.ownerScopeId === this.access.ownerScopeId &&
      sourceDocumentId === this.access.sourceDocumentId &&
      courseId === this.access.courseId
      ? this.access
      : null;
  }

  async persistSourceSpans(
    access: AuthorizedSourceAccess,
    spans: readonly SourceSpanRecord[],
  ): Promise<void> {
    this.#assertAccess(access);
    for (const span of spans) {
      this.sourceSpans.set(span.id, span);
    }
  }

  async recordEmbeddingGeneration(
    access: AuthorizedSourceAccess,
    generation: EmbeddingGenerationRecord,
  ): Promise<void> {
    this.#assertAccess(access);
    this.embeddingGenerations.push(generation);
  }

  async activateEmbeddingGeneration(
    access: AuthorizedSourceAccess,
    generationId: string,
  ): Promise<void> {
    this.#assertAccess(access);
    if (
      !this.embeddingGenerations.some(
        (entry) => entry.generationId === generationId,
      )
    ) {
      throw new Error("unknown generation");
    }
    this.activeGeneration =
      this.embeddingGenerations.find(
        (entry) => entry.generationId === generationId,
      ) ?? null;
  }

  async activeEmbeddingGeneration(
    access: AuthorizedSourceAccess,
  ): Promise<EmbeddingGenerationRecord | null> {
    this.#assertAccess(access);
    return this.activeGeneration;
  }

  async resolveAuthorizedSourceSpans(
    access: AuthorizedSourceAccess,
    generationId: string,
    sourceSpanIds: readonly string[],
  ): Promise<readonly RetrievedSourceSpan[]> {
    this.#assertAccess(access);
    if (generationId !== this.activeGeneration?.generationId) {
      return [];
    }
    return sourceSpanIds.flatMap((id) => {
      const span = this.sourceSpans.get(id);
      return span === undefined
        ? []
        : [{ id, sectionPath: span.sectionPath, text: span.canonicalText }];
    });
  }

  async persistCurriculumPartition(
    access: AuthorizedSourceAccess,
    manifest: CurriculumPartitionManifest,
  ): Promise<void> {
    this.#assertAccess(access);
    const existing = this.curriculumPartitions.get(manifest.parentGenerationId);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(manifest)
    ) {
      throw new Error("curriculum partition changed");
    }
    this.curriculumPartitions.set(manifest.parentGenerationId, manifest);
    for (const segment of manifest.segments) {
      const key = segmentKey(manifest.parentGenerationId, segment.id);
      const current = this.curriculumSegments.get(key);
      if (current !== undefined && current.inputHash !== segment.inputHash) {
        throw new Error("curriculum segment changed");
      }
      this.curriculumSegments.set(
        key,
        current ?? {
          attempts: 0,
          inputHash: segment.inputHash,
          state: "queued",
        },
      );
    }
  }

  async claimCurriculumSegment(
    access: AuthorizedSourceAccess,
    parentGenerationId: string,
    segment: CurriculumSegmentManifestEntry,
  ): Promise<CurriculumSegmentClaim> {
    this.#assertAccess(access);
    const state = this.curriculumSegments.get(
      segmentKey(parentGenerationId, segment.id),
    );
    if (state === undefined || state.inputHash !== segment.inputHash) {
      throw new Error("unknown curriculum segment");
    }
    if (state.state === "succeeded" && state.persisted !== undefined) {
      return { kind: "completed", persisted: state.persisted };
    }
    if (state.state === "processing") {
      return { kind: "active" };
    }
    if (state.state === "failed") {
      return { kind: "failed" };
    }
    state.attempts += 1;
    state.state = "processing";
    return { attemptCount: state.attempts, kind: "claimed" };
  }

  async completeCurriculumSegment(
    access: AuthorizedSourceAccess,
    completion: CurriculumSegmentCompletion,
  ): Promise<void> {
    this.#assertAccess(access);
    const state = this.curriculumSegments.get(
      segmentKey(completion.parentGenerationId, completion.segmentId),
    );
    if (
      state === undefined ||
      state.state !== "processing" ||
      state.attempts !== completion.attemptCount ||
      state.inputHash !== completion.inputHash
    ) {
      throw new Error("curriculum segment completion rejected");
    }
    state.persisted = {
      attemptCount: state.attempts,
      inputHash: completion.inputHash,
      modelProvenance: completion.modelProvenance,
      result: completion.result,
      resultHash: completion.resultHash,
      segmentId: completion.segmentId,
    };
    state.state = "succeeded";
  }

  async failCurriculumSegment(
    access: AuthorizedSourceAccess,
    failure: CurriculumSegmentFailure,
  ): Promise<void> {
    this.#assertAccess(access);
    const state = this.curriculumSegments.get(
      segmentKey(failure.parentGenerationId, failure.segmentId),
    );
    if (
      state === undefined ||
      state.state !== "processing" ||
      state.attempts !== failure.attemptCount ||
      state.inputHash !== failure.inputHash
    ) {
      throw new Error("curriculum segment failure rejected");
    }
    state.state =
      failure.retryable && state.attempts < 3 ? "retry_scheduled" : "failed";
  }

  async persistCurriculum(
    access: AuthorizedSourceAccess,
    generation: CurriculumGenerationRecord,
    _deadlineMs: number,
  ): Promise<CurriculumOutline> {
    this.#assertAccess(access);
    const existing = this.curriculumGenerations.find(
      (entry) => entry.generationId === generation.generationId,
    );
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(generation)
    ) {
      throw new Error("curriculum generation changed");
    }
    if (existing !== undefined) {
      return materializeCurriculumOutline(access, existing);
    }
    this.curriculumGenerations.push(generation);
    return materializeCurriculumOutline(access, generation);
  }

  #assertAccess(access: AuthorizedSourceAccess): void {
    if (
      access.actorId !== this.access.actorId ||
      access.authorizationId !== this.access.authorizationId ||
      access.ownerScopeId !== this.access.ownerScopeId ||
      access.sourceDocumentId !== this.access.sourceDocumentId ||
      access.courseId !== this.access.courseId
    ) {
      throw new Error("authorization denied");
    }
  }
}

function segmentKey(parentGenerationId: string, segmentId: string): string {
  return `${parentGenerationId}/${segmentId}`;
}

export class InMemoryVectorStore implements VectorStorePort {
  contaminatedResult: VectorSearchResult | null = null;
  readonly records: VectorRecord[] = [];

  async writeGeneration(
    access: AuthorizedSourceAccess,
    generation: EmbeddingGenerationRecord,
    records: readonly VectorRecord[],
  ): Promise<void> {
    if (
      access.ownerScopeId !== generation.ownerScopeId ||
      access.sourceDocumentId !== generation.sourceDocumentId ||
      records.some(
        (record) =>
          record.ownerScopeId !== access.ownerScopeId ||
          record.sourceDocumentId !== access.sourceDocumentId ||
          record.generationId !== generation.generationId,
      )
    ) {
      throw new Error("authorization denied");
    }
    this.records.push(...records);
  }

  async searchExact(
    access: AuthorizedSourceAccess,
    generationId: string,
    _queryVector: readonly number[],
    limit: number,
  ): Promise<readonly VectorSearchResult[]> {
    if (this.contaminatedResult !== null) {
      return [this.contaminatedResult];
    }
    return this.records
      .filter(
        (record) =>
          record.ownerScopeId === access.ownerScopeId &&
          record.sourceDocumentId === access.sourceDocumentId &&
          record.generationId === generationId,
      )
      .slice(0, limit)
      .map((record, index) => ({
        distance: index / 10,
        embeddingInputHash: record.embeddingInputHash,
        generationId: record.generationId,
        ownerScopeId: record.ownerScopeId,
        sourceDocumentId: record.sourceDocumentId,
        sourceSpanId: record.sourceSpanId,
      }));
  }

  async purgeSource(access: AuthorizedSourceAccess): Promise<number> {
    const retained = this.records.filter(
      (record) =>
        record.ownerScopeId !== access.ownerScopeId ||
        record.sourceDocumentId !== access.sourceDocumentId,
    );
    const removed = this.records.length - retained.length;
    this.records.splice(0, this.records.length, ...retained);
    return removed;
  }
}
