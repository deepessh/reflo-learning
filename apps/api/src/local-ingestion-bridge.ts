import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  IngestionError,
  INGESTION_LIMITS,
  LOCAL_BRIDGE_LEASE_ID_PATTERN,
  LOCAL_BRIDGE_MAX_INPUT_BYTES,
  LOCAL_BRIDGE_MAX_OUTPUT_BYTES,
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
  type LocalBridgeHeartbeat,
  type LocalBridgeLease,
  type LocalBridgeOutputMetadata,
  type IsolatedDocumentWorkerPort,
  type WorkerExecutionRequest,
  localBridgeLeaseIsCurrent,
  parseLocalBridgeCompletion,
  parseLocalBridgeHeartbeat,
  parseLocalBridgeLease,
  parseLocalBridgeOutputMetadata as validateLocalBridgeOutputMetadata,
} from "@reflo/ingestion";

export {
  LOCAL_BRIDGE_MAX_INPUT_BYTES,
  LOCAL_BRIDGE_MAX_OUTPUT_BYTES,
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
} from "@reflo/ingestion";

const SHA256 = /^[a-f0-9]{64}$/;

export interface LocalIngestionBridgeApi {
  authorize(header: string | undefined): boolean;
  available(): boolean;
  complete(leaseId: string, value: unknown): Promise<void>;
  heartbeat(value: unknown): LocalBridgeHeartbeat;
  lease(): Promise<LocalBridgeLease | null>;
  input(leaseId: string): {
    readonly byteLength: number;
    readonly inputSha256: string;
    readonly stream: ReadStream;
  };
  stageOutput(
    leaseId: string,
    source: AsyncIterable<Uint8Array | string>,
    metadata: LocalBridgeOutputMetadata,
  ): Promise<void>;
}

export type LocalIngestionBridge = IsolatedDocumentWorkerPort &
  LocalIngestionBridgeApi & { close(): Promise<void> };

interface QueuedExecution {
  admissionTimer?: NodeJS.Timeout;
  readonly reject: (error: unknown) => void;
  readonly request: WorkerExecutionRequest;
  readonly resolve: (value: unknown) => void;
}

interface ActiveLease extends QueuedExecution {
  readonly lease: LocalBridgeLease;
  readonly leaseId: string;
  readonly timer: NodeJS.Timeout;
  stagedOutput?: {
    readonly byteLength: number;
    readonly path: string;
    readonly sha256: string;
  };
}

export class LocalIngestionBridgeError extends Error {
  constructor(
    readonly code:
      | "bridge_closed"
      | "heartbeat_invalid"
      | "heartbeat_stale"
      | "lease_invalid"
      | "lease_not_current"
      | "output_invalid"
      | "output_missing",
  ) {
    super(code);
    this.name = "LocalIngestionBridgeError";
  }
}

export class LocalIngestionBridgeBroker implements LocalIngestionBridge {
  readonly #clock: () => Date;
  readonly #heartbeatTtlMs: number;
  readonly #leaseDurationMs: number;
  readonly #newLeaseId: () => string;
  readonly #expectedProfile: typeof LOCAL_INGESTION_BRIDGE_PROFILE;
  readonly #expectedScannerSnapshotId: string;
  readonly #expectedWorkerImageDigest: string;
  readonly #tokenDigest: Buffer;
  readonly #queue: QueuedExecution[] = [];
  #active: ActiveLease | undefined;
  #closed = false;
  #heartbeatAtMs: number | undefined;
  #heartbeatValue: LocalBridgeHeartbeat | undefined;

