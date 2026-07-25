import { createHash } from "node:crypto";
import path from "node:path";

export const FLOW_B_ASSERTION_VERSION = "flow-b-browser-assertion-v1" as const;
export const FLOW_B_RUN_RECORD_VERSION = "flow-b-run-record-v1" as const;
export const FLOW_B_CORE_TRACE_FIELDS = [
  "attemptCount",
  "durationMs",
  "modelTask",
  "operation",
  "outcome",
  "routePolicyVersion",
  "stage",
  "validationStatus",
] as const;
export const FLOW_B_ALLOWED_TRACE_FIELDS = [
  ...FLOW_B_CORE_TRACE_FIELDS,
  "component",
  "demoRunId",
  "eventId",
  "model",
  "modelVersion",
  "promptId",
  "promptVersion",
  "schemaVersion",
] as const;

export type FlowBTraceField = (typeof FLOW_B_ALLOWED_TRACE_FIELDS)[number];

export const FLOW_B_DEPENDENCIES = [
  "delivery",
  "model",
  "postgres",
  "storage",
  "vector",
] as const;

export type FlowBDependencyName = (typeof FLOW_B_DEPENDENCIES)[number];

export interface FlowBAssertionConfig {
  readonly apiBaseUrl: URL;
  readonly appBaseUrl: URL;
  readonly auth:
    | {
        readonly accessKey: string;
        readonly email: string;
        readonly mode: "local-inbox";
      }
    | {
        readonly loginUrl: URL;
        readonly mode: "login-url";
      };
  readonly browserApiBaseUrl: URL;
  readonly browserExecutable: string;
  readonly delivery: {
    readonly telegramDestination: string;
    readonly telegramWebhookSecret: string;
  };
  readonly initialResponse: string;
  readonly mode: "authorized-connected" | "development-connected";
  readonly retestResponse: string;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly traceProbeUrl: URL;
}

export interface FlowBRunRecord {
  readonly assertionVersion: typeof FLOW_B_ASSERTION_VERSION;
  readonly completedAt: string;
  readonly dependencyPreflight: {
    readonly attempts: readonly {
      readonly injectedUnavailable: FlowBDependencyName | null;
      readonly sequence: number;
      readonly status: "ready" | "unavailable";
    }[];
    readonly contractVersion: string;
    readonly versions: Readonly<Record<FlowBDependencyName, string>>;
  };
  readonly durationMs: number;
  readonly delivery: {
    readonly attemptDigest: string;
    readonly deliveryDigest: string;
    readonly dispatchCreated: true;
    readonly dispatchReplayed: true;
    readonly webhookCreated: true;
    readonly webhookReplayed: true;
  };
  readonly evidence: {
    readonly finalMastery: string;
    readonly initialAttemptDigest: string;
    readonly initialEligibleAttemptCount: number;
    readonly initialFailureBand: "incorrect" | "partially_correct";
    readonly initialMastery: string;
    readonly lessonBaselineMastery: string;
    readonly lessonExposureMastery: string;
    readonly masteryDelta: string;
    readonly retestAttemptDigest: string;
    readonly retestBand: "correct";
  };
  readonly honestBoundary: {
    readonly externalDestinationUsed: false;
    readonly externalLearnerUsed: false;
    readonly repeatedReliabilityClaimed: false;
    readonly rightsClearedSeedRequired: true;
  };
  readonly lesson: {
    readonly differentStrategy: true;
    readonly generationVersion: "reteach-generation-v1";
    readonly replacementOrdinal: 1 | 2;
    readonly semanticSimilarity: string;
    readonly sourceSpanCount: number;
    readonly strategyDigest: string;
  };
  readonly mode: FlowBAssertionConfig["mode"];
  readonly recordDigest: string;
  readonly recordVersion: typeof FLOW_B_RUN_RECORD_VERSION;
  readonly replay: {
    readonly initialAttemptReplayed: true;
    readonly retestAttemptReplayed: true;
  };
  readonly runId: string;
  readonly startedAt: string;
  readonly targetOriginDigest: string;
  readonly trace: {
    readonly allowlistValidated: true;
    readonly coreFieldCoverage: readonly [
      "attemptCount",
      "durationMs",
      "modelTask",
      "operation",
      "outcome",
      "routePolicyVersion",
      "stage",
      "validationStatus",
    ];
    readonly eventCount: number;
    readonly observedFieldSet: readonly FlowBTraceField[];
    readonly schemaVersion: "demo-operational-trace-v1";
  };
  readonly ui: {
    readonly exactDeltaDisplayedInKnowledgeMap: true;
    readonly exactDeltaDisplayedInSummary: true;
    readonly explicitFailureStates: readonly ["model", "storage", "delivery"];
    readonly noSuccessRecordedCopyDisplayed: true;
    readonly recoveryAttempts: 3;
  };
  readonly versions: {
    readonly gradingPolicy: "grading-policy-v1";
    readonly knowledgeAlgorithm: "knowledge-model-v1";
    readonly studyView: "connected-study-view-v1";
  };
}

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|1)\.\d{5}$/;
const RUN_ID = /^demo-[a-f0-9]{32}$/;
const FORBIDDEN_KEY =
  /(^|_)(answer|contact|credential|email|filename|learner|passage|question|secret|token|url)($|_)/i;
