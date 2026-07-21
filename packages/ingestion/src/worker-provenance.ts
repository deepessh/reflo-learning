import {
  INGESTION_COMPONENTS,
  INGESTION_PROFILE_VERSION,
} from "./contracts.js";
import { IngestionError } from "./errors.js";

export const WORKER_PROVENANCE_CONTRACT =
  "isolated-ingestion-worker-provenance-v1" as const;

export interface WorkerImageProvenance {
  readonly baseImage: string;
  readonly builtAt: string;
  readonly components: typeof INGESTION_COMPONENTS;
  readonly contractVersion: typeof WORKER_PROVENANCE_CONTRACT;
  readonly evidence: {
    readonly fixtureReportSha256: string;
    readonly licenseReportSha256: string;
    readonly sbomSha256: string;
    readonly vulnerabilityReportSha256: string;
  };
  readonly imageDigest: string;
  readonly platform: "linux/amd64";
  readonly profile: typeof INGESTION_PROFILE_VERSION;
  readonly sourceCommit: string;
  readonly tessdataFastSha256: string;
}

export function validateWorkerImageProvenance(
  value: unknown,
): WorkerImageProvenance {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "baseImage",
      "builtAt",
      "components",
      "contractVersion",
      "evidence",
      "imageDigest",
      "platform",
      "profile",
      "sourceCommit",
      "tessdataFastSha256",
    ]) ||
    value.contractVersion !== WORKER_PROVENANCE_CONTRACT ||
    value.profile !== INGESTION_PROFILE_VERSION ||
    value.platform !== "linux/amd64" ||
    typeof value.imageDigest !== "string" ||
    !DIGEST.test(value.imageDigest) ||
    typeof value.baseImage !== "string" ||
    !IMAGE_REFERENCE.test(value.baseImage) ||
    typeof value.builtAt !== "string" ||
    !isCanonicalUtc(value.builtAt) ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    typeof value.tessdataFastSha256 !== "string" ||
    !SHA256.test(value.tessdataFastSha256) ||
    !isRecord(value.components) ||
    !hasExactKeys(value.components, [
      "clamAv",
      "ociRuntime",
      "ocrEngine",
      "ocrLanguage",
      "parser",
    ]) ||
    Object.entries(INGESTION_COMPONENTS).some(
      ([name, version]) =>
        (value.components as Record<string, unknown>)[name] !== version,
    ) ||
    !isRecord(value.evidence) ||
    !hasExactKeys(value.evidence, [
      "fixtureReportSha256",
      "licenseReportSha256",
      "sbomSha256",
      "vulnerabilityReportSha256",
    ]) ||
    Object.values(value.evidence).some(
      (digest) => typeof digest !== "string" || !SHA256.test(digest),
    )
  ) {
    throw new IngestionError("infrastructure_unavailable");
  }
  return value as unknown as WorkerImageProvenance;
}

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

function isCanonicalUtc(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
