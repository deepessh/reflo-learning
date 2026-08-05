import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ConnectedPrivateAsset } from "@reflo/db";

import { LocalPrivateAssetDelivery } from "./local-private-assets";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_SCOPE_ID = "10000000-0000-4000-8000-000000000002";
const COURSE_ID = "10000000-0000-4000-8000-000000000003";
const ASSET_ID = "10000000-0000-4000-8000-000000000004";
const GENERATION_ID = "10000000-0000-4000-8000-000000000005";
const bytes = Buffer.from("RIFF-safe-private-audio-bytes", "utf8");
const asset: ConnectedPrivateAsset = {
  assetId: ASSET_ID,
  byteSize: bytes.byteLength,
  contentHash: sha256(bytes),
  contentType: "audio/wav",
  courseId: COURSE_ID,
  etag: `sha256:${sha256(bytes)}`,
  objectKey: `owners/${OWNER_SCOPE_ID}/courses/${COURSE_ID}/assets/${ASSET_ID}/generations/${GENERATION_ID}/payload.wav`,
  ownerScopeId: OWNER_SCOPE_ID,
};
const authorization = {
  actorId: ACTOR_ID,
  authorizationId: "session-authorization",
  ownerScopeId: OWNER_SCOPE_ID,
};

describe("local private lesson assets", () => {
  it("issues an owner-scoped 15-minute grant and supports range resume", async () => {
    let now = new Date("2026-07-31T12:00:00.500Z");
    const service = serviceFixture(() => now);

    const crossScope = await service.authorize(
      { ...authorization, ownerScopeId: COURSE_ID },
      ASSET_ID,
      "http://127.0.0.1:53001",
    );
    expect(crossScope).toBeNull();

    const delivery = await service.authorize(
      authorization,
      ASSET_ID,
      "http://127.0.0.1:53001",
    );
    expect(delivery).toMatchObject({
      contractVersion: "private-delivery-v1",
      expiresAt: "2026-07-31T12:15:00.000Z",
      metadata: { resourceId: ASSET_ID, resourceKind: "asset" },
      playback: { acceptsByteRanges: true, resumeSupported: true },
    });
    const token = new URL(delivery!.url).searchParams.get("auth_key");
    const partial = await service.read(ASSET_ID, token, "bytes=5-11");
    expect(partial).toMatchObject({
      contentRange: `bytes 5-11/${bytes.byteLength}`,
      status: 206,
      totalBytes: bytes.byteLength,
    });
    expect(Buffer.from(partial!.bytes).toString("utf8")).toBe("safe-pr");

    expect(await service.read(GENERATION_ID, token, undefined)).toBeNull();
    now = new Date("2026-07-31T12:15:00.000Z");
    expect(await service.read(ASSET_ID, token, undefined)).toBeNull();
  });

  it("fails closed when persisted identity or object integrity changes", async () => {
    let current = asset;
    let stored = bytes;
    const service = new LocalPrivateAssetDelivery({
      clock: () => new Date("2026-07-31T12:00:00.000Z"),
      objects: { read: async () => stored },
      repository: {
        resolvePrivateAsset: async (context, assetId) =>
          context.actorId === ACTOR_ID &&
          context.ownerScopeId === OWNER_SCOPE_ID &&
          assetId === ASSET_ID
            ? current
            : null,
      },
    });
    const delivery = await service.authorize(
      authorization,
      ASSET_ID,
      "http://localhost:53001",
    );
    const token = new URL(delivery!.url).searchParams.get("auth_key");

    current = { ...asset, etag: "changed" };
    expect(await service.read(ASSET_ID, token, undefined)).toBeNull();
    current = asset;
    stored = Buffer.from("tampered", "utf8");
    expect(await service.read(ASSET_ID, token, undefined)).toBeNull();
  });
});

function serviceFixture(clock: () => Date): LocalPrivateAssetDelivery {
  return new LocalPrivateAssetDelivery({
    clock,
    objects: { read: async () => bytes },
    repository: {
      resolvePrivateAsset: async (context, assetId) =>
        context.actorId === ACTOR_ID &&
        context.ownerScopeId === OWNER_SCOPE_ID &&
        assetId === ASSET_ID
          ? asset
          : null,
    },
  });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
