import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  hostPlatformKey,
  ingestionLaunchArguments,
  isSupportedPodmanVersion,
  renderProfileEnvironment,
  validateLocalWorkersContract,
} from "./local-workers.mjs";

const root = process.cwd();
const contract = readJson("scripts/local-workers-manifest.json");
const ingestionManifest = readJson("packages/ingestion/worker/manifest.json");
const piperManifest = readJson("packages/audio/piper-worker/manifest.json");
const containerfile = readFileSync(
  path.join(root, "packages/ingestion/worker/Containerfile"),
  "utf8",
);
const workerScript = readFileSync(
  path.join(root, "scripts/local-workers.mjs"),
  "utf8",
);

describe("optional local worker profile", () => {
  it("aligns development artifact pins with checked-in worker contracts", () => {
    assert.deepEqual(
      validateLocalWorkersContract(
        contract,
        ingestionManifest,
        piperManifest,
        containerfile,
      ),
      [],
    );
  });

  it("rejects mutable updater and incompatible Podman contracts", () => {
    const mutable = structuredClone(contract);
    mutable.clamav.updaterImage = "docker.io/clamav/clamav:1.4.5";
    mutable.supportedPodmanVersions = ["6.0.1"];
    const errors = validateLocalWorkersContract(
      mutable,
      ingestionManifest,
      piperManifest,
      containerfile,
    );

    assert.ok(
      errors.includes("Podman compatibility must be exactly 5.8.3 or 6.0.1"),
    );
    assert.ok(errors.includes("invalid development ClamAV contract"));
  });

  it("accepts only the explicit local Podman versions", () => {
    assert.equal(
      isSupportedPodmanVersion(
        "podman version 5.8.3",
        contract.supportedPodmanVersions,
      ),
      true,
    );
    assert.equal(
      isSupportedPodmanVersion(
        "podman version 6.0.1",
        contract.supportedPodmanVersions,
      ),
      true,
    );
    for (const output of [
      "podman version 5.8.2",
      "podman version 5.8.5",
      "podman version 6.0.0",
      "docker version 6.0.1",
    ]) {
      assert.equal(
        isSupportedPodmanVersion(output, contract.supportedPodmanVersions),
        false,
      );
    }
  });

  it("pins Piper wheels for every supported host platform", () => {
    assert.deepEqual(
      contract.piper.runtimes.map((runtime) => runtime.platform).sort(),
      ["darwin/arm64", "darwin/x64", "linux/arm64", "linux/x64"],
    );
    assert.match(hostPlatformKey("darwin", "x64"), /^darwin\/x64$/);
  });

  it("generates a non-secret profile with safely quoted paths", () => {
    const environment = renderProfileEnvironment(profileState());
    const keys = environment
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));

    assert.ok(environment.includes("Contains no credentials"));
    assert.ok(
      environment.includes(
        "REFLO_LOCAL_PIPER_MODEL_PATH='/tmp/reflo workers/voice.onnx'",
      ),
    );
    assert.ok(!keys.some((key) => /KEY|PASSWORD|SECRET|TOKEN/.test(key)));
    assert.equal(keys.length, new Set(keys).size);
  });

  it("retains the exact isolated ingestion launch authority", () => {
    const args = ingestionLaunchArguments({
      clamavDirectory: "/tmp/reflo-workers/clamav",
      components: ingestionManifest.components,
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageReference: "reflo-ingestion-worker:local",
      inputPath: "/tmp/reflo-workers/job/source",
      inputSha256: "b".repeat(64),
      operationId: "localworker-12345678",
      outputDirectory: "/tmp/reflo-workers/job/output",
      profile: contract.ingestion.profile,
      tessdataDirectory: "/tmp/reflo-workers/tessdata",
    });

    assert.ok(args.includes("--network=none"));
    assert.ok(args.includes("--cap-drop=ALL"));
    assert.ok(args.includes("--security-opt=no-new-privileges"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--user=65532:65532"));
    assert.ok(args.includes("--pull=never"));
    assert.ok(args.includes("--env=REFLO_TIKA_VERSION=apache-tika-3.3.1"));
    assert.equal(
      args.filter((argument) => argument.startsWith("--env=")).length,
      10,
    );
    assert.ok(
      !args.some((argument) =>
        /docker\.sock|podman\.sock|PASSWORD|SECRET|TOKEN|CREDENTIAL/.test(
          argument,
        ),
      ),
    );
    assert.equal(args.at(-1), "reflo-ingestion-worker:local");
  });

  it("requires immutable archive identity and scoped cleanup", () => {
    assert.ok(workerScript.includes("REFLO_LOCAL_INGESTION_ARCHIVE_SHA256"));
    assert.ok(
      workerScript.includes(
        'await requireDigest(archivePath, archiveSha256, "ingestion-worker")',
      ),
    );
    assert.ok(
      workerScript.includes('path.basename(generatedRoot) !== "local-workers"'),
    );
    assert.ok(!/podman", \["(?:system|image)", "prune"/.test(workerScript));
  });
});

function profileState() {
  return {
    ingestion: {
      imageReference: "reflo-ingestion-worker:local",
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
    clamav: { directory: "/tmp/reflo workers/clamav" },
    tessdata: { directory: "/tmp/reflo workers/tessdata" },
    piper: {
      artifactRevision: "b".repeat(40),
      configPath: "/tmp/reflo workers/voice.onnx.json",
      configSha256: "c".repeat(64),
      modelPath: "/tmp/reflo workers/voice.onnx",
      modelSha256: "d".repeat(64),
      pythonExecutable: "/tmp/reflo workers/venv/bin/python",
      voiceArtifactVersion: "piper-voice-en-us-ljspeech-high-v1",
    },
  };
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}
