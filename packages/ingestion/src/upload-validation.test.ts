import { describe, expect, it } from "vitest";

import { INGESTION_LIMITS } from "./contracts.js";
import { IngestionError } from "./errors.js";
import {
  buildStoredZip,
  sha256,
  sourceFor,
  validDocx,
  validEpub,
  validPdf,
} from "./testing-fixtures.js";
import { validateUpload } from "./upload-validation.js";

describe("validateUpload", () => {
  it.each([
    ["pdf", validPdf()],
    ["epub", validEpub()],
    ["docx", validDocx()],
  ] as const)("accepts a structurally valid %s fixture", (kind, bytes) => {
    const source = sourceFor(kind, bytes);
    expect(
      validateUpload(source, {
        byteLength: bytes.byteLength,
        bytes,
        inputPath: "/tmp/job/source",
        sha256: sha256(bytes),
      }),
    ).toEqual({ documentKind: kind, processingLane: "standard" });
  });

  it("requires extension, client MIME, signature, and container structure to agree", () => {
    const bytes = validPdf();
    const source = {
      ...sourceFor("pdf", bytes),
      clientMimeType: "application/epub+zip",
    };
    expectFailure(() => stagedValidation(source, bytes), "mime_mismatch");

    const zipAsPdf = sourceFor("pdf", validEpub());
    expectFailure(
      () => stagedValidation(zipAsPdf, validEpub()),
      "mime_mismatch",
    );
  });

  it("fails closed for unsupported, encrypted, active, and malformed PDFs", () => {
    const bytes = validPdf();
    expectFailure(
      () =>
        stagedValidation(
          { ...sourceFor("pdf", bytes), extension: "txt" },
          bytes,
        ),
      "unsupported_type",
    );
    for (const [marker, code] of [
      ["/Encrypt 1 0 R", "encrypted"],
      ["/JavaScript 1 0 R", "active_content"],
    ] as const) {
      const unsafe = Buffer.from(
        `%PDF-1.7\n1 0 obj << ${marker} >> endobj\n%%EOF\n`,
        "latin1",
      );
      expectFailure(
        () => stagedValidation(sourceFor("pdf", unsafe), unsafe),
        code,
      );
    }
    const malformed = Buffer.from("%PDF-1.7\nno trailer", "latin1");
    expectFailure(
      () => stagedValidation(sourceFor("pdf", malformed), malformed),
      "malformed_document",
    );
  });

  it("rejects archive bombs before expanding their payload", () => {
    const bomb = buildStoredZip([
      {
        content: "x",
        declaredCompressedSize: 1,
        declaredUncompressedSize: 101,
        name: "mimetype",
      },
      { content: "<container/>", name: "META-INF/container.xml" },
    ]);
    expectFailure(
      () => stagedValidation(sourceFor("epub", bomb), bomb),
      "archive_limit",
    );
  });

  it("rejects encrypted ZIP flags and local/central header disagreement", () => {
    const encrypted = Buffer.from(validDocx());
    const centralOffset = encrypted.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    encrypted.writeUInt16LE(1, centralOffset + 8);
    expectFailure(
      () => stagedValidation(sourceFor("docx", encrypted), encrypted),
      "unsupported_type",
    );

    const mismatched = Buffer.from(validDocx());
    mismatched[30] = "X".charCodeAt(0);
    expectFailure(
      () => stagedValidation(sourceFor("docx", mismatched), mismatched),
      "malformed_document",
    );
  });

  it("rejects macro, external relationship, entity, and nested archive content", () => {
    const fixtures = [
      buildStoredZip([
        ...docxBase(),
        { content: "macro", name: "word/vbaProject.bin" },
      ]),
      buildStoredZip([
        ...docxBase(),
        {
          content:
            '<Relationships><Relationship TargetMode="External"/></Relationships>',
          name: "word/_rels/document.xml.rels",
        },
      ]),
      buildStoredZip([
        ...docxBase(),
        {
          content: "<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///etc/passwd'>]>",
          name: "word/styles.xml",
        },
      ]),
      buildStoredZip([
        ...docxBase(),
        { content: "PK", name: "word/embedded.zip" },
      ]),
    ];
    expectFailure(
      () => stagedValidation(sourceFor("docx", fixtures[0]!), fixtures[0]!),
      "active_content",
    );
    expectFailure(
      () => stagedValidation(sourceFor("docx", fixtures[1]!), fixtures[1]!),
      "active_content",
    );
    expectFailure(
      () => stagedValidation(sourceFor("docx", fixtures[2]!), fixtures[2]!),
      "active_content",
    );
    expectFailure(
      () => stagedValidation(sourceFor("docx", fixtures[3]!), fixtures[3]!),
      "archive_limit",
    );
  });

  it("enforces the product maximum before staging oversized content", () => {
    const bytes = validPdf();
    const source = {
      ...sourceFor("pdf", bytes),
      expectedByteLength: INGESTION_LIMITS.largeDocument.maxBytes + 1,
    };
    expectFailure(() => stagedValidation(source, bytes), "archive_limit");
  });
});

function stagedValidation(
  source: ReturnType<typeof sourceFor>,
  bytes: Uint8Array,
) {
  return validateUpload(source, {
    byteLength: bytes.byteLength,
    bytes,
    inputPath: "/tmp/job/source",
    sha256: sha256(bytes),
  });
}

function expectFailure(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IngestionError);
    expect((error as IngestionError).code).toBe(code);
  }
}

function docxBase() {
  return [
    { content: "<Types/>", name: "[Content_Types].xml" },
    { content: "<Relationships/>", name: "_rels/.rels" },
    { content: "<w:document/>", name: "word/document.xml" },
  ];
}
