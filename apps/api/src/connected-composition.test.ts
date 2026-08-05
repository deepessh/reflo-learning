import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AssessmentError,
  AssessmentFinalizationView,
  FrozenGradingPolicy,
} from "@reflo/assessment";
import { KnowledgePersistenceError } from "@reflo/db";
import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
} from "@reflo/knowledge-model";

import {
  createConnectedDemoRuntime,
  KnowledgeProjectingAssessment,
  type ConnectedDemoRuntime,
} from "./connected-composition.js";

const runtimes: ConnectedDemoRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  vi.unstubAllGlobals();
});

describe("connected demo composition", () => {
  it("injects real runtime services and reports bounded dependency states", async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "reflo-connected-api-"),
    );
    directories.push(artifactRoot);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"data":[]}', {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    const runtime = await createConnectedDemoRuntime(
      developmentEnvironment(artifactRoot),
      "dev",
    );
    runtimes.push(runtime);

    expect(runtime.assessment).toBeDefined();
    expect(runtime.study).toBeDefined();
    expect(runtime.tutorAgent).toBeDefined();
    expect(runtime.sessions).toBeDefined();
    await expect(runtime.preflight!.check(false)).resolves.toMatchObject({
      boundary: {
        contractVersion: "connected-demo-boundary-v1",
        destinationClass: "staff-controlled-test",
        learnerClass: "staff-controlled",
        sourceClass: "human-approved-rights-cleared",
      },
      dependencies: [
        { code: "unavailable", name: "delivery" },
        { code: "available", name: "model" },
        { code: "unavailable", name: "postgres" },
        { code: "available", name: "storage" },
        { code: "unavailable", name: "vector" },
      ],
      status: "unavailable",
    });
    await expect(runtime.close()).resolves.toBeUndefined();
    runtimes.pop();
  });

  it("rejects development model descriptors in staging and pilot", async () => {
    for (const deployment of ["pilot", "staging"] as const) {
      await expect(
        createConnectedDemoRuntime(
          {
            REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE:
              "staff-controlled-rights-cleared-v1",
            REFLO_CONNECTED_DEMO_MODE: "staff-only-demo-v1",
            REFLO_ENV: deployment,
            REFLO_MODEL_ADAPTER: "litellm-dev",
          },
          deployment,
        ),
      ).rejects.toThrow("development-only");
    }
  });

  it("fails closed without an explicit staff and source boundary profile", async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "reflo-connected-api-"),
    );
    directories.push(artifactRoot);
    const environment = developmentEnvironment(artifactRoot);
    delete environment.REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE;

    await expect(
      createConnectedDemoRuntime(environment, "dev"),
    ).rejects.toThrow(
      "must attest the staff-controlled rights-cleared demo boundary",
    );
  });

  it("retries a transient post-finalization projection before returning the durable result", async () => {
    const result = assessmentResult();
    const assessment = {
      gradeReplacement: vi.fn(),
      gradeShortAnswer: vi.fn().mockResolvedValue(result),
    };
    const project = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary database connection"))
      .mockResolvedValue(knowledgeState());
    const service = new KnowledgeProjectingAssessment(
      assessment,
      { recordEvidenceAndReplay: project },
      gradingPolicy(),
      { loadPreference: vi.fn().mockResolvedValue(null) },
      { chosenLocalTime: "09:00", timeZone: "UTC" },
      [0],
    );

    await expect(service.gradeShortAnswer(gradingInput())).resolves.toBe(
      result,
    );
    expect(project).toHaveBeenCalledTimes(2);
    expect(assessment.gradeShortAnswer).toHaveBeenCalledTimes(1);
  });

  it("reports a persisted-result recovery error without retrying invalid evidence", async () => {
    const project = vi
      .fn()
      .mockRejectedValue(new KnowledgePersistenceError("invalid_evidence"));
    const service = new KnowledgeProjectingAssessment(
      {
        gradeReplacement: vi.fn(),
        gradeShortAnswer: vi.fn().mockResolvedValue(assessmentResult()),
      },
      { recordEvidenceAndReplay: project },
      gradingPolicy(),
      { loadPreference: vi.fn().mockResolvedValue(null) },
      { chosenLocalTime: "09:00", timeZone: "UTC" },
      [0, 0],
    );

    await expect(
      service.gradeShortAnswer(gradingInput()),
    ).rejects.toMatchObject<Partial<AssessmentError>>({
      code: "projection_unavailable",
    });
    expect(project).toHaveBeenCalledTimes(1);
  });
});

