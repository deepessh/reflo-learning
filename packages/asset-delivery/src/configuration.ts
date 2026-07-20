import { SIGNED_URL_TTL_SECONDS } from "./contracts.js";
import { PrivateDeliveryError } from "./errors.js";

export interface PrivateBucketPolicy {
  readonly acl: "private" | "public-read" | "public-read-write";
  readonly blockPublicAccess: boolean;
  readonly bucketName: string;
  readonly cdnOriginAccess: boolean;
  readonly cdnOriginReadOnly: boolean;
}

export interface PrivateDeliveryConfiguration {
  readonly cdn: {
    readonly authentication: "type-a" | "none";
    readonly cacheKeyExcludesAuthKey: boolean;
    readonly forcedPurgeEnabled: boolean;
    readonly httpsOnly: boolean;
    readonly rangeRequestsEnabled: boolean;
    readonly rotationMode: "primary-secondary" | "single-key";
    readonly signedUrlLogsRedacted: boolean;
    readonly ttlSeconds: number;
  };
  readonly deliveryBucket: PrivateBucketPolicy;
  readonly deliveryBucketContainsOnlyClientDeliverables: boolean;
  readonly quarantineBucket: PrivateBucketPolicy;
}

export function assertPrivateDeliveryConfiguration(
  configuration: PrivateDeliveryConfiguration,
): void {
  const violations: string[] = [];
  const { cdn, deliveryBucket, quarantineBucket } = configuration;

  if (deliveryBucket.bucketName === quarantineBucket.bucketName) {
    violations.push("bucket_isolation");
  }
  if (deliveryBucket.acl !== "private" || !deliveryBucket.blockPublicAccess) {
    violations.push("delivery_bucket_private");
  }
  if (!configuration.deliveryBucketContainsOnlyClientDeliverables) {
    violations.push("delivery_bucket_contents");
  }
  if (!deliveryBucket.cdnOriginAccess || !deliveryBucket.cdnOriginReadOnly) {
    violations.push("delivery_origin_read_only");
  }
  if (
    quarantineBucket.acl !== "private" ||
    !quarantineBucket.blockPublicAccess
  ) {
    violations.push("quarantine_bucket_private");
  }
  if (quarantineBucket.cdnOriginAccess) {
    violations.push("quarantine_not_cdn_accessible");
  }
  if (
    cdn.authentication !== "type-a" ||
    cdn.ttlSeconds !== SIGNED_URL_TTL_SECONDS ||
    !cdn.cacheKeyExcludesAuthKey ||
    cdn.rotationMode !== "primary-secondary"
  ) {
    violations.push("cdn_signing");
  }
  if (!cdn.httpsOnly || !cdn.rangeRequestsEnabled) {
    violations.push("cdn_transport");
  }
  if (!cdn.signedUrlLogsRedacted || !cdn.forcedPurgeEnabled) {
    violations.push("cdn_lifecycle");
  }

  if (violations.length > 0) {
    throw new PrivateDeliveryError("configuration_invalid");
  }
}
