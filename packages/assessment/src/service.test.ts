import { describe, expect, it } from "vitest";

import {
  buildPromptBundle,
  createModelRouter,
  type ShortAnswerGradingResult,
} from "@reflo/model-router";
import {
  createScriptedAdapterRegistry,
  InMemoryTraceSink,
} from "@reflo/model-router/testing";

import type {
  FrozenGradingPolicy,
  GradeShortAnswerCommand,
  KeyedMultipleChoiceQuestion,
  ShortAnswerQuestion,
} from "./contracts.js";
import type { AssessmentError } from "./errors.js";
import { AssessmentService, selectAdaptiveQuestions } from "./service.js";
import { InMemoryAssessmentRepository } from "./testing.js";

const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  scope: "00000000-0000-4000-8000-000000000101",
  course: "00000000-0000-4000-8000-000000000201",
  session: "00000000-0000-4000-8000-000000000301",
  session2: "00000000-0000-4000-8000-000000000302",
  conceptA: "00000000-0000-4000-8000-000000000401",
  conceptB: "00000000-0000-4000-8000-000000000402",
  spanA: "00000000-0000-4000-8000-000000000501",
  spanB: "00000000-0000-4000-8000-000000000502",
} as const;

const authorization = {
  actorId: ids.actor,
  authorizationId: "assessment-test-authorization",
  ownerScopeId: ids.scope,
};

describe("adaptive assessment selection", () => {
  it("targets due and weak concepts, fits difficulty, and never repeats a normalized prompt", () => {
    const questions = [
      selectionQuestion("question-a", ids.conceptA, 1, "hash-a"),
      selectionQuestion("question-b", ids.conceptB, 5, "hash-b"),
      selectionQuestion("question-c", ids.conceptA, 2, "hash-c"),
      selectionQuestion("question-d", ids.conceptB, 4, "hash-c"),
    ];
    const selected = selectAdaptiveQuestions({
      conceptStates: [
        {
          conceptId: ids.conceptA,
          dueAt: "2026-07-24T08:00:00.000Z",
          mastery: "0.30000",
        },
        {
          conceptId: ids.conceptB,
          dueAt: null,
          mastery: "0.80000",
        },
      ],
      limit: 2,
      now: "2026-07-24T09:00:00.000Z",
      questions,
      seenPromptHashes: new Set(["hash-a"]),
    });

    expect(selected.map((question) => question.id)).toEqual([
      "question-c",
      "question-b",
    ]);
    expect(
      new Set(selected.map((question) => question.normalizedPromptHash)).size,
    ).toBe(selected.length);
  });
});

