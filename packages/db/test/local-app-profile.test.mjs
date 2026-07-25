import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  prepareLocalApplicationProfile,
  resolveLocalSchemaPaths,
} from "../scripts/prepare-local-app-profile.mjs";

test("local application setup resolves repository-owned schema inputs", async () => {
  const paths = resolveLocalSchemaPaths();
  await Promise.all(Object.values(paths).map((file) => access(file)));
  assert.match(
    paths.developmentRds,
    /packages[/\\]db[/\\]sql[/\\]local-smoke-development-profile[.]sql$/,
  );
  assert.match(
    paths.vector,
    /packages[/\\]retrieval[/\\]sql[/\\]20260721000100_vector_namespace_v1[.]sql$/,
  );
  assert.match(
    paths.developmentVector,
    /packages[/\\]retrieval[/\\]sql[/\\]20260722000100_litellm_dev_vector_namespace_v1[.]sql$/,
  );
});

test("local application setup rejects non-development use before access", async () => {
  await assert.rejects(
    prepareLocalApplicationProfile({
      DATABASE_URL: "postgresql://invalid",
      REFLO_ENV: "staging",
      REFLO_LOCAL_API_RDS_PASSWORD:
        "000000000000000000000000000000000000000000000000",
      REFLO_VECTOR_DATABASE_URL: "postgresql://invalid",
    }),
    /requires REFLO_ENV=dev/,
  );
});

test("local application setup executes when invoked through a relative path", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/prepare-local-app-profile.mjs"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {},
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires REFLO_ENV=dev/);
});
