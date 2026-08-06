import { createHash } from "node:crypto";

import { buildAssetObjectKey } from "@reflo/asset-delivery";
import type {
  AuthorizedSourceSpan,
  EmbeddingResult,
} from "@reflo/model-router";
import { stableUuid } from "@reflo/retrieval";

import {
  MAX_RETEACHES_PER_CONCEPT_SESSION,
  RETEACH_GENERATION_VERSION,
  RETEACH_MASTERY_THRESHOLD,
  RETEACH_SIMILARITY_THRESHOLD,
  TUTOR_AGENT_VERSION,
  type AskTutorCommand,
  type GeneratedReteachLesson,
  type NextTutorAction,
  type NextTutorActionCommand,
  type PersistedReteachLesson,
  type TutorAnswer,
  type TutorConceptSnapshot,
  type TutorLessonReference,
  type TutorSessionSnapshot,
} from "./contracts.js";
import { TutorAgentError } from "./errors.js";
import type {
  TutorAgentRepositoryPort,
  TutorArtifactStorePort,
  TutorModelRouterPort,
  TutorRetrievalPort,
  TutorReviewSchedulerPort,
} from "./ports.js";

export interface TutorAgentDependencies {
  readonly artifacts: TutorArtifactStorePort;
  readonly models: TutorModelRouterPort;
  readonly repository: TutorAgentRepositoryPort;
  readonly retrieval: TutorRetrievalPort;
  readonly scheduler: TutorReviewSchedulerPort;
}

export class TutorAgentService {
  constructor(private readonly dependencies: TutorAgentDependencies) {}

  async nextAction(command: NextTutorActionCommand): Promise<NextTutorAction> {
    validateDeadline(command.deadlineMs);
    const deadlineAt = Date.now() + command.deadlineMs;
    const session = await this.dependencies.repository.loadSession(
      command.authorization,
      command.sessionId,
    );
    assertAuthorizedSession(command, session);

    for (const concept of session.concepts) {
      const active = activeReteach(concept);
      if (active === null) {
        continue;
      }
      const retest = evidenceAfter(concept, active.servedAt);
      if (retest === null) {
        if (concept.nextRetestQuestion === null) {
          throw new TutorAgentError("retest_unavailable");
        }
        return {
          conceptId: concept.conceptId,
          kind: "retest",
          question: concept.nextRetestQuestion,
        };
      }
      if (retest.rubricBand === "correct") {
        if (compareFixed(concept.mastery, active.baselineMastery) <= 0) {
          throw new TutorAgentError(
            "invalid_result",
            "a correct re-test did not produce an evidence-backed mastery delta",
          );
        }
        return {
          kind: "retest_succeeded",
          result: await this.dependencies.repository.recordLoopSuccess(
            command.authorization,
            {
              conceptId: concept.conceptId,
              finalMastery: concept.mastery,
              initialMastery: concept.reteachLessons[0]!.baselineMastery,
              latestAttemptId: retest.attemptId,
              replacementCount: replacementCount(concept),
              sessionId: session.sessionId,
            },
          ),
        };
      }
      if (concept.reteachLessons.length >= MAX_RETEACHES_PER_CONCEPT_SESSION) {
        const first = concept.reteachLessons[0]!;
        const scheduled = await this.dependencies.scheduler.scheduleLaterReview(
          command.authorization,
          {
            causationId: retest.attemptId,
            conceptId: concept.conceptId,
            sessionId: session.sessionId,
          },
        );
        const result = await this.dependencies.repository.recordLoopStopped(
          command.authorization,
          {
            conceptId: concept.conceptId,
            finalMastery: concept.mastery,
            initialMastery: first.baselineMastery,
            latestAttemptId: retest.attemptId,
            replacementCount: MAX_RETEACHES_PER_CONCEPT_SESSION,
            sessionId: session.sessionId,
          },
        );
        return {
          conceptId: concept.conceptId,
          kind: "review_scheduled",
          nextDeliveryAt: scheduled.nextDeliveryAt,
          result,
        };
      }
      if (isReteachTrigger(concept)) {
        return {
          conceptId: concept.conceptId,
          kind: "reteach",
          lesson: await this.#generateReteach(
            session,
            concept,
            remainingDeadline(deadlineAt),
          ),
        };
      }
    }

