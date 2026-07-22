import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ActivationGenerationService,
  type AuthorizedActivationCourse,
} from "@reflo/activation";
import { AudioGenerationService, buildAudioPlan } from "@reflo/audio";
import {
  PostgresActivationRepository,
  PostgresAnalyticDbPool,
  PostgresAudioGenerationRepository,
  PostgresContentRepository,
  PostgresDevelopmentSmokeRepository,
  PostgresIngestionOperationStore,
  type DevelopmentSmokeSnapshot,
} from "@reflo/db";
import {
  IngestionSupervisor,
  NodeEphemeralWorkspace,
  NodeProcessRunner,
  NormalizedOutputFileReader,
  ObjectArtifactPublisher,
  PodmanDocumentWorker,
  QuarantineStagingAdapter,
  validateNormalizedDocument,
} from "@reflo/ingestion";
import {
  ModelAdapterError,
  ModelRouterError,
  createModelRouter,
  type ModelAdapterRegistry,
  type ModelLogicalCallTrace,
  type ModelTraceSink,
  type SpeechModelPort,
} from "@reflo/model-router";
import { createFalDevVideoAdapter } from "@reflo/model-router/fal";
import { createLiteLlmDevAdapters } from "@reflo/model-router/litellm";
import {
  NodePiperSynthesisProcess,
  createPiperTtsAdapter,
} from "@reflo/model-router/tts";
import {
  DevelopmentPgVectorStore,
  RetrievalService,
  sha256,
  stableUuid,
  type ScopeAuthorizationContext,
} from "@reflo/retrieval";

import {
  SmokePreflightError,
  readLocalSmokeConfiguration,
  verifyLocalSmokePrerequisites,
} from "./configuration.js";
import {
  DevelopmentVideoArtifactError,
  FixtureQuarantineDownload,
  LOCAL_SMOKE_SCANNER,
  LocalSmokeObjectStore,
  TrustedFixtureAdmissionScanner,
  artifactObjectKey,
  copyDevelopmentVideoArtifact,
} from "./local-adapters.js";

const IDS = Object.freeze({
  actor: "11200000-0000-4000-8000-000000000001",
  course: "11200000-0000-4000-8000-000000000004",
  ingestionOperation: "11200000-0000-4000-8000-000000000005",
  membership: "11200000-0000-4000-8000-000000000003",
  scope: "11200000-0000-4000-8000-000000000002",
  source: "11200000-0000-4000-8000-000000000006",
});
const AUTHORIZATION: ScopeAuthorizationContext = Object.freeze({
  actorId: IDS.actor,
  authorizationId: "local-smoke-auth-112",
  ownerScopeId: IDS.scope,
});
const SOURCE_OBJECT_KEY = `owners/${IDS.scope}/sources/${IDS.source}/versions/v1/original.pdf`;
const VIDEO_MANIFEST_KEY = `owners/${IDS.scope}/courses/${IDS.course}/assets/development-fal-video/manifest.json`;

interface ComponentResult {
  readonly detail: string;
  readonly name: string;
  readonly status: "ran" | "replayed" | "skipped";
}

interface SmokeSummary {
  readonly boundary: readonly string[];
  readonly components: readonly ComponentResult[];
  readonly contractVersion: "local-development-smoke-v1";
  readonly counts: DevelopmentSmokeSnapshot;
  readonly fixtureSha256: string;
  readonly outcome: "passed";
  readonly replayVerified: true;
  readonly retrievedSourceSpanCount: number;
  readonly traceCount: number;
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  try {
    const configuration = readLocalSmokeConfiguration(
      process.env,
      repositoryRoot,
    );
    await verifyLocalSmokePrerequisites(configuration);
    const summary = await runSmoke(configuration);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(JSON.stringify(failureSummary(error), null, 2));
    process.exitCode = 1;
  }
}

