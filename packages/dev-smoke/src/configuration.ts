import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOCAL_SMOKE_PODMAN_VERSIONS = ["5.8.3", "6.0.1"] as const;
const LOCAL_SMOKE_PODMAN_VERSION_PATTERN = new RegExp(
  `^podman version (?:${LOCAL_SMOKE_PODMAN_VERSIONS.map(escapeRegex).join("|")})$`,
  "i",
);

export interface LocalSmokeConfiguration {
  readonly artifactRoot: string;
  readonly clamDatabaseDirectory: string;
  readonly databaseUrl: string;
  readonly fal?: {
    readonly apiKey: string;
    readonly mediaLifetimeSeconds: string;
    readonly videoModel: string;
  };
  readonly fixturePath: string;
  readonly ingestionImage: string;
  readonly ingestionImageDigest: string;
  readonly litellm: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly embeddingModel: string;
    readonly textModel: string;
  };
  readonly piper: {
    readonly artifactRevision: string;
    readonly configPath: string;
    readonly configSha256: string;
    readonly modelPath: string;
    readonly modelSha256: string;
    readonly pythonExecutable: string;
    readonly voiceArtifactVersion: string;
    readonly workerPath: string;
  };
  readonly repositoryRoot: string;
  readonly scratchRoot: string;
  readonly tessdataDirectory: string;
  readonly vectorDatabaseUrl: string;
  readonly videoEnabled: boolean;
}

export class SmokePreflightError extends Error {
  constructor(
    readonly component: string,
    readonly action: string,
  ) {
    super(`${component} prerequisite is unavailable`);
    this.name = "SmokePreflightError";
  }
}

