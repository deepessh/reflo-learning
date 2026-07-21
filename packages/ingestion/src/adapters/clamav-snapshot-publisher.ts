import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { INGESTION_COMPONENTS } from "../contracts.js";
import { IngestionError } from "../errors.js";
import type { ProcessRunnerPort } from "../ports.js";
import type { AliOssObjectClient } from "./ali-oss.js";
import {
  type SnapshotDigestSignerPort,
  snapshotManifestDigest,
} from "./alibaba-kms.js";
import { CLAMAV_SNAPSHOT_MANIFEST_CONTRACT } from "./clamav.js";
import {
  CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
  type ClamAvSnapshotPublicKeyPin,
  PinnedP256SnapshotSignatureVerifier,
} from "./clamav-signature.js";

const MAX_DATABASE_FILE_BYTES = 512 * 1_024 * 1_024;
const MAX_DATABASE_TOTAL_BYTES = 1_024 * 1_024 * 1_024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1_024;
const READY_CONTRACT = "clamav-snapshot-ready-v1";

export interface ClamAvSnapshotBundle {
  readonly databaseDirectory: string;
  readonly files: readonly {
    readonly byteLength: number;
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
  readonly providerSigning: {
    readonly keyId: string;
    readonly keyVersionId: string;
    readonly requestId: string;
  };
  readonly signatureBase64: Uint8Array;
  readonly signatureSha256: string;
  readonly snapshotId: string;
}

export class ClamAvSnapshotMaintenancePublisher {
  readonly #verifier: PinnedP256SnapshotSignatureVerifier;

  constructor(
    private readonly runner: ProcessRunnerPort,
    private readonly signer: SnapshotDigestSignerPort,
    private readonly pin: ClamAvSnapshotPublicKeyPin,
  ) {
    this.#verifier = new PinnedP256SnapshotSignatureVerifier([pin]);
  }

  async createBundle(input: {
    readonly databaseDirectory: string;
    readonly publishedAt: Date;
  }): Promise<ClamAvSnapshotBundle> {
    if (
      !path.isAbsolute(input.databaseDirectory) ||
      !isCanonicalUtc(input.publishedAt)
    ) {
      throw unavailable();
    }
    const databaseDirectory = await lstat(input.databaseDirectory).catch(() => {
      throw unavailable();
    });
    if (
      !databaseDirectory.isDirectory() ||
      databaseDirectory.isSymbolicLink()
    ) {
      throw unavailable();
    }
    await assertSigtoolVersion(this.runner);
    const names = (await readdir(input.databaseDirectory)).sort();
    if (
      names.length < 1 ||
      names.length > 3 ||
      names.some((name) => !/^(?:bytecode|daily|main)\.(?:cld|cvd)$/.test(name))
    ) {
      throw unavailable();
    }
    const files: Array<{
      byteLength: number;
      name: string;
      sha256: string;
    }> = [];
    let totalBytes = 0;
    const verificationDirectory = await mkdtemp(
      path.join(tmpdir(), "reflo-clamav-verify-"),
    );
    try {
      for (const name of names) {
        const filePath = path.join(input.databaseDirectory, name);
        const bytes = await readRegularFile(filePath, MAX_DATABASE_FILE_BYTES);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_DATABASE_TOTAL_BYTES) {
          throw unavailable();
        }
        // Validate the same immutable bytes that will be hashed and signed.
        // Running sigtool against the source path would leave a replacement
        // race between upstream verification and the following read.
        const verificationPath = path.join(verificationDirectory, name);
        await writeFile(verificationPath, bytes, { flag: "wx", mode: 0o600 });
        const verified = await this.runner.run(
          "sigtool",
          ["--verify-cvd", verificationPath],
          { maxOutputBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 60_000 },
        );
        if (verified.timedOut || verified.exitCode !== 0) {
          throw unavailable();
        }
        files.push({
          byteLength: bytes.byteLength,
          name,
          sha256: sha256(bytes),
        });
      }
    } finally {
      await rm(verificationDirectory, { force: true, recursive: true });
    }
    const snapshotId = `cvd-${sha256(
      Buffer.from(
        JSON.stringify({
          files,
          kid: this.pin.kid,
          publishedAt: input.publishedAt.toISOString(),
        }),
        "utf8",
      ),
    ).slice(0, 32)}`;
    const manifestBytes = Buffer.from(
      JSON.stringify({
        clamAvVersion: INGESTION_COMPONENTS.clamAv,
        contractVersion: CLAMAV_SNAPSHOT_MANIFEST_CONTRACT,
        files,
        kid: this.pin.kid,
        publishedAt: input.publishedAt.toISOString(),
        publicKeySpkiSha256: this.pin.spkiSha256,
        signatureProfile: CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
        snapshotId,
      }),
      "utf8",
    );
    const signed = await this.signer.signDigest({
      digest: snapshotManifestDigest(manifestBytes),
      payload: manifestBytes,
    });
    if (
      !(await this.#verifier.verify({
        kid: this.pin.kid,
        payload: manifestBytes,
        profile: CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
        publicKeySpkiSha256: this.pin.spkiSha256,
        signature: signed.signature,
      }))
    ) {
      throw unavailable();
    }
    const signatureBase64 = Buffer.from(
      Buffer.from(signed.signature).toString("base64"),
      "ascii",
    );
    return {
      databaseDirectory: input.databaseDirectory,
      files,
      manifestBytes,
      manifestSha256: sha256(manifestBytes),
      providerSigning: {
        keyId: signed.providerKeyId,
        keyVersionId: signed.providerKeyVersionId,
        requestId: signed.providerRequestId,
      },
      signatureBase64,
      signatureSha256: sha256(signatureBase64),
      snapshotId,
    };
  }
}

