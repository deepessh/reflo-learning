import {
  FLOW_B_ALLOWED_TRACE_FIELDS,
  FLOW_B_ASSERTION_VERSION,
  FLOW_B_CORE_TRACE_FIELDS,
  FLOW_B_DEPENDENCIES,
  FLOW_B_RUN_RECORD_VERSION,
  exactMasteryDelta,
  finalizeFlowBRunRecord,
  valueDigest,
  type FlowBAssertionConfig,
  type FlowBDependencyName,
  type FlowBRunRecord,
} from "./contracts.js";
import { ChromeCdpSession } from "./cdp.js";

interface PreflightView {
  readonly boundary: {
    readonly contractVersion: "connected-demo-boundary-v1";
    readonly destinationClass: "staff-controlled-test";
    readonly learnerClass: "staff-controlled";
    readonly sourceClass: "human-approved-rights-cleared";
  };
  readonly checkedAt: string;
  readonly contractVersion: string;
  readonly dependencies: readonly {
    readonly code: "available" | "unavailable";
    readonly contractVersion: string;
    readonly name: FlowBDependencyName;
  }[];
  readonly status: "ready" | "unavailable";
}

interface BrowserSnapshot {
  readonly assessments: readonly CapturedAssessment[];
  readonly nextActions: readonly Record<string, unknown>[];
  readonly preflights: readonly (PreflightView & {
    readonly injectedUnavailable?: FlowBDependencyName;
  })[];
  readonly progress: readonly Record<string, unknown>[];
  readonly replays: readonly CapturedAssessment[];
  readonly views: readonly Record<string, unknown>[];
}

interface CapturedAssessment extends Record<string, unknown> {
  readonly path: string;
  readonly result: Record<string, unknown>;
}

interface TraceProbe {
  readonly allowlistValidated: true;
  readonly coreFieldCoverage: FlowBRunRecord["trace"]["coreFieldCoverage"];
  readonly eventCount: number;
  readonly observedFieldSet: FlowBRunRecord["trace"]["observedFieldSet"];
  readonly schemaVersion: FlowBRunRecord["trace"]["schemaVersion"];
}

interface DeliveryReplayProof {
  readonly attemptId: string;
  readonly deliveryId: string;
}

const FAILURE_SEQUENCE = ["model", "storage", "delivery"] as const;

export async function runFlowBBrowserAssertion(
  config: FlowBAssertionConfig,
): Promise<FlowBRunRecord> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const preflight = await loadReadyPreflight(config);
  const browser = await ChromeCdpSession.launch(
    config.browserExecutable,
    config.timeoutMs,
    { ignoreCertificateErrors: config.mode === "development-connected" },
  );
  try {
    await browser.enable();
    await browser.addScriptOnNewDocument(
      instrumentationSource(preflight, config.browserApiBaseUrl),
    );
    await browser.navigate(config.appBaseUrl);
    await authenticate(browser, config);
    await browser.evaluate<void>(
      `globalThis.__refloFlowBAssertion.setFailures(${JSON.stringify(
        FAILURE_SEQUENCE,
      )})`,
    );

    await clickButton(browser, "Reset & start demo");
    for (const [index, dependency] of FAILURE_SEQUENCE.entries()) {
      await waitForText(browser, `Check ${dependency}`, config.timeoutMs);
      await assertText(browser, "No success was recorded.");
      await clickButton(browser, "Try again");
      if (index === FAILURE_SEQUENCE.length - 1) {
        await waitForText(
          browser,
          "Evidence check · answer incompletely to demonstrate the trigger",
          config.timeoutMs,
        );
      }
    }

    await fill(browser, "#flow-answer", config.initialResponse);
    await clickButton(browser, "Submit evidence");
    await waitForText(browser, "Eligible failing evidence", config.timeoutMs);
    const initialReplay = await replayAssessment(browser, "short-answer");
    assertReplay(initialReplay);

    await clickButton(browser, "Generate a different lesson");
    await waitForText(
      browser,
      "A materially different explanation",
      config.timeoutMs,
    );
    await assertText(browser, "Viewing it does not change mastery.");
    await clickButton(browser, "Continue to distinct re-test");
    await waitForText(
      browser,
      "Distinct re-test · answer from the new explanation",
      config.timeoutMs,
    );

    await fill(browser, "#flow-answer", config.retestResponse);
    await clickButton(browser, "Submit re-test");
    await waitForText(browser, "Eligible correct evidence", config.timeoutMs);
    const retestReplay = await replayAssessment(browser, "short-answer");
    assertReplay(retestReplay);

    await clickButton(browser, "Verify mastery delta");
    await waitForText(
      browser,
      "The re-test evidence closed the loop.",
      config.timeoutMs,
    );
    await clickButton(browser, "Refresh Knowledge Map");
    await waitForText(browser, "Correct re-test evidence", config.timeoutMs);

    const snapshot = await browser.evaluate<BrowserSnapshot>(
      "globalThis.__refloFlowBAssertion.snapshot()",
    );
    const summaryText = await browser.evaluate<string>(
      "document.querySelector('.flow-summary')?.innerText ?? ''",
    );
    const knowledgeMapText = await browser.evaluate<string>(
      "document.querySelector('.knowledge-panel')?.innerText ?? ''",
    );
    const delivery = await proveDeliveryReplay(browser, config);
    const trace = await loadTraceProbe(config);
    const completed = Date.now();
    return buildRunRecord({
      completed,
      config,
      delivery,
      knowledgeMapText,
      preflight,
      snapshot,
      started,
      startedAt,
      summaryText,
      trace,
    });
  } finally {
    await browser.close();
  }
}

