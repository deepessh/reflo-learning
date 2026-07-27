import type { NativeLocator, NormalizedDocument } from "@reflo/ingestion";
import type {
  CurriculumSegmentResult,
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
export const CURRICULUM_SEGMENT_GENERATION_VERSION = "curriculum-v2" as const;
export const CURRICULUM_PARTITION_VERSION = "curriculum-partition-v1" as const;
export const CURRICULUM_COMPOSITION_VERSION = "curriculum-compose-v1" as const;
export const CURRICULUM_SEGMENT_TASK_VERSION = "curriculum.segment.v1" as const;
export const CURRICULUM_SEGMENT_MAX_SPANS = 12 as const;
export const CURRICULUM_SEGMENT_MAX_SOURCE_TOKENS = 8_000 as const;
export const CURRICULUM_SEGMENT_MAX_CONCURRENCY = 4 as const;
export const CURRICULUM_PARENT_DEADLINE_MS = 960_000 as const;
export const CURRICULUM_SEGMENT_DEADLINE_MS = 240_000 as const;
export const CURRICULUM_FINALIZATION_RESERVE_MS = 96_000 as const;
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
  readonly profileVersion: string;
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
  readonly modelProvenance:
    ModelCallProvenance | readonly ModelCallProvenance[];
  readonly ownerScopeId: string;
  readonly resultHash: string;
  readonly sourceDocumentId: string;
  readonly structure: CurriculumStructureResult | ComposedCurriculumResult;
  readonly version:
    | typeof CURRICULUM_GENERATION_VERSION
    | typeof CURRICULUM_SEGMENT_GENERATION_VERSION;
}

export interface CurriculumSegmentManifestEntry {
  readonly firstSourceOrder: number;
  readonly id: string;
  readonly inputHash: string;
  readonly lastSourceOrder: number;
  readonly ordinal: number;
  readonly parentGenerationId: string;
  readonly partitionVersion: typeof CURRICULUM_PARTITION_VERSION;
  readonly sectionPath: readonly string[] | null;
  readonly sourceSpanIds: readonly string[];
  readonly sourceSpanInputHashes: readonly string[];
  readonly sourceTokenCount: number;
}

export interface CurriculumPartitionManifest {
  readonly compositionVersion: typeof CURRICULUM_COMPOSITION_VERSION;
  readonly embeddingGenerationId: string;
  readonly generationVersion: typeof CURRICULUM_SEGMENT_GENERATION_VERSION;
  readonly manifestHash: string;
  readonly ownerScopeId: string;
  readonly parentGenerationId: string;
  readonly partitionVersion: typeof CURRICULUM_PARTITION_VERSION;
  readonly segments: readonly CurriculumSegmentManifestEntry[];
  readonly sourceDocumentId: string;
  readonly courseId: string;
  readonly tokenizerVersion: typeof TOKENIZER_VERSION;
}

export interface PersistedCurriculumSegmentResult {
  readonly attemptCount: number;
  readonly inputHash: string;
  readonly modelProvenance: ModelCallProvenance;
  readonly result: CurriculumSegmentResult;
  readonly resultHash: string;
  readonly segmentId: string;
}

export type CurriculumSegmentClaim =
  | {
      readonly kind: "active";
    }
  | {
      readonly attemptCount: number;
      readonly kind: "claimed";
    }
  | {
      readonly kind: "completed";
      readonly persisted: PersistedCurriculumSegmentResult;
    }
  | {
      readonly kind: "failed";
    };

export interface CurriculumSegmentCompletion {
  readonly attemptCount: number;
  readonly inputHash: string;
  readonly modelProvenance: ModelCallProvenance;
  readonly parentGenerationId: string;
  readonly result: CurriculumSegmentResult;
  readonly resultHash: string;
  readonly segmentId: string;
}

export interface CurriculumSegmentFailure {
  readonly attemptCount: number;
  readonly failureClass: string;
  readonly inputHash: string;
  readonly parentGenerationId: string;
  readonly retryable: boolean;
  readonly segmentId: string;
}

export interface ComposedCurriculumResult {
  readonly chapters: readonly {
    readonly concepts: readonly {
      readonly id: string;
      readonly key: string;
      readonly name: string;
      readonly prerequisiteKeys: readonly string[];
      readonly sourceSpanIds: readonly string[];
    }[];
    readonly id: string;
    readonly sourceSpanIds: readonly string[];
    readonly title: string;
  }[];
  readonly childResultHashes: readonly string[];
  readonly compositionVersion: typeof CURRICULUM_COMPOSITION_VERSION;
  readonly embeddingGenerationId: string;
  readonly generationVersion: typeof CURRICULUM_SEGMENT_GENERATION_VERSION;
  readonly partitionManifestHash: string;
}

export interface CurriculumOrchestrationMetrics {
  readonly chapterCount: number;
  readonly compositionFinalizationMs: number;
  readonly conceptCount: number;
  readonly finalizationReserveMs: number;
  readonly parentDeadlineMs: number;
  readonly retryCount: number;
  readonly segmentAttemptCounts: readonly number[];
  readonly segmentCount: number;
  readonly segmentLatenciesMs: readonly number[];
  readonly segmentQueueTimesMs: readonly number[];
  readonly terminalReason: "outline_ready";
  readonly totalLatencyMs: number;
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
  readonly orchestration: CurriculumOrchestrationMetrics;
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
