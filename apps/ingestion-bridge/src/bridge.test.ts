import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
  NodeEphemeralWorkspace,
  type LocalBridgeCompletion,
  type LocalBridgeHeartbeat,
  type LocalBridgeLease,
} from "@reflo/ingestion";
import { describe, expect, it } from "vitest";

import {
  LocalIngestionBridge,
  type LocalIngestionBridgeApiPort,
  type LocalIngestionBridgeEvent,
} from "./bridge.js";

const now = new Date("2026-07-31T18:00:00.000Z");
const input = Buffer.from("%PDF-1.7\nsynthetic fixture\n", "utf8");
const inputSha256 = sha256(input);
const imageDigest = `sha256:${"d".repeat(64)}`;

const heartbeat: LocalBridgeHeartbeat = {
  checkedAt: now.toISOString(),
  contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
  podmanClientVersion: "6.0.1",
  podmanServerVersion: "6.0.1",
  profile: LOCAL_INGESTION_BRIDGE_PROFILE,
  rootless: true,
  scannerSnapshotId: `cvd-${"e".repeat(32)}`,
  status: "available",
  workerImageDigest: imageDigest,
};

const lease: LocalBridgeLease = {
  contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
  documentKind: "pdf",
  expiresAt: "2026-07-31T18:02:00.000Z",
  inputBytes: input.byteLength,
  inputSha256,
  leaseId: "f".repeat(48),
  leasedAt: "2026-07-31T17:59:59.000Z",
  operationId: "operation_216_fixture",
  processingLane: "standard",
  workerImageDigest: imageDigest,
};

