import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunnerPort } from "../ports.js";
import { ClamAvScannerAdapter } from "./clamav.js";
import {
  CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
  PinnedP256SnapshotSignatureVerifier,
} from "./clamav-signature.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ClamAvScannerAdapter", () => {
  it("accepts the pinned runtime version without a database suffix", async () => {
    const fixture = await snapshotFixture();
    const adapter = fixture.adapter(
      new SequencedRunner([
        processResult(0, "ClamAV 1.4.5\n"),
        processResult(0, ""),
      ]),
    );
    const snapshot = await adapter.currentSnapshot();

    await expect(
      adapter.scan(staged(fixture.directory), snapshot!),
    ).resolves.toEqual({ clean: true });
  });

  it("verifies the signed immutable database before scanning", async () => {
    const fixture = await snapshotFixture();
    const runner = new SequencedRunner([
      processResult(0, "ClamAV 1.4.5/27100/Tue Jul 21 00:00:00 2026\n"),
      processResult(0, ""),
    ]);
    const adapter = fixture.adapter(runner);
    const snapshot = await adapter.currentSnapshot();

    expect(snapshot).toMatchObject({
      signatureVersion: "daily-27100",
      verified: true,
    });
    await expect(
      adapter.scan(staged(fixture.directory), snapshot!),
    ).resolves.toEqual({ clean: true });
    expect(runner.calls[1]?.args).toEqual(
      expect.arrayContaining(["--no-summary", "--infected", "--"]),
    );
  });

  it("maps the documented infected exit status without exposing output", async () => {
    const fixture = await snapshotFixture();
    const adapter = fixture.adapter(
      new SequencedRunner([
        processResult(0, "ClamAV 1.4.5/27100/date\n"),
        processResult(1, "/work/source: signature FOUND\n"),
      ]),
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

  it("rejects database files outside the signed manifest", async () => {
    const fixture = await snapshotFixture();
    await writeFile(path.join(fixture.directory, "untrusted.ndb"), "extra");

    await expect(
      fixture.adapter(new SequencedRunner([])).currentSnapshot(),
    ).resolves.toBeNull();
  });

  it("rejects noncanonical Base64 and an unknown manifest key", async () => {
    const fixture = await snapshotFixture();
    const signature = await import("node:fs/promises").then(({ readFile }) =>
      readFile(fixture.signaturePath, "ascii"),
    );
    await writeFile(fixture.signaturePath, `${signature}\n`);
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
      JSON.stringify({ ...manifest, kid: "unknown-key" }),
    );
    await expect(
      second.adapter(new SequencedRunner([])).currentSnapshot(),
    ).resolves.toBeNull();
  });

  it("rejects a scanner whose runtime version is not exactly pinned", async () => {
    const fixture = await snapshotFixture();
    const adapter = fixture.adapter(
      new SequencedRunner([processResult(0, "ClamAV 1.4.6/27100/date\n")]),
    );
    const snapshot = await adapter.currentSnapshot();
    await expect(
      adapter.scan(staged(fixture.directory), snapshot!),
    ).rejects.toMatchObject({ code: "infrastructure_unavailable" });
  });
});

async function snapshotFixture(): Promise<{
  adapter(runner: ProcessRunnerPort): ClamAvScannerAdapter;
  directory: string;
  manifestPath: string;
  signaturePath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "reflo-clamav-"));
  scratch.push(directory);
  const database = Buffer.from("signed-clamav-fixture", "utf8");
  await writeFile(path.join(directory, "daily.cvd"), database);
  const manifestPath = path.join(directory, "snapshot.json");
  const signaturePath = path.join(directory, "snapshot.sig");
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyDer = keys.publicKey.export({ type: "spki", format: "der" });
  const publicKeySpkiSha256 = createHash("sha256")
    .update(publicKeyDer)
    .digest("hex");
  const publicKeyPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const manifest = Buffer.from(
    JSON.stringify({
      clamAvVersion: "1.4.5",
      contractVersion: "snapshot-manifest-v1",
      files: [
        {
          byteLength: database.byteLength,
          name: "daily.cvd",
          sha256: createHash("sha256").update(database).digest("hex"),
        },
      ],
      kid: "fixture-p256-v1",
      publishedAt: "2026-07-21T00:00:00.000Z",
      publicKeySpkiSha256,
      signatureProfile: CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
      snapshotId: "daily-27100",
    }),
    "utf8",
  );
  await writeFile(manifestPath, manifest);
  await writeFile(
    signaturePath,
    sign("sha256", manifest, {
      dsaEncoding: "der",
      key: keys.privateKey,
    }).toString("base64"),
  );
  return {
    adapter(runner) {
      return new ClamAvScannerAdapter({
        databaseDirectory: directory,
        executable: "clamscan",
        expectedSignatureProfile: CLAMAV_SNAPSHOT_SIGNATURE_PROFILE,
        manifestPath,
        runner,
        signaturePath,
        signatureVerifier: new PinnedP256SnapshotSignatureVerifier([
          {
            kid: "fixture-p256-v1",
            spkiPem: publicKeyPem,
            spkiSha256: publicKeySpkiSha256,
          },
        ]),
      });
    },
    directory,
    manifestPath,
    signaturePath,
  };
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
