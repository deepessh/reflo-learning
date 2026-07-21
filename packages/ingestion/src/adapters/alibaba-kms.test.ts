import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ALIBABA_KMS_SNAPSHOT_SIGNING_API,
  AlibabaKmsSnapshotDigestSigner,
  createAlibabaKmsSnapshotDigestSigner,
  snapshotManifestDigest,
  type AlibabaKmsAsymmetricSignClient,
} from "./alibaba-kms.js";

const KEY = {
  keyId: "5c438b18-05be-40ad-b6c2-3be675200001",
  keyVersionId: "2ab1a983-7072-4bbc-a582-584b5bd800001",
};

describe("Alibaba KMS ClamAV snapshot signer", () => {
  it("constructs the VPC client with an ECS RAM-role provider without a network call", () => {
    expect(() =>
      createAlibabaKmsSnapshotDigestSigner({
        ...KEY,
        ramRoleName: "reflo-clamav-snapshot-publisher",
        region: "cn-shanghai",
      }),
    ).not.toThrow();
  });

  it("freezes AsymmetricSign 2016-01-20 to one SHA-256 DIGEST request", async () => {
    const payload = Buffer.from('{"contractVersion":"snapshot-manifest-v1"}');
    const digest = snapshotManifestDigest(payload);
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signature = sign("sha256", payload, {
      dsaEncoding: "der",
      key: keys.privateKey,
    });
    const asymmetricSign = vi.fn().mockResolvedValue({
      body: {
        ...KEY,
        requestId: "request-12345678",
        value: signature.toString("base64"),
      },
    });
    const signer = new AlibabaKmsSnapshotDigestSigner({ asymmetricSign }, KEY);

    await expect(signer.signDigest({ digest, payload })).resolves.toEqual({
      providerKeyId: KEY.keyId,
      providerKeyVersionId: KEY.keyVersionId,
      providerRequestId: "request-12345678",
      signature,
    });
    expect(ALIBABA_KMS_SNAPSHOT_SIGNING_API).toEqual({
      algorithm: "ECDSA_SHA_256",
      messagePath: "DIGEST",
      operation: "AsymmetricSign",
      version: "2016-01-20",
    });
    expect(asymmetricSign.mock.calls[0]?.[0]).toMatchObject({
      algorithm: "ECDSA_SHA_256",
      digest: digest.toString("base64"),
      dryRun: "false",
      ...KEY,
    });
  });

  it("rejects a mismatched digest before calling KMS", async () => {
    const client: AlibabaKmsAsymmetricSignClient = {
      asymmetricSign: vi.fn(),
    };
    const signer = new AlibabaKmsSnapshotDigestSigner(client, KEY);
    await expect(
      signer.signDigest({
        digest: createHash("sha256").update("other").digest(),
        payload: Buffer.from("manifest"),
      }),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
    expect(client.asymmetricSign).not.toHaveBeenCalled();
  });

  it("fails closed on key drift, malformed DER, and provider errors", async () => {
    const payload = Buffer.from("manifest");
    const digest = snapshotManifestDigest(payload);
    for (const response of [
      {
        body: {
          ...KEY,
          keyVersionId: "unexpected-version",
          requestId: "request-12345678",
          value: Buffer.from("not-der").toString("base64"),
        },
      },
      new Error("provider payload with secret material"),
    ]) {
      const client = {
        asymmetricSign:
          response instanceof Error
            ? vi.fn().mockRejectedValue(response)
            : vi.fn().mockResolvedValue(response),
      };
      const signer = new AlibabaKmsSnapshotDigestSigner(client, KEY);
      const error = await signer
        .signDigest({ digest, payload })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "infrastructure_unavailable" });
      expect(JSON.stringify(error)).not.toContain("secret material");
    }
  });
});
