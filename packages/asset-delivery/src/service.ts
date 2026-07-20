import {
  PRIVATE_DELIVERY_CONTRACT_VERSION,
  SIGNED_URL_TTL_SECONDS,
  type AuthorizedDelivery,
  type AuthorizedDeliveryResource,
  type DeliveryRequest,
  type PrivateResourceReference,
  type VerifiedDeletionOutcome,
} from "./contracts.js";
import { PrivateDeliveryError } from "./errors.js";
import {
  assertOpaqueId,
  assertResourceMatchesCanonicalKey,
  canonicalDeliveryPath,
} from "./object-keys.js";
import type {
  AuthorizedResourceStore,
  CdnInvalidationPort,
  CdnSigningPort,
  Clock,
  PrivateObjectStorePort,
} from "./ports.js";

export interface PrivateDeliveryDependencies {
  readonly clock: Clock;
  readonly resources: AuthorizedResourceStore;
  readonly signer: CdnSigningPort;
}

export class PrivateDeliveryService {
  readonly #clock: Clock;
  readonly #resources: AuthorizedResourceStore;
  readonly #signer: CdnSigningPort;

  constructor(dependencies: PrivateDeliveryDependencies) {
    this.#clock = dependencies.clock;
    this.#resources = dependencies.resources;
    this.#signer = dependencies.signer;
  }

  async authorize(request: DeliveryRequest): Promise<AuthorizedDelivery> {
    validateRequest(request);
    let resource;
    try {
      resource = await this.#resources.resolveForDelivery(request);
    } catch {
      throw new PrivateDeliveryError("authorization_unavailable");
    }
    if (resource === null || resource.deliveryState !== "deliverable") {
      throw new PrivateDeliveryError("not_found_or_forbidden");
    }
    assertResolvedReference(request.resource, resource);
    assertResourceMatchesCanonicalKey(resource);
    assertResourceMetadata(resource);

    const issuedAt = this.#clock.now();
    let canonicalUrl;
    let signed;
    try {
      canonicalUrl = this.#signer.canonicalUrl(
        canonicalDeliveryPath(resource.objectKey),
      );
      signed = this.#signer.sign(
        canonicalDeliveryPath(resource.objectKey),
        issuedAt,
      );
    } catch (error) {
      if (error instanceof PrivateDeliveryError) {
        throw error;
      }
      throw new PrivateDeliveryError("signing_unavailable");
    }
    assertGrantIntegrity(
      canonicalUrl,
      signed.url,
      signed.expiresAt,
      issuedAt,
      resource,
    );

    return {
      contractVersion: PRIVATE_DELIVERY_CONTRACT_VERSION,
      expiresAt: signed.expiresAt.toISOString(),
      metadata: {
        byteSize: resource.byteSize,
        contentType: resource.contentType,
        etag: resource.etag,
        resourceId: resourceId(resource.reference),
        resourceKind: resource.reference.kind,
      },
      playback: {
        acceptsByteRanges: true,
        cacheControl: "private, no-store, max-age=0",
        refreshOnForbidden: true,
        resumeSupported: true,
      },
      url: signed.url,
    };
  }
}

export interface PrivateDeletionDependencies {
  readonly cdn: CdnInvalidationPort;
  readonly clock: Clock;
  readonly objects: PrivateObjectStorePort;
  readonly resources: AuthorizedResourceStore;
  readonly signer: CdnSigningPort;
}

export class PrivateResourceDeletionService {
  readonly #cdn: CdnInvalidationPort;
  readonly #clock: Clock;
  readonly #objects: PrivateObjectStorePort;
  readonly #resources: AuthorizedResourceStore;
  readonly #signer: CdnSigningPort;

  constructor(dependencies: PrivateDeletionDependencies) {
    this.#cdn = dependencies.cdn;
    this.#clock = dependencies.clock;
    this.#objects = dependencies.objects;
    this.#resources = dependencies.resources;
    this.#signer = dependencies.signer;
  }

