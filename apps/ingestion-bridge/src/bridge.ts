import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import {
  IngestionError,
  LOCAL_BRIDGE_MAX_INPUT_BYTES,
  LOCAL_BRIDGE_MAX_OUTPUT_BYTES,
  LOCAL_INGESTION_BRIDGE_VERSION,
  localBridgeLeaseIsCurrent,
  normalizeIngestionFailure,
  validateNormalizedDocument,
  type EphemeralWorkspacePort,
  type IngestionFailureCode,
  type IngestionWorkspace,
  type IsolatedDocumentWorkerPort,
  type LocalBridgeCompletion,
  type LocalBridgeHeartbeat,
  type LocalBridgeLease,
  type LocalBridgeOutputMetadata,
  type MalwareScannerPort,
  type StagedUpload,
} from "@reflo/ingestion";

export interface BridgeLeaseInput {
  readonly lease: LocalBridgeLease;
  readonly source: AsyncIterable<Uint8Array>;
}

export interface LocalIngestionBridgeApiPort {
  complete(completion: LocalBridgeCompletion): Promise<void>;
  heartbeat(heartbeat: LocalBridgeHeartbeat): Promise<void>;
  lease(heartbeat: LocalBridgeHeartbeat): Promise<BridgeLeaseInput | null>;
  putOutput(
    lease: LocalBridgeLease,
    metadata: LocalBridgeOutputMetadata,
    output: AsyncIterable<Uint8Array>,
  ): Promise<void>;
}

export interface LocalIngestionHostReadinessPort {
  check(): Promise<LocalBridgeHeartbeat>;
}

export type LocalIngestionBridgeEvent =
  "bridge_available" | "lease_completed" | "lease_failed" | "poll_failed";

export interface LocalIngestionBridgeLogger {
  event(event: LocalIngestionBridgeEvent): void;
}

export interface LocalIngestionBridgeDependencies {
  readonly api: LocalIngestionBridgeApiPort;
  readonly clock?: { now(): Date };
  readonly logger: LocalIngestionBridgeLogger;
  readonly readiness: LocalIngestionHostReadinessPort;
  readonly scanner: MalwareScannerPort;
  readonly worker: IsolatedDocumentWorkerPort;
  readonly workspaces: EphemeralWorkspacePort;
}

export class LocalIngestionBridge {
  readonly #dependencies: LocalIngestionBridgeDependencies;
  #availability: "available" | "failed" | "initial" = "initial";

  constructor(dependencies: LocalIngestionBridgeDependencies) {
    this.#dependencies = dependencies;
  }