const EMAIL_LIKE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;

export function readFlowBAssertionConfig(
  input: NodeJS.ProcessEnv,
): FlowBAssertionConfig {
  const appBaseUrl = safeBaseUrl(required(input, "REFLO_FLOW_B_APP_BASE_URL"));
  const apiBaseUrl = safeBaseUrl(required(input, "REFLO_FLOW_B_API_BASE_URL"));
  const browserApiBaseUrl = safeBaseUrl(
    input.REFLO_FLOW_B_BROWSER_API_BASE_URL ?? apiBaseUrl.toString(),
  );
  const traceProbeUrl = safeBaseUrl(
    required(input, "REFLO_FLOW_B_TRACE_PROBE_URL"),
  );
  const browserExecutable = required(input, "REFLO_FLOW_B_BROWSER_EXECUTABLE");
  if (!path.isAbsolute(browserExecutable)) {
    throw new Error("REFLO_FLOW_B_BROWSER_EXECUTABLE must be absolute");
  }
  const runId = required(input, "REFLO_FLOW_B_RUN_ID");
  if (!RUN_ID.test(runId)) {
    throw new Error("REFLO_FLOW_B_RUN_ID is invalid");
  }
  const mode = required(input, "REFLO_FLOW_B_MODE");
  if (mode !== "authorized-connected" && mode !== "development-connected") {
    throw new Error("REFLO_FLOW_B_MODE is invalid");
  }
  if (
    mode === "development-connected" &&
    (!isLoopback(appBaseUrl) ||
      !isLoopback(apiBaseUrl) ||
      !isLoopback(browserApiBaseUrl) ||
      !isLoopback(traceProbeUrl))
  ) {
    throw new Error("Development Flow B targets must use loopback");
  }
  const timeoutMs = Number(input.REFLO_FLOW_B_TIMEOUT_MS ?? "45000");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 5_000 ||
    timeoutMs > 180_000
  ) {
    throw new Error("REFLO_FLOW_B_TIMEOUT_MS is invalid");
  }
  const authMode = required(input, "REFLO_FLOW_B_AUTH_MODE");
  const auth =
    authMode === "local-inbox"
      ? {
          accessKey: boundedSecret(
            required(input, "REFLO_FLOW_B_AUTH_INBOX_ACCESS_KEY"),
          ),
          email: staffEmail(required(input, "REFLO_FLOW_B_STAFF_EMAIL")),
          mode: "local-inbox" as const,
        }
      : authMode === "login-url"
        ? {
            loginUrl: safeLoginUrl(
              required(input, "REFLO_FLOW_B_LOGIN_URL"),
              appBaseUrl,
            ),
            mode: "login-url" as const,
          }
        : null;
  if (auth === null) {
    throw new Error("REFLO_FLOW_B_AUTH_MODE is invalid");
  }
  return {
    apiBaseUrl,
    appBaseUrl,
    auth,
    browserApiBaseUrl,
    browserExecutable,
    delivery: {
      telegramDestination: numericIdentity(
        required(input, "REFLO_FLOW_B_TELEGRAM_DESTINATION"),
      ),
      telegramWebhookSecret: boundedSecret(
        required(input, "REFLO_FLOW_B_TELEGRAM_WEBHOOK_SECRET"),
      ),
    },
    initialResponse: boundedResponse(
      required(input, "REFLO_FLOW_B_INITIAL_RESPONSE"),
    ),
    mode,
    retestResponse: boundedResponse(
      required(input, "REFLO_FLOW_B_RETEST_RESPONSE"),
    ),
    runId,
    timeoutMs,
    traceProbeUrl,
  };
}

