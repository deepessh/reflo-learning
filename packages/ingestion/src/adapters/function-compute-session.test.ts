import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FC_SESSION_MAX_CHUNK_BYTES,
  type WorkerExecutionRequest,
} from "../contracts.js";
import { IngestionError } from "../errors.js";
import {
  decodeFunctionSessionFrame,
  encodeFunctionSessionFrame,
  functionSessionChunkCount,
  functionSessionSha256,
} from "../function-session-protocol.js";
import type { FunctionComputeSessionClientPort } from "../ports.js";
import {
  aliFunctionComputeInternalEndpoint,
  FunctionComputeSessionDocumentWorker,
} from "./function-compute-session.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Ali Function Compute session endpoint", () => {
  it("uses the documented same-region Singapore internal endpoint", () => {
    expect(
      aliFunctionComputeInternalEndpoint({
        accountId: "1234567890123456",
        region: "ap-southeast-1",
      }),
    ).toBe("1234567890123456.ap-southeast-1-internal.fc.aliyuncs.com");
  });

  it("rejects an invalid account identifier", () => {
    expect(() =>
      aliFunctionComputeInternalEndpoint({
        accountId: "not-an-account",
        region: "ap-southeast-1",
      }),
    ).toThrow(IngestionError);
  });
});

describe("FunctionComputeSessionDocumentWorker", () => {
  it("serializes exact 8 MiB upload chunks and deletes the session", async () => {
    const bytes = Buffer.alloc(FC_SESSION_MAX_CHUNK_BYTES + 3, 0x61);
    const request = await workerRequest(bytes);
    const output = Buffer.from(JSON.stringify({ result: "ok" }), "utf8");
    const client = new FakeSessionClient(output);
    const worker = new FunctionComputeSessionDocumentWorker(
      { workerArtifactDigest: `sha256:${"b".repeat(64)}` },
      client,
    );

    await expect(worker.execute(request)).resolves.toEqual({ result: "ok" });
    expect(client.uploadSizes).toEqual([FC_SESSION_MAX_CHUNK_BYTES, 3]);
    expect(client.uploadSequences).toEqual([0, 1]);
    expect(client.activeInvocations).toBe(0);
    expect(client.maximumConcurrentInvocations).toBe(1);
    expect(client.cleanupCount).toBe(1);
    expect(client.deleted).toHaveLength(1);
  });

  it("maps a function failure and still cleans and deletes the session", async () => {
    const request = await workerRequest(Buffer.from("%PDF-fixture", "utf8"));
    const client = new FakeSessionClient(Buffer.from("{}"), "malware_detected");
    const worker = new FunctionComputeSessionDocumentWorker(
      { workerArtifactDigest: `sha256:${"b".repeat(64)}` },
      client,
    );

    await expect(worker.execute(request)).rejects.toMatchObject({
      code: "malware_detected",
    });
    expect(client.cleanupCount).toBe(1);
    expect(client.deleted).toHaveLength(1);
  });

  it("fails a successful parse when explicit deletion is incomplete", async () => {
    const request = await workerRequest(Buffer.from("%PDF-fixture", "utf8"));
    const client = new FakeSessionClient(Buffer.from('{"result":"ok"}'));
    client.failDelete = true;
    const worker = new FunctionComputeSessionDocumentWorker(
      { workerArtifactDigest: `sha256:${"b".repeat(64)}` },
      client,
    );

    await expect(worker.execute(request)).rejects.toMatchObject({
      code: "infrastructure_unavailable",
      sanitizedDetail: "function_session_cleanup_incomplete",
    });
  });

  it("reconciles ambiguous upload, parse, and download calls in the same session", async () => {
    const request = await workerRequest(Buffer.from("%PDF-fixture", "utf8"));
    const client = new FakeSessionClient(Buffer.from('{"result":"ok"}'));
    client.loseUploadResponse = true;
    client.loseParseResponse = true;
    client.loseDownloadResponse = true;
    const worker = new FunctionComputeSessionDocumentWorker(
      { workerArtifactDigest: `sha256:${"b".repeat(64)}` },
      client,
    );

    await expect(worker.execute(request)).resolves.toEqual({ result: "ok" });
    expect(client.inspectCount).toBe(3);
    expect(client.deleted).toHaveLength(1);
  });

  it("rejects an input path whose bytes no longer match the registered hash", async () => {
    const request = await workerRequest(Buffer.from("%PDF-fixture", "utf8"));
    await writeFile(request.inputPath, "changed", { flag: "w" });
    const client = new FakeSessionClient(Buffer.from("{}"));
    const worker = new FunctionComputeSessionDocumentWorker(
      { workerArtifactDigest: `sha256:${"b".repeat(64)}` },
      client,
    );

    await expect(worker.execute(request)).rejects.toMatchObject({
      code: "hash_mismatch",
    });
    expect(client.deleted).toEqual([]);
  });
});

describe("function session binary envelope", () => {
  it("rejects a mutated payload after encoding", () => {
    const payload = Buffer.from("trusted chunk");
    const frame = encodeFunctionSessionFrame(
      {
        action: "upload",
        chunkSha256: functionSessionSha256(payload),
        contractVersion: "serverless-isolated-ingestion-session-v1",
        documentKind: "pdf",
        inputSha256: "a".repeat(64),
        operationId: "operation_123",
        processingLane: "standard",
        sequence: 0,
        totalBytes: payload.byteLength,
        totalChunks: 1,
        workerArtifactDigest: `sha256:${"b".repeat(64)}`,
      },
      payload,
    );
    frame[frame.byteLength - 1] ^= 1;

    expect(() => decodeFunctionSessionFrame(frame)).toThrow(IngestionError);
  });

  it("rejects trailing bytes outside the declared frame", () => {
    const frame = encodeFunctionSessionFrame({
      action: "parse",
      contractVersion: "serverless-isolated-ingestion-session-v1",
      inputSha256: "a".repeat(64),
      operationId: "operation_123",
    });

    expect(() =>
      decodeFunctionSessionFrame(Buffer.concat([frame, Buffer.from([0])])),
    ).toThrow(IngestionError);
  });
});

