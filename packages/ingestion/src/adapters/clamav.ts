import { createHash } from "node:crypto";
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

export const CLAMAV_UPSTREAM_SNAPSHOT_PROFILE =
  "upstream-clamav-cloud-demo-v1" as const;
export const CLAMAV_UPSTREAM_SNAPSHOT_MANIFEST_CONTRACT =
  "upstream-clamav-snapshot-manifest-v1" as const;

const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1_024;
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const SNAPSHOT_ID_PATTERN = /^cvd-[a-f0-9]{32}$/;

export interface UpstreamClamAvSnapshotFile {
  readonly buildTime: string;
  readonly byteLength: number;
  readonly databaseVersion: number;
  readonly name: string;
  readonly sha256: string;
}

export interface UpstreamClamAvToolchainIdentity {
  readonly freshClamImageDigest: string;
  readonly sigtoolVersion: string;
}

export interface UpstreamClamAvSnapshotManifest {
  readonly clamAvVersion: string;
  readonly contractVersion: typeof CLAMAV_UPSTREAM_SNAPSHOT_MANIFEST_CONTRACT;
  readonly files: readonly UpstreamClamAvSnapshotFile[];
  readonly profile: typeof CLAMAV_UPSTREAM_SNAPSHOT_PROFILE;
  readonly publishedAt: string;
  readonly snapshotId: string;
  readonly toolchain: UpstreamClamAvToolchainIdentity;
}

export interface ClamAvScannerOptions {
  readonly clock?: { now(): Date };
  readonly databaseDirectory: string;
  readonly executable: "clamscan";
  readonly expectedFreshClamImageDigest: string;
  readonly expectedProfile: typeof CLAMAV_UPSTREAM_SNAPSHOT_PROFILE;
  readonly expectedSnapshotId: string;
  readonly manifestPath: string;
  readonly runner: ProcessRunnerPort;
}

export class ClamAvScannerAdapter implements MalwareScannerPort {
  readonly #options: ClamAvScannerOptions;
  #verifiedSnapshotIdentity: string | undefined;

