import { createHash } from "node:crypto";
import path from "node:path";

import {
  INGESTION_LIMITS,
  type AuthorizedQuarantinedSource,
  type IngestionCommand,
  type IngestionOutcome,
  type IngestionRunResult,
  type MalwareSignatureSnapshot,
  type ProcessingLane,
  type StagedUpload,
  type ValidatedUpload,
} from "./contracts.js";
import { IngestionError, normalizeIngestionFailure } from "./errors.js";
import { validateNormalizedDocument } from "./output-validation.js";
import type {
  EphemeralWorkspacePort,
  IngestionClock,
  IngestionOperationStore,
  IsolatedDocumentWorkerPort,
  MalwareScannerPort,
  NormalizedDocumentPublisherPort,
  QuarantineObjectPort,
} from "./ports.js";
import { validateUpload } from "./upload-validation.js";

const SCAN_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface IngestionSupervisorDependencies {
  readonly clock: IngestionClock;
  readonly malwareScanner: MalwareScannerPort;
  readonly operations: IngestionOperationStore;
  readonly publisher: NormalizedDocumentPublisherPort;
  readonly quarantine: QuarantineObjectPort;
  readonly worker: IsolatedDocumentWorkerPort;
  readonly workspaces: EphemeralWorkspacePort;
}

export class IngestionSupervisor {
  constructor(private readonly dependencies: IngestionSupervisorDependencies) {}

  async execute(command: IngestionCommand): Promise<IngestionRunResult> {
    validateCommand(command);
    const claim = await this.dependencies.operations.claim(command);
    if (claim.kind === "active") {
      return { kind: "in_progress" };
    }
    if (claim.kind === "completed") {
      return { kind: "completed", outcome: claim.outcome };
    }

    let proposed: IngestionOutcome;
    let workspace:
      Awaited<ReturnType<EphemeralWorkspacePort["create"]>> | undefined;
    try {
      const source =
        await this.dependencies.operations.resolveAuthorizedSource(command);
      assertAuthorizedSource(command, source);
      workspace = await this.dependencies.workspaces.create(
        command.operationId,
      );
      validateWorkspace(workspace, command.operationId);
      const staged = await this.dependencies.quarantine.stage(
        source,
        workspace,
      );
      validateStagedUpload(staged, workspace);
      const actualHash = sha256(staged.bytes);
      if (actualHash !== staged.sha256) {
        throw new IngestionError("hash_mismatch");
      }
      const validated = validateUpload(source, staged);
      await this.scanForMalware(staged);
      const rawOutput = await this.dependencies.worker.execute({
        documentKind: validated.documentKind,
        inputPath: staged.inputPath,
        inputSha256: staged.sha256,
        operationId: command.operationId,
        outputDirectory: workspace.outputDirectory,
        processingLane: validated.processingLane,
      });
      const document = validateNormalizedDocument(rawOutput, {
        documentKind: validated.documentKind,
        inputSha256: staged.sha256,
      });
      assertPageWithinLimit(document);
      const stillAuthorized =
        await this.dependencies.operations.resolveAuthorizedSource(command);
      if (stillAuthorized === null) {
        throw new IngestionError("authorization_denied");
      }
      const artifact = await this.dependencies.publisher.publish({
        command,
        document,
      });
      validatePublishedArtifact(artifact, document);
      proposed = outcomeFor(document, artifact, validated);
    } catch (error) {
      proposed = { failure: normalizeIngestionFailure(error), kind: "failed" };
    }

    if (workspace !== undefined) {
      try {
        await this.dependencies.workspaces.cleanup(workspace);
      } catch {
        proposed = {
          failure: {
            code: "infrastructure_unavailable",
            retryable: true,
            sanitizedDetail: "ephemeral_cleanup_incomplete",
          },
          kind: "failed",
        };
      }
    }

    const finalized = await this.dependencies.operations.finalize(
      command.operationId,
      proposed,
    );
    if (finalized) {
      return { kind: "completed", outcome: proposed };
    }
    const winner = await this.dependencies.operations.readCompleted(
      command.operationId,
    );
    if (winner === null) {
      throw new IngestionError("infrastructure_unavailable");
    }
    return { kind: "completed", outcome: winner };
  }

  async scanForMalware(staged: StagedUpload): Promise<void> {
    const snapshot = await this.dependencies.malwareScanner.currentSnapshot();
    validateSnapshot(snapshot, this.dependencies.clock.now());
    const result = await this.dependencies.malwareScanner.scan(
      staged,
      snapshot,
    );
    if (!result.clean) {
      throw new IngestionError("malware_detected");
    }
  }
}

