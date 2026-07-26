import type { IngestionRunResult, NormalizedDocument } from "@reflo/ingestion";
import { ModelRouterError } from "@reflo/model-router";
import {
  RetrievalError,
  type ScopeAuthorizationContext,
} from "@reflo/retrieval";

import type {
  DemoUploadPersistence,
  DemoUploadProcessingQueue,
  DemoUploadProcessingWork,
} from "./demo-upload.js";

const MAX_INGESTION_DELIVERIES = 5;
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const DEFAULT_ACTIVE_POLL_DELAY_MS = 1_000;
const DEFAULT_ACTIVE_POLL_LIMIT = 155;
const DEFAULT_GENERATION_RETRY_DELAYS_MS = [500, 1_000] as const;

export interface DemoUploadIngestionRunner {
  execute(work: DemoUploadProcessingWork): Promise<IngestionRunResult>;
}

export interface DemoUploadNormalizedArtifactReader {
  readNormalizedDocument(input: {
    readonly artifactId: string;
    readonly documentKind: "docx" | "epub" | "pdf";
    readonly inputSha256: string;
    readonly ownerScopeId: string;
  }): Promise<NormalizedDocument>;
}

export interface DemoUploadCurriculumBuilder {
  buildCurriculum(input: {
    readonly authorization: ScopeAuthorizationContext;
    readonly courseId: string;
    readonly deadlineMs: number;
    readonly document: NormalizedDocument;
    readonly sourceDocumentId: string;
  }): Promise<unknown>;
}

type GenerationRepository = Pick<
  DemoUploadPersistence,
  | "claimCourseGeneration"
  | "completeCourseGeneration"
  | "failCourseGenerationAttempt"
>;

export class DemoUploadProcessingService implements DemoUploadProcessingQueue {
  readonly #activePollDelayMs: number;
  readonly #activePollLimit: number;
  readonly #artifacts: DemoUploadNormalizedArtifactReader;
  readonly #curriculum: DemoUploadCurriculumBuilder;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #generationRetryDelaysMs: readonly number[];
  readonly #ingestion: DemoUploadIngestionRunner;
  readonly #repository: GenerationRepository;
  readonly #retryDelaysMs: readonly number[];
  readonly #scheduled = new Set<string>();
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly activePollDelayMs?: number;
    readonly activePollLimit?: number;
    readonly artifacts: DemoUploadNormalizedArtifactReader;
    readonly curriculum: DemoUploadCurriculumBuilder;
    readonly delay?: (milliseconds: number) => Promise<void>;
    readonly generationRetryDelaysMs?: readonly number[];
    readonly ingestion: DemoUploadIngestionRunner;
    readonly repository: GenerationRepository;
    readonly retryDelaysMs?: readonly number[];
  }) {
    this.#activePollDelayMs =
      options.activePollDelayMs ?? DEFAULT_ACTIVE_POLL_DELAY_MS;
    this.#activePollLimit =
      options.activePollLimit ?? DEFAULT_ACTIVE_POLL_LIMIT;
    this.#artifacts = options.artifacts;
    this.#curriculum = options.curriculum;
    this.#delay = options.delay ?? boundedDelay;
    this.#generationRetryDelaysMs =
      options.generationRetryDelaysMs ?? DEFAULT_GENERATION_RETRY_DELAYS_MS;
    this.#ingestion = options.ingestion;
    this.#repository = options.repository;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    if (
      this.#retryDelaysMs.length !== MAX_INGESTION_DELIVERIES - 1 ||
      !isDelayList(this.#retryDelaysMs) ||
      this.#generationRetryDelaysMs.length !== 2 ||
      !isDelayList(this.#generationRetryDelaysMs) ||
      !Number.isSafeInteger(this.#activePollDelayMs) ||
      this.#activePollDelayMs < 0 ||
      this.#activePollDelayMs > 30_000 ||
      !Number.isSafeInteger(this.#activePollLimit) ||
      this.#activePollLimit < 1 ||
      this.#activePollLimit > 300
    ) {
      throw new Error("demo upload retry policy is invalid");
    }
  }

  schedule(work: DemoUploadProcessingWork): void {
    if (this.#closed) {
      throw new Error("demo upload processing is closed");
    }
    validateWork(work);
    if (this.#scheduled.has(work.generationOperationId)) {
      return;
    }
    this.#scheduled.add(work.generationOperationId);
    this.#tail = this.#tail
      .then(() => this.#process(work))
      .catch(() => undefined)
      .finally(() => {
        this.#scheduled.delete(work.generationOperationId);
      });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  async #process(work: DemoUploadProcessingWork): Promise<void> {
    const result = await this.#runIngestion(work);
    if (
      result === undefined ||
      result.kind === "in_progress" ||
      result.outcome.kind === "failed" ||
      result.outcome.kind === "ocr_required"
    ) {
      return;
    }

    let activePolls = 0;
    let localGenerationRetries = 0;
    for (;;) {
      const claim = await this.#repository.claimCourseGeneration(work);
      if (claim.kind === "completed") {
        return;
      }
      if (claim.kind === "active") {
        if (activePolls >= this.#activePollLimit) {
          return;
        }
        activePolls += 1;
        await this.#delay(this.#activePollDelayMs);
        continue;
      }
      try {
        const document = await this.#artifacts.readNormalizedDocument({
          artifactId: result.outcome.artifact.artifactId,
          documentKind: result.outcome.artifact.documentKind,
          inputSha256: work.expectedInputSha256,
          ownerScopeId: work.authorization.ownerScopeId,
        });
        await this.#curriculum.buildCurriculum({
          authorization: work.authorization,
          courseId: work.courseId,
          deadlineMs: claim.deadlineMs,
          document,
          sourceDocumentId: work.sourceDocumentId,
        });
        await this.#repository.completeCourseGeneration(work);
        return;
      } catch (error) {
        const outcome = await this.#repository.failCourseGenerationAttempt(
          work,
          normalizeGenerationFailure(error),
        );
        if (outcome === "failed") {
          return;
        }
        const delay =
          this.#generationRetryDelaysMs[localGenerationRetries] ?? 0;
        localGenerationRetries += 1;
        await this.#delay(delay);
      }
    }
  }

  async #runIngestion(
    work: DemoUploadProcessingWork,
  ): Promise<IngestionRunResult | undefined> {
    let activePolls = 0;
    let delivery = 1;
    while (delivery <= MAX_INGESTION_DELIVERIES) {
      const result = await this.#ingestion.execute(work);
      if (result.kind === "in_progress") {
        if (activePolls >= this.#activePollLimit) {
          return result;
        }
        activePolls += 1;
        await this.#delay(this.#activePollDelayMs);
        continue;
      }
      if (
        result.outcome.kind !== "failed" ||
        !result.outcome.failure.retryable
      ) {
        return result;
      }
      const retryDelay = this.#retryDelaysMs[delivery - 1];
      if (retryDelay === undefined) {
        // The durable store reconciles the exhausted delivery budget without
        // starting an additional delivery.
        return this.#ingestion.execute(work);
      }
      await this.#delay(retryDelay);
      delivery += 1;
    }
    return undefined;
  }
}

