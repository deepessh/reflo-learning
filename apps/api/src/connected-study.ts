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

export class ConnectedStudyService {
  constructor(
    private readonly repository: Pick<TutorAgentRepositoryPort, "loadSession">,
    private readonly artifacts: Pick<
      TutorArtifactStorePort,
      "readAuthorizedText"
    >,
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
}

function activeConcept(
  concepts: readonly TutorConceptSnapshot[],
): TutorConceptSnapshot | null {
  return (
    concepts.find((concept) => concept.loopResult !== null) ??
    concepts.find((concept) => concept.reteachLessons.length > 0) ??
    concepts.find((concept) => concept.eligibleAttemptCount > 0) ??
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
