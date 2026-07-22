import type {
  ModelTaskId,
  ModelTaskInput,
  ModelTaskResult,
} from "./contracts.js";
import { isModelTaskId } from "./contracts.js";
import type {
  AdapterInvocation,
  AdapterResponse,
  ModelAdapterRegistry,
  ModelCapability,
} from "./ports.js";
import { ModelAdapterError } from "./ports.js";
import {
  ROUTE_POLICY_V2,
  ROUTE_POLICY_VERSION,
  type RouteDefinition,
} from "./policy.js";
import {
  buildPromptBundle,
  isPromptedTask,
  type PromptBundle,
} from "./prompts.js";
import {
  assertSafeTraceEnvelope,
  type ModelAttemptTrace,
  type ModelLogicalCallTrace,
  type ModelTraceSink,
} from "./trace.js";
import { RESULT_VALIDATORS } from "./validation.js";

export interface ModelCallProvenance {
  readonly adapterVersion: string;
  readonly effectiveModel: string;
  readonly effectiveModelVersion: string;
  readonly generationParametersVersion?: string;
  readonly inputSchemaVersion: string;
  readonly promptDigest?: string;
  readonly promptId?: string;
  readonly promptVersion?: string;
  readonly requestedSelector: string;
  readonly resultSchemaVersion: string;
  readonly routePolicyVersion: typeof ROUTE_POLICY_VERSION;
  readonly task: ModelTaskId;
  readonly validationOutcome: "passed";
}

export interface RoutedModelResult<Task extends ModelTaskId> {
  readonly provenance: ModelCallProvenance;
  readonly value: ModelTaskResult<Task>;
}

export interface ModelRouterOptions {
  readonly adapters: ModelAdapterRegistry;
  readonly callId?: () => string;
  readonly isFeatureEnabled?: (
    key: "p1.media.video",
    context: {
      readonly videoOperationKind: "chapter_explainer" | "full_course";
    },
  ) => Promise<boolean> | boolean;
  readonly now?: () => number;
  readonly traceSink: ModelTraceSink;
}

export interface ExecuteOptions {
  readonly deadlineMs: number;
  readonly videoOperationKind?: "chapter_explainer" | "full_course";
}

export type RouterErrorCode =
  | "adapter_unavailable"
  | "deadline_exceeded"
  | "feature_disabled"
  | "invalid_adapter_configuration"
  | "invalid_result"
  | "provider_failure"
  | "trace_failure"
  | "unknown_task";

export class ModelRouterError extends Error {
  readonly code: RouterErrorCode;
  readonly providerFailure?: {
    readonly safeCode: string;
    readonly submissionState: "accepted" | "not_accepted" | "unknown";
    readonly transient: boolean;
  };

  constructor(
    code: RouterErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly providerFailure?: ModelRouterError["providerFailure"];
    },
  ) {
    super(message, options);
    this.name = "ModelRouterError";
    this.code = code;
    this.providerFailure = options?.providerFailure;
  }
}