function normalizeGenerationFailure(error: unknown): {
  readonly failureClass: string;
  readonly retryable: boolean;
} {
  if (error instanceof ModelRouterError) {
    switch (error.code) {
      case "adapter_unavailable":
      case "provider_failure":
      case "trace_failure":
        return {
          failureClass: "generation_dependency_unavailable",
          retryable:
            error.code !== "provider_failure" ||
            error.providerFailure?.transient !== false,
        };
      case "deadline_exceeded":
        return {
          failureClass: "generation_deadline_exceeded",
          retryable: false,
        };
      case "feature_disabled":
      case "invalid_adapter_configuration":
      case "invalid_result":
      case "unknown_task":
        return {
          failureClass: "generation_invalid_result",
          retryable: false,
        };
    }
  }
  if (error instanceof RetrievalError) {
    switch (error.code) {
      case "persistence_failure":
        return {
          failureClass: "generation_dependency_unavailable",
          retryable: true,
        };
      case "authorization_denied":
        return {
          failureClass: "generation_authorization_denied",
          retryable: false,
        };
      case "invalid_chunk":
      case "invalid_configuration":
      case "invalid_model_result":
      case "invalid_vector_result":
        return {
          failureClass: "generation_invalid_result",
          retryable: false,
        };
    }
  }
  return {
    failureClass: "generation_dependency_unavailable",
    retryable: true,
  };
}

function validateWork(work: DemoUploadProcessingWork): void {
  if (
    !isUuid(work.authorization.actorId) ||
    work.authorization.authorizationId.length < 8 ||
    !isUuid(work.authorization.ownerScopeId) ||
    !isUuid(work.courseId) ||
    !/^[a-f0-9]{64}$/.test(work.expectedInputSha256) ||
    !isUuid(work.generationOperationId) ||
    !isUuid(work.operationId) ||
    !isUuid(work.sourceDocumentId)
  ) {
    throw new Error("demo upload processing work is invalid");
  }
}

function isDelayList(delays: readonly number[]): boolean {
  return delays.every(
    (delay) => Number.isSafeInteger(delay) && delay >= 0 && delay <= 30_000,
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function boundedDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
