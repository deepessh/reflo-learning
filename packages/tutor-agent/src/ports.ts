import type { ModelTaskInput, RoutedModelResult } from "@reflo/model-router";

import type {
  LaterReviewRequest,
  LoopSuccessRecord,
  PersistedReteachLesson,
  ReteachPersistenceRequest,
  TextArtifactWriteResult,
  TutorQuestionRecord,
  TutorRetrievedSpan,
  TutorSearchRequest,
  TutorSessionSnapshot,
  TutorLessonReference,
  TutorLoopResult,
} from "./contracts.js";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

export type TutorModelTask =
  "embedding.document.v1" | "lesson.reteach.v1" | "tutor.answer.v1";

export interface TutorModelRouterPort {
  execute<Task extends TutorModelTask>(
    task: Task,
    input: ModelTaskInput<Task>,
    options: { readonly deadlineMs: number },
  ): Promise<RoutedModelResult<Task>>;
}

export interface TutorAgentRepositoryPort {
  loadSession(
    authorization: ScopeAuthorizationContext,
    sessionId: string,
  ): Promise<TutorSessionSnapshot | null>;

  saveReteach(
    authorization: ScopeAuthorizationContext,
    request: ReteachPersistenceRequest,
  ): Promise<PersistedReteachLesson>;

  recordLoopSuccess(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
  ): Promise<TutorLoopResult>;

  recordLoopStopped(
    authorization: ScopeAuthorizationContext,
    record: LoopSuccessRecord,
  ): Promise<TutorLoopResult>;

  recordTutorQuestion(
    authorization: ScopeAuthorizationContext,
    record: TutorQuestionRecord,
  ): Promise<void>;
}

export interface TutorArtifactStorePort {
  putImmutable(input: {
    readonly content: string;
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<TextArtifactWriteResult>;

  readAuthorizedText(input: {
    readonly authorization: ScopeAuthorizationContext;
    readonly lesson: TutorLessonReference;
  }): Promise<string | null>;
}

export interface TutorRetrievalPort {
  search(request: TutorSearchRequest): Promise<readonly TutorRetrievedSpan[]>;
}

export interface TutorReviewSchedulerPort {
  scheduleLaterReview(
    authorization: ScopeAuthorizationContext,
    request: LaterReviewRequest,
  ): Promise<{ readonly nextDeliveryAt: string }>;
}