function assessmentResult(): AssessmentFinalizationView {
  return {
    attemptId: "80000000-0000-4000-8000-000000000001",
    evidence: [
      {
        conceptId: "40000000-0000-4000-8000-000000000001",
        eligibleForMastery: true,
        fsrsRating: 3,
        graderConfidence: null,
        gradingMethod: "keyed_mc",
        ineligibilityReason: null,
        judgmentKind: "scored",
        rationaleRef: "keyed-mc/question-1",
        rubricBand: "correct",
        rubricId: "rubric-1",
        rubricVersion: "1",
        score: "1.00000",
      },
    ],
    fallback: null,
    learnerMessage: "Your response was graded.",
    outcome: "graded",
    replacementForAttemptId: null,
    requestDigest: "a".repeat(64),
    status: "replayed",
  };
}

function gradingInput() {
  return {
    answer: "A source-backed answer",
    authorization: {
      actorId: "00000000-0000-4000-8000-000000000001",
      authorizationId: "test-authorization",
      ownerScopeId: "00000000-0000-4000-8000-000000000101",
    },
    deadlineMs: 90_000,
    idempotencyKey: "test/assessment/replay",
    questionId: "60000000-0000-4000-8000-000000000001",
    sessionId: "70000000-0000-4000-8000-000000000001",
  };
}

function gradingPolicy(): FrozenGradingPolicy {
  return {
    calibrationEvidenceId: "calibration-v1",
    confidenceThreshold: "0.95000",
    expectedModelProvenance: {
      effectiveModel: "qwen-plus",
      effectiveModelVersion: "fixture-version-1",
      generationParametersVersion: "grading-generation-parameters-v2",
      inputSchemaVersion: "short-answer-grading-input-v2",
      promptDefinitionDigest: "b".repeat(64),
      promptId: "assessment-grade-short-answer",
      promptVersion: "3",
      resultSchemaVersion: "short-answer-judgment-result-v2",
      routePolicyVersion: "route-policy-v6",
    },
    gradingPolicyVersion: "grading-policy-v1",
    ratingMappingVersion: "rating-mapping-v1",
  };
}

function knowledgeState() {
  return {
    algorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
    alphaQuanta: "200000",
    assessmentStatus: "assessed" as const,
    betaQuanta: "300000",
    confidence: "0.20000",
    configurationId: KNOWLEDGE_CONFIGURATION_ID,
    evidenceCount: 1,
    lastReviewedAt: "2026-08-04T12:00:00.000Z",
    mastery: "0.40000",
  };
}

function developmentEnvironment(artifactRoot: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://127.0.0.1:1/reflo",
    REFLO_CONNECTED_DEMO_ARTIFACT_ROOT: artifactRoot,
    REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE: "staff-controlled-rights-cleared-v1",
    REFLO_CONNECTED_DEMO_MODE: "staff-only-demo-v1",
    REFLO_CONNECTED_DEMO_OBJECT_STORE: "local-filesystem-v1",
    REFLO_DEMO_GRADING_CALIBRATION_EVIDENCE_ID:
      "synthetic-demo-calibration-fixture-v1",
    REFLO_DEMO_GRADING_CONFIDENCE_THRESHOLD: "0.95000",
    REFLO_DEMO_REVIEW_LOCAL_TIME: "09:00",
    REFLO_DEMO_REVIEW_TIME_ZONE: "UTC",
    REFLO_DEMO_SEED_COURSE_ID: "50000000-0000-4000-8000-000000000162",
    REFLO_DEMO_TRACING_MODE: "disabled",
    REFLO_ENV: "dev",
    REFLO_LITELLM_API_KEY: "dev-only-placeholder",
    REFLO_LITELLM_BASE_URL: "http://127.0.0.1:4000",
    REFLO_LITELLM_EMBEDDING_MODEL: "reflo-local-embedding",
    REFLO_LITELLM_TEXT_MODEL: "reflo-local-text",
    REFLO_MODEL_ADAPTER: "litellm-dev",
    REFLO_VECTOR_DATABASE_URL: "postgresql://127.0.0.1:1/reflo_vectors",
  };
}
