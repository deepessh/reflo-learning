import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_TOFU_VERSION = "1.12.0";
const EXPECTED_PROVIDER_VERSION = "1.283.0";
const REQUIRED_DIRECTORIES = [
  "infra/bootstrap",
  "infra/environments/dev",
  "infra/environments/staging",
  "infra/environments/pilot",
  "infra/modules",
];
const FORBIDDEN_FILE_PATTERNS = [
  /\.tfstate(?:\.|$)/,
  /\.tfplan$/,
  /\.tfvars(?:\.json)?$/,
  /^crash(?:\..+)?\.log$/,
];

const REQUIRED_ROOT_FILES = [
  "infra/bootstrap/.terraform.lock.hcl",
  "infra/bootstrap/main.tf",
  "infra/bootstrap/outputs.tf",
  "infra/bootstrap/variables.tf",
  "infra/bootstrap/versions.tf",
  "infra/environments/dev/.terraform.lock.hcl",
  "infra/environments/dev/main.tf",
  "infra/environments/dev/outputs.tf",
  "infra/environments/dev/variables.tf",
  "infra/environments/dev/versions.tf",
];

export function checkInfraPolicy(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const errors = [];
  const versionFile = path.join(root, ".opentofu-version");

  if (
    !existsSync(versionFile) ||
    readFileSync(versionFile, "utf8").trim() !== EXPECTED_TOFU_VERSION
  ) {
    errors.push(`.opentofu-version must pin ${EXPECTED_TOFU_VERSION}`);
  }

  for (const directory of REQUIRED_DIRECTORIES) {
    if (!existsSync(path.join(root, directory))) {
      errors.push(`missing required infrastructure boundary: ${directory}`);
    }
  }

  for (const relative of REQUIRED_ROOT_FILES) {
    if (!existsSync(path.join(root, relative))) {
      errors.push(
        `missing required issue #199 infrastructure file: ${relative}`,
      );
    }
  }

  for (const file of walk(root)) {
    const relative = path.relative(root, file);
    const basename = path.basename(file);

    if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
      errors.push(
        `${relative}: state, plan, variable-value, and crash files must not be committed`,
      );
    }

    if (
      basename === ".terraform.lock.hcl" &&
      (!readFileSync(file, "utf8").includes(
        `version     = "${EXPECTED_PROVIDER_VERSION}"`,
      ) ||
        !readFileSync(file, "utf8").includes(
          `constraints = "${EXPECTED_PROVIDER_VERSION}"`,
        ))
    ) {
      errors.push(
        `${relative}: provider lock must select exactly aliyun/alicloud ${EXPECTED_PROVIDER_VERSION}`,
      );
    }

    if (!file.endsWith(".tf")) {
      continue;
    }

    const source = readFileSync(file, "utf8");
    if (
      /required_version\s*=/.test(source) &&
      !new RegExp(
        `required_version\\s*=\\s*["']=${EXPECTED_TOFU_VERSION.replaceAll(".", "\\.")}["']`,
      ).test(source)
    ) {
      errors.push(
        `${relative}: required_version must be exactly =${EXPECTED_TOFU_VERSION}`,
      );
    }
    if (
      /source\s*=\s*["']aliyun\/alicloud["']/.test(source) &&
      !new RegExp(
        `version\\s*=\\s*["']=${EXPECTED_PROVIDER_VERSION.replaceAll(".", "\\.")}["']`,
      ).test(source)
    ) {
      errors.push(
        `${relative}: aliyun/alicloud must be exactly =${EXPECTED_PROVIDER_VERSION}`,
      );
    }
    if (/terraform\.workspace|tofu\s+workspace/.test(source)) {
      errors.push(
        `${relative}: OpenTofu workspaces cannot define environment boundaries`,
      );
    }
    if (
      !relative.startsWith(`infra${path.sep}bootstrap${path.sep}`) &&
      /backend\s+["']local["']/.test(source)
    ) {
      errors.push(
        `${relative}: local state is allowed only during the one-time bootstrap migration`,
      );
    }
    if (
      source
        .split("\n")
        .some((line) =>
          /^\s*(?:access_key|secret_key|security_token)\s*=/.test(line),
        )
    ) {
      errors.push(
        `${relative}: provider and backend credentials must come only from the protected OIDC environment`,
      );
    }
  }

  const bootstrapVersions = readIfPresent(root, "infra/bootstrap/versions.tf");
  const devVersions = readIfPresent(root, "infra/environments/dev/versions.tf");
  if (!hasProtectedOssBackend(bootstrapVersions, "bootstrap")) {
    errors.push(
      "bootstrap must use the private encrypted OSS backend at the explicit bootstrap prefix",
    );
  }
  if (!hasProtectedOssBackend(devVersions, "environments/dev")) {
    errors.push(
      "dev must use the private encrypted OSS backend at the explicit environments/dev prefix",
    );
  }

  const bootstrapMain = readIfPresent(root, "infra/bootstrap/main.tf");
  if (
    !bootstrapMain.includes(
      '"${var.github_oidc_subject_prefix}:environment:dev"',
    ) ||
    !bootstrapMain.includes('"oidc:sub"') ||
    !bootstrapMain.includes('"oidc:aud"') ||
    !bootstrapMain.includes('"oidc:iss"')
  ) {
    errors.push(
      "bootstrap OIDC trust must bind the exact repository, protected dev environment, issuer, audience, and subject",
    );
  }
  const bootstrapVariables = readIfPresent(
    root,
    "infra/bootstrap/variables.tf",
  );
  if (
    !bootstrapVariables.includes('variable "github_oidc_subject_prefix"') ||
    !bootstrapVariables.includes(
      "^repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+$",
    )
  ) {
    errors.push(
      "bootstrap must require GitHub's exact immutable repository OIDC subject prefix",
    );
  }

  const devSource = [
    readInfrastructureTree(root, path.join("infra", "environments", "dev")),
    readInfrastructureTree(root, path.join("infra", "modules", "demo-runtime")),
  ].join("\n");
  if (/alicloud_(?:kms|kms_secret|kms_key)|secretsmanager/i.test(devSource)) {
    errors.push(
      "bounded Demo Day dev must not retain a KMS Secrets Manager dependency",
    );
  }
  if (/alicloud_(?:log|sls)(?:_|")/i.test(devSource)) {
    errors.push(
      "bounded Demo Day dev must not provision SLS-specific observability infrastructure",
    );
  }
  if (/alicloud_cr(?:_|")/i.test(devSource)) {
    errors.push(
      "bounded Demo Day dev must not provision Alibaba Container Registry",
    );
  }
  if (/resource\s+"alicloud_event_bridge[^"]*"\s+"parser/i.test(devSource)) {
    errors.push(
      "bounded Demo Day parser must not provision or depend on EventBridge",
    );
  }
  for (const requiredResource of [
    'resource "alicloud_instance"',
    'resource "alicloud_db_instance"',
    'resource "alicloud_gpdb_instance"',
    'resource "alicloud_rocketmq_instance"',
    'resource "alicloud_fcv3_function"',
    'resource "alicloud_cdn_domain_new"',
    'resource "alicloud_oss_bucket_object"',
  ]) {
    if (!devSource.includes(requiredResource)) {
      errors.push(
        `bounded dev runtime is missing required minimal service declaration: ${requiredResource}`,
      );
    }
  }
  if (
    !devSource.includes('var.region == "ap-southeast-1"') ||
    !devSource.includes('variable "approved_spend_reference"') ||
    !devSource.includes('variable "approved_runtime_configuration"')
  ) {
    errors.push(
      "bounded dev must fail closed on the approved Singapore region and exact paid-class approval inputs",
    );
  }

  const runtimeMain = readIfPresent(root, "infra/modules/demo-runtime/main.tf");
  const runtimeVariables = readIfPresent(
    root,
    "infra/modules/demo-runtime/variables.tf",
  );
  const devMain = readIfPresent(root, "infra/environments/dev/main.tf");
  const devVariables = readIfPresent(
    root,
    "infra/environments/dev/variables.tf",
  );
  const networkSource = readInfrastructureTree(
    root,
    path.join("infra", "modules", "dev-network"),
  );
  const parserFunction = extractNamedBlock(
    runtimeMain,
    'resource "alicloud_fcv3_function" "parser"',
  );
  const jobsFunction = extractNamedBlock(
    runtimeMain,
    'resource "alicloud_fcv3_function" "jobs"',
  );
  const jobsTrigger = extractNamedBlock(
    runtimeMain,
    'resource "alicloud_fcv3_trigger" "jobs"',
  );
  const parserSessionPolicy = extractNamedBlock(
    runtimeMain,
    'resource "alicloud_ram_policy" "api_parser_sessions"',
  );
  const parserSessionAttachment = extractNamedBlock(
    runtimeMain,
    'resource "alicloud_ram_role_policy_attachment" "api_parser_sessions"',
  );
  const normalizedParser = normalizeWhitespace(parserFunction);
  const normalizedRuntime = normalizeWhitespace(runtimeMain);
  for (const requiredControl of [
    "cpu = 2",
    "disk_size = 10240",
    'handler = "bootstrap"',
    "instance_concurrency = 1",
    'instance_isolation_mode = "SESSION_EXCLUSIVE"',
    "internet_access = false",
    "memory_size = 4096",
    'runtime = "custom.debian11"',
    'session_affinity = "HEADER_FIELD"',
    'affinityHeaderFieldName = "reflo-session-id"',
    "disableSessionIdReuse = true",
    "sessionConcurrencyPerInstance = 1",
    "sessionIdleTimeoutInSeconds = 300",
    "sessionTTLInSeconds = 2400",
    "timeout = 1800",
    'command = ["/code/bootstrap"]',
    "port = 9000",
  ]) {
    if (!normalizedParser.includes(requiredControl)) {
      errors.push(
        `session-isolated parser function is missing required control: ${requiredControl}`,
      );
    }
  }
  for (const forbiddenControl of [
    "role",
    "vpc_config",
    "oss_mount_config",
    "nas_config",
    "log_config",
    "environment_variables",
    "custom_container_config",
  ]) {
    if (new RegExp(`\\b${forbiddenControl}\\b`).test(parserFunction)) {
      errors.push(
        `session-isolated parser function must not configure ${forbiddenControl}`,
      );
    }
  }
  if (
    /resource\s+"alicloud_instance"\s+"parser|resource\s+"alicloud_ram_role"\s+"parser|parser_supervisor|parser-cloud-init|parser\.tar/.test(
      `${runtimeMain}\n${runtimeVariables}`,
    )
  ) {
    errors.push(
      "bounded dev must not retain a parser ECS host, role, attachment, archive, or cloud-init path",
    );
  }
  if (
    /\bparser\b|parser_supervisor/i.test(networkSource) ||
    devVariables.includes("parser_image_id")
  ) {
    errors.push(
      "bounded dev network and ECS inputs must not retain a parser VSwitch or security group",
    );
  }
  if (
    /resource\s+"alicloud_fcv3_trigger"\s+"parser|resource\s+"alicloud_fcv3_provision_config"\s+"parser/.test(
      runtimeMain,
    )
  ) {
    errors.push(
      "session-isolated parser must have no trigger or provisioned/minimum instance resource",
    );
  }
  const normalizedJobs = normalizeWhitespace(`${jobsFunction} ${jobsTrigger}`);
  for (const requiredControl of [
    'handler = "dist/index.handler"',
    "instance_concurrency = 1",
    "vpc_config",
    "vpc_id = var.vpc_id",
    "vswitch_ids = [var.vswitch_ids.application]",
    "security_group_id = var.security_group_ids.application",
    'trigger_type = "eventbridge"',
    "triggerEnable = true",
    "asyncInvocationType = true",
    'eventSourceType = "RocketMQ"',
    'InstanceType = "Cloud_5"',
    'InstanceNetwork = "PrivateNetwork"',
    'Offset = "CONSUME_FROM_LAST_OFFSET"',
    'mode = "event-streaming"',
    'errorsTolerance = "NONE"',
    'PushRetryStrategy = "BACKOFF_RETRY"',
    "CountBasedWindow = 1",
    "TimeBasedWindow = 0",
  ]) {
    if (!normalizedJobs.includes(requiredControl)) {
      errors.push(
        `jobs Function Compute RocketMQ composition is missing required control: ${requiredControl}`,
      );
    }
  }
  for (const requiredArtifact of [
    'resource "alicloud_oss_bucket_object" "parser_code"',
    'resource "alicloud_oss_bucket_object" "parser_runtime_layer"',
    'resource "alicloud_oss_bucket_object" "parser_tools_layer"',
    'resource "alicloud_oss_bucket_object" "parser_snapshot_layer"',
    'resource "alicloud_fcv3_layer_version" "parser_runtime"',
    'resource "alicloud_fcv3_layer_version" "parser_tools"',
    'resource "alicloud_fcv3_layer_version" "parser_snapshot"',
    "alicloud_oss_bucket_object.parser_code.key",
    "alicloud_fcv3_layer_version.parser_runtime.layer_version_arn",
    "alicloud_fcv3_layer_version.parser_tools.layer_version_arn",
    "alicloud_fcv3_layer_version.parser_snapshot.layer_version_arn",
  ]) {
    if (!runtimeMain.includes(requiredArtifact)) {
      errors.push(
        `session-isolated parser is missing immutable code/layer wiring: ${requiredArtifact}`,
      );
    }
  }
  for (const immutablePattern of [
    "parser-code\\\\.zip",
    "parser-java-worker-layer\\\\.zip",
    "parser-native-layer\\\\.zip",
    "parser-clamav-snapshot-layer\\\\.zip",
  ]) {
    if (!runtimeVariables.includes(immutablePattern)) {
      errors.push(
        `session-isolated parser artifact identity is missing content-address validation: ${immutablePattern}`,
      );
    }
  }
  const parserFcActions = [...parserSessionPolicy.matchAll(/"fc:([A-Za-z]+)"/g)]
    .map((match) => `fc:${match[1]}`)
    .sort();
  const expectedParserFcActions = [
    "fc:CreateSession",
    "fc:DeleteSession",
    "fc:GetSession",
    "fc:InvokeFunction",
  ].sort();
  if (
    JSON.stringify(parserFcActions) !==
      JSON.stringify(expectedParserFcActions) ||
    !normalizeWhitespace(parserSessionPolicy).includes('Resource = "*"') ||
    !normalizeWhitespace(parserSessionAttachment).includes(
      "policy_name = alicloud_ram_policy.api_parser_sessions.policy_name",
    ) ||
    !normalizeWhitespace(parserSessionAttachment).includes(
      "role_name = alicloud_ram_role.api.role_name",
    )
  ) {
    errors.push(
      "trusted API role must receive only the exact FC create/get/invoke/delete session action set",
    );
  }
  for (const requiredApiParserEnvironment of [
    'REFLO_DEMO_UPLOAD_PROCESSOR_MODE = "serverless-isolated-ingestion-v1"',
    "REFLO_ALIBABA_FC_ACCOUNT_ID = var.fc_account_id",
    "REFLO_ALIBABA_FC_API_ROLE_NAME = alicloud_ram_role.api.role_name",
    'REFLO_ALIBABA_FC_PARSER_AFFINITY_HEADER = "reflo-session-id"',
    "REFLO_ALIBABA_FC_PARSER_ARTIFACT_DIGEST = local.parser_artifact_digest",
    "REFLO_ALIBABA_FC_PARSER_FUNCTION_NAME = local.parser_function_name",
    'REFLO_ALIBABA_FC_PARSER_FUNCTION_QUALIFIER = "LATEST"',
    'REFLO_ALIBABA_FC_PARSER_SESSION_IDLE_SECONDS = "300"',
    'REFLO_ALIBABA_FC_PARSER_SESSION_TTL_SECONDS = "2400"',
  ]) {
    if (!normalizedRuntime.includes(requiredApiParserEnvironment)) {
      errors.push(
        `trusted API environment is missing parser client control: ${requiredApiParserEnvironment}`,
      );
    }
  }
  for (const parserArtifactDigestInput of [
    '"serverless-isolated-ingestion-package-v1"',
    "var.artifact_identity.parser_code_sha256",
    "var.artifact_identity.parser_java_worker_layer_sha256",
    "var.artifact_identity.parser_native_layer_sha256",
    "var.artifact_identity.parser_clamav_snapshot_sha256",
  ]) {
    if (
      !normalizeWhitespace(extractNamedBlock(runtimeMain, "locals")).includes(
        parserArtifactDigestInput,
      ) &&
      !normalizedRuntime.includes(parserArtifactDigestInput)
    ) {
      errors.push(
        `parser aggregate artifact digest is missing identity input: ${parserArtifactDigestInput}`,
      );
    }
  }
  if (
    !normalizedRuntime.includes(
      'parser_artifact_digest = sha256(join(":", [',
    ) ||
    !runtimeVariables.includes('variable "fc_account_id"') ||
    !devVariables.includes('variable "fc_account_id"') ||
    !normalizeWhitespace(devMain).includes("fc_account_id = var.fc_account_id")
  ) {
    errors.push(
      "trusted API parser client must receive the validated FC account ID and one deterministic aggregate artifact digest",
    );
  }

  const deployWorkflow = readIfPresent(
    root,
    ".github/workflows/deploy-dev.yml",
  );
  for (const requiredControl of [
    "workflow_dispatch:",
    "id-token: write",
    "environment: dev",
    "TF_VAR_fc_account_id: ${{ vars.REFLO_ALIBABA_ACCOUNT_ID }}",
    "github.ref == 'refs/heads/main'",
    "reflo-protected-dev-apply",
    "tofu -chdir=infra/environments/dev plan",
    "tofu -chdir=infra/environments/dev apply",
    'rm -f "$plan_path"',
  ]) {
    if (!deployWorkflow.includes(requiredControl)) {
      errors.push(
        `protected dev workflow is missing required control: ${requiredControl}`,
      );
    }
  }
  if (
    deployWorkflow.includes("pull_request:") ||
    deployWorkflow.includes("actions/upload-artifact") ||
    !deployWorkflow.includes("scripts/write-github-oidc-token.mjs") ||
    !deployWorkflow.includes("TF_VAR_runtime_secrets")
  ) {
    errors.push(
      "protected dev workflow must keep OIDC, environment secrets, plans, and apply out of pull-request and artifact boundaries",
    );
  }

  const bucketModule = readInfrastructureTree(
    root,
    path.join("infra", "modules", "private-oss-bucket"),
  );
  for (const requiredControl of [
    'acl = "private"',
    "block_public_access = true",
    'sse_algorithm = "AES256"',
    "prevent_destroy = true",
  ]) {
    if (!normalizeWhitespace(bucketModule).includes(requiredControl)) {
      errors.push(
        `private OSS module is missing required control: ${requiredControl}`,
      );
    }
  }

  return errors;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      [
        ".artifacts",
        ".git",
        ".next",
        ".turbo",
        ".terraform",
        "node_modules",
      ].includes(entry.name)
    ) {
      return [];
    }

    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function extractNamedBlock(source, declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) {
    return "";
  }
  const opening = source.indexOf("{", start + declaration.length);
  if (opening === -1) {
    return "";
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return "";
}

function readIfPresent(root, relative) {
  const file = path.join(root, relative);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readInfrastructureTree(root, relative) {
  const directory = path.join(root, relative);
  if (!existsSync(directory)) {
    return "";
  }
  return walk(directory)
    .filter((file) => file.endsWith(".tf"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

function hasProtectedOssBackend(source, prefix) {
  const normalized = normalizeWhitespace(source);
  return (
    /backend "oss" \{/.test(normalized) &&
    normalized.includes(`prefix = "${prefix}"`) &&
    normalized.includes('key = "reflo.tfstate"') &&
    normalized.includes("encrypt = true") &&
    normalized.includes('acl = "private"')
  );
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function main() {
  const errors = checkInfraPolicy(process.cwd());
  if (errors.length > 0) {
    console.error("Infrastructure policy violations:\n" + errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.info("Infrastructure repository policy is valid");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
