import type { IngestionRunResult, NormalizedDocument } from "@reflo/ingestion";
import { ModelRouterError } from "@reflo/model-router";
import type { DemoUploadGenerationClaim } from "@reflo/db";
import { describe, expect, it, vi } from "vitest";

import { DemoUploadProcessingService } from "./demo-upload-processing.js";

const work = Object.freeze({
  authorization: {
    actorId: "55100000-0000-4000-8000-000000000001",
    authorizationId: "demo-processing-test",
    ownerScopeId: "55100000-0000-4000-8000-000000000002",
  },
  courseId: "55100000-0000-4000-8000-000000000003",
  expectedInputSha256: "a".repeat(64),
  generationOperationId: "55100000-0000-4000-8000-000000000006",
  operationId: "55100000-0000-4000-8000-000000000004",
  sourceDocumentId: "55100000-0000-4000-8000-000000000005",
});
const artifact = Object.freeze({
  artifactId: "artifact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  blockCount: 1,
  byteLength: 1_024,
  documentKind: "pdf" as const,
  documentSha256: "b".repeat(64),
  inputSha256: work.expectedInputSha256,
  pageCount: 1,
  parserVersion: "apache-tika-3.3.1" as const,
  workerImageDigest: `sha256:${"c".repeat(64)}`,
});
const document = Object.freeze({
  blocks: [],
  classifierVersion: "scan-detect-v1",
  configVersion: "isolated-ingestion-v1",
  contractVersion: "normalized-document-v1",
  diagnostics: [],
  documentKind: "pdf",
  inputSha256: work.expectedInputSha256,
  pageCount: 1,
  parserVersion: "apache-tika-3.3.1",
  scan: {
    candidatePages: [],
    classification: "digital",
    rasterDpi: 300,
  },
  workerImageDigest: artifact.workerImageDigest,
} as const satisfies NormalizedDocument);
const parsed: IngestionRunResult = {
  kind: "completed",
  outcome: { artifact, kind: "parsed", processingLane: "standard" },
};

