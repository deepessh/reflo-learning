import type { ModelTaskInput, RoutedModelResult } from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

import type {
  AssessmentFinalizationView,
  ReplacementBundle,
  ReplacementFinalization,
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
}
