import { createHash } from "node:crypto";

import {
  INGESTION_COMPONENTS,
  INGESTION_LIMITS,
  INGESTION_PROFILE_VERSION,
  NORMALIZED_DOCUMENT_VERSION,
  SCAN_CLASSIFIER_VERSION,
  type DocumentKind,
  type NormalizedBlock,
  type NormalizedDocument,
} from "./contracts.js";
import { IngestionError } from "./errors.js";

const ALLOWED_DIAGNOSTICS = new Set([
  "blank_page",
  "digital_text_preserved",
  "empty_section",
  "image_only_page",
  "table_structure_simplified",
]);
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validateNormalizedDocument(
  value: unknown,
  expected: {
    readonly documentKind: DocumentKind;
    readonly inputSha256: string;
  },
): NormalizedDocument {
  if (!isRecord(value)) {
    invalid();
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !hasExactKeys(candidate, [
      "blocks",
      "classifierVersion",
      "configVersion",
      "contractVersion",
      "diagnostics",
      "documentKind",
      "inputSha256",
      "pageCount",
      "parserVersion",
      "scan",
      "workerImageDigest",
    ]) ||
    candidate.contractVersion !== NORMALIZED_DOCUMENT_VERSION ||
    candidate.configVersion !== INGESTION_PROFILE_VERSION ||
    candidate.classifierVersion !== SCAN_CLASSIFIER_VERSION ||
    candidate.parserVersion !== INGESTION_COMPONENTS.parser ||
    candidate.documentKind !== expected.documentKind ||
    candidate.inputSha256 !== expected.inputSha256 ||
    typeof candidate.workerImageDigest !== "string" ||
    !IMAGE_DIGEST.test(candidate.workerImageDigest) ||
    !Array.isArray(candidate.blocks) ||
    !Array.isArray(candidate.diagnostics) ||
    !isRecord(candidate.scan)
  ) {
    invalid();
  }

  let encodedBytes: number;
  try {
    encodedBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
  } catch {
    invalid();
  }
  if (encodedBytes > INGESTION_LIMITS.normalizedOutputBytes) {
    invalid("normalized_output_too_large");
  }
  validatePageCount(candidate.pageCount, expected.documentKind);
  validateDiagnostics(candidate.diagnostics as readonly unknown[]);
  validateScan(
    candidate.scan as Readonly<Record<string, unknown>>,
    candidate.pageCount as number | null,
    expected.documentKind,
  );
  validateBlocks(
    candidate.blocks as readonly unknown[],
    expected.documentKind,
    candidate.pageCount as number | null,
  );
  return value as unknown as NormalizedDocument;
}

function validatePageCount(value: unknown, kind: DocumentKind): void {
  if (kind === "pdf") {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      invalid();
    }
    return;
  }
  if (value !== null) {
    invalid("reflowable_page_number_prohibited");
  }
}

function validateDiagnostics(values: readonly unknown[]): void {
  if (
    values.length > 100 ||
    values.some(
      (value) => typeof value !== "string" || !ALLOWED_DIAGNOSTICS.has(value),
    )
  ) {
    invalid("diagnostic_not_allowlisted");
  }
}

function validateScan(
  scan: Readonly<Record<string, unknown>>,
  pageCount: number | null,
  kind: DocumentKind,
): void {
  if (
    !hasExactKeys(scan, ["candidatePages", "classification", "rasterDpi"]) ||
    !Array.isArray(scan.candidatePages) ||
    scan.rasterDpi !== 300 ||
    (scan.classification !== "digital" &&
      scan.classification !== "mixed" &&
      scan.classification !== "scanned")
  ) {
    invalid();
  }
  if (kind !== "pdf") {
    if (scan.classification !== "digital" || scan.candidatePages.length !== 0) {
      invalid();
    }
    return;
  }
  const pages = scan.candidatePages as readonly unknown[];
  let previous = 0;
  for (const value of pages) {
    if (
      !Number.isSafeInteger(value) ||
      (value as number) <= previous ||
      (value as number) > (pageCount ?? 0)
    ) {
      invalid();
    }
    previous = value as number;
  }
  const ratio = pages.length / (pageCount ?? 1);
  if (
    (pages.length === 0 && scan.classification !== "digital") ||
    (pages.length > 0 && ratio < 0.8 && scan.classification !== "mixed") ||
    (ratio >= 0.8 && scan.classification !== "scanned")
  ) {
    invalid("scan_classification_mismatch");
  }
}

function validateBlocks(
  values: readonly unknown[],
  kind: DocumentKind,
  pageCount: number | null,
): void {
  let previousEnd = 0;
  values.forEach((value, index) => {
    if (!isRecord(value)) {
      invalid();
    }
    const block = value as unknown as NormalizedBlock;
    if (
      !hasExactKeys(value, [
        "canonicalEnd",
        "canonicalStart",
        "kind",
        "locator",
        "order",
        "text",
        "textSha256",
      ]) ||
      block.order !== index ||
      !Number.isSafeInteger(block.canonicalStart) ||
      !Number.isSafeInteger(block.canonicalEnd) ||
      block.canonicalStart < previousEnd ||
      block.canonicalEnd <= block.canonicalStart ||
      typeof block.text !== "string" ||
      block.text.length === 0 ||
      !/^[a-f0-9]{64}$/.test(block.textSha256) ||
      block.textSha256 !== sha256(block.text) ||
      (block.kind !== "heading" &&
        block.kind !== "list" &&
        block.kind !== "paragraph" &&
        block.kind !== "table") ||
      !isRecord(block.locator) ||
      block.locator.kind !== kind
    ) {
      invalid();
    }
    validateLocator(block, kind, pageCount);
    previousEnd = block.canonicalEnd;
  });
}

function validateLocator(
  block: NormalizedBlock,
  kind: DocumentKind,
  pageCount: number | null,
): void {
  const locator = block.locator;
  if (
    kind === "pdf" &&
    locator.kind === "pdf" &&
    hasExactKeys(locator, ["kind", "page", "sectionPath"]) &&
    Number.isSafeInteger(locator.page) &&
    locator.page > 0 &&
    locator.page <= (pageCount ?? 0) &&
    isStringArray(locator.sectionPath)
  ) {
    return;
  }
  if (
    kind === "epub" &&
    locator.kind === "epub" &&
    hasExactKeys(locator, [
      "kind",
      "page",
      "resource",
      "sectionPath",
      "spineItem",
    ]) &&
    locator.page === null &&
    Number.isSafeInteger(locator.spineItem) &&
    locator.spineItem >= 0 &&
    isSafeResourcePath(locator.resource) &&
    isStringArray(locator.sectionPath)
  ) {
    return;
  }
  if (
    kind === "docx" &&
    locator.kind === "docx" &&
    hasExactKeys(locator, [
      "bodyElement",
      "headingPath",
      "kind",
      "page",
      "section",
    ]) &&
    locator.page === null &&
    Number.isSafeInteger(locator.bodyElement) &&
    locator.bodyElement >= 0 &&
    Number.isSafeInteger(locator.section) &&
    locator.section >= 0 &&
    isStringArray(locator.headingPath)
  ) {
    return;
  }
  invalid("invalid_locator");
}

function isStringArray(value: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((part) => isSafeLocatorPart(part))
  );
}

function isSafeLocatorPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
  );
}

function isSafeResourcePath(value: unknown): value is string {
  return (
    isSafeLocatorPart(value) &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "..")
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(detail?: string): never {
  throw new IngestionError("invalid_output", detail);
}
