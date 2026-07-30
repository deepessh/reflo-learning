import { createHash } from "node:crypto";

import {
  FC_SESSION_MAX_CHUNK_BYTES,
  FC_SESSION_PROTOCOL_VERSION,
  type DocumentKind,
  type IngestionFailureCode,
  type ProcessingLane,
} from "./contracts.js";
import { IngestionError } from "./errors.js";

const MAGIC = Buffer.from("REFLOFC1", "ascii");
const PREFIX_BYTES = MAGIC.byteLength + 8;
const MAX_HEADER_BYTES = 16 * 1_024;
export const FC_SESSION_MAX_FRAME_BYTES =
  PREFIX_BYTES + MAX_HEADER_BYTES + FC_SESSION_MAX_CHUNK_BYTES;

export type FunctionSessionHeader =
  | {
      readonly action: "upload";
      readonly chunkSha256: string;
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly documentKind: DocumentKind;
      readonly inputSha256: string;
      readonly operationId: string;
      readonly processingLane: ProcessingLane;
      readonly sequence: number;
      readonly totalBytes: number;
      readonly totalChunks: number;
      readonly workerArtifactDigest: string;
    }
  | {
      readonly action: "parse";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly inputSha256: string;
      readonly operationId: string;
    }
  | {
      readonly action: "download";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly inputSha256: string;
      readonly operationId: string;
      readonly sequence: number;
    }
  | {
      readonly action: "cleanup";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly inputSha256: string;
      readonly operationId: string;
    }
  | {
      readonly action: "inspect";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly inputSha256: string;
      readonly operationId: string;
    }
  | {
      readonly action: "ack";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly phase: "cleanup" | "upload";
      readonly sequence: number;
    }
  | {
      readonly action: "result";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly outputBytes: number;
      readonly outputSha256: string;
      readonly totalChunks: number;
    }
  | {
      readonly action: "chunk";
      readonly chunkSha256: string;
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly outputBytes: number;
      readonly outputSha256: string;
      readonly sequence: number;
      readonly totalChunks: number;
    }
  | {
      readonly action: "failure";
      readonly code: IngestionFailureCode;
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
    }
  | {
      readonly action: "state";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly nextDownloadSequence: number;
      readonly nextUploadSequence: number;
      readonly outputBytes: number;
      readonly outputSha256: string;
      readonly phase: "parsed";
      readonly totalChunks: number;
    }
  | {
      readonly action: "state";
      readonly contractVersion: typeof FC_SESSION_PROTOCOL_VERSION;
      readonly nextUploadSequence: number;
      readonly phase: "uploaded" | "uploading";
    };

export interface FunctionSessionFrame {
  readonly header: FunctionSessionHeader;
  readonly payload: Uint8Array;
}

export function encodeFunctionSessionFrame(
  header: FunctionSessionHeader,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  validateHeader(header, payload);
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw unavailable();
  }
  const frame = Buffer.allocUnsafe(
    PREFIX_BYTES + headerBytes.byteLength + payload.byteLength,
  );
  MAGIC.copy(frame, 0);
  frame.writeUInt32BE(headerBytes.byteLength, MAGIC.byteLength);
  frame.writeUInt32BE(payload.byteLength, MAGIC.byteLength + 4);
  headerBytes.copy(frame, PREFIX_BYTES);
  Buffer.from(payload).copy(frame, PREFIX_BYTES + headerBytes.byteLength);
  return frame;
}

export function decodeFunctionSessionFrame(
  bytes: Uint8Array,
): FunctionSessionFrame {
  const frame = Buffer.from(bytes);
  if (
    frame.byteLength < PREFIX_BYTES ||
    frame.byteLength > FC_SESSION_MAX_FRAME_BYTES ||
    !frame.subarray(0, MAGIC.byteLength).equals(MAGIC)
  ) {
    throw unavailable();
  }
  const headerLength = frame.readUInt32BE(MAGIC.byteLength);
  const payloadLength = frame.readUInt32BE(MAGIC.byteLength + 4);
  if (
    headerLength < 2 ||
    headerLength > MAX_HEADER_BYTES ||
    payloadLength > FC_SESSION_MAX_CHUNK_BYTES ||
    PREFIX_BYTES + headerLength + payloadLength !== frame.byteLength
  ) {
    throw unavailable();
  }
  let header: unknown;
  try {
    header = JSON.parse(
      frame
        .subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength)
        .toString("utf8"),
    );
  } catch {
    throw unavailable();
  }
  const payload = frame.subarray(PREFIX_BYTES + headerLength);
  validateHeader(header, payload);
  return { header, payload };
}

export function functionSessionChunkCount(totalBytes: number): number {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 1 ||
    totalBytes > 512 * 1_024 * 1_024
  ) {
    throw unavailable();
  }
  return Math.ceil(totalBytes / FC_SESSION_MAX_CHUNK_BYTES);
}

