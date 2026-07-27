import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  hostPlatformKey,
  ingestionLaunchArguments,
  isSupportedPodmanVersion,
  clamavSnapshotId,
  parsePodmanVersionReport,
  piperStatePathsMatch,
  podmanVersionReportIsSupported,
  renderProfileEnvironment,
  unexpectedClamavDirectoryEntries,
  validateClamavAdmission,
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

  it("requires supported Podman client and server runtimes", () => {
    const report = parsePodmanVersionReport(
      JSON.stringify({
        Client: { Version: "5.8.3" },
        Server: { Version: "5.8.5" },
      }),
    );

    assert.deepEqual(report, {
      clientVersion: "5.8.3",
      serverVersion: "5.8.5",
    });
    assert.ok(
      !podmanVersionReportIsSupported(report, contract.supportedPodmanVersions),
    );
    assert.equal(
      podmanVersionReportIsSupported(
        { clientVersion: "5.8.3", serverVersion: "6.0.1" },
        contract.supportedPodmanVersions,
      ),
      false,
    );
    assert.equal(
      podmanVersionReportIsSupported(
        { clientVersion: "6.0.1", serverVersion: "6.0.1" },
        contract.supportedPodmanVersions,
      ),
      true,
    );
    assert.equal(parsePodmanVersionReport('{"Client":{}}'), undefined);
  });

  it("pins Piper wheels for every supported host platform", () => {
    assert.deepEqual(
      contract.piper.runtimes.map((runtime) => runtime.platform).sort(),
      ["darwin/arm64", "darwin/x64", "linux/arm64", "linux/x64"],
    );
    assert.match(hostPlatformKey("darwin", "x64"), /^darwin\/x64$/);
  });

  it("pins the exact checked-in Piper Python patch version", () => {
    const mismatched = structuredClone(contract);
    mismatched.piper.pythonVersion = "3.13.11";

    assert.ok(
      validateLocalWorkersContract(
        mismatched,
        ingestionManifest,
        piperManifest,
        containerfile,
      ).includes("Piper Python version does not match the checked-in manifest"),
    );
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
    assert.ok(
      environment.includes(
        "REFLO_DEMO_UPLOAD_MALWARE_SCANNER_MODE='upstream-clamav-cloud-demo-v1'",
      ),
    );
    assert.ok(
      !keys.some((key) => /PASSWORD|SECRET|TOKEN|PRIVATE_KEY/.test(key)),
    );
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
    assert.ok(workerScript.includes("if (archiveLoaded) throw error"));
    assert.ok(workerScript.includes('"archive",'));
    assert.ok(workerScript.includes('"reflo-ingestion-build-"'));
    assert.ok(!/podman", \["(?:system|image)", "prune"/.test(workerScript));
  });

  it("rejects additional ClamAV inputs outside the recorded snapshot", () => {
    const file = (name) => ({ name, isFile: () => true });
    const directory = (name) => ({ name, isFile: () => false });

    assert.deepEqual(
      unexpectedClamavDirectoryEntries(
        [
          file("main.cvd"),
          file("daily.cld"),
          file("bytecode.cvd"),
          file("freshclam.dat"),
        ],
        ["main.cvd", "daily.cld", "bytecode.cvd"],
        contract.clamav.allowedMetadataFiles,
      ),
      [],
    );
    assert.deepEqual(
      unexpectedClamavDirectoryEntries(
        [file("custom.ndb"), directory("nested")],
        [],
        contract.clamav.allowedMetadataFiles,
      ),
      ["custom.ndb", "nested"],
    );
  });

  it("verifies the exact upstream-signed content-addressed ClamAV bundle", async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "reflo-clamav-upstream-"));
    try {
      const files = ["bytecode.cvd", "daily.cld", "main.cvd"].map(
        (filename, index) => {
          const bytes = Buffer.from(`upstream-clamav-${index}`, "utf8");
          return {
            buildTime: "2026-07-26T18:00:00.000Z",
            byteLength: bytes.byteLength,
            bytes,
            databaseVersion: 27_100 + index,
            name: filename,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        },
      );
      const identity = {
        clamAvVersion: "1.4.5",
        contractVersion: "upstream-clamav-snapshot-manifest-v1",
        files: files.map(({ bytes: _bytes, ...file }) => file),
        profile: "upstream-clamav-cloud-demo-v1",
        publishedAt: "2026-07-26T18:10:00.000Z",
        toolchain: {
          freshClamImageDigest: contract.clamav.updaterImageDigest,
          sigtoolVersion: "ClamAV 1.4.5",
        },
      };
      const snapshotId = clamavSnapshotId(identity);
      const databaseDirectory = path.join(fixture, snapshotId);
      mkdirSync(databaseDirectory);
      for (const file of files) {
        writeFileSync(path.join(databaseDirectory, file.name), file.bytes);
      }
      const manifest = Buffer.from(JSON.stringify({ ...identity, snapshotId }));
      const manifestPath = path.join(databaseDirectory, "snapshot.json");
      writeFileSync(manifestPath, manifest);

      await assert.doesNotReject(
        validateClamavAdmission(
          contract,
          {
            files: files.map(({ bytes: _bytes, ...file }) => ({
              buildTime: file.buildTime,
              byteLength: file.byteLength,
              databaseVersion: file.databaseVersion,
              filename: file.name,
              sha256: file.sha256,
            })),
            toolchain: identity.toolchain,
          },
          {
            directory: databaseDirectory,
            manifestPath,
            manifestSha256: createHash("sha256").update(manifest).digest("hex"),
            profile: identity.profile,
            scannerImage: contract.clamav.updaterImage,
            snapshotId,
          },
          new Date("2026-07-26T18:30:00.000Z"),
        ),
      );
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("rejects state-recorded Piper paths before execution", () => {
    const piperDirectory = "/tmp/reflo-workers/piper";
    const state = {
      configPath: `${piperDirectory}/en_US-ljspeech-high.onnx.json`,
      modelPath: `${piperDirectory}/en_US-ljspeech-high.onnx`,
      preflightWavPath: `${piperDirectory}/preflight.wav`,
      pythonExecutable: `${piperDirectory}/venv/bin/python`,
    };

    assert.equal(
      piperStatePathsMatch(state, piperDirectory, contract.piper.voice),
      true,
    );
    assert.equal(
      piperStatePathsMatch(
        { ...state, pythonExecutable: "/tmp/untrusted-python" },
        piperDirectory,
        contract.piper.voice,
      ),
      false,
    );
    assert.equal(contract.piper.pythonVersion, "3.13.12");
  });
});

function profileState() {
  return {
    ingestion: {
      imageReference: "reflo-ingestion-worker:local",
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
    clamav: { directory: "/tmp/reflo workers/clamav" },
    clamavAdmission: {
      directory: `/tmp/reflo workers/clamav-admission/cvd-${"e".repeat(32)}`,
      manifestPath: `/tmp/reflo workers/clamav-admission/cvd-${"e".repeat(32)}/snapshot.json`,
      manifestSha256: "e".repeat(64),
      profile: "upstream-clamav-cloud-demo-v1",
      scannerImage: `clamav@sha256:${"f".repeat(64)}`,
      snapshotId: `cvd-${"e".repeat(32)}`,
    },
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
