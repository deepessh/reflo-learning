import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { validateClamavLayerInput } from "./validate-clamav-layer-input.mjs";

const directories = [];
const now = new Date("2026-07-28T12:00:00.000Z");

after(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Function Compute ClamAV snapshot layer input", () => {
  it("accepts only a fresh content-addressed admitted snapshot", async () => {
    const directory = await fixture("2026-07-28T11:30:00.000Z");
    const manifest = await validateClamavLayerInput(directory, now);
    assert.equal(manifest.profile, "upstream-clamav-cloud-demo-v1");
  });

  it("rejects changed database bytes", async () => {
    const directory = await fixture("2026-07-28T11:30:00.000Z");
    await writeFile(path.join(directory, "daily.cvd"), "changed");
    await assert.rejects(
      validateClamavLayerInput(directory, now),
      /does not match/,
    );
  });

  it("rejects a snapshot after its 24-hour admission window", async () => {
    const directory = await fixture("2026-07-27T11:59:59.000Z");
    await assert.rejects(
      validateClamavLayerInput(directory, now),
      /24-hour admission window/,
    );
  });
});

async function fixture(publishedAt) {
  const parent = await mkdtemp(path.join(tmpdir(), "reflo-clamav-layer-"));
  directories.push(parent);
  const files = await Promise.all(
    ["bytecode.cvd", "daily.cvd", "main.cvd"].map(async (name, index) => {
      const bytes = Buffer.from(`database-${index}`);
      return {
        buildTime: publishedAt,
        byteLength: bytes.byteLength,
        databaseVersion: 100 + index,
        bytes,
        name,
        sha256: sha256(bytes),
      };
    }),
  );
  const identity = {
    clamAvVersion: "1.4.5",
    contractVersion: "upstream-clamav-snapshot-manifest-v1",
    files: files.map(({ bytes: _bytes, ...file }) => file),
    profile: "upstream-clamav-cloud-demo-v1",
    publishedAt,
    toolchain: {
      freshClamImageDigest:
        "sha256:48eaad9644475c2d466ce6d4ba2da892dbd4dcd47713201d31b665364655cc3c",
      sigtoolVersion: "ClamAV 1.4.5",
    },
  };
  const snapshotId = `cvd-${sha256(Buffer.from(JSON.stringify(identity))).slice(
    0,
    32,
  )}`;
  const directory = path.join(parent, snapshotId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory);
  await Promise.all(
    files.map((file) => writeFile(path.join(directory, file.name), file.bytes)),
  );
  await writeFile(
    path.join(directory, "snapshot.json"),
    JSON.stringify({ ...identity, snapshotId }),
  );
  return directory;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
