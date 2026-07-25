import { createAudioQueueHandler } from "./audio-worker.js";
import {
  HandlerDeadlineError,
  executeBoundedHandler,
} from "./bounded-handler.js";
import { healthcheck } from "./healthcheck.js";

const input = process.env.REFLO_JOBS_DEV_AUDIO_ENVELOPE;
if (input === undefined) {
  console.info("Reflo jobs development handler ready", healthcheck());
} else {
  const deliveryNumber = positiveInteger(
    process.env.REFLO_JOBS_DEV_DELIVERY_NUMBER ?? "1",
    "REFLO_JOBS_DEV_DELIVERY_NUMBER",
  );
  const timeoutMs = positiveInteger(
    process.env.REFLO_JOBS_HANDLER_TIMEOUT_MS ?? "30000",
    "REFLO_JOBS_HANDLER_TIMEOUT_MS",
  );
  const handler = createAudioQueueHandler({
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

  try {
    const result = await executeBoundedHandler(
      () => handler(parseEnvelope(input), deliveryNumber),
      timeoutMs,
    );
    console.info("Reflo jobs development handler completed", result);
  } catch (error) {
    console.error(
      error instanceof HandlerDeadlineError
        ? "Reflo jobs development handler exceeded its deadline"
        : "Reflo jobs development handler failed",
    );
    process.exitCode = 1;
  }
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
