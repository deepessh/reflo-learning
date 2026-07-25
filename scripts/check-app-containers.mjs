import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_IMAGE =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
export const PNPM_VERSION = "10.34.5";

const APPS = ["api", "jobs", "web"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function collectApplicationContainerViolations({
  databaseMigrationSource,
  databasePackageSource,
  composeSource,
  databaseSetupSource,
  dockerfiles,
  dockerignoreSource,
  jobsContainerSource,
  jobsRunnerSource,
  lifecycleSource,
}) {
  const errors = [];

  for (const app of APPS) {
    const source = dockerfiles[app] ?? "";
    const fromLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("FROM "));
    const externalBaseLines = fromLines.filter(
      (line) => line !== "FROM toolchain AS build",
    );
    if (
      fromLines.length !== 3 ||
      externalBaseLines.length !== 2 ||
      externalBaseLines.some(
        (line) => !line.startsWith(`FROM ${NODE_IMAGE} AS `),
      )
    ) {
      errors.push(
        `apps/${app}/Dockerfile must use only the exact pinned Node image in both stages`,
      );
    }
    requireText(
      errors,
      source,
      `corepack prepare pnpm@${PNPM_VERSION} --activate`,
      `apps/${app} exact pnpm activation`,
    );
    requireText(
      errors,
      source,
      `pnpm --filter @reflo/${app}... build`,
      `apps/${app} independent workspace build`,
    );
    requireText(errors, source, "USER node", `apps/${app} non-root runtime`);
    requireText(
      errors,
      source,
      "HEALTHCHECK --interval=5s",
      `apps/${app} bounded image health check`,
    );
    requireText(
      errors,
      source,
      `find /${app === "web" ? "workspace/apps/web/out" : `opt/reflo/${app}`}`,
      `apps/${app} runtime artifact secret scan`,
    );
    if (
      /\b(?:ARG|ENV)\s+[A-Z0-9_]*(?:KEY|PASSWORD|SECRET|TOKEN)\b/.test(source)
    ) {
      errors.push(`apps/${app}/Dockerfile must not declare credential inputs`);
    }
    for (const other of APPS.filter((candidate) => candidate !== app)) {
      if (
        source.includes(`--filter @reflo/${other}`) ||
        source.includes(`COPY apps/${other}`)
      ) {
        errors.push(
          `apps/${app}/Dockerfile must not package the ${other} application`,
        );
      }
    }
  }

  const dockerignoreLines = dockerignoreSource.split("\n");
  if (dockerignoreLines.find((line) => line.trim() !== "") !== "**") {
    errors.push(".dockerignore must default-deny the build context");
  }
  for (const allowed of [
    "!package.json",
    "!pnpm-lock.yaml",
    "!pnpm-workspace.yaml",
    "!turbo.json",
    "!apps/**",
    "!packages/**",
  ]) {
    if (!dockerignoreLines.includes(allowed)) {
      errors.push(`.dockerignore must allow only required source ${allowed}`);
    }
  }
  for (const ignored of [
    "**/.env",
    "**/.env.*",
    "**/node_modules",
    "**/dist",
    "**/out",
  ]) {
    if (!dockerignoreLines.includes(ignored)) {
      errors.push(`.dockerignore must exclude ${ignored}`);
    }
  }
  if (
    dockerignoreLines.lastIndexOf("!.env.example") <
    dockerignoreLines.lastIndexOf("**/.env.*")
  ) {
    errors.push(".dockerignore must preserve the non-secret .env.example");
  }

  const servicesSource = section(composeSource, "services", "volumes");
  for (const app of APPS) {
    const service = serviceBlock(servicesSource, app);
    requireText(
      errors,
      service,
      'profiles: ["apps"]',
      `${app} application profile`,
    );
    requireText(
      errors,
      service,
      `dockerfile: apps/${app}/Dockerfile`,
      `${app} image boundary`,
    );
    requireText(errors, service, "healthcheck:", `${app} Compose health check`);
    requireText(
      errors,
      service,
      '"127.0.0.1:${REFLO_LOCAL_',
      `${app} loopback-only host port`,
    );
  }

  const setup = serviceBlock(servicesSource, "app-setup");
  const api = serviceBlock(servicesSource, "api");
  requireText(errors, setup, 'profiles: ["apps"]', "setup application profile");
  requireText(
    errors,
    setup,
    "dockerfile: apps/api/Dockerfile",
    "setup API image boundary",
  );
  requireText(errors, setup, '"180s"', "bounded setup deadline");
  requireText(
    errors,
    setup,
    "/opt/reflo/api/node_modules/@reflo/db/scripts/prepare-local-app-profile.mjs",
    "repository-owned application database setup",
  );
  requireText(
    errors,
    setup,
    "condition: service_healthy",
    "setup dependency readiness",
  );
  requireText(
    errors,
    setup,
    "postgresql://reflo:${REFLO_LOCAL_RDS_PASSWORD:",
    "setup-only database owner credential",
  );
  requireText(
    errors,
    api,
    "postgresql://reflo_api:${REFLO_LOCAL_API_RDS_PASSWORD:",
    "DML-only API database credential",
  );
  if (
    api.includes("postgresql://reflo:${REFLO_LOCAL_RDS_PASSWORD:") ||
    api.includes("REFLO_LOCAL_RDS_PASSWORD")
  ) {
    errors.push("API runtime must not receive the database owner credential");
  }
  requireText(
    errors,
    servicesSource,
    "@rds:5432/reflo?sslmode=disable",
    "internal RDS service URL",
  );
  requireText(
    errors,
    servicesSource,
    "@vector:5432/reflo_vectors?sslmode=disable",
    "internal vector service URL",
  );
  requireText(
    errors,
    servicesSource,
    "REFLO_LOCAL_RUNTIME_ENV_FILE",
    "ignored runtime environment injection",
  );
  requireText(
    errors,
    servicesSource,
    "required: false",
    "optional ignored runtime environment file",
  );

  const buildArgumentBlocks = [
    ...composeSource.matchAll(
      /\n      args:\n([\s\S]*?)(?=\n    [a-z]|\n  [a-z])/g,
    ),
  ].map((match) => match[1]);
  if (
    buildArgumentBlocks.some((block) =>
      /\b(?:KEY|PASSWORD|SECRET|TOKEN)\b/.test(block),
    )
  ) {
    errors.push("Compose build arguments must not contain credentials");
  }

  requireText(
    errors,
    lifecycleSource,
    "REFLO_APPS_PROJECT=reflo-local",
    "fixed application lifecycle project",
  );
  requireText(
    errors,
    lifecycleSource,
    "REFLO_APPS_PROFILE=apps",
    "fixed application lifecycle profile",
  );
  requireText(
    errors,
    lifecycleSource,
    "up --detach --build --wait --wait-timeout 300",
    "bounded application startup",
  );
  requireText(
    errors,
    lifecycleSource,
    "logs --tail 200 app-setup api jobs web",
    "bounded application logs",
  );
  requireText(
    errors,
    lifecycleSource,
    "rm --force --stop app-setup api jobs web",
    "application-only down scope",
  );
  requireText(
    errors,
    lifecycleSource,
    "down --volumes --remove-orphans",
    "fixed-project reset scope",
  );
  if (
    /\bdocker\s+(?:system|volume)\s+prune\b|\bdocker\s+rm\s+-f\b|\b"\$@"\b/.test(
      lifecycleSource,
    )
  ) {
    errors.push(
      "application lifecycle must not accept arbitrary Compose arguments or remove unrelated Docker resources",
    );
  }

  requireText(
    errors,
    databaseSetupSource,
    'runtimeDatabaseRole: "dml_only"',
    "live DML-only runtime role assertion",
  );
  requireText(
    errors,
    databaseSetupSource,
    "has_schema_privilege",
    "runtime schema-create denial",
  );
  requireText(
    errors,
    databaseSetupSource,
    "NOBYPASSRLS",
    "runtime RLS bypass denial",
  );
  requireText(
    errors,
    databaseMigrationSource,
    "resolveDbmateCli()",
    "packaged database migration executable resolution",
  );
  requireText(
    errors,
    databaseMigrationSource,
    "process.execPath",
    "Node-invoked database migration executable",
  );
  requireText(
    errors,
    databasePackageSource,
    '"sql"',
    "packaged local database setup SQL",
  );
  requireText(
    errors,
    jobsContainerSource,
    "runDevelopmentJob",
    "jobs container bounded runner composition",
  );
  requireText(
    errors,
    jobsRunnerSource,
    "REFLO_JOBS_DEV_AUDIO_ENVELOPE",
    "jobs configured envelope consumption",
  );
  requireText(
    errors,
    jobsRunnerSource,
    "executeBoundedHandler",
    "jobs configured bounded execution",
  );

  return errors;
}

