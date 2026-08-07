import { createHash } from "node:crypto";

import {
  createModelRouter,
  type ScriptedAdapterPlan,
} from "@reflo/model-router";
import {
  createScriptedAdapterRegistry,
  InMemoryTraceSink,
} from "@reflo/model-router/testing";
import { describe, expect, it } from "vitest";

import {
  RETEACH_SIMILARITY_THRESHOLD,
  TutorAgentService,
  semanticSimilarity,
  type PersistedReteachLesson,
  type TutorAgentError,
  type TutorConceptSnapshot,
  type TutorSessionSnapshot,
} from "./index.js";
import {
  InMemoryTutorArtifactStore,
  InMemoryTutorRepository,
  InMemoryTutorRetrieval,
  InMemoryTutorScheduler,
} from "./testing.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  authorization: "20000000-0000-4000-8000-000000000001",
  chapter: "30000000-0000-4000-8000-000000000001",
  concept: "40000000-0000-4000-8000-000000000001",
  course: "50000000-0000-4000-8000-000000000001",
  foreignQuestion: "a0000000-0000-4000-8000-000000000002",
  question: "a0000000-0000-4000-8000-000000000001",
  scope: "60000000-0000-4000-8000-000000000001",
  session: "70000000-0000-4000-8000-000000000001",
  source: "80000000-0000-4000-8000-000000000001",
  span: "90000000-0000-4000-8000-000000000001",
  spanSupplement: "90000000-0000-4000-8000-000000000002",
} as const;

const authorization = {
  actorId: ids.actor,
  authorizationId: ids.authorization,
  ownerScopeId: ids.scope,
};