export function functionSessionSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateHeader(
  value: unknown,
  payload: Uint8Array,
): asserts value is FunctionSessionHeader {
  if (
    !isRecord(value) ||
    value.contractVersion !== FC_SESSION_PROTOCOL_VERSION ||
    typeof value.action !== "string"
  ) {
    throw unavailable();
  }
  switch (value.action) {
    case "upload":
      requireExactKeys(value, [
        "action",
        "chunkSha256",
        "contractVersion",
        "documentKind",
        "inputSha256",
        "operationId",
        "processingLane",
        "sequence",
        "totalBytes",
        "totalChunks",
        "workerArtifactDigest",
      ]);
      if (
        payload.byteLength < 1 ||
        payload.byteLength > FC_SESSION_MAX_CHUNK_BYTES ||
        !isSha256(value.chunkSha256) ||
        value.chunkSha256 !== functionSessionSha256(payload) ||
        !isSha256(value.inputSha256) ||
        !isOpaqueId(value.operationId) ||
        (value.documentKind !== "pdf" &&
          value.documentKind !== "epub" &&
          value.documentKind !== "docx") ||
        (value.processingLane !== "standard" &&
          value.processingLane !== "large") ||
        !isSequence(value.sequence) ||
        !isTotal(value.totalBytes, 50 * 1_024 * 1_024) ||
        !isTotal(value.totalChunks, 64) ||
        value.sequence >= value.totalChunks ||
        value.totalChunks !== functionSessionChunkCount(value.totalBytes) ||
        !isDigest(value.workerArtifactDigest)
      ) {
        throw unavailable();
      }
      return;
    case "parse":
    case "cleanup":
    case "inspect":
      requireExactKeys(value, [
        "action",
        "contractVersion",
        "inputSha256",
        "operationId",
      ]);
      if (
        payload.byteLength !== 0 ||
        !isSha256(value.inputSha256) ||
        !isOpaqueId(value.operationId)
      ) {
        throw unavailable();
      }
      return;
    case "state":
      if (value.phase === "parsed") {
        requireExactKeys(value, [
          "action",
          "contractVersion",
          "nextDownloadSequence",
          "nextUploadSequence",
          "outputBytes",
          "outputSha256",
          "phase",
          "totalChunks",
        ]);
        if (
          payload.byteLength !== 0 ||
          !isSequence(value.nextDownloadSequence) ||
          !isSequence(value.nextUploadSequence) ||
          !isTotal(value.outputBytes, 512 * 1_024 * 1_024) ||
          !isSha256(value.outputSha256) ||
          !isTotal(value.totalChunks, 64) ||
          value.nextDownloadSequence > value.totalChunks ||
          value.totalChunks !== functionSessionChunkCount(value.outputBytes)
        ) {
          throw unavailable();
        }
        return;
      }
      requireExactKeys(value, [
        "action",
        "contractVersion",
        "nextUploadSequence",
        "phase",
      ]);
      if (
        payload.byteLength !== 0 ||
        (value.phase !== "uploading" && value.phase !== "uploaded") ||
        !isSequence(value.nextUploadSequence)
      ) {
        throw unavailable();
      }
      return;
    case "download":
      requireExactKeys(value, [
        "action",
        "contractVersion",
        "inputSha256",
        "operationId",
        "sequence",
      ]);
      if (
        payload.byteLength !== 0 ||
        !isSha256(value.inputSha256) ||
        !isOpaqueId(value.operationId) ||
        !isSequence(value.sequence)
      ) {
        throw unavailable();
      }
      return;
    case "ack":
      requireExactKeys(value, [
        "action",
        "contractVersion",
        "phase",
        "sequence",
      ]);
      if (
        payload.byteLength !== 0 ||
        (value.phase !== "cleanup" && value.phase !== "upload") ||
        !isSequence(value.sequence)
      ) {
        throw unavailable();
      }
      return;
    case "result":
      requireExactKeys(value, [
        "action",
        "contractVersion",
        "outputBytes",
        "outputSha256",
        "totalChunks",
      ]);
      if (
        payload.byteLength !== 0 ||
        !isTotal(value.outputBytes, 512 * 1_024 * 1_024) ||
        !isSha256(value.outputSha256) ||
        !isTotal(value.totalChunks, 64) ||
        value.totalChunks !== functionSessionChunkCount(value.outputBytes)
      ) {
        throw unavailable();
      }
      return;
    case "chunk":
      requireExactKeys(value, [
        "action",
        "chunkSha256",
        "contractVersion",
        "outputBytes",
        "outputSha256",
        "sequence",
        "totalChunks",
      ]);
      if (
        payload.byteLength < 1 ||
        payload.byteLength > FC_SESSION_MAX_CHUNK_BYTES ||
        !isSha256(value.chunkSha256) ||
        value.chunkSha256 !== functionSessionSha256(payload) ||
        !isTotal(value.outputBytes, 512 * 1_024 * 1_024) ||
        !isSha256(value.outputSha256) ||
        !isSequence(value.sequence) ||
        !isTotal(value.totalChunks, 64) ||
        value.sequence >= value.totalChunks ||
        value.totalChunks !== functionSessionChunkCount(value.outputBytes)
      ) {
        throw unavailable();
      }
      return;
    case "failure":
      requireExactKeys(value, ["action", "code", "contractVersion"]);
      if (
        payload.byteLength !== 0 ||
        typeof value.code !== "string" ||
        !FAILURE_CODES.has(value.code as IngestionFailureCode)
      ) {
        throw unavailable();
      }
      return;
    default:
      throw unavailable();
  }
}

const FAILURE_CODES = new Set<IngestionFailureCode>([
  "active_content",
  "archive_limit",
  "authorization_denied",
  "encrypted",
  "hash_mismatch",
  "infrastructure_unavailable",
  "invalid_output",
  "malformed_document",
  "malware_detected",
  "mime_mismatch",
  "page_limit",
  "parse_oom",
  "parse_timeout",
  "parser_crash",
  "retention_blocked",
  "scan_db_stale",
  "unsupported_type",
]);

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== [...expected].sort()[index])
  ) {
    throw unavailable();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTotal(value: unknown, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= maximum
  );
}

function unavailable(): IngestionError {
  return new IngestionError("infrastructure_unavailable");
}
