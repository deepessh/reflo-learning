import { Buffer } from "node:buffer";

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
import type {
  ActivationRepositoryPort,
  TextArtifactWriterPort,
} from "./ports.js";

export class InMemoryActivationRepository implements ActivationRepositoryPort {
  readonly courses = new Map<string, AuthorizedActivationCourse>();
  readonly operations = new Map<string, GenerationOperationView>();
  readonly lessons = new Map<string, GeneratedTextLesson>();
  readonly quizBanks = new Map<string, GeneratedQuizBank>();

  async loadCourse(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<AuthorizedActivationCourse | null> {
    const course = this.courses.get(courseId);
    return course !== undefined && authorized(course, authorization)
      ? course
      : null;
  }

  async registerOperations(
    course: AuthorizedActivationCourse,
    operations: readonly PlannedGenerationOperation[],
  ): Promise<readonly GenerationOperationView[]> {
    const now = new Date("2026-07-21T00:00:00.000Z");
    for (const operation of operations) {
      if (!this.operations.has(operation.id)) {
        this.operations.set(operation.id, {
          ...operation,
          artifactId: null,
          attemptCount: 0,
          failureClass: null,
          retryable: false,
          status: "queued",
          updatedAt: now,
        });
      }
    }
    return operations.map((operation) =>
      required(this.operations.get(operation.id)),
    );
  }

  async claimOperation(
    authorization: ScopeAuthorizationContext,
    courseId: string,
    operationId: string,
  ): Promise<GenerationClaim | null> {
    const course = await this.loadCourse(authorization, courseId);
    const operation = this.operations.get(operationId);
    if (course === null || operation === undefined) {
      return null;
    }
    if (
      ["succeeded", "failed_permanent", "cancelled", "expired"].includes(
        operation.status,
      )
    ) {
      return { kind: "already_final", status: operation };
    }
    if (operation.status === "processing") {
      return null;
    }
    const claimed: GenerationOperationView = {
      ...operation,
      attemptCount: operation.attemptCount + 1,
      failureClass: null,
      retryable: false,
      status: "processing",
      updatedAt: new Date("2026-07-21T00:00:01.000Z"),
    };
    this.operations.set(operationId, claimed);
    return { kind: "claimed", work: { course, operation: claimed } };
  }

  async completeTextLesson(
    work: GenerationWork,
    lesson: GeneratedTextLesson,
  ): Promise<GenerationOperationView> {
    this.lessons.set(lesson.assetId, lesson);
    return this.#complete(work, lesson.assetId);
  }

  async completeQuizBank(
    work: GenerationWork,
    quizBank: GeneratedQuizBank,
  ): Promise<GenerationOperationView> {
    this.quizBanks.set(quizBank.bankId, quizBank);
    return this.#complete(work, quizBank.bankId);
  }

  async recordFailure(
    work: GenerationWork,
    failure: GenerationFailure,
  ): Promise<GenerationOperationView> {
    const current = required(this.operations.get(work.operation.id));
    const next: GenerationOperationView = {
      ...current,
      failureClass: failure.failureClass,
      retryable: failure.retryable,
      status: failure.retryable ? "retry_scheduled" : "failed_permanent",
      updatedAt: new Date("2026-07-21T00:00:02.000Z"),
    };
    this.operations.set(next.id, next);
    return next;
  }

  async listOperations(
    authorization: ScopeAuthorizationContext,
    courseId: string,
  ): Promise<readonly GenerationOperationView[]> {
    if ((await this.loadCourse(authorization, courseId)) === null) {
      return [];
    }
    return [...this.operations.values()].sort(
      (left, right) => left.priority - right.priority,
    );
  }

  #complete(work: GenerationWork, artifactId: string): GenerationOperationView {
    const current = required(this.operations.get(work.operation.id));
    if (current.status === "succeeded") {
      return current;
    }
    const next: GenerationOperationView = {
      ...current,
      artifactId,
      failureClass: null,
      retryable: false,
      status: "succeeded",
      updatedAt: new Date("2026-07-21T00:00:02.000Z"),
    };
    this.operations.set(next.id, next);
    return next;
  }
}

export class InMemoryTextArtifactWriter implements TextArtifactWriterPort {
  readonly objects = new Map<
    string,
    { readonly content: string; readonly contentHash: string }
  >();

  async putImmutable(input: {
    readonly content: string;
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly objectKey: string;
  }): Promise<TextArtifactWriteResult> {
    const existing = this.objects.get(input.objectKey);
    if (existing !== undefined && existing.contentHash !== input.contentHash) {
      throw new Error("immutable object conflict");
    }
    this.objects.set(input.objectKey, {
      content: input.content,
      contentHash: input.contentHash,
    });
    return {
      byteSize: Buffer.byteLength(input.content, "utf8"),
      contentType: "text/markdown; charset=utf-8",
      etag: input.contentHash,
      objectKey: input.objectKey,
    };
  }
}

function authorized(
  course: AuthorizedActivationCourse,
  authorization: ScopeAuthorizationContext,
): boolean {
  return (
    course.actorId === authorization.actorId &&
    course.authorizationId === authorization.authorizationId &&
    course.ownerScopeId === authorization.ownerScopeId
  );
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("missing in-memory fixture");
  }
  return value;
}
