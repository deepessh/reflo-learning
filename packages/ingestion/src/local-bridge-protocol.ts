import {
  INGESTION_LIMITS,
  type IngestionFailureCode,
  type ProcessingLane,
} from "./contracts.js";
import { IngestionError } from "./errors.js";

export const LOCAL_INGESTION_BRIDGE_VERSION =
  "local-isolated-ingestion-bridge-v1" as const;
export const LOCAL_INGESTION_BRIDGE_PROFILE =
  "operator-hosted-connected-demo-v1" as const;
export const LOCAL_BRIDGE_MAX_INPUT_BYTES =
  INGESTION_LIMITS.largeDocument.maxBytes;
export const LOCAL_BRIDGE_MAX_OUTPUT_BYTES =
  INGESTION_LIMITS.normalizedOutputBytes;
export const LOCAL_BRIDGE_LEASE_ID_PATTERN = /^[a-f0-9]{48}$/;
export const LOCAL_BRIDGE_HTTP = Object.freeze({
  contractHeader: "x-reflo-ingestion-contract",
  heartbeatPath: "/internal/v1/local-ingestion/heartbeat",
  inputSha256Header: "x-reflo-input-sha256",
  leasePath: "/internal/v1/local-ingestion/lease",
  outputSha256Header: "x-reflo-output-sha256",
});

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_LEASE_DURATION_MS =
  INGESTION_LIMITS.largeDocument.wallTimeMs + 60_000;
const PODMAN_VERSIONS = new Set(["5.8.3", "6.0.1"] as const);
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

export type LocalBridgePodmanVersion = "5.8.3" | "6.0.1";

export interface LocalBridgeHeartbeat {
  readonly checkedAt: string;
  readonly contractVersion: typeof LOCAL_INGESTION_BRIDGE_VERSION;
  readonly podmanClientVersion: LocalBridgePodmanVersion;
  readonly podmanServerVersion: LocalBridgePodmanVersion;
  readonly profile: typeof LOCAL_INGESTION_BRIDGE_PROFILE;
  readonly rootless: true;
  readonly scannerSnapshotId: string;
  readonly status: "available";
  readonly workerImageDigest: string;
}

export interface LocalBridgeLease {
  readonly contractVersion: typeof LOCAL_INGESTION_BRIDGE_VERSION;
  readonly documentKind: "pdf";
  readonly expiresAt: string;
  readonly inputBytes: number;
  readonly inputSha256: string;
  readonly leaseId: string;
  readonly leasedAt: string;
  readonly operationId: string;
  readonly processingLane: ProcessingLane;
  readonly workerImageDigest: string;
}

export interface LocalBridgeOutputMetadata {
  readonly byteLength: number;
  readonly contractVersion: typeof LOCAL_INGESTION_BRIDGE_VERSION;
  readonly leaseId: string;
  readonly outputSha256: string;
}

export type LocalBridgeCompletion =
  | {
      readonly contractVersion: typeof LOCAL_INGESTION_BRIDGE_VERSION;
      readonly leaseId: string;
      readonly outcome: "success";
    }
  | {
      readonly code: IngestionFailureCode;
      readonly contractVersion: typeof LOCAL_INGESTION_BRIDGE_VERSION;
      readonly leaseId: string;
      readonly outcome: "failure";
    };

export function localBridgeLeaseInputPath(leaseId: string): string {
  return leaseActionPath(leaseId, "input");
}

export function localBridgeLeaseOutputPath(leaseId: string): string {
  return leaseActionPath(leaseId, "output");
}

export function localBridgeLeaseCompletePath(leaseId: string): string {
  return leaseActionPath(leaseId, "complete");
}

export function parseLocalBridgeHeartbeat(
  value: unknown,
): LocalBridgeHeartbeat {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "checkedAt",
      "contractVersion",
      "podmanClientVersion",
      "podmanServerVersion",
      "profile",
      "rootless",
      "scannerSnapshotId",
      "status",
      "workerImageDigest",
    ]) ||
    value.contractVersion !== LOCAL_INGESTION_BRIDGE_VERSION ||
    value.profile !== LOCAL_INGESTION_BRIDGE_PROFILE ||
    value.status !== "available" ||
    value.rootless !== true ||
    !isPodmanVersion(value.podmanClientVersion) ||
    value.podmanServerVersion !== value.podmanClientVersion ||
    !isCanonicalTimestamp(value.checkedAt) ||
    !isSnapshotId(value.scannerSnapshotId) ||
    !isDigest(value.workerImageDigest)
  ) {
    throw unavailable();
  }
  return value as unknown as LocalBridgeHeartbeat;
}

