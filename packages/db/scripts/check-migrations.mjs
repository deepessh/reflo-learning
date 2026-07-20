import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migrationsRoot = path.join(packageRoot, "migrations");
const migrationPattern = /^\d{14}_[a-z0-9_]+\.sql$/;
const migrations = readdirSync(migrationsRoot).filter((name) =>
  name.endsWith(".sql"),
);

if (migrations.length === 0) {
  throw new Error("packages/db must contain at least one migration");
}

for (const migration of migrations) {
  if (!migrationPattern.test(migration)) {
    throw new Error(`Migration is not timestamped correctly: ${migration}`);
  }

  const source = readFileSync(path.join(migrationsRoot, migration), "utf8");
  if (
    !source.includes("-- migrate:up") ||
    !source.includes("-- migrate:down")
  ) {
    throw new Error(`Migration is missing dbmate sections: ${migration}`);
  }
  if (source.includes("transaction:false")) {
    throw new Error(
      `Non-transactional migration requires explicit decision review: ${migration}`,
    );
  }
}

const schemaPath = path.join(packageRoot, "schema.sql");
if (readFileSync(schemaPath, "utf8").trim().length === 0) {
  throw new Error("packages/db/schema.sql must be generated and checked in");
}

try {
  execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
    cwd: packageRoot,
    stdio: "ignore",
  });
  const changed = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=DMR",
      "origin/main...HEAD",
      "--",
      "packages/db/migrations",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  ).trim();
  if (changed.length > 0) {
    throw new Error(
      `Merged migrations are append-only; changed paths:\n${changed}`,
    );
  }
} catch (error) {
  if (process.env.CI === "true") {
    throw error;
  }
}

console.info(
  `Validated ${migrations.length} append-only database migration(s)`,
);
