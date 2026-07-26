import { createHash } from "node:crypto";

import {
  FLOW_B_ASSERTION_VERSION,
  type FlowBRunRecord,
  assertFlowBRunRecord,
} from "./contracts.js";

export const FLOW_B_REHEARSAL_RECORD_VERSION =
  "flow-b-rehearsal-record-v1" as const;
export const FLOW_B_REHEARSAL_RUN_COUNT = 10 as const;
export const FLOW_B_REHEARSAL_MAX_DURATION_MS = 6 * 60 * 1_000;

export interface FlowBRehearsalRecord {
  readonly assertionVersion: typeof FLOW_B_ASSERTION_VERSION;
  readonly completedAt: string;
  readonly dependencyVersions: FlowBRunRecord["dependencyPreflight"]["versions"];
  readonly duration: {
    readonly maximumMs: number;
    readonly medianMs: number;
    readonly minimumMs: number;
    readonly p95Ms: number;
  };
  readonly fixes: readonly [];
  readonly mode: FlowBRunRecord["mode"];
  readonly observedFailureCount: 0;
  readonly productionReliabilityClaimed: false;
  readonly recordDigest: string;
  readonly recordVersion: typeof FLOW_B_REHEARSAL_RECORD_VERSION;
  readonly runCount: typeof FLOW_B_REHEARSAL_RUN_COUNT;
  readonly runs: readonly FlowBRehearsalRun[];
  readonly startedAt: string;
  readonly targetOriginDigest: string;
  readonly tenConsecutiveRunsCompleted: true;
  readonly versions: FlowBRunRecord["versions"];
}

export interface FlowBRehearsalRun {
  readonly completedAt: string;
  readonly durationMs: number;
  readonly recordDigest: string;
  readonly runId: string;
  readonly sequence: number;
  readonly startedAt: string;
}

export function finalizeFlowBRehearsalRecord(
  runRecords: readonly FlowBRunRecord[],
): FlowBRehearsalRecord {
  const runs = runRecords.map((record, index) => {
    assertFlowBRunRecord(record);
    return {
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      recordDigest: record.recordDigest,
      runId: record.runId,
      sequence: index + 1,
      startedAt: record.startedAt,
    };
  });
  const first = requiredRun(runRecords[0]);
  const durations = runs.map((run) => run.durationMs).sort((a, b) => a - b);
  const unsigned: Omit<FlowBRehearsalRecord, "recordDigest"> = {
    assertionVersion: FLOW_B_ASSERTION_VERSION,
    completedAt: requiredRun(runs.at(-1)).completedAt,
    dependencyVersions: first.dependencyPreflight.versions,
    duration: {
      maximumMs: requiredNumber(durations.at(-1)),
      medianMs: nearestRank(durations, 0.5),
      minimumMs: requiredNumber(durations[0]),
      p95Ms: nearestRank(durations, 0.95),
    },
    fixes: [],
    mode: first.mode,
    observedFailureCount: 0,
    productionReliabilityClaimed: false,
    recordVersion: FLOW_B_REHEARSAL_RECORD_VERSION,
    runCount: FLOW_B_REHEARSAL_RUN_COUNT,
    runs,
    startedAt: requiredRun(runs[0]).startedAt,
    targetOriginDigest: first.targetOriginDigest,
    tenConsecutiveRunsCompleted: true,
    versions: first.versions,
  };
  const record: FlowBRehearsalRecord = {
    ...unsigned,
    recordDigest: digest(canonicalJson(unsigned)),
  };
  return assertFlowBRehearsalRecord(record);
}