async function runSmoke(
  configuration: ReturnType<typeof readLocalSmokeConfiguration>,
): Promise<SmokeSummary> {
  const fixtureBytes = await readFile(configuration.fixturePath);
  const fixtureSha256 = digest(fixtureBytes);
  const components: ComponentResult[] = [];
  const traces = new BoundedTraceSink();
  const objects = new LocalSmokeObjectStore(configuration.artifactRoot);
  const smokeRepository = new PostgresDevelopmentSmokeRepository({
    connectionString: configuration.databaseUrl,
    environment: "dev",
  });
  const ingestionRepository = new PostgresIngestionOperationStore({
    connectionString: configuration.databaseUrl,
    environment: "dev",
    leaseDurationMs: 60_000,
    leaseOwner: "local_smoke_112",
  });
  const contentRepository = new PostgresContentRepository(
    configuration.databaseUrl,
  );
  const activationRepository = new PostgresActivationRepository(
    configuration.databaseUrl,
  );
  const audioRepository = new PostgresAudioGenerationRepository({
    connectionString: configuration.databaseUrl,
    leaseDurationMs: 60_000,
    leaseOwner: "local_smoke_audio_112",
  });
  const vectorPool = new PostgresAnalyticDbPool(
    configuration.vectorDatabaseUrl,
  );

  try {
    await smokeRepository.seed({
      authorization: AUTHORIZATION,
      courseId: IDS.course,
      courseTitle: "Synthetic Retention Basics",
      fixtureByteLength: fixtureBytes.byteLength,
      fixtureSha256,
      ingestionOperationId: IDS.ingestionOperation,
      membershipId: IDS.membership,
      sourceDocumentId: IDS.source,
      sourceObjectKey: SOURCE_OBJECT_KEY,
    });
    components.push({
      detail:
        "RDS migrations and isolated local pgvector schemas are reachable",
      name: "local-services",
      status: "ran",
    });

    await mkdir(path.join(configuration.scratchRoot, "ingestion"), {
      mode: 0o700,
      recursive: true,
    });
    const ingestionAtStart = await ingestionRepository.readCompleted(
      IDS.ingestionOperation,
    );
    const ingestion = new IngestionSupervisor({
      clock: { now: () => new Date() },
      malwareScanner: new TrustedFixtureAdmissionScanner(fixtureSha256),
      operations: ingestionRepository,
      publisher: new ObjectArtifactPublisher(objects),
      quarantine: new QuarantineStagingAdapter(
        new FixtureQuarantineDownload(
          configuration.fixturePath,
          SOURCE_OBJECT_KEY,
        ),
      ),
      worker: new PodmanDocumentWorker(
        {
          clamDatabaseDirectory: configuration.clamDatabaseDirectory,
          environment: "dev",
          executable: "podman",
          imageReference: configuration.ingestionImage,
          resolvedImageDigest: configuration.ingestionImageDigest,
          tessdataDirectory: configuration.tessdataDirectory,
        },
        new NodeProcessRunner(),
        new NormalizedOutputFileReader(),
      ),
      workspaces: new NodeEphemeralWorkspace(
        path.join(configuration.scratchRoot, "ingestion"),
      ),
    });
    const ingestionResult = await ingestion.execute({
      expectedInputSha256: fixtureSha256,
      operationId: IDS.ingestionOperation,
      ownerScopeId: IDS.scope,
      sourceDocumentId: IDS.source,
    });
    if (
      ingestionResult.kind !== "completed" ||
      ingestionResult.outcome.kind !== "parsed"
    ) {
      throw new Error("ingestion did not produce a parsed fixture");
    }
    const ingestionArtifact = ingestionResult.outcome.artifact;
    const normalizedBytes = await objects.read(
      artifactObjectKey(IDS.scope, ingestionArtifact.artifactId),
    );
    const normalizedDocument = validateNormalizedDocument(
      JSON.parse(Buffer.from(normalizedBytes).toString("utf8")),
      { documentKind: "pdf", inputSha256: fixtureSha256 },
    );
    const snapshotAtStart = await smokeRepository.snapshot(
      AUTHORIZATION,
      IDS.course,
      IDS.source,
    );
    components.push({
      detail: `${LOCAL_SMOKE_SCANNER}; normalized artifact ${ingestionArtifact.documentSha256.slice(0, 12)}`,
      name: "ingestion",
      status: ingestionAtStart === null ? "ran" : "replayed",
    });

    const liteLlm = createLiteLlmDevAdapters({
      REFLO_ENV: "dev",
      REFLO_LITELLM_API_KEY: configuration.litellm.apiKey,
      REFLO_LITELLM_BASE_URL: configuration.litellm.baseUrl,
      REFLO_LITELLM_EMBEDDING_MODEL: configuration.litellm.embeddingModel,
      REFLO_LITELLM_TEXT_MODEL: configuration.litellm.textModel,
    });
    const router = createModelRouter({
      adapters: withDevelopmentVideo(
        withDevelopmentSpeech(liteLlm.adapters, configuration),
        configuration,
      ),
      deployment: "dev",
      isFeatureEnabled: (key, context) =>
        key === "p1.media.video" &&
        configuration.videoEnabled &&
        context.videoOperationKind === "chapter_explainer",
      traceSink: traces,
    });
    const vectors = new DevelopmentPgVectorStore(
      vectorPool,
      liteLlm.embeddingProfileVersion,
    );
    const retrieval = new RetrievalService({
      models: router,
      repository: contentRepository,
      vectors,
    });

    if (snapshotAtStart.curriculumGenerationCount === 0) {
      await retrieval.buildCurriculum({
        authorization: AUTHORIZATION,
        courseId: IDS.course,
        deadlineMs: 120_000,
        document: normalizedDocument,
        sourceDocumentId: IDS.source,
      });
    }
    const retrieved = await retrieval.search({
      authorization: AUTHORIZATION,
      courseId: IDS.course,
      deadlineMs: 30_000,
      limit: 3,
      query: "How does retrieval evidence differ from lesson exposure?",
      sourceDocumentId: IDS.source,
    });
    if (retrieved.length < 1) {
      throw new Error(
        "development retrieval returned no authorized source span",
      );
    }
    components.push({
      detail: `isolated profile ${liteLlm.embeddingProfileVersion}; exact owner-scoped search`,
      name: "embedding-retrieval",
      status:
        snapshotAtStart.curriculumGenerationCount === 0 ? "ran" : "replayed",
    });
    components.push({
      detail:
        "typed development-only LiteLLM routes with strict result validation",
      name: "litellm",
      status: traces.traces.length > 0 ? "ran" : "replayed",
    });

    const activation = new ActivationGenerationService({
      models: router,
      repository: activationRepository,
      textArtifacts: objects,
    });
    const activationOperations = await activation.plan({
      authorization: AUTHORIZATION,
      courseId: IDS.course,
      environment: "dev",
    });
    for (const operation of activationOperations) {
      const result = await activation.run({
        authorization: AUTHORIZATION,
        courseId: IDS.course,
        deadlineMs: 120_000,
        operationId: operation.id,
      });
      if (result.status !== "succeeded") {
        throw new Error("activation generation did not succeed");
      }
    }
    components.push({
      detail:
        "first text lesson plus 10-item placement and 5-item chapter quizzes",
      name: "activation",
      status:
        snapshotAtStart.activationOperationCount === 0 ? "ran" : "replayed",
    });

    const course = await activationRepository.loadCourse(
      AUTHORIZATION,
      IDS.course,
    );
    if (course === null)
      throw new Error("persisted activation course is unavailable");
    if (snapshotAtStart.narrationScriptCount === 0) {
      await generateNarration(router, smokeRepository, course);
    }

    const audioCourse = await audioRepository.loadCourse(
      AUTHORIZATION,
      IDS.course,
    );
    if (audioCourse === null || audioCourse.chapters.length === 0) {
      throw new Error(
        "persisted narration is unavailable for audio generation",
      );
    }
    const clockValue = new Date();
    const deadlineAt = new Date(clockValue.getTime() + 30 * 60_000);
    const audio = new AudioGenerationService({
      artifacts: objects,
      clock: { now: () => new Date(clockValue) },
      models: router,
      repository: audioRepository,
    });
    const plannedAudio = buildAudioPlan(
      audioCourse,
      "dev",
      clockValue,
      deadlineAt,
    );
    const registeredAudio = await audio.plan({
      authorization: AUTHORIZATION,
      courseId: IDS.course,
      deadlineAt,
      environment: "dev",
    });
    const audioStartedEmpty = snapshotAtStart.audioAssetCount === 0;
    if (audioStartedEmpty) {
      for (const operation of plannedAudio) {
        const result = await audio.consume({
          authorization: AUTHORIZATION,
          envelope: operation.envelope,
        });
        if (result.status !== "succeeded") {
          throw new Error("Piper audio generation did not succeed");
        }
      }
    } else if (
      registeredAudio.some((operation) => operation.status !== "succeeded")
    ) {
      throw new Error("persisted Piper audio operation lost terminal success");
    }
    components.push({
      detail:
        "checked-in bounded Piper worker produced validated private WAV assets",
      name: "piper-audio",
      status: snapshotAtStart.audioAssetCount === 0 ? "ran" : "replayed",
    });

    components.push(
      await runDevelopmentVideo(router, objects, course, configuration),
    );

    const completed = await smokeRepository.snapshot(
      AUTHORIZATION,
      IDS.course,
      IDS.source,
    );
    assertComplete(completed);
    await verifyPersistedFiles(
      objects,
      await smokeRepository.artifactEvidence(AUTHORIZATION, IDS.course),
    );

    await verifyReplay(
      ingestion,
      activation,
      activationOperations,
      audio,
      audioStartedEmpty ? plannedAudio : [],
      fixtureSha256,
    );
    const replayed = await smokeRepository.snapshot(
      AUTHORIZATION,
      IDS.course,
      IDS.source,
    );
    if (JSON.stringify(replayed) !== JSON.stringify(completed)) {
      throw new Error("replay created duplicate logical artifacts");
    }

    return {
      boundary: [
        "development integration evidence only",
        "not the seeded public-internet-offline demo",
        "does not attest Alibaba providers, target security, quota, SLO, privacy, quality, or release gates",
      ],
      components,
      contractVersion: "local-development-smoke-v1",
      counts: replayed,
      fixtureSha256,
      outcome: "passed",
      replayVerified: true,
      retrievedSourceSpanCount: retrieved.length,
      traceCount: traces.traces.length,
    };
  } finally {
    await Promise.allSettled([
      ingestionRepository.close(),
      contentRepository.close(),
      activationRepository.close(),
      audioRepository.close(),
      smokeRepository.close(),
      vectorPool.close(),
    ]);
  }
}

