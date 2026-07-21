import { inflateRawSync } from "node:zlib";

import {
  INGESTION_LIMITS,
  type AuthorizedQuarantinedSource,
  type DocumentKind,
  type StagedUpload,
  type ValidatedUpload,
} from "./contracts.js";
import { IngestionError } from "./errors.js";

const MIME_BY_KIND: Readonly<Record<DocumentKind, string>> = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  pdf: "application/pdf",
});
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const CONTROL_FILE_LIMIT = 4 * 1_024 * 1_024;

interface ZipEntry {
  readonly compressedSize: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly flags: number;
  readonly localHeaderOffset: number;
  readonly name: string;
  readonly uncompressedSize: number;
}

export function validateUpload(
  source: AuthorizedQuarantinedSource,
  staged: StagedUpload,
): ValidatedUpload {
  validateRecordedMetadata(source, staged);
  const documentKind = kindFromExtension(source.extension);
  if (source.clientMimeType.toLowerCase() !== MIME_BY_KIND[documentKind]) {
    throw new IngestionError("mime_mismatch");
  }

  if (documentKind === "pdf") {
    validatePdf(staged.bytes);
  } else {
    const entries = inspectZip(staged.bytes);
    if (documentKind === "epub") {
      validateEpub(staged.bytes, entries);
    } else {
      validateDocx(staged.bytes, entries);
    }
  }

  return {
    documentKind,
    processingLane:
      staged.byteLength > INGESTION_LIMITS.standardDocument.maxBytes
        ? "large"
        : "standard",
  };
}

function validateRecordedMetadata(
  source: AuthorizedQuarantinedSource,
  staged: StagedUpload,
): void {
  if (
    !Number.isSafeInteger(source.expectedByteLength) ||
    source.expectedByteLength < 1 ||
    source.expectedByteLength > INGESTION_LIMITS.largeDocument.maxBytes ||
    !Number.isSafeInteger(staged.byteLength) ||
    staged.byteLength !== staged.bytes.byteLength ||
    staged.byteLength !== source.expectedByteLength
  ) {
    throw new IngestionError(
      source.expectedByteLength > INGESTION_LIMITS.largeDocument.maxBytes
        ? "archive_limit"
        : "hash_mismatch",
    );
  }
  if (
    !isSha256(source.expectedInputSha256) ||
    staged.sha256 !== source.expectedInputSha256
  ) {
    throw new IngestionError("hash_mismatch");
  }
}

function kindFromExtension(extension: string): DocumentKind {
  const normalized = extension.toLowerCase().replace(/^\./, "");
  if (normalized === "pdf" || normalized === "epub" || normalized === "docx") {
    return normalized;
  }
  throw new IngestionError("unsupported_type");
}

function validatePdf(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 8 ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  ) {
    throw new IngestionError("mime_mismatch");
  }
  const searchable = Buffer.from(bytes).toString("latin1");
  if (/\/Encrypt\b/.test(searchable)) {
    throw new IngestionError("encrypted");
  }
  if (
    /\/(?:JavaScript|JS|Launch|EmbeddedFile)\b/.test(searchable) ||
    /\/AA\s*<</.test(searchable)
  ) {
    throw new IngestionError("active_content");
  }
  if (!/%%EOF\s*$/.test(searchable)) {
    throw new IngestionError("malformed_document");
  }
}

function inspectZip(bytes: Uint8Array): readonly ZipEntry[] {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_FILE) {
    throw new IngestionError("mime_mismatch");
  }
  const endOffset = findEndRecord(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const diskEntryCount = buffer.readUInt16LE(endOffset + 8);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    buffer.readUInt16LE(endOffset + 4) !== 0 ||
    buffer.readUInt16LE(endOffset + 6) !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new IngestionError("archive_limit", "zip64_not_allowed");
  }
  if (
    entryCount < 1 ||
    entryCount > INGESTION_LIMITS.archive.maxEntries ||
    directoryOffset + directorySize > endOffset
  ) {
    throw new IngestionError("archive_limit");
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = directoryOffset;
  let expanded = 0;
  let compressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > buffer.byteLength ||
      buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE
    ) {
      throw new IngestionError("malformed_document");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const unixMode = buffer.readUInt32LE(cursor + 38) >>> 16;
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (nameLength < 1 || next > buffer.byteLength) {
      throw new IngestionError("malformed_document");
    }
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    validateArchivePath(name);
    if (names.has(name)) {
      throw new IngestionError("malformed_document", "duplicate_archive_entry");
    }
    names.add(name);
    if (
      (flags & 0x0001) !== 0 ||
      (flags & 0x0008) !== 0 ||
      (flags & ~0x0800) !== 0 ||
      (unixMode & 0xf000) === 0xa000 ||
      localHeaderOffset >= directoryOffset ||
      (compressionMethod !== 0 &&
        compressionMethod !== 8 &&
        !name.endsWith("/"))
    ) {
      throw new IngestionError(
        "unsupported_type",
        "archive_compression_method",
      );
    }
    if (uncompressedSize > INGESTION_LIMITS.archive.maxSingleEntryBytes) {
      throw new IngestionError("archive_limit", "single_entry");
    }
    expanded += uncompressedSize;
    compressed += compressedSize;
    if (
      expanded > INGESTION_LIMITS.archive.maxExpansionBytes ||
      (compressed === 0
        ? expanded > 0
        : expanded / compressed > INGESTION_LIMITS.archive.maxExpansionRatio)
    ) {
      throw new IngestionError("archive_limit", "expansion_ratio");
    }
    entries.push({
      compressedSize,
      compressionMethod,
      crc32: checksum,
      flags,
      localHeaderOffset,
      name,
      uncompressedSize,
    });
    cursor = next;
  }
  if (cursor !== directoryOffset + directorySize) {
    throw new IngestionError("malformed_document");
  }
  return entries;
}

