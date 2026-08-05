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
  AliFunctionComputeSessionClient,
  FunctionComputeSessionDocumentWorker,
  IngestionSupervisor,
  LOCAL_INGESTION_BRIDGE_PROFILE,
  NodeEphemeralWorkspace,
  ObjectArtifactPublisher,
  type IsolatedDocumentWorkerPort,
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
import type { ActivationPackageScheduler } from "./activation-package-processing.js";
import { DemoUploadProcessingService } from "./demo-upload-processing.js";
import {
  LocalIngestionBridgeBroker,
  type LocalIngestionBridge,
} from "./local-ingestion-bridge.js";
import {
  createAliOssConnectedObjectStore,
  type ConnectedObjectStore,
} from "./ali-oss-object-store.js";

const CONNECTED_MODE = "staff-only-demo-v1";
const CONNECTED_BOUNDARY_PROFILE = "staff-controlled-rights-cleared-v1";
const LOCAL_PROCESSOR_MODE = "local-isolated-ingestion-bridge-v1";
const SERVERLESS_PROCESSOR_MODE = "serverless-isolated-ingestion-v1";
const LOCAL_OPERATION_LEASE_MS = 3 * 60_000;
const SERVERLESS_OPERATION_LEASE_MS = 30 * 60_000;

export interface DemoUploadRuntime {
  readonly demoUploads?: ApprovedDemoUploadService;
  readonly localIngestionBridge?: LocalIngestionBridge;
  close(): Promise<void>;
}

export async function createDemoUploadRuntime(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
  activation?: ActivationPackageScheduler,
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
  if (
    processorMode !== LOCAL_PROCESSOR_MODE &&
    processorMode !== SERVERLESS_PROCESSOR_MODE
  ) {
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
  let worker: IsolatedDocumentWorkerPort;
  let localIngestionBridge: LocalIngestionBridge | undefined;
  if (processorMode === LOCAL_PROCESSOR_MODE) {
    localIngestionBridge = new LocalIngestionBridgeBroker({
      bearerToken: required(input, "REFLO_LOCAL_INGESTION_BRIDGE_TOKEN"),
      expectedProfile: LOCAL_INGESTION_BRIDGE_PROFILE,
      expectedScannerSnapshotId: requiredMatching(
        input,
        "REFLO_LOCAL_CLAMAV_SNAPSHOT_ID",
        /^cvd-[a-f0-9]{32}$/,
      ),
      expectedWorkerImageDigest: requiredMatching(
        input,
        "REFLO_LOCAL_INGESTION_IMAGE_DIGEST",
        /^sha256:[a-f0-9]{64}$/,
      ),
    });
    worker = localIngestionBridge;
  } else {
    const region = required(input, "REFLO_ALIBABA_REGION");
    if (region !== "ap-southeast-1") {
      throw new Error("serverless parser is approved only in Singapore");
    }
    worker = new FunctionComputeSessionDocumentWorker(
      {
        workerArtifactDigest: requiredMatching(
          input,
          "REFLO_ALIBABA_FC_PARSER_ARTIFACT_DIGEST",
          /^sha256:[a-f0-9]{64}$/,
        ),
      },
      new AliFunctionComputeSessionClient({
        accountId: requiredMatching(
          input,
          "REFLO_ALIBABA_FC_ACCOUNT_ID",
          /^[0-9]{6,32}$/,
        ),
        affinityHeaderName: required(
          input,
          "REFLO_ALIBABA_FC_PARSER_AFFINITY_HEADER",
        ),
        functionName: required(input, "REFLO_ALIBABA_FC_PARSER_FUNCTION_NAME"),
        qualifier: required(
          input,
          "REFLO_ALIBABA_FC_PARSER_FUNCTION_QUALIFIER",
        ),
        region,
        roleName: required(input, "REFLO_ALIBABA_FC_API_ROLE_NAME"),
        sessionIdleTimeoutSeconds: requiredInteger(
          input,
          "REFLO_ALIBABA_FC_PARSER_SESSION_IDLE_SECONDS",
        ),
        sessionTtlSeconds: requiredInteger(
          input,
          "REFLO_ALIBABA_FC_PARSER_SESSION_TTL_SECONDS",
        ),
      }),
    );
  }
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
    leaseDurationMs: demoUploadOperationLeaseMs(processorMode),
    leaseOwner: "api_demo_upload_v1",
  });
  const content = new PostgresContentRepository(databaseUrl, {
    environment: deployment,
  });
  const vectorPool = new PostgresAnalyticDbPool(vectorDatabaseUrl);
  const storageMode =
    input.REFLO_CONNECTED_DEMO_OBJECT_STORE?.trim() ?? "local-filesystem-v1";
  const objects: ConnectedObjectStore =
    storageMode === "local-filesystem-v1"
      ? new LocalSmokeObjectStore(artifactRoot)
      : storageMode === "alibaba-private-oss-v1"
        ? await createAliOssConnectedObjectStore({
            artifactBucket: required(input, "REFLO_OSS_ARTIFACT_BUCKET"),
            deliveryBucket: required(input, "REFLO_OSS_DELIVERY_BUCKET"),
            quarantineBucket: required(input, "REFLO_OSS_QUARANTINE_BUCKET"),
            region: required(input, "REFLO_ALIBABA_REGION"),
            roleName: required(input, "REFLO_OSS_RUNTIME_ROLE_NAME"),
          })
        : failObjectStoreMode();
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
  const processing = new DemoUploadProcessingService({
    activation,
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
          malwareScanPlacement: "isolated-worker",
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
    localIngestionBridge,
    close: async () => {
      await localIngestionBridge?.close();
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

export function demoUploadOperationLeaseMs(processorMode: string): number {
  switch (processorMode) {
    case LOCAL_PROCESSOR_MODE:
      // The local broker grants a worker up to two minutes. Keep a bounded
      // finalization reserve so a valid result cannot lose its durable lease.
      return LOCAL_OPERATION_LEASE_MS;
    case SERVERLESS_PROCESSOR_MODE:
      // Function Compute owns a bounded 30-minute invocation/session window.
      // The durable lease must cover that accepted worker boundary so the
      // first terminal result can be committed through ADR 0012.
      return SERVERLESS_OPERATION_LEASE_MS;
    default:
      throw new Error("demo upload processor mode is not allowlisted");
  }
}

function failObjectStoreMode(): never {
  throw new Error("REFLO_CONNECTED_DEMO_OBJECT_STORE is not allowlisted");
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

function requiredInteger(input: NodeJS.ProcessEnv, name: string): number {
  const value = required(input, name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}
