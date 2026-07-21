import type { ModelTaskInput, RoutedModelResult } from "@reflo/model-router";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

import type {
  AuthorizedActivationCourse,
  GeneratedQuizBank,
  GeneratedTextLesson,
  GenerationClaim,
  GenerationFailure,
  GenerationOperationView,
  GenerationWork,
  PlannedGenerationOperation,
  TextArtifactWriteResult,
} from "./contracts.js";

export type ActivationModelTask = "lesson.text.v1" | "assessment.quiz.v1";

export interface ActivationModelRouterPort {
  execute<Task extends ActivationModelTask>(
    task: Task,
    input: ModelTaskInput<Task>,
    options: { readonly deadlineMs: number },
  ): Promise<RoutedModelResult<Task>>;
}

export interface ActivationRepositoryPort {
  loadCourse(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<AuthorizedActivationCourse | null>;

  registerOperations(
    course: AuthorizedActivationCourse,
    operations: readonly PlannedGenerationOperation[],
  ): Promise<readonly GenerationOperationView[]>;

  claimOperation(
    authorization: ScopeAuthorizationContext,
    courseId: string,
    operationId: string,
  ): Promise<GenerationClaim | null>;

  completeTextLesson(
    work: GenerationWork,
    lesson: GeneratedTextLesson,
  ): Promise<GenerationOperationView>;

  completeQuizBank(
    work: GenerationWork,
    quizBank: GeneratedQuizBank,
  ): Promise<GenerationOperationView>;

  recordFailure(
    work: GenerationWork,
    failure: GenerationFailure,
  ): Promise<GenerationOperationView>;

  listOperations(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<readonly GenerationOperationView[]>;
}

export interface TextArtifactWriterPort {
  putImmutable(input: {
    readonly content: string;
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<TextArtifactWriteResult>;
}
