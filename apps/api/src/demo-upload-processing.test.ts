import type { IngestionRunResult, NormalizedDocument } from "@reflo/ingestion";
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

describe("demo upload processing queue", () => {
  it("runs bounded ingestion retries before building the source-backed curriculum", async () => {
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
    const parsed: IngestionRunResult = {
      kind: "completed",
      outcome: { artifact, kind: "parsed", processingLane: "standard" },
    };
    const fixture = createFixture([transient, transient, parsed]);

    fixture.service.schedule(work);
    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.ingestion.execute).toHaveBeenCalledTimes(3);
    expect(fixture.delay).toHaveBeenNthCalledWith(1, 1);
    expect(fixture.delay).toHaveBeenNthCalledWith(2, 2);
    expect(fixture.artifacts.readNormalizedDocument).toHaveBeenCalledWith({
      artifactId: artifact.artifactId,
      documentKind: "pdf",
      inputSha256: work.expectedInputSha256,
      ownerScopeId: work.authorization.ownerScopeId,
    });
    expect(fixture.curriculum.buildCurriculum).toHaveBeenCalledWith({
      authorization: work.authorization,
      courseId: work.courseId,
      deadlineMs: 120_000,
      document,
      sourceDocumentId: work.sourceDocumentId,
    });
    expect(fixture.repository.failCourseGeneration).not.toHaveBeenCalled();
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
    expect(fixture.repository.failCourseGeneration).not.toHaveBeenCalled();
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
    expect(fixture.delay).toHaveBeenCalledTimes(4);
    expect(fixture.curriculum.buildCurriculum).not.toHaveBeenCalled();
  });

  it("records curriculum failure after parsing instead of leaving false success", async () => {
    const fixture = createFixture([
      {
        kind: "completed",
        outcome: { artifact, kind: "parsed", processingLane: "standard" },
      },
    ]);
    fixture.curriculum.buildCurriculum.mockRejectedValueOnce(
      new Error("invalid structured output"),
    );

    fixture.service.schedule(work);
    await fixture.service.close();

    expect(fixture.repository.failCourseGeneration).toHaveBeenCalledWith(
      work.authorization,
      work.sourceDocumentId,
    );
  });
});

function createFixture(results: readonly IngestionRunResult[]) {
  const queue = [...results];
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
    failCourseGeneration: vi.fn(async () => undefined),
  };
  const service = new DemoUploadProcessingService({
    artifacts,
    curriculum,
    delay,
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
