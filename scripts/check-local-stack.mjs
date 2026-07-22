import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POSTGRES_IMAGE =
  "postgres:16.9-bookworm@sha256:253815cf7579ffa05e1673d92e78d37273e61be0e4414e9a1449337d7925be94";
export const PGVECTOR_IMAGE =
  "pgvector/pgvector:0.8.1-pg16-bookworm@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function collectLocalStackViolations({
  composeSource,
  gitignoreSource,
  scriptSource,
}) {
  const errors = [];
  const servicesSource = section(composeSource, "services", "volumes");
  const serviceNames = [
    ...servicesSource.matchAll(/^  ([a-z][a-z0-9-]*):$/gm),
  ].map(([, name]) => name);

  if (!/^name: reflo-local$/m.test(composeSource)) {
    errors.push("compose.yaml must fix the project name to reflo-local");
  }
  if (serviceNames.join(",") !== "rds,vector") {
    errors.push(
      `compose.yaml must contain only the implemented rds and vector services; found ${serviceNames.join(",") || "none"}`,
    );
  }

  const rds = serviceBlock(servicesSource, "rds");
  const vector = serviceBlock(servicesSource, "vector");
  requireText(errors, rds, `image: ${POSTGRES_IMAGE}`, "exact RDS image pin");
  requireText(
    errors,
    vector,
    `image: ${PGVECTOR_IMAGE}`,
    "exact pgvector image pin",
  );
  requireText(
    errors,
    rds,
    '"127.0.0.1:${REFLO_LOCAL_RDS_PORT:-55432}:5432"',
    "loopback-only RDS port",
  );
  requireText(
    errors,
    vector,
    '"127.0.0.1:${REFLO_LOCAL_VECTOR_PORT:-55433}:5432"',
    "loopback-only vector port",
  );
  requireText(errors, rds, "pg_isready", "bounded RDS health check");
  requireText(errors, vector, "pg_isready", "bounded vector health check");
  requireText(
    errors,
    rds,
    "rds-data:/var/lib/postgresql/data",
    "RDS-owned volume",
  );
  requireText(
    errors,
    vector,
    "vector-data:/var/lib/postgresql/data",
    "retrieval-owned volume",
  );

  const imageLines = composeSource
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("image:"));
  if (imageLines.some((line) => !/@sha256:[a-f0-9]{64}$/.test(line))) {
    errors.push(
      "every local service image must be immutable by SHA-256 digest",
    );
  }
  if (/\b(?:redis|rocketmq|minio|mailpit|mailhog)\b/i.test(servicesSource)) {
    errors.push(
      "unimplemented service emulators must not be added to the local stack",
    );
  }
  if (/packages\/db\/migrations|packages\/retrieval\/sql/.test(composeSource)) {
    errors.push(
      "schemas must be applied by their repository-owned commands, not image init mounts",
    );
  }

  requireText(
    errors,
    scriptSource,
    "REFLO_LOCAL_PROJECT=reflo-local",
    "fixed lifecycle project scope",
  );
  requireText(
    errors,
    scriptSource,
    "corepack pnpm --filter @reflo/db db:migrate",
    "repository-owned RDS migration command",
  );
  requireText(
    errors,
    scriptSource,
    "REFLO_POSTGRES_CONTAINER_ID=$REFLO_LOCAL_RDS_CONTAINER",
    "canonical pinned-container pg_dump configuration",
  );
  requireText(
    errors,
    scriptSource,
    "REFLO_POSTGRES_CONTAINER_REWRITE_FROM=127.0.0.1:$REFLO_LOCAL_RDS_HOST_PORT",
    "host-to-container pg_dump authority rewrite",
  );
  requireText(
    errors,
    scriptSource,
    "20260721000100_vector_namespace_v1.sql",
    "retrieval-owned vector schema",
  );
  requireText(
    errors,
    scriptSource,
    "20260722000100_litellm_dev_vector_namespace_v1.sql",
    "isolated LiteLLM development vector schema",
  );
  requireText(
    errors,
    scriptSource,
    "local-smoke-development-profile.sql",
    "local-only RDS development profile allowance",
  );
  requireText(
    errors,
    scriptSource,
    "down --volumes --remove-orphans",
    "scoped reset command",
  );
  requireText(
    errors,
    scriptSource,
    "chmod 600",
    "private generated environment files",
  );
  requireText(
    errors,
    scriptSource,
    "SKIPPED ingestion-worker",
    "actionable ingestion-worker state",
  );
  requireText(
    errors,
    scriptSource,
    "5.8.3 | 6.0.1",
    "development-compatible Podman allowlist",
  );
  requireText(
    errors,
    scriptSource,
    "SKIPPED piper-worker",
    "actionable Piper-worker state",
  );
  if (
    /docker\s+(?:system|volume)\s+prune|docker\s+rm\s+-f/.test(scriptSource)
  ) {
    errors.push(
      "local lifecycle commands cannot prune or remove unrelated Docker resources",
    );
  }
  if (!/^\.reflo\/$/m.test(gitignoreSource)) {
    errors.push(".gitignore must exclude generated local stack state");
  }

  return errors;
}

export function validateRepositoryLocalStack(repositoryRoot = root) {
  return collectLocalStackViolations({
    composeSource: readFileSync(
      path.join(repositoryRoot, "compose.yaml"),
      "utf8",
    ),
    gitignoreSource: readFileSync(
      path.join(repositoryRoot, ".gitignore"),
      "utf8",
    ),
    scriptSource: readFileSync(
      path.join(repositoryRoot, "scripts/local-stack.sh"),
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
  const errors = validateRepositoryLocalStack(process.cwd());
  if (errors.length > 0) {
    console.error("Local stack policy violations:\n" + errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.info("Local stack repository policy is valid");
  }
}
