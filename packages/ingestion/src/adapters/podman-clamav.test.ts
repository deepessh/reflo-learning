import { describe, expect, it, vi } from "vitest";

import type { ProcessResult, ProcessRunnerPort } from "../ports.js";
import { PodmanClamAvProcessRunner } from "./podman-clamav.js";

const RESULT: ProcessResult = {
  exitCode: 0,
  signal: null,
  stderr: "",
  stdout: "ClamAV 1.4.5",
  timedOut: false,
};
const CONFIGURATION = {
  databaseDirectory: "/var/reflo/clamav-admission",
  imageReference: `docker.io/clamav/clamav@sha256:${"a".repeat(64)}`,
};

describe("PodmanClamAvProcessRunner", () => {
  it("runs the exact scanner with a read-only job and database boundary", async () => {
    const delegate = runner();
    const scanner = new PodmanClamAvProcessRunner(CONFIGURATION, delegate);
    await scanner.run(
      "clamscan",
      [
        `--database=${CONFIGURATION.databaseDirectory}`,
        "--no-summary",
        "--stdout",
        "--infected",
        "--",
        "/var/reflo/jobs/job-1/source",
      ],
      { maxOutputBytes: 8_192, timeoutMs: 60_000 },
    );

    const [, args] = vi.mocked(delegate.run).mock.calls[0]!;
    expect(args).toEqual(
      expect.arrayContaining([
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--user=100:101",
        "--pids-limit=64",
        "--memory=1073741824",
        "--cpus=1",
        `--mount=type=bind,src=${CONFIGURATION.databaseDirectory},dst=/database,ro=true,relabel=private`,
        "--mount=type=bind,src=/var/reflo/jobs/job-1,dst=/input,ro=true,relabel=private",
        "/input/source",
      ]),
    );
    expect(
      args.some((arg) => /PASSWORD|SECRET|TOKEN|CREDENTIAL/.test(arg)),
    ).toBe(false);
  });

  it("runs sigtool only for the admitted database set", async () => {
    const delegate = runner();
    const scanner = new PodmanClamAvProcessRunner(CONFIGURATION, delegate);
    await scanner.run(
      "sigtool",
      ["--info", `${CONFIGURATION.databaseDirectory}/daily.cvd`],
      { maxOutputBytes: 8_192, timeoutMs: 60_000 },
    );
    expect(vi.mocked(delegate.run).mock.calls[0]![1]).toContain(
      "/database/daily.cvd",
    );
    await expect(
      scanner.run("sigtool", ["--info", "/tmp/untrusted.cvd"], {
        maxOutputBytes: 8_192,
        timeoutMs: 60_000,
      }),
    ).resolves.toMatchObject({ exitCode: 127 });
    expect(delegate.run).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary commands, paths, and mutable image configuration", async () => {
    const delegate = runner();
    const scanner = new PodmanClamAvProcessRunner(CONFIGURATION, delegate);
    await expect(
      scanner.run("sh", ["-c", "id"], {
        maxOutputBytes: 8_192,
        timeoutMs: 60_000,
      }),
    ).resolves.toMatchObject({ exitCode: 127 });
    await expect(
      scanner.run(
        "clamscan",
        [
          `--database=${CONFIGURATION.databaseDirectory}`,
          "--no-summary",
          "--stdout",
          "--infected",
          "--",
          "/source",
        ],
        { maxOutputBytes: 8_192, timeoutMs: 60_000 },
      ),
    ).resolves.toMatchObject({ exitCode: 127 });
    expect(delegate.run).not.toHaveBeenCalled();
    expect(
      () =>
        new PodmanClamAvProcessRunner(
          { ...CONFIGURATION, imageReference: "clamav:latest" },
          delegate,
        ),
    ).toThrow("invalid Podman ClamAV configuration");
  });
});

function runner(): ProcessRunnerPort {
  return { run: vi.fn(async () => RESULT) };
}
