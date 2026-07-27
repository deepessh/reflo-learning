import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessResult, ProcessRunnerPort } from "../ports.js";
import type { AliOssObjectClient } from "./ali-oss.js";
import {
  AliOssClamAvSnapshotPublisher,
  ClamAvSnapshotMaintenancePublisher,
} from "./clamav-snapshot-publisher.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ClamAV snapshot maintenance publication", () => {
  it("verifies official databases and records immutable upstream identity", async () => {
    const fixture = await publisherFixture();
    const bundle = await fixture.publisher.createBundle({
      databaseDirectory: fixture.directory,
      freshClamImageDigest: `sha256:${"a".repeat(64)}`,
      publishedAt: new Date("2026-07-26T18:10:00.000Z"),
    });

    expect(bundle.snapshotId).toMatch(/^cvd-[a-f0-9]{32}$/);
    expect(bundle.files.map((file) => file.name)).toEqual([
      "bytecode.cvd",
      "daily.cvd",
      "main.cvd",
    ]);
    const manifest = JSON.parse(
      Buffer.from(bundle.manifestBytes).toString("utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      clamAvVersion: "1.4.5",
      contractVersion: "upstream-clamav-snapshot-manifest-v1",
      profile: "upstream-clamav-cloud-demo-v1",
      snapshotId: bundle.snapshotId,
      toolchain: {
        freshClamImageDigest: `sha256:${"a".repeat(64)}`,
        sigtoolVersion: "ClamAV 1.4.5",
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/kms|kid|signatureProfile/i);
    expect(fixture.runner.calls.map((call) => call.args[0])).toEqual([
      "--version",
      "--info",
      "--info",
      "--info",
    ]);
    expect(
      fixture.runner.calls
        .slice(1)
        .every((call) => call.args[1]?.includes("reflo-clamav-verify-")),
    ).toBe(true);
  });

  it("publishes the immutable readiness marker only after every snapshot object", async () => {
    const fixture = await publisherFixture();
    const bundle = await fixture.publisher.createBundle({
      databaseDirectory: fixture.directory,
      freshClamImageDigest: `sha256:${"a".repeat(64)}`,
      publishedAt: new Date("2026-07-26T18:10:00.000Z"),
    });
    const puts: string[] = [];
    const client = objectClient({
      put: vi.fn(async (objectKey) => {
        puts.push(objectKey);
        return { res: { status: 200 } };
      }),
    });
    const result = await new AliOssClamAvSnapshotPublisher(client).publish(
      bundle,
    );

    expect(puts.at(-1)).toBe(result.readyObjectKey);
    expect(puts).toEqual([
      `${result.snapshotPrefix}/bytecode.cvd`,
      `${result.snapshotPrefix}/daily.cvd`,
      `${result.snapshotPrefix}/main.cvd`,
      `${result.snapshotPrefix}/snapshot.json`,
      `${result.snapshotPrefix}/ready.json`,
    ]);
  });

  it("does not activate a snapshot after a partial OSS failure", async () => {
    const fixture = await publisherFixture();
    const bundle = await fixture.publisher.createBundle({
      databaseDirectory: fixture.directory,
      freshClamImageDigest: `sha256:${"a".repeat(64)}`,
      publishedAt: new Date("2026-07-26T18:10:00.000Z"),
    });
    const puts: string[] = [];
    const client = objectClient({
      put: vi.fn(async (objectKey) => {
        puts.push(objectKey);
        if (objectKey.endsWith("main.cvd")) {
          throw new Error("storage unavailable");
        }
        return { res: { status: 200 } };
      }),
    });

    await expect(
      new AliOssClamAvSnapshotPublisher(client).publish(bundle),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
    expect(puts.some((key) => key.endsWith("ready.json"))).toBe(false);
  });

  it("rejects incomplete or stale official database sets", async () => {
    const fixture = await publisherFixture();
    await rm(path.join(fixture.directory, "bytecode.cvd"));
    await expect(
      fixture.publisher.createBundle({
        databaseDirectory: fixture.directory,
        freshClamImageDigest: `sha256:${"a".repeat(64)}`,
        publishedAt: new Date("2026-07-26T18:10:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });

    const second = await publisherFixture();
    await expect(
      second.publisher.createBundle({
        databaseDirectory: second.directory,
        freshClamImageDigest: `sha256:${"a".repeat(64)}`,
        publishedAt: new Date("2026-07-28T18:10:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
  });
});

async function publisherFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reflo-cvd-publish-"));
  scratch.push(directory);
  await Promise.all(
    ["bytecode.cvd", "daily.cvd", "main.cvd"].map((name) =>
      writeFile(path.join(directory, name), `${name} database`),
    ),
  );
  const runner = new SuccessRunner();
  return {
    directory,
    publisher: new ClamAvSnapshotMaintenancePublisher(runner),
    runner,
  };
}

class SuccessRunner implements ProcessRunnerPort {
  readonly calls: { readonly args: readonly string[] }[] = [];

  async run(
    _executable: string,
    args: readonly string[],
  ): Promise<ProcessResult> {
    this.calls.push({ args });
    return {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout:
        args[0] === "--version"
          ? "ClamAV 1.4.5\n"
          : [
              "Build time: 2026-07-26T18:00:00.000Z",
              `Version: ${100 + this.calls.length}`,
              "Verification OK.",
              "",
            ].join("\n"),
      timedOut: false,
    };
  }
}

function objectClient(
  overrides: Partial<AliOssObjectClient>,
): AliOssObjectClient {
  return {
    get: vi.fn().mockRejectedValue(new Error("unexpected get")),
    head: vi.fn().mockRejectedValue(new Error("unexpected head")),
    put: vi.fn().mockRejectedValue(new Error("unexpected put")),
    ...overrides,
  };
}
