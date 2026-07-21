import { buildAssetObjectKey } from "@reflo/asset-delivery";
import {
  ModelRouterError,
  type AuthorizedSourceSpan,
  type QuizGenerationResult,
} from "@reflo/model-router";
import { canonicalJson, sha256, stableUuid } from "@reflo/retrieval";

import {
  ACTIVATION_GENERATION_VERSION,
  CHAPTER_QUIZ_ITEM_COUNT,
  PLACEMENT_QUIZ_ITEM_COUNT,
  REQUIRED_QUIZ_ITEM_TYPES,
  TEXT_READING_WORDS_PER_MINUTE,
  type ActivationConcept,
  type AuthorizedActivationCourse,
  type GeneratedQuizBank,
  type GeneratedQuizItem,
  type GeneratedTextLesson,
  type GenerationFailure,
  type GenerationOperationView,
  type PlanActivationCommand,
  type PlannedGenerationOperation,
  type RunGenerationCommand,
} from "./contracts.js";
import { ActivationGenerationError } from "./errors.js";
import type {
  ActivationModelRouterPort,
  ActivationRepositoryPort,
  TextArtifactWriterPort,
} from "./ports.js";

export interface ActivationGenerationDependencies {
  readonly models: ActivationModelRouterPort;
  readonly repository: ActivationRepositoryPort;
  readonly textArtifacts: TextArtifactWriterPort;
}

export class ActivationGenerationService {
  constructor(
    private readonly dependencies: ActivationGenerationDependencies,
  ) {}

  async plan(
    command: PlanActivationCommand,
  ): Promise<readonly GenerationOperationView[]> {
    const course = await this.dependencies.repository.loadCourse(
      command.authorization,
      command.courseId,
    );
    if (course === null) {
      throw new ActivationGenerationError("authorization_denied");
    }
    const operations = buildActivationPlan(course, command.environment);
    return this.dependencies.repository.registerOperations(course, operations);
  }

