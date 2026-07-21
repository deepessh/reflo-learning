import { describe, expect, it } from "vitest";

import { IngestionError } from "../errors.js";
import type {
  ProcessResult,
  ProcessRunnerPort,
  WorkerOutputReaderPort,
} from "../ports.js";
import { PodmanDocumentWorker } from "./podman.js";

const CONFIGURATION = {
  clamDatabaseDirectory: "/var/lib/reflo/clamav/snapshot",
  environment: "pilot" as const,
  executable: "podman",
  imageReference: `registry.example/reflo/ingestion@sha256:${"b".repeat(64)}`,
  resolvedImageDigest: `sha256:${"b".repeat(64)}`,
  tessdataDirectory: "/var/lib/reflo/tessdata/eng",
};
const REQUEST = {
  documentKind: "pdf" as const,
  inputPath: "/var/lib/reflo/jobs/operation-0001-attempt/source",
  inputSha256: "a".repeat(64),
  operationId: "operation-0001",
  outputDirectory: "/var/lib/reflo/jobs/operation-0001-attempt/output",
  processingLane: "standard" as const,
};

describe("PodmanDocumentWorker", () => {
  it("returns only the bounded normalized output file on success", async () => {
    const output = { contractVersion: "normalized-document-v1" };
    const reader = new FixedReader(output);
    const runner = new FixedRunner(success());
    const worker = new PodmanDocumentWorker(CONFIGURATION, runner, reader);
    await expect(worker.execute(REQUEST)).resolves.toBe(output);
    expect(runner.args).toContain("--network=none");
    expect(reader.directories).toEqual([REQUEST.outputDirectory]);
  });

  it.each([
    [{ ...success(), timedOut: true }, "parse_timeout"],
    [{ ...success(), exitCode: null, signal: "SIGKILL" }, "parse_oom"],
    [{ ...success(), exitCode: 125 }, "infrastructure_unavailable"],
    [
      {
        ...success(),
        exitCode: 42,
        stderr: "REFLO_FAILURE:encrypted\nraw input name must not escape",
      },
      "encrypted",
    ],
    [{ ...success(), exitCode: 42, stderr: "arbitrary crash" }, "parser_crash"],
  ] as const)("normalizes worker failure to %s", async (result, code) => {
    const worker = new PodmanDocumentWorker(
      CONFIGURATION,
      new FixedRunner(result),
      new FixedReader({}),
    );
    try {
      await worker.execute(REQUEST);
      throw new Error("expected worker failure");
    } catch (error) {
      expect(error).toBeInstanceOf(IngestionError);
      expect((error as IngestionError).code).toBe(code);
      expect((error as IngestionError).sanitizedDetail).toBeUndefined();
    }
  });
});

class FixedRunner implements ProcessRunnerPort {
  args: readonly string[] = [];

  constructor(private readonly result: ProcessResult) {}

  async run(
    _executable: string,
    args: readonly string[],
    _options: { readonly maxOutputBytes: number; readonly timeoutMs: number },
  ): Promise<ProcessResult> {
    this.args = args;
    return this.result;
  }
}

class FixedReader implements WorkerOutputReaderPort {
  readonly directories: string[] = [];

  constructor(private readonly output: unknown) {}

  async readNormalizedDocument(outputDirectory: string): Promise<unknown> {
    this.directories.push(outputDirectory);
    return this.output;
  }
}

function success(): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}