describe("TutorAgentService", () => {
  it("fires the exact stored-evidence trigger and serves a materially different grounded lesson", async () => {
    const fixture = createFixture();
    const initial = fixture.repository.sessions.get(ids.session)!;
    const action = await fixture.service.nextAction({
      authorization,
      deadlineMs: 5_000,
      sessionId: ids.session,
    });

    expect(action).toMatchObject({
      conceptId: ids.concept,
      kind: "reteach",
      lesson: {
        baselineMastery: "0.16667",
        replacementOrdinal: 1,
        semanticSimilarity: "0.00000",
        strategyTag: "worked-example-v1",
      },
    });
    expect(initial.concepts[0]!.mastery).toBe("0.16667");
    expect(
      fixture.repository.sessions.get(ids.session)!.concepts[0]!.mastery,
    ).toBe("0.16667");
    expect(fixture.artifacts.objects.size).toBe(2);
  });

  it.each(
    [
      {
        change: { eligibleAttemptCount: 1 },
        expected: { conceptId: ids.concept, kind: "review" },
        label: "two eligible attempts",
      },
      {
        change: { latestLessonExposureAt: null },
        expected: { conceptId: ids.concept, kind: "review" },
        label: "lesson exposure",
      },
      {
        change: { mastery: "0.60000" },
        label: "mastery strictly below 0.60",
      },
      {
        change: {
          latestEligibleAttempt: {
            attemptId: "a",
            createdAt: "2026-07-24T12:02:00.000Z",
            eligibleForMastery: true,
            quizItemId: "q",
            rubricBand: "correct",
            score: "1.00000",
          },
        },
        label: "a failing latest confident attempt",
      },
    ].map((testCase) => ({
      expected: { kind: "session_complete" } as const,
      ...testCase,
    })),
  )("does not re-teach without $label", async ({ change, expected }) => {
    const fixture = createFixture({
      concept: change as Partial<TutorConceptSnapshot>,
    });
    await expect(
      fixture.service.nextAction({
        authorization,
        deadlineMs: 5_000,
        sessionId: ids.session,
      }),
    ).resolves.toEqual(expected);
    expect(fixture.artifacts.objects.size).toBe(1);
    if (expected.kind === "session_complete") {
      expect(fixture.repository.completedSessions).toEqual([ids.session]);
    }
  });

  it("skips concepts without an available lesson or follow-up question", async () => {
    const fixture = createFixture();
    const session = fixture.repository.sessions.get(ids.session)!;
    const unavailable = {
      ...session.concepts[0]!,
      latestLessonExposureAt: null,
      lesson: null,
      nextRetestQuestion: null,
    };
    const actionable = {
      ...session.concepts[0]!,
      conceptId: "actionable-concept",
      eligibleAttemptCount: 0,
      latestEligibleAttempt: null,
      latestLessonExposureAt: null,
      mastery: "0.25000" as const,
    };
    fixture.repository.sessions.set(ids.session, {
      ...session,
      concepts: [unavailable, actionable],
    });

    await expect(next(fixture.service)).resolves.toEqual({
      conceptId: "actionable-concept",
      kind: "advance",
    });
  });

  it("completes the session when no remaining concept is actionable", async () => {
    const fixture = createFixture({
      concept: {
        latestLessonExposureAt: null,
        lesson: null,
        nextRetestQuestion: null,
      },
    });

    await expect(next(fixture.service)).resolves.toEqual({
      kind: "session_complete",
    });
    expect(fixture.repository.completedSessions).toEqual([ids.session]);
  });

  it("requires strategy change and similarity strictly below 0.85", async () => {
    const sameStrategy = createFixture({
      lessonResult: {
        content: "different words",
        sourceSpanIds: [ids.span],
        strategyTag: "analogy-v1",
      },
    });
    await expect(next(sameStrategy.service)).rejects.toMatchObject({
      code: "invalid_result",
    });

    expect(
      semanticSimilarity(
        embeddingResult([1, 0], [0.85, Math.sqrt(1 - 0.85 ** 2)]),
      ),
    ).toBeCloseTo(RETEACH_SIMILARITY_THRESHOLD, 10);
    const boundary = createFixture({
      embedding: [0.85, Math.sqrt(1 - 0.85 ** 2)],
    });
    await expect(next(boundary.service)).rejects.toMatchObject({
      code: "invalid_result",
    });
  });

  it("offers a re-test after serving the replacement", async () => {
    const fixture = createFixture({
      concept: { reteachLessons: [reteach(1)] },
    });
    await expect(next(fixture.service)).resolves.toMatchObject({
      conceptId: ids.concept,
      kind: "retest",
      question: { itemId: ids.question },
    });
  });

  it("records the evidence-only mastery delta after a correct re-test", async () => {
    const fixture = createFixture({
      concept: {
        latestEligibleAttempt: {
          attemptId: "retest-correct",
          createdAt: "2026-07-24T12:06:00.000Z",
          eligibleForMastery: true,
          quizItemId: "question-retest",
          rubricBand: "correct",
          score: "1.00000",
        },
        mastery: "0.28571",
        reteachLessons: [reteach(1)],
      },
    });
    await expect(next(fixture.service)).resolves.toEqual({
      kind: "retest_succeeded",
      result: {
        completedAt: "2026-07-24T12:10:00.000Z",
        conceptId: ids.concept,
        evidenceAttemptId: "retest-correct",
        finalMastery: "0.28571",
        initialMastery: "0.16667",
        masteryDelta: "0.11904",
        outcome: "retest_succeeded",
        replacementCount: 1,
      },
    });
    expect(fixture.repository.succeeded).toHaveLength(1);
  });

  it("serves at most two replacements, then schedules a later review", async () => {
    const afterFirstFailure = createFixture({
      concept: {
        latestEligibleAttempt: {
          attemptId: "retest-failed-1",
          createdAt: "2026-07-24T12:06:00.000Z",
          eligibleForMastery: true,
          quizItemId: "question-retest",
          rubricBand: "incorrect",
          score: "0.00000",
        },
        mastery: "0.14286",
        reteachLessons: [reteach(1)],
      },
    });
    await expect(next(afterFirstFailure.service)).resolves.toMatchObject({
      kind: "reteach",
      lesson: { replacementOrdinal: 2 },
    });

    const afterSecondFailure = createFixture({
      concept: {
        latestEligibleAttempt: {
          attemptId: "retest-failed-2",
          createdAt: "2026-07-24T12:09:00.000Z",
          eligibleForMastery: true,
          quizItemId: "question-retest",
          rubricBand: "incorrect",
          score: "0.00000",
        },
        mastery: "0.12500",
        reteachLessons: [reteach(1), reteach(2, "2026-07-24T12:08:00.000Z")],
      },
    });
    await expect(next(afterSecondFailure.service)).resolves.toMatchObject({
      kind: "review_scheduled",
      nextDeliveryAt: "2026-07-25T09:00:00.000Z",
      result: {
        outcome: "stopped_after_two_replacements",
        replacementCount: 2,
      },
    });
    expect(afterSecondFailure.scheduler.requests).toEqual([
      {
        causationId: "retest-failed-2",
        conceptId: ids.concept,
        sessionId: ids.session,
      },
    ]);
  });

  it("returns only server-resolved citations and records a sanitized question event", async () => {
    const fixture = createFixture({ tutorAnswer: "grounded" });
    fixture.retrieval.results = [
      {
        id: ids.span,
        sectionPath: ["Networking", "VPC"],
        text: "A VPC is an isolated virtual network.",
      },
    ];
    const answer = await fixture.service.ask({
      authorization,
      courseId: ids.course,
      deadlineMs: 5_000,
      idempotencyKey: "test/tutor-question/v1/one",
      question: "What is a VPC?",
      sessionId: ids.session,
      sourceDocumentId: ids.source,
    });
    expect(answer).toEqual({
      citations: [
        { sectionPath: ["Networking", "VPC"], sourceSpanId: ids.span },
      ],
      content: "A VPC is an isolated network.",
      kind: "answer",
    });
    expect(fixture.repository.questions).toEqual([
      {
        idempotencyKey: "test/tutor-question/v1/one",
        resultKind: "answer",
        sessionId: ids.session,
        sourceSpanIds: [ids.span],
      },
    ]);
    expect(JSON.stringify(fixture.repository.questions)).not.toContain(
      "What is a VPC?",
    );
  });

  it("prefers server-authorized assessment evidence before retrieval supplements", async () => {
    const fixture = createFixture({ tutorAnswer: "grounded" });
    fixture.retrieval.preferredResults.set(ids.span, {
      id: ids.span,
      sectionPath: ["Agents", "Components"],
      text: "An Agent has a brain and a body.",
    });
    fixture.retrieval.results = [
      {
        id: ids.spanSupplement,
        sectionPath: ["Agents", "Tools"],
        text: "Tools let Agents act in their environment.",
      },
    ];

    await expect(
      fixture.service.ask({
        authorization,
        contextQuestionId: ids.question,
        courseId: ids.course,
        deadlineMs: 5_000,
        idempotencyKey: "test/tutor-question/v1/context",
        question: "Why are tools described as the Agent's body?",
        sessionId: ids.session,
        sourceDocumentId: ids.source,
      }),
    ).resolves.toMatchObject({
      citations: [{ sourceSpanId: ids.span }],
      kind: "answer",
    });
    expect(fixture.retrieval.requests).toEqual([
      expect.objectContaining({ preferredSourceSpanIds: [ids.span] }),
    ]);
    expect(
      fixture.scripted.invocations.find(
        (invocation) => invocation.task === "tutor.answer.v1",
      ),
    ).toMatchObject({
      input: {
        sourceSpans: [{ id: ids.span }, { id: ids.spanSupplement }],
      },
    });
  });

  it("does not let unrelated same-course question context steer Tutor evidence", async () => {
    const fixture = createFixture({ tutorAnswer: "grounded" });
    fixture.repository.questionSourceSpans.set(ids.foreignQuestion, {
      courseId: ids.course,
      sessionId: ids.session,
      sourceDocumentId: ids.source,
      sourceSpanIds: ["foreign-span"],
    });
    fixture.retrieval.results = [
      { id: ids.span, sectionPath: ["VPC"], text: "authorized" },
    ];

    await expect(
      fixture.service.ask({
        authorization,
        contextQuestionId: ids.foreignQuestion,
        courseId: ids.course,
        deadlineMs: 5_000,
        idempotencyKey: "test/tutor-question/v1/mismatched-context",
        question: "What is a VPC?",
        sessionId: ids.session,
        sourceDocumentId: ids.source,
      }),
    ).resolves.toMatchObject({ kind: "answer" });
    expect(fixture.retrieval.requests[0]).not.toHaveProperty(
      "preferredSourceSpanIds",
    );
    expect(JSON.stringify(fixture.scripted.invocations)).not.toContain(
      "foreign-span",
    );
  });

  it("allows question context already recorded in the same session", async () => {
    const fixture = createFixture({ tutorAnswer: "grounded" });
    fixture.repository.questionSourceSpans.set(ids.foreignQuestion, {
      courseId: ids.course,
      sessionId: ids.session,
      sourceDocumentId: ids.source,
      sourceSpanIds: ["recorded-span"],
    });
    fixture.repository.recordedQuestionIds.add(
      `${ids.session}:${ids.foreignQuestion}`,
    );
    fixture.retrieval.preferredResults.set("recorded-span", {
      id: "recorded-span",
      sectionPath: ["Earlier question"],
      text: "Evidence from an earlier question in this session.",
    });
    fixture.retrieval.results = [
      { id: ids.span, sectionPath: ["VPC"], text: "authorized" },
    ];

    await expect(
      fixture.service.ask({
        authorization,
        contextQuestionId: ids.foreignQuestion,
        courseId: ids.course,
        deadlineMs: 5_000,
        idempotencyKey: "test/tutor-question/v1/recorded-context",
        question: "Can you clarify my earlier answer?",
        sessionId: ids.session,
        sourceDocumentId: ids.source,
      }),
    ).resolves.toMatchObject({ kind: "answer" });
    expect(fixture.retrieval.requests[0]).toMatchObject({
      preferredSourceSpanIds: ["recorded-span"],
    });
  });

  it("keeps an honest model not_found even with preferred question evidence", async () => {
    const fixture = createFixture({ tutorAnswer: "not_found" });
    fixture.retrieval.preferredResults.set(ids.span, {
      id: ids.span,
      sectionPath: ["VPC"],
      text: "Authorized but insufficient evidence.",
    });

    await expect(
      fixture.service.ask({
        authorization,
        contextQuestionId: ids.question,
        courseId: ids.course,
        deadlineMs: 5_000,
        idempotencyKey: "test/tutor-question/v1/not-found",
        question: "What is unsupported?",
        sessionId: ids.session,
        sourceDocumentId: ids.source,
      }),
    ).resolves.toEqual({ kind: "not_found" });
    expect(fixture.repository.questions).toEqual([
      {
        idempotencyKey: "test/tutor-question/v1/not-found",
        resultKind: "not_found",
        sessionId: ids.session,
        sourceSpanIds: [],
      },
    ]);
  });

  it("fails closed on a model-supplied unauthorized citation", async () => {
    const fixture = createFixture({ tutorAnswer: "forged" });
    fixture.retrieval.results = [
      { id: ids.span, sectionPath: ["VPC"], text: "authorized" },
    ];
    await expect(
      fixture.service.ask({
        authorization,
        courseId: ids.course,
        deadlineMs: 5_000,
        idempotencyKey: "test/tutor-question/v1/forged",
        question: "What is a VPC?",
        sessionId: ids.session,
        sourceDocumentId: ids.source,
      }),
    ).rejects.toMatchObject({ code: "invalid_result" });
    expect(fixture.repository.questions).toHaveLength(0);
  });

  it("fails closed when session authorization does not match", async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.nextAction({
        authorization: { ...authorization, ownerScopeId: "forged" },
        deadlineMs: 5_000,
        sessionId: ids.session,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<TutorAgentError>>({
        code: "authorization_denied",
      }),
    );
  });
});

