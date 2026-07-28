import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROFILE = "upstream-clamav-cloud-demo-v1";
const CONTRACT = "upstream-clamav-snapshot-manifest-v1";
const IMAGE =
  "docker.io/clamav/clamav@sha256:48eaad9644475c2d466ce6d4ba2da892dbd4dcd47713201d31b665364655cc3c";
const IMAGE_DIGEST =
  "sha256:48eaad9644475c2d466ce6d4ba2da892dbd4dcd47713201d31b665364655cc3c";

export async function admitClamavLayerSnapshot(databaseDirectory, now) {
  if (!path.isAbsolute(databaseDirectory)) {
    throw new Error("ClamAV database path must be absolute");
  }
  const names = (await readdir(databaseDirectory)).sort();
  const selected = selectDatabases(names);
  const sigtoolVersion = await runSigtool(databaseDirectory, ["--version"]);
  if (!sigtoolVersion.trim().startsWith("ClamAV 1.4.5")) {
    throw new Error("digest-pinned sigtool has an unexpected version");
  }
  const files = [];
  let dailyBuildTime;
  for (const name of selected) {
    const output = await runSigtool(databaseDirectory, [
      "--info",
      `/database/${name}`,
    ]);
    if (!output.includes("Verification OK.")) {
      throw new Error(`${name} failed upstream signature verification`);
    }
    const buildTime = new Date(
      output.match(/^Build time: (.+)$/m)?.[1]?.trim() ?? "",
    );
    const databaseVersion = Number(output.match(/^Version: ([0-9]+)$/m)?.[1]);
    if (
      !Number.isFinite(buildTime.getTime()) ||
      !Number.isSafeInteger(databaseVersion) ||
      databaseVersion < 1
    ) {
      throw new Error(`${name} has invalid signed metadata`);
    }
    if (name.startsWith("daily.")) dailyBuildTime = buildTime;
    const bytes = await readFile(path.join(databaseDirectory, name));
    const metadata = await stat(path.join(databaseDirectory, name));
    if (!metadata.isFile() || bytes.byteLength < 1) {
      throw new Error(`${name} is not a non-empty regular file`);
    }
    files.push({
      buildTime: buildTime.toISOString(),
      byteLength: bytes.byteLength,
      databaseVersion,
      name,
      sha256: sha256(bytes),
    });
  }
  const publishedAt = new Date(now ?? Date.now());
  const dailyAgeMs = publishedAt.getTime() - (dailyBuildTime?.getTime() ?? NaN);
  if (
    !Number.isFinite(publishedAt.getTime()) ||
    !Number.isFinite(dailyAgeMs) ||
    dailyAgeMs < -5 * 60_000 ||
    dailyAgeMs > 24 * 60 * 60_000
  ) {
    throw new Error("daily ClamAV database is outside the admission window");
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  const identity = {
    clamAvVersion: "1.4.5",
    contractVersion: CONTRACT,
    files,
    profile: PROFILE,
    publishedAt: publishedAt.toISOString(),
    toolchain: {
      freshClamImageDigest: IMAGE_DIGEST,
      sigtoolVersion: sigtoolVersion.trim(),
    },
  };
  const snapshotId = `cvd-${sha256(
    Buffer.from(JSON.stringify(identity), "utf8"),
  ).slice(0, 32)}`;
  const parent = path.dirname(databaseDirectory);
  const destination = path.join(parent, snapshotId);
  const temporary = path.join(parent, `.${snapshotId}.next`);
  await rm(temporary, { force: true, recursive: true });
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const file of files) {
      await copyFile(
        path.join(databaseDirectory, file.name),
        path.join(temporary, file.name),
      );
    }
    await writeFile(
      path.join(temporary, "snapshot.json"),
      JSON.stringify({ ...identity, snapshotId }),
      { mode: 0o400 },
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
  return destination;
}

function selectDatabases(names) {
  const allowedMetadata = new Set(["freshclam.dat"]);
  const candidates = [
    ["main.cvd"],
    ["daily.cld", "daily.cvd"],
    ["bytecode.cld", "bytecode.cvd"],
  ];
  const selected = candidates.map((group) => {
    const present = group.filter((name) => names.includes(name));
    if (present.length !== 1) {
      throw new Error(`expected exactly one of ${group.join(", ")}`);
    }
    return present[0];
  });
  const allowed = new Set([...selected, ...allowedMetadata]);
  if (names.some((name) => !allowed.has(name))) {
    throw new Error("ClamAV database directory contains unexpected entries");
  }
  return selected.sort();
}

async function runSigtool(databaseDirectory, args) {
  const result = await execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      `--mount=type=bind,src=${databaseDirectory},dst=/database,readonly`,
      "--entrypoint=/usr/bin/sigtool",
      IMAGE,
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    },
  );
  return result.stdout;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [databaseDirectory] = process.argv.slice(2);
  if (databaseDirectory === undefined) {
    throw new Error("ClamAV database directory is required");
  }
  console.info(await admitClamavLayerSnapshot(path.resolve(databaseDirectory)));
}