  async run(command: RunGenerationCommand): Promise<GenerationOperationView> {
    if (!Number.isFinite(command.deadlineMs) || command.deadlineMs <= 0) {
      throw new ActivationGenerationError("invalid_configuration");
    }
    const claim = await this.dependencies.repository.claimOperation(
      command.authorization,
      command.courseId,
      command.operationId,
    );
    if (claim === null) {
      throw new ActivationGenerationError("operation_unavailable");
    }
    if (claim.kind === "already_final") {
      return claim.status;
    }

    try {
      if (claim.work.operation.artifactKind === "first_text_lesson") {
        const lesson = await this.#generateTextLesson(
          claim.work.course,
          claim.work.operation,
          command.deadlineMs,
        );
        return this.dependencies.repository.completeTextLesson(
          claim.work,
          lesson,
        );
      }
      const quizBank = await this.#generateQuizBank(
        claim.work.course,
        claim.work.operation,
        command.deadlineMs,
      );
      return this.dependencies.repository.completeQuizBank(
        claim.work,
        quizBank,
      );
    } catch (error) {
      return this.dependencies.repository.recordFailure(
        claim.work,
        normalizeFailure(error),
      );
    }
  }

  listStatus(
    authorization: RunGenerationCommand["authorization"],
    courseId: string,
  ): Promise<readonly GenerationOperationView[]> {
    return this.dependencies.repository.listOperations(authorization, courseId);
  }

  async #generateTextLesson(
    course: AuthorizedActivationCourse,
    operation: GenerationOperationView,
    deadlineMs: number,
  ): Promise<GeneratedTextLesson> {
    const concept = requiredConcept(course, operation.conceptId);
    const routed = await this.dependencies.models.execute(
      "lesson.text.v1",
      {
        conceptId: concept.id,
        conceptName: concept.name,
        sourceSpans: concept.sourceSpans,
      },
      { deadlineMs },
    );
    const wordCount = countWords(routed.value.content);
    const estimatedReadingMinutes = wordCount / TEXT_READING_WORDS_PER_MINUTE;
    if (estimatedReadingMinutes < 2 || estimatedReadingMinutes > 3) {
      throw new ActivationGenerationError(
        "content_out_of_bounds",
        "activation text lesson must be readable in two to three minutes",
      );
    }
    const contentHash = sha256(routed.value.content);
    const generationId = stableUuid({
      contentHash,
      operationId: operation.id,
      provenance: routed.provenance,
    });
    const assetId = stableUuid({
      artifactKind: operation.artifactKind,
      courseId: course.courseId,
      generationVersion: ACTIVATION_GENERATION_VERSION,
      targetId: concept.id,
    });
    const objectKey = buildAssetObjectKey({
      assetId,
      courseId: course.courseId,
      extension: "md",
      generationId,
      ownerScopeId: course.ownerScopeId,
    });
    const storage = await this.dependencies.textArtifacts.putImmutable({
      content: routed.value.content,
      contentHash,
      idempotencyKey: operation.idempotencyKey,
      objectKey,
    });
    if (storage.objectKey !== objectKey) {
      throw new ActivationGenerationError("invalid_result");
    }
    return {
      assetId,
      contentHash,
      estimatedReadingMinutes,
      generationId,
      modelProvenance: routed.provenance,
      sourceSpanIds: routed.value.sourceSpanIds,
      storage,
      strategyTag: routed.value.strategyTag,
    };
  }

  async #generateQuizBank(
    course: AuthorizedActivationCourse,
    operation: GenerationOperationView,
    deadlineMs: number,
  ): Promise<GeneratedQuizBank> {
    const concepts = quizConcepts(course, operation);
    const sourceSpans = uniqueSourceSpans(
      concepts.flatMap((concept) => concept.sourceSpans),
    );
    const count =
      operation.artifactKind === "placement_quiz"
        ? PLACEMENT_QUIZ_ITEM_COUNT
        : CHAPTER_QUIZ_ITEM_COUNT;
    const routed = await this.dependencies.models.execute(
      "assessment.quiz.v1",
      {
        conceptIds: concepts.map((concept) => concept.id),
        count,
        courseId: course.courseId,
        requiredItemTypes: REQUIRED_QUIZ_ITEM_TYPES,
        sourceSpans,
      },
      { deadlineMs },
    );
    assertPerConceptGrounding(concepts, routed.value);
    const bankId = stableUuid({
      artifactKind: operation.artifactKind,
      courseId: course.courseId,
      generationVersion: ACTIVATION_GENERATION_VERSION,
      targetId: operation.chapterId ?? course.courseId,
    });
    const items = materializeQuizItems(bankId, routed.value);
    if (
      new Set(items.map((item) => item.normalizedPromptHash)).size !== count
    ) {
      throw new ActivationGenerationError(
        "invalid_result",
        "quiz generation repeated an identical normalized question",
      );
    }
    const bankKind =
      operation.artifactKind === "placement_quiz" ? "placement" : "chapter";
    return {
      bankId,
      bankKind,
      items,
      modelProvenance: routed.provenance,
      resultHash: sha256(canonicalJson(routed.value)),
    };
  }
}

export function buildActivationPlan(
  course: AuthorizedActivationCourse,
  environment: PlanActivationCommand["environment"],
): readonly PlannedGenerationOperation[] {
  const chapter = course.chapters[0];
  const concept = chapter?.concepts[0];
  if (chapter === undefined || concept === undefined) {
    throw new ActivationGenerationError(
      "invalid_configuration",
      "activation generation requires a source-backed first chapter and concept",
    );
  }
  const definitions = [
    {
      artifactKind: "first_text_lesson" as const,
      chapterId: chapter.id,
      conceptId: concept.id,
      priority: 1 as const,
    },
    {
      artifactKind: "placement_quiz" as const,
      chapterId: null,
      conceptId: null,
      priority: 2 as const,
    },
    {
      artifactKind: "chapter_quiz" as const,
      chapterId: chapter.id,
      conceptId: null,
      priority: 3 as const,
    },
  ];
  return definitions.map((definition) => {
    const id = stableUuid({
      ...definition,
      courseId: course.courseId,
      curriculumGenerationId: course.curriculumGenerationId,
      generationVersion: ACTIVATION_GENERATION_VERSION,
    });
    return {
      ...definition,
      generationVersion: ACTIVATION_GENERATION_VERSION,
      id,
      idempotencyKey: `${environment}/content.activation.generate/v1/${id}`,
    };
  });
}