function createFixture(
  options: {
    readonly concept?: Partial<TutorConceptSnapshot>;
    readonly embedding?: readonly [number, number];
    readonly lessonResult?: {
      readonly content: string;
      readonly sourceSpanIds: readonly string[];
      readonly strategyTag: string;
    };
    readonly tutorAnswer?: "forged" | "grounded" | "not_found";
  } = {},
) {
  const repository = new InMemoryTutorRepository();
  const artifacts = new InMemoryTutorArtifactStore();
  const retrieval = new InMemoryTutorRetrieval();
  const scheduler = new InMemoryTutorScheduler();
  const initialContent = "A VPC isolates a network with boundaries.";
  const contentHash = artifacts.seed("lessons/original.md", initialContent);
  const session = sessionFixture(contentHash, options.concept);
  repository.sessions.set(ids.session, session);
  repository.questionSourceSpans.set(ids.question, {
    courseId: ids.course,
    sessionId: ids.session,
    sourceDocumentId: ids.source,
    sourceSpanIds: [ids.span],
  });
  for (const lesson of session.concepts.flatMap(
    (concept) => concept.reteachLessons,
  )) {
    artifacts.seed(
      lesson.objectKey,
      `replacement-${lesson.replacementOrdinal}`,
    );
  }
  const lessonResult = options.lessonResult ?? {
    content: "Picture a fenced campus with guarded gates and private roads.",
    sourceSpanIds: [ids.span],
    strategyTag: "worked-example-v1",
  };
  const plan: ScriptedAdapterPlan = {
    "embedding.document.v1": [
      {
        type: "result",
        value: embeddingResult([1, 0], options.embedding ?? [0, 1]),
      },
    ],
    "lesson.reteach.v1": [{ type: "result", value: lessonResult }],
    "tutor.answer.v1":
      options.tutorAnswer === undefined
        ? []
        : [
            {
              type: "result",
              value:
                options.tutorAnswer === "not_found"
                  ? { kind: "not_found" }
                  : {
                      content: "A VPC is an isolated network.",
                      kind: "answer",
                      sourceSpanIds:
                        options.tutorAnswer === "grounded"
                          ? [ids.span]
                          : ["forged"],
                    },
            },
          ],
  };
  const scripted = createScriptedAdapterRegistry(plan);
  const models = createModelRouter({
    adapters: scripted.adapters,
    callId: () => "call-1",
    deployment: "staging",
    traceSink: new InMemoryTraceSink(),
  });
  return {
    artifacts,
    repository,
    retrieval,
    scheduler,
    scripted,
    service: new TutorAgentService({
      artifacts,
      models,
      repository,
      retrieval,
      scheduler,
    }),
  };
}

