import { access, mkdir, constants as fsConstants } from "node:fs/promises";
import path from "node:path";

import {
  AssessmentService,
  type AssessmentFinalizationView,
  type FrozenGradingPolicy,
} from "@reflo/assessment";
import type { Deployment } from "@reflo/config";
import {
  CONNECTED_DEMO_BOUNDARY_VERSION,
  CONNECTED_DEMO_PREFLIGHT_VERSION,
  type ConnectedDemoPreflightDependency,
  type ConnectedDemoPreflightView,
} from "@reflo/contracts";
import {
  PostgresAnalyticDbPool,
  PostgresAssessmentRepository,
  PostgresConnectedDemoRepository,
  PostgresContentRepository,
  PostgresKnowledgeRepository,
  PostgresTutorAgentRepository,
  type ConnectedDemoSessionSummary,
} from "@reflo/db";
import { LocalSmokeObjectStore } from "@reflo/dev-smoke";
import { DEMO_DELIVERY_CONTRACT_VERSION } from "@reflo/delivery";
import {
  KNOWLEDGE_ALGORITHM_VERSION,
  KNOWLEDGE_CONFIGURATION_ID,
  type AssessmentEvidenceWrite,
  type DeliveryPreference,
} from "@reflo/knowledge-model";
import {
  ROUTE_POLICY_V4,
  ROUTE_POLICY_VERSION,
  buildPromptBundle,
  createModelRouter,
} from "@reflo/model-router";
import {
  LITELLM_DEV_ADAPTER_VERSION,
  createLiteLlmDevAdapters,
} from "@reflo/model-router/litellm";
import { createDemoTraceRuntime } from "@reflo/observability";
import {
  DevelopmentPgVectorStore,
  RetrievalService,
  type AnalyticDbPoolPort,
  type ScopeAuthorizationContext,
} from "@reflo/retrieval";
import {
  TutorAgentService,
  type TutorArtifactStorePort,
  type TutorLessonReference,
} from "@reflo/tutor-agent";

import { ConnectedStudyService } from "./connected-study.js";

const CONNECTED_MODE = "staff-only-demo-v1";
const CONNECTED_BOUNDARY_PROFILE = "staff-controlled-rights-cleared-v1";
const MODEL_ADAPTER = "litellm-dev";
const POSTGRES_CONTRACT_VERSION = "reflo-schema-20260724000300";
const STORAGE_CONTRACT_VERSION = "local-smoke-object-store-v1";

export interface ConnectedAssessmentRuntime {
  gradeReplacement(input: {
    readonly answer: string;
    readonly authorization: ScopeAuthorizationContext;
    readonly bundleId: string;
    readonly idempotencyKey: string;
    readonly itemId: string;
    readonly sessionId: string;
  }): Promise<AssessmentFinalizationView>;
  gradeShortAnswer(input: {
    readonly answer: string;
    readonly authorization: ScopeAuthorizationContext;
    readonly deadlineMs: number;
    readonly idempotencyKey: string;
    readonly questionId: string;
    readonly sessionId: string;
  }): Promise<AssessmentFinalizationView>;
}

export interface ConnectedDemoPreflight {
  check(deliveryAvailable: boolean): Promise<ConnectedDemoPreflightView>;
}

export interface ConnectedDemoRuntime {
  readonly assessment?: ConnectedAssessmentRuntime;
  readonly preflight?: ConnectedDemoPreflight;
  readonly seed?: {
    reset(authorization: ScopeAuthorizationContext): Promise<{
      readonly conceptId: string;
      readonly courseId: string;
      readonly demoOnly: true;
      readonly sessionId: string;
    }>;
  };
  readonly sessions?: {
    loadSummary(
      authorization: ScopeAuthorizationContext,
      sessionId: string,
    ): Promise<ConnectedDemoSessionSummary | null>;
  };
  readonly study?: Pick<ConnectedStudyService, "load">;
  readonly tutorAgent?: TutorAgentService;
  close(): Promise<void>;
}

