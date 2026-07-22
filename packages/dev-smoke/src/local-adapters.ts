import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AudioArtifactWriteResult,
  AudioArtifactWriterPort,
} from "@reflo/audio";
import {
  INGESTION_COMPONENTS,
  IngestionError,
  type InternalArtifactObjectPort,
  type MalwareScannerPort,
  type MalwareSignatureSnapshot,
  type QuarantineDownloadPort,
  type StagedUpload,
} from "@reflo/ingestion";
import type {
  TextArtifactWriteResult,
  TextArtifactWriterPort,
} from "@reflo/activation";

export class LocalSmokeObjectStore
  implements
    InternalArtifactObjectPort,
    TextArtifactWriterPort,
    AudioArtifactWriterPort
{
  constructor(private readonly root: string) {}

  async putIfAbsent(input: {
    readonly bytes: Uint8Array;
    readonly objectKey: string;
    readonly sha256: string;
  }): Promise<{
    readonly byteLength: number;
    readonly objectKey: string;
    readonly sha256: string;
  }> {
    const actual = sha256(input.bytes);
    if (actual !== input.sha256) throw new Error("artifact digest mismatch");
    await this.#writeImmutable(input.objectKey, input.bytes, actual);
    return {
      byteLength: input.bytes.byteLength,
      objectKey: input.objectKey,
      sha256: actual,
    };
  }

  putImmutable(input: {
    readonly bytes: Uint8Array;
    readonly contentSha256: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<AudioArtifactWriteResult>;
  putImmutable(input: {
    readonly content: string;
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<TextArtifactWriteResult>;
  async putImmutable(input: {
    readonly bytes?: Uint8Array;
    readonly content?: string;
    readonly contentHash?: string;
    readonly contentSha256?: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<AudioArtifactWriteResult | TextArtifactWriteResult> {
    const bytes =
      input.bytes ??
      Buffer.from(required(input.content, "text content"), "utf8");
    const digest =
      input.contentSha256 ?? required(input.contentHash, "content hash");
    if (sha256(bytes) !== digest) throw new Error("immutable content mismatch");
    await this.#writeImmutable(input.objectKey, bytes, digest);
    return input.bytes === undefined
      ? {
          byteSize: bytes.byteLength,
          contentType: "text/markdown; charset=utf-8",
          etag: digest,
          objectKey: input.objectKey,
        }
      : {
          byteSize: bytes.byteLength,
          contentType: "audio/wav",
          etag: `sha256:${digest}`,
          objectKey: input.objectKey,
        };
  }

  async read(objectKey: string): Promise<Uint8Array> {
    return readFile(this.#resolve(objectKey));
  }

  async #writeImmutable(
    objectKey: string,
    bytes: Uint8Array,
    digest: string,
  ): Promise<void> {
    const target = this.#resolve(objectKey);
    await mkdir(path.dirname(target), { mode: 0o700, recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(target, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      const existing = await readFile(target).catch(() => null);
      if (existing === null || sha256(existing) !== digest) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  #resolve(objectKey: string): string {
    if (
      objectKey.startsWith("/") ||
      objectKey.includes("..") ||
      !/^[a-zA-Z0-9/_.-]{8,512}$/.test(objectKey)
    ) {
      throw new Error("unsafe local smoke object key");
    }
    const target = path.resolve(this.root, objectKey);
    const relative = path.relative(this.root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("local smoke object escaped its root");
    }
    return target;
  }
}

export class FixtureQuarantineDownload implements QuarantineDownloadPort {
  constructor(
    private readonly fixturePath: string,
    private readonly objectKey: string,
  ) {}

  async getObject(input: {
    readonly maximumBytes: number;
    readonly objectKey: string;
  }): Promise<{ readonly bytes: Uint8Array; readonly objectKey: string }> {
    if (input.objectKey !== this.objectKey) {
      throw new IngestionError("authorization_denied");
    }
    const bytes = await readFile(this.fixturePath);
    if (bytes.byteLength > input.maximumBytes) {
      throw new IngestionError("page_limit");
    }
    return { bytes, objectKey: input.objectKey };
  }
}

/** Admits only the immutable committed fixture; it is not a malware gate. */
export class TrustedFixtureAdmissionScanner implements MalwareScannerPort {
  constructor(private readonly fixtureSha256: string) {}

  async currentSnapshot(): Promise<MalwareSignatureSnapshot> {
    return {
      publishedAt: new Date(),
      signatureVersion: `trusted-fixture-${this.fixtureSha256.slice(0, 16)}`,
      verified: true,
    };
  }

  async scan(staged: StagedUpload): Promise<{ readonly clean: boolean }> {
    if (sha256(staged.bytes) !== this.fixtureSha256) {
      throw new IngestionError("malware_detected");
    }
    return { clean: true };
  }
}

export function artifactObjectKey(
  ownerScopeId: string,
  artifactId: string,
): string {
  return `owners/${ownerScopeId}/ingestion-artifacts/v1/${artifactId}.json`;
}

export const LOCAL_SMOKE_SCANNER = `trusted-committed-fixture-only; not ${INGESTION_COMPONENTS.clamAv}`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function required<Value>(value: Value | undefined, name: string): Value {
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}
