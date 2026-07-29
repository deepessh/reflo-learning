import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOYMENT_ARTIFACT_CONTRACT = "reflo-dev-deployment-artifacts-v3";
export const JOBS_RUNTIME = "nodejs20";
export const JOBS_LAYER_LIMIT_BYTES = 500 * 1024 * 1024;
export const PARSER_RUNTIME = "custom.debian11";
export const PARSER_ARCHIVE_LIMIT_BYTES = 500 * 1024 * 1024;
export const PARSER_LAYER_COUNT_LIMIT = 4;
export const PARSER_LAYER_TOTAL_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

const artifactFiles = Object.freeze({
  api: "api.tar.gz",
  jobs: "jobs.zip",
  jobsPiperLayer: "jobs-piper-layer.zip",
  parserCode: "parser-code.zip",
  parserJavaWorker: "parser-java-worker-layer.zip",
  parserNative: "parser-native-layer.zip",
  parserClamavSnapshot: "parser-clamav-snapshot-layer.zip",
});

export async function buildDeploymentManifest(directory, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new Error("deployment manifest commit is invalid");
  }
  const artifacts = Object.fromEntries(
    await Promise.all(
      Object.entries(artifactFiles).map(async ([name, filename]) => [
        name,
        await immutableArtifact(directory, filename),
      ]),
    ),
  );
  const parserLayers = [
    artifacts.parserJavaWorker,
    artifacts.parserNative,
    artifacts.parserClamavSnapshot,
  ];
  if (artifacts.jobsPiperLayer.compressedBytes > JOBS_LAYER_LIMIT_BYTES) {
    throw new Error(
      "jobs-piper-layer.zip exceeds the 500 MiB Function Compute layer limit",
    );
  }
  for (const archive of [artifacts.parserCode, ...parserLayers]) {
    if (archive.compressedBytes > PARSER_ARCHIVE_LIMIT_BYTES) {
      throw new Error(
        `${archive.filename} exceeds the 500 MiB Function Compute archive limit`,
      );
    }
  }
  if (parserLayers.length > PARSER_LAYER_COUNT_LIMIT) {
    throw new Error("parser layer count exceeds the Function Compute limit");
  }
  const totalLayerBytes = parserLayers.reduce(
    (total, layer) => total + layer.compressedBytes,
    0,
  );
  if (totalLayerBytes > PARSER_LAYER_TOTAL_LIMIT_BYTES) {
    throw new Error(
      "parser layers exceed the 2 GiB Function Compute compressed-size limit",
    );
  }
  return {
    artifacts: {
      api: artifacts.api,
      jobs: {
        code: artifacts.jobs,
        layers: { piper: artifacts.jobsPiperLayer },
        runtime: JOBS_RUNTIME,
      },
      parser: {
        code: artifacts.parserCode,
        layers: {
          clamavSnapshot: artifacts.parserClamavSnapshot,
          javaWorker: artifacts.parserJavaWorker,
          nativeTools: artifacts.parserNative,
        },
        runtime: PARSER_RUNTIME,
      },
    },
    commit,
    contractVersion: DEPLOYMENT_ARTIFACT_CONTRACT,
  };
}

export async function writeDeploymentManifest(output, commit) {
  const root = path.resolve(".artifacts/deployment");
  const destination = path.resolve(output);
  if (
    destination !== path.join(root, "manifest.json") ||
    path.dirname(destination) !== root
  ) {
    throw new Error(
      "deployment manifest must be .artifacts/deployment/manifest.json",
    );
  }
  const manifest = await buildDeploymentManifest(root, commit);
  await writePrivateJson(destination, manifest);
  await writePrivateJson(path.join(root, "deployment.tfvars.json"), {
    deployment_manifest: manifest,
  });
  console.info(
    `Prepared immutable deployment manifest for commit ${commit.slice(0, 12)}`,
  );
}

async function immutableArtifact(directory, filename) {
  const filePath = path.join(directory, filename);
  const [bytes, metadata] = await Promise.all([
    readFile(filePath),
    stat(filePath),
  ]);
  if (!metadata.isFile() || metadata.size < 1) {
    throw new Error(`${filename} is not a non-empty regular file`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    compressedBytes: metadata.size,
    filename,
    key: `deployments/${sha256}/${filename}`,
    sha256,
  };
}

async function writePrivateJson(destination, value) {
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [output, commit] = process.argv.slice(2);
  if (output === undefined || commit === undefined) {
    throw new Error("deployment manifest inputs are invalid");
  }
  await writeDeploymentManifest(output, commit);
}