/** Publishes immutable objects and writes the readiness marker last. */
export class AliOssClamAvSnapshotPublisher {
  constructor(
    private readonly client: AliOssObjectClient,
    private readonly rootPrefix = "internal/clamav/snapshots/v1",
  ) {
    if (!isSafeObjectKey(rootPrefix)) {
      throw unavailable();
    }
  }

  async publish(bundle: ClamAvSnapshotBundle): Promise<{
    readonly readyObjectKey: string;
    readonly snapshotPrefix: string;
  }> {
    if (!/^cvd-[a-f0-9]{32}$/.test(bundle.snapshotId)) {
      throw unavailable();
    }
    const snapshotPrefix = `${this.rootPrefix}/${bundle.snapshotId}`;
    for (const file of bundle.files) {
      const bytes = await readRegularFile(
        path.join(bundle.databaseDirectory, file.name),
        file.byteLength,
      );
      if (
        bytes.byteLength !== file.byteLength ||
        sha256(bytes) !== file.sha256
      ) {
        throw unavailable();
      }
      await putImmutable(this.client, {
        bytes,
        contentType: "application/octet-stream",
        objectKey: `${snapshotPrefix}/${file.name}`,
        sha256: file.sha256,
      });
    }
    await putImmutable(this.client, {
      bytes: bundle.manifestBytes,
      contentType: "application/json",
      objectKey: `${snapshotPrefix}/snapshot.json`,
      sha256: bundle.manifestSha256,
    });
    await putImmutable(this.client, {
      bytes: bundle.signatureBase64,
      contentType: "application/octet-stream",
      objectKey: `${snapshotPrefix}/snapshot.sig`,
      sha256: bundle.signatureSha256,
    });
    const readyBytes = Buffer.from(
      JSON.stringify({
        contractVersion: READY_CONTRACT,
        manifestSha256: bundle.manifestSha256,
        signatureSha256: bundle.signatureSha256,
        snapshotId: bundle.snapshotId,
      }),
      "utf8",
    );
    const readyObjectKey = `${snapshotPrefix}/ready.json`;
    await putImmutable(this.client, {
      bytes: readyBytes,
      contentType: "application/json",
      objectKey: readyObjectKey,
      sha256: sha256(readyBytes),
    });
    return { readyObjectKey, snapshotPrefix };
  }
}

async function assertSigtoolVersion(runner: ProcessRunnerPort): Promise<void> {
  const version = await runner.run("sigtool", ["--version"], {
    maxOutputBytes: MAX_DIAGNOSTIC_BYTES,
    timeoutMs: 5_000,
  });
  if (
    version.timedOut ||
    version.exitCode !== 0 ||
    !new RegExp(`^ClamAV ${INGESTION_COMPONENTS.clamAv}(?:/|\\s|$)`).test(
      version.stdout,
    )
  ) {
    throw unavailable();
  }
}

async function putImmutable(
  client: AliOssObjectClient,
  input: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly objectKey: string;
    readonly sha256: string;
  },
): Promise<void> {
  if (!isSafeObjectKey(input.objectKey)) {
    throw unavailable();
  }
  try {
    const result = await client.put(input.objectKey, input.bytes, {
      headers: {
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-reflo-sha256": input.sha256,
      },
      mime: input.contentType,
    });
    if (result.res.status !== 200) {
      throw unavailable();
    }
  } catch (error) {
    if (!isAlreadyExists(error)) {
      if (error instanceof IngestionError) {
        throw error;
      }
      throw unavailable();
    }
    const head = await client.head(input.objectKey).catch(() => {
      throw unavailable();
    });
    const length =
      head.res.size ?? Number(head.res.headers?.["content-length"]);
    if (
      head.res.status !== 200 ||
      length !== input.bytes.byteLength ||
      head.meta?.["reflo-sha256"] !== input.sha256
    ) {
      throw unavailable();
    }
  }
}

async function readRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) {
      throw unavailable();
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) {
      throw unavailable();
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function isCanonicalUtc(value: Date): boolean {
  return Number.isFinite(value.getTime()) && value.toISOString().endsWith("Z");
}

function isSafeObjectKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "FileAlreadyExists"
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unavailable(): IngestionError {
  return new IngestionError("infrastructure_unavailable");
}