  constructor(options: {
    readonly bearerToken: string;
    readonly clock?: () => Date;
    readonly expectedProfile: typeof LOCAL_INGESTION_BRIDGE_PROFILE;
    readonly expectedScannerSnapshotId: string;
    readonly expectedWorkerImageDigest: string;
    readonly heartbeatTtlMs?: number;
    readonly leaseDurationMs?: number;
    readonly newLeaseId?: () => string;
  }) {
    if (
      options.bearerToken.length < 32 ||
      options.bearerToken.length > 256 ||
      /\s/.test(options.bearerToken)
    ) {
      throw new Error("local ingestion bridge token is invalid");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#expectedProfile = options.expectedProfile;
    this.#expectedScannerSnapshotId = options.expectedScannerSnapshotId;
    this.#expectedWorkerImageDigest = options.expectedWorkerImageDigest;
    this.#heartbeatTtlMs = options.heartbeatTtlMs ?? 15_000;
    this.#leaseDurationMs = options.leaseDurationMs ?? 120_000;
    this.#newLeaseId =
      options.newLeaseId ?? (() => randomBytes(24).toString("hex"));
    this.#tokenDigest = tokenDigest(options.bearerToken);
    if (
      !Number.isSafeInteger(this.#heartbeatTtlMs) ||
      this.#heartbeatTtlMs < 1_000 ||
      this.#heartbeatTtlMs > 300_000 ||
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 1_000 ||
      this.#leaseDurationMs > INGESTION_LIMITS.largeDocument.wallTimeMs ||
      this.#expectedProfile !== LOCAL_INGESTION_BRIDGE_PROFILE ||
      !/^cvd-[a-f0-9]{32}$/.test(this.#expectedScannerSnapshotId) ||
      !/^sha256:[a-f0-9]{64}$/.test(this.#expectedWorkerImageDigest)
    ) {
      throw new Error("local ingestion bridge timing is invalid");
    }
  }

  authorize(header: string | undefined): boolean {
    const candidate =
      header?.startsWith("Bearer ") === true ? header.slice(7) : "";
    return timingSafeEqual(this.#tokenDigest, tokenDigest(candidate));
  }

  available(): boolean {
    return (
      !this.#closed &&
      this.#heartbeatValue !== undefined &&
      this.#heartbeatAtMs !== undefined &&
      this.#clock().getTime() - this.#heartbeatAtMs <= this.#heartbeatTtlMs
    );
  }

  execute(request: WorkerExecutionRequest): Promise<unknown> {
    assertWorkerRequest(request);
    if (this.#closed) {
      return Promise.reject(new IngestionError("infrastructure_unavailable"));
    }
    if (!this.available()) {
      return Promise.reject(
        new IngestionError(
          "infrastructure_unavailable",
          "local_bridge_heartbeat_unavailable",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const queued: QueuedExecution = {
        reject,
        request,
        resolve,
      };
      const heartbeatAtMs = this.#heartbeatAtMs!;
      const remainingHeartbeatMs = Math.max(
        1,
        Math.min(
          this.#heartbeatTtlMs,
          heartbeatAtMs + this.#heartbeatTtlMs - this.#clock().getTime(),
        ),
      );
      queued.admissionTimer = setTimeout(() => {
        this.#expireQueued(queued);
      }, remainingHeartbeatMs);
      queued.admissionTimer.unref();
      this.#queue.push(queued);
    });
  }

  heartbeat(value: unknown): LocalBridgeHeartbeat {
    if (this.#closed) {
      throw new LocalIngestionBridgeError("bridge_closed");
    }
    let heartbeat: LocalBridgeHeartbeat;
    try {
      heartbeat = parseLocalBridgeHeartbeat(value);
    } catch {
      throw new LocalIngestionBridgeError("heartbeat_invalid");
    }
    if (
      heartbeat.profile !== this.#expectedProfile ||
      heartbeat.scannerSnapshotId !== this.#expectedScannerSnapshotId ||
      heartbeat.workerImageDigest !== this.#expectedWorkerImageDigest
    ) {
      throw new LocalIngestionBridgeError("heartbeat_invalid");
    }
    this.#heartbeatAtMs = this.#clock().getTime();
    this.#heartbeatValue = heartbeat;
    return heartbeat;
  }

  async lease(): Promise<LocalBridgeLease | null> {
    if (this.#closed) {
      throw new LocalIngestionBridgeError("bridge_closed");
    }
    this.#assertCurrentHeartbeat();
    if (this.#active !== undefined) {
      return null;
    }
    const queued = this.#queue.shift();
    if (queued === undefined) {
      return null;
    }
    clearTimeout(queued.admissionTimer);
    let input: Awaited<ReturnType<typeof lstat>>;
    try {
      input = await lstat(queued.request.inputPath);
    } catch {
      queued.reject(
        new IngestionError(
          "infrastructure_unavailable",
          "local_bridge_input_unavailable",
        ),
      );
      throw new LocalIngestionBridgeError("lease_invalid");
    }
    if (
      !input.isFile() ||
      input.isSymbolicLink() ||
      input.size < 1 ||
      input.size > LOCAL_BRIDGE_MAX_INPUT_BYTES
    ) {
      queued.reject(new IngestionError("infrastructure_unavailable"));
      throw new LocalIngestionBridgeError("lease_invalid");
    }
    const leaseId = this.#newLeaseId();
    if (!LOCAL_BRIDGE_LEASE_ID_PATTERN.test(leaseId)) {
      queued.reject(new IngestionError("infrastructure_unavailable"));
      throw new LocalIngestionBridgeError("lease_invalid");
    }
    const leasedAt = this.#clock();
    const expiresAtMs = leasedAt.getTime() + this.#leaseDurationMs;
    const timer = setTimeout(() => {
      void this.#expire(leaseId);
    }, this.#leaseDurationMs);
    timer.unref();
    let lease: LocalBridgeLease;
    try {
      lease = parseLocalBridgeLease({
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        documentKind: queued.request.documentKind,
        expiresAt: new Date(expiresAtMs).toISOString(),
        inputBytes: input.size,
        inputSha256: queued.request.inputSha256,
        leaseId,
        leasedAt: leasedAt.toISOString(),
        operationId: queued.request.operationId,
        processingLane: queued.request.processingLane,
        workerImageDigest: this.#heartbeatValue!.workerImageDigest,
      });
    } catch {
      clearTimeout(timer);
      queued.reject(new IngestionError("infrastructure_unavailable"));
      throw new LocalIngestionBridgeError("lease_invalid");
    }
    this.#active = { ...queued, lease, leaseId, timer };
    return lease;
  }

  input(leaseId: string): {
    readonly byteLength: number;
    readonly inputSha256: string;
    readonly stream: ReadStream;
  } {
    const active = this.#currentLease(leaseId);
    return {
      byteLength: active.lease.inputBytes,
      inputSha256: active.lease.inputSha256,
      stream: createReadStream(active.request.inputPath),
    };
  }

  async stageOutput(
    leaseId: string,
    source: AsyncIterable<Uint8Array | string>,
    metadata: LocalBridgeOutputMetadata,
  ): Promise<void> {
    const active = this.#currentLease(leaseId);
    let validated: LocalBridgeOutputMetadata;
    try {
      validated = validateLocalBridgeOutputMetadata(metadata);
    } catch {
      throw new LocalIngestionBridgeError("output_invalid");
    }
    if (active.stagedOutput !== undefined || validated.leaseId !== leaseId) {
      throw new LocalIngestionBridgeError("output_invalid");
    }
    const outputPath = path.join(
      active.request.outputDirectory,
      `.local-bridge-${leaseId}.json`,
    );
    const handle = await open(outputPath, "wx", 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      for await (const chunk of source) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        byteLength += bytes.byteLength;
        if (
          byteLength > validated.byteLength ||
          byteLength > LOCAL_BRIDGE_MAX_OUTPUT_BYTES
        ) {
          throw new LocalIngestionBridgeError("output_invalid");
        }
        hash.update(bytes);
        await handle.writeFile(bytes);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(outputPath, { force: true });
      throw error;
    }
    await handle.close();
    const actualSha256 = hash.digest("hex");
    if (
      byteLength !== validated.byteLength ||
      actualSha256 !== validated.outputSha256
    ) {
      await rm(outputPath, { force: true });
      throw new LocalIngestionBridgeError("output_invalid");
    }
    active.stagedOutput = {
      byteLength,
      path: outputPath,
      sha256: actualSha256,
    };
  }

  async complete(leaseId: string, value: unknown): Promise<void> {
    const active = this.#currentLease(leaseId);
    let completion: ReturnType<typeof parseLocalBridgeCompletion>;
    try {
      completion = parseLocalBridgeCompletion(value);
    } catch {
      throw new LocalIngestionBridgeError("output_invalid");
    }
    if (completion.leaseId !== leaseId) {
      throw new LocalIngestionBridgeError("lease_not_current");
    }
    clearTimeout(active.timer);
    this.#active = undefined;
    if (completion.outcome === "failure") {
      await removeStagedOutput(active);
      active.reject(new IngestionError(completion.code));
      return;
    }
    if (active.stagedOutput === undefined) {
      active.reject(new IngestionError("invalid_output"));
      throw new LocalIngestionBridgeError("output_missing");
    }
    try {
      const raw = await readFile(active.stagedOutput.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      await removeStagedOutput(active);
      active.resolve(parsed);
    } catch {
      await removeStagedOutput(active);
      active.reject(new IngestionError("invalid_output"));
      throw new LocalIngestionBridgeError("output_invalid");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failure = new IngestionError("infrastructure_unavailable");
    for (const queued of this.#queue.splice(0)) {
      clearTimeout(queued.admissionTimer);
      queued.reject(failure);
    }
    const active = this.#active;
    this.#active = undefined;
    if (active !== undefined) {
      clearTimeout(active.timer);
      await removeStagedOutput(active);
      active.reject(failure);
    }
  }

  #assertCurrentHeartbeat(): void {
    if (!this.available()) {
      throw new LocalIngestionBridgeError("heartbeat_stale");
    }
  }

  #currentLease(leaseId: string): ActiveLease {
    if (
      !LOCAL_BRIDGE_LEASE_ID_PATTERN.test(leaseId) ||
      this.#active?.leaseId !== leaseId ||
      !localBridgeLeaseIsCurrent(this.#active.lease, this.#clock())
    ) {
      throw new LocalIngestionBridgeError("lease_not_current");
    }
    return this.#active;
  }

  async #expire(leaseId: string): Promise<void> {
    if (this.#active?.leaseId !== leaseId) return;
    const active = this.#active;
    this.#active = undefined;
    await removeStagedOutput(active);
    active.reject(
      new IngestionError(
        "infrastructure_unavailable",
        "local_bridge_lease_expired",
      ),
    );
  }

  #expireQueued(queued: QueuedExecution): void {
    const index = this.#queue.indexOf(queued);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    clearTimeout(queued.admissionTimer);
    queued.reject(
      new IngestionError(
        "infrastructure_unavailable",
        "local_bridge_queue_expired",
      ),
    );
  }
}

export function localBridgeOutputMetadataFromHeaders(
  leaseId: string,
  input: {
    readonly contentLength: string | undefined;
    readonly sha256: string | undefined;
  },
): LocalBridgeOutputMetadata {
  if (
    input.contentLength === undefined ||
    !/^\d+$/.test(input.contentLength) ||
    input.sha256 === undefined ||
    !SHA256.test(input.sha256)
  ) {
    throw new LocalIngestionBridgeError("output_invalid");
  }
  const byteLength = Number(input.contentLength);
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 2 ||
    byteLength > LOCAL_BRIDGE_MAX_OUTPUT_BYTES
  ) {
    throw new LocalIngestionBridgeError("output_invalid");
  }
  try {
    return validateLocalBridgeOutputMetadata({
      byteLength,
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId,
      outputSha256: input.sha256,
    });
  } catch {
    throw new LocalIngestionBridgeError("output_invalid");
  }
}

function assertWorkerRequest(request: WorkerExecutionRequest): void {
  if (
    !path.isAbsolute(request.inputPath) ||
    !path.isAbsolute(request.outputDirectory) ||
    !SHA256.test(request.inputSha256) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(request.operationId) ||
    request.documentKind !== "pdf" ||
    !["standard", "large"].includes(request.processingLane)
  ) {
    throw new Error("local ingestion bridge request is invalid");
  }
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function removeStagedOutput(active: ActiveLease): Promise<void> {
  if (active.stagedOutput !== undefined) {
    await rm(active.stagedOutput.path, { force: true });
    active.stagedOutput = undefined;
  }
}