export function normalizeQuizPrompt(prompt: string): string {
  return prompt
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function selectUnseenQuizItems(
  items: readonly GeneratedQuizItem[],
  attemptedPromptHashes: ReadonlySet<string>,
  limit: number,
): readonly GeneratedQuizItem[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ActivationGenerationError("invalid_configuration");
  }
  const selected: GeneratedQuizItem[] = [];
  const seen = new Set(attemptedPromptHashes);
  for (const item of items) {
    if (seen.has(item.normalizedPromptHash)) {
      continue;
    }
    seen.add(item.normalizedPromptHash);
    selected.push(item);
    if (selected.length === limit) {
      break;
    }
  }
  return selected;
}

function materializeQuizItems(
  bankId: string,
  result: QuizGenerationResult,
): readonly GeneratedQuizItem[] {
  return result.items.map((item, itemOrder) => {
    const normalizedPrompt = normalizeQuizPrompt(item.prompt);
    if (normalizedPrompt.length === 0) {
      throw new ActivationGenerationError("invalid_result");
    }
    return {
      ...item,
      id: stableUuid({ bankId, itemOrder, normalizedPrompt }),
      itemOrder,
      normalizedPromptHash: sha256(normalizedPrompt),
    };
  });
}

function assertPerConceptGrounding(
  concepts: readonly ActivationConcept[],
  result: QuizGenerationResult,
): void {
  const spansByConcept = new Map(
    concepts.map((concept) => [
      concept.id,
      new Set(concept.sourceSpans.map((span) => span.id)),
    ]),
  );
  for (const item of result.items) {
    for (const conceptId of item.conceptIds) {
      const authorizedSpans = spansByConcept.get(conceptId);
      if (
        authorizedSpans === undefined ||
        !item.sourceSpanIds.some((spanId) => authorizedSpans.has(spanId))
      ) {
        throw new ActivationGenerationError(
          "invalid_result",
          "quiz item lacks source provenance for a tagged concept",
        );
      }
    }
  }
}

function quizConcepts(
  course: AuthorizedActivationCourse,
  operation: GenerationOperationView,
): readonly ActivationConcept[] {
  if (operation.artifactKind === "chapter_quiz") {
    const chapter = course.chapters.find(
      (candidate) => candidate.id === operation.chapterId,
    );
    if (chapter === undefined || chapter.concepts.length === 0) {
      throw new ActivationGenerationError("authorization_denied");
    }
    return chapter.concepts;
  }
  const concepts = course.chapters.flatMap((chapter) => chapter.concepts);
  if (concepts.length === 0) {
    throw new ActivationGenerationError("invalid_configuration");
  }
  return concepts.slice(0, PLACEMENT_QUIZ_ITEM_COUNT);
}

function uniqueSourceSpans(
  sourceSpans: readonly AuthorizedSourceSpan[],
): readonly AuthorizedSourceSpan[] {
  const unique = new Map<string, AuthorizedSourceSpan>();
  for (const span of sourceSpans) {
    unique.set(span.id, span);
  }
  return [...unique.values()];
}

function requiredConcept(
  course: AuthorizedActivationCourse,
  conceptId: string | null,
): ActivationConcept {
  const concept = course.chapters
    .flatMap((chapter) => chapter.concepts)
    .find((candidate) => candidate.id === conceptId);
  if (concept === undefined || concept.sourceSpans.length === 0) {
    throw new ActivationGenerationError("authorization_denied");
  }
  return concept;
}

function countWords(content: string): number {
  return content.trim().split(/\s+/u).filter(Boolean).length;
}

function normalizeFailure(error: unknown): GenerationFailure {
  if (error instanceof ModelRouterError) {
    return {
      failureClass: error.code,
      retryable:
        error.code === "deadline_exceeded" || error.code === "provider_failure",
    };
  }
  if (error instanceof ActivationGenerationError) {
    return { failureClass: error.code, retryable: false };
  }
  return { failureClass: "infrastructure_unavailable", retryable: true };
}