  async runOnce(): Promise<"completed" | "failed" | "idle"> {
    const heartbeat = await this.#dependencies.readiness.check();
    await this.#dependencies.api.heartbeat(heartbeat);
    if (this.#availability !== "available") {
      this.#dependencies.logger.event("bridge_available");
      this.#availability = "available";
    }
    const claimed = await this.#dependencies.api.lease(heartbeat);
    if (claimed === null) {
      return "idle";
    }
    if (
      claimed.lease.workerImageDigest !== heartbeat.workerImageDigest ||
      !localBridgeLeaseIsCurrent(claimed.lease, this.#now())
    ) {
      await claimed.source[Symbol.asyncIterator]().return?.();
      throw new IngestionError("infrastructure_unavailable");
    }
    return this.#process(claimed);
  }

  async run(signal: AbortSignal, pollIntervalMs: number): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch {
        if (this.#availability !== "failed") {
          this.#dependencies.logger.event("poll_failed");
          this.#availability = "failed";
        }
      }
      if (!signal.aborted) {
        await abortableDelay(pollIntervalMs, signal);
      }
    }
  }

  async #process(claimed: BridgeLeaseInput): Promise<"completed" | "failed"> {
    let workspace: IngestionWorkspace | undefined;
    let failure: IngestionFailureCode | undefined;
    let outputAccepted = false;
    try {
      workspace = await this.#dependencies.workspaces.create(
        claimed.lease.operationId,
      );
      const staged = await stageLeaseInput(claimed, workspace);
      if (!localBridgeLeaseIsCurrent(claimed.lease, this.#now())) {
        throw new IngestionError("infrastructure_unavailable");
      }
      const snapshot = await this.#dependencies.scanner.currentSnapshot();
      if (snapshot === null || !snapshot.verified) {
        throw new IngestionError("scan_db_stale");
      }
      const scan = await this.#dependencies.scanner.scan(staged, snapshot);
      if (!scan.clean) {
        throw new IngestionError("malware_detected");
      }
      const untrusted = await this.#dependencies.worker.execute({
        documentKind: claimed.lease.documentKind,
        inputPath: staged.inputPath,
        inputSha256: claimed.lease.inputSha256,
        operationId: claimed.lease.operationId,
        outputDirectory: workspace.outputDirectory,
        processingLane: claimed.lease.processingLane,
      });
      validateNormalizedDocument(untrusted, {
        documentKind: claimed.lease.documentKind,
        inputSha256: claimed.lease.inputSha256,
      });
      if (!localBridgeLeaseIsCurrent(claimed.lease, this.#now())) {
        throw new IngestionError("infrastructure_unavailable");
      }
      const outputPath = path.join(
        workspace.outputDirectory,
        "normalized-document.json",
      );
      const metadata = await inspectOutput(outputPath, claimed.lease.leaseId);
      await this.#dependencies.api.putOutput(
        claimed.lease,
        metadata,
        readRegularFile(outputPath, LOCAL_BRIDGE_MAX_OUTPUT_BYTES),
      );
      outputAccepted = true;
    } catch (error) {
      failure = normalizeIngestionFailure(error).code;
    }

    if (workspace !== undefined) {
      try {
        await this.#dependencies.workspaces.cleanup(workspace);
      } catch {
        failure = "infrastructure_unavailable";
      }
    } else {
      failure ??= "infrastructure_unavailable";
    }

    if (
      failure === undefined &&
      outputAccepted &&
      localBridgeLeaseIsCurrent(claimed.lease, this.#now())
    ) {
      await this.#dependencies.api.complete({
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        leaseId: claimed.lease.leaseId,
        outcome: "success",
      });
      this.#dependencies.logger.event("lease_completed");
      return "completed";
    }

    await this.#dependencies.api.complete({
      code: failure ?? "infrastructure_unavailable",
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId: claimed.lease.leaseId,
      outcome: "failure",
    });
    this.#dependencies.logger.event("lease_failed");
    return "failed";
  }

  #now(): Date {
    return this.#dependencies.clock?.now() ?? new Date();
  }
}

async function stageLeaseInput(
  claimed: BridgeLeaseInput,
  workspace: IngestionWorkspace,
): Promise<StagedUpload> {
  if (
    claimed.lease.inputBytes < 1 ||
    claimed.lease.inputBytes > LOCAL_BRIDGE_MAX_INPUT_BYTES
  ) {
    throw new IngestionError("hash_mismatch");
  }
  const inputPath = path.join(workspace.directory, "source");
  const handle = await open(
    inputPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    for await (const value of claimed.source) {
      const chunk = Buffer.from(value);
      byteLength += chunk.byteLength;
      if (
        byteLength > claimed.lease.inputBytes ||
        byteLength > LOCAL_BRIDGE_MAX_INPUT_BYTES
      ) {
        throw new IngestionError("hash_mismatch");
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError("infrastructure_unavailable");
  } finally {
    await handle.close().catch(() => undefined);
  }
  const sha256 = hash.digest("hex");
  if (
    byteLength !== claimed.lease.inputBytes ||
    sha256 !== claimed.lease.inputSha256
  ) {
    throw new IngestionError("hash_mismatch");
  }
  return {
    byteLength,
    bytes: new Uint8Array(0),
    inputPath,
    sha256,
  };
}

async function inspectOutput(
  outputPath: string,
  leaseId: string,
): Promise<LocalBridgeOutputMetadata> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of readRegularFile(
    outputPath,
    LOCAL_BRIDGE_MAX_OUTPUT_BYTES,
  )) {
    byteLength += chunk.byteLength;
    hash.update(chunk);
  }
  if (byteLength < 1) {
    throw new IngestionError("invalid_output");
  }
  return {
    byteLength,
    contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
    leaseId,
    outputSha256: hash.digest("hex"),
  };
}

async function* readRegularFile(
  filePath: string,
  maximumBytes: number,
): AsyncGenerator<Uint8Array> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => {
    throw new IngestionError("invalid_output");
  });
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new IngestionError("invalid_output");
    }
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      yield new Uint8Array(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError("invalid_output");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (result.bytesWritten < 1) {
      throw new IngestionError("infrastructure_unavailable");
    }
    offset += result.bytesWritten;
  }
}
