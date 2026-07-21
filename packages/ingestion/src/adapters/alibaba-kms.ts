import { createHash, timingSafeEqual } from "node:crypto";

import * as CredentialModule from "@alicloud/credentials";
import { ECSRAMRoleCredentialsProvider } from "@alicloud/credentials";
import * as KmsModule from "@alicloud/kms20160120";
import { AsymmetricSignRequest } from "@alicloud/kms20160120";

import { IngestionError } from "../errors.js";
import { decodeStrictPaddedBase64P256Der } from "./clamav-signature.js";

export const ALIBABA_KMS_SNAPSHOT_SIGNING_API = Object.freeze({
  algorithm: "ECDSA_SHA_256",
  messagePath: "DIGEST",
  operation: "AsymmetricSign",
  version: "2016-01-20",
});

export interface AlibabaKmsAsymmetricSignClient {
  asymmetricSign(request: AsymmetricSignRequest): Promise<{
    readonly body?: {
      readonly keyId?: string;
      readonly keyVersionId?: string;
      readonly requestId?: string;
      readonly value?: string;
    };
  }>;
}

export interface SnapshotDigestSignature {
  readonly providerKeyId: string;
  readonly providerKeyVersionId: string;
  readonly providerRequestId: string;
  readonly signature: Uint8Array;
}

export interface SnapshotDigestSignerPort {
  signDigest(input: {
    readonly digest: Uint8Array;
    readonly payload: Uint8Array;
  }): Promise<SnapshotDigestSignature>;
}

export interface AlibabaKmsSnapshotSignerConfig {
  readonly keyId: string;
  readonly keyVersionId: string;
  readonly ramRoleName: string;
  readonly region: string;
}

/** Connected maintenance-only adapter for KMS 2016-01-20 AsymmetricSign. */
export class AlibabaKmsSnapshotDigestSigner implements SnapshotDigestSignerPort {
  constructor(
    private readonly client: AlibabaKmsAsymmetricSignClient,
    private readonly key: Pick<
      AlibabaKmsSnapshotSignerConfig,
      "keyId" | "keyVersionId"
    >,
  ) {
    assertExactKey(key);
  }

  async signDigest(input: {
    readonly digest: Uint8Array;
    readonly payload: Uint8Array;
  }): Promise<SnapshotDigestSignature> {
    const expectedDigest = snapshotManifestDigest(input.payload);
    if (
      input.digest.byteLength !== 32 ||
      !timingSafeEqual(expectedDigest, input.digest)
    ) {
      throw unavailable();
    }
    const request = new AsymmetricSignRequest({
      algorithm: ALIBABA_KMS_SNAPSHOT_SIGNING_API.algorithm,
      digest: Buffer.from(input.digest).toString("base64"),
      dryRun: "false",
      keyId: this.key.keyId,
      keyVersionId: this.key.keyVersionId,
    });
    try {
      const response = await this.client.asymmetricSign(request);
      const body = response.body;
      const signature =
        typeof body?.value === "string"
          ? decodeStrictPaddedBase64P256Der(body.value)
          : null;
      if (
        body?.keyId !== this.key.keyId ||
        body.keyVersionId !== this.key.keyVersionId ||
        typeof body.requestId !== "string" ||
        !/^[A-Za-z0-9-]{8,128}$/.test(body.requestId) ||
        signature === null
      ) {
        throw unavailable();
      }
      return {
        providerKeyId: body.keyId,
        providerKeyVersionId: body.keyVersionId,
        providerRequestId: body.requestId,
        signature,
      };
    } catch (error) {
      if (error instanceof IngestionError) {
        throw error;
      }
      // Provider payloads may contain identifiers or request details. Do not
      // retain the original error as a cause or diagnostic field.
      throw unavailable();
    }
  }
}

export function createAlibabaKmsSnapshotDigestSigner(
  config: AlibabaKmsSnapshotSignerConfig,
): AlibabaKmsSnapshotDigestSigner {
  assertExactKey(config);
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(config.ramRoleName) ||
    !/^[a-z0-9-]{3,32}$/.test(config.region)
  ) {
    throw unavailable();
  }
  const provider = ECSRAMRoleCredentialsProvider.builder()
    .withRoleName(config.ramRoleName)
    .withDisableIMDSv1(true)
    .withConnectTimeout(1_000)
    .withReadTimeout(1_000)
    .build();
  const CredentialClient =
    cjsDefault<new (config: null, credentialProvider: object) => object>(
      CredentialModule,
    );
  const KmsClient =
    cjsDefault<
      new (config: {
        credential: object;
        endpoint: string;
        protocol: string;
        regionId: string;
      }) => AlibabaKmsAsymmetricSignClient
    >(KmsModule);
  const credential = new CredentialClient(null, provider);
  const client = new KmsClient({
    credential,
    endpoint: `kms-vpc.${config.region}.aliyuncs.com`,
    protocol: "https",
    regionId: config.region,
  });
  return new AlibabaKmsSnapshotDigestSigner(client, config);
}

export function snapshotManifestDigest(payload: Uint8Array): Buffer {
  return createHash("sha256").update(payload).digest();
}

function assertExactKey(
  key: Pick<AlibabaKmsSnapshotSignerConfig, "keyId" | "keyVersionId">,
): void {
  if (
    !/^[A-Za-z0-9-]{8,128}$/.test(key.keyId) ||
    !/^[A-Za-z0-9-]{8,128}$/.test(key.keyVersionId)
  ) {
    throw unavailable();
  }
}

function cjsDefault<Value>(module: unknown): Value {
  const first = (module as { default?: unknown }).default ?? module;
  return ((first as { default?: unknown }).default ?? first) as Value;
}

function unavailable(): IngestionError {
  return new IngestionError("infrastructure_unavailable");
}