function withDevelopmentSpeech(
  adapters: ModelAdapterRegistry,
  configuration: ReturnType<typeof readLocalSmokeConfiguration>,
): ModelAdapterRegistry {
  const unavailablePrimary: SpeechModelPort = {
    descriptor: {
      adapterVersion: "local-smoke-unavailable-primary-v1",
      capability: "speech",
      developmentOnly: true,
      driftCanaryPassed: false,
      effectiveModel: "qwen-tts-unavailable-in-local-smoke",
      effectiveModelVersion: "development-only",
      maxImmediateAttempts: 1,
      mediaSubmissionIdempotent: false,
      mutableAlias: false,
      selector: "qwen-tts.primary",
    },
    async synthesize(): Promise<never> {
      throw new ModelAdapterError({
        safeCode: "unavailable",
        submissionState: "not_accepted",
        transient: true,
      });
    },
  };
  const piperBase = createPiperTtsAdapter({
    process: new NodePiperSynthesisProcess({
      configPath: configuration.piper.configPath,
      configSha256: configuration.piper.configSha256,
      modelPath: configuration.piper.modelPath,
      modelSha256: configuration.piper.modelSha256,
      pythonExecutable: configuration.piper.pythonExecutable,
      scratchRoot: path.join(configuration.scratchRoot, "piper-work"),
      workerPath: configuration.piper.workerPath,
    }),
    profile: {
      artifactRevision: configuration.piper.artifactRevision,
      configPath: configuration.piper.configPath,
      configSha256: configuration.piper.configSha256,
      modelPath: configuration.piper.modelPath,
      modelSha256: configuration.piper.modelSha256,
      runtimeDownloadsAllowed: false,
      voiceArtifactVersion: configuration.piper.voiceArtifactVersion,
    },
  });
  const piper: SpeechModelPort = {
    ...piperBase,
    descriptor: {
      ...piperBase.descriptor,
      developmentOnly: true,
      driftCanaryPassed: false,
    },
  };
  return {
    ...adapters,
    speech: {
      "piper-tts.cpu": piper,
      "qwen-tts.primary": unavailablePrimary,
    },
  };
}

