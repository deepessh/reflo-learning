import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunnerPort } from "../ports.js";
import {
  CLAMAV_UPSTREAM_SNAPSHOT_MANIFEST_CONTRACT,
  CLAMAV_UPSTREAM_SNAPSHOT_PROFILE,
  ClamAvScannerAdapter,
  upstreamClamAvSnapshotId,
} from "./clamav.js";

const scratch: string[] = [];
const now = new Date("2026-07-26T18:30:00.000Z");

afterEach(async () => {
  await Promise.all(
    scratch
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ClamAvScannerAdapter", () => {
  it("independently verifies upstream signatures and exact identity before scanning", async () => {
    const fixture = await snapshotFixture();
    const runner = verifiedRunner(processResult(0, ""));
    const adapter = fixture.adapter(runner);
    const snapshot = await adapter.currentSnapshot();

    expect(snapshot).toMatchObject({
      signatureVersion: fixture.snapshotId,
      verified: true,
    });
    await expect(
      adapter.scan(staged(fixture.directory), snapshot!),
    ).resolves.toEqual({ clean: true });
    expect(runner.calls.map((call) => call.executable)).toEqual([
      "sigtool",
      "sigtool",
      "sigtool",
      "sigtool",
      "clamscan",
      "clamscan",
    ]);
  });

  it("maps the documented infected exit status without exposing output", async () => {
    const fixture = await snapshotFixture();
    const adapter = fixture.adapter(
      verifiedRunner(processResult(1, "/work/source: signature FOUND\n")),
    );
    const snapshot = await adapter.currentSnapshot();

    await expect(
      adapter.scan(staged(fixture.directory), snapshot!),
    ).resolves.toEqual({ clean: false });
  });

  it("rejects tampered manifests and symlinked database files", async () => {
    const fixture = await snapshotFixture();
    await writeFile(fixture.manifestPath, "{}\n");
    await expect(
      fixture.adapter(new SequencedRunner([])).currentSnapshot(),
    ).resolves.toBeNull();

    const second = await snapshotFixture();
    await rm(path.join(second.directory, "daily.cvd"));
    await symlink(
      second.manifestPath,
      path.join(second.directory, "daily.cvd"),
    );
    await expect(
      second.adapter(new SequencedRunner([])).currentSnapshot(),
    ).resolves.toBeNull();
  });

  it("rejects extra databases and mismatched content addresses", async () => {
    const fixture = await snapshotFixture();
    await writeFile(path.join(fixture.directory, "untrusted.ndb"), "extra");
    await expect(
      fixture.adapter(new SequencedRunner([])).currentSnapshot(),
    ).resolves.toBeNull();

    const second = await snapshotFixture();
    const manifest = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(second.manifestPath, "utf8"),
      ),
    ) as Record<string, unknown>;
    await writeFile(
      second.manifestPath,
      JSON.stringify({ ...manifest, snapshotId: `cvd-${"f".repeat(32)}` }),
    );
    await expect(
      second.adapter(new SequencedRunner([])).currentSnapshot(),
    ).resolves.toBeNull();
  });

  it("rejects a database when independent upstream verification fails", async () => {
    const fixture = await snapshotFixture();
    const runner = new SequencedRunner([
      processResult(0, "ClamAV 1.4.5\n"),
      processResult(0, sigtoolInfo(101)),
      processResult(0, sigtoolInfo(102).replace("Verification OK.\n", "")),
    ]);

    await expect(fixture.adapter(runner).currentSnapshot()).resolves.toBeNull();
  });

  it("rejects stale snapshots and scanner version drift", async () => {
    const fixture = await snapshotFixture();
    await expect(
      fixture
        .adapter(verifiedRunner(processResult(0, "")), fixture.snapshotId, {
          now: () => new Date("2026-07-28T18:30:00.000Z"),
        })
        .currentSnapshot(),
    ).resolves.toBeNull();

    const adapter = fixture.adapter(
      verifiedRunner(
        processResult(0, ""),
        processResult(0, "ClamAV 1.4.6/27100/date\n"),
      ),
    );
    const snapshot = await adapter.currentSnapshot();
    await expect(
      adapter.scan(staged(fixture.directory), snapshot!),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
  });
});

