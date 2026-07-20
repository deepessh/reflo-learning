import { describe, expect, it } from "vitest";

import {
  createAlibabaTypeASigner,
  verifyAlibabaTypeAUrl,
} from "./adapters/alibaba-type-a.js";
import type { AuthorizedDeliveryResource } from "./contracts.js";
import { buildAssetObjectKey } from "./object-keys.js";
import { PrivateDeliveryService } from "./service.js";
import {
  FixedClock,
  InMemoryAuthorizedResourceStore,
  MutableClock,
} from "./testing.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const ACTOR_ID = "90000000-0000-4000-8000-000000000009";
const OTHER_ACTOR_ID = "91000000-0000-4000-8000-000000000009";
const SCOPE_ID = "10000000-0000-4000-8000-000000000001";
const COURSE_ID = "40000000-0000-4000-8000-000000000004";
const ASSET_ID = "50000000-0000-4000-8000-000000000005";
const RESOURCE: AuthorizedDeliveryResource = {
  byteSize: 12_345,
  contentType: "audio/mpeg",
  courseId: COURSE_ID,
  deliveryState: "deliverable",
  etag: "sha256:fixture",
  objectKey: buildAssetObjectKey({
    assetId: ASSET_ID,
    courseId: COURSE_ID,
    extension: "mp3",
    generationId: "60000000-0000-4000-8000-000000000006",
    ownerScopeId: SCOPE_ID,
  }),
  ownerScopeId: SCOPE_ID,
  reference: { assetId: ASSET_ID, kind: "asset" },
};

describe("private delivery authorization", () => {
  it("delivers metadata and a short-lived URL to an active owner", async () => {
    const { resources, service } = fixture();
    resources.addMembership(ACTOR_ID, SCOPE_ID);
    resources.addResource(RESOURCE);

    const delivery = await service.authorize({
      actorId: ACTOR_ID,
      resource: RESOURCE.reference,
    });

    expect(delivery).toMatchObject({
      contractVersion: "private-delivery-v1",
      expiresAt: "2026-07-20T12:15:00.000Z",
      metadata: {
        byteSize: 12_345,
        contentType: "audio/mpeg",
        etag: "sha256:fixture",
        resourceId: ASSET_ID,
        resourceKind: "asset",
      },
      playback: {
        acceptsByteRanges: true,
        cacheControl: "private, no-store, max-age=0",
        refreshOnForbidden: true,
        resumeSupported: true,
      },
    });
    expect(new URL(delivery.url).pathname).toBe(`/${RESOURCE.objectKey}`);
    expect(new URL(delivery.url).searchParams.has("auth_key")).toBe(true);
    expect(JSON.stringify(delivery.metadata)).not.toContain(SCOPE_ID);
    expect(JSON.stringify(delivery.metadata)).not.toContain(RESOURCE.objectKey);
  });

  it("uses the same safe denial for missing, cross-scope, and revoked access", async () => {
    const { resources, service } = fixture();
    resources.addResource(RESOURCE);
    resources.addMembership(ACTOR_ID, SCOPE_ID);
    resources.revokeMembership(ACTOR_ID, SCOPE_ID);

    await expect(
      service.authorize({
        actorId: ACTOR_ID,
        resource: RESOURCE.reference,
      }),
    ).rejects.toMatchObject({ safeCode: "not_found_or_forbidden" });
    await expect(
      service.authorize({
        actorId: OTHER_ACTOR_ID,
        resource: RESOURCE.reference,
      }),
    ).rejects.toMatchObject({ safeCode: "not_found_or_forbidden" });
    await expect(
      service.authorize({
        actorId: ACTOR_ID,
        resource: {
          assetId: "70000000-0000-4000-8000-000000000007",
          kind: "asset",
        },
      }),
    ).rejects.toMatchObject({ safeCode: "not_found_or_forbidden" });
  });

  it("reauthorizes and refreshes an expired URL for range resume", async () => {
    const resources = new InMemoryAuthorizedResourceStore();
    const clock = new MutableClock(NOW);
    const signer = createSigner();
    const service = new PrivateDeliveryService({ clock, resources, signer });
    resources.addMembership(ACTOR_ID, SCOPE_ID);
    resources.addResource(RESOURCE);

    const first = await service.authorize({
      actorId: ACTOR_ID,
      resource: RESOURCE.reference,
    });
    clock.set(new Date(NOW.getTime() + 16 * 60 * 1_000));
    const refreshed = await service.authorize({
      actorId: ACTOR_ID,
      resource: RESOURCE.reference,
    });

    expect(first.url).not.toBe(refreshed.url);
    expect(
      verifyAlibabaTypeAUrl({
        expectedOrigin: "https://assets.reflo.example",
        now: clock.now(),
        signingKeys: ["fixture-private-key-material".repeat(2)],
        url: first.url,
      }),
    ).toBe(false);
    expect(
      verifyAlibabaTypeAUrl({
        expectedOrigin: "https://assets.reflo.example",
        now: clock.now(),
        signingKeys: ["fixture-private-key-material".repeat(2)],
        url: refreshed.url,
      }),
    ).toBe(true);
    expect(refreshed.playback.resumeSupported).toBe(true);
  });

  it("refuses a repository result with a cross-scope canonical key", async () => {
    const { resources, service } = fixture();
    resources.addMembership(ACTOR_ID, SCOPE_ID);
    resources.addResource({
      ...RESOURCE,
      objectKey: buildAssetObjectKey({
        assetId: ASSET_ID,
        courseId: COURSE_ID,
        extension: "mp3",
        generationId: "60000000-0000-4000-8000-000000000006",
        ownerScopeId: "80000000-0000-4000-8000-000000000008",
      }),
    });

    await expect(
      service.authorize({
        actorId: ACTOR_ID,
        resource: RESOURCE.reference,
      }),
    ).rejects.toMatchObject({ safeCode: "integrity_check_failed" });
  });

  it("does not accept a caller-supplied owner scope or object key", () => {
    const requestKeys = Object.keys({
      actorId: ACTOR_ID,
      resource: RESOURCE.reference,
    }).sort();
    expect(requestKeys).toEqual(["actorId", "resource"]);
    expect(Object.keys(RESOURCE.reference).sort()).toEqual(["assetId", "kind"]);
  });

  it("does not retain raw authorization diagnostics on public errors", async () => {
    const service = new PrivateDeliveryService({
      clock: new FixedClock(NOW),
      resources: {
        async markPurged() {},
        async resolveForDelivery() {
          throw new Error(
            "provider failed for https://assets.example/payload?auth_key=bearer",
          );
        },
        async tombstoneForDeletion() {
          return null;
        },
      },
      signer: createSigner(),
    });

    const error = await service
      .authorize({ actorId: ACTOR_ID, resource: RESOURCE.reference })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ safeCode: "authorization_unavailable" });
    expect(String(error)).not.toContain("auth_key");
    expect(error).not.toHaveProperty("cause");
  });
});

function fixture() {
  const resources = new InMemoryAuthorizedResourceStore();
  const signer = createSigner();
  return {
    resources,
    service: new PrivateDeliveryService({
      clock: new FixedClock(NOW),
      resources,
      signer,
    }),
  };
}

function createSigner() {
  return createAlibabaTypeASigner({
    activeKey: {
      keyVersion: "fixture-v1",
      source: "kms-secrets-manager",
      value: "fixture-private-key-material".repeat(2),
    },
    cdnOrigin: "https://assets.reflo.example",
    randomValue: () => "477b3bbc253f467b8def6711128c7bec",
  });
}
