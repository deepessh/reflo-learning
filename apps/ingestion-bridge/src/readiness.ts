import {
  INGESTION_PROFILE_VERSION,
  LOCAL_INGESTION_BRIDGE_PROFILE,
  LOCAL_INGESTION_BRIDGE_VERSION,
  parseLocalBridgeHeartbeat,
  type LocalBridgeHeartbeat,
  type LocalBridgePodmanVersion,
  type MalwareScannerPort,
  type ProcessRunnerPort,
} from "@reflo/ingestion";

import type { LocalIngestionHostReadinessPort } from "./bridge.js";

const PODMAN_VERSIONS = new Set(["5.8.3", "6.0.1"]);
const OUTPUT_LIMIT = 64 * 1_024;

export class LocalIngestionHostReadiness implements LocalIngestionHostReadinessPort {
  constructor(
    private readonly dependencies: {
      readonly clock?: { now(): Date };
      readonly processRunner: ProcessRunnerPort;
      readonly scanner: Pick<MalwareScannerPort, "currentSnapshot">;
      readonly workerImageDigest: string;
      readonly workerImageReference: string;
    },
  ) {}

  async check(): Promise<LocalBridgeHeartbeat> {
    const version = await this.dependencies.processRunner.run(
      "podman",
      ["version", "--format", "json"],
      { maxOutputBytes: OUTPUT_LIMIT, timeoutMs: 10_000 },
    );
    const versions = parsePodmanVersions(successOutput(version));
    const rootless = await this.dependencies.processRunner.run(
      "podman",
      ["info", "--format", "{{.Host.Security.Rootless}}"],
      { maxOutputBytes: OUTPUT_LIMIT, timeoutMs: 10_000 },
    );
    if (successOutput(rootless).trim() !== "true") unavailable();
    const inspected = await this.dependencies.processRunner.run(
      "podman",
      ["image", "inspect", this.dependencies.workerImageReference],
      { maxOutputBytes: OUTPUT_LIMIT, timeoutMs: 10_000 },
    );
    validateImage(
      successOutput(inspected),
      this.dependencies.workerImageDigest,
    );
    const snapshot = await this.dependencies.scanner.currentSnapshot();
    if (snapshot === null || !snapshot.verified) unavailable();
    return parseLocalBridgeHeartbeat({
      checkedAt: (this.dependencies.clock?.now() ?? new Date()).toISOString(),
      contractVersion: LOCAL_INGESTION_BRIDGE_VERSION,
      podmanClientVersion: versions.client,
      podmanServerVersion: versions.server,
      profile: LOCAL_INGESTION_BRIDGE_PROFILE,
      rootless: true,
      scannerSnapshotId: snapshot.signatureVersion,
      status: "available",
      workerImageDigest: this.dependencies.workerImageDigest,
    });
  }
}

function parsePodmanVersions(value: string): {
  readonly client: LocalBridgePodmanVersion;
  readonly server: LocalBridgePodmanVersion;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    unavailable();
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.Client) ||
    !isRecord(parsed.Server)
  ) {
    unavailable();
  }
  const client = parsed.Client.Version;
  const server = parsed.Server.Version;
  if (
    typeof client !== "string" ||
    typeof server !== "string" ||
    client !== server ||
    !PODMAN_VERSIONS.has(client)
  ) {
    unavailable();
  }
  return {
    client: client as LocalBridgePodmanVersion,
    server: server as LocalBridgePodmanVersion,
  };
}

function validateImage(value: string, expectedDigest: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    unavailable();
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    unavailable();
  }
  const image = parsed[0];
  if (
    image.Digest !== expectedDigest ||
    image.Os !== "linux" ||
    image.Architecture !== "amd64" ||
    !isRecord(image.Config) ||
    image.Config.User !== "65532:65532" ||
    !Array.isArray(image.Config.Entrypoint) ||
    image.Config.Entrypoint.length !== 3 ||
    image.Config.Entrypoint[0] !== "java" ||
    image.Config.Entrypoint[1] !== "-jar" ||
    image.Config.Entrypoint[2] !== "/opt/reflo/worker.jar" ||
    !isRecord(image.Config.Labels) ||
    image.Config.Labels["org.opencontainers.image.version"] !==
      INGESTION_PROFILE_VERSION ||
    (Array.isArray(image.Config.Env) &&
      image.Config.Env.some(
        (entry) =>
          typeof entry !== "string" ||
          /(?:^|_)(?:ACCESS|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:_|=)/i.test(
            entry,
          ),
      ))
  ) {
    unavailable();
  }
}

function successOutput(result: {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly timedOut: boolean;
}): string {
  if (
    result.timedOut ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.stdout.length > OUTPUT_LIMIT
  ) {
    unavailable();
  }
  return result.stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): never {
  throw new Error("local ingestion host is unavailable");
}
