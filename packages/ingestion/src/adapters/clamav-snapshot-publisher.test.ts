import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessResult, ProcessRunnerPort } from "../ports.js";
import type { SnapshotDigestSignerPort } from "./alibaba-kms.js";
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
  it("verifies upstream CVDs, signs exact manifest bytes, and records provenance", async () => {
    const fixture = await publisherFixture();
    const bundle = await fixture.publisher.createBundle({
      databaseDirectory: fixture.directory,
      publishedAt: new Date("2026-07-21T18:00:00.000Z"),
    });

    expect(bundle.snapshotId).toMatch(/^cvd-[a-f0-9]{32}$/);
    expect(bundle.files).toEqual([
      expect.objectContaining({ name: "daily.cvd" }),
      expect.objectContaining({ name: "main.cvd" }),
    ]);
    expect(bundle.providerSigning).toEqual({
      keyId: "kms-key-12345678",
      keyVersionId: "kms-version-12345678",
      requestId: "kms-request-12345678",
    });
    const manifest = JSON.parse(
      Buffer.from(bundle.manifestBytes).toString("utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      clamAvVersion: "1.4.5",
      contractVersion: "snapshot-manifest-v1",
      kid: "snapshot-key-v1",
      signatureProfile: "clamav-snapshot-signature-v1",
      snapshotId: bundle.snapshotId,
    });
    expect(fixture.runner.calls.map((call) => call.args[0])).toEqual([
      "--version",
      "--verify-cvd",
      "--verify-cvd",
    ]);
    expect(
      fixture.runner.calls
        .slice(1)
        .every((call) => call.args[1]?.includes("reflo-clamav-verify-")),
    ).toBe(true);
  });

  it("publishes the immutable readiness marker only after every bundle object", async () => {
    const fixture = await publisherFixture();
    const bundle = await fixture.publisher.createBundle({
      databaseDirectory: fixture.directory,
      publishedAt: new Date("2026-07-21T18:00:00.000Z"),
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
      `${result.snapshotPrefix}/daily.cvd`,
      `${result.snapshotPrefix}/main.cvd`,
      `${result.snapshotPrefix}/snapshot.json`,
      `${result.snapshotPrefix}/snapshot.sig`,
      `${result.snapshotPrefix}/ready.json`,
    ]);
  });

  it("does not activate a snapshot after a partial OSS failure", async () => {
    const fixture = await publisherFixture();
    const bundle = await fixture.publisher.createBundle({
      databaseDirectory: fixture.directory,
      publishedAt: new Date("2026-07-21T18:00:00.000Z"),
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
});

async function publisherFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reflo-cvd-publish-"));
  scratch.push(directory);
  await writeFile(path.join(directory, "daily.cvd"), "daily database");
  await writeFile(path.join(directory, "main.cvd"), "main database");
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const signer: SnapshotDigestSignerPort = {
    async signDigest(input) {
      expect(input.digest).toEqual(
        createHash("sha256").update(input.payload).digest(),
      );
      return {
        providerKeyId: "kms-key-12345678",
        providerKeyVersionId: "kms-version-12345678",
        providerRequestId: "kms-request-12345678",
        signature: sign("sha256", input.payload, {
          dsaEncoding: "der",
          key: keys.privateKey,
        }),
      };
    },
  };
  const runner = new SuccessRunner();
  return {
    directory,
    publisher: new ClamAvSnapshotMaintenancePublisher(runner, signer, {
      kid: "snapshot-key-v1",
      spkiPem: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      spkiSha256: createHash("sha256").update(spki).digest("hex"),
    }),
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
      stdout: args[0] === "--version" ? "ClamAV 1.4.5\n" : "Verification OK\n",
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