export function validateRepositoryApplicationContainers(repositoryRoot = root) {
  return collectApplicationContainerViolations({
    databaseMigrationSource: readFileSync(
      path.join(repositoryRoot, "packages/db/scripts/strict-migrate.mjs"),
      "utf8",
    ),
    databasePackageSource: readFileSync(
      path.join(repositoryRoot, "packages/db/package.json"),
      "utf8",
    ),
    composeSource: readFileSync(
      path.join(repositoryRoot, "compose.yaml"),
      "utf8",
    ),
    databaseSetupSource: readFileSync(
      path.join(
        repositoryRoot,
        "packages/db/scripts/prepare-local-app-profile.mjs",
      ),
      "utf8",
    ),
    dockerfiles: Object.fromEntries(
      APPS.map((app) => [
        app,
        readFileSync(
          path.join(repositoryRoot, "apps", app, "Dockerfile"),
          "utf8",
        ),
      ]),
    ),
    dockerignoreSource: readFileSync(
      path.join(repositoryRoot, ".dockerignore"),
      "utf8",
    ),
    jobsContainerSource: readFileSync(
      path.join(repositoryRoot, "apps/jobs/src/container.ts"),
      "utf8",
    ),
    jobsRunnerSource: readFileSync(
      path.join(repositoryRoot, "apps/jobs/src/development-runner.ts"),
      "utf8",
    ),
    lifecycleSource: readFileSync(
      path.join(repositoryRoot, "scripts/local-apps.sh"),
      "utf8",
    ),
  });
}

function section(source, start, end) {
  const match = source.match(
    new RegExp(`^${start}:\\n([\\s\\S]*?)(?=^${end}:\\n)`, "m"),
  );
  return match?.[1] ?? "";
}

function serviceBlock(servicesSource, name) {
  const match = servicesSource.match(
    new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`,
      "m",
    ),
  );
  return match?.[1] ?? "";
}

function requireText(errors, source, expected, description) {
  if (!source.includes(expected)) {
    errors.push(`missing ${description}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateRepositoryApplicationContainers();
  if (errors.length > 0) {
    console.error(
      "Application container policy violations:\n" + errors.join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.info("Application container policy is valid");
  }
}