export function createModelRouter(options: ModelRouterOptions) {
  const now = options.now ?? Date.now;
  const callId = options.callId ?? defaultCallId;

  return Object.freeze({
    execute,
  });

  async function execute<Task extends ModelTaskId>(
    task: Task,
    input: ModelTaskInput<Task>,
    executeOptions: ExecuteOptions,
  ): Promise<RoutedModelResult<Task>> {
    if (!isModelTaskId(task)) {
      throw new ModelRouterError("unknown_task", "unknown model task");
    }
    if (
      !Number.isFinite(executeOptions.deadlineMs) ||
      executeOptions.deadlineMs <= 0
    ) {
      throw new ModelRouterError(
        "deadline_exceeded",
        "model call deadline must be a positive duration",
      );
    }

    const logicalStartedAt = now();
    const deadlineAt = logicalStartedAt + executeOptions.deadlineMs;
    const route: RouteDefinition = ROUTE_POLICY_V2[task];
    const featureFlag = route.featureFlag;
    if (featureFlag !== undefined) {
      const operationKind = executeOptions.videoOperationKind;
      const isFeatureEnabled = options.isFeatureEnabled;
      let enabled = false;
      try {
        enabled =
          operationKind !== undefined &&
          isFeatureEnabled !== undefined &&
          (await withDeadline(
            Promise.resolve().then(() =>
              isFeatureEnabled(featureFlag, {
                videoOperationKind: operationKind,
              }),
            ),
            deadlineAt,
            now,
          ));
      } catch (error) {
        if (
          error instanceof ModelRouterError &&
          error.code === "deadline_exceeded"
        ) {
          throw error;
        }
        enabled = false;
      }
      if (!enabled) {
        throw new ModelRouterError(
          "feature_disabled",
          "the requested model capability is unavailable",
        );
      }
    }

    const prompt = buildPrompt(task, input);
    verifyPromptRoute(route, prompt);
    const attempts: ModelAttemptTrace[] = [];
    let failure: ModelRouterError | undefined;
    const selectors = [
      route.requestedSelector,
      ...(route.fallback === null ? [] : [route.fallback]),
    ];
    for (const [selectorIndex, selector] of selectors.entries()) {
      const adapter = selectAdapter(
        options.adapters,
        route.capability,
        selector,
      );
      verifyAdapter(adapter.descriptor, route.capability, selector);
      const maximumAttempts = Math.min(
        route.maxImmediateAttempts,
        adapter.descriptor.maxImmediateAttempts,
      );
      let fallbackEligible = false;

      for (
        let localAttempt = 1;
        localAttempt <= maximumAttempts;
        localAttempt += 1
      ) {
        const attempt = attempts.length + 1;
        const attemptStartedAt = now();
        if (attemptStartedAt >= deadlineAt) {
          failure = new ModelRouterError(
            "deadline_exceeded",
            "model call deadline elapsed before an eligible retry",
          );
          break;
        }

        const abortController = new AbortController();
        try {
          const response = await withDeadline(
            invokeAdapter(adapter, route.capability, {
              input,
              ...(prompt === undefined ? {} : { prompt }),
              signal: abortController.signal,
              task,
            }),
            deadlineAt,
            now,
            () => abortController.abort(),
          );
          const finishedAt = now();
          if (finishedAt > deadlineAt) {
            attempts.push(
              attemptTrace(
                adapter.descriptor,
                attempt,
                attemptStartedAt,
                finishedAt,
                "deadline_exceeded",
                "not_run",
                response,
              ),
            );
            failure = new ModelRouterError(
              "deadline_exceeded",
              "model adapter returned after the caller deadline",
            );
            break;
          }

          if (!RESULT_VALIDATORS[task](response.value, input)) {
            attempts.push(
              attemptTrace(
                adapter.descriptor,
                attempt,
                attemptStartedAt,
                finishedAt,
                "validation_error",
                "failed",
                response,
              ),
            );
            failure = new ModelRouterError(
              "invalid_result",
              "model result failed its route schema",
            );
            break;
          }

          attempts.push(
            attemptTrace(
              adapter.descriptor,
              attempt,
              attemptStartedAt,
              finishedAt,
              "success",
              "passed",
              response,
            ),
          );
          const traceAbortController = new AbortController();
          await withDeadline(
            recordTrace(
              options.traceSink,
              traceEnvelope({
                attempts,
                callId: callId(),
                finishedAt,
                logicalStartedAt,
                outcome: "success",
                prompt,
                task,
              }),
              traceAbortController.signal,
            ),
            deadlineAt,
            now,
            () => traceAbortController.abort(),
          );
          return {
            provenance: {
              adapterVersion: adapter.descriptor.adapterVersion,
              effectiveModel: adapter.descriptor.effectiveModel,
              effectiveModelVersion: adapter.descriptor.effectiveModelVersion,
              ...(prompt === undefined
                ? {}
                : {
                    generationParametersVersion:
                      prompt.generationParametersVersion,
                    promptDigest: prompt.digest,
                    promptId: prompt.id,
                    promptVersion: prompt.version,
                  }),
              inputSchemaVersion: route.inputSchemaVersion,
              requestedSelector: adapter.descriptor.selector,
              resultSchemaVersion: route.resultSchemaVersion,
              routePolicyVersion: ROUTE_POLICY_VERSION,
              task,
              validationOutcome: "passed",
            },
            value: response.value as ModelTaskResult<Task>,
          };
        } catch (error) {
          if (attempts.at(-1)?.outcome === "success") {
            throw new ModelRouterError(
              "trace_failure",
              "model result succeeded but its logical trace was not accepted",
              { cause: error },
            );
          }
          if (
            error instanceof ModelRouterError &&
            error.code === "deadline_exceeded"
          ) {
            const finishedAt = now();
            attempts.push({
              adapterVersion: adapter.descriptor.adapterVersion,
              attempt,
              durationMs: Math.max(0, finishedAt - attemptStartedAt),
              effectiveModel: adapter.descriptor.effectiveModel,
              effectiveModelVersion: adapter.descriptor.effectiveModelVersion,
              outcome: "deadline_exceeded",
              requestedSelector: adapter.descriptor.selector,
              retryReason: "timeout",
              startedAt: toIso(attemptStartedAt),
              validationStatus: "not_run",
            });
            failure = error;
            break;
          }
          if (!(error instanceof ModelAdapterError)) {
            throw error;
          }
          const finishedAt = now();
          attempts.push({
            adapterVersion: adapter.descriptor.adapterVersion,
            attempt,
            durationMs: Math.max(0, finishedAt - attemptStartedAt),
            effectiveModel: adapter.descriptor.effectiveModel,
            effectiveModelVersion: adapter.descriptor.effectiveModelVersion,
            outcome: error.transient ? "transient_error" : "permanent_error",
            requestedSelector: adapter.descriptor.selector,
            retryReason: error.safeCode,
            startedAt: toIso(attemptStartedAt),
            validationStatus: "not_run",
          });
          failure = new ModelRouterError(
            "provider_failure",
            "model provider request failed",
            {
              cause: error,
              providerFailure: {
                safeCode: error.safeCode,
                submissionState: error.submissionState,
                transient: error.transient,
              },
            },
          );
          const retryEligible =
            error.transient &&
            localAttempt < maximumAttempts &&
            finishedAt < deadlineAt;
          if (retryEligible) {
            continue;
          }
          fallbackEligible =
            selectorIndex === 0 &&
            route.fallback !== null &&
            canUseTtsFallback(task, error) &&
            finishedAt < deadlineAt;
          break;
        }
      }
      if (!fallbackEligible) {
        break;
      }
    }

    const finishedAt = now();
    const traceAbortController = new AbortController();
    await withDeadline(
      recordTrace(
        options.traceSink,
        traceEnvelope({
          attempts,
          callId: callId(),
          finishedAt,
          logicalStartedAt,
          outcome: "failure",
          prompt,
          task,
        }),
        traceAbortController.signal,
      ),
      deadlineAt,
      now,
      () => traceAbortController.abort(),
    );
    throw (
      failure ??
      new ModelRouterError(
        "provider_failure",
        "model provider request failed without an eligible attempt",
      )
    );
  }
}