export function finalizeFlowBRunRecord(
  unsigned: Omit<FlowBRunRecord, "recordDigest">,
): FlowBRunRecord {
  assertSafeValue(unsigned);
  const record: FlowBRunRecord = {
    ...unsigned,
    recordDigest: digest(canonicalJson(unsigned)),
  };
  assertFlowBRunRecord(record);
  return record;
}

export function assertFlowBRunRecord(record: FlowBRunRecord): FlowBRunRecord {
  const { recordDigest, ...unsigned } = record;
  assertSafeValue(unsigned);
  const startedAt = Date.parse(record.startedAt);
  const completedAt = Date.parse(record.completedAt);
  const expectedDependencies = [...FLOW_B_DEPENDENCIES].sort();
  const observedDependencies = Object.keys(
    record.dependencyPreflight.versions,
  ).sort();
  const expectedPreflightAttempts = [
    {
      injectedUnavailable: "model",
      sequence: 1,
      status: "unavailable",
    },
    {
      injectedUnavailable: "storage",
      sequence: 2,
      status: "unavailable",
    },
    {
      injectedUnavailable: "delivery",
      sequence: 3,
      status: "unavailable",
    },
    { injectedUnavailable: null, sequence: 4, status: "ready" },
  ];
  const observedTraceFields = [...record.trace.observedFieldSet];
  if (
    record.recordVersion !== FLOW_B_RUN_RECORD_VERSION ||
    record.assertionVersion !== FLOW_B_ASSERTION_VERSION ||
    recordDigest !== digest(canonicalJson(unsigned)) ||
    !DIGEST.test(recordDigest) ||
    !DIGEST.test(record.targetOriginDigest) ||
    !DIGEST.test(record.delivery.attemptDigest) ||
    !DIGEST.test(record.delivery.deliveryDigest) ||
    !DIGEST.test(record.evidence.initialAttemptDigest) ||
    !DIGEST.test(record.evidence.retestAttemptDigest) ||
    !DIGEST.test(record.lesson.strategyDigest) ||
    !RUN_ID.test(record.runId) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt ||
    record.durationMs !== completedAt - startedAt ||
    record.durationMs < 0 ||
    record.durationMs > 900_000 ||
    record.dependencyPreflight.contractVersion !==
      "connected-demo-preflight-v1" ||
    canonicalJson(record.dependencyPreflight.attempts) !==
      canonicalJson(expectedPreflightAttempts) ||
    record.delivery.dispatchCreated !== true ||
    record.delivery.dispatchReplayed !== true ||
    record.delivery.webhookCreated !== true ||
    record.delivery.webhookReplayed !== true ||
    (record.evidence.initialFailureBand !== "incorrect" &&
      record.evidence.initialFailureBand !== "partially_correct") ||
    record.evidence.retestBand !== "correct" ||
    record.honestBoundary.externalDestinationUsed !== false ||
    record.honestBoundary.externalLearnerUsed !== false ||
    record.honestBoundary.repeatedReliabilityClaimed !== false ||
    record.honestBoundary.rightsClearedSeedRequired !== true ||
    record.lesson.differentStrategy !== true ||
    record.lesson.generationVersion !== "reteach-generation-v1" ||
    record.replay.initialAttemptReplayed !== true ||
    record.replay.retestAttemptReplayed !== true ||
    record.trace.allowlistValidated !== true ||
    record.trace.schemaVersion !== "demo-operational-trace-v1" ||
    canonicalJson(record.trace.coreFieldCoverage) !==
      canonicalJson(FLOW_B_CORE_TRACE_FIELDS) ||
    record.ui.exactDeltaDisplayedInKnowledgeMap !== true ||
    record.ui.exactDeltaDisplayedInSummary !== true ||
    canonicalJson(record.ui.explicitFailureStates) !==
      canonicalJson(["model", "storage", "delivery"]) ||
    record.ui.noSuccessRecordedCopyDisplayed !== true ||
    record.ui.recoveryAttempts !== 3 ||
    record.versions.gradingPolicy !== "grading-policy-v1" ||
    record.versions.knowledgeAlgorithm !== "knowledge-model-v1" ||
    record.versions.studyView !== "connected-study-view-v1" ||
    canonicalJson(expectedDependencies) !== canonicalJson(observedDependencies)
  ) {
    throw new Error("flow_b_run_record_invalid");
  }
  for (const version of Object.values(record.dependencyPreflight.versions)) {
    if (!VERSION.test(version)) {
      throw new Error("flow_b_dependency_version_invalid");
    }
  }
  for (const value of [
    record.evidence.initialMastery,
    record.evidence.lessonBaselineMastery,
    record.evidence.lessonExposureMastery,
    record.evidence.finalMastery,
  ]) {
    if (!DECIMAL.test(value)) {
      throw new Error("flow_b_mastery_invalid");
    }
  }
  if (
    !/^-?(?:0|1)\.\d{5}$/.test(record.evidence.masteryDelta) ||
    !/^(?:0|1)\.\d{5}$/.test(record.lesson.semanticSimilarity) ||
    Number(record.lesson.semanticSimilarity) >= 0.85 ||
    record.evidence.initialMastery !== record.evidence.lessonBaselineMastery ||
    record.evidence.lessonBaselineMastery !==
      record.evidence.lessonExposureMastery ||
    record.evidence.masteryDelta !==
      exactMasteryDelta(
        record.evidence.finalMastery,
        record.evidence.initialMastery,
      ) ||
    record.evidence.initialEligibleAttemptCount < 2 ||
    record.evidence.initialEligibleAttemptCount > 100 ||
    record.lesson.sourceSpanCount < 1 ||
    record.lesson.sourceSpanCount > 100 ||
    !Number.isSafeInteger(record.trace.eventCount) ||
    record.trace.eventCount < 4 ||
    record.trace.eventCount > 100 ||
    observedTraceFields.length < FLOW_B_CORE_TRACE_FIELDS.length ||
    new Set(observedTraceFields).size !== observedTraceFields.length ||
    observedTraceFields.some(
      (field) => !FLOW_B_ALLOWED_TRACE_FIELDS.includes(field),
    ) ||
    FLOW_B_CORE_TRACE_FIELDS.some(
      (field) => !observedTraceFields.includes(field),
    ) ||
    record.dependencyPreflight.attempts.length !== 4
  ) {
    throw new Error("flow_b_assertion_invariant_failed");
  }
  return record;
}