export function createConnectedDemoRuntime(
  input: NodeJS.ProcessEnv,
  deployment: Deployment,
): ConnectedDemoRuntime {
  const mode = input.REFLO_CONNECTED_DEMO_MODE;
  if (mode === undefined || mode === "disabled") {
    if (deployment !== "dev") {
      throw new Error(
        "REFLO_CONNECTED_DEMO_MODE must enable the connected demo runtime",
      );
    }
    return { close: async () => undefined };
  }
  if (mode !== CONNECTED_MODE) {
    throw new Error("REFLO_CONNECTED_DEMO_MODE is not allowlisted");
  }
  if (input.REFLO_MODEL_ADAPTER !== MODEL_ADAPTER) {
    throw new Error(
      "REFLO_MODEL_ADAPTER is not available for the demo runtime",
    );
  }
  if (
    input.REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE !== CONNECTED_BOUNDARY_PROFILE
  ) {
    throw new Error(
      "REFLO_CONNECTED_DEMO_BOUNDARY_PROFILE must attest the staff-controlled rights-cleared demo boundary",
    );
  }
  if (deployment !== "dev" || input.REFLO_ENV !== "dev") {
    throw new Error("LiteLLM connected composition is development-only");
  }

  const databaseUrl = required(input, "DATABASE_URL");
  const vectorDatabaseUrl = required(input, "REFLO_VECTOR_DATABASE_URL");
  const artifactRoot = requiredAbsolute(
    input,
    "REFLO_CONNECTED_DEMO_ARTIFACT_ROOT",
  );
  const tracing = createDemoTraceRuntime(input, {
    component: "api",
    deployment,
  });
  const liteLlm = createLiteLlmDevAdapters(input);
  const router = createModelRouter({
    adapters: liteLlm.adapters,
    deployment,
    traceSink: tracing.modelTraces,
  });
  const contentRepository = new PostgresContentRepository(databaseUrl);
  const vectorPool = new PostgresAnalyticDbPool(vectorDatabaseUrl);
  const retrieval = new RetrievalService({
    models: router,
    repository: contentRepository,
    vectors: new DevelopmentPgVectorStore(
      vectorPool,
      liteLlm.embeddingProfileVersion,
    ),
  });
  const assessmentRepository = new PostgresAssessmentRepository(databaseUrl);
  const knowledgeRepository = new PostgresKnowledgeRepository(databaseUrl);
  const tutorRepository = new PostgresTutorAgentRepository(databaseUrl, {
    retestItemTypes: ["short_answer"],
  });
  const connectedRepository = new PostgresConnectedDemoRepository(databaseUrl);
  const objects = new LocalSmokeObjectStore(artifactRoot);
  const tutorArtifacts = new AuthorizedLocalTutorArtifacts(objects);
  const tutorAgent = new TutorAgentService({
    artifacts: tutorArtifacts,
    models: router,
    repository: tutorRepository,
    retrieval,
    scheduler: tutorRepository,
  });
  const preference = deliveryPreference(input);
  const assessment = new KnowledgeProjectingAssessment(
    new AssessmentService({
      models: router,
      repository: assessmentRepository,
    }),
    knowledgeRepository,
    gradingPolicy(input, liteLlm.adapters.grading["qwen.grading"]!.descriptor),
    preference,
  );

  return {
    assessment,
    preflight: new RuntimePreflight({
      artifactRoot,
      boundary: {
        contractVersion: CONNECTED_DEMO_BOUNDARY_VERSION,
        destinationClass: "staff-controlled-test",
        learnerClass: "staff-controlled",
        sourceClass: "human-approved-rights-cleared",
      },
      database: connectedRepository,
      dependencyVersions: {
        delivery: DEMO_DELIVERY_CONTRACT_VERSION,
        model: `${ROUTE_POLICY_VERSION}/${LITELLM_DEV_ADAPTER_VERSION}`,
        postgres: POSTGRES_CONTRACT_VERSION,
        storage: STORAGE_CONTRACT_VERSION,
        vector: liteLlm.embeddingProfileVersion,
      },
      liteLlmApiKey: required(input, "REFLO_LITELLM_API_KEY"),
      liteLlmBaseUrl: new URL(required(input, "REFLO_LITELLM_BASE_URL")),
      vector: vectorPool,
    }),
    sessions: {
      loadSummary: (authorization, sessionId) =>
        connectedRepository.loadSessionSummary(authorization, sessionId),
    },
    seed: new ConnectedDemoSeedService(
      connectedRepository,
      knowledgeRepository,
      requiredUuid(input, "REFLO_DEMO_SEED_COURSE_ID"),
      preference,
    ),
    study: new ConnectedStudyService(tutorRepository, tutorArtifacts),
    tutorAgent,
    close: async () => {
      const results = await Promise.allSettled([
        assessmentRepository.close(),
        connectedRepository.close(),
        contentRepository.close(),
        knowledgeRepository.close(),
        tutorRepository.close(),
        vectorPool.close(),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("connected demo runtime cleanup failed");
      }
    },
  };
}

class KnowledgeProjectingAssessment implements ConnectedAssessmentRuntime {
  constructor(
    private readonly assessment: AssessmentService,
    private readonly knowledge: PostgresKnowledgeRepository,
    private readonly policy: FrozenGradingPolicy,
    private readonly preference: DeliveryPreference,
  ) {}

  async gradeShortAnswer(
    input: Parameters<ConnectedAssessmentRuntime["gradeShortAnswer"]>[0],
  ): Promise<AssessmentFinalizationView> {
    const result = await this.assessment.gradeShortAnswer({
      ...input,
      policy: this.policy,
    });
    await this.#project(input.authorization, result);
    return result;
  }

  async gradeReplacement(
    input: Parameters<ConnectedAssessmentRuntime["gradeReplacement"]>[0],
  ): Promise<AssessmentFinalizationView> {
    const result = await this.assessment.gradeReplacement({
      ...input,
      policy: this.policy,
    });
    await this.#project(input.authorization, result);
    return result;
  }

  async #project(
    authorization: ScopeAuthorizationContext,
    result: AssessmentFinalizationView,
  ): Promise<void> {
    for (const evidence of result.evidence) {
      await this.knowledge.recordEvidenceAndReplay(
        authorization,
        assessmentEvidence(result, evidence),
        this.preference,
      );
    }
  }
}

