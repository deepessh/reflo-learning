import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDemoUploadRuntime,
  PodmanClamAvProcessRunner,
} from "./demo-upload-composition.js";

const result = {
  exitCode: 0,
  signal: null,
  stderr: "",
  stdout: "ClamAV 1.4.5",
  timedOut: false,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("demo upload ClamAV runner", () => {
  it("runs the pinned scanner without network or host-runtime authority", async () => {
    const delegate = { run: vi.fn(async () => result) };
    const runner = new PodmanClamAvProcessRunner(
      {
        databaseDirectory: "/var/reflo/clamav-admission",
        imageReference: `clamav@sha256:${"a".repeat(64)}`,
      },
      delegate,
    );

    await runner.run(
      "clamscan",
      [
        "--database=/var/reflo/clamav-admission",
        "--no-summary",
        "--stdout",
        "--infected",
        "--",
        "/var/reflo/jobs/job-1/source.pdf",
      ],
      { maxOutputBytes: 8_192, timeoutMs: 60_000 },
    );

    const [, args] = delegate.run.mock.calls[0];
    expect(args).toContain("--network=none");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--read-only");
    expect(args).toContain("--memory=1073741824");
    expect(args).toContain(
      "--mount=type=bind,src=/var/reflo/clamav-admission,dst=/database,ro=true,relabel=private",
    );
    expect(args).toContain(
      "--mount=type=bind,src=/var/reflo/jobs/job-1,dst=/input,ro=true,relabel=private",
    );
    expect(args).toContain("/input/source.pdf");
  });

  it("rejects commands outside the exact clamscan invocation", async () => {
    const delegate = { run: vi.fn(async () => result) };
    const runner = new PodmanClamAvProcessRunner(
      {
        databaseDirectory: "/var/reflo/clamav-admission",
        imageReference: `clamav@sha256:${"a".repeat(64)}`,
      },
      delegate,
    );

    await expect(
      runner.run("sh", ["-c", "id"], {
        maxOutputBytes: 8_192,
        timeoutMs: 60_000,
      }),
    ).resolves.toMatchObject({ exitCode: 127 });
    expect(delegate.run).not.toHaveBeenCalled();
  });

  it("independently verifies only admitted database files with confined sigtool", async () => {
    const delegate = { run: vi.fn(async () => result) };
    const runner = new PodmanClamAvProcessRunner(
      {
        databaseDirectory: "/var/reflo/clamav-admission",
        imageReference: `clamav@sha256:${"a".repeat(64)}`,
      },
      delegate,
    );

    await runner.run(
      "sigtool",
      ["--info", "/var/reflo/clamav-admission/daily.cvd"],
      { maxOutputBytes: 8_192, timeoutMs: 60_000 },
    );

    const [, args] = delegate.run.mock.calls[0];
    expect(args).toContain("--network=none");
    expect(args).toContain(
      "--mount=type=bind,src=/var/reflo/clamav-admission,dst=/database,ro=true,relabel=private",
    );
    expect(args).toContain("--entrypoint=/usr/bin/sigtool");
    expect(args).toContain("/database/daily.cvd");

    await expect(
      runner.run("sigtool", ["--info", "/tmp/untrusted.cvd"], {
        maxOutputBytes: 8_192,
        timeoutMs: 60_000,
      }),
    ).resolves.toMatchObject({ exitCode: 127 });
    expect(delegate.run).toHaveBeenCalledTimes(1);
  });
});

describe("serverless demo upload composition", () => {
  it("rejects the FC parser outside the owner-approved Singapore region before cloud access", async () => {
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "reflo-serverless-composition-"),
    );
    temporaryDirectories.push(artifactRoot);

    await expect(
      createDemoUploadRuntime(
        {
          DATABASE_URL: "postgresql://unused",
          REFLO_ALIBABA_REGION: "us-west-1",
          REFLO_CONNECTED_DEMO_ARTIFACT_ROOT: artifactRoot,
          REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE:
            "staff-controlled-rights-cleared-v1",
          REFLO_CONNECTED_DEMO_MODE: "staff-only-demo-v1",
          REFLO_DEMO_OPERATOR_OWNER_SCOPE_ID:
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          REFLO_DEMO_OPERATOR_USER_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          REFLO_DEMO_UPLOAD_PROCESSOR_MODE: "serverless-isolated-ingestion-v1",
          REFLO_ENV: "dev",
          REFLO_VECTOR_DATABASE_URL: "postgresql://unused",
        },
        "dev",
      ),
    ).rejects.toThrow("approved only in Singapore");
  });
});
