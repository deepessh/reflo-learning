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
const canonicalDump = path.join(
  packageRoot,
  "scripts/dump-schema-from-container.sh",
);

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

test("pinned pg_dump wrapper rewrites only the configured local authority", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "reflo-pg-dump-rewrite-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const fakeDocker = path.join(scratch, "docker");
  await writeFile(fakeDocker, '#!/usr/bin/env sh\nprintf "%s\\n" "$@"\n');
  await chmod(fakeDocker, 0o755);

  const hostUrl =
    "postgresql://reflo:local@127.0.0.1:55432/reflo_schema_123?sslmode=disable";
  const containerUrl =
    "postgresql://reflo:local@127.0.0.1:5432/reflo_schema_123?sslmode=disable";
  const { stdout } = await execFileAsync(
    wrapper,
    ["--schema-only", `--dbname=${hostUrl}`],
    {
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH ?? ""}`,
        REFLO_POSTGRES_CONTAINER_ID: "abc123",
        REFLO_POSTGRES_CONTAINER_REWRITE_FROM: "127.0.0.1:55432",
        REFLO_POSTGRES_CONTAINER_REWRITE_TO: "127.0.0.1:5432",
      },
    },
  );

  assert.deepEqual(stdout.trimEnd().split("\n"), [
    "exec",
    "abc123",
    "pg_dump",
    "--schema-only",
    `--dbname=${containerUrl}`,
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

test("canonical schema dump exposes only the container pg_dump", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "reflo-schema-dump-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const fakeNode = path.join(scratch, "node");
  await writeFile(
    fakeNode,
    '#!/usr/bin/env sh\nprintf "script=%s\\n" "$1"\nprintf "client=%s\\n" "$(command -v pg_dump)"\npg_dump --version\n',
  );
  await chmod(fakeNode, 0o755);
  const fakeDocker = path.join(scratch, "docker");
  await writeFile(fakeDocker, '#!/usr/bin/env sh\nprintf "%s\\n" "$@"\n');
  await chmod(fakeDocker, 0o755);

  const { stdout } = await execFileAsync(canonicalDump, [], {
    env: {
      ...process.env,
      PATH: `${scratch}:${process.env.PATH ?? ""}`,
      REFLO_POSTGRES_CONTAINER_ID: "abc123",
    },
  });
  const output = stdout.trimEnd().split("\n");
  assert.match(output[0], /scripts\/dump-schema\.mjs$/);
  assert.match(output[1], /^client=.*\/pg_dump$/);
  assert.deepEqual(output.slice(2), ["exec", "abc123", "pg_dump", "--version"]);
});
