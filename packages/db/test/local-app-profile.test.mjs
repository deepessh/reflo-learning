import { access } from "node:fs/promises";
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
      REFLO_VECTOR_DATABASE_URL: "postgresql://invalid",
    }),
    /requires REFLO_ENV=dev/,
  );
});
