import { createHash } from "node:crypto";
import { access, mkdir, open, readFile } from "node:fs/promises";
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

const MAX_DEVELOPMENT_VIDEO_BYTES = 128 * 1024 * 1024;

export class DevelopmentVideoArtifactError extends Error {
  constructor() {
    super("development video artifact could not be copied safely");
    this.name = "DevelopmentVideoArtifactError";
  }
}

export interface DevelopmentVideoArtifact {
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly objectKey: string;
}

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

  async exists(objectKey: string): Promise<boolean> {
    try {
      await access(this.#resolve(objectKey));
      return true;
    } catch {
      return false;
    }
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

export async function copyDevelopmentVideoArtifact(input: {
  readonly courseId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly mimeType: string;
  readonly ownerScopeId: string;
  readonly store: LocalSmokeObjectStore;
  readonly uri: string;
}): Promise<DevelopmentVideoArtifact> {
  if (
    input.mimeType !== "video/mp4" ||
    !isSafeIdentifier(input.courseId) ||
    !isSafeIdentifier(input.ownerScopeId)
  ) {
    throw new DevelopmentVideoArtifactError();
  }
  let source: URL;
  try {
    source = new URL(input.uri);
  } catch {
    throw new DevelopmentVideoArtifactError();
  }
  if (
    source.protocol !== "https:" ||
    source.username.length > 0 ||
    source.password.length > 0 ||
    !isAllowedFalMediaLocation(source)
  ) {
    throw new DevelopmentVideoArtifactError();
  }
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(source, {
      headers: { Accept: "video/mp4" },
      method: "GET",
      redirect: "error",
    });
  } catch {
    throw new DevelopmentVideoArtifactError();
  }
  const contentLength = response.headers.get("content-length");
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "video/mp4" ||
    (contentLength !== null &&
      (!/^[0-9]+$/.test(contentLength) ||
        Number(contentLength) > MAX_DEVELOPMENT_VIDEO_BYTES))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new DevelopmentVideoArtifactError();
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new DevelopmentVideoArtifactError();
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DEVELOPMENT_VIDEO_BYTES) {
    throw new DevelopmentVideoArtifactError();
  }
  const contentSha256 = sha256(bytes);
  const objectKey = `owners/${input.ownerScopeId}/courses/${input.courseId}/assets/development-fal-video/generations/${contentSha256}/payload.mp4`;
  await input.store.putIfAbsent({ bytes, objectKey, sha256: contentSha256 });
  return { byteSize: bytes.byteLength, contentSha256, objectKey };
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

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function isAllowedFalMediaLocation(url: URL): boolean {
  return (
    url.hostname === "fal.media" ||
    url.hostname.endsWith(".fal.media") ||
    (url.hostname === "storage.googleapis.com" &&
      url.pathname.startsWith("/falserverless/"))
  );
}
