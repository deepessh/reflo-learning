export const PRIVATE_DELIVERY_CONTRACT_VERSION = "private-delivery-v1" as const;
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

export type PrivateResourceReference =
  | {
      readonly kind: "source";
      readonly sourceDocumentId: string;
    }
  | {
      readonly assetId: string;
      readonly kind: "asset";
    };

export interface AuthorizedDeliveryResource {
  readonly byteSize: number;
  readonly contentType: string;
  readonly courseId?: string;
  readonly deliveryState: "deliverable" | "tombstoned" | "purged";
  readonly etag: string;
  readonly objectKey: string;
  readonly ownerScopeId: string;
  readonly reference: PrivateResourceReference;
}

export interface DeliveryRequest {
  readonly actorId: string;
  readonly resource: PrivateResourceReference;
}

export interface AuthorizedDelivery {
  readonly contractVersion: typeof PRIVATE_DELIVERY_CONTRACT_VERSION;
  readonly expiresAt: string;
  readonly metadata: {
    readonly byteSize: number;
    readonly contentType: string;
    readonly etag: string;
    readonly resourceId: string;
    readonly resourceKind: PrivateResourceReference["kind"];
  };
  readonly playback: {
    readonly acceptsByteRanges: true;
    readonly cacheControl: "private, no-store, max-age=0";
    readonly refreshOnForbidden: true;
    readonly resumeSupported: true;
  };
  readonly url: string;
}

export interface VerifiedDeletionOutcome {
  readonly completedAt: string;
  readonly objectsAbsent: 1;
  readonly purgesVerified: 1;
}
