import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
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

const errors = [];
const versionFile = path.join(ROOT, ".opentofu-version");

if (
  !existsSync(versionFile) ||
  readFileSync(versionFile, "utf8").trim() !== EXPECTED_TOFU_VERSION
) {
  errors.push(`.opentofu-version must pin ${EXPECTED_TOFU_VERSION}`);
}

for (const directory of REQUIRED_DIRECTORIES) {
  if (!existsSync(path.join(ROOT, directory))) {
    errors.push(`missing required infrastructure boundary: ${directory}`);
  }
}

for (const file of walk(ROOT)) {
  const relative = path.relative(ROOT, file);
  const basename = path.basename(file);

  if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
    errors.push(
      `${relative}: state, plan, variable-value, and crash files must not be committed`,
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
}

if (errors.length > 0) {
  console.error("Infrastructure policy violations:\n" + errors.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Infrastructure repository policy is valid");
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
