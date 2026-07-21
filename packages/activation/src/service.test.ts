import { describe, expect, it } from "vitest";

import { createModelRouter } from "@reflo/model-router";
import {
  createScriptedAdapterRegistry,
  InMemoryTraceSink,
} from "@reflo/model-router/testing";

import type {
  AuthorizedActivationCourse,
  GeneratedQuizItem,
} from "./contracts.js";
import {
  ActivationGenerationService,
  normalizeQuizPrompt,
  selectUnseenQuizItems,
} from "./service.js";
import {
  InMemoryActivationRepository,
  InMemoryTextArtifactWriter,
} from "./testing.js";

const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  scope: "00000000-0000-4000-8000-000000000101",
  document: "00000000-0000-4000-8000-000000000201",
  course: "00000000-0000-4000-8000-000000000301",
  curriculum: "00000000-0000-5000-8000-000000000401",
  chapter: "00000000-0000-5000-8000-000000000501",
  conceptA: "00000000-0000-5000-8000-000000000601",
  conceptB: "00000000-0000-5000-8000-000000000602",
  spanA: "00000000-0000-5000-8000-000000000701",
  spanB: "00000000-0000-5000-8000-000000000702",
} as const;

const authorization = {
  actorId: ids.actor,
  authorizationId: "authorization-fixture-1",
  ownerScopeId: ids.scope,
} as const;

describe("activation generation", () => {
  it("plans the first lesson, complete placement quiz, and chapter-one quiz in priority order", async () => {
    const { repository, service } = fixtureService({});

    const first = await service.plan({
      authorization,
      courseId: ids.course,
      environment: "dev",
    });
    const replay = await service.plan({
      authorization,
      courseId: ids.course,
      environment: "dev",
    });

    expect(first.map((operation) => operation.artifactKind)).toEqual([
      "first_text_lesson",
      "placement_quiz",
      "chapter_quiz",
    ]);
    expect(first.map((operation) => operation.priority)).toEqual([1, 2, 3]);
    expect(first.map((operation) => operation.id)).toEqual(
      replay.map((operation) => operation.id),
    );
    expect(repository.operations).toHaveLength(3);
  });

  it("persists a source-backed two-to-three-minute lesson once with complete router provenance", async () => {
    const content = Array.from(
      { length: 400 },
      (_, index) => `word${index}`,
    ).join(" ");
    const { repository, scripted, service, textArtifacts } = fixtureService({
      "lesson.text.v1": [
        {
          type: "result",
          value: {
            content,
            sourceSpanIds: [ids.spanA],
            strategyTag: "worked-example-v1",
          },
        },
      ],
    });
    const plan = await service.plan({
      authorization,
      courseId: ids.course,
      environment: "pilot",
    });
    const operationId = required(plan[0]).id;

    const completed = await service.run({
      authorization,
      courseId: ids.course,
      deadlineMs: 5_000,
      operationId,
    });
    const replay = await service.run({
      authorization,
      courseId: ids.course,
      deadlineMs: 5_000,
      operationId,
    });

    expect(completed).toMatchObject({
      artifactKind: "first_text_lesson",
      attemptCount: 1,
      failureClass: null,
      status: "succeeded",
    });
    expect(replay).toEqual(completed);
    expect(scripted.invocations).toHaveLength(1);
    expect(textArtifacts.objects).toHaveLength(1);
    const lesson = required([...repository.lessons.values()][0]);
    expect(lesson.estimatedReadingMinutes).toBe(2);
    expect(lesson.sourceSpanIds).toEqual([ids.spanA]);
    expect(lesson.modelProvenance).toMatchObject({
      promptId: "lesson-text",
      promptVersion: "1",
      task: "lesson.text.v1",
      validationOutcome: "passed",
    });
    expect(lesson.storage.objectKey).toMatch(
      new RegExp(`^owners/${ids.scope}/courses/${ids.course}/assets/`),
    );
  });

  it("progressively persists complete typed placement and chapter quiz banks", async () => {
    const { repository, service } = fixtureService({
      "assessment.quiz.v1": [
        { type: "result", value: { items: quizItems(10, "placement") } },
        { type: "result", value: { items: quizItems(5, "chapter") } },
      ],
    });
    const plan = await service.plan({
      authorization,
      courseId: ids.course,
      environment: "staging",
    });

    const placement = await service.run({
      authorization,
      courseId: ids.course,
      deadlineMs: 5_000,
      operationId: required(plan[1]).id,
    });
    let statuses = await service.listStatus(authorization, ids.course);
    expect(statuses.map((status) => status.status)).toEqual([
      "queued",
      "succeeded",
      "queued",
    ]);
    const chapter = await service.run({
      authorization,
      courseId: ids.course,
      deadlineMs: 5_000,
      operationId: required(plan[2]).id,
    });

    expect(placement.status).toBe("succeeded");
    expect(chapter.status).toBe("succeeded");
    statuses = await service.listStatus(authorization, ids.course);
    expect(statuses.map((status) => status.status)).toEqual([
      "queued",
      "succeeded",
      "succeeded",
    ]);
    const banks = [...repository.quizBanks.values()];
    expect(banks.map((bank) => bank.items.length)).toEqual([10, 5]);
    for (const bank of banks) {
      expect(new Set(bank.items.map((item) => item.itemType))).toEqual(
        new Set(["multiple_choice", "short_answer", "concept_linking"]),
      );
      expect(bank.modelProvenance).toMatchObject({
        inputSchemaVersion: "quiz-generation-input-v2",
        promptId: "assessment-quiz",
        promptVersion: "2",
        resultSchemaVersion: "quiz-generation-result-v2",
      });
      expect(bank.items.every((item) => item.sourceSpanIds.length > 0)).toBe(
        true,
      );
    }
  });

  it("exposes retryable failure and reuses the operation without duplicating artifacts", async () => {
    const content = Array.from({ length: 500 }, () => "grounded").join(" ");
    const { repository, service } = fixtureService({
      "lesson.text.v1": [
        { safeCode: "unavailable", transient: true, type: "failure" },
        { safeCode: "unavailable", transient: true, type: "failure" },
        {
          type: "result",
          value: {
            content,
            sourceSpanIds: [ids.spanA],
            strategyTag: "analogy-v1",
          },
        },
      ],
    });
    const plan = await service.plan({
      authorization,
      courseId: ids.course,
      environment: "dev",
    });
    const operationId = required(plan[0]).id;

    await expect(
      service.run({
        authorization,
        courseId: ids.course,
        deadlineMs: 5_000,
        operationId,
      }),
    ).resolves.toMatchObject({
      attemptCount: 1,
      failureClass: "provider_failure",
      retryable: true,
      status: "retry_scheduled",
    });
    await expect(
      service.run({
        authorization,
        courseId: ids.course,
        deadlineMs: 5_000,
        operationId,
      }),
    ).resolves.toMatchObject({ attemptCount: 2, status: "succeeded" });
    expect(repository.lessons).toHaveLength(1);
  });

  it("fails duplicate normalized questions permanently", async () => {
    const duplicate = quizItems(10, "duplicate").map((item) => ({
      ...item,
      prompt: "What is a VPC?",
    }));
    const { service } = fixtureService({
      "assessment.quiz.v1": [{ type: "result", value: { items: duplicate } }],
    });
    const plan = await service.plan({
      authorization,
      courseId: ids.course,
      environment: "dev",
    });

    await expect(
      service.run({
        authorization,
        courseId: ids.course,
        deadlineMs: 5_000,
        operationId: required(plan[1]).id,
      }),
    ).resolves.toMatchObject({
      failureClass: "invalid_result",
      retryable: false,
      status: "failed_permanent",
    });
  });

  it("rejects quiz spans that do not support each tagged concept", async () => {
    const mismatched = quizItems(10, "mismatch").map((item, index) =>
      index === 0
        ? { ...item, conceptIds: [ids.conceptA], sourceSpanIds: [ids.spanB] }
        : item,
    );
    const { service } = fixtureService({
      "assessment.quiz.v1": [{ type: "result", value: { items: mismatched } }],
    });
    const plan = await service.plan({
      authorization,
      courseId: ids.course,
      environment: "dev",
    });

    await expect(
      service.run({
        authorization,
        courseId: ids.course,
        deadlineMs: 5_000,
        operationId: required(plan[1]).id,
      }),
    ).resolves.toMatchObject({
      failureClass: "invalid_result",
      status: "failed_permanent",
    });
  });
});

