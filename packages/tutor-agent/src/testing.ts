import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { ScopeAuthorizationContext } from "@reflo/retrieval";

import {
  RETEACH_GENERATION_VERSION,
  type GeneratedReteachLesson,
  type LaterReviewRequest,
  type LoopSuccessRecord,
  type PersistedReteachLesson,
  type ReteachPersistenceRequest,
  type TextArtifactWriteResult,
  type TutorLoopResult,
  type TutorQuestionRecord,
  type TutorQuestionSourceSpanRequest,
  type TutorRetrievedSpan,
  type TutorSearchRequest,
  type TutorSessionSnapshot,
} from "./contracts.js";
import type {
  TutorAgentRepositoryPort,
  TutorArtifactStorePort,
  TutorRetrievalPort,
  TutorReviewSchedulerPort,
} from "./ports.js";

export class InMemoryTutorRepository implements TutorAgentRepositoryPort {
  readonly completedSessions: string[] = [];
  readonly questions: TutorQuestionRecord[] = [];
  readonly recordedQuestionIds = new Set<string>();
  readonly questionSourceSpans = new Map<
    string,
    {
      readonly courseId: string;
      readonly sessionId: string;
      readonly sourceDocumentId: string;
      readonly sourceSpanIds: readonly string[];
    }
  >();
  readonly sessions = new Map<string, TutorSessionSnapshot>();
  readonly stopped: TutorLoopResult[] = [];
  readonly succeeded: TutorLoopResult[] = [];
  servedAt = "2026-07-24T12:05:00.000Z";

  async completeSession(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !authorized(session, authorization)) {
      throw new Error("unauthorized fixture completion");
    }
    if (!this.completedSessions.includes(sessionId)) {
      this.completedSessions.push(sessionId);
    }
  }

  async loadSession(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<TutorSessionSnapshot | null> {
    const session = this.sessions.get(sessionId);
    return session !== undefined && authorized(session, authorization)
      ? session
      : null;
  }

  async resolveAuthorizedQuestionSourceSpanIds(
    authorization: ScopeAuthorizationContext,
    request: TutorQuestionSourceSpanRequest,
  ): Promise<readonly string[]> {
    const session = this.sessions.get(request.sessionId);
    const question = this.questionSourceSpans.get(request.questionId);
    if (
      session === undefined ||
      !authorized(session, authorization) ||
      session.courseId !== request.courseId ||
      session.sourceDocumentId !== request.sourceDocumentId ||
      question === undefined ||
      question.sessionId !== request.sessionId ||
      question.courseId !== request.courseId ||
      question.sourceDocumentId !== request.sourceDocumentId ||
      (request.currentQuestionId !== request.questionId &&
        !this.recordedQuestionIds.has(
          `${request.sessionId}:${request.questionId}`,
        ))
    ) {
      return [];
    }
    return question.sourceSpanIds;
  }

  async saveReteach(
    authorization: ScopeAuthorizationContext,
    request: ReteachPersistenceRequest,
  ): Promise<PersistedReteachLesson> {
    if (!authorized(request.session, authorization)) {
      throw new Error("unauthorized fixture write");
    }
    const lesson: PersistedReteachLesson = {
      assetId: request.generated.assetId,
      baselineMastery: request.generated.baselineMastery,
      chapterId: request.generated.chapterId,
      conceptId: request.generated.conceptId,
      contentHash: request.generated.contentHash,
      generationId: request.generated.generationId,
      generationVersion: RETEACH_GENERATION_VERSION,
      modality: "text",
      modelProvenance: request.generated.modelProvenance,
      objectKey: request.generated.objectKey,
      ownerScopeId: request.generated.ownerScopeId,
      replacementOrdinal: request.generated.replacementOrdinal,
      semanticSimilarity: request.generated.semanticSimilarity,
      servedAt: this.servedAt,
      sessionId: request.generated.sessionId,
      sourceSpanIds: request.generated.sourceSpanIds,
      strategyTag: request.generated.strategyTag,
    };
    this.#updateConcept(request.session.sessionId, request.concept.conceptId, {
      reteachLessons: [...request.concept.reteachLessons, lesson],
    });
    return lesson;
  }

  async recordLoopSuccess(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
  ): Promise<TutorLoopResult> {
    return this.#record(authorization, record, "retest_succeeded");
  }

  async recordLoopStopped(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
  ): Promise<TutorLoopResult> {
    return this.#record(
      authorization,
      record,
      "stopped_after_two_replacements",
    );
  }

  async recordTutorQuestion(
    authorization: ScopeAuthorizationContext,
    record: TutorQuestionRecord,
  ): Promise<void> {
    const session = this.sessions.get(record.sessionId);
    if (session === undefined || !authorized(session, authorization)) {
      throw new Error("unauthorized fixture question");
    }
    const existing = this.questions.find(
      (question) => question.idempotencyKey === record.idempotencyKey,
    );
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error("conflicting question replay");
      }
      return;
    }
    this.questions.push(record);
  }

  #record(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
    outcome: TutorLoopResult["outcome"],
  ): TutorLoopResult {
    const session = this.sessions.get(record.sessionId);
    if (session === undefined || !authorized(session, authorization)) {
      throw new Error("unauthorized fixture summary");
    }
    const current = session.concepts.find(
      (concept) => concept.conceptId === record.conceptId,
    );
    if (current?.loopResult !== null && current?.loopResult !== undefined) {
      return current.loopResult;
    }
    const result: TutorLoopResult = {
      completedAt: "2026-07-24T12:10:00.000Z",
      conceptId: record.conceptId,
      evidenceAttemptId: record.latestAttemptId,
      finalMastery: record.finalMastery,
      initialMastery: record.initialMastery,
      masteryDelta: fixedDelta(record.finalMastery, record.initialMastery),
      outcome,
      replacementCount: record.replacementCount,
    };
    this.#updateConcept(record.sessionId, record.conceptId, {
      loopResult: result,
    });
    (outcome === "retest_succeeded" ? this.succeeded : this.stopped).push(
      result,
    );
    return result;
  }

  #updateConcept(
    sessionId: string,
    conceptId: string,
    update: Partial<TutorSessionSnapshot["concepts"][number]>,
  ): void {
    const session = required(this.sessions.get(sessionId));
    this.sessions.set(sessionId, {
      ...session,
      concepts: session.concepts.map((concept) =>
        concept.conceptId === conceptId ? { ...concept, ...update } : concept,
      ),
    });
  }
}

