import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function findOutOfOrderMigrations(knownVersions, appliedVersions) {
  const known = new Set(knownVersions);
  const unknownApplied = appliedVersions.filter(
    (version) => !known.has(version),
  );
  if (unknownApplied.length > 0) {
    throw new Error(
      `Database contains migration versions absent from this checkout: ${unknownApplied.join(", ")}`,
    );
  }

  if (appliedVersions.length === 0) {
    return [];
  }

  const latestApplied = appliedVersions.reduce((latest, version) =>
    BigInt(version) > BigInt(latest) ? version : latest,
  );
  const applied = new Set(appliedVersions);
  return knownVersions.filter(
    (version) =>
      !applied.has(version) && BigInt(version) < BigInt(latestApplied),
  );
}

export async function migrateStrict(databaseUrl = process.env.DATABASE_URL) {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for database migration");
  }

  const knownVersions = readdirSync(path.join(packageRoot, "migrations"))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .map((name) => name.match(/^\d{14}/)[0])
    .sort();
  const client = new pg.Client({ connectionString: databaseUrl });
  let appliedVersions = [];

  await client.connect();
  try {
    const result = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    appliedVersions = result.rows.map(({ version }) => version);
  } catch (error) {
    if (error.code !== "42P01") {
      throw error;
    }
  } finally {
    await client.end();
  }

  const outOfOrder = findOutOfOrderMigrations(knownVersions, appliedVersions);
  if (outOfOrder.length > 0) {
    throw new Error(
      `Refusing out-of-order migrations older than an applied version: ${outOfOrder.join(", ")}`,
    );
  }

  // AGENT-NOTE: dbmate 2.34.1's published binaries omit the documented
  // --strict flag. This preflight preserves that accepted behavior while
  // dbmate remains the only process that applies migration SQL.
  execFileSync(
    "dbmate",
    [
      "--migrations-dir",
      path.join(packageRoot, "migrations"),
      "--schema-file",
      path.join(packageRoot, "schema.sql"),
      "--no-dump-schema",
      "migrate",
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrateStrict();
}
