import { createHash, verify } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

import {
  INGESTION_COMPONENTS,
  type MalwareSignatureSnapshot,
  type StagedUpload,
} from "../contracts.js";
import { IngestionError } from "../errors.js";
import type { MalwareScannerPort, ProcessRunnerPort } from "../ports.js";

const SNAPSHOT_CONTRACT = "clamav-signature-snapshot-v1";
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1_024;

interface SnapshotFile {
  readonly byteLength: number;
  readonly name: string;
  readonly sha256: string;
}

interface SnapshotManifest {
  readonly clamAvVersion: string;
  readonly contractVersion: typeof SNAPSHOT_CONTRACT;
  readonly files: readonly SnapshotFile[];
  readonly publishedAt: string;
  readonly signatureAlgorithm: "ed25519";
  readonly signatureVersion: string;
}

export interface ClamAvScannerOptions {
  readonly databaseDirectory: string;
  readonly executable: "clamscan";
  readonly manifestPath: string;
  readonly publicKeyPem: string;
  readonly runner: ProcessRunnerPort;
  readonly signaturePath: string;
}

export class ClamAvScannerAdapter implements MalwareScannerPort {
  readonly #options: ClamAvScannerOptions;
  #verifiedSnapshotIdentity: string | undefined;

  constructor(options: ClamAvScannerOptions) {
    if (
      options.executable !== "clamscan" ||
      !path.isAbsolute(options.databaseDirectory) ||
      !path.isAbsolute(options.manifestPath) ||
      !path.isAbsolute(options.signaturePath) ||
      path.dirname(options.manifestPath) !== options.databaseDirectory ||
      path.dirname(options.signaturePath) !== options.databaseDirectory ||
      options.publicKeyPem.length < 32
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
    this.#options = options;
  }

  async currentSnapshot(): Promise<MalwareSignatureSnapshot | null> {
    try {
      const manifestBytes = await readRegularFile(
        this.#options.manifestPath,
        MAX_MANIFEST_BYTES,
      );
      const signatureText = (
        await readRegularFile(this.#options.signaturePath, 16 * 1_024)
      ).toString("ascii");
      if (!/^[A-Za-z0-9+/]+={0,2}\n?$/.test(signatureText)) {
        return null;
      }
      const signature = Buffer.from(signatureText.trim(), "base64");
      if (
        signature.byteLength === 0 ||
        !verify(null, manifestBytes, this.#options.publicKeyPem, signature)
      ) {
        return null;
      }
      const manifest = parseManifest(manifestBytes);
      await verifySnapshotFiles(
        this.#options.databaseDirectory,
        manifest.files,
        [
          path.basename(this.#options.manifestPath),
          path.basename(this.#options.signaturePath),
        ],
      );
      const publishedAt = new Date(manifest.publishedAt);
      if (!Number.isFinite(publishedAt.getTime())) {
        return null;
      }
      this.#verifiedSnapshotIdentity = snapshotIdentity(
        publishedAt,
        manifest.signatureVersion,
      );
      return {
        publishedAt,
        signatureVersion: manifest.signatureVersion,
        verified: true,
      };
    } catch {
      return null;
    }
  }

  async scan(
    staged: StagedUpload,
    snapshot: MalwareSignatureSnapshot,
  ): Promise<{ readonly clean: boolean }> {
    if (
      !snapshot.verified ||
      this.#verifiedSnapshotIdentity !==
        snapshotIdentity(snapshot.publishedAt, snapshot.signatureVersion)
    ) {
      throw new IngestionError("scan_db_stale");
    }
    const version = await this.#options.runner.run(
      this.#options.executable,
      ["--version"],
      { maxOutputBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 5_000 },
    );
    if (
      version.timedOut ||
      version.exitCode !== 0 ||
      !new RegExp(`^ClamAV ${escapeRegex(INGESTION_COMPONENTS.clamAv)}/`).test(
        version.stdout,
      )
    ) {
      throw new IngestionError("infrastructure_unavailable");
    }
    const result = await this.#options.runner.run(
      this.#options.executable,
      [
        `--database=${this.#options.databaseDirectory}`,
        "--no-summary",
        "--stdout",
        "--infected",
        "--",
        staged.inputPath,
      ],
      { maxOutputBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 10 * 60 * 1_000 },
    );
    if (result.timedOut) {
      throw new IngestionError("infrastructure_unavailable");
    }
    if (result.exitCode === 0) {
      return { clean: true };
    }
    if (result.exitCode === 1) {
      return { clean: false };
    }
    throw new IngestionError("infrastructure_unavailable");
  }
}

function parseManifest(bytes: Buffer): SnapshotManifest {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "clamAvVersion",
      "contractVersion",
      "files",
      "publishedAt",
      "signatureAlgorithm",
      "signatureVersion",
    ])
  ) {
    throw new Error("invalid snapshot manifest");
  }
  if (
    value.contractVersion !== SNAPSHOT_CONTRACT ||
    value.clamAvVersion !== INGESTION_COMPONENTS.clamAv ||
    value.signatureAlgorithm !== "ed25519" ||
    typeof value.publishedAt !== "string" ||
    typeof value.signatureVersion !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.signatureVersion) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 128
  ) {
    throw new Error("invalid snapshot manifest");
  }
  const names = new Set<string>();
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ["byteLength", "name", "sha256"]) ||
      typeof file.name !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(file.name) ||
      names.has(file.name) ||
      !Number.isSafeInteger(file.byteLength) ||
      (file.byteLength as number) < 1 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("invalid snapshot manifest");
    }
    names.add(file.name);
  }
  return value as unknown as SnapshotManifest;
}

async function verifySnapshotFiles(
  databaseDirectory: string,
  files: readonly SnapshotFile[],
  controlFiles: readonly string[],
): Promise<void> {
  const expectedNames = new Set([
    ...files.map((file) => file.name),
    ...controlFiles,
  ]);
  const directoryNames = await readdir(databaseDirectory);
  if (
    directoryNames.length !== expectedNames.size ||
    directoryNames.some((name) => !expectedNames.has(name))
  ) {
    throw new Error("snapshot directory mismatch");
  }
  for (const file of files) {
    const bytes = await readRegularFile(
      path.join(databaseDirectory, file.name),
      file.byteLength,
    );
    if (
      bytes.byteLength !== file.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      throw new Error("snapshot file mismatch");
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
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new Error("unsafe snapshot file");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) {
      throw new Error("unsafe snapshot file");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function snapshotIdentity(publishedAt: Date, signatureVersion: string): string {
  return `${publishedAt.toISOString()}:${signatureVersion}`;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
