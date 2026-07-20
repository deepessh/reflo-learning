import { describe, expect, it } from "vitest";

import { buildAssetObjectKey } from "../object-keys.js";
import {
  computeAlibabaTypeASignature,
  createAlibabaTypeASigner,
  redactSignedUrl,
  verifyAlibabaTypeAUrl,
} from "./alibaba-type-a.js";

const ISSUED_AT = new Date("2026-07-20T12:00:00.000Z");
const ORIGIN = "https://assets.reflo.example";
const PRIMARY_KEY = "p".repeat(48);
const SECONDARY_KEY = "s".repeat(48);
const RANDOM = "477b3bbc253f467b8def6711128c7bec";
const OBJECT_KEY = buildAssetObjectKey({
  assetId: "50000000-0000-4000-8000-000000000005",
  courseId: "40000000-0000-4000-8000-000000000004",
  extension: "mp3",
  generationId: "60000000-0000-4000-8000-000000000006",
  ownerScopeId: "10000000-0000-4000-8000-000000000001",
});

describe("Alibaba CDN Type A signing adapter", () => {
  it("matches Alibaba's published signing vector", () => {
    expect(
      computeAlibabaTypeASignature({
        canonicalPath: "/video/standard/test.mp4",
        privateKey: "aliyuncdnexp1234",
        random: "0",
        timestamp: 1_444_435_200,
      }),
    ).toBe("23bf85053008f5c0e791667a313e28ce");
  });

  it("mints a 15-minute HTTPS bearer URL and validates replay only within its TTL", () => {
    const signer = createAlibabaTypeASigner({
      activeKey: {
        keyVersion: "kms-primary-v1",
        source: "kms-secrets-manager",
        value: PRIMARY_KEY,
      },
      cdnOrigin: ORIGIN,
      randomValue: () => RANDOM,
    });
    const signed = signer.sign(`/${OBJECT_KEY}`, ISSUED_AT);

    expect(signed.expiresAt).toEqual(
      new Date(ISSUED_AT.getTime() + 15 * 60 * 1_000),
    );
    expect(new URL(signed.url).protocol).toBe("https:");
    const verification = {
      expectedOrigin: ORIGIN,
      now: new Date(ISSUED_AT.getTime() + 14 * 60 * 1_000),
      signingKeys: [PRIMARY_KEY],
      url: signed.url,
    };
    expect(verifyAlibabaTypeAUrl(verification)).toBe(true);
    expect(verifyAlibabaTypeAUrl(verification)).toBe(true);
    expect(
      verifyAlibabaTypeAUrl({
        ...verification,
        now: signed.expiresAt,
      }),
    ).toBe(false);
    expect(
      verifyAlibabaTypeAUrl({
        expectedOrigin: ORIGIN,
        now: ISSUED_AT,
        signingKeys: [SECONDARY_KEY],
        url: signer.canonicalUrl(`/${OBJECT_KEY}`),
      }),
    ).toBe(false);
  });

  it("rejects tampering and supports primary/secondary rotation overlap", () => {
    const signer = createAlibabaTypeASigner({
      activeKey: {
        keyVersion: "kms-secondary-v2",
        source: "kms-secrets-manager",
        value: SECONDARY_KEY,
      },
      cdnOrigin: ORIGIN,
      randomValue: () => RANDOM,
    });
    const signed = signer.sign(`/${OBJECT_KEY}`, ISSUED_AT);

    expect(
      verifyAlibabaTypeAUrl({
        expectedOrigin: ORIGIN,
        now: ISSUED_AT,
        signingKeys: [PRIMARY_KEY, SECONDARY_KEY],
        url: signed.url,
      }),
    ).toBe(true);
    expect(
      verifyAlibabaTypeAUrl({
        expectedOrigin: ORIGIN,
        now: ISSUED_AT,
        signingKeys: [PRIMARY_KEY],
        url: signed.url,
      }),
    ).toBe(false);
    expect(
      verifyAlibabaTypeAUrl({
        expectedOrigin: ORIGIN,
        now: ISSUED_AT,
        signingKeys: [PRIMARY_KEY, SECONDARY_KEY],
        url: signed.url.replace("payload.mp3", "payload.mp4"),
      }),
    ).toBe(false);
  });

  it("fails closed for unsafe origins, weak secrets, and invalid random values", () => {
    expect(() =>
      createAlibabaTypeASigner({
        activeKey: {
          keyVersion: "kms-primary-v1",
          source: "kms-secrets-manager",
          value: "short",
        },
        cdnOrigin: ORIGIN,
      }),
    ).toThrow("configuration is invalid");
    expect(() =>
      createAlibabaTypeASigner({
        activeKey: {
          keyVersion: "kms-primary-v1",
          source: "kms-secrets-manager",
          value: PRIMARY_KEY,
        },
        cdnOrigin: "http://assets.reflo.example",
      }),
    ).toThrow("configuration is invalid");

    const signer = createAlibabaTypeASigner({
      activeKey: {
        keyVersion: "kms-primary-v1",
        source: "kms-secrets-manager",
        value: PRIMARY_KEY,
      },
      cdnOrigin: ORIGIN,
      randomValue: () => "request-user@example.com",
    });
    expect(() => signer.sign(`/${OBJECT_KEY}`, ISSUED_AT)).toThrow(
      "signing is unavailable",
    );
  });

  it("redacts the bearer query from diagnostics", () => {
    expect(
      redactSignedUrl(
        `${ORIGIN}/${OBJECT_KEY}?auth_key=secret-signature&tracking=also-secret`,
      ),
    ).toBe(`${ORIGIN}/${OBJECT_KEY}`);
    expect(redactSignedUrl("not a URL")).toBe(
      "[REDACTED_PRIVATE_DELIVERY_URL]",
    );
  });
});