  async delete(request: DeliveryRequest): Promise<VerifiedDeletionOutcome> {
    validateRequest(request);
    let target;
    try {
      target = await this.#resources.tombstoneForDeletion(request);
    } catch {
      throw new PrivateDeliveryError("deletion_incomplete");
    }
    if (target === null || target.deliveryState === "purged") {
      throw new PrivateDeliveryError("not_found_or_forbidden");
    }
    assertResolvedReference(request.resource, target);
    assertResourceMatchesCanonicalKey(target);

    try {
      await this.#objects.deleteObject(target.objectKey);
    } catch {
      throw new PrivateDeliveryError("deletion_incomplete");
    }
    let objectExists;
    try {
      objectExists = await this.#objects.objectExists(target.objectKey);
    } catch {
      throw new PrivateDeliveryError("deletion_incomplete");
    }
    if (objectExists) {
      throw new PrivateDeliveryError("deletion_incomplete");
    }

    let canonicalUrl;
    let purge;
    try {
      canonicalUrl = this.#signer.canonicalUrl(
        canonicalDeliveryPath(target.objectKey),
      );
      assertUnsignedCanonicalUrl(canonicalUrl, target);
      purge = await this.#cdn.purgeAndWait(canonicalUrl);
    } catch (error) {
      throw error instanceof PrivateDeliveryError
        ? error
        : new PrivateDeliveryError("deletion_incomplete");
    }
    if (
      !purge.verified ||
      !Number.isFinite(purge.completedAt.getTime()) ||
      purge.completedAt > this.#clock.now() ||
      purge.purgeRequestId.length === 0
    ) {
      throw new PrivateDeliveryError("deletion_incomplete");
    }
    try {
      await this.#resources.markPurged({
        completedAt: purge.completedAt,
        purgeRequestId: purge.purgeRequestId,
        resource: target.reference,
      });
    } catch {
      throw new PrivateDeliveryError("deletion_incomplete");
    }

    return {
      completedAt: purge.completedAt.toISOString(),
      objectsAbsent: 1,
      purgesVerified: 1,
    };
  }
}

function validateRequest(request: DeliveryRequest): void {
  assertOpaqueId(request.actorId);
  assertOpaqueId(resourceId(request.resource));
}

function assertResolvedReference(
  requested: PrivateResourceReference,
  resolved: AuthorizedDeliveryResource,
): void {
  if (
    requested.kind !== resolved.reference.kind ||
    resourceId(requested) !== resourceId(resolved.reference)
  ) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
}

function assertResourceMetadata(resource: AuthorizedDeliveryResource): void {
  const contentTypePattern =
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
  if (
    !Number.isSafeInteger(resource.byteSize) ||
    resource.byteSize < 0 ||
    !contentTypePattern.test(resource.contentType) ||
    resource.etag.length === 0 ||
    resource.etag.length > 256 ||
    [...resource.etag].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
}

function assertGrantIntegrity(
  canonicalUrl: string,
  signedUrl: string,
  expiresAt: Date,
  issuedAt: Date,
  resource: AuthorizedDeliveryResource,
): void {
  let canonical;
  let url;
  try {
    canonical = new URL(canonicalUrl);
    url = new URL(signedUrl);
  } catch {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
  const expectedPath = canonicalDeliveryPath(resource.objectKey);
  if (
    url.protocol !== "https:" ||
    canonical.protocol !== "https:" ||
    url.origin !== canonical.origin ||
    canonical.pathname !== expectedPath ||
    canonical.search !== "" ||
    canonical.hash !== "" ||
    url.pathname !== expectedPath ||
    url.searchParams.get("auth_key") === null ||
    url.searchParams.getAll("auth_key").length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "auth_key") ||
    expiresAt.getTime() - Math.floor(issuedAt.getTime() / 1_000) * 1_000 !==
      SIGNED_URL_TTL_SECONDS * 1_000
  ) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
}

function assertUnsignedCanonicalUrl(
  canonicalUrl: string,
  resource: AuthorizedDeliveryResource,
): void {
  try {
    const url = new URL(canonicalUrl);
    if (
      url.protocol !== "https:" ||
      url.pathname !== canonicalDeliveryPath(resource.objectKey) ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new PrivateDeliveryError("integrity_check_failed");
    }
  } catch (error) {
    throw error instanceof PrivateDeliveryError
      ? error
      : new PrivateDeliveryError("integrity_check_failed");
  }
}

function resourceId(reference: PrivateResourceReference): string {
  return reference.kind === "asset"
    ? reference.assetId
    : reference.sourceDocumentId;
}
