import {
  canonicalJson,
  type ScopeAuthorizationContext,
} from "@reflo/retrieval";

import type {
  AssessmentFinalizationView,
  ReplacementBundle,
  ReplacementFinalization,
  ShortAnswerFinalization,
} from "./contracts.js";
import { AssessmentError } from "./errors.js";
import type { AssessmentRepositoryPort } from "./ports.js";

export class InMemoryAssessmentRepository implements AssessmentRepositoryPort {
  readonly bundles = new Map<string, ReplacementBundle>();
  readonly finalizations = new Map<
    string,
    ShortAnswerFinalization | ReplacementFinalization
  >();
  readonly policyBindings = new Map<string, string>();
  readonly views = new Map<string, AssessmentFinalizationView>();

  async finalizeShortAnswer(
    authorization: ScopeAuthorizationContext,
    finalization: ShortAnswerFinalization,
  ): Promise<AssessmentFinalizationView> {
    assertAuthorized(authorization, finalization);
    const view: AssessmentFinalizationView = {
      attemptId: finalization.attemptId,
      evidence: finalization.evidence,
      fallback: finalization.fallback,
      learnerMessage: finalization.learnerMessage,
      outcome: finalization.outcome,
      requestDigest: finalization.requestDigest,
      status: "created",
    };
    this.#put(finalization.idempotencyKey, finalization, view);
    if (finalization.fallback !== null) {
      this.bundles.set(finalization.fallback.id, finalization.fallback);
    }
    return this.views.get(finalization.idempotencyKey) ?? view;
  }

  async finalizeReplacement(
    authorization: ScopeAuthorizationContext,
    finalization: ReplacementFinalization,
  ): Promise<AssessmentFinalizationView> {
    assertAuthorized(authorization, finalization);
    const view: AssessmentFinalizationView = {
      attemptId: finalization.attemptId,
      evidence: [finalization.evidence],
      fallback: null,
      learnerMessage:
        "The replacement answer was graded from its keyed option.",
      outcome: "graded",
      requestDigest: finalization.requestDigest,
      status: "created",
    };
    this.#put(finalization.idempotencyKey, finalization, view);
    return this.views.get(finalization.idempotencyKey) ?? view;
  }

  async loadFinalization(
    authorization: ScopeAuthorizationContext,
    idempotencyKey: string,
  ): Promise<AssessmentFinalizationView | null> {
    const finalization = this.finalizations.get(idempotencyKey);
    if (finalization === undefined) return null;
    assertAuthorized(authorization, finalization);
    return this.views.get(idempotencyKey) ?? null;
  }

  async loadReplacementBundle(
    authorization: ScopeAuthorizationContext,
    bundleId: string,
  ): Promise<ReplacementBundle | null> {
    const bundle = this.bundles.get(bundleId);
    if (bundle === undefined) return null;
    const original = [...this.finalizations.values()].find(
      (entry) =>
        "fallback" in entry &&
        entry.fallback?.id === bundleId &&
        entry.ownerScopeId === authorization.ownerScopeId &&
        entry.userId === authorization.actorId,
    );
    return original === undefined ? null : bundle;
  }

  #put(
    idempotencyKey: string,
    finalization: ShortAnswerFinalization | ReplacementFinalization,
    view: AssessmentFinalizationView,
  ): void {
    const binding = canonicalJson(finalization.policy);
    const currentBinding = this.policyBindings.get(
      finalization.policy.gradingPolicyVersion,
    );
    if (currentBinding !== undefined && currentBinding !== binding) {
      throw new AssessmentError("invalid_configuration");
    }
    this.policyBindings.set(finalization.policy.gradingPolicyVersion, binding);
    const current = this.finalizations.get(idempotencyKey);
    if (
      current !== undefined &&
      current.requestDigest !== finalization.requestDigest
    ) {
      throw new AssessmentError("conflicting_duplicate");
    }
    if (current === undefined) {
      this.finalizations.set(idempotencyKey, finalization);
      this.views.set(idempotencyKey, view);
    }
  }
}

function assertAuthorized(
  authorization: ScopeAuthorizationContext,
  finalization: {
    readonly ownerScopeId: string;
    readonly userId: string;
  },
): void {
  if (
    authorization.ownerScopeId !== finalization.ownerScopeId ||
    authorization.actorId !== finalization.userId
  ) {
    throw new AssessmentError("authorization_denied");
  }
}
