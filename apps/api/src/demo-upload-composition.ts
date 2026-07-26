import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Deployment } from "@reflo/config";
import {
  PostgresAnalyticDbPool,
  PostgresContentRepository,
  PostgresDemoUploadRepository,
  PostgresIngestionOperationStore,
} from "@reflo/db";
import {
  LocalSmokeObjectStore,
  TrustedFixtureAdmissionScanner,
  artifactObjectKey,
} from "@reflo/dev-smoke";
import {
  IngestionSupervisor,
  NodeEphemeralWorkspace,
  NodeProcessRunner,
  NormalizedOutputFileReader,
  ObjectArtifactPublisher,
  PodmanDocumentWorker,
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

export interface DemoUploadRuntime {
  readonly demoUploads?: ApprovedDemoUploadService;
  close(): Promise<void>;
}

export function createDemoUploadRuntime(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
): DemoUploadRuntime {
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
  const content = new PostgresContentRepository(databaseUrl);
  const vectorPool = new PostgresAnalyticDbPool(vectorDatabaseUrl);
  const objects = new LocalSmokeObjectStore(artifactRoot);
  const liteLlm = createLiteLlmDevAdapters(input);
  const router = createModelRouter({
    adapters: liteLlm.adapters,
    deployment,
    traceSink: createDemoTraceRuntime(input, {
      component: "api-demo-upload",
      deployment,
    }).modelTraces,
  });
  const curriculum = new RetrievalService({
    models: router,
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
      clamDatabaseDirectory: requiredAbsolute(
        input,
        "REFLO_LOCAL_CLAMAV_DATABASE_DIR",
      ),
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
          malwareScanner: new TrustedFixtureAdmissionScanner(
            work.expectedInputSha256,
          ),
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
  return {
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
