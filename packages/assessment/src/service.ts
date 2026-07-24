import {
  ModelRouterError,
  type ModelCallProvenance,
  type ShortAnswerJudgment,
  type ShortAnswerRubricBand,
} from "@reflo/model-router";
import { canonicalJson, sha256, stableUuid } from "@reflo/retrieval";

import {
  ASSESSMENT_SELECTION_VERSION,
  GRADING_POLICY_VERSION,
  RATING_MAPPING_VERSION,
  REPLACEMENT_CONTRACT_VERSION,
  type AdaptiveSelectionInput,
  type AssessmentEvidenceCandidate,
  type AssessmentFinalizationView,
  type FrozenGradingPolicy,
  type GradeReplacementCommand,
  type GradeShortAnswerCommand,
  type KeyedMultipleChoiceQuestion,
  type ReplacementBundle,
  type ReplacementItem,
  type SelectableAssessmentQuestion,
  type ShortAnswerQuestion,
} from "./contracts.js";
import { AssessmentError } from "./errors.js";
import type {
  AssessmentModelRouterPort,
  AssessmentRepositoryPort,
} from "./ports.js";

const UNIT_SCALE = 100_000;
type LlmEvidenceCandidate = Exclude<
  AssessmentEvidenceCandidate,
  { readonly gradingMethod: "keyed_mc" }
>;

export class AssessmentService {
  constructor(
    private readonly dependencies: {
      readonly models: AssessmentModelRouterPort;
      readonly repository: AssessmentRepositoryPort;
    },
  ) {}

  async gradeShortAnswer(
    command: GradeShortAnswerCommand,
  ): Promise<AssessmentFinalizationView> {
    validateCommand(command);
    const requestDigest = shortAnswerRequestDigest(command);
    const replay = await this.dependencies.repository.loadFinalization(
      command.authorization,
      command.idempotencyKey,
    );
    if (replay !== null) {
      if (replay.requestDigest !== requestDigest) {
        throw new AssessmentError("conflicting_duplicate");
      }
      return { ...replay, status: "replayed" };
    }

    const attemptId = stableUuid({
      idempotencyKey: command.idempotencyKey,
      questionId: command.question.id,
      sessionId: command.sessionId,
      version: GRADING_POLICY_VERSION,
    });
    const fallback = buildReplacementBundle(command, attemptId);
    let routed;
    try {
      routed = await this.dependencies.models.execute(
        "assessment.grade-short-answer.v1",
        {
          answer: command.answer,
          question: command.question.prompt,
          rubrics: command.question.rubrics,
          sourceSpans: command.question.sourceSpans,
        },
        { deadlineMs: command.deadlineMs },
      );
    } catch (error) {
      if (
        !(error instanceof ModelRouterError) ||
        error.code !== "invalid_result"
      ) {
        throw error;
      }
      return this.dependencies.repository.finalizeShortAnswer(
        command.authorization,
        {
          answer: command.answer,
          attemptId,
          evidence: [],
          fallback,
          idempotencyKey: command.idempotencyKey,
          learnerMessage:
            "We could not grade that response reliably. Try the source-backed multiple-choice replacements.",
          modelProvenance: null,
          outcome: "abstained",
          ownerScopeId: command.authorization.ownerScopeId,
          policy: command.policy,
          questionId: command.question.id,
          requestDigest,
          sessionId: command.sessionId,
          userId: command.authorization.actorId,
        },
      );
    }

    assertExpectedProvenance(command.policy, routed.provenance);
    const evidence = normalizeJudgments(
      command.question,
      routed.value.judgments,
      command.policy,
      routed.provenance,
    );
    const abstained = evidence.some(
      (candidate) => !candidate.eligibleForMastery,
    );
    const finalizedEvidence: readonly LlmEvidenceCandidate[] = abstained
      ? evidence.map((candidate) =>
          candidate.judgmentKind === "scored" && candidate.eligibleForMastery
            ? {
                ...candidate,
                eligibleForMastery: false as const,
                fsrsRating: null,
                ineligibilityReason: "attempt_abstained" as const,
              }
            : candidate,
        )
      : evidence;

    return this.dependencies.repository.finalizeShortAnswer(
      command.authorization,
      {
        answer: command.answer,
        attemptId,
        evidence: finalizedEvidence,
        fallback: abstained ? fallback : null,
        idempotencyKey: command.idempotencyKey,
        learnerMessage: abstained
          ? "We could not grade that response reliably. Try the source-backed multiple-choice replacements."
          : "Your response was graded against each concept rubric.",
        modelProvenance: routed.provenance,
        outcome: abstained ? "abstained" : "graded",
        ownerScopeId: command.authorization.ownerScopeId,
        policy: command.policy,
        questionId: command.question.id,
        requestDigest,
        sessionId: command.sessionId,
        userId: command.authorization.actorId,
      },
    );
  }