function validateEpub(bytes: Uint8Array, entries: readonly ZipEntry[]): void {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const mimetype = byName.get("mimetype");
  const container = byName.get("META-INF/container.xml");
  if (mimetype === undefined || container === undefined) {
    throw new IngestionError("mime_mismatch");
  }
  if (
    mimetype.compressionMethod !== 0 ||
    mimetype.localHeaderOffset !== 0 ||
    extractControlEntry(bytes, mimetype).toString("utf8") !==
      "application/epub+zip"
  ) {
    throw new IngestionError("mime_mismatch");
  }
  inspectXml(extractControlEntry(bytes, container));
  rejectNestedAndActiveEntries(entries, [".js", ".exe", ".dll", ".sh"]);
  for (const entry of entries) {
    if (/\.(?:xhtml|html|xml|opf|ncx|css)$/i.test(entry.name)) {
      const content = extractControlEntry(bytes, entry).toString("utf8");
      if (
        /<(?:script|iframe|object|embed)\b/i.test(content) ||
        /(?:src|href)\s*=\s*["']\s*(?:https?:|ftp:|file:|\/\/)/i.test(
          content,
        ) ||
        /url\(\s*["']?\s*(?:https?:|ftp:|file:|\/\/)/i.test(content)
      ) {
        throw new IngestionError("active_content");
      }
      inspectXml(Buffer.from(content));
    }
  }
}

function validateDocx(bytes: Uint8Array, entries: readonly ZipEntry[]): void {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const required of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
  ]) {
    if (!byName.has(required)) {
      throw new IngestionError("mime_mismatch");
    }
  }
  rejectNestedAndActiveEntries(entries, [
    ".bin",
    ".js",
    ".exe",
    ".dll",
    ".sh",
    ".cmd",
  ]);
  for (const entry of entries) {
    if (/\.(?:xml|rels)$/i.test(entry.name)) {
      const content = extractControlEntry(bytes, entry);
      inspectXml(content);
      if (/TargetMode\s*=\s*["']External["']/i.test(content.toString("utf8"))) {
        throw new IngestionError("active_content", "external_relationship");
      }
    }
  }
}

function rejectNestedAndActiveEntries(
  entries: readonly ZipEntry[],
  activeExtensions: readonly string[],
): void {
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (activeExtensions.some((extension) => lower.endsWith(extension))) {
      throw new IngestionError("active_content");
    }
    if (/\.(?:zip|epub|docx)$/i.test(lower)) {
      throw new IngestionError("archive_limit", "nested_archive_rejected");
    }
  }
}

function inspectXml(content: Buffer): void {
  const value = content.toString("utf8");
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(value)) {
    throw new IngestionError("active_content", "xml_entity");
  }
}

function extractControlEntry(bytes: Uint8Array, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > CONTROL_FILE_LIMIT) {
    throw new IngestionError("archive_limit", "control_file_size");
  }
  const buffer = Buffer.from(bytes);
  const offset = entry.localHeaderOffset;
  if (
    offset + 30 > buffer.byteLength ||
    buffer.readUInt32LE(offset) !== ZIP_LOCAL_FILE
  ) {
    throw new IngestionError("malformed_document");
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const localFlags = buffer.readUInt16LE(offset + 6);
  const localMethod = buffer.readUInt16LE(offset + 8);
  const localChecksum = buffer.readUInt32LE(offset + 14);
  const localCompressedSize = buffer.readUInt32LE(offset + 18);
  const localUncompressedSize = buffer.readUInt32LE(offset + 22);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.byteLength) {
    throw new IngestionError("malformed_document");
  }
  const localName = buffer
    .subarray(offset + 30, offset + 30 + nameLength)
    .toString("utf8");
  if (
    localName !== entry.name ||
    localFlags !== entry.flags ||
    localMethod !== entry.compressionMethod ||
    localChecksum !== entry.crc32 ||
    localCompressedSize !== entry.compressedSize ||
    localUncompressedSize !== entry.uncompressedSize
  ) {
    throw new IngestionError("malformed_document");
  }
  const compressed = buffer.subarray(start, end);
  let output: Buffer;
  try {
    output =
      entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: CONTROL_FILE_LIMIT });
  } catch {
    throw new IngestionError("malformed_document");
  }
  if (
    output.byteLength !== entry.uncompressedSize ||
    crc32(output) !== entry.crc32
  ) {
    throw new IngestionError("malformed_document");
  }
  return output;
}

function findEndRecord(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.byteLength) {
        return offset;
      }
    }
  }
  throw new IngestionError("malformed_document");
}

function validateArchivePath(name: string): void {
  if (
    name.length > 4_096 ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    name.includes("\\") ||
    /^[a-z]:/i.test(name) ||
    name.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new IngestionError("archive_limit", "archive_path");
  }
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
