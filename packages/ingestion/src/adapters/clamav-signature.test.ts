import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
  decodeStrictPaddedBase64P256Der,
  isCanonicalP256DerSignature,
  PinnedP256SnapshotSignatureVerifier,
} from "./clamav-signature.js";

describe("clamav-snapshot-signature-v1", () => {
  it("verifies exact bytes with a pinned P-256 SPKI", async () => {
    const fixture = keyFixture("active-v1");
    const payload = Buffer.from('{"contractVersion":"snapshot-manifest-v1"}');
    const signature = sign("sha256", payload, {
      dsaEncoding: "der",
      key: fixture.privateKey,
    });
    const verifier = new PinnedP256SnapshotSignatureVerifier([fixture.pin]);

    await expect(
      verifier.verify({
        kid: fixture.pin.kid,
        payload,
        profile: CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
        publicKeySpkiSha256: fixture.pin.spkiSha256,
        signature,
      }),
    ).resolves.toBe(true);
    await expect(
      verifier.verify({
        kid: fixture.pin.kid,
        payload: Buffer.concat([payload, Buffer.from("\n")]),
        profile: CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
        publicKeySpkiSha256: fixture.pin.spkiSha256,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it("supports only the bounded old/new rotation overlap", async () => {
    const oldKey = keyFixture("old-v1");
    const newKey = keyFixture("new-v2");
    expect(
      () =>
        new PinnedP256SnapshotSignatureVerifier([
          oldKey.pin,
          newKey.pin,
          keyFixture("unexpected-third").pin,
        ]),
    ).toThrow();

    const verifier = new PinnedP256SnapshotSignatureVerifier([
      oldKey.pin,
      newKey.pin,
    ]);
    const payload = Buffer.from("rotation-vector", "utf8");
    for (const fixture of [oldKey, newKey]) {
      const signature = sign("sha256", payload, {
        dsaEncoding: "der",
        key: fixture.privateKey,
      });
      await expect(
        verifier.verify({
          kid: fixture.pin.kid,
          payload,
          profile: CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
          publicKeySpkiSha256: fixture.pin.spkiSha256,
          signature,
        }),
      ).resolves.toBe(true);
    }
  });

  it("rejects noncanonical Base64 and DER encodings", () => {
    const fixture = keyFixture("active-v1");
    const signature = sign("sha256", Buffer.from("vector"), {
      dsaEncoding: "der",
      key: fixture.privateKey,
    });
    const encoded = signature.toString("base64");
    expect(decodeStrictPaddedBase64P256Der(encoded)).toEqual(signature);
    expect(decodeStrictPaddedBase64P256Der(`${encoded}\n`)).toBeNull();
    expect(
      decodeStrictPaddedBase64P256Der(encoded.replace(/=+$/, "")),
    ).toBeNull();

    const trailing = Buffer.concat([signature, Buffer.from([0])]);
    expect(isCanonicalP256DerSignature(trailing)).toBe(false);
    const nonMinimal = Buffer.from([
      0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01,
    ]);
    expect(isCanonicalP256DerSignature(nonMinimal)).toBe(false);
  });

  it("rejects wrong curves and fingerprint drift", () => {
    const wrongCurve = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const wrongPem = wrongCurve.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const wrongDer = wrongCurve.publicKey.export({
      format: "der",
      type: "spki",
    });
    expect(
      () =>
        new PinnedP256SnapshotSignatureVerifier([
          {
            kid: "wrong-curve",
            spkiPem: wrongPem,
            spkiSha256: createHash("sha256").update(wrongDer).digest("hex"),
          },
        ]),
    ).toThrow();
    const valid = keyFixture("valid");
    expect(
      () =>
        new PinnedP256SnapshotSignatureVerifier([
          { ...valid.pin, spkiSha256: "0".repeat(64) },
        ]),
    ).toThrow();
  });
});

function keyFixture(kid: string) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  return {
    pin: {
      kid,
      spkiPem: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      spkiSha256: createHash("sha256").update(spki).digest("hex"),
    },
    privateKey: keys.privateKey,
  };
}