describe("versioned short-answer grading", () => {
  it("admits confident per-concept partial evidence independently and maps only Again/Good", async () => {
    const result: ShortAnswerGradingResult = {
      judgments: [
        scored(ids.conceptA, "partially_correct", 0.97),
        scored(ids.conceptB, "correct", 0.99),
      ],
    };
    const fixture = gradingFixture([result]);
    const command = gradingCommand(fixture.policy, "attempt/confident");

    const finalized = await fixture.service.gradeShortAnswer(command);

    expect(finalized).toMatchObject({
      fallback: null,
      outcome: "graded",
      status: "created",
    });
    expect(finalized.evidence).toEqual([
      expect.objectContaining({
        conceptId: ids.conceptA,
        eligibleForMastery: true,
        fsrsRating: 1,
        rubricBand: "partially_correct",
        score: "0.50000",
      }),
      expect.objectContaining({
        conceptId: ids.conceptB,
        eligibleForMastery: true,
        fsrsRating: 3,
        rubricBand: "correct",
        score: "1.00000",
      }),
    ]);
  });

  it("uses an inclusive exact threshold and abstains the whole attempt if one concept is below it", async () => {
    const result: ShortAnswerGradingResult = {
      judgments: [
        scored(ids.conceptA, "correct", 0.95),
        scored(ids.conceptB, "correct", 0.94999),
      ],
    };
    const fixture = gradingFixture([result]);
    const command = gradingCommand(fixture.policy, "attempt/threshold");

    const finalized = await fixture.service.gradeShortAnswer(command);

    expect(finalized.outcome).toBe("abstained");
    expect(finalized.fallback?.items.map((item) => item.conceptId)).toEqual([
      ids.conceptA,
      ids.conceptB,
    ]);
    expect(finalized.evidence).toEqual([
      expect.objectContaining({
        conceptId: ids.conceptA,
        eligibleForMastery: false,
        fsrsRating: null,
        ineligibilityReason: "attempt_abstained",
      }),
      expect.objectContaining({
        conceptId: ids.conceptB,
        eligibleForMastery: false,
        fsrsRating: null,
        ineligibilityReason: "below_threshold",
      }),
    ]);
  });

  it("treats semantic unanswerable as whole-attempt abstention without a score or rating", async () => {
    const result: ShortAnswerGradingResult = {
      judgments: [
        {
          conceptId: ids.conceptA,
          judgmentKind: "unanswerable",
          reason: "source_conflict",
        },
        scored(ids.conceptB, "correct", 0.99),
      ],
    };
    const fixture = gradingFixture([result]);

    const finalized = await fixture.service.gradeShortAnswer(
      gradingCommand(fixture.policy, "attempt/unanswerable"),
    );

    expect(finalized.outcome).toBe("abstained");
    expect(finalized.evidence[0]).toMatchObject({
      graderConfidence: null,
      ineligibilityReason: "semantic_unanswerable",
      judgmentKind: "unanswerable",
      rubricBand: null,
      score: null,
    });
  });

  it("finalizes invalid model output once and never reinvokes the grader on replay", async () => {
    const fixture = gradingFixture([{ judgments: [] }]);
    const command = gradingCommand(fixture.policy, "attempt/invalid-result");

    const first = await fixture.service.gradeShortAnswer(command);
    const replay = await fixture.service.gradeShortAnswer(command);

    expect(first).toMatchObject({
      evidence: [],
      outcome: "abstained",
      status: "created",
    });
    expect(replay).toMatchObject({
      attemptId: first.attemptId,
      outcome: "abstained",
      status: "replayed",
    });
    expect(fixture.scripted.invocations).toHaveLength(1);
    expect(fixture.traces.traces[0]?.attempts).toHaveLength(1);
    expect(fixture.traces.traces[0]?.attempts[0]?.outcome).toBe(
      "validation_error",
    );
  });

  it("rejects conflicting reuse of a finalized idempotency key without reinvoking the grader", async () => {
    const fixture = gradingFixture([
      {
        judgments: [
          scored(ids.conceptA, "correct", 0.99),
          scored(ids.conceptB, "correct", 0.99),
        ],
      },
    ]);
    const command = gradingCommand(fixture.policy, "attempt/conflict");
    await fixture.service.gradeShortAnswer(command);

    await expect(
      fixture.service.gradeShortAnswer({
        ...command,
        answer: "A materially different synthetic answer.",
      }),
    ).rejects.toMatchObject<Partial<AssessmentError>>({
      code: "conflicting_duplicate",
    });
    expect(fixture.scripted.invocations).toHaveLength(1);
  });

  it("uses one static policy identity to grade distinct answers", async () => {
    const fixture = gradingFixture([
      {
        judgments: [
          scored(ids.conceptA, "correct", 0.99),
          scored(ids.conceptB, "correct", 0.99),
        ],
      },
      {
        judgments: [
          scored(ids.conceptA, "partially_correct", 0.99),
          scored(ids.conceptB, "correct", 0.99),
        ],
      },
    ]);
    fixture.repository.seedAuthorizedSession({
      authorization,
      fallbackCandidates: fallbackQuestions(),
      questions: [shortAnswerQuestion()],
      sessionId: ids.session2,
    });
    await fixture.service.gradeShortAnswer(
      gradingCommand(fixture.policy, "attempt/policy-binding-a"),
    );
    const second = await fixture.service.gradeShortAnswer({
      ...gradingCommand(fixture.policy, "attempt/policy-binding-b"),
      answer: "A different answer that is still graded under the same policy.",
      sessionId: ids.session2,
    });

    expect(second.outcome).toBe("graded");
    expect(fixture.scripted.invocations).toHaveLength(2);
    expect(fixture.repository.policyBindings.size).toBe(1);
  });

  it("rejects an unauthorized question before invoking the model", async () => {
    const fixture = gradingFixture([]);
    const command = gradingCommand(fixture.policy, "attempt/bad-rubric");

    await expect(
      fixture.service.gradeShortAnswer({
        ...command,
        questionId: "unauthorized-question",
      }),
    ).rejects.toMatchObject<Partial<AssessmentError>>({
      code: "authorization_denied",
    });
    expect(fixture.scripted.invocations).toHaveLength(0);
  });

  it("coalesces concurrent duplicate submissions before model invocation", async () => {
    const question = shortAnswerQuestion();
    const repository = new InMemoryAssessmentRepository();
    repository.seedAuthorizedSession({
      authorization,
      fallbackCandidates: fallbackQuestions(),
      questions: [question],
      sessionId: ids.session,
    });
    const policy = gradingFixture([]).policy;
    let releaseModel!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let invocations = 0;
    const service = new AssessmentService({
      models: {
        async execute(_task, input) {
          invocations += 1;
          await gate;
          const prompt = buildPromptBundle(
            "assessment.grade-short-answer.v1",
            input,
          );
          return {
            provenance: {
              adapterVersion: "concurrency-test-adapter-v1",
              evidenceClassification: "authoritative",
              ...policy.expectedModelProvenance,
              promptDigest: prompt.digest,
              requestedSelector: "qwen.grading",
              task: "assessment.grade-short-answer.v1",
              validationOutcome: "passed",
            },
            value: {
              judgments: [
                scored(ids.conceptA, "correct", 0.99),
                scored(ids.conceptB, "correct", 0.99),
              ],
            },
          };
        },
      },
      repository,
    });
    const command = gradingCommand(policy, "attempt/concurrent");
    const first = service.gradeShortAnswer(command);
    await Promise.resolve();
    const duplicate = service.gradeShortAnswer(command);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(invocations).toBe(1);
    releaseModel();
    const [created, replayed] = await Promise.all([first, duplicate]);
    expect(created.status).toBe("created");
    expect(replayed.status).toBe("replayed");
    expect(invocations).toBe(1);
  });

  it("uses authoritative session history when selecting fallbacks", async () => {
    const fixture = gradingFixture([]);
    fixture.repository.presentedHashes.set(
      ids.session,
      new Set([fallbackQuestions()[0]!.normalizedPromptHash]),
    );

    await expect(
      fixture.service.gradeShortAnswer(
        gradingCommand(fixture.policy, "attempt/repeated-fallback"),
      ),
    ).rejects.toMatchObject<Partial<AssessmentError>>({
      code: "fallback_unavailable",
    });
    expect(fixture.scripted.invocations).toHaveLength(0);
  });

  it("reuses stable fallback lineage and admits only keyed replacement evidence", async () => {
    const fixture = gradingFixture([
      {
        judgments: [
          scored(ids.conceptA, "correct", 0.2),
          scored(ids.conceptB, "incorrect", 0.3),
        ],
      },
    ]);
    const original = await fixture.service.gradeShortAnswer(
      gradingCommand(fixture.policy, "attempt/fallback"),
    );
    const bundle = original.fallback!;
    const item = bundle.items[0]!;
    expect("keyedAnswer" in item.question).toBe(false);

    const replacement = await fixture.service.gradeReplacement({
      answer: "A logically isolated network",
      authorization,
      bundleId: bundle.id,
      idempotencyKey: "replacement/concept-a",
      itemId: item.id,
      policy: fixture.policy,
      sessionId: ids.session,
    });
    const replay = await fixture.service.gradeReplacement({
      answer: "A logically isolated network",
      authorization,
      bundleId: bundle.id,
      idempotencyKey: "replacement/concept-a",
      itemId: item.id,
      policy: fixture.policy,
      sessionId: ids.session,
    });

    expect(original.evidence.every((entry) => !entry.eligibleForMastery)).toBe(
      true,
    );
    expect(replacement.evidence).toEqual([
      expect.objectContaining({
        conceptId: ids.conceptA,
        eligibleForMastery: true,
        fsrsRating: 3,
        graderConfidence: null,
        gradingMethod: "keyed_mc",
        score: "1.00000",
      }),
    ]);
    expect(replay).toMatchObject({
      attemptId: replacement.attemptId,
      status: "replayed",
    });
  });
});

