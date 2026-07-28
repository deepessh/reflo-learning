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
      '"repo:${var.github_repository}:environment:dev"',
    ) ||
    !bootstrapMain.includes('"oidc:sub"') ||
    !bootstrapMain.includes('"oidc:aud"') ||
    !bootstrapMain.includes('"oidc:iss"')
  ) {
    errors.push(
      "bootstrap OIDC trust must bind the exact repository, protected dev environment, issuer, audience, and subject",
    );
  }

  const devSource = readInfrastructureTree(
    root,
    path.join("infra", "environments", "dev"),
  );
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
      [".git", ".next", ".turbo", ".terraform", "node_modules"].includes(
        entry.name,
      )
    ) {
      return [];
    }

    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
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