function sessionFixture(
  contentHash: string,
  conceptOverrides: Partial<TutorConceptSnapshot> = {},
): TutorSessionSnapshot {
  return {
    actorId: ids.actor,
    authorizationId: ids.authorization,
    concepts: [
      {
        chapterId: ids.chapter,
        conceptId: ids.concept,
        conceptName: "Virtual Private Cloud",
        dueForReview: false,
        eligibleAttemptCount: 2,
        latestEligibleAttempt: {
          attemptId: "attempt-failed",
          createdAt: "2026-07-24T12:02:00.000Z",
          eligibleForMastery: true,
          quizItemId: "question-failed",
          rubricBand: "incorrect",
          score: "0.00000",
        },
        latestLessonExposureAt: "2026-07-24T12:00:00.000Z",
        lesson: {
          assetId: "lesson-original",
          contentHash,
          modality: "text",
          objectKey: "lessons/original.md",
          servedAt: "2026-07-24T12:00:00.000Z",
          strategyTag: "analogy-v1",
        },
        loopResult: null,
        mastery: "0.16667",
        nextRetestQuestion: {
          conceptId: ids.concept,
          difficulty: 2,
          itemId: ids.question,
          itemType: "multiple_choice",
          prompt: "Which statement best describes a VPC?",
          responseOptions: ["An isolated network", "A storage bucket"],
          sourceSpanIds: [ids.span],
        },
        reteachLessons: [],
        sourceSpans: [
          { id: ids.span, text: "A VPC is an isolated virtual network." },
        ],
        ...conceptOverrides,
      },
    ],
    courseId: ids.course,
    ownerScopeId: ids.scope,
    sessionId: ids.session,
    sourceDocumentId: ids.source,
    status: "active",
    userId: ids.actor,
  };
}

