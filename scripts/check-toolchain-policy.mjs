import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function read(root, relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function versions(root) {
  const source = read(root, "scripts/toolchain-versions.sh");
  const value = (name) =>
    source.match(new RegExp(`^${name}=([^\\n]+)$`, "m"))?.[1];
  return {
    node: value("REFLO_NODE_VERSION"),
    pnpm: value("REFLO_PNPM_VERSION"),
    postgresImage: value("REFLO_POSTGRES_IMAGE"),
  };
}

export function checkToolchainPolicy(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const errors = [];
  let pinned;
  try {
    pinned = versions(root);
  } catch (error) {
    return [`toolchain manifest is unreadable: ${error.message}`];
  }
  for (const [name, value] of Object.entries(pinned)) {
    if (!value) {
      errors.push(`toolchain manifest is missing ${name}`);
    }
  }
  if (errors.length > 0) {
    return errors;
  }

  const packageJson = JSON.parse(read(root, "package.json"));
  const governanceRequirements = read(
    root,
    "scripts/requirements-governance.txt",
  ).trim();
  if (governanceRequirements !== "PyYAML==6.0.3") {
    errors.push("governance tooling must pin exactly PyYAML==6.0.3");
  }
  if (read(root, ".nvmrc").trim() !== pinned.node) {
    errors.push(`.nvmrc must pin ${pinned.node}`);
  }
  if (packageJson.engines?.node !== pinned.node) {
    errors.push(`package.json engines.node must pin exactly ${pinned.node}`);
  }
  if (packageJson.packageManager !== `pnpm@${pinned.pnpm}`) {
    errors.push(`package.json packageManager must pin pnpm@${pinned.pnpm}`);
  }

  const ci = read(root, ".github/workflows/ci.yml");
  const governanceCi = read(root, ".github/workflows/validate-decisions.yml");
  if (!ci.includes(`node-version: ${pinned.node}`)) {
    errors.push(`ci.yml must use Node ${pinned.node}`);
  }
  if (!ci.includes(`image: ${pinned.postgresImage}`)) {
    errors.push(
      "ci.yml must use the digest-pinned PostgreSQL image from the manifest",
    );
  }
  if (
    !governanceCi.includes(
      "python3 -m pip install --requirement scripts/requirements-governance.txt",
    ) ||
    !governanceCi.includes("python3 scripts/validate_adrs.py")
  ) {
    errors.push(
      "decision validation CI must install the pinned governance requirement and run ADR validation",
    );
  }

  const databasePackage = JSON.parse(read(root, "packages/db/package.json"));
  if (
    databasePackage.scripts?.["db:dump"] !==
    "scripts/dump-schema-from-container.sh"
  ) {
    errors.push("@reflo/db db:dump must use the canonical container generator");
  }
  const turbo = JSON.parse(read(root, "turbo.json"));
  for (const variable of [
    "REFLO_POSTGRES_CONTAINER_ID",
    "REFLO_POSTGRES_CONTAINER_REWRITE_FROM",
    "REFLO_POSTGRES_CONTAINER_REWRITE_TO",
  ]) {
    if (!turbo.tasks?.test?.env?.includes(variable)) {
      errors.push(`turbo test env must pass ${variable}`);
    }
  }

  for (const script of [
    "scripts/doctor.sh",
    "packages/db/scripts/dump-schema-from-container.sh",
    "packages/db/scripts/pg-dump-from-container.sh",
  ]) {
    try {
      if ((statSync(path.join(root, script)).mode & 0o111) === 0) {
        errors.push(`${script} must be executable`);
      }
    } catch (error) {
      errors.push(`${script} is unavailable: ${error.message}`);
    }
  }

  const databaseReadme = read(root, "packages/db/README.md");
  if (
    !databaseReadme.includes("scripts/dump-schema-from-container.sh") ||
    !/never[^.\n]*hand-edit[^.\n]*`schema\.sql`/i.test(databaseReadme)
  ) {
    errors.push(
      "database README must name the canonical generator and prohibit hand-edits",
    );
  }

  const schemaTest = read(root, "packages/db/test/schema.test.mjs");
  for (const diagnostic of [
    "first difference",
    "actual length",
    "actual context",
    "actual tail",
  ]) {
    if (!schemaTest.includes(diagnostic)) {
      errors.push(
        `schema comparison must retain bounded ${diagnostic} diagnostics`,
      );
    }
  }
  return errors;
}

function main() {
  const errors = checkToolchainPolicy(process.cwd());
  if (errors.length > 0) {
    console.error(`Toolchain policy violations:\n${errors.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.info("Pinned toolchain policy is valid");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