function gradingFixture(results: readonly unknown[]) {
  const question = shortAnswerQuestion();
  const answer = "A VPC is isolated and subnets divide its address space.";
  const prompt = buildPromptBundle("assessment.grade-short-answer.v1", {
    answer,
    question: question.prompt,
    rubrics: question.rubrics,
    sourceSpans: question.sourceSpans,
  });
  const policy: FrozenGradingPolicy = {
    calibrationEvidenceId: "rights-cleared-calibration-fixture-v1",
    confidenceThreshold: "0.95000",
    expectedModelProvenance: {
      effectiveModel: "qwen-plus",
      effectiveModelVersion: "fixture-version-1",
      generationParametersVersion: "grading-generation-parameters-v2",
      inputSchemaVersion: "short-answer-grading-input-v2",
      promptDefinitionDigest: prompt.definitionDigest,
      promptId: "assessment-grade-short-answer",
      promptVersion: "3",
      resultSchemaVersion: "short-answer-judgment-result-v2",
      routePolicyVersion: "route-policy-v6",
    },
    gradingPolicyVersion: "grading-policy-v1",
    ratingMappingVersion: "rating-mapping-v1",
  };
  const scripted = createScriptedAdapterRegistry({
    "assessment.grade-short-answer.v1": results.map((value) => ({
      type: "result" as const,
      value,
    })),
  });
  const traces = new InMemoryTraceSink();
  const repository = new InMemoryAssessmentRepository();
  repository.seedAuthorizedSession({
    authorization,
    fallbackCandidates: fallbackQuestions(),
    questions: [question],
    sessionId: ids.session,
  });
  const service = new AssessmentService({
    models: createModelRouter({
      adapters: scripted.adapters,
      traceSink: traces,
    }),
    repository,
  });
  return { policy, repository, scripted, service, traces };
}

