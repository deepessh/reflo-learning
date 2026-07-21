import { createHash } from "node:crypto";

import { normalizedDocument } from "@reflo/ingestion/testing";
import { describe, expect, it } from "vitest";

import { chunkNormalizedDocument } from "./chunker.js";
import { SOURCE_SPAN_CONTRACT_VERSION } from "./contracts.js";
import { unicodeTokenizerV1 } from "./tokenizer.js";

const ownerScopeId = "00000000-0000-4000-8000-000000000101";
const sourceDocumentId = "00000000-0000-4000-8000-000000000201";

describe("chunk-v1", () => {
  it("creates stable source spans with native PDF provenance", () => {
    const document = normalizedDocument("pdf", "a".repeat(64));
    const first = chunkNormalizedDocument({
      document,
      ownerScopeId,
      sourceDocumentId,
    });
    const regenerated = chunkNormalizedDocument({
      document: structuredClone(document),
      ownerScopeId,
      sourceDocumentId,
    });

    expect(regenerated).toEqual(first);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      chunkOrder: 0,
      contractVersion: SOURCE_SPAN_CONTRACT_VERSION,
      ownerScopeId,
      pageEnd: 1,
      pageStart: 1,
      sectionPath: ["Introduction"],
      sourceDocumentId,
    });
    expect(first[0]?.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(first[0]?.mappings[0]?.locator).toEqual({
      kind: "pdf",
      page: 1,
      sectionPath: ["Introduction"],
    });
  });

  it.each(["epub", "docx"] as const)(
    "preserves %s native locators without invented pages",
    (kind) => {
      const [span] = chunkNormalizedDocument({
        document: normalizedDocument(kind, "b".repeat(64)),
        ownerScopeId,
        sourceDocumentId,
      });
      expect(span?.pageStart).toBeNull();
      expect(span?.pageEnd).toBeNull();
      expect(span?.mappings[0]?.locator.kind).toBe(kind);
      if (kind === "epub") {
        expect(span?.mappings[0]?.locator).toMatchObject({
          resource: "chapter.xhtml",
          spineItem: 0,
        });
      } else {
        expect(span?.mappings[0]?.locator).toMatchObject({
          bodyElement: 0,
          section: 0,
        });
      }
    },
  );

  it("splits oversized blocks under the complete 700-token cap", () => {
    const document = normalizedDocument("pdf", "c".repeat(64));
    const text = Array.from(
      { length: 1_420 },
      (_, index) => `token${index}`,
    ).join(" ");
    const block = document.blocks[0];
    if (block === undefined) {
      throw new Error("fixture block missing");
    }
    const oversized = {
      ...document,
      blocks: [
        {
          ...block,
          canonicalEnd: text.length,
          text,
          textSha256: createHash("sha256").update(text).digest("hex"),
        },
      ],
    };

    const spans = chunkNormalizedDocument({
      document: oversized,
      ownerScopeId,
      sourceDocumentId,
    });
    expect(spans.length).toBeGreaterThan(2);
    expect(
      spans.every(
        (span) => unicodeTokenizerV1.count(span.embeddingInput) <= 700,
      ),
    ).toBe(true);
    expect(
      spans.every((span) => span.mappings.every((map) => !map.overlap)),
    ).toBe(true);
  });
});
