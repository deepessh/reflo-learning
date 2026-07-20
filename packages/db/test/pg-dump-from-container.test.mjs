import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const wrapper = path.join(packageRoot, "scripts/pg-dump-from-container.sh");

test("pinned pg_dump wrapper delegates to the service container", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "reflo-pg-dump-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const fakeDocker = path.join(scratch, "docker");
  await writeFile(fakeDocker, '#!/usr/bin/env sh\nprintf "%s\\n" "$@"\n');
  await chmod(fakeDocker, 0o755);

  const databaseUrl =
    "postgres://postgres:postgres@127.0.0.1:5432/reflo_test?sslmode=disable";
  const { stdout } = await execFileAsync(
    wrapper,
    ["--schema-only", databaseUrl],
    {
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH ?? ""}`,
        REFLO_POSTGRES_CONTAINER_ID: "abc123",
      },
    },
  );

  assert.deepEqual(stdout.trimEnd().split("\n"), [
    "exec",
    "abc123",
    "pg_dump",
    "--schema-only",
    databaseUrl,
  ]);
});

test("pinned pg_dump wrapper requires a service container", async () => {
  await assert.rejects(
    execFileAsync(wrapper, [], {
      env: { ...process.env, REFLO_POSTGRES_CONTAINER_ID: "" },
    }),
    (error) => {
      assert.match(error.stderr, /REFLO_POSTGRES_CONTAINER_ID is required/);
      return true;
    },
  );
});