function withDevelopmentVideo(
  adapters: ModelAdapterRegistry,
  configuration: ReturnType<typeof readLocalSmokeConfiguration>,
): ModelAdapterRegistry {
  if (!configuration.videoEnabled) return adapters;
  const fal = configuration.fal;
  if (fal === undefined) {
    throw new SmokePreflightError(
      "video",
      "set the required fal development configuration",
    );
  }
  return {
    ...adapters,
    video: {
      "wanx.video": createFalDevVideoAdapter({
        REFLO_ENV: "dev",
        REFLO_FAL_KEY: fal.apiKey,
        REFLO_FAL_MEDIA_LIFETIME_SECONDS: fal.mediaLifetimeSeconds,
        REFLO_FAL_VIDEO_MODEL: fal.videoModel,
      }),
    },
  };
}

async function runDevelopmentVideo(
  router: ReturnType<typeof createModelRouter>,
  objects: LocalSmokeObjectStore,
  course: AuthorizedActivationCourse,
  configuration: ReturnType<typeof readLocalSmokeConfiguration>,
): Promise<ComponentResult> {
  if (!configuration.videoEnabled) {
    return {
      detail: "P1 video flag is disabled",
      name: "video",
      status: "skipped",
    };
  }
  if (await objects.exists(VIDEO_MANIFEST_KEY)) {
    const manifest = parseDevelopmentVideoManifest(
      await objects.read(VIDEO_MANIFEST_KEY),
    );
    const payload = await objects.read(manifest.objectKey);
    if (
      payload.byteLength !== manifest.byteSize ||
      digest(payload) !== manifest.contentSha256
    ) {
      throw new Error("development video replay failed integrity validation");
    }
    return {
      detail: "private local fal clip artifact replayed",
      name: "video",
      status: "replayed",
    };
  }
  const concept = course.chapters[0]?.concepts[0];
  if (concept === undefined || concept.sourceSpans.length === 0) {
    throw new Error("source-backed video concept is unavailable");
  }
  try {
    const result = await router.execute(
      "media.video.v1",
      {
        conceptId: concept.id,
        sourceSpans: concept.sourceSpans,
        visualBrief: `Create a concise animated educational diagram explaining ${concept.name}. Use labels, motion, and no decorative text walls.`,
      },
      { deadlineMs: 10 * 60_000, videoOperationKind: "chapter_explainer" },
    );
    const copied = await copyDevelopmentVideoArtifact({
      courseId: course.courseId,
      mimeType: result.value.mimeType,
      ownerScopeId: course.ownerScopeId,
      store: objects,
      uri: result.value.uri,
    });
    const manifest = Buffer.from(
      JSON.stringify({
        byteSize: copied.byteSize,
        contentSha256: copied.contentSha256,
        contractVersion: "development-fal-video-manifest-v1",
        objectKey: copied.objectKey,
      }),
      "utf8",
    );
    await objects.putIfAbsent({
      bytes: manifest,
      objectKey: VIDEO_MANIFEST_KEY,
      sha256: digest(manifest),
    });
    return {
      detail:
        "one five-second fal clip copied into the private local artifact path",
      name: "video",
      status: "ran",
    };
  } catch (error) {
    if (
      error instanceof ModelRouterError ||
      error instanceof DevelopmentVideoArtifactError
    ) {
      return {
        detail:
          "optional fal video was unavailable; text and audio remained complete",
        name: "video",
        status: "skipped",
      };
    }
    throw error;
  }
}