function canUseTtsFallback(
  task: ModelTaskId,
  error: ModelAdapterError,
): boolean {
  return (
    task === "media.tts.v1" &&
    error.transient &&
    error.submissionState === "not_accepted" &&
    [
      "capacity_unavailable",
      "quota_exhausted",
      "rate_limited",
      "unavailable",
    ].includes(error.safeCode)
  );
}

type SelectedAdapter = ReturnType<typeof selectAdapter>;

function selectAdapter(
  registry: ModelAdapterRegistry,
  capability: ModelCapability,
  selector: string,
) {
  const adapter =
    capability === "grounded_generation"
      ? registry.groundedGeneration[selector]
      : registry[capability][selector];
  if (adapter === undefined) {
    throw new ModelRouterError(
      "adapter_unavailable",
      "no approved adapter is configured for this route",
    );
  }
  return adapter;
}

function verifyAdapter(
  descriptor: SelectedAdapter["descriptor"],
  capability: ModelCapability,
  selector: string,
): void {
  const attemptsValid =
    Number.isInteger(descriptor.maxImmediateAttempts) &&
    descriptor.maxImmediateAttempts >= 1 &&
    descriptor.maxImmediateAttempts <= 2;
  const mediaRetryValid =
    (capability !== "speech" && capability !== "video") ||
    descriptor.maxImmediateAttempts === 1 ||
    descriptor.mediaSubmissionIdempotent;
  if (
    descriptor.capability !== capability ||
    descriptor.selector !== selector ||
    descriptor.adapterVersion.length === 0 ||
    descriptor.effectiveModel.length === 0 ||
    descriptor.effectiveModelVersion.length === 0 ||
    !attemptsValid ||
    !mediaRetryValid ||
    (descriptor.mutableAlias && !descriptor.driftCanaryPassed)
  ) {
    throw new ModelRouterError(
      "invalid_adapter_configuration",
      "the configured adapter is not eligible for this route",
    );
  }
}

