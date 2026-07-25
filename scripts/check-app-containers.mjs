import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_IMAGE =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
export const PNPM_VERSION = "10.34.5";

const APPS = ["api", "jobs", "web"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function collectApplicationContainerViolations({
  composeSource,
  dockerfiles,
  dockerignoreSource,
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

  for (const ignored of [
    ".env",
    ".env.*",
    ".reflo",
    "**/node_modules",
    "**/dist",
    "**/out",
  ]) {
    if (!dockerignoreSource.split("\n").includes(ignored)) {
      errors.push(`.dockerignore must exclude ${ignored}`);
    }
  }
  if (!dockerignoreSource.includes("!.env.example")) {
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
    "prepare-local-app-profile.mjs",
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

  return errors;
}

export function validateRepositoryApplicationContainers(repositoryRoot = root) {
  return collectApplicationContainerViolations({
    composeSource: readFileSync(
      path.join(repositoryRoot, "compose.yaml"),
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
