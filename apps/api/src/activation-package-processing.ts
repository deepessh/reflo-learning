import type {
  ActivationArtifactKind,
  ActivationGenerationService,
  GenerationOperationView,
} from "@reflo/activation";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

export const DEFAULT_ACTIVATION_DEADLINES_MS: Readonly<
  Record<ActivationArtifactKind, number>
> = Object.freeze({
  chapter_quiz: 180_000,
  first_text_lesson: 180_000,
  placement_quiz: 180_000,
});
export const MAX_ACTIVATION_OPERATION_BUDGET_MS = 15 * 60_000;
const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;
const MIN_ARTIFACT_DEADLINE_MS = 30_000;
const MAX_ARTIFACT_DEADLINE_MS = 300_000;
const MAX_ATTEMPTS = 5;

export interface ActivationPackageRequest {
  readonly authorization: ScopeAuthorizationContext;
  readonly courseId: string;
}

export interface ActivationPackageScheduler {
  schedule(request: ActivationPackageRequest): void;
  scheduleRegeneration(
    request: ActivationPackageRequest,
    operation: GenerationOperationView,
  ): void;
}

type GenerationService = Pick<ActivationGenerationService, "plan" | "run">;

/**
 * Runs the three durable activation operations in priority order. The
 * activation repository owns operation idempotency and the five-attempt
 * delivery budget; this queue only provides bounded local redelivery and
 * deduplicates repeated launch requests in one API process.
 */