    const triggered = session.concepts.find(isReteachTrigger);
    if (triggered !== undefined) {
      return {
        conceptId: triggered.conceptId,
        kind: "reteach",
        lesson: await this.#generateReteach(
          session,
          triggered,
          remainingDeadline(deadlineAt),
        ),
      };
    }

    const review = session.concepts.find(
      (concept) =>
        concept.loopResult === null &&
        concept.dueForReview &&
        concept.nextRetestQuestion !== null,
    );
    if (review !== undefined) {
      return { conceptId: review.conceptId, kind: "review" };
    }
    const weak = session.concepts.find(
      (concept) =>
        concept.loopResult === null &&
        concept.latestEligibleAttempt !== null &&
        concept.latestEligibleAttempt.rubricBand !== "correct" &&
        concept.nextRetestQuestion !== null &&
        compareFixed(concept.mastery, RETEACH_MASTERY_THRESHOLD) < 0,
    );
    if (weak !== undefined) {
      return { conceptId: weak.conceptId, kind: "review" };
    }
    const advance = session.concepts.find(
      (concept) =>
        concept.loopResult === null &&
        concept.latestLessonExposureAt === null &&
        concept.lesson !== null &&
        concept.nextRetestQuestion !== null,
    );
    if (advance !== undefined) {
      return { conceptId: advance.conceptId, kind: "advance" };
    }
    await this.dependencies.repository.completeSession(
      command.authorization,
      session.sessionId,
    );
    return { kind: "session_complete" };
  }

  async ask(command: AskTutorCommand): Promise<TutorAnswer> {
    validateDeadline(command.deadlineMs);
    if (
      command.question.trim().length === 0 ||
      command.question.length > 4_000 ||
      command.idempotencyKey.length < 1 ||
      command.idempotencyKey.length > 240
    ) {
      throw new TutorAgentError("invalid_configuration");
    }
    const deadlineAt = Date.now() + command.deadlineMs;
    const session = await this.dependencies.repository.loadSession(
      command.authorization,
      command.sessionId,
    );
    assertAuthorizedSession(
      {
        authorization: command.authorization,
        sessionId: command.sessionId,
      },
      session,
    );
    if (
      session.courseId !== command.courseId ||
      session.sourceDocumentId !== command.sourceDocumentId
    ) {
      throw new TutorAgentError("authorization_denied");
    }
    const retrieved = await this.dependencies.retrieval.search({
      authorization: command.authorization,
      courseId: command.courseId,
      deadlineMs: remainingDeadline(deadlineAt),
      limit: 8,
      query: command.question,
      sourceDocumentId: command.sourceDocumentId,
    });
    if (retrieved.length === 0) {
      const notFound = { kind: "not_found" } as const;
      await this.#recordQuestion(command, notFound);
      return notFound;
    }
    const routed = await this.dependencies.models.execute(
      "tutor.answer.v1",
      {
        question: command.question,
        sourceSpans: retrieved.map((span) => ({
          id: span.id,
          text: span.text,
        })),
      },
      { deadlineMs: remainingDeadline(deadlineAt) },
    );
    if (routed.value.kind === "not_found") {
      await this.#recordQuestion(command, routed.value);
      return routed.value;
    }
    const spansById = new Map(retrieved.map((span) => [span.id, span]));
    if (
      routed.value.sourceSpanIds.length === 0 ||
      new Set(routed.value.sourceSpanIds).size !==
        routed.value.sourceSpanIds.length ||
      routed.value.sourceSpanIds.some((id) => !spansById.has(id))
    ) {
      throw new TutorAgentError(
        "invalid_result",
        "tutor answer cited a span that was not server-authorized",
      );
    }
    const answer: TutorAnswer = {
      citations: routed.value.sourceSpanIds.map((sourceSpanId) => ({
        sectionPath: spansById.get(sourceSpanId)!.sectionPath,
        sourceSpanId,
      })),
      content: routed.value.content,
      kind: "answer",
    };
    await this.#recordQuestion(command, answer);
    return answer;
  }

  async #generateReteach(
    session: TutorSessionSnapshot,
    concept: TutorConceptSnapshot,
    deadlineMs: number,
  ): Promise<PersistedReteachLesson> {
    const prior = latestLesson(concept);
    if (prior === null || concept.sourceSpans.length === 0) {
      throw new TutorAgentError("content_unavailable");
    }
    const priorContent = await this.dependencies.artifacts.readAuthorizedText({
      authorization: {
        actorId: session.actorId,
        authorizationId: session.authorizationId,
        ownerScopeId: session.ownerScopeId,
      },
      lesson: prior,
    });
    if (priorContent === null || sha256(priorContent) !== prior.contentHash) {
      throw new TutorAgentError("content_unavailable");
    }
    const deadlineAt = Date.now() + deadlineMs;
    const routed = await this.dependencies.models.execute(
      "lesson.reteach.v1",
      {
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        priorStrategyTag: prior.strategyTag,
        sourceSpans: concept.sourceSpans,
      },
      { deadlineMs: remainingDeadline(deadlineAt) },
    );
    validateGroundedLesson(
      routed.value.sourceSpanIds,
      concept.sourceSpans,
      routed.value.strategyTag,
      prior.strategyTag,
    );
    const embeddings = await this.dependencies.models.execute(
      "embedding.document.v1",
      { texts: [priorContent, routed.value.content] },
      { deadlineMs: remainingDeadline(deadlineAt) },
    );
    const similarity = semanticSimilarity(embeddings.value);
    if (similarity >= RETEACH_SIMILARITY_THRESHOLD) {
      throw new TutorAgentError(
        "invalid_result",
        "replacement lesson was not materially different",
      );
    }
    const replacementOrdinal = (concept.reteachLessons.length + 1) as 1 | 2;
    if (
      replacementOrdinal < 1 ||
      replacementOrdinal > MAX_RETEACHES_PER_CONCEPT_SESSION
    ) {
      throw new TutorAgentError("invalid_session");
    }
    const contentHash = sha256(routed.value.content);
    const generationId = stableUuid({
      conceptId: concept.conceptId,
      contentHash,
      modelProvenance: routed.provenance,
      replacementOrdinal,
      sessionId: session.sessionId,
      version: RETEACH_GENERATION_VERSION,
    });
    const assetId = stableUuid({
      conceptId: concept.conceptId,
      replacementOrdinal,
      sessionId: session.sessionId,
      version: RETEACH_GENERATION_VERSION,
    });
    const objectKey = buildAssetObjectKey({
      assetId,
      courseId: session.courseId,
      extension: "md",
      generationId,
      ownerScopeId: session.ownerScopeId,
    });
    const storage = await this.dependencies.artifacts.putImmutable({
      content: routed.value.content,
      contentHash,
      idempotencyKey: `${TUTOR_AGENT_VERSION}/reteach/${assetId}`,
      objectKey,
    });
    if (storage.objectKey !== objectKey) {
      throw new TutorAgentError("invalid_result");
    }
    const generated: GeneratedReteachLesson = {
      assetId,
      baselineMastery:
        concept.reteachLessons[0]?.baselineMastery ?? concept.mastery,
      chapterId: concept.chapterId,
      conceptId: concept.conceptId,
      contentHash,
      generationId,
      generationVersion: RETEACH_GENERATION_VERSION,
      modelProvenance: routed.provenance,
      objectKey,
      ownerScopeId: session.ownerScopeId,
      replacementOrdinal,
      semanticSimilarity: similarity.toFixed(5),
      sessionId: session.sessionId,
      sourceSpanIds: routed.value.sourceSpanIds,
      storage,
      strategyTag: routed.value.strategyTag,
    };
    return this.dependencies.repository.saveReteach(
      {
        actorId: session.actorId,
        authorizationId: session.authorizationId,
        ownerScopeId: session.ownerScopeId,
      },
      { concept, generated, session },
    );
  }

  async #recordQuestion(
    command: AskTutorCommand,
    answer: TutorAnswer,
  ): Promise<void> {
    await this.dependencies.repository.recordTutorQuestion(
      command.authorization,
      {
        idempotencyKey: command.idempotencyKey,
        resultKind: answer.kind,
        sessionId: command.sessionId,
        sourceSpanIds:
          answer.kind === "answer"
            ? answer.citations.map((citation) => citation.sourceSpanId)
            : [],
      },
    );
  }
}