function gradingCommand(
  policy: FrozenGradingPolicy,
  idempotencyKey: string,
): GradeShortAnswerCommand {
  return {
    answer: "A VPC is isolated and subnets divide its address space.",
    authorization,
    deadlineMs: 1_000,
    idempotencyKey,
    policy,
    questionId: shortAnswerQuestion().id,
    sessionId: ids.session,
  };
}

function shortAnswerQuestion(): ShortAnswerQuestion {
  return {
    conceptIds: [ids.conceptA, ids.conceptB],
    courseId: ids.course,
    difficulty: 3,
    id: "short-answer-question",
    itemType: "short_answer",
    normalizedPromptHash: "a".repeat(64),
    prompt: "Explain VPC isolation and the role of subnets.",
    rubrics: [
      {
        conceptId: ids.conceptA,
        materialContradictions: ["A VPC is public by default."],
        requiredCriteria: ["States that a VPC provides isolation."],
        rubricId: "vpc-isolation-rubric",
        rubricVersion: "1",
        sourceSpanIds: [ids.spanA],
      },
      {
        conceptId: ids.conceptB,
        materialContradictions: ["Subnets are separate cloud accounts."],
        requiredCriteria: ["States that subnets divide an address space."],
        rubricId: "subnet-rubric",
        rubricVersion: "1",
        sourceSpanIds: [ids.spanB],
      },
    ],
    sourceSpans: [
      { id: ids.spanA, text: "A VPC is a logically isolated network." },
      { id: ids.spanB, text: "Subnets partition the VPC address space." },
    ],
  };
}

function fallbackQuestions(): readonly KeyedMultipleChoiceQuestion[] {
  return [
    {
      conceptIds: [ids.conceptA],
      courseId: ids.course,
      difficulty: 2,
      id: "fallback-a",
      itemType: "multiple_choice",
      keyedAnswer: "A logically isolated network",
      normalizedPromptHash: "b".repeat(64),
      prompt: "What does a VPC provide?",
      responseOptions: ["A logically isolated network", "A public DNS zone"],
      rubricId: "vpc-isolation-rubric",
      rubricVersion: "1",
      sourceSpans: [
        { id: ids.spanA, text: "A VPC is a logically isolated network." },
      ],
    },
    {
      conceptIds: [ids.conceptB],
      courseId: ids.course,
      difficulty: 2,
      id: "fallback-b",
      itemType: "multiple_choice",
      keyedAnswer: "Partition the VPC address space",
      normalizedPromptHash: "c".repeat(64),
      prompt: "What is the role of a subnet?",
      responseOptions: [
        "Partition the VPC address space",
        "Create a separate account",
      ],
      rubricId: "subnet-rubric",
      rubricVersion: "1",
      sourceSpans: [
        { id: ids.spanB, text: "Subnets partition the VPC address space." },
      ],
    },
  ];
}

function scored(
  conceptId: string,
  rubricBand: "correct" | "incorrect" | "partially_correct",
  confidence: number,
) {
  return {
    conceptId,
    confidence,
    judgmentKind: "scored" as const,
    rubricBand,
    score:
      rubricBand === "correct"
        ? 1
        : rubricBand === "partially_correct"
          ? 0.5
          : 0,
  };
}

function selectionQuestion(
  id: string,
  conceptId: string,
  difficulty: 1 | 2 | 3 | 4 | 5,
  normalizedPromptHash: string,
) {
  return {
    conceptIds: [conceptId] as const,
    courseId: ids.course,
    difficulty,
    id,
    itemType: "concept_linking" as const,
    normalizedPromptHash,
    prompt: id,
    sourceSpans: [{ id: ids.spanA, text: "source" }],
  };
}