describe("local ingestion bridge", () => {
  it("logs availability transitions without emitting one event per idle poll", async () => {
    const controller = new AbortController();
    const events: LocalIngestionBridgeEvent[] = [];
    let checks = 0;
    const bridge = new LocalIngestionBridge({
      api: {
        complete: async () => undefined,
        heartbeat: async () => undefined,
        lease: async () => null,
        putOutput: async () => undefined,
      },
      logger: { event: (event) => events.push(event) },
      readiness: {
        check: async () => {
          checks += 1;
          if (checks < 3) throw new Error("unavailable");
          controller.abort();
          return heartbeat;
        },
      },
      scanner: cleanScanner(),
      worker: { execute: async () => undefined },
      workspaces: {
        create: async () => {
          throw new Error("no lease expected");
        },
        cleanup: async () => undefined,
      },
    });

    await bridge.run(controller.signal, 1);
    expect(events).toEqual(["poll_failed", "bridge_available"]);
  });

  it("scans, runs the isolated worker, uploads validated output, cleans, then completes", async () => {
    const root = await workspaceRoot();
    const events: string[] = [];
    let workspaceDirectory = "";
    const api = new FakeApi(events, async () => {
      expect(workspaceDirectory).not.toBe("");
      await expect(readFile(workspaceDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    const bridge = new LocalIngestionBridge({
      api,
      clock: { now: () => now },
      logger: { event: (event) => events.push(`log:${event}`) },
      readiness: {
        check: async () => {
          events.push("ready");
          return heartbeat;
        },
      },
      scanner: {
        currentSnapshot: async () => {
          events.push("snapshot");
          return {
            publishedAt: new Date("2026-07-31T17:30:00.000Z"),
            signatureVersion: heartbeat.scannerSnapshotId,
            verified: true,
          };
        },
        scan: async (staged) => {
          events.push("scan");
          expect(staged.byteLength).toBe(input.byteLength);
          expect(await readFile(staged.inputPath)).toEqual(input);
          workspaceDirectory = path.dirname(staged.inputPath);
          return { clean: true };
        },
      },
      worker: {
        execute: async (request) => {
          events.push("worker");
          const document = normalizedDocument();
          await writeFile(
            path.join(request.outputDirectory, "normalized-document.json"),
            JSON.stringify(document),
            { mode: 0o600 },
          );
          return document;
        },
      },
      workspaces: new NodeEphemeralWorkspace(root),
    });

    await expect(bridge.runOnce()).resolves.toBe("completed");
    expect(api.completion).toEqual({
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId: lease.leaseId,
      outcome: "success",
    });
    expect(events).toEqual([
      "ready",
      "heartbeat",
      "log:bridge_available",
      "lease",
      "snapshot",
      "scan",
      "worker",
      "output",
      "complete",
      "log:lease_completed",
    ]);
    expect(JSON.parse(api.output.toString("utf8"))).toEqual(
      normalizedDocument(),
    );
  });

  it("cleans before reporting a malware failure and never runs or uploads", async () => {
    const root = await workspaceRoot();
    const events: string[] = [];
    let workspaceDirectory = "";
    const api = new FakeApi(events, async () => {
      await expect(readFile(workspaceDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    const bridge = new LocalIngestionBridge({
      api,
      clock: { now: () => now },
      logger: { event: (event) => events.push(`log:${event}`) },
      readiness: { check: async () => heartbeat },
      scanner: {
        currentSnapshot: async () => ({
          publishedAt: now,
          signatureVersion: heartbeat.scannerSnapshotId,
          verified: true,
        }),
        scan: async (staged) => {
          workspaceDirectory = path.dirname(staged.inputPath);
          return { clean: false };
        },
      },
      worker: {
        execute: async () => {
          throw new Error("worker must not run");
        },
      },
      workspaces: new NodeEphemeralWorkspace(root),
    });

    await expect(bridge.runOnce()).resolves.toBe("failed");
    expect(api.output).toHaveLength(0);
    expect(api.completion).toMatchObject({
      code: "malware_detected",
      outcome: "failure",
    });
  });

  it("never reports success when cleanup fails after output receipt", async () => {
    const events: LocalIngestionBridgeEvent[] = [];
    const api = new FakeApi([]);
    const base = await workspaceRoot();
    const workspaces = new NodeEphemeralWorkspace(base);
    const bridge = new LocalIngestionBridge({
      api,
      clock: { now: () => now },
      logger: { event: (event) => events.push(event) },
      readiness: { check: async () => heartbeat },
      scanner: cleanScanner(),
      worker: {
        execute: async (request) => {
          const document = normalizedDocument();
          await writeFile(
            path.join(request.outputDirectory, "normalized-document.json"),
            JSON.stringify(document),
          );
          return document;
        },
      },
      workspaces: {
        create: (operationId) => workspaces.create(operationId),
        cleanup: async () => {
          throw new Error("sensitive path intentionally omitted");
        },
      },
    });

    await expect(bridge.runOnce()).resolves.toBe("failed");
    expect(api.completion).toMatchObject({
      code: "infrastructure_unavailable",
      outcome: "failure",
    });
    expect(events).toEqual([
      "bridge_available",
      "lease_failed",
    ] satisfies LocalIngestionBridgeEvent[]);
  });
});

class FakeApi implements LocalIngestionBridgeApiPort {
  completion: LocalBridgeCompletion | undefined;
  output = Buffer.alloc(0);

  constructor(
    private readonly events: string[],
    private readonly beforeComplete?: () => Promise<void>,
  ) {}

  async heartbeat(): Promise<void> {
    this.events.push("heartbeat");
  }

  async lease() {
    this.events.push("lease");
    return {
      lease,
      source: (async function* () {
        yield input.subarray(0, 7);
        yield input.subarray(7);
      })(),
    };
  }

  async putOutput(
    _lease: LocalBridgeLease,
    metadata: { readonly byteLength: number; readonly outputSha256: string },
    output: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    this.events.push("output");
    const chunks: Uint8Array[] = [];
    for await (const chunk of output) chunks.push(chunk);
    this.output = Buffer.concat(chunks);
    expect(this.output.byteLength).toBe(metadata.byteLength);
    expect(sha256(this.output)).toBe(metadata.outputSha256);
  }

  async complete(completion: LocalBridgeCompletion): Promise<void> {
    await this.beforeComplete?.();
    this.events.push("complete");
    this.completion = completion;
  }
}

function cleanScanner() {
  return {
    currentSnapshot: async () => ({
      publishedAt: now,
      signatureVersion: heartbeat.scannerSnapshotId,
      verified: true as const,
    }),
    scan: async () => ({ clean: true }),
  };
}

function normalizedDocument() {
  const text = "Synthetic fixture content.";
  return {
    blocks: [
      {
        canonicalEnd: text.length,
        canonicalStart: 0,
        kind: "paragraph",
        locator: { kind: "pdf", page: 1, sectionPath: [] },
        order: 0,
        text,
        textSha256: sha256(text),
      },
    ],
    classifierVersion: "scan-detect-v1",
    configVersion: "isolated-ingestion-v1",
    contractVersion: "normalized-document-v1",
    diagnostics: ["digital_text_preserved"],
    documentKind: "pdf",
    inputSha256,
    pageCount: 1,
    parserVersion: "apache-tika-3.3.1",
    scan: { candidatePages: [], classification: "digital", rasterDpi: 300 },
    workerImageDigest: imageDigest,
  } as const;
}

async function workspaceRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "reflo-bridge-test-"));
  const root = path.join(parent, "workspaces");
  await mkdir(root, { mode: 0o700 });
  return root;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
