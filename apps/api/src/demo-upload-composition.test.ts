import { describe, expect, it, vi } from "vitest";

import { PodmanClamAvProcessRunner } from "./demo-upload-composition.js";

const result = {
  exitCode: 0,
  signal: null,
  stderr: "",
  stdout: "ClamAV 1.4.5",
  timedOut: false,
};

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
});
