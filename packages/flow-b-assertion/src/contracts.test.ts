import { describe, expect, it } from "vitest";

import {
  FLOW_B_ASSERTION_VERSION,
  FLOW_B_RUN_RECORD_VERSION,
  assertFlowBRunRecord,
  finalizeFlowBRunRecord,
  readFlowBAssertionConfig,
} from "./contracts";

describe("Flow B browser assertion contracts", () => {
  it("requires runtime-only target, staff authentication, and seeded responses", () => {
    const config = readFlowBAssertionConfig({
      REFLO_FLOW_B_API_BASE_URL: "http://127.0.0.1:3001",
      REFLO_FLOW_B_APP_BASE_URL: "http://127.0.0.1:3000",
      REFLO_FLOW_B_AUTH_INBOX_ACCESS_KEY: "a".repeat(32),
      REFLO_FLOW_B_AUTH_MODE: "local-inbox",
      REFLO_FLOW_B_BROWSER_EXECUTABLE: "/opt/browser/chrome",
      REFLO_FLOW_B_INITIAL_RESPONSE: "An incomplete synthetic response.",
      REFLO_FLOW_B_MODE: "development-connected",
      REFLO_FLOW_B_RETEST_RESPONSE: "A complete synthetic response.",
      REFLO_FLOW_B_RUN_ID: `demo-${"1".repeat(32)}`,
      REFLO_FLOW_B_STAFF_EMAIL: "staff@example.test",
      REFLO_FLOW_B_TELEGRAM_DESTINATION: "100164000",
      REFLO_FLOW_B_TELEGRAM_WEBHOOK_SECRET: "a".repeat(32),
      REFLO_FLOW_B_TRACE_PROBE_URL: "http://127.0.0.1:4000/__reflo/traces",
    });

    expect(config).toMatchObject({
      auth: { mode: "local-inbox" },
      mode: "development-connected",
      timeoutMs: 45_000,
    });
    expect(JSON.stringify(config)).toContain("staff@example.test");
  });

  it("rejects unsafe target origins and malformed browser configuration", () => {
    expect(() =>
      readFlowBAssertionConfig({
        REFLO_FLOW_B_API_BASE_URL: "http://remote.example/v1",
        REFLO_FLOW_B_APP_BASE_URL: "https://app.example",
        REFLO_FLOW_B_AUTH_MODE: "login-url",
        REFLO_FLOW_B_BROWSER_EXECUTABLE: "chrome",
        REFLO_FLOW_B_INITIAL_RESPONSE: "incomplete",
        REFLO_FLOW_B_LOGIN_URL:
          "https://app.example/auth/callback?token=temporary",
        REFLO_FLOW_B_MODE: "authorized-connected",
        REFLO_FLOW_B_RETEST_RESPONSE: "complete",
        REFLO_FLOW_B_RUN_ID: `demo-${"2".repeat(32)}`,
        REFLO_FLOW_B_TELEGRAM_DESTINATION: "100164000",
        REFLO_FLOW_B_TELEGRAM_WEBHOOK_SECRET: "a".repeat(32),
        REFLO_FLOW_B_TRACE_PROBE_URL: "http://127.0.0.1:4000/__reflo/traces",
      }),
    ).toThrow("base URL is unsafe");
  });

  it("content-addresses a closed sanitized successful run record", () => {
    const record = finalizeFlowBRunRecord(runFixture());

    expect(record.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(assertFlowBRunRecord(record)).toEqual(record);
    expect(JSON.stringify(record)).not.toContain("@");
    expect(JSON.stringify(record)).not.toContain("https://");
  });

  it("fails closed when a persisted invariant or digest changes", () => {
    const record = finalizeFlowBRunRecord(runFixture());

    expect(() =>
      assertFlowBRunRecord({
        ...record,
        lesson: { ...record.lesson, semanticSimilarity: "0.85000" },
      }),
    ).toThrow();
    expect(() =>
      assertFlowBRunRecord({ ...record, durationMs: record.durationMs + 1 }),
    ).toThrow();
  });
});

function runFixture() {
  return {
    assertionVersion: FLOW_B_ASSERTION_VERSION,
    completedAt: "2026-07-25T01:00:10.000Z",
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
        model: "route-policy-v3/test-v1",
        postgres: "reflo-schema-20260724000300",
        storage: "local-smoke-object-store-v1",
        vector: "litellm-dev-embedding-v1-1234567890abcdef",
      },
    },
    durationMs: 10_000,
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
      initialMastery: "0.16667",
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
    runId: `demo-${"4".repeat(32)}`,
    startedAt: "2026-07-25T01:00:00.000Z",
    targetOriginDigest: `sha256:${"5".repeat(64)}`,
    trace: {
      capturedFieldSet: [
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