export function assertFlowBRehearsalRecord(
  record: FlowBRehearsalRecord,
): FlowBRehearsalRecord {
  const { recordDigest: _recordDigest, ...unsigned } = record;
  const startedAt = Date.parse(record.startedAt);
  const completedAt = Date.parse(record.completedAt);
  const durations = record.runs
    .map((run) => run.durationMs)
    .sort((left, right) => left - right);
  const runIds = new Set(record.runs.map((run) => run.runId));
  const runDigests = new Set(record.runs.map((run) => run.recordDigest));
  const sequential = record.runs.every((run, index) => {
    const previous = record.runs[index - 1];
    return (
      run.sequence === index + 1 &&
      Number.isFinite(Date.parse(run.startedAt)) &&
      Number.isFinite(Date.parse(run.completedAt)) &&
      Date.parse(run.completedAt) - Date.parse(run.startedAt) ===
        run.durationMs &&
      (previous === undefined ||
        Date.parse(run.startedAt) >= Date.parse(previous.completedAt))
    );
  });

  if (
    record.recordVersion !== FLOW_B_REHEARSAL_RECORD_VERSION ||
    record.assertionVersion !== FLOW_B_ASSERTION_VERSION ||
    record.recordDigest !== digest(canonicalJson(unsigned)) ||
    !/^sha256:[a-f0-9]{64}$/.test(record.recordDigest) ||
    record.runCount !== FLOW_B_REHEARSAL_RUN_COUNT ||
    record.runs.length !== FLOW_B_REHEARSAL_RUN_COUNT ||
    runIds.size !== FLOW_B_REHEARSAL_RUN_COUNT ||
    runDigests.size !== FLOW_B_REHEARSAL_RUN_COUNT ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt ||
    record.startedAt !== requiredRun(record.runs[0]).startedAt ||
    record.completedAt !== requiredRun(record.runs.at(-1)).completedAt ||
    record.tenConsecutiveRunsCompleted !== true ||
    record.observedFailureCount !== 0 ||
    record.fixes.length !== 0 ||
    record.productionReliabilityClaimed !== false ||
    record.duration.minimumMs !== requiredNumber(durations[0]) ||
    record.duration.maximumMs !== requiredNumber(durations.at(-1)) ||
    record.duration.medianMs !== nearestRank(durations, 0.5) ||
    record.duration.p95Ms !== nearestRank(durations, 0.95) ||
    record.duration.maximumMs > FLOW_B_REHEARSAL_MAX_DURATION_MS ||
    !sequential
  ) {
    throw new Error("flow_b_rehearsal_record_invalid");
  }

  return record;
}

export function verifyFlowBRehearsalSources(
  record: FlowBRehearsalRecord,
  runRecords: readonly FlowBRunRecord[],
): FlowBRehearsalRecord {
  assertFlowBRehearsalRecord(record);
  if (runRecords.length !== FLOW_B_REHEARSAL_RUN_COUNT) {
    throw new Error("flow_b_rehearsal_source_count_invalid");
  }
  const first = requiredRun(runRecords[0]);
  const expectedRuns = runRecords.map((run, index) => {
    assertFlowBRunRecord(run);
    if (
      run.mode !== record.mode ||
      run.targetOriginDigest !== record.targetOriginDigest ||
      canonicalJson(run.dependencyPreflight.versions) !==
        canonicalJson(record.dependencyVersions) ||
      canonicalJson(run.versions) !== canonicalJson(record.versions) ||
      run.durationMs > FLOW_B_REHEARSAL_MAX_DURATION_MS
    ) {
      throw new Error("flow_b_rehearsal_source_drift");
    }
    return {
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      recordDigest: run.recordDigest,
      runId: run.runId,
      sequence: index + 1,
      startedAt: run.startedAt,
    };
  });
  if (
    first.mode !== record.mode ||
    canonicalJson(expectedRuns) !== canonicalJson(record.runs)
  ) {
    throw new Error("flow_b_rehearsal_source_mismatch");
  }
  return record;
}

function nearestRank(values: readonly number[], percentile: number): number {
  const index = Math.ceil(percentile * values.length) - 1;
  return requiredNumber(values[index]);
}

function requiredNumber(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("flow_b_rehearsal_run_count_invalid");
  }
  return value;
}

function requiredRun<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("flow_b_rehearsal_run_count_invalid");
  }
  return value;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