  async gradeReplacement(
    command: GradeReplacementCommand,
  ): Promise<AssessmentFinalizationView> {
    validatePolicy(command.policy);
    validateIdentity(command.idempotencyKey);
    validateIdentity(command.sessionId);
    const requestDigest = replacementRequestDigest(command);
    const replay = await this.dependencies.repository.loadFinalization(
      command.authorization,
      command.idempotencyKey,
    );
    if (replay !== null) {
      if (replay.requestDigest !== requestDigest) {
        throw new AssessmentError("conflicting_duplicate");
      }
      return { ...replay, status: "replayed" };
    }
    const bundle = await this.dependencies.repository.loadReplacementBundle(
      command.authorization,
      command.bundleId,
    );
    const item = bundle?.items.find(
      (candidate) => candidate.id === command.itemId,
    );
    if (bundle === null || item === undefined) {
      throw new AssessmentError("authorization_denied");
    }
    const correct = command.answer === item.question.keyedAnswer;
    const attemptId = stableUuid({
      bundleId: bundle.id,
      idempotencyKey: command.idempotencyKey,
      itemId: item.id,
      sessionId: command.sessionId,
    });
    const evidence: AssessmentEvidenceCandidate = {
      conceptId: item.conceptId,
      eligibleForMastery: true,
      fsrsRating: correct ? 3 : 1,
      graderConfidence: null,
      gradingMethod: "keyed_mc",
      ineligibilityReason: null,
      judgmentKind: "scored",
      rationaleRef: `keyed-mc/${item.question.id}`,
      rubricBand: correct ? "correct" : "incorrect",
      rubricId: item.question.rubricId,
      rubricVersion: item.question.rubricVersion,
      score: correct ? "1.00000" : "0.00000",
    };
    return this.dependencies.repository.finalizeReplacement(
      command.authorization,
      {
        answer: command.answer,
        attemptId,
        bundleId: bundle.id,
        evidence,
        idempotencyKey: command.idempotencyKey,
        itemId: item.id,
        ownerScopeId: command.authorization.ownerScopeId,
        policy: command.policy,
        requestDigest,
        sessionId: command.sessionId,
        userId: command.authorization.actorId,
      },
    );
  }
}

