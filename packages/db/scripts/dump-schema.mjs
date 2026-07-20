import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function dumpSchema({
  databaseUrl = process.env.DATABASE_URL,
  schemaFile = process.env.REFLO_SCHEMA_FILE ??
    path.join(packageRoot, "schema.sql"),
} = {}) {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for schema dump");
  }

  execFileSync(
    "dbmate",
    [
      "--migrations-dir",
      path.join(packageRoot, "migrations"),
      "--schema-file",
      schemaFile,
      "dump",
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    },
  );

  const generated = readFileSync(schemaFile, "utf8");
  writeFileSync(schemaFile, `${generated.trimEnd()}\n`, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  dumpSchema();
}