export function isReteachTrigger(concept: TutorConceptSnapshot): boolean {
  if (concept.loopResult !== null || concept.latestLessonExposureAt === null) {
    return false;
  }
  const latest = concept.latestEligibleAttempt;
  return (
    latest !== null &&
    latest.createdAt >= concept.latestLessonExposureAt &&
    latest.rubricBand !== "correct" &&
    concept.eligibleAttemptCount >= 2 &&
    compareFixed(concept.mastery, RETEACH_MASTERY_THRESHOLD) < 0 &&
    concept.reteachLessons.length < MAX_RETEACHES_PER_CONCEPT_SESSION
  );
}

export function semanticSimilarity(result: EmbeddingResult): number {
  const left = result.vectors[0];
  const right = result.vectors[1];
  if (
    left === undefined ||
    right === undefined ||
    result.vectors.length !== 2 ||
    left.length === 0 ||
    left.length !== right.length
  ) {
    throw new TutorAgentError("invalid_result");
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new TutorAgentError("invalid_result");
    }
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    throw new TutorAgentError("invalid_result");
  }
  const similarity = dot / Math.sqrt(leftMagnitude * rightMagnitude);
  if (!Number.isFinite(similarity) || similarity < -1 || similarity > 1) {
    throw new TutorAgentError("invalid_result");
  }
  return similarity;
}

