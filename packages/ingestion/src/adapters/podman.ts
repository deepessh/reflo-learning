import { INGESTION_LIMITS, type WorkerExecutionRequest } from "../contracts.js";
import { IngestionError } from "../errors.js";
import type {
  IsolatedDocumentWorkerPort,
  ProcessRunnerPort,
  WorkerOutputReaderPort,
} from "../ports.js";
import {
  createPodmanWorkerLaunch,
  type PodmanWorkerConfiguration,
} from "../worker-profile.js";

const DIAGNOSTIC_LIMIT = 2_048;

export class PodmanDocumentWorker implements IsolatedDocumentWorkerPort {
  constructor(
    private readonly configuration: PodmanWorkerConfiguration,
    private readonly processRunner: ProcessRunnerPort,
    private readonly outputReader: WorkerOutputReaderPort,
  ) {}

  async execute(request: WorkerExecutionRequest): Promise<unknown> {
    const launch = createPodmanWorkerLaunch(this.configuration, request);
    const result = await this.processRunner.run(
      launch.executable,
      launch.args,
      {
        maxOutputBytes: DIAGNOSTIC_LIMIT,
        timeoutMs: launch.timeoutMs,
      },
    );
    if (result.timedOut) {
      throw new IngestionError("parse_timeout");
    }
    if (result.signal === "SIGKILL" && result.exitCode === null) {
      throw new IngestionError("parse_oom");
    }
    if (result.exitCode === null) {
      throw new IngestionError("parser_crash");
    }
    if (result.exitCode !== 0) {
      throw mapWorkerFailure(result.exitCode, result.stderr);
    }
    return this.outputReader.readNormalizedDocument(request.outputDirectory);
  }
}

function mapWorkerFailure(exitCode: number, stderr: string): IngestionError {
  const diagnostic = stderr.slice(0, DIAGNOSTIC_LIMIT).trim();
  const code = diagnostic.match(/^REFLO_FAILURE:([a-z_]+)$/m)?.[1];
  switch (code) {
    case "encrypted":
    case "archive_limit":
    case "page_limit":
    case "malformed_document":
    case "active_content":
      return new IngestionError(code);
    case "parse_oom":
      return new IngestionError("parse_oom");
    case "parse_timeout":
      return new IngestionError("parse_timeout");
    default:
      return new IngestionError(
        exitCode === 125 || exitCode === 126 || exitCode === 127
          ? "infrastructure_unavailable"
          : "parser_crash",
      );
  }
}

export const PODMAN_DIAGNOSTIC_OUTPUT_LIMIT = DIAGNOSTIC_LIMIT;
export const PODMAN_NORMALIZED_OUTPUT_LIMIT =
  INGESTION_LIMITS.normalizedOutputBytes;
