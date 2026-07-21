import { describe, expect, it } from "vitest";

import { INGESTION_LIMITS } from "./contracts.js";
import { IngestionError } from "./errors.js";
import { createPodmanWorkerLaunch } from "./worker-profile.js";

const REQUEST = {
  documentKind: "pdf" as const,
  inputPath: "/var/lib/reflo/jobs/operation-0001-attempt/source",
  inputSha256: "a".repeat(64),
  operationId: "operation-0001",
  outputDirectory: "/var/lib/reflo/jobs/operation-0001-attempt/output",
  processingLane: "standard" as const,
};

const CONFIGURATION = {
  clamDatabaseDirectory: "/var/lib/reflo/clamav/snapshot",
  environment: "pilot" as const,
  executable: "podman",
  imageReference: `registry.example/reflo/ingestion@sha256:${"b".repeat(64)}`,
  resolvedImageDigest: `sha256:${"b".repeat(64)}`,
  tessdataDirectory: "/var/lib/reflo/tessdata/eng",
};

describe("createPodmanWorkerLaunch", () => {
  it("builds a networkless, non-root, capability-free, bounded launch", () => {
    const launch = createPodmanWorkerLaunch(CONFIGURATION, REQUEST);
    expect(launch.executable).toBe("podman");
    expect(launch.timeoutMs).toBe(INGESTION_LIMITS.standardDocument.wallTimeMs);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--user=65532:65532",
        "--cpus=2",
        `--memory=${4 * 1_024 * 1_024 * 1_024}`,
        "--pids-limit=256",
        "--pull=never",
      ]),
    );
    expect(launch.args.some((arg) => arg.includes("docker.sock"))).toBe(false);
    expect(launch.args).not.toContain("--security-opt=seccomp=unconfined");
    expect(launch.args.filter((arg) => arg.startsWith("--env="))).toHaveLength(
      10,
    );
    expect(
      launch.args.some((arg) => /SECRET|TOKEN|PASSWORD|KEY=/.test(arg)),
    ).toBe(false);
  });

  it("requires a digest outside local development and rejects unsafe paths", () => {
    expectFailure(() =>
      createPodmanWorkerLaunch(
        { ...CONFIGURATION, imageReference: "reflo-ingestion-worker:latest" },
        REQUEST,
      ),
    );
    expectFailure(() =>
      createPodmanWorkerLaunch(
        { ...CONFIGURATION, resolvedImageDigest: `sha256:${"c".repeat(64)}` },
        REQUEST,
      ),
    );
    expectFailure(() =>
      createPodmanWorkerLaunch(CONFIGURATION, {
        ...REQUEST,
        inputPath: "/var/lib/reflo/jobs/another/source",
      }),
    );
  });

  it("allows only the explicit local image alias in development", () => {
    expect(
      createPodmanWorkerLaunch(
        {
          ...CONFIGURATION,
          environment: "dev",
          imageReference: "reflo-ingestion-worker:local",
        },
        REQUEST,
      ).args,
    ).toContain("reflo-ingestion-worker:local");
  });
});

function expectFailure(operation: () => unknown): void {
  expect(operation).toThrowError(IngestionError);
}
