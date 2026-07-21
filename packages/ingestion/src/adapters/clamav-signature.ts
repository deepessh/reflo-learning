import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

export const CLAMAV_SNAPSHOT_SIGNATURE_PROFILE =
  "clamav-snapshot-signature-v1" as const;

export interface ClamAvSnapshotPublicKeyPin {
  readonly kid: string;
  readonly spkiPem: string;
  readonly spkiSha256: string;
}

interface ValidatedPin {
  readonly key: KeyObject;
  readonly spkiSha256: string;
}

/** Offline, network-free verifier for the D-GH-96 snapshot profile. */
export class PinnedP256SnapshotSignatureVerifier {
  readonly #pins: ReadonlyMap<string, ValidatedPin>;

  constructor(pins: readonly ClamAvSnapshotPublicKeyPin[]) {
    if (pins.length < 1 || pins.length > 2) {
      throw new Error("ClamAV snapshot verification requires one or two pins");
    }
    const validated = new Map<string, ValidatedPin>();
    for (const pin of pins) {
      if (
        !/^[A-Za-z0-9._-]{1,128}$/.test(pin.kid) ||
        !/^[a-f0-9]{64}$/.test(pin.spkiSha256) ||
        validated.has(pin.kid)
      ) {
        throw new Error("Invalid ClamAV snapshot public-key pin");
      }
      const key = createPublicKey(pin.spkiPem);
      const details = key.asymmetricKeyDetails;
      const spki = key.export({ format: "der", type: "spki" });
      const fingerprint = createHash("sha256").update(spki).digest("hex");
      if (
        key.asymmetricKeyType !== "ec" ||
        details?.namedCurve !== "prime256v1" ||
        fingerprint !== pin.spkiSha256
      ) {
        throw new Error("ClamAV snapshot pin is not the declared P-256 key");
      }
      validated.set(pin.kid, { key, spkiSha256: fingerprint });
    }
    this.#pins = validated;
  }

  async verify(input: {
    readonly kid: string;
    readonly payload: Uint8Array;
    readonly profile: string;
    readonly publicKeySpkiSha256: string;
    readonly signature: Uint8Array;
  }): Promise<boolean> {
    const pin = this.#pins.get(input.kid);
    if (
      input.profile !== CLAMAV_SNAPSHOT_SIGNATURE_PROFILE ||
      pin === undefined ||
      pin.spkiSha256 !== input.publicKeySpkiSha256 ||
      !isCanonicalP256DerSignature(input.signature)
    ) {
      return false;
    }
    try {
      // The Alibaba publisher signs SHA-256(manifestBytes) through the DIGEST
      // API. Node hashes these original bytes exactly once before ECDSA verify.
      return verifySignature(
        "sha256",
        input.payload,
        { dsaEncoding: "der", key: pin.key },
        input.signature,
      );
    } catch {
      return false;
    }
  }
}

export function decodeStrictPaddedBase64P256Der(value: string): Buffer | null {
  if (
    value.length < 4 ||
    value.length > 128 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    !isCanonicalP256DerSignature(decoded)
  ) {
    return null;
  }
  return decoded;
}

export function isCanonicalP256DerSignature(signature: Uint8Array): boolean {
  if (
    signature.byteLength < 8 ||
    signature.byteLength > 72 ||
    signature[0] !== 0x30 ||
    signature[1] !== signature.byteLength - 2
  ) {
    return false;
  }
  const firstEnd = canonicalIntegerEnd(signature, 2);
  if (firstEnd === null) {
    return false;
  }
  const secondEnd = canonicalIntegerEnd(signature, firstEnd);
  return secondEnd === signature.byteLength;
}

function canonicalIntegerEnd(
  signature: Uint8Array,
  offset: number,
): number | null {
  if (signature[offset] !== 0x02) {
    return null;
  }
  const length = signature[offset + 1];
  const start = offset + 2;
  if (
    length === undefined ||
    length < 1 ||
    length > 33 ||
    start + length > signature.byteLength
  ) {
    return null;
  }
  const first = signature[start];
  const second = signature[start + 1];
  if (
    first === undefined ||
    (first === 0 &&
      (length === 1 || second === undefined || (second & 0x80) === 0)) ||
    (first !== 0 && (first & 0x80) !== 0)
  ) {
    return null;
  }
  return start + length;
}
