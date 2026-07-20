import {
  isP1FlagKey,
  P1_FLAG_REGISTRY,
  type P1FlagKey,
  type PrerequisitePolicyDefinition,
  type ResourceAdmissionPolicy,
  type VideoOperationKind,
} from "./registry.js";

export type FlagEnvironment = "dev" | "pilot" | "staging";

export const MAX_P1_TRUE_SNAPSHOT_MS = 30_000 as const;

export interface RequestedFlagState {
  readonly requestedEnabled: boolean;
  readonly revision: number;
}

export interface RequestedFlagStateSource {
  read(
    key: P1FlagKey,
    environment: FlagEnvironment,
  ): Promise<RequestedFlagState | null>;
}

export interface PrerequisiteVerdict {
  readonly evidenceRefs: readonly string[];
  readonly policyId: string;
  readonly policyVersion: string;
  readonly satisfied: boolean;
  readonly validUntilMs: number;
}

export interface PrerequisiteVerdictSource {
  read(
    policy: PrerequisitePolicyDefinition,
    environment: FlagEnvironment,
  ): Promise<PrerequisiteVerdict | null>;
}

export interface ResourceAdmissionSource {
  admit(
    policy: Extract<ResourceAdmissionPolicy, { readonly mode: "shared" }>,
    context: {
      readonly environment: FlagEnvironment;
      readonly key: P1FlagKey;
    },
  ): Promise<boolean>;
}

export interface DeploymentCeiling {
  readonly allowed: ReadonlySet<P1FlagKey>;
  readonly status: "invalid" | "missing" | "valid";
}

export type FlagDisabledReason =
  | "admission_denied"
  | "deployment_ceiling_denied"
  | "deployment_ceiling_invalid"
  | "deployment_ceiling_missing"
  | "prerequisite_missing_or_stale"
  | "requested_state_missing_or_disabled"
  | "source_unavailable"
  | "unknown_flag"
  | "video_operation_invalid";

export type FlagEvaluation =
  | {
      readonly enabled: false;
      readonly reason: FlagDisabledReason;
    }
  | {
      readonly enabled: true;
      readonly evaluatedAtMs: number;
      readonly requestedRevision: number;
    };

export interface FlagEvaluationContext {
  readonly videoOperationKind?: VideoOperationKind;
}

export interface P1FlagEvaluatorOptions {
  readonly admissionSource: ResourceAdmissionSource;
  readonly deploymentCeiling: DeploymentCeiling;
  readonly environment: FlagEnvironment;
  readonly maxTrueSnapshotMs?: number;
  readonly now?: () => number;
  readonly prerequisiteSource: PrerequisiteVerdictSource;
  readonly requestedStateSource: RequestedFlagStateSource;
}

export function parseDeploymentCeiling(
  value: string | undefined,
): DeploymentCeiling {
  if (value === undefined || value.trim().length === 0) {
    return { allowed: new Set(), status: "missing" };
  }
  const entries = value.split(",").map((entry) => entry.trim());
  if (
    entries.some(
      (entry) => entry.length === 0 || entry === "*" || !isP1FlagKey(entry),
    )
  ) {
    return { allowed: new Set(), status: "invalid" };
  }
  return { allowed: new Set(entries as P1FlagKey[]), status: "valid" };
}

