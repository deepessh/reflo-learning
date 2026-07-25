import { createAudioQueueHandler } from "./audio-worker.js";
import {
  HandlerDeadlineError,
  executeBoundedHandler,
} from "./bounded-handler.js";

export interface DevelopmentJobExecution {
  readonly kind: "completed" | "idle";
  readonly result?: unknown;
}

export interface DevelopmentJobDependencies {
  readonly handler?: (
    envelope: unknown,
    deliveryNumber: number,
  ) => Promise<unknown>;
}

export async function runDevelopmentJob(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DevelopmentJobDependencies = {},
): Promise<DevelopmentJobExecution> {
  const input = environment.REFLO_JOBS_DEV_AUDIO_ENVELOPE;
  if (input === undefined || input === "") {
    return { kind: "idle" };
  }
  const deliveryNumber = positiveInteger(
    environment.REFLO_JOBS_DEV_DELIVERY_NUMBER ?? "1",
    "REFLO_JOBS_DEV_DELIVERY_NUMBER",
  );
  const timeoutMs = positiveInteger(
    environment.REFLO_JOBS_HANDLER_TIMEOUT_MS ?? "30000",
    "REFLO_JOBS_HANDLER_TIMEOUT_MS",
  );
  const handler = dependencies.handler ?? unavailableAudioHandler();
  const result = await executeBoundedHandler(
    () => handler(parseEnvelope(input), deliveryNumber),
    timeoutMs,
  );
  return { kind: "completed", result };
}

export function developmentJobFailureMessage(error: unknown): string {
  return error instanceof HandlerDeadlineError
    ? "Reflo jobs development handler exceeded its deadline"
    : "Reflo jobs development handler failed";
}

function unavailableAudioHandler() {
  return createAudioQueueHandler({
    authorization: {
      // This development contract path never fabricates runtime authority.
      // A deployable broker adapter must inject its current authorization resolver.
      resolve: async () => null,
    },
    consumer: {
      consume: async () => {
        throw new Error("development audio consumer is unavailable");
      },
    },
  });
}

function parseEnvelope(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > 16_384) {
    throw new Error("REFLO_JOBS_DEV_AUDIO_ENVELOPE is too large");
  }
  return JSON.parse(raw) as unknown;
}

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
