import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the activation target index permits immutable regeneration versions", async () => {
  const migration = await readFile(
    path.join(
      packageRoot,
      "migrations/20260801000300_allow_versioned_lesson_regeneration.sql",
    ),
    "utf8",
  );
  const schema = await readFile(path.join(packageRoot, "schema.sql"), "utf8");

  assert.match(
    migration,
    /CREATE UNIQUE INDEX activation_generation_operation_target_idx[\s\S]*generation_version,[\s\S]*regeneration_ordinal[\s\S]*NULLS NOT DISTINCT/,
  );
  assert.match(
    schema,
    /CREATE UNIQUE INDEX activation_generation_operation_target_idx[\s\S]*generation_version, regeneration_ordinal\) NULLS NOT DISTINCT/,
  );
});
