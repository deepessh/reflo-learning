import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IngestionError } from "@reflo/ingestion";

import {
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
  LocalIngestionBridgeBroker,
  LocalIngestionBridgeError,
} from "./local-ingestion-bridge";

const temporaryDirectories: string[] = [];
const token = "local-bridge-test-token-1234567890abcdef";
const leaseId = "1".repeat(48);
const scannerSnapshotId = `cvd-${"1".repeat(32)}`;
const workerImageDigest = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalIngestionBridgeBroker", () => {
  it("streams one host lease and resolves only after matching output completion", async () => {
    const fixture = await workerFixture();
    const broker = createBroker();
    broker.heartbeat(heartbeat());
    const execution = broker.execute(fixture.request);

    const lease = await broker.lease();

    expect(lease).toMatchObject({
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      documentKind: "pdf",
      inputBytes: fixture.input.byteLength,
      inputSha256: fixture.inputSha256,
      leaseId,
      operationId: "bridge-operation-0001",
      processingLane: "standard",
    });
    expect(JSON.stringify(lease)).not.toContain(fixture.root);
    const input = broker.input(leaseId);
    expect(Buffer.from(await streamBytes(input.stream))).toEqual(fixture.input);
    expect(await broker.lease()).toBeNull();

    const normalized = Buffer.from(
      JSON.stringify({
        contractVersion: "normalized-document-v1",
        blocks: [],
      }),
    );
    await broker.stageOutput(leaseId, chunks(normalized), {
      byteLength: normalized.byteLength,
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId,
      outputSha256: sha256(normalized),
    });
    let settled = false;
    void execution.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await broker.complete(leaseId, {
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId,
      outcome: "success",
    });

    await expect(execution).resolves.toEqual({
      blocks: [],
      contractVersion: "normalized-document-v1",
    });
    await expect(
      readFile(
        path.join(fixture.outputDirectory, `.local-bridge-${leaseId}.json`),
      ),
    ).rejects.toThrow();
    await broker.close();
  });

  it("authenticates bearer material without exposing it and validates heartbeat identity", () => {
    const broker = createBroker();

    expect(broker.authorize(`Bearer ${token}`)).toBe(true);
    expect(broker.authorize(`Bearer ${token}x`)).toBe(false);
    expect(broker.authorize(undefined)).toBe(false);
    expect(broker.available()).toBe(false);
    broker.heartbeat(heartbeat());
    expect(broker.available()).toBe(true);
    expect(() =>
      broker.heartbeat({ ...heartbeat(), podmanServerVersion: "6.0.2" }),
    ).toThrow("heartbeat_invalid");
    expect(() =>
      broker.heartbeat({
        ...heartbeat(),
        workerImageDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("heartbeat_invalid");
  });

  it("rejects mismatched output and late or cross-lease completion", async () => {
    const fixture = await workerFixture();
    const broker = createBroker();
    broker.heartbeat(heartbeat());
    const execution = broker.execute(fixture.request);
    await broker.lease();
    const normalized = Buffer.from("{}");

    await expect(
      broker.stageOutput(leaseId, chunks(normalized), {
        byteLength: normalized.byteLength,
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        leaseId,
        outputSha256: "2".repeat(64),
      }),
    ).rejects.toThrow("output_invalid");
    await expect(
      broker.complete("3".repeat(48), {
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        code: "parser_crash",
        leaseId: "3".repeat(48),
        outcome: "failure",
      }),
    ).rejects.toThrow("lease_not_current");

    await broker.complete(leaseId, {
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      code: "parser_crash",
      leaseId,
      outcome: "failure",
    });
    await expect(execution).rejects.toMatchObject<Partial<IngestionError>>({
      code: "parser_crash",
    });
    await expect(
      broker.complete(leaseId, {
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        code: "parser_crash",
        leaseId,
        outcome: "failure",
      }),
    ).rejects.toBeInstanceOf(LocalIngestionBridgeError);
    await broker.close();
  });

  it("requires a current heartbeat before leasing queued work", async () => {
    const fixture = await workerFixture();
    let now = Date.parse("2026-07-31T12:00:00.000Z");
    const broker = new LocalIngestionBridgeBroker({
      bearerToken: token,
      clock: () => new Date(now),
      expectedProfile: LOCAL_INGESTION_BRIDGE_PROFILE,
      expectedScannerSnapshotId: scannerSnapshotId,
      expectedWorkerImageDigest: workerImageDigest,
      heartbeatTtlMs: 1_000,
      leaseDurationMs: 1_000,
      newLeaseId: () => leaseId,
    });
    broker.heartbeat(heartbeat());
    const execution = broker.execute(fixture.request);
    now += 1_001;
    await expect(broker.lease()).rejects.toThrow("heartbeat_stale");

    await broker.close();
    await expect(execution).rejects.toMatchObject<Partial<IngestionError>>({
      code: "infrastructure_unavailable",
    });
  });

  it("rejects execution immediately when no current heartbeat is available", async () => {
    const fixture = await workerFixture();
    const broker = createBroker();

    await expect(broker.execute(fixture.request)).rejects.toMatchObject<
      Partial<IngestionError>
    >({
      code: "infrastructure_unavailable",
      sanitizedDetail: "local_bridge_heartbeat_unavailable",
    });

    broker.heartbeat(heartbeat());
    await expect(broker.lease()).resolves.toBeNull();
    await broker.close();
  });

  it("expires unleased work when the current heartbeat disappears", async () => {
    vi.useFakeTimers();
    const fixture = await workerFixture();
    let now = Date.parse("2026-07-31T12:00:00.000Z");
    const broker = new LocalIngestionBridgeBroker({
      bearerToken: token,
      clock: () => new Date(now),
      expectedProfile: LOCAL_INGESTION_BRIDGE_PROFILE,
      expectedScannerSnapshotId: scannerSnapshotId,
      expectedWorkerImageDigest: workerImageDigest,
      heartbeatTtlMs: 1_000,
      leaseDurationMs: 1_000,
      newLeaseId: () => leaseId,
    });
    broker.heartbeat(heartbeat());
    const execution = broker.execute(fixture.request);
    const rejected = expect(execution).rejects.toMatchObject<
      Partial<IngestionError>
    >({
      code: "infrastructure_unavailable",
      sanitizedDetail: "local_bridge_queue_expired",
    });

    now += 1_001;
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    broker.heartbeat(heartbeat());
    await expect(broker.lease()).resolves.toBeNull();
    await broker.close();
  });
});

function createBroker(): LocalIngestionBridgeBroker {
  return new LocalIngestionBridgeBroker({
    bearerToken: token,
    expectedProfile: LOCAL_INGESTION_BRIDGE_PROFILE,
    expectedScannerSnapshotId: scannerSnapshotId,
    expectedWorkerImageDigest: workerImageDigest,
    heartbeatTtlMs: 10_000,
    leaseDurationMs: 10_000,
    newLeaseId: () => leaseId,
  });
}

function heartbeat() {
  return {
    checkedAt: "2026-07-31T12:00:00.000Z",
    contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
    podmanClientVersion: "6.0.1",
    podmanServerVersion: "6.0.1",
    profile: LOCAL_INGESTION_BRIDGE_PROFILE,
    rootless: true as const,
    scannerSnapshotId,
    status: "available" as const,
    workerImageDigest,
  };
}

async function workerFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "reflo-local-bridge-test-"));
  temporaryDirectories.push(root);
  const input = Buffer.from("%PDF-1.7\nrights-cleared-test\n");
  const inputPath = path.join(root, "source");
  const outputDirectory = path.join(root, "output");
  await mkdir(outputDirectory, { mode: 0o700 });
  await writeFile(inputPath, input, { mode: 0o400 });
  return {
    input,
    inputSha256: sha256(input),
    outputDirectory,
    request: {
      documentKind: "pdf" as const,
      inputPath,
      inputSha256: sha256(input),
      operationId: "bridge-operation-0001",
      outputDirectory,
      processingLane: "standard" as const,
    },
    root,
  };
}

async function* chunks(value: Uint8Array) {
  const midpoint = Math.ceil(value.byteLength / 2);
  yield value.slice(0, midpoint);
  yield value.slice(midpoint);
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