function assertAuthorizedSession(
  command: Pick<NextTutorActionCommand, "authorization" | "sessionId">,
  session: TutorSessionSnapshot | null,
): asserts session is TutorSessionSnapshot {
  if (
    session === null ||
    session.actorId !== command.authorization.actorId ||
    session.authorizationId !== command.authorization.authorizationId ||
    session.ownerScopeId !== command.authorization.ownerScopeId ||
    session.userId !== command.authorization.actorId ||
    session.sessionId !== command.sessionId ||
    session.status !== "active"
  ) {
    throw new TutorAgentError("authorization_denied");
  }
}

function activeReteach(
  concept: TutorConceptSnapshot,
): PersistedReteachLesson | null {
  if (concept.loopResult !== null) {
    return null;
  }
  return concept.reteachLessons.at(-1) ?? null;
}

function evidenceAfter(
  concept: TutorConceptSnapshot,
  servedAt: string,
): TutorConceptSnapshot["latestEligibleAttempt"] {
  const latest = concept.latestEligibleAttempt;
  return latest !== null && latest.createdAt > servedAt ? latest : null;
}

function latestLesson(
  concept: TutorConceptSnapshot,
): TutorLessonReference | null {
  return concept.reteachLessons.at(-1) ?? concept.lesson;
}

function replacementCount(concept: TutorConceptSnapshot): 1 | 2 {
  return concept.reteachLessons.length === 1 ? 1 : 2;
}

function validateGroundedLesson(
  citedIds: readonly string[],
  authorized: readonly AuthorizedSourceSpan[],
  strategyTag: string,
  priorStrategyTag: string,
): void {
  const authorizedIds = new Set(authorized.map((span) => span.id));
  if (
    strategyTag.trim().length === 0 ||
    strategyTag === priorStrategyTag ||
    citedIds.length === 0 ||
    new Set(citedIds).size !== citedIds.length ||
    citedIds.some((id) => !authorizedIds.has(id))
  ) {
    throw new TutorAgentError("invalid_result");
  }
}

function compareFixed(left: string, right: string): number {
  if (!/^(?:0(?:\.\d{1,5})?|1(?:\.0{1,5})?)$/.test(left)) {
    throw new TutorAgentError("invalid_result");
  }
  if (!/^(?:0(?:\.\d{1,5})?|1(?:\.0{1,5})?)$/.test(right)) {
    throw new TutorAgentError("invalid_result");
  }
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100_000 + Number(fraction.padEnd(5, "0"));
  };
  return units(left) - units(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new TutorAgentError("invalid_configuration");
  }
}

function remainingDeadline(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new TutorAgentError("invalid_configuration", "deadline exceeded");
  }
  return remaining;
}
