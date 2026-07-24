import type { ModelTaskInput, RoutedModelResult } from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

import type {
  AssessmentFinalizationView,
  FrozenGradingPolicy,
  ReplacementBundle,
  ReplacementAnswerResolution,
  ReplacementFinalization,
  ShortAnswerClaim,
  ShortAnswerFinalization,
} from "./contracts.js";

export interface AssessmentModelRouterPort {
  execute(
    task: "assessment.grade-short-answer.v1",
    input: ModelTaskInput<"assessment.grade-short-answer.v1">,
    options: { readonly deadlineMs: number },
  ): Promise<RoutedModelResult<"assessment.grade-short-answer.v1">>;
}

export interface AssessmentRepositoryPort {
  claimShortAnswer(
    authorization: ScopeAuthorizationContext,
    request: {
      readonly idempotencyKey: string;
      readonly leaseMs: number;
      readonly policy: FrozenGradingPolicy;
      readonly questionId: string;
      readonly requestDigest: string;
      readonly sessionId: string;
    },
  ): Promise<ShortAnswerClaim>;

  finalizeReplacement(
    authorization: ScopeAuthorizationContext,
    finalization: ReplacementFinalization,
  ): Promise<AssessmentFinalizationView>;

  finalizeShortAnswer(
    authorization: ScopeAuthorizationContext,
    finalization: ShortAnswerFinalization,
  ): Promise<AssessmentFinalizationView>;

  loadFinalization(
    authorization: ScopeAuthorizationContext,
    idempotencyKey: string,
  ): Promise<AssessmentFinalizationView | null>;

  loadReplacementBundle(
    authorization: ScopeAuthorizationContext,
    bundleId: string,
  ): Promise<ReplacementBundle | null>;

  releaseShortAnswerClaim(
    authorization: ScopeAuthorizationContext,
    idempotencyKey: string,
    claimToken: string,
  ): Promise<void>;

  resolveReplacementAnswer(
    authorization: ScopeAuthorizationContext,
    request: {
      readonly answer: string;
      readonly bundleId: string;
      readonly itemId: string;
    },
  ): Promise<ReplacementAnswerResolution | null>;
}