async function snapshotFixture(): Promise<{
  adapter(
    runner: ProcessRunnerPort,
    expectedSnapshotId?: string,
    clock?: { now(): Date },
  ): ClamAvScannerAdapter;
  directory: string;
  manifestPath: string;
  snapshotId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reflo-clamav-"));
  scratch.push(root);
  const definitions = [
    ["bytecode.cvd", 101],
    ["daily.cvd", 102],
    ["main.cvd", 103],
  ] as const;
  const files = definitions.map(([name, databaseVersion]) => {
    const bytes = Buffer.from(`upstream-clamav-${name}`, "utf8");
    return {
      buildTime: "2026-07-26T18:00:00.000Z",
      byteLength: bytes.byteLength,
      bytes,
      databaseVersion,
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const identity = {
    clamAvVersion: "1.4.5",
    contractVersion: CLAMAV_UPSTREAM_SNAPSHOT_MANIFEST_CONTRACT,
    files: files.map(({ bytes: _bytes, ...file }) => file),
    profile: CLAMAV_UPSTREAM_SNAPSHOT_PROFILE,
    publishedAt: "2026-07-26T18:10:00.000Z",
    toolchain: {
      freshClamImageDigest: `sha256:${"a".repeat(64)}`,
      sigtoolVersion: "ClamAV 1.4.5",
    },
  };
  const snapshotId = upstreamClamAvSnapshotId(identity);
  const directory = path.join(root, snapshotId);
  await mkdir(directory);
  await Promise.all(
    files.map((file) => writeFile(path.join(directory, file.name), file.bytes)),
  );
  const manifestPath = path.join(directory, "snapshot.json");
  await writeFile(manifestPath, JSON.stringify({ ...identity, snapshotId }));
  return {
    adapter(
      runner,
      expectedSnapshotId = snapshotId,
      clock = { now: () => now },
    ) {
      return new ClamAvScannerAdapter({
        clock,
        databaseDirectory: directory,
        executable: "clamscan",
        expectedFreshClamImageDigest: `sha256:${"a".repeat(64)}`,
        expectedProfile: CLAMAV_UPSTREAM_SNAPSHOT_PROFILE,
        expectedSnapshotId,
        manifestPath,
        runner,
      });
    },
    directory,
    manifestPath,
    snapshotId,
  };
}

function verifiedRunner(
  scan: ProcessResult,
  clamscanVersion = processResult(0, "ClamAV 1.4.5/27100/date\n"),
): SequencedRunner {
  return new SequencedRunner([
    processResult(0, "ClamAV 1.4.5\n"),
    processResult(0, sigtoolInfo(101)),
    processResult(0, sigtoolInfo(102)),
    processResult(0, sigtoolInfo(103)),
    clamscanVersion,
    scan,
  ]);
}

function sigtoolInfo(databaseVersion: number): string {
  return [
    "Build time: 2026-07-26T18:00:00.000Z",
    `Version: ${databaseVersion}`,
    "Verification OK.",
    "",
  ].join("\n");
}

function staged(directory: string) {
  return {
    byteLength: 1,
    bytes: new Uint8Array([1]),
    inputPath: path.join(directory, "source"),
    sha256: "0".repeat(64),
  };
}

function processResult(exitCode: number, stdout: string): ProcessResult {
  return { exitCode, signal: null, stderr: "", stdout, timedOut: false };
}

class SequencedRunner implements ProcessRunnerPort {
  readonly calls: { args: readonly string[]; executable: string }[] = [];

  constructor(private readonly results: readonly ProcessResult[]) {}

  async run(
    executable: string,
    args: readonly string[],
  ): Promise<ProcessResult> {
    this.calls.push({ args, executable });
    const result = this.results[this.calls.length - 1];
    if (result === undefined) {
      throw new Error("unexpected process call");
    }
    return result;
  }
}
