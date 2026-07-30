import { createHash } from "node:crypto";

import type { RefloOssClient } from "@reflo/asset-delivery";
import type {
  AudioArtifactWriteResult,
  AudioArtifactWriterPort,
} from "@reflo/audio";

export class AliOssAudioArtifactWriter implements AudioArtifactWriterPort {
  constructor(private readonly client: RefloOssClient) {}

  async putImmutable(input: {
    readonly bytes: Uint8Array;
    readonly contentSha256: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<AudioArtifactWriteResult> {
    assertWrite(input);
    try {
      const result = await this.client.put(input.objectKey, input.bytes, {
        headers: {
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-reflo-idempotency": input.idempotencyKey,
          "x-oss-meta-reflo-sha256": input.contentSha256,
        },
        mime: "audio/wav",
      });
      if (result.res.status !== 200) {
        throw new Error("OSS audio write failed");
      }
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const current = await this.client.head(input.objectKey);
      if (
        current.res.status !== 200 ||
        responseLength(current) !== input.bytes.byteLength ||
        String(current.meta?.["reflo-sha256"] ?? "") !== input.contentSha256 ||
        String(current.meta?.["reflo-idempotency"] ?? "") !==
          input.idempotencyKey
      ) {
        throw new Error("immutable OSS audio identity mismatch");
      }
    }
    return {
      byteSize: input.bytes.byteLength,
      contentType: "audio/wav",
      etag: input.contentSha256,
      objectKey: input.objectKey,
    };
  }
}

function assertWrite(input: {
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly idempotencyKey: string;
  readonly objectKey: string;
}): void {
  if (
    input.bytes.byteLength <= 44 ||
    input.bytes.byteLength > 32 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(input.contentSha256) ||
    sha256(input.bytes) !== input.contentSha256 ||
    !/^[a-zA-Z0-9_./-]{8,512}$/.test(input.idempotencyKey) ||
    !/^owners\/[0-9a-f-]{36}\/courses\/[0-9a-f-]{36}\/assets\/[0-9a-f-]{36}\/generations\/[0-9a-f-]{36}\/audio\.wav$/.test(
      input.objectKey,
    )
  ) {
    throw new Error("immutable OSS audio input is invalid");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "FileAlreadyExists"
  );
}

function responseLength(result: {
  readonly res: {
    readonly headers?: Readonly<Record<string, string | undefined>>;
    readonly size?: number;
  };
}): number {
  const value = result.res.size ?? result.res.headers?.["content-length"];
  return typeof value === "number" ? value : Number(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
