import type {
  AuthorizedDeliveryResource,
  DeliveryRequest,
  PrivateResourceReference,
} from "./contracts.js";

export interface AuthorizedResourceStore {
  /**
   * Resolves identity, active membership, ownership, retention, and readiness in
   * one authoritative operation. A missing or unauthorized resource returns null.
   */
  resolveForDelivery(
    request: DeliveryRequest,
  ): Promise<AuthorizedDeliveryResource | null>;

  /**
   * Authorizes the mutation and atomically tombstones the resource before any
   * provider-side deletion occurs. A tombstoned retry returns the same target.
   */
  tombstoneForDeletion(
    request: DeliveryRequest,
  ): Promise<AuthorizedDeliveryResource | null>;

  markPurged(input: {
    readonly completedAt: Date;
    readonly purgeRequestId: string;
    readonly resource: PrivateResourceReference;
  }): Promise<void>;
}

export interface CdnSignedUrl {
  readonly expiresAt: Date;
  readonly url: string;
}

export interface CdnSigningPort {
  canonicalUrl(canonicalPath: string): string;
  sign(canonicalPath: string, issuedAt: Date): CdnSignedUrl;
}

export interface PrivateObjectStorePort {
  deleteObject(objectKey: string): Promise<void>;
  objectExists(objectKey: string): Promise<boolean>;
}

export interface VerifiedCdnPurge {
  readonly completedAt: Date;
  readonly purgeRequestId: string;
  readonly verified: true;
}

export interface CdnInvalidationPort {
  /** Returns only after the provider reports forced purge completion. */
  purgeAndWait(unsignedCanonicalUrl: string): Promise<VerifiedCdnPurge>;
}

export interface Clock {
  now(): Date;
}
