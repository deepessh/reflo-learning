import path from "node:path";

import {
  CLAMAV_UPSTREAM_SNAPSHOT_PROFILE,
  LOCAL_INGESTION_BRIDGE_PROFILE,
} from "@reflo/ingestion";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^cvd-[a-f0-9]{32}$/;
const IMAGE_REFERENCE =
  /^(?:reflo-ingestion-worker:local|[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64})$/;

export interface LocalIngestionBridgeConfiguration {
  readonly admissionDatabaseDirectory: string;
  readonly apiOrigin: URL;
  readonly bearerToken: string;
  readonly clamDatabaseDirectory: string;
  readonly clamManifestPath: string;
  readonly clamSnapshotId: string;
  readonly pollIntervalMs: number;
  readonly scannerImage: string;
  readonly tessdataDirectory: string;
  readonly workerImageDigest: string;
  readonly workerImageReference: string;
  readonly workspaceRoot: string;
}

export function readLocalIngestionBridgeConfiguration(
  input: NodeJS.ProcessEnv,
): LocalIngestionBridgeConfiguration {
  if (
    required(input, "REFLO_LOCAL_INGESTION_BRIDGE_PROFILE") !==
    LOCAL_INGESTION_BRIDGE_PROFILE
  ) {
    invalid();
  }
  if (
    required(input, "REFLO_DEMO_UPLOAD_MALWARE_SCANNER_MODE") !==
    CLAMAV_UPSTREAM_SNAPSHOT_PROFILE
  ) {
    invalid();
  }
  const apiOrigin = loopbackOrigin(
    required(input, "REFLO_LOCAL_INGESTION_BRIDGE_API_ORIGIN"),
  );
  const bearerToken = required(input, "REFLO_LOCAL_INGESTION_BRIDGE_TOKEN");
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(bearerToken)) {
    invalid();
  }
  const workerImageDigest = required(
    input,
    "REFLO_LOCAL_INGESTION_IMAGE_DIGEST",
  );
  const workerImageReference = required(input, "REFLO_LOCAL_INGESTION_IMAGE");
  const scannerImage = required(input, "REFLO_LOCAL_CLAMAV_SCANNER_IMAGE");
  const clamSnapshotId = required(input, "REFLO_LOCAL_CLAMAV_SNAPSHOT_ID");
  if (
    !SHA256.test(workerImageDigest) ||
    !IMAGE_REFERENCE.test(workerImageReference) ||
    !/.+@sha256:[a-f0-9]{64}$/.test(scannerImage) ||
    !SNAPSHOT_ID.test(clamSnapshotId)
  ) {
    invalid();
  }
  const referencedDigest = workerImageReference.match(
    /@(sha256:[a-f0-9]{64})$/,
  )?.[1];
  if (
    referencedDigest !== undefined &&
    referencedDigest !== workerImageDigest
  ) {
    invalid();
  }

  const admissionDatabaseDirectory = absolute(
    input,
    "REFLO_LOCAL_CLAMAV_ADMISSION_DATABASE_DIR",
  );
  const clamManifestPath = absolute(input, "REFLO_LOCAL_CLAMAV_MANIFEST_PATH");
  if (
    path.dirname(clamManifestPath) !== admissionDatabaseDirectory ||
    path.basename(admissionDatabaseDirectory) !== clamSnapshotId
  ) {
    invalid();
  }
  return {
    admissionDatabaseDirectory,
    apiOrigin,
    bearerToken,
    clamDatabaseDirectory: absolute(input, "REFLO_LOCAL_CLAMAV_DATABASE_DIR"),
    clamManifestPath,
    clamSnapshotId,
    pollIntervalMs: boundedInteger(
      input.REFLO_LOCAL_INGESTION_BRIDGE_POLL_INTERVAL_MS ?? "1000",
      250,
      10_000,
    ),
    scannerImage,
    tessdataDirectory: absolute(input, "REFLO_LOCAL_TESSDATA_DIR"),
    workerImageDigest,
    workerImageReference,
    workspaceRoot: absolute(
      input,
      "REFLO_LOCAL_INGESTION_BRIDGE_WORKSPACE_ROOT",
    ),
  };
}

function loopbackOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === ""
  ) {
    invalid();
  }
  return parsed;
}

function absolute(input: NodeJS.ProcessEnv, key: string): string {
  const value = required(input, key);
  const resolved = path.resolve(value);
  if (
    !path.isAbsolute(value) ||
    resolved === path.parse(resolved).root ||
    path.basename(resolved).length < 4
  ) {
    invalid();
  }
  return resolved;
}

function boundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^[0-9]+$/.test(value)) {
    invalid();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid();
  }
  return parsed;
}

function required(input: NodeJS.ProcessEnv, key: string): string {
  const value = input[key]?.trim();
  if (value === undefined || value === "") {
    invalid();
  }
  return value;
}

function invalid(): never {
  throw new Error("local ingestion bridge configuration is invalid");
}
