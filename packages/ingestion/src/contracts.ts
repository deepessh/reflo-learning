export const INGESTION_PROFILE_VERSION = "isolated-ingestion-v1" as const;
export const INGESTION_LIMITS_VERSION = "isolated-ingestion-limits-v1" as const;
export const NORMALIZED_DOCUMENT_VERSION = "normalized-document-v1" as const;
export const SCAN_CLASSIFIER_VERSION = "scan-detect-v1" as const;

export const INGESTION_COMPONENTS = Object.freeze({
  clamAv: "1.4.5",
  ociRuntime: "podman-6.0.1",
  ocrEngine: "tesseract-5.5.2",
  ocrLanguage: "eng-tessdata_fast-checksum-pinned",
  parser: "apache-tika-3.3.1",
});

export const INGESTION_LIMITS = Object.freeze({
  archive: {
    maxEntries: 10_000,
    maxExpansionBytes: 1_024 * 1_024 * 1_024,
    maxExpansionRatio: 100,
    maxNestingDepth: 4,
    maxSingleEntryBytes: 100 * 1_024 * 1_024,
  },
  largeDocument: {
    maxBytes: 50 * 1_024 * 1_024,
    maxStablePages: 800,
    wallTimeMs: 30 * 60 * 1_000,
  },
  normalizedOutputBytes: 512 * 1_024 * 1_024,
  ocrPageTimeMs: 60 * 1_000,
  standardDocument: {
    maxBytes: 20 * 1_024 * 1_024,
    maxStablePages: 200,
    wallTimeMs: 90 * 1_000,
  },
  worker: {
    cpuCount: 2,
    memoryBytes: 4 * 1_024 * 1_024 * 1_024,
    maxPids: 256,
    temporaryStorageBytes: 4 * 1_024 * 1_024 * 1_024,
  },
});

export type DocumentKind = "docx" | "epub" | "pdf";
export type ProcessingLane = "large" | "standard";
export type ScanClassification = "digital" | "mixed" | "scanned";

export type IngestionFailureCode =
  | "active_content"
  | "archive_limit"
  | "authorization_denied"
  | "encrypted"
  | "hash_mismatch"
  | "infrastructure_unavailable"
  | "invalid_output"
  | "malformed_document"
  | "malware_detected"
  | "mime_mismatch"
  | "page_limit"
  | "parse_oom"
  | "parse_timeout"
  | "parser_crash"
  | "retention_blocked"
  | "scan_db_stale"
  | "unsupported_type";

export interface IngestionCommand {
  readonly expectedInputSha256: string;
  readonly operationId: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
}

export interface AuthorizedQuarantinedSource {
  readonly clientMimeType: string;
  readonly expectedByteLength: number;
  readonly expectedInputSha256: string;
  readonly extension: string;
  readonly objectKey: string;
  readonly ownerScopeId: string;
  readonly retentionState: "active";
  readonly sourceDocumentId: string;
}

export interface StagedUpload {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly inputPath: string;
  readonly sha256: string;
}

export interface ValidatedUpload {
  readonly documentKind: DocumentKind;
  readonly processingLane: ProcessingLane;
}

export interface PdfLocator {
  readonly kind: "pdf";
  readonly page: number;
  readonly sectionPath: readonly string[];
}

export interface EpubLocator {
  readonly kind: "epub";
  readonly page: null;
  readonly resource: string;
  readonly sectionPath: readonly string[];
  readonly spineItem: number;
}

export interface DocxLocator {
  readonly bodyElement: number;
  readonly headingPath: readonly string[];
  readonly kind: "docx";
  readonly page: null;
  readonly section: number;
}

export type NativeLocator = PdfLocator | EpubLocator | DocxLocator;

export interface NormalizedBlock {
  readonly canonicalEnd: number;
  readonly canonicalStart: number;
  readonly kind: "heading" | "list" | "paragraph" | "table";
  readonly locator: NativeLocator;
  readonly order: number;
  readonly text: string;
  readonly textSha256: string;
}

export interface NormalizedDocument {
  readonly blocks: readonly NormalizedBlock[];
  readonly classifierVersion: typeof SCAN_CLASSIFIER_VERSION;
  readonly configVersion: typeof INGESTION_PROFILE_VERSION;
  readonly contractVersion: typeof NORMALIZED_DOCUMENT_VERSION;
  readonly diagnostics: readonly string[];
  readonly documentKind: DocumentKind;
  readonly inputSha256: string;
  readonly pageCount: number | null;
  readonly parserVersion: typeof INGESTION_COMPONENTS.parser;
  readonly scan: {
    readonly candidatePages: readonly number[];
    readonly classification: ScanClassification;
    readonly rasterDpi: 300;
  };
  readonly workerImageDigest: string;
}

export interface MalwareSignatureSnapshot {
  readonly publishedAt: Date;
  readonly signatureVersion: string;
  readonly verified: boolean;
}

export interface NormalizedDocumentArtifact {
  readonly artifactId: string;
  readonly blockCount: number;
  readonly byteLength: number;
  readonly documentKind: DocumentKind;
  readonly documentSha256: string;
  readonly inputSha256: string;
  readonly pageCount: number | null;
  readonly parserVersion: typeof INGESTION_COMPONENTS.parser;
  readonly workerImageDigest: string;
}

export type IngestionOutcome =
  | {
      readonly artifact: NormalizedDocumentArtifact;
      readonly kind: "parsed";
      readonly processingLane: ProcessingLane;
    }
  | {
      readonly candidatePages: readonly number[];
      readonly classification: "mixed" | "scanned";
      readonly artifact: NormalizedDocumentArtifact;
      readonly kind: "ocr_required";
      readonly processingLane: "large";
    }
  | {
      readonly failure: IngestionFailure;
      readonly kind: "failed";
    };

export interface IngestionFailure {
  readonly code: IngestionFailureCode;
  readonly retryable: boolean;
  readonly sanitizedDetail?: string;
}

export type IngestionRunResult =
  | { readonly kind: "completed"; readonly outcome: IngestionOutcome }
  | { readonly kind: "in_progress" };

export interface WorkerExecutionRequest {
  readonly documentKind: DocumentKind;
  readonly inputPath: string;
  readonly inputSha256: string;
  readonly operationId: string;
  readonly outputDirectory: string;
  readonly processingLane: ProcessingLane;
}
