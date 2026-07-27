import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Deployment } from "@reflo/config";
import {
  PostgresAnalyticDbPool,
  PostgresContentRepository,
  PostgresDemoUploadRepository,
  PostgresIngestionOperationStore,
} from "@reflo/db";
import { LocalSmokeObjectStore, artifactObjectKey } from "@reflo/dev-smoke";
import {
  CLAMAV_UPSTREAM_SNAPSHOT_PROFILE,
  ClamAvScannerAdapter,
  IngestionSupervisor,
  NodeEphemeralWorkspace,
  NodeProcessRunner,
  NormalizedOutputFileReader,
  ObjectArtifactPublisher,
  PodmanDocumentWorker,
  type ProcessRunnerPort,
  QuarantineStagingAdapter,
  validateNormalizedDocument,
} from "@reflo/ingestion";
import { createModelRouter } from "@reflo/model-router";
import { createLiteLlmDevAdapters } from "@reflo/model-router/litellm";
import { createDemoTraceRuntime } from "@reflo/observability";
import { DevelopmentPgVectorStore, RetrievalService } from "@reflo/retrieval";

import {
  APPROVED_AGENTS_COURSE_SOURCE,
  ApprovedDemoUploadService,
  type DemoUploadProcessingWork,
} from "./demo-upload.js";
import { DemoUploadProcessingService } from "./demo-upload-processing.js";

const CONNECTED_MODE = "staff-only-demo-v1";
const CONNECTED_BOUNDARY_PROFILE = "staff-controlled-rights-cleared-v1";
const LOCAL_PROCESSOR_MODE = "local-isolated-v1";
const CLAMAV_SCANNER_MEMORY_BYTES = 1_024 * 1_024 * 1_024;

export interface DemoUploadRuntime {
  readonly demoUploads?: ApprovedDemoUploadService;
  close(): Promise<void>;
}

