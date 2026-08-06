import { createHash } from "node:crypto";

import {
  CONNECTED_STUDY_VIEW_VERSION,
  type ConnectedStudyView,
} from "@reflo/contracts";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";
import type {
  TutorAgentRepositoryPort,
  TutorArtifactStorePort,
  TutorConceptSnapshot,
} from "@reflo/tutor-agent";
import type { ConnectedStudyLessonAssets } from "@reflo/db";

interface ConnectedLessonAssetPort {
  loadStudyLessonAssets(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
    conceptId: string,
  ): Promise<ConnectedStudyLessonAssets | null>;
}

export class ConnectedStudyService {
  constructor(
    private readonly repository: Pick<TutorAgentRepositoryPort, "loadSession">,
    private readonly artifacts: Pick<
      TutorArtifactStorePort,
      "readAuthorizedText"
    >,
    private readonly lessonAssets?: ConnectedLessonAssetPort,
  ) {}

  async load(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<ConnectedStudyView | null> {
    const session = await this.repository.loadSession(authorization, sessionId);
    if (session === null) {
      return null;
    }
    const concept = activeConcept(session.concepts);
    if (concept === null) {
      return null;
    }
    const persistedLesson = concept.reteachLessons.at(-1) ?? null;
    const lessonContent =
      persistedLesson === null
        ? null
        : await this.artifacts.readAuthorizedText({
            authorization,
            lesson: persistedLesson,
          });
    const lesson =
      persistedLesson !== null &&
      lessonContent !== null &&
      sha256(lessonContent) === persistedLesson.contentHash
        ? {
            baselineMastery: persistedLesson.baselineMastery,
            content: lessonContent,
            generationVersion: persistedLesson.generationVersion,
            modality: "text" as const,
            priorStrategyTag: concept.lesson?.strategyTag ?? "unknown",
            replacementOrdinal: persistedLesson.replacementOrdinal,
            semanticSimilarity: persistedLesson.semanticSimilarity,
            servedAt: persistedLesson.servedAt,
            sourceSpanCount: persistedLesson.sourceSpanIds.length,
            strategyTag: persistedLesson.strategyTag,
          }
        : null;
    const question =
      concept.nextRetestQuestion?.itemType === "short_answer"
        ? {
            conceptId: concept.nextRetestQuestion.conceptId,
            difficulty: concept.nextRetestQuestion.difficulty,
            itemId: concept.nextRetestQuestion.itemId,
            itemType: "short_answer" as const,
            prompt: concept.nextRetestQuestion.prompt,
          }
        : null;
    const state = studyState(
      concept,
      persistedLesson !== null,
      lesson !== null,
    );

    return {
      concept: {
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        eligibleAttemptCount: concept.eligibleAttemptCount,
        latestEligibleAttempt:
          concept.latestEligibleAttempt === null
            ? null
            : {
                attemptId: concept.latestEligibleAttempt.attemptId,
                createdAt: concept.latestEligibleAttempt.createdAt,
                rubricBand: concept.latestEligibleAttempt.rubricBand,
              },
        mastery: concept.mastery,
      },
      contractVersion: CONNECTED_STUDY_VIEW_VERSION,
      courseId: session.courseId,
      demoOnly: true,
      lesson,
      loopResult: concept.loopResult,
      plan: {
        steps: ["answer", "different_lesson", "retest", "refresh_map"],
        target: "close_evidence_gap",
      },
      question,
      sessionId: session.sessionId,
      sourceDocumentId: session.sourceDocumentId,
      state,
    };
  }

  async loadLesson(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const session = await this.repository.loadSession(authorization, sessionId);
    if (session === null) {
      return null;
    }
    const concept = activeConcept(session.concepts);
    const selectedLesson =
      concept?.reteachLessons.at(-1) ?? concept?.lesson ?? null;
    if (concept === null || selectedLesson === null) {
      return null;
    }
    const assets = await this.lessonAssets?.loadStudyLessonAssets(
      authorization,
      sessionId,
      concept.conceptId,
    );
    if (this.lessonAssets !== undefined && assets === null) {
      return null;
    }
    const textLesson =
      assets?.text ??
      (selectedLesson.modality === "text"
        ? {
            assetId: selectedLesson.assetId,
            contentHash: selectedLesson.contentHash,
            objectKey: selectedLesson.objectKey,
            servedAt: selectedLesson.servedAt,
            strategyTag: selectedLesson.strategyTag,
          }
        : null);
    if (textLesson === null) {
      return null;
    }
    const content = await this.artifacts.readAuthorizedText({
      authorization,
      lesson: { ...textLesson, modality: "text" },
    });
    if (content === null || sha256(content) !== textLesson.contentHash) {
      return null;
    }
    const presented = assets?.media ?? {
      assetId: textLesson.assetId,
      modality: "text" as const,
      status: "ready" as const,
    };
    return {
      concept: {
        chapterId: concept.chapterId,
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        mastery: concept.mastery,
      },
      content,
      courseId: session.courseId,
      kind:
        concept.reteachLessons.at(-1)?.assetId === textLesson.assetId
          ? "reteach"
          : concept.dueForReview
            ? "review"
            : "advance",
      lesson: {
        assetId: presented.assetId,
        media:
          presented.modality === "text"
            ? null
            : { delivery: null, status: presented.status },
        modality: presented.modality,
        servedAt: textLesson.servedAt,
        sourceSpanCount: concept.sourceSpans.length,
        strategyTag: textLesson.strategyTag,
      },
      sessionId: session.sessionId,
      sourceDocumentId: session.sourceDocumentId,
    };
  }
}

function activeConcept(
  concepts: readonly TutorConceptSnapshot[],
): TutorConceptSnapshot | null {
  return (
    concepts.find((concept) => concept.loopResult !== null) ??
    concepts.find((concept) => concept.reteachLessons.length > 0) ??
    concepts.find(
      (concept) => concept.dueForReview && concept.nextRetestQuestion !== null,
    ) ??
    concepts.find(
      (concept) =>
        concept.latestEligibleAttempt !== null &&
        concept.latestEligibleAttempt.rubricBand !== "correct" &&
        concept.nextRetestQuestion !== null,
    ) ??
    concepts.find(
      (concept) =>
        concept.latestLessonExposureAt === null &&
        concept.lesson !== null &&
        concept.nextRetestQuestion !== null,
    ) ??
    concepts.find(
      (concept) =>
        concept.eligibleAttemptCount > 0 && concept.nextRetestQuestion !== null,
    ) ??
    null
  );
}

function studyState(
  concept: TutorConceptSnapshot,
  hasPersistedLesson: boolean,
  hasReadableLesson: boolean,
): ConnectedStudyView["state"] {
  if (concept.loopResult?.outcome === "retest_succeeded") {
    return "complete";
  }
  if (concept.loopResult?.outcome === "stopped_after_two_replacements") {
    return "review_scheduled";
  }
  if (hasPersistedLesson && !hasReadableLesson) {
    return "lesson_unavailable";
  }
  return hasReadableLesson ? "retest" : "question";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