function parseDevelopmentVideoManifest(bytes: Uint8Array): {
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly objectKey: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("development video manifest is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("contractVersion" in value) ||
    value.contractVersion !== "development-fal-video-manifest-v1" ||
    !("byteSize" in value) ||
    typeof value.byteSize !== "number" ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    !("contentSha256" in value) ||
    typeof value.contentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentSha256) ||
    !("objectKey" in value) ||
    typeof value.objectKey !== "string" ||
    !value.objectKey.startsWith(
      `owners/${IDS.scope}/courses/${IDS.course}/assets/development-fal-video/generations/`,
    )
  ) {
    throw new Error("development video manifest is invalid");
  }
  return {
    byteSize: value.byteSize,
    contentSha256: value.contentSha256,
    objectKey: value.objectKey,
  };
}

async function generateNarration(
  router: ReturnType<typeof createModelRouter>,
  repository: PostgresDevelopmentSmokeRepository,
  course: AuthorizedActivationCourse,
): Promise<void> {
  const chapter = course.chapters[0];
  const concept = chapter?.concepts[0];
  if (chapter === undefined || concept === undefined) {
    throw new Error("source-backed first concept is unavailable");
  }
  const result = await router.execute(
    "lesson.audio-script.v1",
    {
      conceptId: concept.id,
      conceptName: concept.name,
      sourceSpans: concept.sourceSpans,
    },
    { deadlineMs: 120_000 },
  );
  await repository.persistNarration({
    authorization: AUTHORIZATION,
    chapterId: chapter.id,
    courseId: course.courseId,
    generationVersion: "audio-script-generation-v1",
    modelProvenance: result.provenance,
    narrationScriptId: stableUuid({
      chapterId: chapter.id,
      generationVersion: "audio-script-generation-v1",
      scriptSha256: sha256(result.value.script),
    }),
    scriptSha256: sha256(result.value.script),
    scriptText: result.value.script,
    sourceSpanIds: result.value.sourceSpanIds,
  });
}

