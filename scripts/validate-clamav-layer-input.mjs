import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE = "upstream-clamav-cloud-demo-v1";
const CONTRACT = "upstream-clamav-snapshot-manifest-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export async function validateClamavLayerInput(directory, now = new Date()) {
  if (!path.isAbsolute(directory)) {
    throw new Error("ClamAV snapshot path must be absolute");
  }
  const names = (await readdir(directory)).sort();
  const databaseNames = names.filter((name) => /\.(?:cld|cvd)$/.test(name));
  if (
    names.length !== 4 ||
    !names.includes("snapshot.json") ||
    !databaseNames.includes("main.cvd") ||
    databaseNames.filter((name) => /^daily\.(?:cld|cvd)$/.test(name)).length !==
      1 ||
    databaseNames.filter((name) => /^bytecode\.(?:cld|cvd)$/.test(name))
      .length !== 1
  ) {
    throw new Error("ClamAV snapshot has an unexpected file set");
  }
  const manifestBytes = await readFile(path.join(directory, "snapshot.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.clamAvVersion !== "1.4.5" ||
    manifest.contractVersion !== CONTRACT ||
    manifest.profile !== PROFILE ||
    !/^cvd-[a-f0-9]{32}$/.test(manifest.snapshotId ?? "") ||
    path.basename(directory) !== manifest.snapshotId ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 3 ||
    manifest.toolchain?.freshClamImageDigest !==
      "sha256:48eaad9644475c2d466ce6d4ba2da892dbd4dcd47713201d31b665364655cc3c"
  ) {
    throw new Error("ClamAV snapshot manifest identity is invalid");
  }
  const publishedAt = new Date(manifest.publishedAt).getTime();
  const ageMs = now.getTime() - publishedAt;
  if (
    !Number.isFinite(publishedAt) ||
    new Date(publishedAt).toISOString() !== manifest.publishedAt ||
    ageMs < -MAX_FUTURE_SKEW_MS ||
    ageMs > MAX_AGE_MS
  ) {
    throw new Error("ClamAV snapshot is outside the 24-hour admission window");
  }
  const expectedNames = manifest.files.map((file) => file.name).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(databaseNames)) {
    throw new Error("ClamAV snapshot database set does not match its manifest");
  }
  for (const file of manifest.files) {
    if (
      !/^(?:main\.cvd|daily\.(?:cld|cvd)|bytecode\.(?:cld|cvd))$/.test(
        file.name ?? "",
      ) ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 1 ||
      !Number.isSafeInteger(file.databaseVersion) ||
      file.databaseVersion < 1 ||
      !Number.isFinite(new Date(file.buildTime).getTime())
    ) {
      throw new Error("ClamAV snapshot file identity is invalid");
    }
    const filePath = path.join(directory, file.name);
    const [bytes, metadata] = await Promise.all([
      readFile(filePath),
      lstat(filePath),
    ]);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== file.byteLength ||
      sha256(bytes) !== file.sha256
    ) {
      throw new Error(`ClamAV snapshot file ${file.name} does not match`);
    }
    if (file.name.startsWith("daily.")) {
      const buildAgeMs = now.getTime() - new Date(file.buildTime).getTime();
      if (buildAgeMs < -MAX_FUTURE_SKEW_MS || buildAgeMs > MAX_AGE_MS) {
        throw new Error(
          "ClamAV daily database is outside the 24-hour admission window",
        );
      }
    }
  }
  const identity = {
    clamAvVersion: manifest.clamAvVersion,
    contractVersion: manifest.contractVersion,
    files: manifest.files,
    profile: manifest.profile,
    publishedAt: manifest.publishedAt,
    toolchain: manifest.toolchain,
  };
  const snapshotId = `cvd-${sha256(
    Buffer.from(JSON.stringify(identity), "utf8"),
  ).slice(0, 32)}`;
  if (snapshotId !== manifest.snapshotId) {
    throw new Error("ClamAV snapshot content address is invalid");
  }
  return manifest;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  if (directory === undefined) {
    throw new Error("ClamAV snapshot directory is required");
  }
  await validateClamavLayerInput(path.resolve(directory));
}
