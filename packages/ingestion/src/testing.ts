import { createHash } from "node:crypto";

import type {
  AuthorizedQuarantinedSource,
  IngestionCommand,
  IngestionOutcome,
  MalwareSignatureSnapshot,
  StagedUpload,
  WorkerExecutionRequest,
  NormalizedDocument,
  NormalizedDocumentArtifact,
} from "./contracts.js";
import type {
  EphemeralWorkspacePort,
  IngestionClock,
  IngestionOperationStore,
  IngestionWorkspace,
  IsolatedDocumentWorkerPort,
  MalwareScannerPort,
  NormalizedDocumentPublisherPort,
  OperationClaim,
  QuarantineObjectPort,
} from "./ports.js";

export class FixedIngestionClock implements IngestionClock {
  constructor(private readonly value: Date) {}

  now(): Date {
    return new Date(this.value);
  }
}

export class InMemoryIngestionOperationStore implements IngestionOperationStore {
  readonly #active = new Set<string>();
  readonly #completed = new Map<string, IngestionOutcome>();
  readonly #sources = new Map<string, AuthorizedQuarantinedSource>();
  finalizeCalls = 0;

  addSource(source: AuthorizedQuarantinedSource): void {
    this.#sources.set(source.sourceDocumentId, source);
  }

  setActive(operationId: string): void {
    this.#active.add(operationId);
  }

  async claim(command: IngestionCommand): Promise<OperationClaim> {
    const completed = this.#completed.get(command.operationId);
    if (completed !== undefined) {
      return { kind: "completed", outcome: completed };
    }
    if (this.#active.has(command.operationId)) {
      return { kind: "active" };
    }
    this.#active.add(command.operationId);
    return { kind: "claimed" };
  }

  async resolveAuthorizedSource(
    command: IngestionCommand,
  ): Promise<AuthorizedQuarantinedSource | null> {
    return this.#sources.get(command.sourceDocumentId) ?? null;
  }

  async finalize(
    operationId: string,
    outcome: IngestionOutcome,
  ): Promise<boolean> {
    this.finalizeCalls += 1;
    if (this.#completed.has(operationId)) {
      return false;
    }
    this.#completed.set(operationId, outcome);
    this.#active.delete(operationId);
    return true;
  }

  async readCompleted(operationId: string): Promise<IngestionOutcome | null> {
    return this.#completed.get(operationId) ?? null;
  }
}

export class DeterministicWorkspacePort implements EphemeralWorkspacePort {
  readonly cleaned: string[] = [];
  failCleanup = false;

  async create(operationId: string): Promise<IngestionWorkspace> {
    const directory = `/tmp/reflo-ingestion-tests/${operationId}-attempt-0001`;
    return { directory, outputDirectory: `${directory}/output` };
  }

  async cleanup(workspace: IngestionWorkspace): Promise<void> {
    this.cleaned.push(workspace.directory);
    if (this.failCleanup) {
      throw new Error("cleanup failed");
    }
  }
}

export class InMemoryQuarantineObjectPort implements QuarantineObjectPort {
  readonly #objects = new Map<string, Uint8Array>();
  stageCalls = 0;

  add(objectKey: string, bytes: Uint8Array): void {
    this.#objects.set(objectKey, bytes);
  }

  async stage(
    source: AuthorizedQuarantinedSource,
    workspace: IngestionWorkspace,
  ): Promise<StagedUpload> {
    this.stageCalls += 1;
    const bytes = this.#objects.get(source.objectKey);
    if (bytes === undefined) {
      throw new Error("missing quarantine object");
    }
    return {
      byteLength: bytes.byteLength,
      bytes,
      inputPath: `${workspace.directory}/source`,
      sha256: sha256(bytes),
    };
  }
}

export class DeterministicMalwareScanner implements MalwareScannerPort {
  clean = true;
  scanCalls = 0;
  snapshot: MalwareSignatureSnapshot | null;

  constructor(snapshot: MalwareSignatureSnapshot | null) {
    this.snapshot = snapshot;
  }

  async currentSnapshot(): Promise<MalwareSignatureSnapshot | null> {
    return this.snapshot;
  }

  async scan(
    _staged: StagedUpload,
    _snapshot: MalwareSignatureSnapshot,
  ): Promise<{ readonly clean: boolean }> {
    this.scanCalls += 1;
    return { clean: this.clean };
  }
}

export class DeterministicDocumentWorker implements IsolatedDocumentWorkerPort {
  readonly requests: WorkerExecutionRequest[] = [];

  constructor(public output: unknown) {}

  async execute(request: WorkerExecutionRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.output instanceof Error) {
      throw this.output;
    }
    return this.output;
  }
}

export class DeterministicNormalizedDocumentPublisher implements NormalizedDocumentPublisherPort {
  readonly published: NormalizedDocument[] = [];

  async publish(input: {
    readonly command: IngestionCommand;
    readonly document: NormalizedDocument;
  }): Promise<NormalizedDocumentArtifact> {
    this.published.push(input.document);
    const serialized = Buffer.from(JSON.stringify(input.document), "utf8");
    return {
      artifactId: `artifact-${input.command.operationId}`,
      blockCount: input.document.blocks.length,
      byteLength: serialized.byteLength,
      documentKind: input.document.documentKind,
      documentSha256: sha256(serialized),
      inputSha256: input.document.inputSha256,
      pageCount: input.document.pageCount,
      parserVersion: input.document.parserVersion,
      workerImageDigest: input.document.workerImageDigest,
    };
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