describe("session question de-duplication", () => {
  it("normalizes surface-equivalent prompts and excludes attempted hashes", () => {
    expect(normalizeQuizPrompt("  WHAT—is a VPC?! ")).toBe("what is a vpc");
    const items = quizItems(3, "session").map((item, itemOrder) => ({
      ...item,
      id: `item-${itemOrder}`,
      itemOrder,
      normalizedPromptHash: `hash-${itemOrder}`,
    })) as readonly GeneratedQuizItem[];

    expect(
      selectUnseenQuizItems(items, new Set(["hash-0"]), 2).map(
        (item) => item.id,
      ),
    ).toEqual(["item-1", "item-2"]);
  });
});

function fixtureService(
  plan: Parameters<typeof createScriptedAdapterRegistry>[0],
) {
  const repository = new InMemoryActivationRepository();
  repository.courses.set(ids.course, courseFixture());
  const scripted = createScriptedAdapterRegistry(plan);
  const textArtifacts = new InMemoryTextArtifactWriter();
  const service = new ActivationGenerationService({
    models: createModelRouter({
      adapters: scripted.adapters,
      traceSink: new InMemoryTraceSink(),
    }),
    repository,
    textArtifacts,
  });
  return { repository, scripted, service, textArtifacts };
}

function courseFixture(): AuthorizedActivationCourse {
  return {
    ...authorization,
    chapters: [
      {
        concepts: [
          {
            id: ids.conceptA,
            name: "Virtual private clouds",
            sourceSpans: [{ id: ids.spanA, text: "A VPC is isolated." }],
          },
          {
            id: ids.conceptB,
            name: "Subnets",
            sourceSpans: [{ id: ids.spanB, text: "Subnets divide a VPC." }],
          },
        ],
        id: ids.chapter,
        sourceSpans: [
          { id: ids.spanA, text: "A VPC is isolated." },
          { id: ids.spanB, text: "Subnets divide a VPC." },
        ],
        title: "Networking",
      },
    ],
    courseId: ids.course,
    curriculumGenerationId: ids.curriculum,
    sourceDocumentId: ids.document,
  };
}

function quizItems(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => {
    const itemType = ["multiple_choice", "short_answer", "concept_linking"][
      index % 3
    ];
    const base = {
      conceptIds: [index % 2 === 0 ? ids.conceptA : ids.conceptB],
      difficulty: ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5,
      itemType,
      keyedAnswer: `answer-${index}`,
      prompt: `${prefix} grounded question ${index}?`,
      sourceSpanIds: [index % 2 === 0 ? ids.spanA : ids.spanB],
    };
    return itemType === "short_answer"
      ? { ...base, rubric: `rubric-${index}` }
      : {
          ...base,
          responseOptions: [`answer-${index}`, `distractor-${index}`],
        };
  });
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("missing fixture value");
  }
  return value;
}