class FakeSessionClient implements FunctionComputeSessionClientPort {
  activeInvocations = 0;
  cleanupCount = 0;
  deleted: string[] = [];
  failDelete = false;
  inspectCount = 0;
  loseDownloadResponse = false;
  loseParseResponse = false;
  loseUploadResponse = false;
  maximumConcurrentInvocations = 0;
  nextDownloadSequence = 0;
  parsed = false;
  totalUploadChunks = 0;
  uploadSequences: number[] = [];
  uploadSizes: number[] = [];

  constructor(
    private readonly output: Uint8Array,
    private readonly parseFailure?: "malware_detected",
  ) {}

  sessionId = "";

  async createSession(sessionId: string) {
    this.sessionId = sessionId;
    return { sessionId };
  }

  async deleteSession(sessionId: string) {
    this.deleted.push(sessionId);
    if (this.failDelete) {
      throw new Error("delete failed");
    }
  }

  async invoke(sessionId: string, request: Uint8Array) {
    expect(sessionId).toBe(this.sessionId);
    this.activeInvocations += 1;
    this.maximumConcurrentInvocations = Math.max(
      this.maximumConcurrentInvocations,
      this.activeInvocations,
    );
    try {
      const frame = decodeFunctionSessionFrame(request);
      switch (frame.header.action) {
        case "upload":
          this.uploadSequences.push(frame.header.sequence);
          this.uploadSizes.push(frame.payload.byteLength);
          this.totalUploadChunks = frame.header.totalChunks;
          if (this.loseUploadResponse) {
            this.loseUploadResponse = false;
            throw new Error("ambiguous upload response");
          }
          return encodeFunctionSessionFrame({
            action: "ack",
            contractVersion: "serverless-isolated-ingestion-session-v1",
            phase: "upload",
            sequence: frame.header.sequence,
          });
        case "parse":
          if (this.parseFailure !== undefined) {
            return encodeFunctionSessionFrame({
              action: "failure",
              code: this.parseFailure,
              contractVersion: "serverless-isolated-ingestion-session-v1",
            });
          }
          this.parsed = true;
          if (this.loseParseResponse) {
            this.loseParseResponse = false;
            throw new Error("ambiguous parse response");
          }
          return encodeFunctionSessionFrame({
            action: "result",
            contractVersion: "serverless-isolated-ingestion-session-v1",
            outputBytes: this.output.byteLength,
            outputSha256: functionSessionSha256(this.output),
            totalChunks: functionSessionChunkCount(this.output.byteLength),
          });
        case "download": {
          const start = frame.header.sequence * FC_SESSION_MAX_CHUNK_BYTES;
          const payload = this.output.subarray(
            start,
            Math.min(
              start + FC_SESSION_MAX_CHUNK_BYTES,
              this.output.byteLength,
            ),
          );
          this.nextDownloadSequence = Math.max(
            this.nextDownloadSequence,
            frame.header.sequence + 1,
          );
          if (this.loseDownloadResponse) {
            this.loseDownloadResponse = false;
            throw new Error("ambiguous download response");
          }
          return encodeFunctionSessionFrame(
            {
              action: "chunk",
              chunkSha256: functionSessionSha256(payload),
              contractVersion: "serverless-isolated-ingestion-session-v1",
              outputBytes: this.output.byteLength,
              outputSha256: functionSessionSha256(this.output),
              sequence: frame.header.sequence,
              totalChunks: functionSessionChunkCount(this.output.byteLength),
            },
            payload,
          );
        }
        case "cleanup":
          this.cleanupCount += 1;
          return encodeFunctionSessionFrame({
            action: "ack",
            contractVersion: "serverless-isolated-ingestion-session-v1",
            phase: "cleanup",
            sequence: 0,
          });
        case "inspect":
          this.inspectCount += 1;
          if (this.parsed) {
            return encodeFunctionSessionFrame({
              action: "state",
              contractVersion: "serverless-isolated-ingestion-session-v1",
              nextDownloadSequence: this.nextDownloadSequence,
              nextUploadSequence: this.uploadSequences.length,
              outputBytes: this.output.byteLength,
              outputSha256: functionSessionSha256(this.output),
              phase: "parsed",
              totalChunks: functionSessionChunkCount(this.output.byteLength),
            });
          }
          return encodeFunctionSessionFrame({
            action: "state",
            contractVersion: "serverless-isolated-ingestion-session-v1",
            nextUploadSequence: this.uploadSequences.length,
            phase:
              this.uploadSequences.length === this.totalUploadChunks
                ? "uploaded"
                : "uploading",
          });
        default:
          throw new Error("unexpected request");
      }
    } finally {
      this.activeInvocations -= 1;
    }
  }
}

async function workerRequest(
  bytes: Uint8Array,
): Promise<WorkerExecutionRequest> {
  const directory = await mkdtemp(path.join(tmpdir(), "reflo-fc-worker-"));
  created.push(directory);
  const inputPath = path.join(directory, "source");
  await writeFile(inputPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    documentKind: "pdf",
    inputPath,
    inputSha256: functionSessionSha256(bytes),
    operationId: "operation_123",
    outputDirectory: path.join(directory, "output"),
    processingLane: "standard",
  };
}
