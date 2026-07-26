import type { IngestionRunResult, NormalizedDocument } from "@reflo/ingestion";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

import type {
  DemoUploadPersistence,
  DemoUploadProcessingQueue,
  DemoUploadProcessingWork,
} from "./demo-upload.js";

const MAX_INGESTION_DELIVERIES = 5;
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

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

export class DemoUploadProcessingService implements DemoUploadProcessingQueue {
  readonly #artifacts: DemoUploadNormalizedArtifactReader;
  readonly #curriculum: DemoUploadCurriculumBuilder;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #ingestion: DemoUploadIngestionRunner;
  readonly #repository: Pick<DemoUploadPersistence, "failCourseGeneration">;
  readonly #retryDelaysMs: readonly number[];
  readonly #scheduled = new Set<string>();
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly artifacts: DemoUploadNormalizedArtifactReader;
    readonly curriculum: DemoUploadCurriculumBuilder;
    readonly delay?: (milliseconds: number) => Promise<void>;
    readonly ingestion: DemoUploadIngestionRunner;
    readonly repository: Pick<DemoUploadPersistence, "failCourseGeneration">;
    readonly retryDelaysMs?: readonly number[];
  }) {
    this.#artifacts = options.artifacts;
    this.#curriculum = options.curriculum;
    this.#delay = options.delay ?? boundedDelay;
    this.#ingestion = options.ingestion;
    this.#repository = options.repository;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    if (
      this.#retryDelaysMs.length !== MAX_INGESTION_DELIVERIES - 1 ||
      this.#retryDelaysMs.some(
        (delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 30_000,
      )
    ) {
      throw new Error("demo upload retry policy is invalid");
    }
  }

  schedule(work: DemoUploadProcessingWork): void {
    if (this.#closed) {
      throw new Error("demo upload processing is closed");
    }
    validateWork(work);
    if (this.#scheduled.has(work.operationId)) {
      return;
    }
    this.#scheduled.add(work.operationId);
    this.#tail = this.#tail
      .then(() => this.#process(work))
      .catch(async () => {
        await this.#failGeneratedCourse(work).catch(() => undefined);
      });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  async #process(work: DemoUploadProcessingWork): Promise<void> {
    let result: IngestionRunResult | undefined;
    for (
      let delivery = 1;
      delivery <= MAX_INGESTION_DELIVERIES;
      delivery += 1
    ) {
      result = await this.#ingestion.execute(work);
      if (
        result.kind !== "completed" ||
        result.outcome.kind !== "failed" ||
        !result.outcome.failure.retryable
      ) {
        break;
      }
      const retryDelay = this.#retryDelaysMs[delivery - 1];
      if (retryDelay !== undefined) {
        await this.#delay(retryDelay);
      }
    }
    if (
      result?.kind === "completed" &&
      result.outcome.kind === "failed" &&
      result.outcome.failure.retryable
    ) {
      // The durable store performs this reconciliation without starting a
      // sixth delivery once the five-delivery budget is exhausted.
      result = await this.#ingestion.execute(work);
    }
    if (
      result === undefined ||
      result.kind === "in_progress" ||
      result.outcome.kind === "failed" ||
      result.outcome.kind === "ocr_required"
    ) {
      return;
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
        deadlineMs: 120_000,
        document,
        sourceDocumentId: work.sourceDocumentId,
      });
    } catch {
      await this.#failGeneratedCourse(work);
    }
  }

  #failGeneratedCourse(work: DemoUploadProcessingWork): Promise<void> {
    return this.#repository.failCourseGeneration(
      work.authorization,
      work.sourceDocumentId,
    );
  }
}

function validateWork(work: DemoUploadProcessingWork): void {
  if (
    !isUuid(work.authorization.actorId) ||
    work.authorization.authorizationId.length < 8 ||
    !isUuid(work.authorization.ownerScopeId) ||
    !isUuid(work.courseId) ||
    !/^[a-f0-9]{64}$/.test(work.expectedInputSha256) ||
    !isUuid(work.operationId) ||
    !isUuid(work.sourceDocumentId)
  ) {
    throw new Error("demo upload processing work is invalid");
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