export async function createDemoUploadRuntime(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
): Promise<DemoUploadRuntime> {
  const mode = input.REFLO_CONNECTED_DEMO_MODE;
  if (mode === undefined || mode === "disabled") {
    return { close: async () => undefined };
  }
  if (
    mode !== CONNECTED_MODE ||
    input.REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE !== CONNECTED_BOUNDARY_PROFILE
  ) {
    throw new Error("demo upload requires the connected demo boundary");
  }
  if (deployment !== "dev" || input.REFLO_ENV !== "dev") {
    throw new Error("local demo upload composition is development-only");
  }
  const processorMode =
    input.REFLO_DEMO_UPLOAD_PROCESSOR_MODE?.trim() ?? "disabled";
  if (processorMode === "disabled") {
    return { close: async () => undefined };
  }
  if (processorMode !== LOCAL_PROCESSOR_MODE) {
    throw new Error("demo upload processor mode is not allowlisted");
  }
  const databaseUrl = required(input, "DATABASE_URL");
  const artifactRoot = requiredAbsolute(
    input,
    "REFLO_CONNECTED_DEMO_ARTIFACT_ROOT",
  );
  const vectorDatabaseUrl = required(input, "REFLO_VECTOR_DATABASE_URL");
  const operatorUserId = requiredUuid(input, "REFLO_DEMO_OPERATOR_USER_ID");
  const operatorOwnerScopeId = requiredUuid(
    input,
    "REFLO_DEMO_OPERATOR_OWNER_SCOPE_ID",
  );
  if (
    required(input, "REFLO_DEMO_UPLOAD_MALWARE_SCANNER_MODE") !==
    CLAMAV_UPSTREAM_SNAPSHOT_PROFILE
  ) {
    throw new Error("demo upload requires a verified malware scanner");
  }
  const clamDatabaseDirectory = requiredAbsolute(
    input,
    "REFLO_LOCAL_CLAMAV_DATABASE_DIR",
  );
  const admissionDatabaseDirectory = requiredAbsolute(
    input,
    "REFLO_LOCAL_CLAMAV_ADMISSION_DATABASE_DIR",
  );
  const scannerImage = requiredMatching(
    input,
    "REFLO_LOCAL_CLAMAV_SCANNER_IMAGE",
    /^.+@sha256:[a-f0-9]{64}$/,
  );
  const scannerRunner = new PodmanClamAvProcessRunner(
    {
      databaseDirectory: admissionDatabaseDirectory,
      imageReference: scannerImage,
    },
    new NodeProcessRunner(),
  );
  const malwareScanner = new ClamAvScannerAdapter({
    databaseDirectory: admissionDatabaseDirectory,
    executable: "clamscan",
    expectedFreshClamImageDigest: scannerImage.slice(
      scannerImage.lastIndexOf("@") + 1,
    ),
    expectedProfile: CLAMAV_UPSTREAM_SNAPSHOT_PROFILE,
    expectedSnapshotId: requiredMatching(
      input,
      "REFLO_LOCAL_CLAMAV_SNAPSHOT_ID",
      /^cvd-[a-f0-9]{32}$/,
    ),
    manifestPath: requiredAbsolute(input, "REFLO_LOCAL_CLAMAV_MANIFEST_PATH"),
    runner: scannerRunner,
  });
  const scratchRoot = path.join(artifactRoot, ".ingestion-work");
  mkdirSync(scratchRoot, { mode: 0o700, recursive: true });
  const scratchStat = lstatSync(scratchRoot);
  if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) {
    throw new Error("demo upload scratch root is unsafe");
  }
  const repository = new PostgresDemoUploadRepository(databaseUrl, {
    environment: deployment,
  });
  const operations = new PostgresIngestionOperationStore({
    connectionString: databaseUrl,
    environment: deployment,
    leaseDurationMs: 60_000,
    leaseOwner: "api_demo_upload_v1",
  });
  const content = new PostgresContentRepository(databaseUrl, {
    environment: deployment,
  });
  const vectorPool = new PostgresAnalyticDbPool(vectorDatabaseUrl);
  const objects = new LocalSmokeObjectStore(artifactRoot);
  const liteLlm = createLiteLlmDevAdapters(input);
  const tracing = createDemoTraceRuntime(input, {
    component: "api-demo-upload",
    deployment,
  });
  const router = createModelRouter({
    adapters: liteLlm.adapters,
    deployment,
    traceSink: tracing.modelTraces,
  });
  const curriculum = new RetrievalService({
    models: router,
    observeCurriculum: async (metrics) => {
      const finishedAt = new Date().toISOString();
      const latency = distribution(metrics.segmentLatenciesMs);
      const queue = distribution(metrics.segmentQueueTimesMs);
      await tracing.recordOperational({
        attemptCount: Math.min(10, metrics.retryCount + 1),
        chapterCount: metrics.chapterCount,
        compositionFinalizationMs: metrics.compositionFinalizationMs,
        conceptCount: metrics.conceptCount,
        deadlineBudgetMs: metrics.parentDeadlineMs,
        durationMs: metrics.totalLatencyMs,
        finalizationReserveMs: metrics.finalizationReserveMs,
        finishedAt,
        operation: "curriculum_generation",
        outcome: "success",
        retryCount: metrics.retryCount,
        segmentCount: metrics.segmentCount,
        segmentLatencyMaxMs: latency.max,
        segmentLatencyMinMs: latency.min,
        segmentLatencyP50Ms: latency.p50,
        segmentLatencyP95Ms: latency.p95,
        segmentQueueMaxMs: queue.max,
        segmentQueueMinMs: queue.min,
        segmentQueueP50Ms: queue.p50,
        segmentQueueP95Ms: queue.p95,
        stage: "ingestion",
        startedAt: new Date(
          Date.parse(finishedAt) - metrics.totalLatencyMs,
        ).toISOString(),
      });
    },
    repository: content,
    vectors: new DevelopmentPgVectorStore(
      vectorPool,
      liteLlm.embeddingProfileVersion,
    ),
  });
  const publisher = new ObjectArtifactPublisher(objects);
  const workspaces = new NodeEphemeralWorkspace(scratchRoot);
  const worker = new PodmanDocumentWorker(
    {
      clamDatabaseDirectory,
      environment: deployment,
      executable: "podman",
      imageReference: required(input, "REFLO_LOCAL_INGESTION_IMAGE"),
      resolvedImageDigest: requiredMatching(
        input,
        "REFLO_LOCAL_INGESTION_IMAGE_DIGEST",
        /^sha256:[a-f0-9]{64}$/,
      ),
      tessdataDirectory: requiredAbsolute(input, "REFLO_LOCAL_TESSDATA_DIR"),
    },
    new NodeProcessRunner(),
    new NormalizedOutputFileReader(),
  );
  const processing = new DemoUploadProcessingService({
    artifacts: {
      async readNormalizedDocument(artifact) {
        const bytes = await objects.read(
          artifactObjectKey(artifact.ownerScopeId, artifact.artifactId),
        );
        return validateNormalizedDocument(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
          {
            documentKind: artifact.documentKind,
            inputSha256: artifact.inputSha256,
          },
        );
      },
    },
    curriculum,
    ingestion: {
      execute(work: DemoUploadProcessingWork) {
        return new IngestionSupervisor({
          clock: { now: () => new Date() },
          malwareScanner,
          operations,
          publisher,
          quarantine: new QuarantineStagingAdapter(objects),
          worker,
          workspaces,
        }).execute({
          expectedInputSha256: work.expectedInputSha256,
          operationId: work.operationId,
          ownerScopeId: work.authorization.ownerScopeId,
          sourceDocumentId: work.sourceDocumentId,
        });
      },
    },
    repository,
  });
  const runtime = {
    demoUploads: new ApprovedDemoUploadService({
      approvals: [APPROVED_AGENTS_COURSE_SOURCE],
      objects,
      operatorUserIds: [operatorUserId],
      processing,
      repository,
    }),
    close: async () => {
      await processing.close();
      const results = await Promise.allSettled([
        repository.close(),
        operations.close(),
        content.close(),
        vectorPool.close(),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("demo upload runtime cleanup failed");
      }
    },
  } satisfies DemoUploadRuntime;
  try {
    const recoverable = await repository.listRecoverable({
      actorId: operatorUserId,
      authorizationId: "demo-upload-startup-recovery-v1",
      ownerScopeId: operatorOwnerScopeId,
    });
    for (const work of recoverable) {
      processing.schedule(work);
    }
    return runtime;
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

function distribution(values: readonly number[]): {
  readonly max: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (quantile: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
  return {
    max: sorted.at(-1) ?? 0,
    min: sorted[0] ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function required(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredUuid(input: NodeJS.ProcessEnv, name: string): string {
  const value = required(input, name);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requiredAbsolute(input: NodeJS.ProcessEnv, name: string): string {
  const value = required(input, name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be absolute`);
  }
  return value;
}

function requiredMatching(
  input: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string {
  const value = required(input, name);
  if (!pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export class PodmanClamAvProcessRunner implements ProcessRunnerPort {
  constructor(
    private readonly configuration: {
      readonly databaseDirectory: string;
      readonly imageReference: string;
    },
    private readonly runner: ProcessRunnerPort,
  ) {}

  run(
    executable: string,
    args: readonly string[],
    options: { readonly maxOutputBytes: number; readonly timeoutMs: number },
  ) {
    if (executable !== "clamscan" && executable !== "sigtool") {
      return Promise.resolve(failedProcess());
    }
    if (executable === "sigtool") {
      if (args.length === 1 && args[0] === "--version") {
        return this.runner.run(
          "podman",
          [
            ...this.#baseArguments(),
            "--entrypoint=/usr/bin/sigtool",
            this.configuration.imageReference,
            "--version",
          ],
          options,
        );
      }
      const databasePath = args[1];
      if (
        args.length !== 2 ||
        args[0] !== "--info" ||
        databasePath === undefined ||
        path.dirname(databasePath) !== this.configuration.databaseDirectory ||
        !/^(?:bytecode|daily|main)\.(?:cld|cvd)$/.test(
          path.basename(databasePath),
        )
      ) {
        return Promise.resolve(failedProcess());
      }
      return this.runner.run(
        "podman",
        [
          ...this.#baseArguments(),
          `--mount=type=bind,src=${this.configuration.databaseDirectory},dst=/database,ro=true,relabel=private`,
          "--entrypoint=/usr/bin/sigtool",
          this.configuration.imageReference,
          "--info",
          `/database/${path.basename(databasePath)}`,
        ],
        options,
      );
    }
    if (args.length === 1 && args[0] === "--version") {
      return this.runner.run(
        "podman",
        [
          ...this.#baseArguments(),
          "--entrypoint=/usr/bin/clamscan",
          this.configuration.imageReference,
          "--version",
        ],
        options,
      );
    }
    const inputPath = args.at(-1);
    const separatorIndex = args.lastIndexOf("--");
    if (
      inputPath === undefined ||
      !path.isAbsolute(inputPath) ||
      separatorIndex !== args.length - 2 ||
      args[0] !== `--database=${this.configuration.databaseDirectory}` ||
      args[1] !== "--no-summary" ||
      args[2] !== "--stdout" ||
      args[3] !== "--infected"
    ) {
      return Promise.resolve(failedProcess());
    }
    return this.runner.run(
      "podman",
      [
        ...this.#baseArguments(),
        `--mount=type=bind,src=${this.configuration.databaseDirectory},dst=/database,ro=true,relabel=private`,
        `--mount=type=bind,src=${path.dirname(inputPath)},dst=/input,ro=true,relabel=private`,
        "--entrypoint=/usr/bin/clamscan",
        this.configuration.imageReference,
        "--database=/database",
        "--no-summary",
        "--stdout",
        "--infected",
        "--",
        `/input/${path.basename(inputPath)}`,
      ],
      options,
    );
  }

  #baseArguments(): readonly string[] {
    return [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--user=100:101",
      "--userns=keep-id:uid=100,gid=101",
      "--pids-limit=64",
      `--memory=${CLAMAV_SCANNER_MEMORY_BYTES}`,
      "--cpus=1",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864",
    ];
  }
}

function failedProcess() {
  return {
    exitCode: 127,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}
