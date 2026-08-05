import { describe, expect, it } from "vitest";

import { LOCAL_INGESTION_BRIDGE_PROFILE } from "@reflo/ingestion";

import { readLocalIngestionBridgeConfiguration } from "./config.js";

const digest = `sha256:${"a".repeat(64)}`;
const scannerDigest = `sha256:${"b".repeat(64)}`;
const snapshotId = `cvd-${"c".repeat(32)}`;

const valid: NodeJS.ProcessEnv = {
  REFLO_DEMO_UPLOAD_MALWARE_SCANNER_MODE: "upstream-clamav-cloud-demo-v1",
  REFLO_LOCAL_CLAMAV_ADMISSION_DATABASE_DIR: `/private/tmp/${snapshotId}`,
  REFLO_LOCAL_CLAMAV_DATABASE_DIR: "/private/tmp/reflo-clam-database",
  REFLO_LOCAL_CLAMAV_MANIFEST_PATH: `/private/tmp/${snapshotId}/manifest.json`,
  REFLO_LOCAL_CLAMAV_SCANNER_IMAGE: `clamav/clamav@${scannerDigest}`,
  REFLO_LOCAL_CLAMAV_SNAPSHOT_ID: snapshotId,
  REFLO_LOCAL_INGESTION_BRIDGE_API_ORIGIN: "http://127.0.0.1:53001",
  REFLO_LOCAL_INGESTION_BRIDGE_TOKEN: "t".repeat(48),
  REFLO_LOCAL_INGESTION_BRIDGE_PROFILE: LOCAL_INGESTION_BRIDGE_PROFILE,
  REFLO_LOCAL_INGESTION_BRIDGE_WORKSPACE_ROOT:
    "/private/tmp/reflo-ingestion-bridge",
  REFLO_LOCAL_INGESTION_IMAGE: "reflo-ingestion-worker:local",
  REFLO_LOCAL_INGESTION_IMAGE_DIGEST: digest,
  REFLO_LOCAL_TESSDATA_DIR: "/private/tmp/reflo-tessdata",
};

describe("local ingestion bridge configuration", () => {
  it("accepts the exact operator profile and loopback boundary", () => {
    expect(readLocalIngestionBridgeConfiguration(valid)).toMatchObject({
      apiOrigin: new URL("http://127.0.0.1:53001"),
      pollIntervalMs: 1_000,
      workerImageDigest: digest,
    });
  });

  it.each([
    [
      "non-loopback API",
      { REFLO_LOCAL_INGESTION_BRIDGE_API_ORIGIN: "http://0.0.0.0:53001" },
    ],
    [
      "credential-bearing API",
      {
        REFLO_LOCAL_INGESTION_BRIDGE_API_ORIGIN:
          "http://user:pass@127.0.0.1:53001",
      },
    ],
    [
      "wrong profile",
      { REFLO_LOCAL_INGESTION_BRIDGE_PROFILE: "development-only" },
    ],
    ["short token", { REFLO_LOCAL_INGESTION_BRIDGE_TOKEN: "secret" }],
    [
      "mismatched snapshot path",
      { REFLO_LOCAL_CLAMAV_MANIFEST_PATH: "/private/tmp/other/manifest.json" },
    ],
  ])("rejects %s without disclosing the invalid value", (_name, changed) => {
    expect(() =>
      readLocalIngestionBridgeConfiguration({ ...valid, ...changed }),
    ).toThrow("local ingestion bridge configuration is invalid");
  });
});
