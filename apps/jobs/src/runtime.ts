import { createAliOssPrivateClient } from "@reflo/asset-delivery";
import { AudioGenerationService } from "@reflo/audio";
import {
  PostgresAudioAuthorizationResolver,
  PostgresAudioGenerationRepository,
} from "@reflo/db";
import {
  createModelRouter,
  type ModelAdapterRegistry,
} from "@reflo/model-router";
import {
  DashScopeModelStudioTtsClient,
  QWEN_3_TTS_FLASH_MODEL,
  QWEN_3_TTS_FLASH_MODEL_VERSION,
  createQwenTtsAdapter,
} from "@reflo/model-router/tts";
import { createDemoTraceRuntime } from "@reflo/observability";

import { AliOssAudioArtifactWriter } from "./ali-oss-audio-writer.js";
import { createAudioQueueHandler } from "./audio-worker.js";
import {
  createRocketMqFunctionComputeHandler,
  type FunctionComputeContext,
} from "./function-compute.js";

export async function handler(
  event: Buffer | Uint8Array | string,
  context: FunctionComputeContext,
) {
  const environment = process.env;
  return createRocketMqFunctionComputeHandler({
    createHandler: (currentContext) =>
      createProductionAudioHandler(environment, currentContext),
    timeoutMs: positiveInteger(
      environment.REFLO_JOBS_HANDLER_TIMEOUT_MS,
      "REFLO_JOBS_HANDLER_TIMEOUT_MS",
    ),
    topic: required(environment, "REFLO_ROCKETMQ_JOBS_TOPIC"),
  })(event, context);
}

export async function createProductionAudioHandler(
  environment: NodeJS.ProcessEnv,
  context: FunctionComputeContext,
) {
  const databaseUrl = required(environment, "DATABASE_URL");
  const region = required(environment, "REFLO_ALIBABA_REGION");
  if (region !== "ap-southeast-1") {
    throw new Error("jobs region is not approved");
  }
  const credentials = functionComputeCredentials(context);
  const client = await createAliOssPrivateClient({
    bucket: required(environment, "REFLO_OSS_DELIVERY_BUCKET"),
    loadCredentials: async () => credentials,
    region,
  });
  const repository = new PostgresAudioGenerationRepository({
    connectionString: databaseUrl,
    leaseDurationMs: 60_000,
    leaseOwner: leaseOwner(context.requestId),
  });
  const authorization = new PostgresAudioAuthorizationResolver(databaseUrl);
  const traces = createDemoTraceRuntime(environment, {
    component: "jobs",
    deployment: "dev",
  });
  const speech = createQwenTtsAdapter({
    client: new DashScopeModelStudioTtsClient({
      apiKey: required(environment, "REFLO_QWEN_TTS_API_KEY"),
    }),
    driftCanaryPassed:
      required(environment, "REFLO_QWEN_TTS_DRIFT_CANARY_PASSED") === "true",
    effectiveModelVersion: QWEN_3_TTS_FLASH_MODEL_VERSION,
    model: QWEN_3_TTS_FLASH_MODEL,
  });
  const models = createModelRouter({
    adapters: adapterRegistry(speech),
    deployment: "dev",
    traceSink: traces.modelTraces,
  });
  const consumer = new AudioGenerationService({
    artifacts: new AliOssAudioArtifactWriter(client),
    clock: { now: () => new Date() },
    models,
    repository,
  });
  return {
    close: async (): Promise<void> => {
      const results = await Promise.allSettled([
        authorization.close(),
        repository.close(),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("jobs database cleanup failed");
      }
    },
    handler: createAudioQueueHandler({ authorization, consumer }),
  };
}

function adapterRegistry(
  speech: ModelAdapterRegistry["speech"][string],
): ModelAdapterRegistry {
  return {
    dialogue: {},
    embedding: {},
    grading: {},
    groundedGeneration: {},
    speech: { "qwen-tts.primary": speech },
    structured: {},
    video: {},
  };
}

function functionComputeCredentials(context: FunctionComputeContext): {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly stsToken: string;
} {
  const accessKeyId = context.credentials?.accessKeyId;
  const accessKeySecret = context.credentials?.accessKeySecret;
  const stsToken = context.credentials?.securityToken;
  if (
    accessKeyId === undefined ||
    accessKeySecret === undefined ||
    stsToken === undefined ||
    accessKeyId.length < 8 ||
    accessKeySecret.length < 8 ||
    stsToken.length < 8
  ) {
    throw new Error("Function Compute credentials are unavailable");
  }
  return { accessKeyId, accessKeySecret, stsToken };
}

function leaseOwner(requestId: string | undefined): string {
  const normalized = requestId?.replace(/[^a-zA-Z0-9_-]/g, "_") ?? "unknown";
  return `fc_jobs_${normalized}`.slice(0, 128);
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 120_000) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

function required(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "" || value.length > 4_096) {
    throw new Error(`${name} is required`);
  }
  return value;
}
