const ALERT_KINDS = new Set([
  "ambiguous_publication",
  "configuration_drift",
  "dlq_backlog",
  "dlq_handoff",
  "oldest_record_age",
  "operator_retry_guard",
  "publication_failure",
  "validator_rejection",
]);

const FAILURE_CLASSES = new Set([
  "broker_unavailable",
  "configuration_invalid",
  "invalid_receipt",
  "publication_timeout",
  "publisher_shutdown",
  "throttled",
  "unknown_transient",
]);

export type RocketMqAlertKind =
  | "ambiguous_publication"
  | "configuration_drift"
  | "dlq_backlog"
  | "dlq_handoff"
  | "oldest_record_age"
  | "operator_retry_guard"
  | "publication_failure"
  | "validator_rejection";

export function emitRocketMqOperationalAlert(
  unsafe: {
    readonly ageSeconds?: number;
    readonly component: "outbox-relay" | "rocketmq-dlq-redrive";
    readonly count: number;
    readonly failureClass?: string;
    readonly kind: RocketMqAlertKind;
  },
  write: (line: string) => void = console.warn,
): void {
  if (
    !ALERT_KINDS.has(unsafe.kind) ||
    !["outbox-relay", "rocketmq-dlq-redrive"].includes(unsafe.component) ||
    !Number.isSafeInteger(unsafe.count) ||
    unsafe.count < 1 ||
    unsafe.count > 10_000 ||
    (unsafe.ageSeconds !== undefined &&
      (!Number.isSafeInteger(unsafe.ageSeconds) ||
        unsafe.ageSeconds < 0 ||
        unsafe.ageSeconds > 86_400)) ||
    (unsafe.failureClass !== undefined &&
      !FAILURE_CLASSES.has(unsafe.failureClass))
  ) {
    throw new Error("RocketMQ operational alert is invalid");
  }
  write(
    JSON.stringify({
      ...(unsafe.ageSeconds === undefined
        ? {}
        : { ageSeconds: unsafe.ageSeconds }),
      component: unsafe.component,
      count: unsafe.count,
      event: "operational_alert",
      ...(unsafe.failureClass === undefined
        ? {}
        : { failureClass: unsafe.failureClass }),
      kind: unsafe.kind,
      messagePolicy: "dev/media.audio.generate/v1",
      schemaVersion: "reflo-rocketmq-operational-alert-v1",
    }),
  );
}