export class InMemoryTutorArtifactStore implements TutorArtifactStorePort {
  readonly objects = new Map<
    string,
    { readonly content: string; readonly contentHash: string }
  >();

  async putImmutable(input: {
    readonly content: string;
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<TextArtifactWriteResult> {
    const existing = this.objects.get(input.objectKey);
    if (existing !== undefined && existing.contentHash !== input.contentHash) {
      throw new Error("immutable object conflict");
    }
    this.objects.set(input.objectKey, {
      content: input.content,
      contentHash: input.contentHash,
    });
    return {
      byteSize: Buffer.byteLength(input.content),
      contentType: "text/markdown; charset=utf-8",
      etag: input.contentHash,
      objectKey: input.objectKey,
    };
  }

  async readAuthorizedText(input: {
    readonly authorization: ScopeAuthorizationContext;
    readonly lesson: {
      readonly contentHash: string;
      readonly objectKey: string;
    };
  }): Promise<string | null> {
    const object = this.objects.get(input.lesson.objectKey);
    return object?.contentHash === input.lesson.contentHash
      ? object.content
      : null;
  }

  seed(objectKey: string, content: string): string {
    const contentHash = createHash("sha256").update(content).digest("hex");
    this.objects.set(objectKey, { content, contentHash });
    return contentHash;
  }
}

export class InMemoryTutorRetrieval implements TutorRetrievalPort {
  readonly preferredResults = new Map<string, TutorRetrievedSpan>();
  readonly requests: TutorSearchRequest[] = [];
  results: readonly TutorRetrievedSpan[] = [];

  async search(
    request: TutorSearchRequest,
  ): Promise<readonly TutorRetrievedSpan[]> {
    this.requests.push(request);
    const preferred = (request.preferredSourceSpanIds ?? []).flatMap((id) => {
      const span = this.preferredResults.get(id);
      return span === undefined ? [] : [span];
    });
    const preferredIds = new Set(preferred.map((span) => span.id));
    return [
      ...preferred,
      ...this.results.filter((span) => !preferredIds.has(span.id)),
    ].slice(0, request.limit);
  }
}

export class InMemoryTutorScheduler implements TutorReviewSchedulerPort {
  readonly requests: LaterReviewRequest[] = [];
  nextDeliveryAt = "2026-07-25T09:00:00.000Z";

  async scheduleLaterReview(
    _authorization: ScopeAuthorizationContext,
    request: LaterReviewRequest,
  ): Promise<{ readonly nextDeliveryAt: string }> {
    this.requests.push(request);
    return { nextDeliveryAt: this.nextDeliveryAt };
  }
}

export function generatedReteachFixture(
  overrides: Partial<GeneratedReteachLesson> = {},
): GeneratedReteachLesson {
  return {
    assetId: "10000000-0000-4000-8000-000000000001",
    baselineMastery: "0.16667",
    chapterId: "20000000-0000-4000-8000-000000000001",
    conceptId: "30000000-0000-4000-8000-000000000001",
    contentHash: "a".repeat(64),
    generationId: "40000000-0000-4000-8000-000000000001",
    generationVersion: RETEACH_GENERATION_VERSION,
    modelProvenance: {} as GeneratedReteachLesson["modelProvenance"],
    objectKey: "scopes/scope/assets/lesson.md",
    ownerScopeId: "50000000-0000-4000-8000-000000000001",
    replacementOrdinal: 1,
    semanticSimilarity: "0.00000",
    sessionId: "60000000-0000-4000-8000-000000000001",
    sourceSpanIds: ["70000000-0000-4000-8000-000000000001"],
    storage: {
      byteSize: 1,
      contentType: "text/markdown; charset=utf-8",
      etag: "a".repeat(64),
      objectKey: "scopes/scope/assets/lesson.md",
    },
    strategyTag: "analogy-v1",
    ...overrides,
  };
}

function fixedDelta(finalMastery: string, initialMastery: string): string {
  const units = (value: string) =>
    Math.round(Number.parseFloat(value) * 100_000);
  return ((units(finalMastery) - units(initialMastery)) / 100_000).toFixed(5);
}

function authorized(
  session: TutorSessionSnapshot,
  authorization: ScopeAuthorizationContext,
): boolean {
  return (
    session.actorId === authorization.actorId &&
    session.authorizationId === authorization.authorizationId &&
    session.ownerScopeId === authorization.ownerScopeId
  );
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("missing in-memory tutor fixture");
  }
  return value;
}