export function exactMasteryDelta(
  finalMastery: string,
  initialMastery: string,
): string {
  const delta = masteryUnits(finalMastery) - masteryUnits(initialMastery);
  const sign = delta < 0n ? "-" : "";
  const absolute = delta < 0n ? -delta : delta;
  return `${sign}${absolute / 100_000n}.${String(absolute % 100_000n).padStart(
    5,
    "0",
  )}`;
}

export function valueDigest(value: string): string {
  return digest(value);
}

function safeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Flow B base URL is invalid");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Flow B base URL is unsafe");
  }
  url.pathname = url.pathname.replace(/\/?$/, "/");
  return url;
}

function safeLoginUrl(value: string, appBaseUrl: URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REFLO_FLOW_B_LOGIN_URL is invalid");
  }
  if (
    url.origin !== appBaseUrl.origin ||
    url.pathname !== "/auth/callback" ||
    url.searchParams.get("token") === null ||
    [...url.searchParams.keys()].some((key) => key !== "token") ||
    url.hash !== ""
  ) {
    throw new Error("REFLO_FLOW_B_LOGIN_URL is unsafe");
  }
  return url;
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]"
  );
}

function staffEmail(value: string): string {
  if (value.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new Error("REFLO_FLOW_B_STAFF_EMAIL is invalid");
  }
  return value;
}

function boundedSecret(value: string): string {
  if (value.length < 32 || value.length > 256 || /\s/.test(value)) {
    throw new Error("REFLO_FLOW_B_AUTH_INBOX_ACCESS_KEY is invalid");
  }
  return value;
}

function numericIdentity(value: string): string {
  if (!/^\d{1,32}$/.test(value)) {
    throw new Error("REFLO_FLOW_B_TELEGRAM_DESTINATION is invalid");
  }
  return value;
}

function boundedResponse(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 2_000) {
    throw new Error("Flow B configured response is invalid");
  }
  return trimmed;
}

function required(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertSafeValue(value: unknown, key = "root"): void {
  if (FORBIDDEN_KEY.test(key)) {
    throw new Error(`flow_b_run_record_forbidden_field:${key}`);
  }
  if (typeof value === "string") {
    if (value.length > 256 || EMAIL_LIKE.test(value)) {
      throw new Error(`flow_b_run_record_unsafe_value:${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertSafeValue(entry, key);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      assertSafeValue(childValue, childKey);
    }
  }
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

function masteryUnits(value: string): bigint {
  if (!DECIMAL.test(value)) {
    throw new Error("flow_b_mastery_invalid");
  }
  const [whole, fraction] = value.split(".");
  return BigInt(whole!) * 100_000n + BigInt(fraction!);
}