describe("demo upload processing queue", () => {
  it("runs bounded ingestion retries before durably completing generation", async () => {
    const transient: IngestionRunResult = {
      kind: "completed",
      outcome: {
        failure: {
          code: "infrastructure_unavailable",
          retryable: true,
        },
        kind: "failed",
      },
    };
    const fixture = createFixture([transient, transient, parsed]);

    fixture.service.schedule(work);
    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.ingestion.execute).toHaveBeenCalledTimes(3);
    expect(fixture.delay).toHaveBeenNthCalledWith(1, 1);
    expect(fixture.delay).toHaveBeenNthCalledWith(2, 2);
    expect(fixture.repository.claimCourseGeneration).toHaveBeenCalledWith(work);
    expect(fixture.curriculum.buildCurriculum).toHaveBeenCalledWith({
      authorization: work.authorization,
      courseId: work.courseId,
      deadlineMs: 480_000,
      document,
      sourceDocumentId: work.sourceDocumentId,
    });
    expect(fixture.repository.completeCourseGeneration).toHaveBeenCalledWith(
      work,
    );
  });

  it("waits for a live ingestion lease so restart recovery can take over", async () => {
    const fixture = createFixture([{ kind: "in_progress" }, parsed]);

    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.ingestion.execute).toHaveBeenCalledTimes(2);
    expect(fixture.delay).toHaveBeenCalledWith(7);
    expect(fixture.repository.completeCourseGeneration).toHaveBeenCalledWith(
      work,
    );
  });

  it("waits for a live generation lease before claiming recovered work", async () => {
    const fixture = createFixture([parsed]);
    fixture.repository.claimCourseGeneration
      .mockResolvedValueOnce({ kind: "active" })
      .mockResolvedValueOnce({ deadlineMs: 480_000, kind: "claimed" });

    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.repository.claimCourseGeneration).toHaveBeenCalledTimes(2);
    expect(fixture.delay).toHaveBeenCalledWith(7);
    expect(fixture.repository.completeCourseGeneration).toHaveBeenCalledWith(
      work,
    );
  });

  it("leaves an honest OCR terminal state without generating an outline", async () => {
    const fixture = createFixture([
      {
        kind: "completed",
        outcome: {
          artifact,
          candidatePages: [1],
          classification: "scanned",
          kind: "ocr_required",
          processingLane: "large",
        },
      },
    ]);

    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.curriculum.buildCurriculum).not.toHaveBeenCalled();
    expect(fixture.repository.claimCourseGeneration).not.toHaveBeenCalled();
  });

  it("reconciles the durable terminal failure after five transient deliveries", async () => {
    const transient: IngestionRunResult = {
      kind: "completed",
      outcome: {
        failure: {
          code: "infrastructure_unavailable",
          retryable: true,
        },
        kind: "failed",
      },
    };
    const terminal: IngestionRunResult = {
      kind: "completed",
      outcome: {
        failure: { code: "parse_timeout", retryable: false },
        kind: "failed",
      },
    };
    const fixture = createFixture([
      transient,
      transient,
      transient,
      transient,
      transient,
      terminal,
    ]);

    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.ingestion.execute).toHaveBeenCalledTimes(6);
    expect(fixture.curriculum.buildCurriculum).not.toHaveBeenCalled();
  });

  it("retries transient curriculum failures through the durable operation", async () => {
    const fixture = createFixture([parsed], ["retry_scheduled"]);
    fixture.curriculum.buildCurriculum
      .mockRejectedValueOnce(new Error("temporary vector store outage"))
      .mockResolvedValueOnce({});

    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.repository.failCourseGenerationAttempt).toHaveBeenCalledWith(
      work,
      {
        failureClass: "generation_dependency_unavailable",
        retryable: true,
      },
    );
    expect(fixture.repository.claimCourseGeneration).toHaveBeenCalledTimes(2);
    expect(fixture.curriculum.buildCurriculum).toHaveBeenCalledTimes(2);
    expect(fixture.repository.completeCourseGeneration).toHaveBeenCalledWith(
      work,
    );
  });

  it("persists deterministic model failures without retrying", async () => {
    const fixture = createFixture([parsed], ["failed"]);
    fixture.curriculum.buildCurriculum.mockRejectedValueOnce(
      new ModelRouterError("invalid_result", "invalid structured output"),
    );

    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.repository.failCourseGenerationAttempt).toHaveBeenCalledWith(
      work,
      {
        failureClass: "generation_invalid_result",
        retryable: false,
      },
    );
    expect(fixture.repository.claimCourseGeneration).toHaveBeenCalledTimes(1);
    expect(fixture.repository.completeCourseGeneration).not.toHaveBeenCalled();
  });
});

function createFixture(
  results: readonly IngestionRunResult[],
  failureOutcomes: readonly ("failed" | "retry_scheduled")[] = [],
) {
  const queue = [...results];
  const persistedFailureOutcomes = [...failureOutcomes];
  const artifacts = {
    readNormalizedDocument: vi.fn(async () => document),
  };
  const curriculum = {
    buildCurriculum: vi.fn(async () => ({})),
  };
  const delay = vi.fn(async () => undefined);
  const ingestion = {
    execute: vi.fn(async () => {
      const result = queue.shift();
      if (result === undefined) {
        throw new Error("missing fake ingestion outcome");
      }
      return result;
    }),
  };
  const repository = {
    claimCourseGeneration: vi.fn(
      async (): Promise<DemoUploadGenerationClaim> => ({
        deadlineMs: 480_000,
        kind: "claimed",
      }),
    ),
    completeCourseGeneration: vi.fn(async () => undefined),
    failCourseGenerationAttempt: vi.fn(async () => {
      return persistedFailureOutcomes.shift() ?? "failed";
    }),
  };
  const service = new DemoUploadProcessingService({
    activePollDelayMs: 7,
    activePollLimit: 2,
    artifacts,
    curriculum,
    delay,
    generationRetryDelaysMs: [5, 6],
    ingestion,
    repository,
    retryDelaysMs: [1, 2, 3, 4],
  });
  return {
    artifacts,
    curriculum,
    delay,
    ingestion,
    repository,
    service,
  };
}
