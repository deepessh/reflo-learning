import type { NativeLocator, NormalizedDocument } from "@reflo/ingestion";
import type {
  CurriculumStructureResult,
  ModelCallProvenance,
} from "@reflo/model-router";

export const SOURCE_SPAN_CONTRACT_VERSION = "source-span-v1" as const;
export const CHUNKER_VERSION = "chunk-v1" as const;
export const TOKENIZER_VERSION = "reflo-unicode-tokenizer-v1" as const;
export const EMBEDDING_PROFILE_VERSION = "embedding-v1" as const;
export const EMBEDDING_INPUT_PROFILE_VERSION = "embedding-input-v1" as const;
export const VECTOR_NAMESPACE_VERSION = "vector-namespace-v1" as const;
export const CURRICULUM_GENERATION_VERSION = "curriculum-v1" as const;
export const EMBEDDING_DIMENSIONS = 1_024 as const;

export interface ScopeAuthorizationContext {
  readonly actorId: string;
  readonly authorizationId: string;
  readonly ownerScopeId: string;
}

export interface AuthorizedSourceAccess {
  readonly actorId: string;
  readonly authorizationId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
}

export interface SourceSpanMapping {
  readonly canonicalEnd: number;
  readonly canonicalStart: number;
  readonly locator: NativeLocator;
  readonly overlap: boolean;
  readonly sourceBlockOrder: number;
  readonly textEnd: number;
  readonly textStart: number;
}

export interface SourceSpanRecord {
  readonly canonicalEnd: number;
  readonly canonicalStart: number;
  readonly canonicalText: string;
  readonly chunkOrder: number;
  readonly chunkerVersion: typeof CHUNKER_VERSION;
  readonly contractVersion: typeof SOURCE_SPAN_CONTRACT_VERSION;
  readonly embeddingInput: string;
  readonly embeddingInputHash: string;
  readonly embeddingInputProfileVersion: typeof EMBEDDING_INPUT_PROFILE_VERSION;
  readonly id: string;
  readonly mappings: readonly SourceSpanMapping[];
  readonly ownerScopeId: string;
  readonly pageEnd: number | null;
  readonly pageStart: number | null;
  readonly parserVersion: string;
  readonly sectionPath: readonly string[];
  readonly sourceDocumentId: string;
  readonly textHash: string;
  readonly tokenizerVersion: typeof TOKENIZER_VERSION;
}

export interface EmbeddingGenerationRecord {
  readonly adapterVersion: string;
  readonly dimensions: typeof EMBEDDING_DIMENSIONS;
  readonly effectiveModel: string;
  readonly effectiveModelVersion: string;
  readonly endpoint: string;
  readonly generationId: string;
  readonly inputMode: "document";
  readonly ownerScopeId: string;
  readonly profileVersion: typeof EMBEDDING_PROFILE_VERSION;
  readonly providerIdentifier: string;
  readonly providerRequestIds: readonly string[];
  readonly region: string;
  readonly sourceDocumentId: string;
  readonly spanIds: readonly string[];
}

export interface VectorRecord {
  readonly embedding: readonly number[];
  readonly embeddingInputHash: string;
  readonly generationId: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
  readonly sourceSpanId: string;
}

export interface VectorSearchResult {
  readonly distance: number;
  readonly embeddingInputHash: string;
  readonly generationId: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
  readonly sourceSpanId: string;
}

export interface CurriculumGenerationRecord {
  readonly courseId: string;
  readonly embeddingGenerationId: string;
  readonly generationId: string;
  readonly modelProvenance: ModelCallProvenance;
  readonly ownerScopeId: string;
  readonly resultHash: string;
  readonly sourceDocumentId: string;
  readonly structure: CurriculumStructureResult;
  readonly version: typeof CURRICULUM_GENERATION_VERSION;
}

export interface CurriculumOutline {
  readonly chapters: readonly {
    readonly concepts: readonly {
      readonly id: string;
      readonly key: string;
      readonly name: string;
      readonly prerequisiteIds: readonly string[];
      readonly sourceSpanIds: readonly string[];
    }[];
    readonly id: string;
    readonly sourceSpanIds: readonly string[];
    readonly title: string;
  }[];
  readonly courseId: string;
  readonly generationId: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
  readonly status: "ready";
}

export interface BuildCurriculumCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly deadlineMs: number;
  readonly document: NormalizedDocument;
  readonly sourceDocumentId: string;
}

export interface BuildCurriculumResult {
  readonly embeddingGeneration: EmbeddingGenerationRecord;
  readonly outline: CurriculumOutline;
  readonly sourceSpans: readonly SourceSpanRecord[];
}

export interface SearchCommand {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
  readonly deadlineMs: number;
  readonly limit: number;
  readonly query: string;
  readonly sourceDocumentId: string;
}

export interface RetrievedSourceSpan {
  readonly id: string;
  readonly sectionPath: readonly string[];
  readonly text: string;
}