export function selectAdaptiveQuestions(
  input: AdaptiveSelectionInput,
): readonly SelectableAssessmentQuestion[] {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    !Number.isFinite(Date.parse(input.now))
  ) {
    throw new AssessmentError("invalid_input");
  }
  const states = new Map(
    input.conceptStates.map((state) => {
      const mastery = parseExactUnit(state.mastery);
      const dueAt = state.dueAt === null ? null : Date.parse(state.dueAt);
      if (
        state.conceptId.length === 0 ||
        (dueAt !== null && !Number.isFinite(dueAt))
      ) {
        throw new AssessmentError("invalid_input");
      }
      return [state.conceptId, { dueAt, mastery }] as const;
    }),
  );
  if (states.size !== input.conceptStates.length) {
    throw new AssessmentError("invalid_input");
  }
  const now = Date.parse(input.now);
  const candidates = input.questions
    .filter(
      (question) =>
        !input.seenPromptHashes.has(question.normalizedPromptHash) &&
        question.conceptIds.some((conceptId) => states.has(conceptId)),
    )
    .map((question) => {
      const targetStates = question.conceptIds
        .map((conceptId) => states.get(conceptId))
        .filter((state) => state !== undefined);
      const weakestMastery = Math.min(
        ...targetStates.map((state) => state.mastery),
      );
      const dueAt = Math.min(
        ...targetStates.map((state) => state.dueAt ?? Number.POSITIVE_INFINITY),
      );
      const dueRank = dueAt <= now ? 0 : 1;
      const desiredDifficulty =
        weakestMastery < 40_000 ? 1 : weakestMastery < 70_000 ? 3 : 5;
      return {
        difficultyDistance: Math.abs(question.difficulty - desiredDifficulty),
        dueAt,
        dueRank,
        question,
        weakestMastery,
      };
    })
    .sort(
      (left, right) =>
        left.dueRank - right.dueRank ||
        left.weakestMastery - right.weakestMastery ||
        left.dueAt - right.dueAt ||
        left.difficultyDistance - right.difficultyDistance ||
        compareAscii(left.question.id, right.question.id),
    );

  const selected: SelectableAssessmentQuestion[] = [];
  const seen = new Set(input.seenPromptHashes);
  for (const candidate of candidates) {
    if (seen.has(candidate.question.normalizedPromptHash)) {
      continue;
    }
    seen.add(candidate.question.normalizedPromptHash);
    selected.push(candidate.question);
    if (selected.length === input.limit) break;
  }
  return selected;
}

function normalizeJudgments(
  question: ShortAnswerQuestion,
  judgments: readonly ShortAnswerJudgment[],
  policy: FrozenGradingPolicy,
  provenance: ModelCallProvenance,
): readonly LlmEvidenceCandidate[] {
  const expectedConcepts = new Set(
    question.rubrics.map((rubric) => rubric.conceptId),
  );
  if (
    judgments.length !== expectedConcepts.size ||
    new Set(judgments.map((judgment) => judgment.conceptId)).size !==
      expectedConcepts.size ||
    judgments.some((judgment) => !expectedConcepts.has(judgment.conceptId))
  ) {
    throw new AssessmentError("invalid_result");
  }
  const byConcept = new Map(judgments.map((entry) => [entry.conceptId, entry]));
  const threshold = parseExactUnit(policy.confidenceThreshold);
  return question.rubrics.map((rubric) => {
    const judgment = byConcept.get(rubric.conceptId);
    if (judgment === undefined) {
      throw new AssessmentError("invalid_result");
    }
    const rationaleRef = `model-call/${sha256(
      canonicalJson({
        conceptId: rubric.conceptId,
        promptDigest: provenance.promptDigest,
        policyVersion: policy.gradingPolicyVersion,
      }),
    )}`;
    if (judgment.judgmentKind === "unanswerable") {
      return {
        conceptId: rubric.conceptId,
        eligibleForMastery: false,
        fsrsRating: null,
        graderConfidence: null,
        gradingMethod: "llm_short_answer",
        ineligibilityReason: "semantic_unanswerable",
        judgmentKind: "unanswerable",
        rationaleRef,
        reason: judgment.reason,
        rubricBand: null,
        rubricId: rubric.rubricId,
        rubricVersion: rubric.rubricVersion,
        score: null,
      };
    }
    const confidence = formatUnit(judgment.confidence);
    const eligible = parseExactUnit(confidence) >= threshold;
    return {
      conceptId: rubric.conceptId,
      eligibleForMastery: eligible,
      fsrsRating: eligible ? ratingFor(judgment.rubricBand) : null,
      graderConfidence: confidence,
      gradingMethod: "llm_short_answer",
      ineligibilityReason: eligible ? null : "below_threshold",
      judgmentKind: "scored",
      rationaleRef,
      rubricBand: judgment.rubricBand,
      rubricId: rubric.rubricId,
      rubricVersion: rubric.rubricVersion,
      score: scoreFor(judgment.rubricBand),
    };
  });
}

