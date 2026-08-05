import type { ProcessResult, ProcessRunnerPort } from "@reflo/ingestion";
import { describe, expect, it } from "vitest";

import { LocalIngestionHostReadiness } from "./readiness.js";

const digest = `sha256:${"d".repeat(64)}`;

describe("local ingestion host readiness", () => {
  it("requires matching allowed rootless Podman and exact worker identity", async () => {
    const calls: string[] = [];
    const readiness = new LocalIngestionHostReadiness({
      clock: { now: () => new Date("2026-07-31T18:00:00.000Z") },
      processRunner: runner(calls),
      scanner: {
        currentSnapshot: async () => ({
          publishedAt: new Date("2026-07-31T17:30:00.000Z"),
          signatureVersion: `cvd-${"e".repeat(32)}`,
          verified: true,
        }),
      },
      workerImageDigest: digest,
      workerImageReference: "reflo-ingestion-worker:local",
    });

    await expect(readiness.check()).resolves.toMatchObject({
      podmanClientVersion: "6.0.1",
      podmanServerVersion: "6.0.1",
      rootless: true,
      workerImageDigest: digest,
    });
    expect(calls).toEqual(["version", "info", "image"]);
  });

  it("fails closed on client/server drift without reporting raw output", async () => {
    const readiness = new LocalIngestionHostReadiness({
      processRunner: runner([], "5.8.3"),
      scanner: { currentSnapshot: async () => null },
      workerImageDigest: digest,
      workerImageReference: "reflo-ingestion-worker:local",
    });

    await expect(readiness.check()).rejects.toThrow(
      "local ingestion host is unavailable",
    );
  });
});

function runner(calls: string[], serverVersion = "6.0.1"): ProcessRunnerPort {
  return {
    run: async (_executable, args): Promise<ProcessResult> => {
      calls.push(args[0]!);
      const stdout =
        args[0] === "version"
          ? JSON.stringify({
              Client: { Version: "6.0.1" },
              Server: { Version: serverVersion },
            })
          : args[0] === "info"
            ? "true\n"
            : JSON.stringify([
                {
                  Architecture: "amd64",
                  Config: {
                    Entrypoint: ["java", "-jar", "/opt/reflo/worker.jar"],
                    Env: ["PATH=/usr/bin"],
                    Labels: {
                      "org.opencontainers.image.version":
                        "isolated-ingestion-v1",
                    },
                    User: "65532:65532",
                  },
                  Digest: digest,
                  Os: "linux",
                },
              ]);
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout,
        timedOut: false,
      };
    },
  };
}
