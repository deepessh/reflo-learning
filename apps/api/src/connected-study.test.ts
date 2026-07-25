import { describe, expect, it } from "vitest";

import {
  InMemoryTutorArtifactStore,
  InMemoryTutorRepository,
} from "@reflo/tutor-agent/testing";
import type {
  PersistedReteachLesson,
  TutorSessionSnapshot,
} from "@reflo/tutor-agent";

import { ConnectedStudyService } from "./connected-study";

const authorization = {
  actorId: "user",
  authorizationId: "session-secret",
  ownerScopeId: "scope",
};

describe("connected study projection", () => {
  it("returns an authorized question without leaking object-store keys", async () => {
    const repository = new InMemoryTutorRepository();
    const artifacts = new InMemoryTutorArtifactStore();
    repository.sessions.set("session", sessionFixture());
    const service = new ConnectedStudyService(repository, artifacts);

    const view = await service.load(authorization, "session");

    expect(view).toMatchObject({
      contractVersion: "connected-study-view-v1",
      demoOnly: true,
      question: {
        itemType: "short_answer",
      },
      state: "question",
    });
    expect(JSON.stringify(view)).not.toContain("objectKey");
    expect(JSON.stringify(view)).not.toContain("modelProvenance");
  });

  it("renders only hash-matched authorized lesson content", async () => {
    const repository = new InMemoryTutorRepository();
    const artifacts = new InMemoryTutorArtifactStore();
    const session = sessionFixture();
    const content = "A materially different source-grounded explanation.";
    const contentHash = artifacts.seed(
      "owners/scope/courses/course/assets/reteach.md",
      content,
    );
    repository.sessions.set("session", {
      ...session,
      concepts: [
        {
          ...session.concepts[0]!,
          reteachLessons: [
            {
              assetId: "asset",
              baselineMastery: "0.20000",
              chapterId: "chapter",
              conceptId: "concept",
              contentHash,
              generationId: "generation",
              generationVersion: "reteach-generation-v1",
              modality: "text",
              modelProvenance: {} as PersistedReteachLesson["modelProvenance"],
              objectKey: "owners/scope/courses/course/assets/reteach.md",
              ownerScopeId: "scope",
              replacementOrdinal: 1,
              semanticSimilarity: "0.42000",
              servedAt: "2026-07-24T12:00:00.000Z",
              sessionId: "session",
              sourceSpanIds: ["span"],
              strategyTag: "analogy-v1",
            },
          ],
        },
      ],
    });
    const service = new ConnectedStudyService(repository, artifacts);

    const view = await service.load(authorization, "session");

    expect(view).toMatchObject({
      lesson: {
        content,
        semanticSimilarity: "0.42000",
        strategyTag: "analogy-v1",
      },
      state: "retest",
    });
  });
});

function sessionFixture(): TutorSessionSnapshot {
  return {
    actorId: "user",
    authorizationId: "session-secret",
    concepts: [
      {
        chapterId: "chapter",
        conceptId: "concept",
        conceptName: "Virtual Private Cloud",
        dueForReview: false,
        eligibleAttemptCount: 2,
        latestEligibleAttempt: {
          attemptId: "attempt",
          createdAt: "2026-07-24T12:02:00.000Z",
          eligibleForMastery: true,
          quizItemId: "question-prior",
          rubricBand: "incorrect",
          score: "0.00000",
        },
        latestLessonExposureAt: "2026-07-24T12:00:00.000Z",
        lesson: null,
        loopResult: null,
        mastery: "0.16667",
        nextRetestQuestion: {
          conceptId: "concept",
          difficulty: 2,
          itemId: "question",
          itemType: "short_answer",
          prompt: "What makes a VPC isolated?",
          sourceSpanIds: ["span"],
        },
        reteachLessons: [],
        sourceSpans: [{ id: "span", text: "A VPC is isolated." }],
      },
    ],
    courseId: "course",
    ownerScopeId: "scope",
    sessionId: "session",
    sourceDocumentId: "source",
    status: "active",
    userId: "user",
  };
}
