import { lstat, mkdir } from "node:fs/promises";

import {
  ClamAvScannerAdapter,
  NodeEphemeralWorkspace,
  NodeProcessRunner,
  NormalizedOutputFileReader,
  PodmanClamAvProcessRunner,
  PodmanDocumentWorker,
} from "@reflo/ingestion";

import {
  LocalIngestionBridge,
  type LocalIngestionBridgeEvent,
} from "./bridge.js";
import { readLocalIngestionBridgeConfiguration } from "./config.js";
import { LocalIngestionBridgeHttpClient } from "./http-client.js";
import { LocalIngestionHostReadiness } from "./readiness.js";

async function main(): Promise<void> {
  const configuration = readLocalIngestionBridgeConfiguration(process.env);
  await ensurePrivateWorkspaceRoot(configuration.workspaceRoot);
  const processRunner = new NodeProcessRunner();
  const scanner = new ClamAvScannerAdapter({
    databaseDirectory: configuration.admissionDatabaseDirectory,
    executable: "clamscan",
    expectedFreshClamImageDigest: configuration.scannerImage.slice(
      configuration.scannerImage.lastIndexOf("@") + 1,
    ),
    expectedProfile: "upstream-clamav-cloud-demo-v1",
    expectedSnapshotId: configuration.clamSnapshotId,
    manifestPath: configuration.clamManifestPath,
    runner: new PodmanClamAvProcessRunner(
      {
        databaseDirectory: configuration.admissionDatabaseDirectory,
        imageReference: configuration.scannerImage,
      },
      processRunner,
    ),
  });
  const bridge = new LocalIngestionBridge({
    api: new LocalIngestionBridgeHttpClient(
      configuration.apiOrigin,
      configuration.bearerToken,
    ),
    logger: {
      event: (event: LocalIngestionBridgeEvent) =>
        console.info(`ingestion-bridge:${event}`),
    },
    readiness: new LocalIngestionHostReadiness({
      processRunner,
      scanner,
      workerImageDigest: configuration.workerImageDigest,
      workerImageReference: configuration.workerImageReference,
    }),
    scanner,
    worker: new PodmanDocumentWorker(
      {
        clamDatabaseDirectory: configuration.clamDatabaseDirectory,
        environment: "dev",
        executable: "podman",
        imageReference: configuration.workerImageReference,
        resolvedImageDigest: configuration.workerImageDigest,
        tessdataDirectory: configuration.tessdataDirectory,
      },
      processRunner,
      new NormalizedOutputFileReader(),
    ),
    workspaces: new NodeEphemeralWorkspace(configuration.workspaceRoot),
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await bridge.run(controller.signal, configuration.pollIntervalMs);
}

async function ensurePrivateWorkspaceRoot(
  workspaceRoot: string,
): Promise<void> {
  await mkdir(workspaceRoot, { mode: 0o700, recursive: true });
  const metadata = await lstat(workspaceRoot);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("ingestion bridge workspace is unavailable");
  }
}

main().catch(() => {
  console.error("ingestion-bridge:unavailable");
  process.exitCode = 1;
});
