import { describe, expect, it } from "vitest";

import {
  DEMO_UPLOAD_FILE_ACCEPT,
  isDemoPdfSelection,
} from "./demo-upload-file";

describe("Demo Day PDF upload selection", () => {
  it("advertises and accepts only bounded PDF files", () => {
    expect(DEMO_UPLOAD_FILE_ACCEPT).toBe("application/pdf,.pdf");
    expect(
      isDemoPdfSelection({
        name: "approved-source.PDF",
        size: 1,
        type: "application/pdf",
      }),
    ).toBe(true);
    expect(
      isDemoPdfSelection({
        name: "approved-source.pdf",
        size: 50 * 1024 * 1024,
        type: "",
      }),
    ).toBe(true);
  });

  it.each([
    ["approved-source.epub", "application/epub+zip"],
    [
      "approved-source.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["approved-source.pdf", "application/epub+zip"],
  ])("rejects inactive %s selections", (name, type) => {
    expect(isDemoPdfSelection({ name, size: 1024, type })).toBe(false);
  });

  it("rejects empty and over-maximum PDFs", () => {
    expect(
      isDemoPdfSelection({
        name: "approved-source.pdf",
        size: 0,
        type: "application/pdf",
      }),
    ).toBe(false);
    expect(
      isDemoPdfSelection({
        name: "approved-source.pdf",
        size: 50 * 1024 * 1024 + 1,
        type: "application/pdf",
      }),
    ).toBe(false);
  });
});
