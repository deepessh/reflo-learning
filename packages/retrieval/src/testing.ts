import {
  materializeCurriculumOutline,
  type AuthorizedSourceAccess,
  type ContentRepositoryPort,
  type CurriculumGenerationRecord,
  type CurriculumOutline,
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

  async persistCurriculum(
    access: AuthorizedSourceAccess,
    generation: CurriculumGenerationRecord,
  ): Promise<CurriculumOutline> {
    this.#assertAccess(access);
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
