import { describe, expect, it } from "vitest";

import { IngestionError } from "./errors.js";
import { validateNormalizedDocument } from "./output-validation.js";
import { normalizedDocument, sha256, validPdf } from "./testing-fixtures.js";

describe("validateNormalizedDocument", () => {
  it("accepts versioned blocks with stable hashes and native locators", () => {
    const inputSha256 = sha256(validPdf());
    const document = normalizedDocument("pdf", inputSha256);
    expect(
      validateNormalizedDocument(document, {
        documentKind: "pdf",
        inputSha256,
      }),
    ).toEqual(document);
  });

  it("rejects invented DOCX page numbers and invalid block hashes", () => {
    const inputSha256 = sha256(Buffer.from("docx"));
    const document = normalizedDocument("docx", inputSha256);
    expectInvalid(
      { ...document, pageCount: 1 },
      "reflowable_page_number_prohibited",
    );
    expectInvalid(
      {
        ...document,
        blocks: [{ ...document.blocks[0]!, textSha256: "b".repeat(64) }],
      },
      undefined,
    );
  });

  it("rejects scan classifier outcomes that do not match candidate ratios", () => {
    const inputSha256 = sha256(validPdf());
    const document = normalizedDocument("pdf", inputSha256, {
      candidatePages: [1],
      pageCount: 10,
    });
    expectInvalid(
      { ...document, scan: { ...document.scan, classification: "scanned" } },
      "scan_classification_mismatch",
    );
  });

  it("rejects undeclared output fields and PDF locators outside the document", () => {
    const inputSha256 = sha256(validPdf());
    const document = normalizedDocument("pdf", inputSha256);
    expectInvalid(
      { ...document, rawParserDiagnostic: "not allowlisted" },
      undefined,
    );
    expectInvalid(
      {
        ...document,
        blocks: [
          {
            ...document.blocks[0]!,
            locator: { kind: "pdf", page: 2, sectionPath: [] },
          },
        ],
      },
      "invalid_locator",
    );
  });

  function expectInvalid(value: unknown, detail: string | undefined): void {
    try {
      validateNormalizedDocument(value, {
        documentKind: (value as { documentKind: "docx" | "pdf" }).documentKind,
        inputSha256: (value as { inputSha256: string }).inputSha256,
      });
      throw new Error("expected output validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(IngestionError);
      expect((error as IngestionError).code).toBe("invalid_output");
      expect((error as IngestionError).sanitizedDetail).toBe(detail);
    }
  }
});