  constructor(options: ClamAvScannerOptions) {
    if (
      options.executable !== "clamscan" ||
      !path.isAbsolute(options.databaseDirectory) ||
      !path.isAbsolute(options.manifestPath) ||
      path.dirname(options.manifestPath) !== options.databaseDirectory ||
      path.basename(options.databaseDirectory) !== options.expectedSnapshotId ||
      !SNAPSHOT_ID_PATTERN.test(options.expectedSnapshotId) ||
      !/^sha256:[a-f0-9]{64}$/.test(options.expectedFreshClamImageDigest) ||
      options.expectedProfile !== CLAMAV_UPSTREAM_SNAPSHOT_PROFILE
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
      const manifest = parseUpstreamClamAvManifest(manifestBytes);
      if (
        manifest.profile !== this.#options.expectedProfile ||
        manifest.snapshotId !== this.#options.expectedSnapshotId ||
        manifest.toolchain.freshClamImageDigest !==
          this.#options.expectedFreshClamImageDigest ||
        upstreamClamAvSnapshotId(manifest) !== manifest.snapshotId
      ) {
        return null;
      }
      const now = this.#options.clock?.now() ?? new Date();
      if (!snapshotIsFresh(manifest, now)) {
        return null;
      }
      const version = await this.#options.runner.run("sigtool", ["--version"], {
        maxOutputBytes: MAX_DIAGNOSTIC_BYTES,
        timeoutMs: 5_000,
      });
      if (
        version.timedOut ||
        version.exitCode !== 0 ||
        version.stdout.trim() !== manifest.toolchain.sigtoolVersion ||
        !new RegExp(
          `^ClamAV ${escapeRegex(INGESTION_COMPONENTS.clamAv)}(?:/|\\s|$)`,
        ).test(version.stdout)
      ) {
        return null;
      }
      await verifySnapshotFiles(
        this.#options.databaseDirectory,
        manifest.files,
        [path.basename(this.#options.manifestPath)],
      );
      for (const file of manifest.files) {
        const result = await this.#options.runner.run(
          "sigtool",
          ["--info", path.join(this.#options.databaseDirectory, file.name)],
          { maxOutputBytes: MAX_DIAGNOSTIC_BYTES, timeoutMs: 60_000 },
        );
        if (result.timedOut || result.exitCode !== 0) {
          return null;
        }
        const verified = parseSigtoolDatabaseInfo(result.stdout);
        if (
          verified.buildTime !== file.buildTime ||
          verified.databaseVersion !== file.databaseVersion
        ) {
          return null;
        }
      }
      const publishedAt = new Date(manifest.publishedAt);
      this.#verifiedSnapshotIdentity = snapshotIdentity(
        publishedAt,
        manifest.snapshotId,
      );
      return {
        publishedAt,
        signatureVersion: manifest.snapshotId,
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
      !new RegExp(
        `^ClamAV ${escapeRegex(INGESTION_COMPONENTS.clamAv)}(?:/|\\s|$)`,
      ).test(version.stdout)
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

export function upstreamClamAvSnapshotId(
  input: Omit<UpstreamClamAvSnapshotManifest, "snapshotId">,
): string {
  const identity = Buffer.from(
    JSON.stringify({
      clamAvVersion: input.clamAvVersion,
      contractVersion: input.contractVersion,
      files: input.files,
      profile: input.profile,
      publishedAt: input.publishedAt,
      toolchain: input.toolchain,
    }),
    "utf8",
  );
  return `cvd-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function parseSigtoolDatabaseInfo(output: string): {
  readonly buildTime: string;
  readonly databaseVersion: number;
} {
  if (!/^Verification OK\.$/m.test(output)) {
    throw new Error("upstream signature verification failed");
  }
  const buildTime = new Date(output.match(/^Build time: (.+)$/m)?.[1] ?? "");
  const databaseVersion = Number(output.match(/^Version: ([0-9]+)$/m)?.[1]);
  if (
    !Number.isFinite(buildTime.getTime()) ||
    !Number.isSafeInteger(databaseVersion) ||
    databaseVersion < 1
  ) {
    throw new Error("invalid upstream database metadata");
  }
  return {
    buildTime: buildTime.toISOString(),
    databaseVersion,
  };
}

export function parseUpstreamClamAvManifest(
  bytes: Uint8Array,
): UpstreamClamAvSnapshotManifest {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "clamAvVersion",
      "contractVersion",
      "files",
      "profile",
      "publishedAt",
      "snapshotId",
      "toolchain",
    ]) ||
    value.contractVersion !== CLAMAV_UPSTREAM_SNAPSHOT_MANIFEST_CONTRACT ||
    value.profile !== CLAMAV_UPSTREAM_SNAPSHOT_PROFILE ||
    value.clamAvVersion !== INGESTION_COMPONENTS.clamAv ||
    typeof value.publishedAt !== "string" ||
    typeof value.snapshotId !== "string" ||
    !SNAPSHOT_ID_PATTERN.test(value.snapshotId) ||
    !isRecord(value.toolchain) ||
    !hasExactKeys(value.toolchain, [
      "freshClamImageDigest",
      "sigtoolVersion",
    ]) ||
    typeof value.toolchain.freshClamImageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.toolchain.freshClamImageDigest) ||
    typeof value.toolchain.sigtoolVersion !== "string" ||
    !new RegExp(
      `^ClamAV ${escapeRegex(INGESTION_COMPONENTS.clamAv)}(?:/|\\s|$)`,
    ).test(value.toolchain.sigtoolVersion) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("invalid snapshot manifest");
  }
  const files = value.files as unknown[];
  const names = new Set<string>();
  for (const file of files) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, [
        "buildTime",
        "byteLength",
        "databaseVersion",
        "name",
        "sha256",
      ]) ||
      typeof file.buildTime !== "string" ||
      !Number.isFinite(new Date(file.buildTime).getTime()) ||
      !Number.isSafeInteger(file.byteLength) ||
      (file.byteLength as number) < 1 ||
      !Number.isSafeInteger(file.databaseVersion) ||
      (file.databaseVersion as number) < 1 ||
      typeof file.name !== "string" ||
      !/^(?:bytecode|daily|main)\.(?:cld|cvd)$/.test(file.name) ||
      names.has(file.name) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("invalid snapshot manifest");
    }
    names.add(file.name);
  }
  assertClosedDatabaseSet([...names]);
  if (
    files.some(
      (file, index) =>
        (file as { readonly name: string }).name !== [...names].sort()[index],
    )
  ) {
    throw new Error("invalid snapshot manifest");
  }
  return value as unknown as UpstreamClamAvSnapshotManifest;
}

function snapshotIsFresh(
  manifest: UpstreamClamAvSnapshotManifest,
  now: Date,
): boolean {
  const publishedAt = new Date(manifest.publishedAt).getTime();
  const daily = manifest.files.find((file) => file.name.startsWith("daily."));
  const dailyBuildTime = new Date(daily?.buildTime ?? "").getTime();
  return (
    Number.isFinite(now.getTime()) &&
    Number.isFinite(publishedAt) &&
    Number.isFinite(dailyBuildTime) &&
    publishedAt <= now.getTime() + MAX_FUTURE_SKEW_MS &&
    dailyBuildTime <= now.getTime() + MAX_FUTURE_SKEW_MS &&
    now.getTime() - publishedAt <= MAX_SNAPSHOT_AGE_MS &&
    now.getTime() - dailyBuildTime <= MAX_SNAPSHOT_AGE_MS
  );
}

function assertClosedDatabaseSet(names: readonly string[]): void {
  const groups = ["main.", "daily.", "bytecode."];
  if (
    names.length !== groups.length ||
    groups.some(
      (prefix) => names.filter((name) => name.startsWith(prefix)).length !== 1,
    )
  ) {
    throw new Error("invalid snapshot database set");
  }
}

async function verifySnapshotFiles(
  databaseDirectory: string,
  files: readonly UpstreamClamAvSnapshotFile[],
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