function outcomeFor(
  document: ReturnType<typeof validateNormalizedDocument>,
  artifact: Awaited<ReturnType<NormalizedDocumentPublisherPort["publish"]>>,
  upload: ValidatedUpload,
): IngestionOutcome {
  let processingLane: ProcessingLane = upload.processingLane;
  if (
    document.documentKind === "pdf" &&
    (document.pageCount ?? 0) > INGESTION_LIMITS.standardDocument.maxStablePages
  ) {
    processingLane = "large";
  }
  if (document.scan.candidatePages.length > 0) {
    return {
      candidatePages: document.scan.candidatePages,
      classification:
        document.scan.classification === "scanned" ? "scanned" : "mixed",
      artifact,
      kind: "ocr_required",
      processingLane: "large",
    };
  }
  return { artifact, kind: "parsed", processingLane };
}

function assertPageWithinLimit(
  document: ReturnType<typeof validateNormalizedDocument>,
): void {
  if (
    document.documentKind === "pdf" &&
    (document.pageCount ?? 0) > INGESTION_LIMITS.largeDocument.maxStablePages
  ) {
    throw new IngestionError("page_limit");
  }
}

function validatePublishedArtifact(
  artifact: Awaited<ReturnType<NormalizedDocumentPublisherPort["publish"]>>,
  document: ReturnType<typeof validateNormalizedDocument>,
): void {
  const serialized = Buffer.from(JSON.stringify(document), "utf8");
  if (
    !isOpaqueId(artifact.artifactId) ||
    artifact.blockCount !== document.blocks.length ||
    artifact.byteLength !== serialized.byteLength ||
    artifact.documentKind !== document.documentKind ||
    artifact.documentSha256 !== sha256(serialized) ||
    artifact.inputSha256 !== document.inputSha256 ||
    artifact.pageCount !== document.pageCount ||
    artifact.parserVersion !== document.parserVersion ||
    artifact.workerImageDigest !== document.workerImageDigest
  ) {
    throw new IngestionError("invalid_output", "published_artifact_mismatch");
  }
}

function validateCommand(command: IngestionCommand): void {
  if (
    !isOpaqueId(command.operationId) ||
    !isOpaqueId(command.ownerScopeId) ||
    !isOpaqueId(command.sourceDocumentId) ||
    !/^[a-f0-9]{64}$/.test(command.expectedInputSha256)
  ) {
    throw new IngestionError("unsupported_type");
  }
}

function assertAuthorizedSource(
  command: IngestionCommand,
  source: AuthorizedQuarantinedSource | null,
): asserts source is AuthorizedQuarantinedSource {
  if (source === null) {
    throw new IngestionError("authorization_denied");
  }
  if (
    source.ownerScopeId !== command.ownerScopeId ||
    source.sourceDocumentId !== command.sourceDocumentId
  ) {
    throw new IngestionError("authorization_denied");
  }
  if (
    source.expectedInputSha256 !== command.expectedInputSha256 ||
    source.retentionState !== "active"
  ) {
    throw new IngestionError(
      source.retentionState === "active"
        ? "hash_mismatch"
        : "retention_blocked",
    );
  }
}

function validateWorkspace(
  workspace: { readonly directory: string; readonly outputDirectory: string },
  operationId: string,
): void {
  if (
    !path.isAbsolute(workspace.directory) ||
    workspace.outputDirectory !== path.join(workspace.directory, "output") ||
    !path.basename(workspace.directory).startsWith(`${operationId}-`)
  ) {
    throw new IngestionError("infrastructure_unavailable");
  }
}

function validateStagedUpload(
  staged: StagedUpload,
  workspace: { readonly directory: string },
): void {
  if (
    staged.inputPath !== path.join(workspace.directory, "source") ||
    !Number.isSafeInteger(staged.byteLength) ||
    staged.byteLength < 1 ||
    staged.byteLength !== staged.bytes.byteLength ||
    !/^[a-f0-9]{64}$/.test(staged.sha256)
  ) {
    throw new IngestionError("hash_mismatch");
  }
}

function validateSnapshot(
  snapshot: MalwareSignatureSnapshot | null,
  now: Date,
): asserts snapshot is MalwareSignatureSnapshot {
  const publishedAt = snapshot?.publishedAt.getTime() ?? Number.NaN;
  const age = now.getTime() - publishedAt;
  if (
    snapshot === null ||
    !snapshot.verified ||
    snapshot.signatureVersion.length < 1 ||
    !Number.isFinite(publishedAt) ||
    age < 0 ||
    age > SCAN_SNAPSHOT_MAX_AGE_MS
  ) {
    throw new IngestionError("scan_db_stale");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isOpaqueId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}
