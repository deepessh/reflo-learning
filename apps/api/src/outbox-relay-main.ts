import { validateAudioGenerationEnvelope } from "@reflo/audio";
import { PostgresRocketMqRepository } from "@reflo/db";

import { OutboxRelay, runOutboxRelayLoop } from "./outbox-relay.js";
import { emitRocketMqOperationalAlert } from "./rocketmq-alert.js";
import { RocketMqPublisher } from "./rocketmq-adapter.js";

const environment = process.env;
const shutdown = new AbortController();
let phase: "configuration" | "runtime" = "configuration";
let publisher: RocketMqPublisher | undefined;
let repository: PostgresRocketMqRepository | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort());
}

try {
  repository = new PostgresRocketMqRepository({
    connectionString: required(environment, "DATABASE_URL"),
    leaseDurationMs: positiveInteger(
      environment.REFLO_OUTBOX_RELAY_LEASE_MS,
      "REFLO_OUTBOX_RELAY_LEASE_MS",
      10_000,
      5 * 60_000,
    ),
    leaseOwner: required(environment, "REFLO_OUTBOX_RELAY_LEASE_OWNER"),
  });
  publisher = new RocketMqPublisher({
    endpoints: required(environment, "REFLO_ROCKETMQ_PRIVATE_ENDPOINT"),
    namespace: required(environment, "REFLO_ROCKETMQ_NAMESPACE"),
    requestTimeoutMs: positiveInteger(
      environment.REFLO_ROCKETMQ_REQUEST_TIMEOUT_MS,
      "REFLO_ROCKETMQ_REQUEST_TIMEOUT_MS",
      1_000,
      10_000,
    ),
    topic: required(environment, "REFLO_ROCKETMQ_JOBS_TOPIC"),
  });
  const relay = new OutboxRelay({
    batchSize: positiveInteger(
      environment.REFLO_OUTBOX_RELAY_BATCH_SIZE,
      "REFLO_OUTBOX_RELAY_BATCH_SIZE",
      1,
      25,
    ),
    publisher,
    repository,
    validate: (input) => validateAudioGenerationEnvelope(input),
  });
  phase = "runtime";
  await publisher.startup();
  console.info(
    JSON.stringify({
      component: "outbox-relay",
      event: "ready",
      state: "ready",
    }),
  );
  await runOutboxRelayLoop({
    onResult: (result) => {
      for (const [failureClass, count] of Object.entries(
        result.failureClasses,
      )) {
        if (count !== undefined && count > 0) {
          emitRocketMqOperationalAlert({
            component: "outbox-relay",
            count,
            failureClass,
            kind: "publication_failure",
          });
        }
      }
      if (result.ambiguous > 0) {
        emitRocketMqOperationalAlert({
          component: "outbox-relay",
          count: result.ambiguous,
          kind: "ambiguous_publication",
        });
      }
    },
    pollIntervalMs: positiveInteger(
      environment.REFLO_OUTBOX_RELAY_POLL_MS,
      "REFLO_OUTBOX_RELAY_POLL_MS",
      100,
      60_000,
    ),
    relay,
    signal: shutdown.signal,
  });
} catch {
  emitRocketMqOperationalAlert({
    component: "outbox-relay",
    count: 1,
    ...(phase === "configuration"
      ? { failureClass: "configuration_invalid" }
      : {}),
    kind:
      phase === "configuration" ? "configuration_drift" : "publication_failure",
  });
  console.error(
    JSON.stringify({
      component: "outbox-relay",
      event: "failed",
      failureClass: "relay_unavailable",
    }),
  );
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([
    publisher === undefined
      ? Promise.resolve()
      : boundedShutdown(publisher.shutdown(), 10_000),
    repository?.close(),
  ]);
  if (cleanup.some((result) => result.status === "rejected")) {
    console.warn(
      JSON.stringify({
        component: "outbox-relay",
        event: "shutdown_incomplete",
      }),
    );
  }
}

async function boundedShutdown(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("publisher shutdown timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function positiveInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
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
