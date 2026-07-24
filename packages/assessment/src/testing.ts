import {
  canonicalJson,
  type ScopeAuthorizationContext,
} from "@reflo/retrieval";

import type {
  AssessmentFinalizationView,
  AuthorizedShortAnswerSnapshot,
  FrozenGradingPolicy,
  KeyedMultipleChoiceQuestion,
  ReplacementAnswerResolution,
  ReplacementBundle,
  ReplacementBundleSnapshot,
  ReplacementFinalization,
  ShortAnswerClaim,
  ShortAnswerFinalization,
  ShortAnswerQuestion,
} from "./contracts.js";
import { AssessmentError } from "./errors.js";
import type { AssessmentRepositoryPort } from "./ports.js";

interface SeededSession {
  readonly actorId: string;
  readonly fallbackCandidates: readonly KeyedMultipleChoiceQuestion[];
  readonly ownerScopeId: string;
  readonly questions: ReadonlyMap<string, ShortAnswerQuestion>;
}

interface InMemoryOperation {
  claimToken: string | null;
  expiresAt: number;
  finalized: boolean;
  readonly requestDigest: string;
  readonly reservedFallbackHashes: readonly string[];
  readonly sessionId: string;
  readonly snapshot: AuthorizedShortAnswerSnapshot;
}

export class InMemoryAssessmentRepository implements AssessmentRepositoryPort {
  readonly bundles = new Map<string, ReplacementBundleSnapshot>();
  readonly finalizations = new Map<
    string,
    ShortAnswerFinalization | ReplacementFinalization
  >();
  readonly operations = new Map<string, InMemoryOperation>();
  readonly policyBindings = new Map<string, string>();
  readonly presentedHashes = new Map<string, Set<string>>();
  readonly sessions = new Map<string, SeededSession>();
  readonly views = new Map<string, AssessmentFinalizationView>();
  #claimSequence = 0;

  seedAuthorizedSession(input: {
    readonly authorization: ScopeAuthorizationContext;
    readonly fallbackCandidates: readonly KeyedMultipleChoiceQuestion[];
    readonly questions: readonly ShortAnswerQuestion[];
    readonly sessionId: string;
  }): void {
    this.sessions.set(input.sessionId, {
      actorId: input.authorization.actorId,
      fallbackCandidates: input.fallbackCandidates,
      ownerScopeId: input.authorization.ownerScopeId,
      questions: new Map(
        input.questions.map((question) => [question.id, question]),
      ),
    });
  }

  async claimShortAnswer(
    authorization: ScopeAuthorizationContext,
    request: Parameters<AssessmentRepositoryPort["claimShortAnswer"]>[1],
  ): Promise<ShortAnswerClaim> {
    this.#bindPolicy(request.policy);
    const current = this.operations.get(request.idempotencyKey);
    if (current !== undefined) {
      if (current.requestDigest !== request.requestDigest) {
        throw new AssessmentError("conflicting_duplicate");
      }
      if (current.finalized) {
        const finalization = this.views.get(request.idempotencyKey);
        if (finalization === undefined) {
          throw new AssessmentError("invalid_result");
        }
        return { finalization, kind: "finalized" };
      }
      if (current.claimToken !== null && current.expiresAt > Date.now()) {
        return { kind: "pending" };
      }
      current.claimToken = this.#nextClaimToken();
      current.expiresAt = Date.now() + request.leaseMs;
      return {
        claimToken: current.claimToken,
        kind: "claimed",
        snapshot: current.snapshot,
      };
    }

    const session = this.sessions.get(request.sessionId);
    if (
      session === undefined ||
      session.actorId !== authorization.actorId ||
      session.ownerScopeId !== authorization.ownerScopeId
    ) {
      throw new AssessmentError("authorization_denied");
    }
    const question = session.questions.get(request.questionId);
    if (question === undefined) {
      throw new AssessmentError("authorization_denied");
    }
    const presented =
      this.presentedHashes.get(request.sessionId) ?? new Set<string>();
    if (presented.has(question.normalizedPromptHash)) {
      throw new AssessmentError("question_unavailable");
    }
    const fallbackCandidates = question.rubrics.map((rubric) => {
      const candidate = [...session.fallbackCandidates]
        .sort((left, right) => compareAscii(left.id, right.id))
        .find(
          (entry) =>
            entry.conceptIds[0] === rubric.conceptId &&
            entry.courseId === question.courseId &&
            entry.rubricId === rubric.rubricId &&
            entry.rubricVersion === rubric.rubricVersion &&
            !presented.has(entry.normalizedPromptHash) &&
            entry.normalizedPromptHash !== question.normalizedPromptHash,
        );
      if (candidate === undefined) {
        throw new AssessmentError("fallback_unavailable");
      }
      presented.add(candidate.normalizedPromptHash);
      return candidate;
    });
    presented.add(question.normalizedPromptHash);
    this.presentedHashes.set(request.sessionId, presented);
    const snapshot = { fallbackCandidates, question };
    const claimToken = this.#nextClaimToken();
    this.operations.set(request.idempotencyKey, {
      claimToken,
      expiresAt: Date.now() + request.leaseMs,
      finalized: false,
      requestDigest: request.requestDigest,
      reservedFallbackHashes: fallbackCandidates.map(
        (entry) => entry.normalizedPromptHash,
      ),
      sessionId: request.sessionId,
      snapshot,
    });
    return { claimToken, kind: "claimed", snapshot };
  }

