import path from "node:path";

import {
  INGESTION_COMPONENTS,
  INGESTION_LIMITS,
  INGESTION_PROFILE_VERSION,
  type WorkerExecutionRequest,
} from "./contracts.js";
import { IngestionError } from "./errors.js";

const IMAGE_DIGEST =
  /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const LOCAL_IMAGE = /^reflo-ingestion-worker:local$/;

export interface PodmanWorkerConfiguration {
  readonly clamDatabaseDirectory: string;
  readonly environment: "dev" | "pilot" | "staging";
  readonly executable: string;
  readonly imageReference: string;
  readonly resolvedImageDigest: string;
  readonly tessdataDirectory: string;
}

export interface WorkerLaunch {
  readonly args: readonly string[];
  readonly executable: string;
  readonly timeoutMs: number;
}

export function createPodmanWorkerLaunch(
  configuration: PodmanWorkerConfiguration,
  request: WorkerExecutionRequest,
): WorkerLaunch {
  validateConfiguration(configuration);
  validateRequestPaths(request);
  const timeoutMs =
    request.processingLane === "standard"
      ? INGESTION_LIMITS.standardDocument.wallTimeMs
      : INGESTION_LIMITS.largeDocument.wallTimeMs;
  return {
    executable: configuration.executable,
    timeoutMs,
    args: [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--user=65532:65532",
      "--userns=keep-id:uid=65532,gid=65532",
      `--cpus=${INGESTION_LIMITS.worker.cpuCount}`,
      `--memory=${INGESTION_LIMITS.worker.memoryBytes}`,
      `--pids-limit=${INGESTION_LIMITS.worker.maxPids}`,
      `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${INGESTION_LIMITS.worker.temporaryStorageBytes}`,
      `--mount=type=bind,src=${request.inputPath},dst=/work/input/source,ro=true,relabel=private`,
      `--mount=type=bind,src=${request.outputDirectory},dst=/work/output,rw=true,relabel=private`,
      `--mount=type=bind,src=${configuration.clamDatabaseDirectory},dst=/opt/clamav/database,ro=true,relabel=private`,
      `--mount=type=bind,src=${configuration.tessdataDirectory},dst=/opt/tessdata,ro=true,relabel=private`,
      `--env=REFLO_INGESTION_PROFILE=${INGESTION_PROFILE_VERSION}`,
      `--env=REFLO_DOCUMENT_KIND=${request.documentKind}`,
      `--env=REFLO_INPUT_SHA256=${request.inputSha256}`,
      `--env=REFLO_OPERATION_ID=${request.operationId}`,
      `--env=REFLO_PROCESSING_LANE=${request.processingLane}`,
      `--env=REFLO_WORKER_IMAGE_DIGEST=${configuration.resolvedImageDigest}`,
      `--env=REFLO_CLAMAV_VERSION=${INGESTION_COMPONENTS.clamAv}`,
      `--env=REFLO_OCR_LANGUAGE_PROFILE=${INGESTION_COMPONENTS.ocrLanguage}`,
      `--env=REFLO_TESSERACT_VERSION=${INGESTION_COMPONENTS.ocrEngine}`,
      `--env=REFLO_TIKA_VERSION=${INGESTION_COMPONENTS.parser}`,
      configuration.imageReference,
    ],
  };
}

function validateConfiguration(configuration: PodmanWorkerConfiguration): void {
  if (
    configuration.executable !== "podman" ||
    !/^sha256:[a-f0-9]{64}$/.test(configuration.resolvedImageDigest) ||
    !path.isAbsolute(configuration.clamDatabaseDirectory) ||
    !path.isAbsolute(configuration.tessdataDirectory) ||
    (configuration.environment === "dev"
      ? !IMAGE_DIGEST.test(configuration.imageReference) &&
        !LOCAL_IMAGE.test(configuration.imageReference)
      : !IMAGE_DIGEST.test(configuration.imageReference))
  ) {
    throw new IngestionError("infrastructure_unavailable");
  }
  const referencedDigest = configuration.imageReference.match(
    /@(sha256:[a-f0-9]{64})$/,
  )?.[1];
  if (
    referencedDigest !== undefined &&
    referencedDigest !== configuration.resolvedImageDigest
  ) {
    throw new IngestionError("infrastructure_unavailable");
  }
}

function validateRequestPaths(request: WorkerExecutionRequest): void {
  if (
    !path.isAbsolute(request.inputPath) ||
    !path.isAbsolute(request.outputDirectory) ||
    path.dirname(request.inputPath) !== path.dirname(request.outputDirectory) ||
    !path
      .basename(path.dirname(request.inputPath))
      .startsWith(`${request.operationId}-`) ||
    path.basename(request.inputPath) !== "source" ||
    path.basename(request.outputDirectory) !== "output" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(request.operationId) ||
    !/^[a-f0-9]{64}$/.test(request.inputSha256)
  ) {
    throw new IngestionError("infrastructure_unavailable");
  }
}
