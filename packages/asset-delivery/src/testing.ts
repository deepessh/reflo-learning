import type {
  AuthorizedDeliveryResource,
  DeliveryRequest,
  PrivateResourceReference,
} from "./contracts.js";
import type {
  AuthorizedResourceStore,
  CdnInvalidationPort,
  Clock,
  PrivateObjectStorePort,
  VerifiedCdnPurge,
} from "./ports.js";

export class FixedClock implements Clock {
  constructor(private readonly value: Date) {}

  now(): Date {
    return new Date(this.value);
  }
}

export class MutableClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: Date): void {
    this.value = new Date(value);
  }
}

export class InMemoryAuthorizedResourceStore implements AuthorizedResourceStore {
  readonly #memberships = new Set<string>();
  readonly #resources = new Map<string, AuthorizedDeliveryResource>();

  addMembership(actorId: string, ownerScopeId: string): void {
    this.#memberships.add(`${actorId}:${ownerScopeId}`);
  }

  revokeMembership(actorId: string, ownerScopeId: string): void {
    this.#memberships.delete(`${actorId}:${ownerScopeId}`);
  }

  addResource(resource: AuthorizedDeliveryResource): void {
    this.#resources.set(referenceKey(resource.reference), resource);
  }

  getState(
    reference: PrivateResourceReference,
  ): AuthorizedDeliveryResource["deliveryState"] | undefined {
    return this.#resources.get(referenceKey(reference))?.deliveryState;
  }

  async resolveForDelivery(
    request: DeliveryRequest,
  ): Promise<AuthorizedDeliveryResource | null> {
    const resource = this.#authorizedResource(request);
    return resource?.deliveryState === "deliverable" ? resource : null;
  }

  async tombstoneForDeletion(
    request: DeliveryRequest,
  ): Promise<AuthorizedDeliveryResource | null> {
    const resource = this.#authorizedResource(request);
    if (resource === null || resource.deliveryState === "purged") {
      return null;
    }
    const tombstoned = { ...resource, deliveryState: "tombstoned" as const };
    this.#resources.set(referenceKey(resource.reference), tombstoned);
    return tombstoned;
  }

  async markPurged(input: {
    readonly completedAt: Date;
    readonly purgeRequestId: string;
    readonly resource: PrivateResourceReference;
  }): Promise<void> {
    const key = referenceKey(input.resource);
    const resource = this.#resources.get(key);
    if (resource === undefined || resource.deliveryState !== "tombstoned") {
      throw new Error("resource must be tombstoned before purge completion");
    }
    this.#resources.set(key, { ...resource, deliveryState: "purged" });
  }

  #authorizedResource(
    request: DeliveryRequest,
  ): AuthorizedDeliveryResource | null {
    const resource = this.#resources.get(referenceKey(request.resource));
    if (
      resource === undefined ||
      !this.#memberships.has(`${request.actorId}:${resource.ownerScopeId}`)
    ) {
      return null;
    }
    return resource;
  }
}

export class InMemoryPrivateObjectStore implements PrivateObjectStorePort {
  readonly #objects = new Set<string>();
  readonly deletedKeys: string[] = [];

  add(objectKey: string): void {
    this.#objects.add(objectKey);
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.deletedKeys.push(objectKey);
    this.#objects.delete(objectKey);
  }

  async objectExists(objectKey: string): Promise<boolean> {
    return this.#objects.has(objectKey);
  }
}

export class DeterministicCdnInvalidator implements CdnInvalidationPort {
  readonly purgedUrls: string[] = [];

  constructor(
    private readonly completedAt: Date,
    private readonly verified = true,
  ) {}

  async purgeAndWait(unsignedCanonicalUrl: string): Promise<VerifiedCdnPurge> {
    this.purgedUrls.push(unsignedCanonicalUrl);
    if (!this.verified) {
      throw new Error("purge did not complete");
    }
    return {
      completedAt: new Date(this.completedAt),
      purgeRequestId: `purge-${this.purgedUrls.length}`,
      verified: true,
    };
  }
}

function referenceKey(reference: PrivateResourceReference): string {
  return reference.kind === "asset"
    ? `asset:${reference.assetId}`
    : `source:${reference.sourceDocumentId}`;
}
