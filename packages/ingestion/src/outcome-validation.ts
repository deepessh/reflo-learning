import {
  INGESTION_COMPONENTS,
  type IngestionFailureCode,
  type IngestionOutcome,
  type NormalizedDocumentArtifact,
} from "./contracts.js";
import { IngestionError } from "./errors.js";

const FAILURE_CODES: ReadonlySet<IngestionFailureCode> = new Set([
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

export function validateIngestionOutcome(value: unknown): IngestionOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    invalid();
  }
  if (value.kind === "failed") {
    if (!hasExactKeys(value, ["failure", "kind"]) || !isRecord(value.failure)) {
      invalid();
    }
    const failure = value.failure;
    const keys = Object.keys(failure);
    if (
      (keys.length !== 2 && keys.length !== 3) ||
      !keys.includes("code") ||
      !keys.includes("retryable") ||
      (keys.length === 3 && !keys.includes("sanitizedDetail")) ||
      typeof failure.code !== "string" ||
      !FAILURE_CODES.has(failure.code as IngestionFailureCode) ||
      failure.retryable !== (failure.code === "infrastructure_unavailable") ||
      (failure.sanitizedDetail !== undefined &&
        (typeof failure.sanitizedDetail !== "string" ||
          !/^[a-z0-9_]{1,128}$/.test(failure.sanitizedDetail)))
    ) {
      invalid();
    }
    return value as unknown as IngestionOutcome;
  }
  if (value.kind === "parsed") {
    if (
      !hasExactKeys(value, ["artifact", "kind", "processingLane"]) ||
      (value.processingLane !== "standard" && value.processingLane !== "large")
    ) {
      invalid();
    }
    validateArtifact(value.artifact);
    return value as unknown as IngestionOutcome;
  }
  if (value.kind === "ocr_required") {
    if (
      !hasExactKeys(value, [
        "artifact",
        "candidatePages",
        "classification",
        "kind",
        "processingLane",
      ]) ||
      value.processingLane !== "large" ||
      (value.classification !== "mixed" &&
        value.classification !== "scanned") ||
      !Array.isArray(value.candidatePages)
    ) {
      invalid();
    }
    const artifact = validateArtifact(value.artifact);
    if (artifact.documentKind !== "pdf" || artifact.pageCount === null) {
      invalid();
    }
    let previous = 0;
    for (const page of value.candidatePages) {
      if (
        !Number.isSafeInteger(page) ||
        (page as number) <= previous ||
        (page as number) > artifact.pageCount
      ) {
        invalid();
      }
      previous = page as number;
    }
    const ratio = value.candidatePages.length / artifact.pageCount;
    if (
      value.candidatePages.length === 0 ||
      ratio >= 0.8 !== (value.classification === "scanned")
    ) {
      invalid();
    }
    return value as unknown as IngestionOutcome;
  }
  invalid();
}

function validateArtifact(value: unknown): NormalizedDocumentArtifact {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "artifactId",
      "blockCount",
      "byteLength",
      "documentKind",
      "documentSha256",
      "inputSha256",
      "pageCount",
      "parserVersion",
      "workerImageDigest",
    ]) ||
    typeof value.artifactId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(value.artifactId) ||
    !Number.isSafeInteger(value.blockCount) ||
    (value.blockCount as number) < 0 ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    (value.documentKind !== "pdf" &&
      value.documentKind !== "epub" &&
      value.documentKind !== "docx") ||
    typeof value.documentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.documentSha256) ||
    typeof value.inputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.inputSha256) ||
    value.parserVersion !== INGESTION_COMPONENTS.parser ||
    typeof value.workerImageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.workerImageDigest) ||
    (value.documentKind === "pdf"
      ? !Number.isSafeInteger(value.pageCount) ||
        (value.pageCount as number) < 1
      : value.pageCount !== null)
  ) {
    invalid();
  }
  return value as unknown as NormalizedDocumentArtifact;
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

function invalid(): never {
  throw new IngestionError("infrastructure_unavailable");
}