class ConnectedDemoSeedService {
  constructor(
    private readonly repository: Pick<
      PostgresConnectedDemoRepository,
      "resetWeakState"
    >,
    private readonly knowledge: PostgresKnowledgeRepository,
    private readonly courseId: string,
    private readonly preference: DeliveryPreference,
  ) {}

  async reset(authorization: ScopeAuthorizationContext) {
    const seed = await this.repository.resetWeakState(
      authorization,
      this.courseId,
    );
    for (const evidence of seed.evidence) {
      await this.knowledge.recordEvidenceAndReplay(
        authorization,
        evidence,
        this.preference,
      );
    }
    return {
      conceptId: seed.conceptId,
      courseId: seed.courseId,
      demoOnly: true as const,
      sessionId: seed.sessionId,
    };
  }
}

class AuthorizedLocalTutorArtifacts implements TutorArtifactStorePort {
  constructor(private readonly objects: LocalSmokeObjectStore) {}

  putImmutable(
    input: Parameters<TutorArtifactStorePort["putImmutable"]>[0],
  ): ReturnType<TutorArtifactStorePort["putImmutable"]> {
    return this.objects.putImmutable(input);
  }

  async readAuthorizedText(input: {
    readonly authorization: ScopeAuthorizationContext;
    readonly lesson: TutorLessonReference;
  }): Promise<string | null> {
    const expectedPrefix = `owners/${input.authorization.ownerScopeId}/`;
    if (!input.lesson.objectKey.startsWith(expectedPrefix)) {
      return null;
    }
    try {
      return Buffer.from(
        await this.objects.read(input.lesson.objectKey),
      ).toString("utf8");
    } catch {
      return null;
    }
  }
}

class RuntimePreflight implements ConnectedDemoPreflight {
  constructor(
    private readonly dependencies: {
      readonly artifactRoot: string;
      readonly boundary: ConnectedDemoPreflightView["boundary"];
      readonly database: Pick<PostgresConnectedDemoRepository, "ping">;
      readonly dependencyVersions: Readonly<
        Record<"delivery" | "model" | "postgres" | "storage" | "vector", string>
      >;
      readonly liteLlmApiKey: string;
      readonly liteLlmBaseUrl: URL;
      readonly vector: Pick<AnalyticDbPoolPort, "connect">;
    },
  ) {}

