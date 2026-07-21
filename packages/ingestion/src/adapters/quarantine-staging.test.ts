import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IngestionError } from "../errors.js";
import type { QuarantineDownloadPort } from "../ports.js";
import { sourceFor, validPdf } from "../testing-fixtures.js";
import { QuarantineStagingAdapter } from "./quarantine-staging.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("QuarantineStagingAdapter", () => {
  it("writes exactly one private source file and returns its digest", async () => {
    const directory = await workspace();
    const bytes = validPdf();
    const download = fixedDownload(bytes, "quarantine/pdf");
    const staged = await new QuarantineStagingAdapter(download).stage(
      sourceFor("pdf", bytes),
      { directory, outputDirectory: path.join(directory, "output") },
    );

    expect(staged.inputPath).toBe(path.join(directory, "source"));
    expect(staged.bytes).toEqual(bytes);
    expect(await readFile(staged.inputPath)).toEqual(Buffer.from(bytes));
    expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when the download capability returns another object", async () => {
    const directory = await workspace();
    const bytes = validPdf();
    await expect(
      new QuarantineStagingAdapter(
        fixedDownload(bytes, "quarantine/wrong"),
      ).stage(sourceFor("pdf", bytes), {
        directory,
        outputDirectory: path.join(directory, "output"),
      }),
    ).rejects.toMatchObject<Partial<IngestionError>>({ code: "hash_mismatch" });
  });

  it("refuses to overwrite an existing staged source", async () => {
    const directory = await workspace();
    const bytes = validPdf();
    const adapter = new QuarantineStagingAdapter(
      fixedDownload(bytes, "quarantine/pdf"),
    );
    const source = sourceFor("pdf", bytes);
    const target = {
      directory,
      outputDirectory: path.join(directory, "output"),
    };
    await adapter.stage(source, target);
    await expect(adapter.stage(source, target)).rejects.toMatchObject<
      Partial<IngestionError>
    >({ code: "infrastructure_unavailable" });
  });
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "reflo-quarantine-"));
  scratch.push(directory);
  await mkdir(path.join(directory, "output"));
  return directory;
}

function fixedDownload(
  bytes: Uint8Array,
  objectKey: string,
): QuarantineDownloadPort {
  return {
    async getObject() {
      return { bytes, objectKey };
    },
  };
}