function buildReplacementBundle(
  command: GradeShortAnswerCommand,
  attemptId: string,
): ReplacementBundle {
  const used = new Set(command.seenPromptHashes);
  used.add(command.question.normalizedPromptHash);
  const items: ReplacementItem[] = command.question.rubrics.map((rubric) => {
    const candidate = [...command.fallbackCandidates]
      .sort((left, right) => compareAscii(left.id, right.id))
      .find(
        (question) =>
          question.conceptIds[0] === rubric.conceptId &&
          question.courseId === command.question.courseId &&
          question.rubricId === rubric.rubricId &&
          question.rubricVersion === rubric.rubricVersion &&
          question.sourceSpans.every((span) =>
            rubric.sourceSpanIds.includes(span.id),
          ) &&
          !used.has(question.normalizedPromptHash) &&
          validReplacement(question),
      );
    if (candidate === undefined) {
      throw new AssessmentError(
        "fallback_unavailable",
        `no valid source-backed fallback for concept ${rubric.conceptId}`,
      );
    }
    used.add(candidate.normalizedPromptHash);
    return {
      conceptId: rubric.conceptId,
      id: stableUuid({
        conceptId: rubric.conceptId,
        originalAttemptId: attemptId,
        policyVersion: command.policy.gradingPolicyVersion,
      }),
      question: candidate,
    };
  });
  return {
    id: stableUuid({
      conceptIds: command.question.rubrics
        .map((rubric) => rubric.conceptId)
        .sort(compareAscii),
      originalAttemptId: attemptId,
      policyVersion: command.policy.gradingPolicyVersion,
    }),
    items,
    originalAttemptId: attemptId,
    policyVersion: GRADING_POLICY_VERSION,
    version: REPLACEMENT_CONTRACT_VERSION,
  };
}

function validateCommand(command: GradeShortAnswerCommand): void {
  validatePolicy(command.policy);
  validateIdentity(command.idempotencyKey);
  validateIdentity(command.sessionId);
  if (
    command.answer.length === 0 ||
    command.question.itemType !== "short_answer" ||
    command.question.rubrics.length === 0 ||
    command.question.conceptIds.length !== command.question.rubrics.length ||
    !Number.isFinite(command.deadlineMs) ||
    command.deadlineMs <= 0
  ) {
    throw new AssessmentError("invalid_input");
  }
  const conceptIds = new Set(command.question.conceptIds);
  const spanIds = new Set(command.question.sourceSpans.map((span) => span.id));
  if (
    conceptIds.size !== command.question.conceptIds.length ||
    spanIds.size !== command.question.sourceSpans.length ||
    command.question.rubrics.some(
      (rubric) =>
        !conceptIds.has(rubric.conceptId) ||
        rubric.rubricId.length === 0 ||
        rubric.rubricVersion.length === 0 ||
        rubric.requiredCriteria.length === 0 ||
        rubric.requiredCriteria.some((criterion) => criterion.length === 0) ||
        rubric.materialContradictions.some(
          (contradiction) => contradiction.length === 0,
        ) ||
        rubric.sourceSpanIds.length === 0 ||
        rubric.sourceSpanIds.some((spanId) => !spanIds.has(spanId)),
    ) ||
    new Set(command.question.rubrics.map((rubric) => rubric.conceptId)).size !==
      command.question.rubrics.length
  ) {
    throw new AssessmentError("invalid_input");
  }
  buildReplacementBundle(
    command,
    stableUuid({
      idempotencyKey: command.idempotencyKey,
      questionId: command.question.id,
      sessionId: command.sessionId,
      version: GRADING_POLICY_VERSION,
    }),
  );
}