  async finalizeShortAnswer(
    authorization: ScopeAuthorizationContext,
    finalization: ShortAnswerFinalization,
  ): Promise<AssessmentFinalizationView> {
    assertAuthorized(authorization, finalization);
    const operation = this.operations.get(finalization.idempotencyKey);
    if (
      operation === undefined ||
      operation.requestDigest !== finalization.requestDigest ||
      operation.claimToken !== finalization.claimToken
    ) {
      throw new AssessmentError("conflicting_duplicate");
    }
    const publicFallback =
      finalization.fallback === null
        ? null
        : sanitizeBundle(finalization.fallback);
    const view: AssessmentFinalizationView = {
      attemptId: finalization.attemptId,
      evidence: finalization.evidence,
      fallback: publicFallback,
      learnerMessage: finalization.learnerMessage,
      outcome: finalization.outcome,
      requestDigest: finalization.requestDigest,
      status: "created",
    };
    this.#put(finalization.idempotencyKey, finalization, view);
    operation.finalized = true;
    operation.claimToken = null;
    if (finalization.fallback !== null) {
      this.bundles.set(finalization.fallback.id, finalization.fallback);
    } else {
      const presented = this.presentedHashes.get(operation.sessionId);
      for (const hash of operation.reservedFallbackHashes) {
        presented?.delete(hash);
      }
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
    return original === undefined ? null : sanitizeBundle(bundle);
  }

  async releaseShortAnswerClaim(
    authorization: ScopeAuthorizationContext,
    idempotencyKey: string,
    claimToken: string,
  ): Promise<void> {
    const operation = this.operations.get(idempotencyKey);
    const session =
      operation === undefined
        ? undefined
        : this.sessions.get(operation.sessionId);
    if (
      operation !== undefined &&
      session?.actorId === authorization.actorId &&
      session.ownerScopeId === authorization.ownerScopeId &&
      operation.claimToken === claimToken &&
      !operation.finalized
    ) {
      operation.claimToken = null;
      operation.expiresAt = 0;
    }
  }

  async resolveReplacementAnswer(
    authorization: ScopeAuthorizationContext,
    request: Parameters<
      AssessmentRepositoryPort["resolveReplacementAnswer"]
    >[1],
  ): Promise<ReplacementAnswerResolution | null> {
    const bundle = this.bundles.get(request.bundleId);
    const item = bundle?.items.find((entry) => entry.id === request.itemId);
    if (bundle === undefined || item === undefined) return null;
    const original = [...this.finalizations.values()].find(
      (entry) =>
        "fallback" in entry &&
        entry.fallback?.id === bundle.id &&
        entry.ownerScopeId === authorization.ownerScopeId &&
        entry.userId === authorization.actorId,
    );
    if (original === undefined) return null;
    const publicBundle = sanitizeBundle(bundle);
    const publicItem = publicBundle.items.find(
      (entry) => entry.id === request.itemId,
    );
    if (publicItem === undefined) return null;
    return {
      bundle: publicBundle,
      correct: request.answer === item.question.keyedAnswer,
      item: publicItem,
    };
  }

  #bindPolicy(policy: FrozenGradingPolicy): void {
    const binding = canonicalJson(policy);
    const currentBinding = this.policyBindings.get(policy.gradingPolicyVersion);
    if (currentBinding !== undefined && currentBinding !== binding) {
      throw new AssessmentError("invalid_configuration");
    }
    this.policyBindings.set(policy.gradingPolicyVersion, binding);
  }

  #nextClaimToken(): string {
    this.#claimSequence += 1;
    return `in-memory-assessment-claim-${this.#claimSequence}`;
  }

  #put(
    idempotencyKey: string,
    finalization: ShortAnswerFinalization | ReplacementFinalization,
    view: AssessmentFinalizationView,
  ): void {
    this.#bindPolicy(finalization.policy);
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

function sanitizeBundle(
  snapshot: ReplacementBundleSnapshot,
): ReplacementBundle {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      const { keyedAnswer: _keyedAnswer, ...question } = item.question;
      return { ...item, question };
    }),
  };
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

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
