import { createHash } from "node:crypto";

import {
  createAliOssPrivateClient,
  type RefloOssClient,
} from "@reflo/asset-delivery";
import type {
  InternalArtifactObjectPort,
  QuarantineDownloadPort,
} from "@reflo/ingestion";
import {
  createEcsRamRoleCredentialLoader,
  IngestionError,
} from "@reflo/ingestion";

export type { RefloOssClient } from "@reflo/asset-delivery";

export interface ConnectedObjectStore
  extends InternalArtifactObjectPort, QuarantineDownloadPort {
  exists(objectKey: string): Promise<boolean>;
  putImmutable(input: {
    readonly content: string;
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<{
    readonly byteSize: number;
    readonly contentType: "text/markdown; charset=utf-8";
    readonly etag: string;
    readonly objectKey: string;
  }>;
  read(objectKey: string): Promise<Uint8Array>;
}

export class AliOssConnectedObjectStore implements ConnectedObjectStore {
  constructor(
    private readonly clients: {
      readonly artifacts: RefloOssClient;
      readonly delivery: RefloOssClient;
      readonly quarantine: RefloOssClient;
    },
  ) {}

  async putIfAbsent(input: {
    readonly bytes: Uint8Array;
    readonly objectKey: string;
    readonly sha256: string;
  }) {
    await this.#writeImmutable(
      input.objectKey,
      input.bytes,
      input.sha256,
      contentType(input.objectKey),
    );
    return {
      byteLength: input.bytes.byteLength,
      objectKey: input.objectKey,
      sha256: input.sha256,
    };
  }

  async putImmutable(input: {
    readonly content: string;
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }) {
    assertKey(input.objectKey);
    const bytes = Buffer.from(input.content, "utf8");
    const digest = input.contentHash;
    await this.#writeImmutable(
      input.objectKey,
      bytes,
      digest,
      "text/markdown; charset=utf-8",
    );
    return {
      byteSize: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8" as const,
      etag: digest,
      objectKey: input.objectKey,
    };
  }

  async read(objectKey: string): Promise<Uint8Array> {
    assertKey(objectKey);
    const result = await this.#client(objectKey).get(objectKey);
    if (result.res.status !== 200 || !(result.content instanceof Uint8Array)) {
      throw new Error("OSS object read failed");
    }
    return result.content;
  }

  async getObject(input: {
    readonly maximumBytes: number;
    readonly objectKey: string;
  }): Promise<{ readonly bytes: Uint8Array; readonly objectKey: string }> {
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
      throw new IngestionError("infrastructure_unavailable");
    }
    try {
      const bytes = await this.read(input.objectKey);
      if (bytes.byteLength < 1 || bytes.byteLength > input.maximumBytes) {
        throw new IngestionError("page_limit");
      }
      return { bytes, objectKey: input.objectKey };
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      throw new IngestionError("infrastructure_unavailable");
    }
  }

  async exists(objectKey: string): Promise<boolean> {
    assertKey(objectKey);
    try {
      return (await this.#client(objectKey).head(objectKey)).res.status === 200;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async #writeImmutable(
    objectKey: string,
    bytes: Uint8Array,
    digest: string,
    mime: string,
  ): Promise<void> {
    assertKey(objectKey);
    if (bytes.byteLength < 1 || sha256(bytes) !== digest) {
      throw new Error("immutable OSS content mismatch");
    }
    const client = this.#client(objectKey);
    try {
      const result = await client.put(objectKey, bytes, {
        headers: {
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-reflo-sha256": digest,
        },
        mime,
      });
      if (result.res.status !== 200) throw new Error("OSS put failed");
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const head = await client.head(objectKey);
      if (
        head.res.status !== 200 ||
        responseLength(head) !== bytes.byteLength ||
        String(head.meta?.["reflo-sha256"] ?? "") !== digest
      ) {
        throw new Error("immutable OSS object identity mismatch");
      }
    }
  }

  #client(objectKey: string): RefloOssClient {
    if (
      /\/sources\/[^/]+\/versions\/[^/]+\/original\.[a-z0-9]+$/.test(objectKey)
    ) {
      return this.clients.quarantine;
    }
    if (objectKey.includes("/ingestion-artifacts/")) {
      return this.clients.artifacts;
    }
    if (objectKey.includes("/courses/") && objectKey.includes("/assets/")) {
      return this.clients.delivery;
    }
    throw new Error("OSS object key does not match an approved boundary");
  }
}

export async function createAliOssConnectedObjectStore(input: {
  readonly artifactBucket: string;
  readonly deliveryBucket: string;
  readonly quarantineBucket: string;
  readonly region: string;
  readonly roleName: string;
}): Promise<AliOssConnectedObjectStore> {
  const loadCredentials = createEcsRamRoleCredentialLoader(input.roleName);
  const client = (bucket: string) =>
    createAliOssPrivateClient({
      bucket,
      loadCredentials,
      region: input.region,
    });
  return new AliOssConnectedObjectStore({
    artifacts: await client(input.artifactBucket),
    delivery: await client(input.deliveryBucket),
    quarantine: await client(input.quarantineBucket),
  });
}

function assertKey(objectKey: string): void {
  if (
    objectKey.length < 8 ||
    objectKey.length > 1_024 ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey.split("/").some((part) => ["", ".", ".."].includes(part))
  ) {
    throw new Error("unsafe OSS object key");
  }
}

function contentType(objectKey: string): string {
  if (objectKey.endsWith(".pdf")) return "application/pdf";
  if (objectKey.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "FileAlreadyExists"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { readonly status?: unknown }).status === 404
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