export function parseLocalBridgeLease(value: unknown): LocalBridgeLease {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "documentKind",
      "expiresAt",
      "inputBytes",
      "inputSha256",
      "leaseId",
      "leasedAt",
      "operationId",
      "processingLane",
      "workerImageDigest",
    ]) ||
    value.contractVersion !== LOCAL_INGESTION_BRIDGE_VERSION ||
    value.documentKind !== "pdf" ||
    !isCanonicalTimestamp(value.leasedAt) ||
    !isCanonicalTimestamp(value.expiresAt) ||
    !isTotal(value.inputBytes, LOCAL_BRIDGE_MAX_INPUT_BYTES) ||
    !isSha256(value.inputSha256) ||
    !isLeaseId(value.leaseId) ||
    !isOpaqueId(value.operationId) ||
    (value.processingLane !== "standard" && value.processingLane !== "large") ||
    !isDigest(value.workerImageDigest)
  ) {
    throw unavailable();
  }
  const leasedAt = Date.parse(value.leasedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= leasedAt || expiresAt - leasedAt > MAX_LEASE_DURATION_MS) {
    throw unavailable();
  }
  return value as unknown as LocalBridgeLease;
}

export function localBridgeLeaseIsCurrent(
  lease: LocalBridgeLease,
  now = new Date(),
): boolean {
  const checkedAt = now.getTime();
  const leasedAt = Date.parse(lease.leasedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  return (
    Number.isFinite(checkedAt) &&
    leasedAt <= checkedAt + MAX_CLOCK_SKEW_MS &&
    checkedAt < expiresAt
  );
}

export function parseLocalBridgeOutputMetadata(
  value: unknown,
): LocalBridgeOutputMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "byteLength",
      "contractVersion",
      "leaseId",
      "outputSha256",
    ]) ||
    value.contractVersion !== LOCAL_INGESTION_BRIDGE_VERSION ||
    !isTotal(value.byteLength, LOCAL_BRIDGE_MAX_OUTPUT_BYTES) ||
    !isLeaseId(value.leaseId) ||
    !isSha256(value.outputSha256)
  ) {
    throw unavailable();
  }
  return value as unknown as LocalBridgeOutputMetadata;
}

export function parseLocalBridgeCompletion(
  value: unknown,
): LocalBridgeCompletion {
  if (
    !isRecord(value) ||
    value.contractVersion !== LOCAL_INGESTION_BRIDGE_VERSION ||
    !isLeaseId(value.leaseId)
  ) {
    throw unavailable();
  }
  if (
    value.outcome === "success" &&
    hasExactKeys(value, ["contractVersion", "leaseId", "outcome"])
  ) {
    return value as unknown as LocalBridgeCompletion;
  }
  if (
    value.outcome === "failure" &&
    hasExactKeys(value, ["code", "contractVersion", "leaseId", "outcome"]) &&
    typeof value.code === "string" &&
    FAILURE_CODES.has(value.code as IngestionFailureCode)
  ) {
    return value as unknown as LocalBridgeCompletion;
  }
  throw unavailable();
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isPodmanVersion(value: unknown): value is LocalBridgePodmanVersion {
  return (
    typeof value === "string" &&
    PODMAN_VERSIONS.has(value as LocalBridgePodmanVersion)
  );
}

function isSnapshotId(value: unknown): value is string {
  return typeof value === "string" && /^cvd-[a-f0-9]{32}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isLeaseId(value: unknown): value is string {
  return typeof value === "string" && LOCAL_BRIDGE_LEASE_ID_PATTERN.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
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

function leaseActionPath(
  leaseId: string,
  action: "complete" | "input" | "output",
): string {
  if (!LOCAL_BRIDGE_LEASE_ID_PATTERN.test(leaseId)) {
    throw unavailable();
  }
  return `/internal/v1/local-ingestion/leases/${leaseId}/${action}`;
}