export class ActivationPackageProcessingQueue implements ActivationPackageScheduler {
  readonly #deadlinesMs: Readonly<Record<ActivationArtifactKind, number>>;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #generation: GenerationService;
  readonly #retryDelaysMs: readonly number[];
  readonly #maxOperationBudgetMs: number;
  readonly #now: () => number;
  readonly #scheduled = new Set<string>();
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly deadlineMs?: number;
    readonly deadlinesMs?: Partial<Record<ActivationArtifactKind, number>>;
    readonly delay?: (milliseconds: number) => Promise<void>;
    readonly generation: GenerationService;
    readonly maxOperationBudgetMs?: number;
    readonly now?: () => number;
    readonly retryDelaysMs?: readonly number[];
  }) {
    const legacyDeadline = options.deadlineMs;
    this.#deadlinesMs = {
      chapter_quiz:
        options.deadlinesMs?.chapter_quiz ??
        legacyDeadline ??
        DEFAULT_ACTIVATION_DEADLINES_MS.chapter_quiz,
      first_text_lesson:
        options.deadlinesMs?.first_text_lesson ??
        legacyDeadline ??
        DEFAULT_ACTIVATION_DEADLINES_MS.first_text_lesson,
      placement_quiz:
        options.deadlinesMs?.placement_quiz ??
        legacyDeadline ??
        DEFAULT_ACTIVATION_DEADLINES_MS.placement_quiz,
    };
    this.#delay = options.delay ?? boundedDelay;
    this.#generation = options.generation;
    this.#maxOperationBudgetMs =
      options.maxOperationBudgetMs ?? MAX_ACTIVATION_OPERATION_BUDGET_MS;
    this.#now = options.now ?? Date.now;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    if (
      !Object.values(this.#deadlinesMs).every(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= MIN_ARTIFACT_DEADLINE_MS &&
          value <= MAX_ARTIFACT_DEADLINE_MS,
      ) ||
      !Number.isSafeInteger(this.#maxOperationBudgetMs) ||
      this.#maxOperationBudgetMs < MAX_ARTIFACT_DEADLINE_MS ||
      this.#maxOperationBudgetMs > MAX_ACTIVATION_OPERATION_BUDGET_MS ||
      this.#retryDelaysMs.length !== 4 ||
      !this.#retryDelaysMs.every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= 30_000,
      )
    ) {
      throw new Error("activation package processing policy is invalid");
    }
  }

  schedule(request: ActivationPackageRequest): void {
    if (this.#closed) {
      throw new Error("activation package processing is closed");
    }
    validateRequest(request);
    const key = `${request.authorization.ownerScopeId}/${request.courseId}`;
    if (this.#scheduled.has(key)) {
      return;
    }
    this.#scheduled.add(key);
    this.#tail = this.#tail
      .then(() => this.#process(request))
      .catch((error: unknown) => {
        // Operation-level failures are persisted by the activation repository.
        // This log covers planning/infrastructure failures that occur before an
        // operation can record a durable status; do not include source content.
        console.warn("Activation package processing stopped", {
          courseId: request.courseId,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => this.#scheduled.delete(key));
  }

  scheduleRegeneration(
    request: ActivationPackageRequest,
    operation: GenerationOperationView,
  ): void {
    if (this.#closed) {
      throw new Error("activation package processing is closed");
    }
    validateRequest(request);
    if (
      !["first_text_lesson", "chapter_quiz", "placement_quiz"].includes(
        operation.artifactKind,
      ) ||
      !["queued", "retry_scheduled", "processing"].includes(operation.status)
    ) {
      throw new Error("lesson regeneration operation is invalid");
    }
    const key = `${request.authorization.ownerScopeId}/${request.courseId}/${operation.id}`;
    if (this.#scheduled.has(key)) return;
    this.#scheduled.add(key);
    this.#tail = this.#tail
      .then(() => this.#runOperation(request, operation))
      .then(() => undefined)
      .catch((error: unknown) => {
        writeActivationLog({
          artifactKind: operation.artifactKind,
          attempt: operation.attemptCount,
          courseId: request.courseId,
          deadlineMs: this.#deadlinesMs[operation.artifactKind],
          durationMs: 0,
          event: "activation_operation_queue_error",
          failureClass: safeErrorClass(error),
          maxAttempts: MAX_ATTEMPTS,
          operationId: operation.id,
          regenerationOrdinal: operation.regenerationOrdinal,
          status: operation.status,
        });
      })
      .finally(() => this.#scheduled.delete(key));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  async #process(request: ActivationPackageRequest): Promise<void> {
    const operations = await this.#generation.plan({
      authorization: request.authorization,
      courseId: request.courseId,
      environment: "dev",
    });
    for (const operation of [...operations].sort(
      (left, right) => left.priority - right.priority,
    )) {
      const outcome = await this.#runOperation(request, operation);
      // Another process owns this operation. Do not overtake it by generating
      // lower-priority artifacts; a later idempotent launch can resume work.
      if (outcome.status === "processing") {
        return;
      }
    }
  }

  async #runOperation(
    request: ActivationPackageRequest,
    initial: GenerationOperationView,
  ): Promise<GenerationOperationView> {
    let operation = initial;
    const operationStartedAt = this.#now();
    for (;;) {
      if (
        operation.status !== "queued" &&
        operation.status !== "retry_scheduled"
      ) {
        return operation;
      }
      const attemptStartedAt = this.#now();
      const remainingBudgetMs = Math.max(
        1,
        this.#maxOperationBudgetMs - (attemptStartedAt - operationStartedAt),
      );
      const deadlineMs = Math.min(
        this.#deadlinesMs[operation.artifactKind],
        remainingBudgetMs,
      );
      writeActivationLog({
        artifactKind: operation.artifactKind,
        attempt: operation.attemptCount + 1,
        courseId: request.courseId,
        deadlineMs,
        durationMs: 0,
        event: "activation_operation_started",
        failureClass: null,
        maxAttempts: MAX_ATTEMPTS,
        operationId: operation.id,
        regenerationOrdinal: operation.regenerationOrdinal,
        status: "processing",
      });
      operation = await this.#generation.run({
        authorization: request.authorization,
        courseId: request.courseId,
        deadlineMs,
        operationId: operation.id,
      });
      writeActivationLog({
        artifactKind: operation.artifactKind,
        attempt: operation.attemptCount,
        courseId: request.courseId,
        deadlineMs,
        durationMs: Math.max(0, this.#now() - attemptStartedAt),
        event: "activation_operation_finished",
        failureClass: operation.failureClass,
        maxAttempts: MAX_ATTEMPTS,
        operationId: operation.id,
        regenerationOrdinal: operation.regenerationOrdinal,
        status: operation.status,
      });
      if (operation.status !== "retry_scheduled") {
        return operation;
      }
      const delay = this.#retryDelaysMs[operation.attemptCount - 1];
      if (delay === undefined) {
        return operation;
      }
      await this.#delay(delay);
    }
  }
}

export function activationGenerationDeadlines(
  input: NodeJS.ProcessEnv,
): Readonly<Record<ActivationArtifactKind, number>> {
  return {
    chapter_quiz: configuredDeadline(
      input.REFLO_ACTIVATION_CHAPTER_QUIZ_DEADLINE_MS,
      DEFAULT_ACTIVATION_DEADLINES_MS.chapter_quiz,
    ),
    first_text_lesson: configuredDeadline(
      input.REFLO_ACTIVATION_LESSON_DEADLINE_MS,
      DEFAULT_ACTIVATION_DEADLINES_MS.first_text_lesson,
    ),
    placement_quiz: configuredDeadline(
      input.REFLO_ACTIVATION_PLACEMENT_QUIZ_DEADLINE_MS,
      DEFAULT_ACTIVATION_DEADLINES_MS.placement_quiz,
    ),
  };
}

function configuredDeadline(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_ARTIFACT_DEADLINE_MS ||
    parsed > MAX_ARTIFACT_DEADLINE_MS
  ) {
    throw new Error(
      `activation artifact deadline must be ${MIN_ARTIFACT_DEADLINE_MS}-${MAX_ARTIFACT_DEADLINE_MS}ms`,
    );
  }
  return parsed;
}

interface ActivationLogEvent {
  readonly artifactKind: ActivationArtifactKind;
  readonly attempt: number;
  readonly courseId: string;
  readonly deadlineMs: number;
  readonly durationMs: number;
  readonly event:
    | "activation_operation_finished"
    | "activation_operation_queue_error"
    | "activation_operation_started";
  readonly failureClass: string | null;
  readonly maxAttempts: number;
  readonly operationId: string;
  readonly regenerationOrdinal: number;
  readonly status: string;
}

function writeActivationLog(event: ActivationLogEvent): void {
  const serialized = JSON.stringify(event);
  if (
    event.event === "activation_operation_queue_error" ||
    event.status === "failed_permanent"
  ) {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
}

function safeErrorClass(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) {
    return error.name.toLowerCase();
  }
  return "unknown";
}

function validateRequest(request: ActivationPackageRequest): void {
  if (
    !isUuid(request.courseId) ||
    !isUuid(request.authorization.actorId) ||
    !isUuid(request.authorization.ownerScopeId) ||
    request.authorization.authorizationId.trim() === ""
  ) {
    throw new Error("activation package request is invalid");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function boundedDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
