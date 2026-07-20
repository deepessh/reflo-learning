import { describe, expect, it } from "vitest";

import {
  assertPrivateDeliveryConfiguration,
  type PrivateDeliveryConfiguration,
} from "./configuration.js";

const VALID_CONFIGURATION: PrivateDeliveryConfiguration = {
  cdn: {
    authentication: "type-a",
    cacheKeyExcludesAuthKey: true,
    forcedPurgeEnabled: true,
    httpsOnly: true,
    rangeRequestsEnabled: true,
    rotationMode: "primary-secondary",
    signedUrlLogsRedacted: true,
    ttlSeconds: 900,
  },
  deliveryBucket: {
    acl: "private",
    blockPublicAccess: true,
    bucketName: "reflo-dev-delivery",
    cdnOriginAccess: true,
    cdnOriginReadOnly: true,
  },
  deliveryBucketContainsOnlyClientDeliverables: true,
  quarantineBucket: {
    acl: "private",
    blockPublicAccess: true,
    bucketName: "reflo-dev-quarantine",
    cdnOriginAccess: false,
    cdnOriginReadOnly: false,
  },
};

describe("private delivery configuration", () => {
  it("accepts an isolated private delivery-only origin", () => {
    expect(() =>
      assertPrivateDeliveryConfiguration(VALID_CONFIGURATION),
    ).not.toThrow();
  });

  it.each([
    {
      ...VALID_CONFIGURATION,
      deliveryBucket: {
        ...VALID_CONFIGURATION.deliveryBucket,
        acl: "public-read" as const,
      },
    },
    {
      ...VALID_CONFIGURATION,
      quarantineBucket: {
        ...VALID_CONFIGURATION.quarantineBucket,
        cdnOriginAccess: true,
      },
    },
    {
      ...VALID_CONFIGURATION,
      cdn: { ...VALID_CONFIGURATION.cdn, ttlSeconds: 3_600 },
    },
    {
      ...VALID_CONFIGURATION,
      cdn: { ...VALID_CONFIGURATION.cdn, cacheKeyExcludesAuthKey: false },
    },
    {
      ...VALID_CONFIGURATION,
      deliveryBucketContainsOnlyClientDeliverables: false,
    },
    {
      ...VALID_CONFIGURATION,
      quarantineBucket: {
        ...VALID_CONFIGURATION.quarantineBucket,
        bucketName: VALID_CONFIGURATION.deliveryBucket.bucketName,
      },
    },
  ])(
    "rejects a configuration that weakens a required control",
    (configuration) => {
      expect(() => assertPrivateDeliveryConfiguration(configuration)).toThrow(
        "configuration is invalid",
      );
    },
  );
});
