import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { INGESTION_LIMITS } from "../contracts.js";
import { IngestionError } from "../errors.js";
import { NormalizedOutputFileReader } from "./normalized-output-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("NormalizedOutputFileReader", () => {
  it("reads one regular bounded JSON output", async () => {
    const output = await outputDirectory();
    await writeFile(
      path.join(output, "normalized-document.json"),
      JSON.stringify({ contractVersion: "normalized-document-v1" }),
      { flag: "wx", mode: 0o600 },
    );
    await expect(
      new NormalizedOutputFileReader().readNormalizedDocument(output),
    ).resolves.toEqual({ contractVersion: "normalized-document-v1" });
  });

  it("rejects symlink output and oversized sparse files without reading them", async () => {
    const symlinkOutput = await outputDirectory();
    const target = path.join(path.dirname(symlinkOutput), "target.json");
    await writeFile(target, "{}", { flag: "wx", mode: 0o600 });
    await symlink(target, path.join(symlinkOutput, "normalized-document.json"));
    await expectInvalid(
      new NormalizedOutputFileReader().readNormalizedDocument(symlinkOutput),
    );

    const oversizedOutput = await outputDirectory();
    const oversized = path.join(oversizedOutput, "normalized-document.json");
    await writeFile(oversized, "{}", { flag: "wx", mode: 0o600 });
    await truncate(oversized, INGESTION_LIMITS.normalizedOutputBytes + 1);
    await expectInvalid(
      new NormalizedOutputFileReader().readNormalizedDocument(oversizedOutput),
    );
  });
});

async function outputDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reflo-ingestion-output-"));
  temporaryDirectories.push(root);
  const output = path.join(root, "output");
  await mkdir(output, { mode: 0o700 });
  return output;
}

async function expectInvalid(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error("expected output read to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IngestionError);
    expect((error as IngestionError).code).toBe("invalid_output");
  }
}
