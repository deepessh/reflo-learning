import { describe, expect, it } from "vitest";

import { createAlibabaTypeASigner } from "./adapters/alibaba-type-a.js";
import type { AuthorizedDeliveryResource } from "./contracts.js";
import { buildAssetObjectKey, buildSourceObjectKey } from "./object-keys.js";
import { PrivateResourceDeletionService } from "./service.js";
import {
  DeterministicCdnInvalidator,
  FixedClock,
  InMemoryAuthorizedResourceStore,
  InMemoryPrivateObjectStore,
} from "./testing.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const ACTOR_ID = "90000000-0000-4000-8000-000000000009";
const SCOPE_ID = "10000000-0000-4000-8000-000000000001";
const COURSE_ID = "40000000-0000-4000-8000-000000000004";
const SOURCE_ID = "20000000-0000-4000-8000-000000000002";
const ASSET_ID = "50000000-0000-4000-8000-000000000005";

const RESOURCES: readonly AuthorizedDeliveryResource[] = [
  {
    byteSize: 20_000,
    contentType: "application/pdf",
    deliveryState: "deliverable",
    etag: "source-etag",
    objectKey: buildSourceObjectKey({
      extension: "pdf",
      ownerScopeId: SCOPE_ID,
      sourceDocumentId: SOURCE_ID,
      versionId: "30000000-0000-4000-8000-000000000003",
    }),
    ownerScopeId: SCOPE_ID,
    reference: { kind: "source", sourceDocumentId: SOURCE_ID },
  },
  {
    byteSize: 12_345,
    contentType: "audio/mpeg",
    courseId: COURSE_ID,
    deliveryState: "deliverable",
    etag: "asset-etag",
    objectKey: buildAssetObjectKey({
      assetId: ASSET_ID,
      courseId: COURSE_ID,
      extension: "mp3",
      generationId: "60000000-0000-4000-8000-000000000006",
      ownerScopeId: SCOPE_ID,
    }),
    ownerScopeId: SCOPE_ID,
    reference: { assetId: ASSET_ID, kind: "asset" },
  },
];

describe("private resource deletion hooks", () => {
  it("removes and invalidates every scoped source and generated asset fixture", async () => {
    const { cdn, objects, resources, service } = fixture();
    resources.addMembership(ACTOR_ID, SCOPE_ID);
    for (const resource of RESOURCES) {
      resources.addResource(resource);
      objects.add(resource.objectKey);
    }

    const outcomes = await Promise.all(
      RESOURCES.map((resource) =>
        service.delete({ actorId: ACTOR_ID, resource: resource.reference }),
      ),
    );

    expect(outcomes).toEqual([
      {
        completedAt: NOW.toISOString(),
        objectsAbsent: 1,
        purgesVerified: 1,
      },
      {
        completedAt: NOW.toISOString(),
        objectsAbsent: 1,
        purgesVerified: 1,
      },
    ]);
    expect(objects.deletedKeys.sort()).toEqual(
      RESOURCES.map((resource) => resource.objectKey).sort(),
    );
    expect(cdn.purgedUrls).toHaveLength(2);
    expect(cdn.purgedUrls.every((url) => !url.includes("auth_key"))).toBe(true);
    for (const resource of RESOURCES) {
      expect(resources.getState(resource.reference)).toBe("purged");
      await expect(objects.objectExists(resource.objectKey)).resolves.toBe(
        false,
      );
    }
  });

  it("tombstones first and leaves incomplete purge work retryable", async () => {
    const resources = new InMemoryAuthorizedResourceStore();
    const objects = new InMemoryPrivateObjectStore();
    const resource = RESOURCES[0];
    if (resource === undefined) {
      throw new Error("missing fixture");
    }
    resources.addMembership(ACTOR_ID, SCOPE_ID);
    resources.addResource(resource);
    objects.add(resource.objectKey);
    const failingService = createService(
      resources,
      objects,
      new DeterministicCdnInvalidator(NOW, false),
    );

    await expect(
      failingService.delete({
        actorId: ACTOR_ID,
        resource: resource.reference,
      }),
    ).rejects.toMatchObject({ safeCode: "deletion_incomplete" });
    expect(resources.getState(resource.reference)).toBe("tombstoned");

    const retryService = createService(
      resources,
      objects,
      new DeterministicCdnInvalidator(NOW),
    );
    await expect(
      retryService.delete({ actorId: ACTOR_ID, resource: resource.reference }),
    ).resolves.toMatchObject({ objectsAbsent: 1, purgesVerified: 1 });
    expect(resources.getState(resource.reference)).toBe("purged");
  });

  it("does not tombstone an object after membership revocation", async () => {
    const { resources, service } = fixture();
    const resource = RESOURCES[0];
    if (resource === undefined) {
      throw new Error("missing fixture");
    }
    resources.addResource(resource);
    resources.addMembership(ACTOR_ID, SCOPE_ID);
    resources.revokeMembership(ACTOR_ID, SCOPE_ID);

    await expect(
      service.delete({ actorId: ACTOR_ID, resource: resource.reference }),
    ).rejects.toMatchObject({ safeCode: "not_found_or_forbidden" });
    expect(resources.getState(resource.reference)).toBe("deliverable");
  });
});

function fixture() {
  const resources = new InMemoryAuthorizedResourceStore();
  const objects = new InMemoryPrivateObjectStore();
  const cdn = new DeterministicCdnInvalidator(NOW);
  return {
    cdn,
    objects,
    resources,
    service: createService(resources, objects, cdn),
  };
}

function createService(
  resources: InMemoryAuthorizedResourceStore,
  objects: InMemoryPrivateObjectStore,
  cdn: DeterministicCdnInvalidator,
) {
  return new PrivateResourceDeletionService({
    cdn,
    clock: new FixedClock(NOW),
    objects,
    resources,
    signer: createAlibabaTypeASigner({
      activeKey: {
        keyVersion: "fixture-v1",
        source: "kms-secrets-manager",
        value: "fixture-private-key-material".repeat(2),
      },
      cdnOrigin: "https://assets.reflo.example",
      randomValue: () => "477b3bbc253f467b8def6711128c7bec",
    }),
  });
}