function validatePolicy(policy: FrozenGradingPolicy): void {
  if (
    policy.gradingPolicyVersion !== GRADING_POLICY_VERSION ||
    policy.ratingMappingVersion !== RATING_MAPPING_VERSION ||
    policy.calibrationEvidenceId.length === 0 ||
    policy.expectedModelProvenance.routePolicyVersion !== "route-policy-v3" ||
    policy.expectedModelProvenance.inputSchemaVersion !==
      "short-answer-grading-input-v2" ||
    policy.expectedModelProvenance.promptId !==
      "assessment-grade-short-answer" ||
    policy.expectedModelProvenance.promptVersion !== "2" ||
    policy.expectedModelProvenance.resultSchemaVersion !==
      "short-answer-judgment-result-v2" ||
    !/^[0-9a-f]{64}$/.test(policy.expectedModelProvenance.promptDigest ?? "") ||
    policy.expectedModelProvenance.effectiveModel.length === 0 ||
    policy.expectedModelProvenance.effectiveModelVersion.length === 0
  ) {
    throw new AssessmentError("invalid_configuration");
  }
  parseExactUnit(policy.confidenceThreshold);
}

function assertExpectedProvenance(
  policy: FrozenGradingPolicy,
  actual: ModelCallProvenance,
): void {
  for (const [key, expected] of Object.entries(
    policy.expectedModelProvenance,
  )) {
    if (actual[key as keyof ModelCallProvenance] !== expected) {
      throw new AssessmentError("invalid_configuration");
    }
  }
}

function validReplacement(question: KeyedMultipleChoiceQuestion): boolean {
  return (
    question.itemType === "multiple_choice" &&
    question.conceptIds.length === 1 &&
    /^[0-9a-f]{64}$/.test(question.normalizedPromptHash) &&
    question.sourceSpans.length > 0 &&
    question.responseOptions.length >= 2 &&
    new Set(question.responseOptions).size ===
      question.responseOptions.length &&
    question.responseOptions.includes(question.keyedAnswer)
  );
}

function ratingFor(band: ShortAnswerRubricBand): 1 | 3 {
  return band === "correct" ? 3 : 1;
}

function scoreFor(
  band: ShortAnswerRubricBand,
): "0.00000" | "0.50000" | "1.00000" {
  return band === "correct"
    ? "1.00000"
    : band === "partially_correct"
      ? "0.50000"
      : "0.00000";
}

function formatUnit(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AssessmentError("invalid_result");
  }
  return value.toFixed(5);
}

function parseExactUnit(value: string): number {
  if (!/^(?:0(?:\.\d{5})|1\.00000)$/.test(value)) {
    throw new AssessmentError("invalid_configuration");
  }
  return Math.round(Number(value) * UNIT_SCALE);
}

function validateIdentity(value: string): void {
  if (
    value.length < 1 ||
    value.length > 240 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new AssessmentError("invalid_input");
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const ASSESSMENT_SELECTION_POLICY = Object.freeze({
  version: ASSESSMENT_SELECTION_VERSION,
  priority: ["due", "weak_mastery", "difficulty_fit", "stable_id"],
});

function shortAnswerRequestDigest(command: GradeShortAnswerCommand): string {
  return sha256(
    canonicalJson({
      answer: command.answer,
      fallbackCandidates: command.fallbackCandidates,
      ownerScopeId: command.authorization.ownerScopeId,
      policy: command.policy,
      question: command.question,
      seenPromptHashes: [...command.seenPromptHashes].sort(compareAscii),
      sessionId: command.sessionId,
      userId: command.authorization.actorId,
    }),
  );
}

function replacementRequestDigest(command: GradeReplacementCommand): string {
  return sha256(
    canonicalJson({
      answer: command.answer,
      bundleId: command.bundleId,
      itemId: command.itemId,
      ownerScopeId: command.authorization.ownerScopeId,
      policy: command.policy,
      sessionId: command.sessionId,
      userId: command.authorization.actorId,
    }),
  );
}