  async check(deliveryAvailable: boolean) {
    const [postgres, model, storage, vector] = await Promise.all([
      availableWhen(() => this.dependencies.database.ping()),
      availableWhen(() => this.#model()),
      availableWhen(() => this.#storage()),
      availableWhen(() => this.#vector()),
    ]);
    const deliveryCode: "available" | "unavailable" = deliveryAvailable
      ? "available"
      : "unavailable";
    const dependencies: ConnectedDemoPreflightDependency[] = [
      {
        code: deliveryCode,
        contractVersion: this.dependencies.dependencyVersions.delivery,
        name: "delivery" as const,
      },
      {
        code: model,
        contractVersion: this.dependencies.dependencyVersions.model,
        name: "model" as const,
      },
      {
        code: postgres,
        contractVersion: this.dependencies.dependencyVersions.postgres,
        name: "postgres" as const,
      },
      {
        code: storage,
        contractVersion: this.dependencies.dependencyVersions.storage,
        name: "storage" as const,
      },
      {
        code: vector,
        contractVersion: this.dependencies.dependencyVersions.vector,
        name: "vector" as const,
      },
    ];
    return {
      boundary: this.dependencies.boundary,
      checkedAt: new Date().toISOString(),
      contractVersion: CONNECTED_DEMO_PREFLIGHT_VERSION,
      dependencies,
      status: dependencies.every(
        (dependency) => dependency.code === "available",
      )
        ? ("ready" as const)
        : ("unavailable" as const),
    };
  }

  async #model(): Promise<void> {
    const response = await boundedFetch(
      new URL("v1/models", this.dependencies.liteLlmBaseUrl),
      {
        headers: {
          authorization: `Bearer ${this.dependencies.liteLlmApiKey}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error("model dependency unavailable");
    }
    await response.body?.cancel();
  }

  async #storage(): Promise<void> {
    await mkdir(this.dependencies.artifactRoot, {
      mode: 0o700,
      recursive: true,
    });
    await access(
      this.dependencies.artifactRoot,
      fsConstants.R_OK | fsConstants.W_OK,
    );
  }

  async #vector(): Promise<void> {
    const session = await this.dependencies.vector.connect();
    try {
      const result = await session.query<{ ready: number }>(
        "SELECT 1::integer AS ready",
      );
      if (result.rows[0]?.ready !== 1) {
        throw new Error("vector dependency unavailable");
      }
    } finally {
      session.release();
    }
  }
}

function assessmentEvidence(
  result: AssessmentFinalizationView,
  evidence: AssessmentFinalizationView["evidence"][number],
): AssessmentEvidenceWrite {
  return {
    attemptId: result.attemptId,
    conceptId: evidence.conceptId,
    eligibleForMastery: evidence.eligibleForMastery,
    fsrsRating: evidence.fsrsRating,
    graderConfidence: evidence.graderConfidence,
    gradingMethod: evidence.gradingMethod,
    gradingPolicyVersion: "grading-policy-v1",
    ineligibilityReason: evidence.ineligibilityReason,
    judgmentKind: evidence.judgmentKind,
    knowledgeAlgorithmVersion: KNOWLEDGE_ALGORITHM_VERSION,
    knowledgeConfigurationId: KNOWLEDGE_CONFIGURATION_ID,
    rationaleRef: evidence.rationaleRef,
    ratingMappingVersion: "rating-mapping-v1",
    replacementForAttemptId: result.replacementForAttemptId,
    rubricBand: evidence.rubricBand,
    rubricId: evidence.rubricId,
    rubricVersion: evidence.rubricVersion,
    score: evidence.score,
    unanswerableReason:
      evidence.judgmentKind === "unanswerable" ? evidence.reason : null,
  };
}

function gradingPolicy(
  input: NodeJS.ProcessEnv,
  descriptor: {
    readonly effectiveModel: string;
    readonly effectiveModelVersion: string;
  },
): FrozenGradingPolicy {
  const route = ROUTE_POLICY_V4["assessment.grade-short-answer.v1"];
  const prompt = buildPromptBundle("assessment.grade-short-answer.v1", {
    answer: "",
    question: "",
    rubrics: [],
    sourceSpans: [],
  });
  return {
    calibrationEvidenceId: required(
      input,
      "REFLO_DEMO_GRADING_CALIBRATION_EVIDENCE_ID",
    ),
    confidenceThreshold: exactUnit(
      required(input, "REFLO_DEMO_GRADING_CONFIDENCE_THRESHOLD"),
    ),
    expectedModelProvenance: {
      effectiveModel: descriptor.effectiveModel,
      effectiveModelVersion: descriptor.effectiveModelVersion,
      generationParametersVersion: prompt.generationParametersVersion,
      inputSchemaVersion: route.inputSchemaVersion,
      promptDefinitionDigest: prompt.definitionDigest,
      promptId: prompt.id,
      promptVersion: prompt.version,
      resultSchemaVersion: route.resultSchemaVersion,
      routePolicyVersion: "route-policy-v4",
    },
    gradingPolicyVersion: "grading-policy-v1",
    ratingMappingVersion: "rating-mapping-v1",
  };
}

function deliveryPreference(input: NodeJS.ProcessEnv): DeliveryPreference {
  const chosenLocalTime = required(input, "REFLO_DEMO_REVIEW_LOCAL_TIME");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(chosenLocalTime)) {
    throw new Error("REFLO_DEMO_REVIEW_LOCAL_TIME is invalid");
  }
  const timeZone = required(input, "REFLO_DEMO_REVIEW_TIME_ZONE");
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error("REFLO_DEMO_REVIEW_TIME_ZONE is invalid");
  }
  return { chosenLocalTime, timeZone };
}

async function availableWhen(
  check: () => Promise<void>,
): Promise<"available" | "unavailable"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("dependency preflight timed out")),
          5_000,
        );
        timer.unref();
      }),
    ]);
    return "available";
  } catch {
    return "unavailable";
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function boundedFetch(url: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function exactUnit(value: string): string {
  if (!/^(?:0(?:\.\d{5})|1\.00000)$/.test(value)) {
    throw new Error(
      "REFLO_DEMO_GRADING_CONFIDENCE_THRESHOLD must use five decimals",
    );
  }
  return value;
}

function required(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredAbsolute(input: NodeJS.ProcessEnv, name: string): string {
  const value = required(input, name);
  if (!path.isAbsolute(value) || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function requiredUuid(input: NodeJS.ProcessEnv, name: string): string {
  const value = required(input, name);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}