async function verifyReplay(
  ingestion: IngestionSupervisor,
  activation: ActivationGenerationService,
  activationOperations: readonly { readonly id: string }[],
  audio: AudioGenerationService,
  plannedAudio: ReturnType<typeof buildAudioPlan>,
  fixtureSha256: string,
): Promise<void> {
  const replayedIngestion = await ingestion.execute({
    expectedInputSha256: fixtureSha256,
    operationId: IDS.ingestionOperation,
    ownerScopeId: IDS.scope,
    sourceDocumentId: IDS.source,
  });
  if (replayedIngestion.kind !== "completed") {
    throw new Error("ingestion replay did not return the terminal result");
  }
  await activation.plan({
    authorization: AUTHORIZATION,
    courseId: IDS.course,
    environment: "dev",
  });
  for (const operation of activationOperations) {
    const result = await activation.run({
      authorization: AUTHORIZATION,
      courseId: IDS.course,
      deadlineMs: 30_000,
      operationId: operation.id,
    });
    if (result.status !== "succeeded") {
      throw new Error("activation replay lost its terminal success");
    }
  }
  for (const operation of plannedAudio) {
    const result = await audio.consume({
      authorization: AUTHORIZATION,
      envelope: operation.envelope,
    });
    if (result.status !== "succeeded") {
      throw new Error("audio replay lost its terminal success");
    }
  }
}

function assertComplete(snapshot: DevelopmentSmokeSnapshot): void {
  if (
    snapshot.sourceSpanCount < 1 ||
    snapshot.curriculumGenerationCount !== 1 ||
    snapshot.chapterCount < 1 ||
    snapshot.conceptCount < 1 ||
    snapshot.activationOperationCount !== 3 ||
    snapshot.activationArtifactCount !== 1 ||
    snapshot.quizBankCount !== 2 ||
    snapshot.quizItemCount !== 15 ||
    snapshot.narrationScriptCount !== 1 ||
    snapshot.audioOperationCount !== 1 ||
    snapshot.audioAssetCount !== 1
  ) {
    throw new Error("persisted smoke artifacts are incomplete");
  }
}

async function verifyPersistedFiles(
  objects: LocalSmokeObjectStore,
  artifacts: Awaited<
    ReturnType<PostgresDevelopmentSmokeRepository["artifactEvidence"]>
  >,
): Promise<void> {
  if (
    artifacts.length !== 2 ||
    artifacts.filter((artifact) => artifact.assetType === "text").length !==
      1 ||
    artifacts.filter((artifact) => artifact.assetType === "audio").length !== 1
  ) {
    throw new Error("persisted local file evidence is incomplete");
  }
  for (const artifact of artifacts) {
    const bytes = await objects.read(artifact.objectKey);
    if (
      bytes.byteLength !== Number(artifact.byteSize) ||
      digest(bytes) !== artifact.contentHash ||
      (artifact.assetType === "audio" &&
        Buffer.from(bytes).subarray(0, 4).toString("ascii") !== "RIFF") ||
      (artifact.assetType === "text" &&
        artifact.contentType !== "text/markdown; charset=utf-8")
    ) {
      throw new Error("persisted local artifact failed integrity validation");
    }
  }
}

class BoundedTraceSink implements ModelTraceSink {
  readonly traces: ModelLogicalCallTrace[] = [];

  record(trace: ModelLogicalCallTrace): void {
    if (this.traces.length >= 128) {
      throw new Error("local smoke trace bound exceeded");
    }
    this.traces.push(trace);
  }
}

function failureSummary(error: unknown): Record<string, unknown> {
  if (error instanceof SmokePreflightError) {
    return {
      action: error.action,
      component: error.component,
      contractVersion: "local-development-smoke-v1",
      outcome: "failed",
    };
  }
  if (error instanceof ModelRouterError) {
    return {
      action:
        "check the configured LiteLLM aliases, strict JSON schemas, and Piper prerequisites",
      component: "model-routing",
      contractVersion: "local-development-smoke-v1",
      failureClass: error.code,
      outcome: "failed",
    };
  }
  const failureClass =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 80)
      : "integration_failure";
  return {
    action:
      "run scripts/local-stack.sh status, verify worker/Piper files, then rerun the focused smoke tests",
    component: "local-smoke",
    contractVersion: "local-development-smoke-v1",
    failureClass,
    outcome: "failed",
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

await main();
