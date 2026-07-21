import type {
  AuthorizedQuarantinedSource,
  IngestionCommand,
  IngestionOutcome,
  MalwareSignatureSnapshot,
  NormalizedDocument,
  NormalizedDocumentArtifact,
  StagedUpload,
  WorkerExecutionRequest,
} from "./contracts.js";

export interface IngestionClock {
  now(): Date;
}

export type OperationClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "active" }
  | { readonly kind: "completed"; readonly outcome: IngestionOutcome };

export interface IngestionOperationStore {
  claim(command: IngestionCommand): Promise<OperationClaim>;

  /** Reauthorizes active membership, source ownership, and retention state. */
  resolveAuthorizedSource(
    command: IngestionCommand,
  ): Promise<AuthorizedQuarantinedSource | null>;

  /** First committed terminal state wins. False means another lease finalized. */
  finalize(operationId: string, outcome: IngestionOutcome): Promise<boolean>;

  readCompleted(operationId: string): Promise<IngestionOutcome | null>;
}

export interface IngestionWorkspace {
  readonly directory: string;
  readonly outputDirectory: string;
}

export interface EphemeralWorkspacePort {
  create(operationId: string): Promise<IngestionWorkspace>;
  cleanup(workspace: IngestionWorkspace): Promise<void>;
}

export interface QuarantineObjectPort {
  /** Stages exactly one source into the job workspace without exposing credentials. */
  stage(
    source: AuthorizedQuarantinedSource,
    workspace: IngestionWorkspace,
  ): Promise<StagedUpload>;
}

export interface MalwareScannerPort {
  currentSnapshot(): Promise<MalwareSignatureSnapshot | null>;
  scan(
    staged: StagedUpload,
    snapshot: MalwareSignatureSnapshot,
  ): Promise<{ readonly clean: boolean }>;
}

export interface IsolatedDocumentWorkerPort {
  execute(request: WorkerExecutionRequest): Promise<unknown>;
}

export interface NormalizedDocumentPublisherPort {
  /**
   * Idempotently publishes the validated internal artifact by operation and
   * input hash. The returned reference contains no source text or object key.
   */
  publish(input: {
    readonly command: IngestionCommand;
    readonly document: NormalizedDocument;
  }): Promise<NormalizedDocumentArtifact>;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface ProcessRunnerPort {
  run(
    executable: string,
    args: readonly string[],
    options: {
      readonly maxOutputBytes: number;
      readonly timeoutMs: number;
    },
  ): Promise<ProcessResult>;
}

export interface WorkerOutputReaderPort {
  readNormalizedDocument(outputDirectory: string): Promise<unknown>;
}

export type ValidatedWorkerDocument = NormalizedDocument;
