import { createHash } from "node:crypto";

import {
  INGESTION_COMPONENTS,
  INGESTION_PROFILE_VERSION,
  NORMALIZED_DOCUMENT_VERSION,
  SCAN_CLASSIFIER_VERSION,
  type AuthorizedQuarantinedSource,
  type DocumentKind,
  type NormalizedDocument,
} from "./contracts.js";

interface StoredZipEntry {
  readonly content: string | Uint8Array;
  readonly declaredCompressedSize?: number;
  readonly declaredUncompressedSize?: number;
  readonly name: string;
}

export function buildStoredZip(entries: readonly StoredZipEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : Buffer.from(entry.content);
    const compressedSize = entry.declaredCompressedSize ?? content.byteLength;
    const uncompressedSize =
      entry.declaredUncompressedSize ?? content.byteLength;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.byteLength + name.byteLength + content.byteLength;
  }
  const locals = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(locals.byteLength, 16);
  return Buffer.concat([locals, central, end]);
}

export function validPdf(): Uint8Array {
  return Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n0\n%%EOF\n",
    "latin1",
  );
}

export function validEpub(): Uint8Array {
  return buildStoredZip([
    { content: "application/epub+zip", name: "mimetype" },
    {
      content:
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      name: "META-INF/container.xml",
    },
    { content: "<package><spine/></package>", name: "content.opf" },
    {
      content: "<html><body><p>Lesson</p></body></html>",
      name: "chapter.xhtml",
    },
  ]);
}

export function validDocx(): Uint8Array {
  return buildStoredZip([
    {
      content:
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      name: "[Content_Types].xml",
    },
    {
      content:
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
      name: "_rels/.rels",
    },
    {
      content: "<w:document><w:body/></w:document>",
      name: "word/document.xml",
    },
  ]);
}

export function sourceFor(
  kind: DocumentKind,
  bytes: Uint8Array,
): AuthorizedQuarantinedSource {
  return {
    clientMimeType:
      kind === "pdf"
        ? "application/pdf"
        : kind === "epub"
          ? "application/epub+zip"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    expectedByteLength: bytes.byteLength,
    expectedInputSha256: sha256(bytes),
    extension: kind,
    objectKey: `quarantine/${kind}`,
    ownerScopeId: "scope-test-0001",
    retentionState: "active",
    sourceDocumentId: "source-test-0001",
  };
}

export function normalizedDocument(
  kind: DocumentKind,
  inputSha256: string,
  options: {
    readonly candidatePages?: readonly number[];
    readonly pageCount?: number;
  } = {},
): NormalizedDocument {
  const text = "Grounded lesson text";
  const candidatePages = options.candidatePages ?? [];
  const pageCount = kind === "pdf" ? (options.pageCount ?? 1) : null;
  const ratio = candidatePages.length / (pageCount ?? 1);
  return {
    blocks: [
      {
        canonicalEnd: text.length,
        canonicalStart: 0,
        kind: "paragraph",
        locator:
          kind === "pdf"
            ? { kind: "pdf", page: 1, sectionPath: ["Introduction"] }
            : kind === "epub"
              ? {
                  kind: "epub",
                  page: null,
                  resource: "chapter.xhtml",
                  sectionPath: ["Introduction"],
                  spineItem: 0,
                }
              : {
                  bodyElement: 0,
                  headingPath: ["Introduction"],
                  kind: "docx",
                  page: null,
                  section: 0,
                },
        order: 0,
        text,
        textSha256: sha256(Buffer.from(text)),
      },
    ],
    classifierVersion: SCAN_CLASSIFIER_VERSION,
    configVersion: INGESTION_PROFILE_VERSION,
    contractVersion: NORMALIZED_DOCUMENT_VERSION,
    diagnostics: [],
    documentKind: kind,
    inputSha256,
    pageCount,
    parserVersion: INGESTION_COMPONENTS.parser,
    scan: {
      candidatePages,
      classification:
        candidatePages.length === 0
          ? "digital"
          : ratio >= 0.8
            ? "scanned"
            : "mixed",
      rasterDpi: 300,
    },
    workerImageDigest: `sha256:${"a".repeat(64)}`,
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
