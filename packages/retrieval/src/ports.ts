import type { ModelTaskInput, RoutedModelResult } from "@reflo/model-router";

import type {
  AuthorizedSourceAccess,
  CurriculumGenerationRecord,
  CurriculumOutline,
  EmbeddingGenerationRecord,
  RetrievedSourceSpan,
  ScopeAuthorizationContext,
  SourceSpanRecord,
  VectorRecord,
  VectorSearchResult,
} from "./contracts.js";

export type RetrievalModelTask =
  "curriculum.structure.v1" | "embedding.document.v1" | "embedding.query.v1";

export interface RetrievalModelRouterPort {
  execute<Task extends RetrievalModelTask>(
    task: Task,
    input: ModelTaskInput<Task>,
    options: { readonly deadlineMs: number },
  ): Promise<RoutedModelResult<Task>>;
}

export interface ContentRepositoryPort {
  authorizeSource(
    context: ScopeAuthorizationContext,
    sourceDocumentId: string,
    courseId: string,
  ): Promise<AuthorizedSourceAccess | null>;

  persistSourceSpans(
    access: AuthorizedSourceAccess,
    spans: readonly SourceSpanRecord[],
  ): Promise<void>;

  recordEmbeddingGeneration(
    access: AuthorizedSourceAccess,
    generation: EmbeddingGenerationRecord,
  ): Promise<void>;

  activateEmbeddingGeneration(
    access: AuthorizedSourceAccess,
    generationId: string,
  ): Promise<void>;

  activeEmbeddingGeneration(
    access: AuthorizedSourceAccess,
  ): Promise<EmbeddingGenerationRecord | null>;

  resolveAuthorizedSourceSpans(
    access: AuthorizedSourceAccess,
    generationId: string,
    sourceSpanIds: readonly string[],
  ): Promise<readonly RetrievedSourceSpan[]>;

  persistCurriculum(
    access: AuthorizedSourceAccess,
    generation: CurriculumGenerationRecord,
  ): Promise<CurriculumOutline>;
}

export interface VectorStorePort {
  writeGeneration(
    access: AuthorizedSourceAccess,
    generation: EmbeddingGenerationRecord,
    records: readonly VectorRecord[],
  ): Promise<void>;

  searchExact(
    access: AuthorizedSourceAccess,
    generationId: string,
    queryVector: readonly number[],
    limit: number,
  ): Promise<readonly VectorSearchResult[]>;

  purgeSource(access: AuthorizedSourceAccess): Promise<number>;
}

export interface SqlQueryResult<Row extends Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface AnalyticDbSessionPort {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
  release(): void;
}

export interface AnalyticDbPoolPort {
  connect(): Promise<AnalyticDbSessionPort>;
}
