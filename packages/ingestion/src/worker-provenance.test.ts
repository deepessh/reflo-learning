import { describe, expect, it } from "vitest";

import {
  INGESTION_COMPONENTS,
  INGESTION_PROFILE_VERSION,
} from "./contracts.js";
import {
  validateWorkerImageProvenance,
  WORKER_PROVENANCE_CONTRACT,
} from "./worker-provenance.js";

const VALID = {
  baseImage: `registry.example/temurin@sha256:${"a".repeat(64)}`,
  builtAt: "2026-07-21T12:00:00.000Z",
  components: INGESTION_COMPONENTS,
  contractVersion: WORKER_PROVENANCE_CONTRACT,
  evidence: {
    fixtureReportSha256: "b".repeat(64),
    licenseReportSha256: "c".repeat(64),
    sbomSha256: "d".repeat(64),
    vulnerabilityReportSha256: "e".repeat(64),
  },
  imageDigest: `sha256:${"f".repeat(64)}`,
  platform: "linux/amd64",
  profile: INGESTION_PROFILE_VERSION,
  sourceCommit: "1".repeat(40),
  tessdataFastSha256: "2".repeat(64),
} as const;

describe("validateWorkerImageProvenance", () => {
  it("accepts complete immutable build evidence", () => {
    expect(validateWorkerImageProvenance(VALID)).toEqual(VALID);
  });

  it("rejects mutable bases, omitted evidence, and version drift", () => {
    expect(() =>
      validateWorkerImageProvenance({ ...VALID, baseImage: "temurin:17" }),
    ).toThrow();
    expect(() =>
      validateWorkerImageProvenance({
        ...VALID,
        evidence: { ...VALID.evidence, sbomSha256: "missing" },
      }),
    ).toThrow();
    expect(() =>
      validateWorkerImageProvenance({
        ...VALID,
        components: { ...VALID.components, clamAv: "1.4.6" },
      }),
    ).toThrow();
  });
});
