import { describe, expect, it } from "vitest";

import {
  FLOW_B_ASSERTION_VERSION,
  FLOW_B_RUN_RECORD_VERSION,
  type FlowBRunRecord,
  finalizeFlowBRunRecord,
} from "./contracts";
import {
  FLOW_B_REHEARSAL_MAX_DURATION_MS,
  FLOW_B_REHEARSAL_RECORD_VERSION,
  assertFlowBRehearsalRecord,
  finalizeFlowBRehearsalRecord,
  verifyFlowBRehearsalSources,
} from "./rehearsal";

describe("Flow B repeated rehearsal evidence", () => {
  it("content-addresses ten sequential sub-six-minute runs without overstating reliability", () => {
    const runs = Array.from({ length: 10 }, (_, index) =>
      runFixture(index, 4_000 + index * 100),
    );

    const record = finalizeFlowBRehearsalRecord(runs);

    expect(record).toMatchObject({
      assertionVersion: FLOW_B_ASSERTION_VERSION,
      claims: {
        capacity: false,
        causalLearning: false,
        certification: false,
        p95: false,
        pilot: false,
        productionReadiness: false,
        releaseGate: false,
        retention: false,
        securityQualification: false,
      },
      duration: {
        maximumMs: 4_900,
        medianMs: 4_400,
        minimumMs: 4_000,
      },
      fixes: [],
      observedFailureCount: 0,
      recordVersion: FLOW_B_REHEARSAL_RECORD_VERSION,
      runCount: 10,
      targetProfile: "development-fixture-v1",
      tenConsecutiveRunsCompleted: true,
    });
    expect(record.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(assertFlowBRehearsalRecord(record)).toEqual(record);
    expect(verifyFlowBRehearsalSources(record, runs)).toEqual(record);
  });

  it("rejects target drift and any run over the six-minute demo limit", () => {
    const runs = Array.from({ length: 10 }, (_, index) =>
      runFixture(index, 5_000),
    );
    const record = finalizeFlowBRehearsalRecord(runs);
    const drifted = [
      ...runs.slice(0, 9),
      finalizeFlowBRunRecord({
        ...unsignedRun(9, 5_000),
        targetOriginDigest: `sha256:${"f".repeat(64)}`,
      }),
    ];

    expect(() => verifyFlowBRehearsalSources(record, drifted)).toThrow(
      "flow_b_rehearsal_source_drift",
    );
    expect(() =>
      finalizeFlowBRehearsalRecord([
        ...runs.slice(0, 9),
        runFixture(9, FLOW_B_REHEARSAL_MAX_DURATION_MS + 1),
      ]),
    ).toThrow("flow_b_run_record_invalid");
  });

  it("rejects duplicate or overlapping run evidence and changed aggregates", () => {
    const runs = Array.from({ length: 10 }, (_, index) =>
      runFixture(index, 5_000),
    );
    const record = finalizeFlowBRehearsalRecord(runs);

    expect(() =>
      finalizeFlowBRehearsalRecord([...runs.slice(0, 9), runs[0]!]),
    ).toThrow("flow_b_rehearsal_record_invalid");
    expect(() =>
      finalizeFlowBRehearsalRecord([
        runs[0]!,
        runFixture(1, 5_000, Date.parse(runs[0]!.startedAt) + 1_000),
        ...runs.slice(2),
      ]),
    ).toThrow("flow_b_rehearsal_record_invalid");
    expect(() =>
      assertFlowBRehearsalRecord({
        ...record,
        claims: { ...record.claims, p95: true as false },
      }),
    ).toThrow("flow_b_rehearsal_record_invalid");
  });
});

function runFixture(
  index: number,
  durationMs: number,
  startedAtMs = Date.UTC(2026, 6, 25, 2, index),
): FlowBRunRecord {
  return finalizeFlowBRunRecord(unsignedRun(index, durationMs, startedAtMs));
}

function unsignedRun(
  index: number,
  durationMs: number,
  startedAtMs = Date.UTC(2026, 6, 25, 2, index),
) {
  const uniqueHex = (index + 1).toString(16);
  const startedAt = new Date(startedAtMs).toISOString();
  const completedAt = new Date(startedAtMs + durationMs).toISOString();
  return {
    assertionVersion: FLOW_B_ASSERTION_VERSION,
    completedAt,
    dependencyPreflight: {
      attempts: [
        {
          injectedUnavailable: "model" as const,
          sequence: 1,
          status: "unavailable" as const,
        },
        {
          injectedUnavailable: "storage" as const,
          sequence: 2,
          status: "unavailable" as const,
        },
        {
          injectedUnavailable: "delivery" as const,
          sequence: 3,
          status: "unavailable" as const,
        },
        {
          injectedUnavailable: null,
          sequence: 4,
          status: "ready" as const,
        },
      ],
      contractVersion: "connected-demo-preflight-v1",
      versions: {
        delivery: "demo-delivery-v1",
        model: "route-policy-v6/test-v1",
        postgres: "reflo-schema-20260724000300",
        storage: "local-smoke-object-store-v1",
        vector: "litellm-dev-embedding-v1-1234567890abcdef",
      },
    },
    durationMs,
    delivery: {
      attemptDigest: `sha256:${"6".repeat(64)}`,
      deliveryDigest: `sha256:${"7".repeat(64)}`,
      dispatchCreated: true as const,
      dispatchReplayed: true as const,
      webhookCreated: true as const,
      webhookReplayed: true as const,
    },
    evidence: {
      finalMastery: "0.25000",
      initialAttemptDigest: `sha256:${"1".repeat(64)}`,
      initialEligibleAttemptCount: 2,
      initialFailureBand: "incorrect" as const,
      initialMastery: "0.14286",
      lessonBaselineMastery: "0.14286",
      lessonExposureMastery: "0.14286",
      masteryDelta: "0.10714",
      retestAttemptDigest: `sha256:${"2".repeat(64)}`,
      retestBand: "correct" as const,
    },
    honestBoundary: {
      externalDestinationUsed: false as const,
      externalLearnerUsed: false as const,
      repeatedReliabilityClaimed: false as const,
      rightsClearedSeedRequired: true as const,
    },
    lesson: {
      differentStrategy: true as const,
      generationVersion: "reteach-generation-v1" as const,
      replacementOrdinal: 1 as const,
      semanticSimilarity: "0.42000",
      sourceSpanCount: 1,
      strategyDigest: `sha256:${"3".repeat(64)}`,
    },
    mode: "development-connected" as const,
    recordVersion: FLOW_B_RUN_RECORD_VERSION,
    replay: {
      initialAttemptReplayed: true as const,
      retestAttemptReplayed: true as const,
    },
    runId: `demo-${uniqueHex.padStart(32, "0")}`,
    startedAt,
    targetProfile: "development-fixture-v1" as const,
    targetOriginDigest: `sha256:${"5".repeat(64)}`,
    trace: {
      allowlistValidated: true as const,
      coreFieldCoverage: [
        "attemptCount",
        "durationMs",
        "modelTask",
        "operation",
        "outcome",
        "routePolicyVersion",
        "stage",
        "validationStatus",
      ] as const,
      eventCount: 4,
      observedFieldSet: [
        "attemptCount",
        "durationMs",
        "modelTask",
        "operation",
        "outcome",
        "routePolicyVersion",
        "stage",
        "validationStatus",
        "component",
        "demoRunId",
        "eventId",
        "schemaVersion",
      ] as const,
      schemaVersion: "demo-operational-trace-v1" as const,
    },
    ui: {
      exactDeltaDisplayedInKnowledgeMap: true as const,
      exactDeltaDisplayedInSummary: true as const,
      explicitFailureStates: ["model", "storage", "delivery"] as const,
      noSuccessRecordedCopyDisplayed: true as const,
      recoveryAttempts: 3 as const,
    },
    versions: {
      gradingPolicy: "grading-policy-v1" as const,
      knowledgeAlgorithm: "knowledge-model-v1" as const,
      studyView: "connected-study-view-v1" as const,
    },
  };
}
