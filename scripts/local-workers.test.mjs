import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
        "REFLO_DEMO_UPLOAD_MALWARE_SCANNER_MODE='verified-clamav-v1'",
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

  it("verifies the exact KMS-signed ClamAV admission bundle", async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "reflo-clamav-signed-"));
    const databaseDirectory = path.join(fixture, "snapshot");
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    try {
      mkdirSync(databaseDirectory);
      const files = ["bytecode.cvd", "daily.cld", "main.cvd"].map(
        (filename, index) => {
          const bytes = Buffer.from(`signed-clamav-${index}`, "utf8");
          writeFileSync(path.join(databaseDirectory, filename), bytes);
          return {
            byteLength: bytes.byteLength,
            name: filename,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        },
      );
      const publicKeyPath = path.join(fixture, "public.pem");
      const spki = publicKey.export({ format: "der", type: "spki" });
      const spkiSha256 = createHash("sha256").update(spki).digest("hex");
      writeFileSync(
        publicKeyPath,
        publicKey.export({ format: "pem", type: "spki" }),
      );
      const manifest = Buffer.from(
        JSON.stringify({
          clamAvVersion: "1.4.5",
          contractVersion: "snapshot-manifest-v1",
          files,
          kid: "local-test-kid",
          publishedAt: new Date().toISOString(),
          publicKeySpkiSha256: spkiSha256,
          signatureProfile: "clamav-snapshot-signature-v1",
          snapshotId: "local-test-snapshot",
        }),
      );
      const manifestPath = path.join(databaseDirectory, "snapshot.json");
      const signaturePath = path.join(databaseDirectory, "snapshot.sig");
      writeFileSync(manifestPath, manifest);
      writeFileSync(
        signaturePath,
        sign("sha256", manifest, privateKey).toString("base64"),
      );

      await assert.doesNotReject(
        validateClamavAdmission(
          contract,
          {
            files: files.map((file) => ({
              byteLength: file.byteLength,
              filename: file.name,
              sha256: file.sha256,
            })),
          },
          {
            directory: databaseDirectory,
            kid: "local-test-kid",
            manifestPath,
            publicKeyPath,
            publicKeySpkiSha256: spkiSha256,
            scannerImage: contract.clamav.updaterImage,
            signaturePath,
          },
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
      directory: "/tmp/reflo workers/clamav-admission",
      kid: "reflo-clamav-v1",
      manifestPath: "/tmp/reflo workers/clamav-admission/snapshot.json",
      publicKeyPath: "/tmp/reflo workers/clamav-public.pem",
      publicKeySpkiSha256: "e".repeat(64),
      scannerImage: `clamav@sha256:${"f".repeat(64)}`,
      signaturePath: "/tmp/reflo workers/clamav-admission/snapshot.sig",
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