function reteach(
  ordinal: 1 | 2,
  servedAt = "2026-07-24T12:05:00.000Z",
): PersistedReteachLesson {
  const content = `replacement-${ordinal}`;
  return {
    assetId: `asset-${ordinal}`,
    baselineMastery: "0.16667",
    chapterId: ids.chapter,
    conceptId: ids.concept,
    contentHash: createHash("sha256").update(content).digest("hex"),
    generationId: `generation-${ordinal}`,
    generationVersion: "reteach-generation-v1",
    modality: "text",
    modelProvenance: {} as PersistedReteachLesson["modelProvenance"],
    objectKey: `lessons/reteach-${ordinal}.md`,
    ownerScopeId: ids.scope,
    replacementOrdinal: ordinal,
    semanticSimilarity: "0.10000",
    servedAt,
    sessionId: ids.session,
    sourceSpanIds: [ids.span],
    strategyTag: `strategy-${ordinal}`,
  };
}

function embeddingResult(left: readonly number[], right: readonly number[]) {
  const fill = (input: readonly number[]) => [
    ...input,
    ...Array.from({ length: 1_024 - input.length }, () => 0),
  ];
  return {
    metadata: {
      dimensions: 1_024 as const,
      endpoint: "https://model.example/v1",
      inputMode: "document" as const,
      providerIdentifier: "text-embedding-v4",
      providerRequestId: "request-1",
      region: "test-region",
    },
    vectors: [fill(left), fill(right)],
  };
}

function next(service: TutorAgentService) {
  return service.nextAction({
    authorization,
    deadlineMs: 5_000,
    sessionId: ids.session,
  });
}
