import { describe, expect, it } from "vitest";

import { IngestionError } from "./errors.js";
import {
  LOCAL_BRIDGE_MAX_INPUT_BYTES,
  LOCAL_BRIDGE_MAX_OUTPUT_BYTES,
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
  localBridgeLeaseIsCurrent,
  localBridgeLeaseCompletePath,
  localBridgeLeaseInputPath,
  localBridgeLeaseOutputPath,
  parseLocalBridgeCompletion,
  parseLocalBridgeHeartbeat,
  parseLocalBridgeLease,
  parseLocalBridgeOutputMetadata,
} from "./local-bridge-protocol.js";

const LEASE_ID = "a".repeat(48);
const SHA256 = "b".repeat(64);
const DIGEST = `sha256:${"c".repeat(64)}`;

describe("local isolated-ingestion bridge protocol", () => {
  it("accepts one exact available heartbeat with matching Podman runtimes", () => {
    expect(parseLocalBridgeHeartbeat(heartbeat())).toEqual(heartbeat());
    expectFailure({ ...heartbeat(), podmanServerVersion: "6.0.1" });
    expectFailure({ ...heartbeat(), rootless: false });
    expectFailure({ ...heartbeat(), unexpected: true });
  });

  it("accepts one bounded PDF lease and evaluates its expiry", () => {
    const lease = parseLocalBridgeLease(validLease());
    expect(
      localBridgeLeaseIsCurrent(lease, new Date("2026-07-31T18:01:00.000Z")),
    ).toBe(true);
    expect(localBridgeLeaseIsCurrent(lease, new Date(lease.expiresAt))).toBe(
      false,
    );
    expectFailure({ ...validLease(), documentKind: "epub" });
    expectFailure({
      ...validLease(),
      inputBytes: LOCAL_BRIDGE_MAX_INPUT_BYTES + 1,
    });
    expectFailure({ ...validLease(), leaseId: "short" });
    expectFailure({
      ...validLease(),
      expiresAt: "2026-07-31T19:00:01.000Z",
    });
  });

  it("accepts only bounded digest-bound output metadata", () => {
    const metadata = {
      byteLength: LOCAL_BRIDGE_MAX_OUTPUT_BYTES,
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId: LEASE_ID,
      outputSha256: SHA256,
    };
    expect(parseLocalBridgeOutputMetadata(metadata)).toEqual(metadata);
    expectFailure({
      ...metadata,
      byteLength: LOCAL_BRIDGE_MAX_OUTPUT_BYTES + 1,
    });
    expectFailure({ ...metadata, outputSha256: "invalid" });
  });

  it("accepts cleanup-confirmed success or one allowlisted failure only", () => {
    expect(
      parseLocalBridgeCompletion({
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        leaseId: LEASE_ID,
        outcome: "success",
      }),
    ).toMatchObject({ outcome: "success" });
    expect(
      parseLocalBridgeCompletion({
        code: "scan_db_stale",
        contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
        leaseId: LEASE_ID,
        outcome: "failure",
      }),
    ).toMatchObject({ code: "scan_db_stale", outcome: "failure" });
    expectFailure({
      code: "raw_host_error",
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId: LEASE_ID,
      outcome: "failure",
    });
    expectFailure({
      code: "parser_crash",
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      leaseId: LEASE_ID,
      outcome: "success",
    });
  });

  it("constructs only lease-scoped internal transport paths", () => {
    expect(localBridgeLeaseInputPath(LEASE_ID)).toBe(
      `/internal/v1/local-ingestion/leases/${LEASE_ID}/input`,
    );
    expect(localBridgeLeaseOutputPath(LEASE_ID)).toBe(
      `/internal/v1/local-ingestion/leases/${LEASE_ID}/output`,
    );
    expect(localBridgeLeaseCompletePath(LEASE_ID)).toBe(
      `/internal/v1/local-ingestion/leases/${LEASE_ID}/complete`,
    );
    expect(() => localBridgeLeaseInputPath("../escape")).toThrowError(
      IngestionError,
    );
  });
});

function heartbeat() {
  return {
    checkedAt: "2026-07-31T18:00:00.000Z",
    contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
    podmanClientVersion: "5.8.3" as const,
    podmanServerVersion: "5.8.3" as const,
    profile: LOCAL_INGESTION_BRIDGE_PROFILE,
    rootless: true as const,
    scannerSnapshotId: `cvd-${"d".repeat(32)}`,
    status: "available" as const,
    workerImageDigest: DIGEST,
  };
}

function validLease() {
  return {
    contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
    documentKind: "pdf" as const,
    expiresAt: "2026-07-31T18:31:00.000Z",
    inputBytes: LOCAL_BRIDGE_MAX_INPUT_BYTES,
    inputSha256: SHA256,
    leaseId: LEASE_ID,
    leasedAt: "2026-07-31T18:00:00.000Z",
    operationId: "operation-0001",
    processingLane: "large" as const,
    workerImageDigest: DIGEST,
  };
}

function expectFailure(value: unknown): void {
  expect(() => {
    if (typeof value === "object" && value !== null && "checkedAt" in value) {
      parseLocalBridgeHeartbeat(value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      "documentKind" in value
    ) {
      parseLocalBridgeLease(value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      "outputSha256" in value
    ) {
      parseLocalBridgeOutputMetadata(value);
    } else {
      parseLocalBridgeCompletion(value);
    }
  }).toThrowError(IngestionError);
}