export function readLocalSmokeConfiguration(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): LocalSmokeConfiguration {
  if (environment.REFLO_ENV !== "dev") {
    throw new SmokePreflightError(
      "environment",
      "set REFLO_ENV=dev; local smoke adapters are rejected elsewhere",
    );
  }
  const absoluteRoot = path.resolve(repositoryRoot);
  const piperWorker = path.join(
    absoluteRoot,
    "packages/audio/piper-worker/worker.py",
  );
  const videoEnabled = optionalBoolean(
    environment.REFLO_LOCAL_SMOKE_VIDEO,
    "video",
    "set REFLO_LOCAL_SMOKE_VIDEO to true or false",
  );
  return {
    artifactRoot: path.join(absoluteRoot, ".reflo/local-smoke/artifacts"),
    clamDatabaseDirectory: requiredAbsolute(
      environment.REFLO_LOCAL_CLAMAV_DATABASE_DIR,
      "ingestion-worker",
      "set REFLO_LOCAL_CLAMAV_DATABASE_DIR to the verified local snapshot directory",
    ),
    databaseUrl: required(
      environment.DATABASE_URL,
      "local-services",
      "run scripts/local-stack.sh setup and source its generated app.env",
    ),
    ...(videoEnabled
      ? {
          fal: {
            apiKey: required(
              environment.REFLO_FAL_KEY,
              "video",
              "set the development-only fal API key",
            ),
            mediaLifetimeSeconds: required(
              environment.REFLO_FAL_MEDIA_LIFETIME_SECONDS,
              "video",
              "set a bounded fal development media lifetime",
            ),
            videoModel: required(
              environment.REFLO_FAL_VIDEO_MODEL,
              "video",
              "set the fal text-to-video model endpoint",
            ),
          },
        }
      : {}),
    fixturePath: path.join(
      absoluteRoot,
      "packages/dev-smoke/fixtures/reflo-retention-basics.pdf",
    ),
    ingestionImage: required(
      environment.REFLO_LOCAL_INGESTION_IMAGE,
      "ingestion-worker",
      "build the pinned worker and set REFLO_LOCAL_INGESTION_IMAGE",
    ),
    ingestionImageDigest: requiredMatching(
      environment.REFLO_LOCAL_INGESTION_IMAGE_DIGEST,
      /^sha256:[a-f0-9]{64}$/,
      "ingestion-worker",
      "set REFLO_LOCAL_INGESTION_IMAGE_DIGEST from the locally inspected image",
    ),
    litellm: {
      apiKey: required(
        environment.REFLO_LITELLM_API_KEY,
        "litellm",
        "set the development-only LiteLLM API key",
      ),
      baseUrl: required(
        environment.REFLO_LITELLM_BASE_URL,
        "litellm",
        "start LiteLLM and set REFLO_LITELLM_BASE_URL",
      ),
      embeddingModel: required(
        environment.REFLO_LITELLM_EMBEDDING_MODEL,
        "embedding",
        "configure a LiteLLM embedding alias that returns exactly 1,024 dimensions",
      ),
      textModel: required(
        environment.REFLO_LITELLM_TEXT_MODEL,
        "litellm",
        "configure a JSON-capable LiteLLM text alias",
      ),
    },
    piper: {
      artifactRevision: requiredMatching(
        environment.REFLO_LOCAL_PIPER_ARTIFACT_REVISION,
        /^[a-f0-9]{40}$/,
        "piper",
        "set the immutable Piper voice repository revision",
      ),
      configPath: requiredAbsolute(
        environment.REFLO_LOCAL_PIPER_CONFIG_PATH,
        "piper",
        "set REFLO_LOCAL_PIPER_CONFIG_PATH to the pinned voice config",
      ),
      configSha256: requiredMatching(
        environment.REFLO_LOCAL_PIPER_CONFIG_SHA256,
        /^[a-f0-9]{64}$/,
        "piper",
        "set the pinned voice config SHA-256",
      ),
      modelPath: requiredAbsolute(
        environment.REFLO_LOCAL_PIPER_MODEL_PATH,
        "piper",
        "set REFLO_LOCAL_PIPER_MODEL_PATH to the pinned ONNX voice",
      ),
      modelSha256: requiredMatching(
        environment.REFLO_LOCAL_PIPER_MODEL_SHA256,
        /^[a-f0-9]{64}$/,
        "piper",
        "set the pinned voice model SHA-256",
      ),
      pythonExecutable: requiredAbsolute(
        environment.REFLO_LOCAL_PIPER_PYTHON,
        "piper",
        "set REFLO_LOCAL_PIPER_PYTHON to a Python environment with piper-tts==1.4.2",
      ),
      voiceArtifactVersion: requiredMatching(
        environment.REFLO_LOCAL_PIPER_VOICE_ARTIFACT_VERSION,
        /^piper-voice-[a-z0-9.-]+$/,
        "piper",
        "set a versioned local Piper voice artifact identity",
      ),
      workerPath: piperWorker,
    },
    repositoryRoot: absoluteRoot,
    scratchRoot: path.join(absoluteRoot, ".reflo/local-smoke/tmp"),
    tessdataDirectory: requiredAbsolute(
      environment.REFLO_LOCAL_TESSDATA_DIR,
      "ingestion-worker",
      "set REFLO_LOCAL_TESSDATA_DIR to the pinned English tessdata directory",
    ),
    vectorDatabaseUrl: required(
      environment.REFLO_VECTOR_DATABASE_URL,
      "embedding",
      "run scripts/local-stack.sh setup and source its generated app.env",
    ),
    videoEnabled,
  };
}

export async function verifyLocalSmokePrerequisites(
  configuration: LocalSmokeConfiguration,
): Promise<void> {
  await Promise.all([
    verifyRegularFile(configuration.fixturePath, "fixture"),
    verifyDirectory(configuration.clamDatabaseDirectory, "ingestion-worker"),
    verifyDirectory(configuration.tessdataDirectory, "ingestion-worker"),
    verifyRegularFile(configuration.piper.workerPath, "piper"),
    verifyRegularFile(configuration.piper.pythonExecutable, "piper"),
    verifyDigest(
      configuration.piper.modelPath,
      configuration.piper.modelSha256,
      "piper",
    ),
    verifyDigest(
      configuration.piper.configPath,
      configuration.piper.configSha256,
      "piper",
    ),
  ]);
  await verifyCommandVersion(
    "podman",
    ["--version"],
    LOCAL_SMOKE_PODMAN_VERSION_PATTERN,
    {
      action:
        "install development-compatible Podman 5.8.3 or production-pinned 6.0.1 and retry",
      component: "ingestion-worker",
    },
  );
  await verifyPodmanImage(configuration);
  await verifyPiper(configuration);
  await verifyLiteLlm(configuration);
}