function buildPrompt<Task extends ModelTaskId>(
  task: Task,
  input: ModelTaskInput<Task>,
): PromptBundle | undefined {
  if (!isPromptedTask(task)) {
    return undefined;
  }
  return buildPromptBundle(task, input as never);
}

function verifyPromptRoute(
  route: RouteDefinition,
  prompt: PromptBundle | undefined,
): void {
  if (
    (route.promptId === undefined) !== (prompt === undefined) ||
    (prompt !== undefined &&
      (prompt.id !== route.promptId || prompt.version !== route.promptVersion))
  ) {
    throw new ModelRouterError(
      "invalid_adapter_configuration",
      "the route prompt is missing or does not match policy",
    );
  }
}

async function invokeAdapter(
  adapter: SelectedAdapter,
  capability: ModelCapability,
  invocation: AdapterInvocation,
): Promise<AdapterResponse> {
  switch (capability) {
    case "dialogue":
      return (
        adapter as ModelAdapterRegistry["dialogue"][string]
      ).answerGrounded(invocation);
    case "embedding":
      return (adapter as ModelAdapterRegistry["embedding"][string]).embed(
        invocation,
      );
    case "grading":
      return (adapter as ModelAdapterRegistry["grading"][string]).grade(
        invocation,
      );
    case "grounded_generation":
      return (
        adapter as ModelAdapterRegistry["groundedGeneration"][string]
      ).generateGrounded(invocation);
    case "speech":
      return (adapter as ModelAdapterRegistry["speech"][string]).synthesize(
        invocation,
      );
    case "structured":
      return (
        adapter as ModelAdapterRegistry["structured"][string]
      ).executeStructured(invocation);
    case "video":
      return (adapter as ModelAdapterRegistry["video"][string]).generateVideo(
        invocation,
      );
  }
}

function attemptTrace(
  descriptor: SelectedAdapter["descriptor"],
  attempt: number,
  startedAt: number,
  finishedAt: number,
  outcome: ModelAttemptTrace["outcome"],
  validationStatus: ModelAttemptTrace["validationStatus"],
  response: AdapterResponse,
): ModelAttemptTrace {
  return {
    adapterVersion: descriptor.adapterVersion,
    attempt,
    durationMs: Math.max(0, finishedAt - startedAt),
    effectiveModel: descriptor.effectiveModel,
    effectiveModelVersion: descriptor.effectiveModelVersion,
    outcome,
    requestedSelector: descriptor.selector,
    startedAt: toIso(startedAt),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    validationStatus,
  };
}

function traceEnvelope(options: {
  readonly attempts: readonly ModelAttemptTrace[];
  readonly callId: string;
  readonly finishedAt: number;
  readonly logicalStartedAt: number;
  readonly outcome: "failure" | "success";
  readonly prompt: PromptBundle | undefined;
  readonly task: ModelTaskId;
}): ModelLogicalCallTrace {
  return assertSafeTraceEnvelope({
    attempts: options.attempts,
    callId: options.callId,
    durationMs: Math.max(0, options.finishedAt - options.logicalStartedAt),
    finishedAt: toIso(options.finishedAt),
    outcome: options.outcome,
    ...(options.prompt === undefined
      ? {}
      : {
          promptDigest: options.prompt.digest,
          promptId: options.prompt.id,
        }),
    routePolicyVersion: ROUTE_POLICY_VERSION,
    startedAt: toIso(options.logicalStartedAt),
    task: options.task,
  });
}

async function recordTrace(
  sink: ModelTraceSink,
  trace: ModelLogicalCallTrace,
  signal: AbortSignal,
): Promise<void> {
  await sink.record(trace, signal);
}

function withDeadline<Value>(
  operation: PromiseLike<Value>,
  deadlineAt: number,
  now: () => number,
  onTimeout?: () => void,
): Promise<Value> {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    onTimeout?.();
    return Promise.reject(deadlineError());
  }

  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      onTimeout?.();
      reject(deadlineError());
    }, remainingMs);

    void Promise.resolve(operation).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function deadlineError(): ModelRouterError {
  return new ModelRouterError(
    "deadline_exceeded",
    "model call exceeded the caller's total deadline",
  );
}

function toIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

let nextCallId = 0;

function defaultCallId(): string {
  nextCallId += 1;
  return `model-call-${nextCallId}`;
}
