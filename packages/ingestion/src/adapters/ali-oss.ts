import { IngestionError } from "../errors.js";
import type {
  InternalArtifactObjectPort,
  QuarantineDownloadPort,
} from "../ports.js";

interface AliOssResponse {
  readonly status: number;
}

interface AliOssGetResult {
  readonly content: Uint8Array;
  readonly res: AliOssResponse;
}

interface AliOssHeadResult {
  readonly meta?: Readonly<Record<string, string>>;
  readonly res: AliOssResponse & {
    readonly headers?: Readonly<Record<string, string | undefined>>;
    readonly size?: number;
  };
}

interface AliOssPutResult {
  readonly res: AliOssResponse;
}

/** Narrow surface implemented by ali-oss 6.x without leaking its types. */
export interface AliOssObjectClient {
  get(objectKey: string): Promise<AliOssGetResult>;
  head(objectKey: string): Promise<AliOssHeadResult>;
  put(
    objectKey: string,
    bytes: Uint8Array,
    options: {
      readonly headers: Readonly<Record<string, string>>;
      readonly mime: string;
    },
  ): Promise<AliOssPutResult>;
}

export class AliOssQuarantineDownloadAdapter implements QuarantineDownloadPort {
  constructor(private readonly client: AliOssObjectClient) {}

  async getObject(input: {
    readonly maximumBytes: number;
    readonly objectKey: string;
  }): Promise<{ readonly bytes: Uint8Array; readonly objectKey: string }> {
    assertObjectKey(input.objectKey);
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
      throw unavailable();
    }
    try {
      const head = await this.client.head(input.objectKey);
      const length = responseLength(head);
      if (
        head.res.status !== 200 ||
        length < 1 ||
        length > input.maximumBytes
      ) {
        throw unavailable();
      }
      const result = await this.client.get(input.objectKey);
      if (
        result.res.status !== 200 ||
        !(result.content instanceof Uint8Array) ||
        result.content.byteLength !== length ||
        result.content.byteLength > input.maximumBytes
      ) {
        throw unavailable();
      }
      return { bytes: result.content, objectKey: input.objectKey };
    } catch (error) {
      if (error instanceof IngestionError) {
        throw error;
      }
      throw unavailable();
    }
  }
}

export class AliOssInternalArtifactAdapter implements InternalArtifactObjectPort {
  constructor(private readonly client: AliOssObjectClient) {}

  async putIfAbsent(input: {
    readonly bytes: Uint8Array;
    readonly objectKey: string;
    readonly sha256: string;
  }): Promise<{
    readonly byteLength: number;
    readonly objectKey: string;
    readonly sha256: string;
  }> {
    assertObjectKey(input.objectKey);
    if (input.bytes.byteLength < 1 || !/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw unavailable();
    }
    try {
      const result = await this.client.put(input.objectKey, input.bytes, {
        headers: {
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-reflo-sha256": input.sha256,
        },
        mime: "application/json",
      });
      if (result.res.status !== 200) {
        throw unavailable();
      }
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw unavailable();
      }
      try {
        const head = await this.client.head(input.objectKey);
        if (
          head.res.status !== 200 ||
          responseLength(head) !== input.bytes.byteLength ||
          head.meta?.["reflo-sha256"] !== input.sha256
        ) {
          throw unavailable();
        }
      } catch (headError) {
        if (headError instanceof IngestionError) {
          throw headError;
        }
        throw unavailable();
      }
    }
    return {
      byteLength: input.bytes.byteLength,
      objectKey: input.objectKey,
      sha256: input.sha256,
    };
  }
}

function responseLength(result: AliOssHeadResult): number {
  const value = result.res.size ?? result.res.headers?.["content-length"];
  const length = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(length) ? length : -1;
}

function assertObjectKey(objectKey: string): void {
  if (
    objectKey.length < 1 ||
    objectKey.length > 1_024 ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw unavailable();
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

function unavailable(): IngestionError {
  return new IngestionError("infrastructure_unavailable");
}