async function verifyPodmanImage(
  configuration: LocalSmokeConfiguration,
): Promise<void> {
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(
      "podman",
      [
        "image",
        "inspect",
        "--format",
        "{{.Digest}}",
        configuration.ingestionImage,
      ],
      { maxBuffer: 4_096, timeout: 10_000 },
    ));
  } catch {
    throw new SmokePreflightError(
      "ingestion-worker",
      "build or load REFLO_LOCAL_INGESTION_IMAGE before running the smoke flow",
    );
  }
  const digest = output.trim();
  if (digest !== configuration.ingestionImageDigest) {
    throw new SmokePreflightError(
      "ingestion-worker",
      "REFLO_LOCAL_INGESTION_IMAGE_DIGEST does not match the inspected image",
    );
  }
}

async function verifyPiper(
  configuration: LocalSmokeConfiguration,
): Promise<void> {
  await verifyCommandVersion(
    configuration.piper.pythonExecutable,
    [
      "-c",
      "import importlib.metadata; print(importlib.metadata.version('piper-tts'))",
    ],
    /^1[.]4[.]2$/,
    {
      action: "install piper-tts==1.4.2 in REFLO_LOCAL_PIPER_PYTHON and retry",
      component: "piper",
    },
  );
}

async function verifyLiteLlm(
  configuration: LocalSmokeConfiguration,
): Promise<void> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(configuration.litellm.baseUrl);
  } catch {
    throw new SmokePreflightError(
      "litellm",
      "REFLO_LITELLM_BASE_URL must be an absolute safe endpoint",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(new URL("v1/models", baseUrl), {
      headers: { Authorization: `Bearer ${configuration.litellm.apiKey}` },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("unhealthy");
    }
    await response.body?.cancel();
  } catch {
    throw new SmokePreflightError(
      "litellm",
      "start the configured LiteLLM gateway and verify its /v1/models endpoint",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function verifyCommandVersion(
  executable: string,
  args: readonly string[],
  expected: RegExp,
  error: { readonly action: string; readonly component: string },
): Promise<void> {
  try {
    const { stdout } = await execFileAsync(executable, [...args], {
      maxBuffer: 4_096,
      timeout: 10_000,
    });
    if (!expected.test(stdout.trim())) throw new Error("version mismatch");
  } catch {
    throw new SmokePreflightError(error.component, error.action);
  }
}

async function verifyDigest(
  filePath: string,
  expectedSha256: string,
  component: string,
): Promise<void> {
  await verifyRegularFile(filePath, component);
  const { createHash } = await import("node:crypto");
  const actual = createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
  if (actual !== expectedSha256) {
    throw new SmokePreflightError(
      component,
      `${path.basename(filePath)} does not match its configured SHA-256`,
    );
  }
}

async function verifyRegularFile(
  filePath: string,
  component: string,
): Promise<void> {
  try {
    await access(filePath);
    if (!(await stat(filePath)).isFile()) throw new Error("not a file");
  } catch {
    throw new SmokePreflightError(
      component,
      `required file is missing: ${filePath}`,
    );
  }
}

async function verifyDirectory(
  directory: string,
  component: string,
): Promise<void> {
  try {
    if (!(await stat(directory)).isDirectory())
      throw new Error("not a directory");
  } catch {
    throw new SmokePreflightError(
      component,
      `required directory is missing: ${directory}`,
    );
  }
}

function required(
  value: string | undefined,
  component: string,
  action: string,
): string {
  if (value === undefined || value.length === 0) {
    throw new SmokePreflightError(component, action);
  }
  return value;
}

function requiredAbsolute(
  value: string | undefined,
  component: string,
  action: string,
): string {
  const requiredValue = required(value, component, action);
  if (!path.isAbsolute(requiredValue) || /[\r\n]/.test(requiredValue)) {
    throw new SmokePreflightError(component, action);
  }
  return requiredValue;
}

function requiredMatching(
  value: string | undefined,
  pattern: RegExp,
  component: string,
  action: string,
): string {
  const requiredValue = required(value, component, action);
  if (!pattern.test(requiredValue)) {
    throw new SmokePreflightError(component, action);
  }
  return requiredValue;
}

function optionalBoolean(
  value: string | undefined,
  component: string,
  action: string,
): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new SmokePreflightError(component, action);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSupportedLocalSmokePodmanVersion(output: string): boolean {
  return LOCAL_SMOKE_PODMAN_VERSION_PATTERN.test(output.trim());
}
