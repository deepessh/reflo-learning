import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  buildDeploymentManifest,
  DEPLOYMENT_ARTIFACT_CONTRACT,
  JOBS_LAYER_LIMIT_BYTES,
  JOBS_RUNTIME,
  PARSER_ARCHIVE_LIMIT_BYTES,
  PARSER_LAYER_COUNT_LIMIT,
  PARSER_LAYER_TOTAL_LIMIT_BYTES,
  PARSER_RUNTIME,
} from "./write-deployment-manifest.mjs";

const directories = [];
const filenames = [
  "api.tar.gz",
  "jobs.zip",
  "jobs-piper-layer.zip",
  "parser-code.zip",
  "parser-java-worker-layer.zip",
  "parser-native-layer.zip",
  "parser-clamav-snapshot-layer.zip",
];

after(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("deployment artifact manifest", () => {
  it("records the registry-free custom.debian11 parser archives by content", async () => {
    const directory = await fixture();
    const commit = "a".repeat(40);
    const manifest = await buildDeploymentManifest(directory, commit);

    assert.equal(manifest.contractVersion, DEPLOYMENT_ARTIFACT_CONTRACT);
    assert.equal(manifest.commit, commit);
    assert.equal(manifest.artifacts.jobs.runtime, JOBS_RUNTIME);
    assert.equal(
      manifest.artifacts.jobs.layers.piper.compressedBytes <=
        JOBS_LAYER_LIMIT_BYTES,
      true,
    );
    assert.equal(
      manifest.artifacts.jobs.layers.piper.key,
      `deployments/${manifest.artifacts.jobs.layers.piper.sha256}/jobs-piper-layer.zip`,
    );
    assert.equal(manifest.artifacts.parser.runtime, PARSER_RUNTIME);
    assert.deepEqual(Object.keys(manifest.artifacts.parser.layers), [
      "clamavSnapshot",
      "javaWorker",
      "nativeTools",
    ]);
    const parserArtifacts = [
      manifest.artifacts.parser.code,
      ...Object.values(manifest.artifacts.parser.layers),
    ];
    assert.equal(parserArtifacts.length - 1 <= PARSER_LAYER_COUNT_LIMIT, true);
    assert.equal(
      parserArtifacts.every(
        (artifact) =>
          artifact.key ===
            `deployments/${artifact.sha256}/${artifact.filename}` &&
          /^[a-f0-9]{64}$/.test(artifact.sha256) &&
          artifact.compressedBytes > 0 &&
          artifact.compressedBytes <= PARSER_ARCHIVE_LIMIT_BYTES,
      ),
      true,
    );
    assert.equal(
      parserArtifacts
        .slice(1)
        .reduce((total, artifact) => total + artifact.compressedBytes, 0) <=
        PARSER_LAYER_TOTAL_LIMIT_BYTES,
      true,
    );
    assert.equal(JSON.stringify(manifest).includes("parser.tar"), false);
    assert.equal(JSON.stringify(manifest).includes("acr"), false);
  });

  it("rejects a missing or empty immutable artifact", async () => {
    const directory = await fixture();
    await writeFile(path.join(directory, "parser-native-layer.zip"), "");
    await assert.rejects(
      buildDeploymentManifest(directory, "b".repeat(40)),
      /non-empty regular file/,
    );
  });

  it("rejects a non-exact commit", async () => {
    const directory = await fixture();
    await assert.rejects(
      buildDeploymentManifest(directory, "main"),
      /commit is invalid/,
    );
  });
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "reflo-deployment-manifest-"),
  );
  directories.push(directory);
  await Promise.all(
    filenames.map((filename, index) =>
      writeFile(path.join(directory, filename), `artifact-${index}`),
    ),
  );
  return directory;
}