export function createP1FlagEvaluator(options: P1FlagEvaluatorOptions) {
  const maxTrueSnapshotMs =
    options.maxTrueSnapshotMs ?? MAX_P1_TRUE_SNAPSHOT_MS;
  if (
    !Number.isInteger(maxTrueSnapshotMs) ||
    maxTrueSnapshotMs < 1 ||
    maxTrueSnapshotMs > MAX_P1_TRUE_SNAPSHOT_MS
  ) {
    throw new Error(
      `maxTrueSnapshotMs must be between 1 and ${MAX_P1_TRUE_SNAPSHOT_MS}`,
    );
  }
  const now = options.now ?? Date.now;
  const trueSnapshots = new Map<
    string,
    Extract<FlagEvaluation, { readonly enabled: true }> & {
      readonly expiresAtMs: number;
    }
  >();

  return Object.freeze({
    evaluate,
    invalidate,
    isEnabled,
  });

  async function evaluate(
    key: string,
    context: FlagEvaluationContext = {},
  ): Promise<FlagEvaluation> {
    if (!isP1FlagKey(key)) {
      return disabled("unknown_flag");
    }
    const definition = P1_FLAG_REGISTRY[key];
    if (definition.default !== false) {
      return disabled("source_unavailable");
    }

    if (options.deploymentCeiling.status === "missing") {
      return disabled("deployment_ceiling_missing");
    }
    if (options.deploymentCeiling.status === "invalid") {
      return disabled("deployment_ceiling_invalid");
    }
    if (!options.deploymentCeiling.allowed.has(key)) {
      return disabled("deployment_ceiling_denied");
    }

    const operationPolicy = getOperationPolicy(key, context);
    if (operationPolicy === "invalid") {
      return disabled("video_operation_invalid");
    }
    const cacheKey = `${key}:${context.videoOperationKind ?? "default"}`;
    const snapshot = trueSnapshots.get(cacheKey);
    const evaluatedAtMs = now();
    if (snapshot !== undefined && snapshot.expiresAtMs > evaluatedAtMs) {
      return {
        enabled: true,
        evaluatedAtMs: snapshot.evaluatedAtMs,
        requestedRevision: snapshot.requestedRevision,
      };
    }
    trueSnapshots.delete(cacheKey);

    try {
      const state = await options.requestedStateSource.read(
        key,
        options.environment,
      );
      if (state === null || !state.requestedEnabled) {
        return disabled("requested_state_missing_or_disabled");
      }
      if (!isValidRevision(state.revision)) {
        return disabled("source_unavailable");
      }

      const baseValidUntilMs = await prerequisiteValidUntil(
        definition.prerequisitePolicy,
        evaluatedAtMs,
      );
      if (baseValidUntilMs === null) {
        return disabled("prerequisite_missing_or_stale");
      }
      let operationValidUntilMs = Number.POSITIVE_INFINITY;
      if (operationPolicy !== undefined) {
        const validUntilMs = await prerequisiteValidUntil(
          operationPolicy,
          evaluatedAtMs,
        );
        if (validUntilMs === null) {
          return disabled("prerequisite_missing_or_stale");
        }
        operationValidUntilMs = validUntilMs;
      }

      const resourcePolicy = definition.resourceAdmissionPolicy;
      if (
        resourcePolicy.mode === "shared" &&
        !(await options.admissionSource.admit(resourcePolicy, {
          environment: options.environment,
          key,
        }))
      ) {
        return disabled("admission_denied");
      }

      const result = {
        enabled: true,
        evaluatedAtMs,
        requestedRevision: state.revision,
      } as const;
      trueSnapshots.set(cacheKey, {
        ...result,
        expiresAtMs: Math.min(
          evaluatedAtMs + maxTrueSnapshotMs,
          baseValidUntilMs,
          operationValidUntilMs,
        ),
      });
      return result;
    } catch {
      return disabled("source_unavailable");
    }
  }

  async function prerequisiteValidUntil(
    policy: PrerequisitePolicyDefinition,
    evaluatedAtMs: number,
  ): Promise<number | null> {
    const verdict = await options.prerequisiteSource.read(
      policy,
      options.environment,
    );
    const current =
      verdict !== null &&
      verdict.satisfied &&
      verdict.policyId === policy.id &&
      verdict.policyVersion === policy.version &&
      Number.isFinite(verdict.validUntilMs) &&
      verdict.validUntilMs > evaluatedAtMs &&
      verdict.evidenceRefs.length > 0 &&
      verdict.evidenceRefs.every((reference) => reference.trim().length > 0);
    return current ? verdict.validUntilMs : null;
  }

  function invalidate(key?: P1FlagKey): void {
    if (key === undefined) {
      trueSnapshots.clear();
      return;
    }
    for (const cacheKey of trueSnapshots.keys()) {
      if (cacheKey.startsWith(`${key}:`)) {
        trueSnapshots.delete(cacheKey);
      }
    }
  }

  async function isEnabled(
    key: string,
    context: FlagEvaluationContext = {},
  ): Promise<boolean> {
    return (await evaluate(key, context)).enabled;
  }
}

function getOperationPolicy(
  key: P1FlagKey,
  context: FlagEvaluationContext,
): PrerequisitePolicyDefinition | "invalid" | undefined {
  if (key !== "p1.media.video") {
    return context.videoOperationKind === undefined ? undefined : "invalid";
  }
  if (context.videoOperationKind === undefined) {
    return "invalid";
  }
  return (
    P1_FLAG_REGISTRY[key].videoOperationPolicies?.[
      context.videoOperationKind
    ] ?? "invalid"
  );
}

function disabled(reason: FlagDisabledReason): FlagEvaluation {
  return { enabled: false, reason };
}

function isValidRevision(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