async function loadReadyPreflight(
  config: FlowBAssertionConfig,
): Promise<PreflightView> {
  const endpoint = new URL("/v1/demo/preflight", config.apiBaseUrl);
  const response = await fetch(endpoint, {
    redirect: "error",
    signal: AbortSignal.timeout(6_000),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  const preflight = parsePreflight(body);
  if (!response.ok || preflight.status !== "ready") {
    const unavailable = preflight.dependencies
      .filter((dependency) => dependency.code === "unavailable")
      .map((dependency) => dependency.name)
      .join(",");
    throw new Error(
      `Connected Flow B preflight is not ready${unavailable === "" ? "" : `: ${unavailable}`}`,
    );
  }
  return preflight;
}

async function authenticate(
  browser: ChromeCdpSession,
  config: FlowBAssertionConfig,
): Promise<void> {
  let loginUrl: URL;
  if (config.auth.mode === "local-inbox") {
    await waitForText(browser, "Sign in to Reflo", config.timeoutMs);
    await fill(browser, "#email", config.auth.email);
    await clickButton(browser, "Email me a secure link");
    await waitForText(browser, "CHECK YOUR INBOX", config.timeoutMs);
    const response = await fetch(
      new URL("/v1/dev/auth-inbox/latest", config.apiBaseUrl),
      {
        headers: {
          "x-reflo-dev-inbox-key": config.auth.accessKey,
        },
        redirect: "error",
        signal: AbortSignal.timeout(6_000),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      readonly message?: { readonly loginUrl?: unknown };
    } | null;
    if (!response.ok || typeof body?.message?.loginUrl !== "string") {
      throw new Error(
        "The configured development authentication link is unavailable",
      );
    }
    loginUrl = assertedLoginUrl(body.message.loginUrl, config.appBaseUrl);
  } else {
    loginUrl = config.auth.loginUrl;
  }
  await browser.navigate(loginUrl);
  await waitForText(browser, "Good to have you back.", config.timeoutMs);
  await waitForText(browser, "Adaptive study loop", config.timeoutMs);
}

function buildRunRecord(input: {
  readonly completed: number;
  readonly config: FlowBAssertionConfig;
  readonly delivery: DeliveryReplayProof;
  readonly knowledgeMapText: string;
  readonly preflight: PreflightView;
  readonly snapshot: BrowserSnapshot;
  readonly started: number;
  readonly startedAt: string;
  readonly summaryText: string;
  readonly trace: TraceProbe;
}): FlowBRunRecord {
  const initialView = findView(input.snapshot.views, "question");
  const lessonView = findView(input.snapshot.views, "retest");
  const finalView = findView(input.snapshot.views, "complete");
  const initialAssessment = findAssessment(
    input.snapshot.assessments,
    "incorrect",
    0,
  );
  const retestAssessment = findAssessment(
    input.snapshot.assessments,
    "correct",
    1,
  );
  const initialReplay = findReplay(input.snapshot.replays, 0);
  const retestReplay = findReplay(input.snapshot.replays, 1);
  const initialConcept = objectField(initialView, "concept");
  const lessonConcept = objectField(lessonView, "concept");
  const finalConcept = objectField(finalView, "concept");
  const lesson = objectField(lessonView, "lesson");
  const loopResult = objectField(finalView, "loopResult");
  const initialQuestion = objectField(initialView, "question");
  const retestQuestion = findRetestQuestion(input.snapshot.nextActions);
  const initialResult = objectField(initialAssessment, "result");
  const retestResult = objectField(retestAssessment, "result");
  const initialReplayResult = objectField(initialReplay, "result");
  const retestReplayResult = objectField(retestReplay, "result");
  const initialAttemptId = stringField(initialResult, "attemptId");
  const retestAttemptId = stringField(retestResult, "attemptId");
  if (
    stringField(initialReplayResult, "attemptId") !== initialAttemptId ||
    stringField(retestReplayResult, "attemptId") !== retestAttemptId ||
    stringField(initialReplayResult, "status") !== "replayed" ||
    stringField(retestReplayResult, "status") !== "replayed" ||
    stringField(initialQuestion, "itemId") ===
      stringField(retestQuestion, "itemId")
  ) {
    throw new Error("Flow B replay or distinct re-test assertion failed");
  }
  const priorStrategy = stringField(lesson, "priorStrategyTag");
  const strategy = stringField(lesson, "strategyTag");
  const similarity = exactDecimal(lesson, "semanticSimilarity");
  const lessonBaseline = exactDecimal(lesson, "baselineMastery");
  const lessonMastery = exactDecimal(lessonConcept, "mastery");
  const finalMastery = exactDecimal(finalConcept, "mastery");
  const delta = signedDecimal(loopResult, "masteryDelta");
  const initialMastery = exactDecimal(loopResult, "initialMastery");
  assertConnectedMasteryProof({
    concepts: {
      finalView: stringField(finalConcept, "conceptId"),
      initialEvidence: eligibleConceptIds(initialResult),
      initialQuestion: stringField(initialQuestion, "conceptId"),
      initialView: stringField(initialConcept, "conceptId"),
      lessonView: stringField(lessonConcept, "conceptId"),
      loopResult: stringField(loopResult, "conceptId"),
      retestEvidence: eligibleConceptIds(retestResult),
      retestQuestion: stringField(retestQuestion, "conceptId"),
    },
    finalMastery,
    lessonBaselineMastery: lessonBaseline,
    loopEvidenceAttemptId: stringField(loopResult, "evidenceAttemptId"),
    loopFinalMastery: exactDecimal(loopResult, "finalMastery"),
    loopInitialMastery: initialMastery,
    masteryDelta: delta,
    retestAttemptId,
  });
  const expectedInitialLabel = exactPercentLabel(initialMastery);
  const expectedFinalLabel = exactPercentLabel(
    exactDecimal(loopResult, "finalMastery"),
  );
  const expectedDeltaLabel = masteryDeltaLabel(delta);
  if (
    priorStrategy === strategy ||
    Number(similarity) >= 0.85 ||
    lessonBaseline !== lessonMastery ||
    stringField(loopResult, "outcome") !== "retest_succeeded" ||
    !input.summaryText.includes(expectedInitialLabel) ||
    !input.summaryText.includes(expectedFinalLabel) ||
    !input.summaryText.includes(expectedDeltaLabel) ||
    !input.knowledgeMapText.includes(expectedDeltaLabel)
  ) {
    throw new Error(
      "Flow B persisted evidence or exact UI delta assertion failed",
    );
  }
  const versions = Object.fromEntries(
    input.preflight.dependencies.map((dependency) => [
      dependency.name,
      dependency.contractVersion,
    ]),
  ) as Record<FlowBDependencyName, string>;
  const attempts = input.snapshot.preflights.map((attempt, index) => ({
    injectedUnavailable: attempt.injectedUnavailable ?? null,
    sequence: index + 1,
    status: attempt.status,
  }));
  if (
    attempts.length !== 4 ||
    FAILURE_SEQUENCE.some(
      (name, index) =>
        attempts[index]?.injectedUnavailable !== name ||
        attempts[index]?.status !== "unavailable",
    ) ||
    attempts[3]?.status !== "ready"
  ) {
    throw new Error("Flow B bounded dependency recovery assertion failed");
  }
  const initialBand = assessmentBand(initialResult);
  if (initialBand === "correct") {
    throw new Error("Flow B initial evidence did not fail");
  }
  if (assessmentBand(retestResult) !== "correct") {
    throw new Error("Flow B re-test evidence was not correct");
  }
  const completedAt = new Date(input.completed).toISOString();
  return finalizeFlowBRunRecord({
    assertionVersion: FLOW_B_ASSERTION_VERSION,
    completedAt,
    dependencyPreflight: {
      attempts,
      contractVersion: input.preflight.contractVersion,
      versions,
    },
    durationMs: input.completed - input.started,
    delivery: {
      attemptDigest: valueDigest(input.delivery.attemptId),
      deliveryDigest: valueDigest(input.delivery.deliveryId),
      dispatchCreated: true,
      dispatchReplayed: true,
      webhookCreated: true,
      webhookReplayed: true,
    },
    evidence: {
      finalMastery,
      initialAttemptDigest: valueDigest(initialAttemptId),
      initialEligibleAttemptCount: integerField(
        initialConcept,
        "eligibleAttemptCount",
      ),
      initialFailureBand: initialBand,
      initialMastery,
      lessonBaselineMastery: lessonBaseline,
      lessonExposureMastery: lessonMastery,
      masteryDelta: delta,
      retestAttemptDigest: valueDigest(retestAttemptId),
      retestBand: "correct",
    },
    honestBoundary: {
      externalDestinationUsed:
        input.preflight.boundary.destinationClass === "staff-controlled-test"
          ? false
          : failBoundary(),
      externalLearnerUsed:
        input.preflight.boundary.learnerClass === "staff-controlled"
          ? false
          : failBoundary(),
      repeatedReliabilityClaimed: false,
      rightsClearedSeedRequired:
        input.preflight.boundary.sourceClass === "human-approved-rights-cleared"
          ? true
          : failBoundary(),
    },
    lesson: {
      differentStrategy: true,
      generationVersion: literalField(
        lesson,
        "generationVersion",
        "reteach-generation-v1",
      ),
      replacementOrdinal: ordinalField(lesson, "replacementOrdinal"),
      semanticSimilarity: similarity,
      sourceSpanCount: integerField(lesson, "sourceSpanCount"),
      strategyDigest: valueDigest(`${priorStrategy}\0${strategy}`),
    },
    mode: input.config.mode,
    recordVersion: FLOW_B_RUN_RECORD_VERSION,
    replay: {
      initialAttemptReplayed: true,
      retestAttemptReplayed: true,
    },
    runId: input.config.runId,
    startedAt: input.startedAt,
    targetOriginDigest: valueDigest(
      [
        input.config.appBaseUrl.origin,
        input.config.apiBaseUrl.origin,
        input.config.browserApiBaseUrl.origin,
      ].join("\0"),
    ),
    trace: input.trace,
    ui: {
      exactDeltaDisplayedInKnowledgeMap: true,
      exactDeltaDisplayedInSummary: true,
      explicitFailureStates: ["model", "storage", "delivery"],
      noSuccessRecordedCopyDisplayed: true,
      recoveryAttempts: 3,
    },
    versions: {
      gradingPolicy: "grading-policy-v1",
      knowledgeAlgorithm: "knowledge-model-v1",
      studyView: literalField(
        finalView,
        "contractVersion",
        "connected-study-view-v1",
      ),
    },
  });
}

async function proveDeliveryReplay(
  browser: ChromeCdpSession,
  config: FlowBAssertionConfig,
): Promise<DeliveryReplayProof> {
  const dispatches = await browser.evaluate<readonly Record<string, unknown>[]>(
    `(async () => {
      const apiOrigin = ${JSON.stringify(config.browserApiBaseUrl.origin)};
      const csrfResponse = await fetch(apiOrigin + "/v1/csrf-token", {
        credentials: "include"
      });
      const csrfBody = await csrfResponse.json();
      if (!csrfResponse.ok || typeof csrfBody.csrfToken !== "string") {
        throw new Error("delivery replay CSRF unavailable");
      }
      const request = {
        body: JSON.stringify({
          idempotencyKey: ${JSON.stringify(`flow-b/${config.runId}/telegram`)},
          provider: "telegram"
        }),
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-reflo-csrf": csrfBody.csrfToken
        },
        method: "POST"
      };
      const first = await fetch(
        apiOrigin + "/v1/demo/deliveries/dispatch",
        request
      );
      const second = await fetch(
        apiOrigin + "/v1/demo/deliveries/dispatch",
        request
      );
      const bodies = await Promise.all([first.json(), second.json()]);
      if (!first.ok || !second.ok) {
        throw new Error(
          "delivery replay dispatch failed: " +
          JSON.stringify({
            first: { error: bodies[0]?.error, status: first.status },
            second: { error: bodies[1]?.error, status: second.status }
          })
        );
      }
      return bodies.map((body) => body.result);
    })()`,
  );
  const first = asObject(dispatches[0]);
  const second = asObject(dispatches[1]);
  const firstDelivery = objectField(first, "delivery");
  const secondDelivery = objectField(second, "delivery");
  const deliveryId = stringField(firstDelivery, "deliveryId");
  const items = firstDelivery.items;
  if (
    stringField(first, "status") !== "created" ||
    stringField(second, "status") !== "replayed" ||
    stringField(secondDelivery, "deliveryId") !== deliveryId ||
    !Array.isArray(items) ||
    items.length !== 1
  ) {
    throw new Error("Connected delivery dispatch replay assertion failed");
  }
  const deliveryItemId = stringField(asObject(items[0]), "deliveryItemId");
  const callbackBody = JSON.stringify({
    callback_query: {
      data: `reflo:${deliveryId}:${deliveryItemId}:0`,
      from: { id: config.delivery.telegramDestination },
      id: `${config.runId}-webhook`,
      message: { chat: { id: config.delivery.telegramDestination } },
    },
    update_id: 164,
  });
  const webhookUrl = new URL("/v1/webhooks/telegram", config.apiBaseUrl);
  const webhook = async (): Promise<readonly Record<string, unknown>[]> => {
    const response = await fetch(webhookUrl, {
      body: callbackBody,
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token":
          config.delivery.telegramWebhookSecret,
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = asObject(await response.json().catch(() => null));
    if (
      !response.ok ||
      body.accepted !== true ||
      !Array.isArray(body.results)
    ) {
      throw new Error("Connected delivery webhook replay failed");
    }
    return body.results.map(asObject);
  };
  const created = await webhook();
  const replayed = await webhook();
  if (
    created.length !== 1 ||
    replayed.length !== 1 ||
    stringField(created[0]!, "status") !== "created" ||
    stringField(replayed[0]!, "status") !== "replayed"
  ) {
    throw new Error("Connected delivery webhook status assertion failed");
  }
  const attemptId = stringField(created[0]!, "attemptId");
  if (stringField(replayed[0]!, "attemptId") !== attemptId) {
    throw new Error("Connected delivery webhook created a duplicate attempt");
  }
  return { attemptId, deliveryId };
}

async function loadTraceProbe(
  config: FlowBAssertionConfig,
): Promise<TraceProbe> {
  const response = await fetch(config.traceProbeUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(6_000),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  const record = asObject(body);
  const coreFieldCoverage = stringArrayField(record, "coreFieldCoverage");
  const observedFieldSet = stringArrayField(record, "observedFieldSet");
  if (
    !response.ok ||
    record.allowlistValidated !== true ||
    record.schemaVersion !== "demo-operational-trace-v1" ||
    !Number.isSafeInteger(record.eventCount) ||
    (record.eventCount as number) < 4 ||
    JSON.stringify(coreFieldCoverage) !==
      JSON.stringify(FLOW_B_CORE_TRACE_FIELDS) ||
    observedFieldSet.length < FLOW_B_CORE_TRACE_FIELDS.length ||
    new Set(observedFieldSet).size !== observedFieldSet.length ||
    observedFieldSet.some(
      (field) =>
        !FLOW_B_ALLOWED_TRACE_FIELDS.includes(
          field as (typeof FLOW_B_ALLOWED_TRACE_FIELDS)[number],
        ),
    ) ||
    FLOW_B_CORE_TRACE_FIELDS.some((field) => !observedFieldSet.includes(field))
  ) {
    throw new Error("Sanitized operational trace evidence is unavailable");
  }
  return {
    allowlistValidated: true,
    coreFieldCoverage: FLOW_B_CORE_TRACE_FIELDS,
    eventCount: record.eventCount as number,
    observedFieldSet:
      observedFieldSet as FlowBRunRecord["trace"]["observedFieldSet"],
    schemaVersion: "demo-operational-trace-v1",
  };
}

async function replayAssessment(
  browser: ChromeCdpSession,
  kind: string,
): Promise<CapturedAssessment> {
  return browser.evaluate<CapturedAssessment>(
    `globalThis.__refloFlowBAssertion.replay(${JSON.stringify(kind)})`,
  );
}

function assertReplay(replay: CapturedAssessment): void {
  if (stringField(replay.result, "status") !== "replayed") {
    throw new Error("The browser submission replay did not reuse its attempt");
  }
}

async function waitForText(
  browser: ChromeCdpSession,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await browser.evaluate<boolean>(
      `(document.body?.innerText.toLocaleLowerCase().includes(${JSON.stringify(
        text.toLocaleLowerCase(),
      )}) ?? false)`,
    );
    if (found) {
      return;
    }
    await delay(100);
  }
  const diagnostic = await browser.evaluate<string>(`(() => {
    const portal = document.querySelector("nextjs-portal");
    const overlay = portal?.shadowRoot?.innerText ?? "";
    const body = document.body?.innerText ?? "";
    const requests = globalThis.__refloFlowBAssertion?.diagnostics?.() ?? [];
    return JSON.stringify({
      requests,
      body: [body, overlay].filter(Boolean).join("\\n---\\n").slice(0, 700)
    }).slice(0, 2000);
  })()`);
  throw new Error(
    `Browser text assertion timed out: ${text}; visible=${JSON.stringify(
      diagnostic,
    )}; runtime=${JSON.stringify(browser.diagnostics())}`,
  );
}

async function assertText(
  browser: ChromeCdpSession,
  text: string,
): Promise<void> {
  const found = await browser.evaluate<boolean>(
    `(document.body?.innerText.toLocaleLowerCase().includes(${JSON.stringify(
      text.toLocaleLowerCase(),
    )}) ?? false)`,
  );
  if (!found) {
    throw new Error(`Browser text assertion failed: ${text}`);
  }
}

async function clickButton(
  browser: ChromeCdpSession,
  label: string,
): Promise<void> {
  const clicked = await browser.evaluate<boolean>(`(() => {
    const target = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === ${JSON.stringify(label)}
    );
    if (!(target instanceof HTMLButtonElement) || target.disabled) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) {
    throw new Error(`Browser button is unavailable: ${label}`);
  }
}

async function fill(
  browser: ChromeCdpSession,
  selector: string,
  value: string,
): Promise<void> {
  const changed = await browser.evaluate<boolean>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return false;
    }
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (!changed) {
    throw new Error(`Browser field is unavailable: ${selector}`);
  }
}

function parsePreflight(value: unknown): PreflightView {
  const record = asObject(value);
  const boundary = asObject(record.boundary);
  const dependencies = record.dependencies;
  if (
    record.contractVersion !== "connected-demo-preflight-v1" ||
    boundary.contractVersion !== "connected-demo-boundary-v1" ||
    boundary.destinationClass !== "staff-controlled-test" ||
    boundary.learnerClass !== "staff-controlled" ||
    boundary.sourceClass !== "human-approved-rights-cleared" ||
    typeof record.checkedAt !== "string" ||
    (record.status !== "ready" && record.status !== "unavailable") ||
    !Array.isArray(dependencies) ||
    dependencies.length !== FLOW_B_DEPENDENCIES.length
  ) {
    throw new Error("Connected Flow B preflight contract is invalid");
  }
  const parsed = dependencies.map((entry) => {
    const dependency = asObject(entry);
    if (
      !FLOW_B_DEPENDENCIES.includes(dependency.name as FlowBDependencyName) ||
      (dependency.code !== "available" && dependency.code !== "unavailable") ||
      typeof dependency.contractVersion !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(dependency.contractVersion)
    ) {
      throw new Error("Connected Flow B dependency contract is invalid");
    }
    return {
      code: dependency.code,
      contractVersion: dependency.contractVersion,
      name: dependency.name,
    } as PreflightView["dependencies"][number];
  });
  if (
    new Set(parsed.map((dependency) => dependency.name)).size !==
    FLOW_B_DEPENDENCIES.length
  ) {
    throw new Error("Connected Flow B dependency names are invalid");
  }
  return {
    boundary: {
      contractVersion: "connected-demo-boundary-v1",
      destinationClass: "staff-controlled-test",
      learnerClass: "staff-controlled",
      sourceClass: "human-approved-rights-cleared",
    },
    checkedAt: record.checkedAt,
    contractVersion: record.contractVersion,
    dependencies: parsed,
    status: record.status,
  };
}

function instrumentationSource(
  preflight: PreflightView,
  apiBaseUrl: URL,
): string {
  const serialized = JSON.stringify(preflight).replaceAll("<", "\\u003c");
  const apiOrigin = JSON.stringify(apiBaseUrl.origin);
  return `(() => {
    const template = ${serialized};
    const apiOrigin = ${apiOrigin};
    const rawFetch = globalThis.fetch.bind(globalThis);
    const state = {
      assessments: [],
      failures: [],
      lastRequests: new Map(),
      nextActions: [],
      requests: [],
      preflights: [],
      progress: [],
      replays: [],
      views: []
    };
    const route = (input) => {
      const value = input instanceof Request ? input.url : String(input);
      const url = new URL(value, location.href);
      return url.origin === apiOrigin ? url.pathname : "";
    };
    const capture = async (response, path) => {
      let body;
      try { body = await response.clone().json(); } catch { return; }
      if (path === "/v1/demo/preflight") state.preflights.push(body);
      else if (path.endsWith("/state")) state.views.push(body.view);
      else if (path.endsWith("/next")) state.nextActions.push(body.action);
      else if (path.endsWith("/answers/short-answer") || path.endsWith("/answers/replacement")) {
        state.assessments.push({ path, result: body.result });
      } else if (path.endsWith("/progress")) state.progress.push(body.progress);
    };
    globalThis.fetch = async (input, init) => {
      const path = route(input);
      if (path === "/v1/demo/preflight" && state.failures.length > 0) {
        const injectedUnavailable = state.failures.shift();
        const body = {
          ...template,
          checkedAt: new Date().toISOString(),
          dependencies: template.dependencies.map((dependency) => ({
            ...dependency,
            code: dependency.name === injectedUnavailable ? "unavailable" : "available"
          })),
          injectedUnavailable,
          status: "unavailable"
        };
        state.preflights.push(body);
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status: 503
        });
      }
      if (
        (path.endsWith("/answers/short-answer") || path.endsWith("/answers/replacement")) &&
        (init?.method ?? "GET").toUpperCase() === "POST"
      ) {
        state.lastRequests.set(path.endsWith("/answers/short-answer") ? "short-answer" : "replacement", {
          init: { ...init, headers: { ...(init?.headers ?? {}) } },
          input
        });
      }
      let response;
      try {
        response = await rawFetch(input, init);
        state.requests.push({
          method: (init?.method ?? "GET").toUpperCase(),
          path,
          status: response.status
        });
      } catch (error) {
        state.requests.push({
          error: error instanceof Error ? error.name : "fetch_error",
          method: (init?.method ?? "GET").toUpperCase(),
          path,
          status: 0
        });
        throw error;
      }
      void capture(response, path);
      return response;
    };
    globalThis.__refloFlowBAssertion = {
      diagnostics: () => state.requests.slice(-12),
      replay: async (kind) => {
        const request = state.lastRequests.get(kind);
        if (!request) throw new Error("replay request unavailable");
        const response = await rawFetch(request.input, request.init);
        const body = await response.json();
        const captured = { path: route(request.input), result: body.result };
        state.replays.push(captured);
        return captured;
      },
      setFailures: (failures) => {
        state.failures = Array.from(failures);
      },
      snapshot: () => ({
        assessments: state.assessments,
        nextActions: state.nextActions,
        preflights: state.preflights,
        progress: state.progress,
        replays: state.replays,
        views: state.views
      })
    };
  })();`;
}

function findView(
  views: readonly Record<string, unknown>[],
  state: string,
): Record<string, unknown> {
  const found = [...views].reverse().find((view) => view.state === state);
  if (found === undefined) {
    throw new Error(`Flow B browser state was not observed: ${state}`);
  }
  return found;
}

function findAssessment(
  assessments: readonly CapturedAssessment[],
  expected: ReturnType<typeof assessmentBand>,
  ordinal: number,
): CapturedAssessment {
  const found = assessments.filter(
    (assessment) =>
      assessment.path.endsWith("/answers/short-answer") &&
      assessmentBand(assessment.result) === expected,
  )[
    ordinal === 0
      ? 0
      : assessments.filter(
          (assessment) =>
            assessment.path.endsWith("/answers/short-answer") &&
            assessmentBand(assessment.result) === expected,
        ).length - 1
  ];
  if (found === undefined) {
    throw new Error(`Flow B assessment was not observed: ${expected}`);
  }
  return found;
}

function findReplay(
  replays: readonly CapturedAssessment[],
  index: number,
): CapturedAssessment {
  const replay = replays[index];
  if (replay === undefined) {
    throw new Error("Flow B replay evidence is missing");
  }
  return replay;
}

function findRetestQuestion(
  actions: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const action = [...actions]
    .reverse()
    .find((candidate) => candidate.kind === "retest");
  return objectField(action ?? {}, "question");
}

function assessmentBand(
  result: Record<string, unknown>,
): "correct" | "incorrect" | "partially_correct" {
  const evidence = result.evidence;
  if (!Array.isArray(evidence) || evidence.length < 1) {
    throw new Error("Flow B assessment evidence is missing");
  }
  const eligible = evidence
    .map(asObject)
    .filter((entry) => entry.eligibleForMastery === true);
  if (eligible.length < 1) {
    throw new Error("Flow B assessment evidence is ineligible");
  }
  const bands = eligible.map((entry) => entry.rubricBand);
  if (bands.every((band) => band === "correct")) {
    return "correct";
  }
  if (bands.some((band) => band === "partially_correct")) {
    return "partially_correct";
  }
  if (bands.every((band) => band === "incorrect")) {
    return "incorrect";
  }
  throw new Error("Flow B assessment band is invalid");
}

function eligibleConceptIds(result: Record<string, unknown>): string[] {
  const evidence = result.evidence;
  if (!Array.isArray(evidence)) {
    throw new Error("Flow B assessment evidence is missing");
  }
  const conceptIds = evidence
    .map(asObject)
    .filter((entry) => entry.eligibleForMastery === true)
    .map((entry) => stringField(entry, "conceptId"));
  if (conceptIds.length < 1) {
    throw new Error("Flow B assessment evidence is ineligible");
  }
  return conceptIds;
}

export function assertConnectedMasteryProof(input: {
  readonly concepts: {
    readonly finalView: string;
    readonly initialEvidence: readonly string[];
    readonly initialQuestion: string;
    readonly initialView: string;
    readonly lessonView: string;
    readonly loopResult: string;
    readonly retestEvidence: readonly string[];
    readonly retestQuestion: string;
  };
  readonly finalMastery: string;
  readonly lessonBaselineMastery: string;
  readonly loopEvidenceAttemptId: string;
  readonly loopFinalMastery: string;
  readonly loopInitialMastery: string;
  readonly masteryDelta: string;
  readonly retestAttemptId: string;
}): void {
  const conceptIds = [
    input.concepts.finalView,
    ...input.concepts.initialEvidence,
    input.concepts.initialQuestion,
    input.concepts.initialView,
    input.concepts.lessonView,
    input.concepts.loopResult,
    ...input.concepts.retestEvidence,
    input.concepts.retestQuestion,
  ];
  if (
    input.concepts.initialEvidence.length < 1 ||
    input.concepts.retestEvidence.length < 1 ||
    new Set(conceptIds).size !== 1 ||
    input.loopEvidenceAttemptId !== input.retestAttemptId ||
    input.loopInitialMastery !== input.lessonBaselineMastery ||
    input.loopFinalMastery !== input.finalMastery ||
    input.masteryDelta !==
      exactMasteryDelta(input.loopFinalMastery, input.loopInitialMastery)
  ) {
    throw new Error("Flow B mastery evidence provenance assertion failed");
  }
}

function assertedLoginUrl(value: string, appBaseUrl: URL): URL {
  const loginUrl = new URL(value);
  if (
    loginUrl.origin !== appBaseUrl.origin ||
    loginUrl.pathname !== "/auth/callback" ||
    loginUrl.searchParams.get("token") === null ||
    [...loginUrl.searchParams.keys()].some((key) => key !== "token")
  ) {
    throw new Error("Development authentication returned an unsafe URL");
  }
  return loginUrl;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Flow B browser response is malformed");
  }
  return value as Record<string, unknown>;
}

function objectField(
  value: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return asObject(value[name]);
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length < 1 || field.length > 512) {
    throw new Error(`Flow B browser field is invalid: ${name}`);
  }
  return field;
}

function stringArrayField(
  value: Record<string, unknown>,
  name: string,
): string[] {
  const field = value[name];
  if (
    !Array.isArray(field) ||
    field.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Flow B browser string array is invalid: ${name}`);
  }
  return field as string[];
}

function integerField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (!Number.isSafeInteger(field)) {
    throw new Error(`Flow B browser integer is invalid: ${name}`);
  }
  return field as number;
}

function ordinalField(value: Record<string, unknown>, name: string): 1 | 2 {
  const field = integerField(value, name);
  if (field !== 1 && field !== 2) {
    throw new Error(`Flow B browser ordinal is invalid: ${name}`);
  }
  return field;
}

function exactDecimal(value: Record<string, unknown>, name: string): string {
  const field = stringField(value, name);
  if (!/^(?:0|1)\.\d{5}$/.test(field)) {
    throw new Error(`Flow B browser decimal is invalid: ${name}`);
  }
  return field;
}

function signedDecimal(value: Record<string, unknown>, name: string): string {
  const field = stringField(value, name);
  if (!/^-?(?:0|1)\.\d{5}$/.test(field)) {
    throw new Error(`Flow B browser signed decimal is invalid: ${name}`);
  }
  return field;
}

function literalField<const Value extends string>(
  source: Record<string, unknown>,
  name: string,
  expected: Value,
): Value {
  if (source[name] !== expected) {
    throw new Error(`Flow B browser contract version is invalid: ${name}`);
  }
  return expected;
}

function exactPercentLabel(value: string): string {
  const units = unsignedMasteryUnits(value);
  return `${units / 1_000n}.${String(units % 1_000n).padStart(3, "0")}%`;
}

function masteryDeltaLabel(value: string): string {
  const units = signedMasteryUnits(value);
  const sign = units >= 0n ? "+" : "-";
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / 1_000n}.${String(absolute % 1_000n).padStart(
    3,
    "0",
  )} pts`;
}

function unsignedMasteryUnits(value: string): bigint {
  if (!/^(?:0|1)\.\d{5}$/.test(value)) {
    throw new Error("Flow B browser mastery is invalid");
  }
  const [whole, fraction] = value.split(".");
  return BigInt(whole!) * 100_000n + BigInt(fraction!);
}

function signedMasteryUnits(value: string): bigint {
  const sign = value.startsWith("-") ? -1n : 1n;
  return sign * unsignedMasteryUnits(value.replace(/^-/, ""));
}

function failBoundary(): never {
  throw new Error("Connected Flow B safety boundary is unavailable");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
