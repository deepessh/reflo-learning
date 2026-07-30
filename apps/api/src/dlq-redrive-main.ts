import {
  PostgresRocketMqRepository,
  type RocketMqRedriveReasonCode,
} from "@reflo/db";

import { RocketMqDlqRedrive } from "./dlq-redrive.js";
import { emitRocketMqOperationalAlert } from "./rocketmq-alert.js";
import {
  RocketMqDeadLetterConsumer,
  RocketMqPublisher,
} from "./rocketmq-adapter.js";

const environment = process.env;
let phase: "configuration" | "runtime" = "configuration";
let consumer: RocketMqDeadLetterConsumer | undefined;
let publisher: RocketMqPublisher | undefined;
let repository: PostgresRocketMqRepository | undefined;

try {
  const input = commandInput(process.argv.slice(2));
  const common = {
    endpoints: required(environment, "REFLO_ROCKETMQ_PRIVATE_ENDPOINT"),
    namespace: required(environment, "REFLO_ROCKETMQ_NAMESPACE"),
    requestTimeoutMs: integer(
      environment.REFLO_ROCKETMQ_REQUEST_TIMEOUT_MS,
      "REFLO_ROCKETMQ_REQUEST_TIMEOUT_MS",
      1_000,
      10_000,
    ),
  };
  repository = new PostgresRocketMqRepository({
    connectionString: required(environment, "DATABASE_URL"),
    leaseDurationMs: integer(
      environment.REFLO_REDRIVE_LEASE_MS,
      "REFLO_REDRIVE_LEASE_MS",
      10_000,
      5 * 60_000,
    ),
    leaseOwner: required(environment, "REFLO_REDRIVE_LEASE_OWNER"),
  });
  publisher = new RocketMqPublisher({
    ...common,
    topic: required(environment, "REFLO_ROCKETMQ_JOBS_TOPIC"),
  });
  consumer = new RocketMqDeadLetterConsumer({
    ...common,
    awaitDurationMs: integer(
      environment.REFLO_REDRIVE_AWAIT_MS,
      "REFLO_REDRIVE_AWAIT_MS",
      100,
      10_000,
    ),
    consumerGroup: required(environment, "REFLO_ROCKETMQ_DLQ_OPERATOR_GROUP"),
    invisibleDurationMs: integer(
      environment.REFLO_REDRIVE_INVISIBLE_MS,
      "REFLO_REDRIVE_INVISIBLE_MS",
      10_000,
      5 * 60_000,
    ),
    topic: required(environment, "REFLO_ROCKETMQ_DLQ_TOPIC"),
  });
  const redrive = new RocketMqDlqRedrive({
    consumer,
    publisher,
    repository,
    sourceInstance: common.namespace,
    sourceTopic: required(environment, "REFLO_ROCKETMQ_JOBS_TOPIC"),
  });
  phase = "runtime";
  await Promise.all([publisher.startup(), consumer.startup()]);
  const result = await redrive.run(input);
  if (result.received > 0) {
    for (const kind of ["dlq_handoff", "dlq_backlog"] as const) {
      emitRocketMqOperationalAlert({
        component: "rocketmq-dlq-redrive",
        count: result.received,
        kind,
      });
    }
  }
  if (result.oldestRecordAgeSeconds !== undefined) {
    emitRocketMqOperationalAlert({
      ageSeconds: result.oldestRecordAgeSeconds,
      component: "rocketmq-dlq-redrive",
      count: 1,
      kind: "oldest_record_age",
    });
  }
  if (result.retryGuard > 0) {
    emitRocketMqOperationalAlert({
      component: "rocketmq-dlq-redrive",
      count: result.retryGuard,
      kind: "operator_retry_guard",
    });
  }
  if (result.validatorRejections > 0) {
    emitRocketMqOperationalAlert({
      component: "rocketmq-dlq-redrive",
      count: result.validatorRejections,
      kind: "validator_rejection",
    });
  }
  if (result.ambiguousPublications > 0) {
    emitRocketMqOperationalAlert({
      component: "rocketmq-dlq-redrive",
      count: result.ambiguousPublications,
      kind: "ambiguous_publication",
    });
  }
  console.info(
    JSON.stringify({
      component: "rocketmq-dlq-redrive",
      event: "completed",
      ...result,
    }),
  );
  if (result.blocked > 0) {
    process.exitCode = 2;
  }
} catch {
  emitRocketMqOperationalAlert({
    component: "rocketmq-dlq-redrive",
    count: 1,
    ...(phase === "configuration"
      ? { failureClass: "configuration_invalid" }
      : {}),
    kind:
      phase === "configuration" ? "configuration_drift" : "publication_failure",
  });
  console.error(
    JSON.stringify({
      component: "rocketmq-dlq-redrive",
      event: "failed",
      failureClass: "operator_path_unavailable",
    }),
  );
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([
    consumer?.shutdown(),
    publisher?.shutdown(),
    repository?.close(),
  ]);
  if (cleanup.some((result) => result.status === "rejected")) {
    process.exitCode = process.exitCode ?? 1;
  }
}

function commandInput(arguments_: readonly string[]): {
  readonly batchSize: number;
  readonly reasonCode: RocketMqRedriveReasonCode;
  readonly requestKey: string;
} {
  if (
    arguments_.length !== 6 ||
    arguments_[0] !== "--request-key" ||
    arguments_[2] !== "--reason-code" ||
    arguments_[4] !== "--batch-size"
  ) {
    throw new Error("redrive command arguments are invalid");
  }
  const requestKey = arguments_[1] ?? "";
  const reasonCode = arguments_[3] ?? "";
  const batchSize = integer(arguments_[5], "batch size", 1, 10);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestKey,
    ) ||
    ![
      "configuration_repaired",
      "provider_recovered",
      "transient_dependency_recovered",
    ].includes(reasonCode)
  ) {
    throw new Error("redrive command identity is invalid");
  }
  return {
    batchSize,
    reasonCode: reasonCode as RocketMqRedriveReasonCode,
    requestKey,
  };
}

function integer(
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
