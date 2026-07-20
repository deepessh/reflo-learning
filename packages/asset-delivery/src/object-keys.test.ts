import { describe, expect, it } from "vitest";

import {
  assertResourceMatchesCanonicalKey,
  buildAssetObjectKey,
  buildSourceObjectKey,
  canonicalDeliveryPath,
  parseCanonicalObjectKey,
} from "./object-keys.js";

const SCOPE_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_ID = "20000000-0000-4000-8000-000000000002";
const VERSION_ID = "30000000-0000-4000-8000-000000000003";
const COURSE_ID = "40000000-0000-4000-8000-000000000004";
const ASSET_ID = "50000000-0000-4000-8000-000000000005";
const GENERATION_ID = "60000000-0000-4000-8000-000000000006";

describe("private OSS object layout", () => {
  it("builds the accepted immutable source and asset layouts", () => {
    expect(
      buildSourceObjectKey({
        extension: "pdf",
        ownerScopeId: SCOPE_ID,
        sourceDocumentId: SOURCE_ID,
        versionId: VERSION_ID,
      }),
    ).toBe(
      `owners/${SCOPE_ID}/sources/${SOURCE_ID}/versions/${VERSION_ID}/original.pdf`,
    );
    expect(
      buildAssetObjectKey({
        assetId: ASSET_ID,
        courseId: COURSE_ID,
        extension: "mp3",
        generationId: GENERATION_ID,
        ownerScopeId: SCOPE_ID,
      }),
    ).toBe(
      `owners/${SCOPE_ID}/courses/${COURSE_ID}/assets/${ASSET_ID}/generations/${GENERATION_ID}/payload.mp3`,
    );
  });

  it("round-trips only canonical opaque layouts", () => {
    const objectKey = buildAssetObjectKey({
      assetId: ASSET_ID,
      courseId: COURSE_ID,
      extension: "mp4",
      generationId: GENERATION_ID,
      ownerScopeId: SCOPE_ID,
    });

    expect(parseCanonicalObjectKey(objectKey)).toEqual({
      courseId: COURSE_ID,
      extension: "mp4",
      generationId: GENERATION_ID,
      kind: "asset",
      ownerScopeId: SCOPE_ID,
      reference: { assetId: ASSET_ID, kind: "asset" },
    });
    expect(canonicalDeliveryPath(objectKey)).toBe(`/${objectKey}`);
  });

  it("rejects names, traversal, arbitrary keys, and noncanonical IDs", () => {
    expect(() =>
      buildSourceObjectKey({
        extension: "Study Guide.pdf",
        ownerScopeId: SCOPE_ID,
        sourceDocumentId: SOURCE_ID,
        versionId: VERSION_ID,
      }),
    ).toThrow("integrity check failed");
    expect(() => parseCanonicalObjectKey("../../private/secret.pdf")).toThrow(
      "integrity check failed",
    );
    expect(() =>
      parseCanonicalObjectKey(
        `owners/alice@example.com/sources/${SOURCE_ID}/versions/${VERSION_ID}/original.pdf`,
      ),
    ).toThrow("integrity check failed");
  });

  it("detects a persisted key that does not match its server record", () => {
    const objectKey = buildAssetObjectKey({
      assetId: ASSET_ID,
      courseId: COURSE_ID,
      extension: "mp3",
      generationId: GENERATION_ID,
      ownerScopeId: SCOPE_ID,
    });

    expect(() =>
      assertResourceMatchesCanonicalKey({
        byteSize: 42,
        contentType: "audio/mpeg",
        courseId: "70000000-0000-4000-8000-000000000007",
        deliveryState: "deliverable",
        etag: "etag",
        objectKey,
        ownerScopeId: SCOPE_ID,
        reference: { assetId: ASSET_ID, kind: "asset" },
      }),
    ).toThrow("integrity check failed");
  });
});
